/**
 * Branch 3 manager orchestrator — Gemini native function-calling loop.
 * Replaces the classify→apply pipeline for post-onboarding manager messages.
 */

import { GoogleGenAI, Type, FunctionCallingConfigMode } from '@google/genai'
import type { Content, FunctionDeclaration } from '@google/genai'
import { desc, eq } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { managerMemory } from '../../db/schema.js'
import type { CalendarClient } from '../calendar/client.js'
import type { TranscriptTurn } from './types.js'
import type { Lang } from '../../domain/i18n/t.js'
import type { BusinessKnowledge } from '../../shared/skill-types.js'
import { buildVoiceCore } from './voice.js'
import { MODELS } from './models.js'
import {
  executeListCalendarEvents,
  executeCreateCalendarEvent,
  executeScheduleGroupSession,
  executeDeleteCalendarEvent,
  executeManageBusinessSettings,
  executeSearchWeb,
  executeLookupCustomer,
  executeSaveContactNote,
  executePauseConversation,
  executeResumeConversation,
  type ToolContext,
} from '../../domain/manager/orchestrator-tools.js'
import {
  logOrchestratorIteration,
  logOrchestratorCompletion,
  logOrchestratorError,
} from '../../domain/orchestrator-log.js'

const LLM_API_KEY = process.env['LLM_API_KEY']
const MAX_ITERATIONS = 5

const ai = new GoogleGenAI({ apiKey: LLM_API_KEY ?? '', apiVersion: 'v1beta' })

// Branch 3 runs on Pro for conversational fluency. Pro reasons by default and its
// thinking draws down maxOutputTokens, so we bound thinking with a positive budget
// (only 0 is invalid on Pro) and guarantee headroom for the reply — otherwise a
// short budget gets fully spent on thinking and Pro returns empty text. If a Pro
// call fails, fall back to Flash (thinkingBudget:0) so a turn is never dropped.
const PRO_THINKING_BUDGET = 1024
const PRO_MIN_OUTPUT_TOKENS = 3072
type OrchestratorConfig = NonNullable<Parameters<typeof ai.models.generateContent>[0]['config']>
async function generateOrchestratorTurn(contents: Content[], config: OrchestratorConfig) {
  try {
    return await ai.models.generateContent({
      model: MODELS.pro,
      contents,
      config: {
        ...config,
        thinkingConfig: { thinkingBudget: PRO_THINKING_BUDGET },
        maxOutputTokens: Math.max(config.maxOutputTokens ?? 1024, PRO_MIN_OUTPUT_TOKENS),
      },
    })
  } catch (err) {
    console.warn('[orchestrator] Pro turn failed, falling back to Flash', {
      error: err instanceof Error ? err.message : String(err),
    })
    return await ai.models.generateContent({
      model: MODELS.fast,
      contents,
      config: { ...config, thinkingConfig: { thinkingBudget: 0 } },
    })
  }
}

// ── Tool declarations ─────────────────────────────────────────────────────────

// Structured date pieces — the manager-facing equivalent of customerIntentSchema.
// The LLM CLASSIFIES what the manager said into these pieces; resolveSlotRange
// (deterministic core) turns them into an absolute instant. The LLM never does
// calendar arithmetic (Principle #1), so "tomorrow"/"next Tuesday"/"the 9th" can
// never resolve to the wrong weekday/month or a past year on a write.
const DATE_PIECES_SCHEMA = {
  type: Type.OBJECT,
  description: 'The date the manager stated, as structured pieces. CLASSIFY ONLY — never compute an absolute or ISO date. Use relativeDay for "today/tomorrow/this week", weekday for a named day, explicitDate for a calendar date. Include year ONLY if the manager explicitly stated it.',
  properties: {
    relativeDay: {
      type: Type.STRING,
      enum: ['today', 'tomorrow', 'day_after_tomorrow', 'this_week', 'next_week'],
      description: 'Relative phrasing if used (e.g. "tomorrow" → tomorrow). Omit if a weekday or explicit date is given.',
    },
    weekday: { type: Type.NUMBER, description: '0=Sunday … 6=Saturday when a named day is given ("Tuesday" → 2). Omit otherwise.' },
    explicitDate: {
      type: Type.OBJECT,
      description: 'When a calendar date is stated (day + month required; year optional and only if explicitly said).',
      properties: {
        year: { type: Type.NUMBER },
        month: { type: Type.NUMBER },
        day: { type: Type.NUMBER },
      },
    },
  },
}

const timeSchema = (description: string) => ({
  type: Type.OBJECT,
  description,
  properties: {
    hour: { type: Type.NUMBER, description: '0–23' },
    minute: { type: Type.NUMBER, description: '0–59' },
  },
  required: ['hour', 'minute'],
})

const MANAGER_TOOLS: FunctionDeclaration[] = [
  {
    name: 'listCalendarEvents',
    description: 'Read the business calendar — list upcoming events, check availability, or see what a specific day looks like. Use this when the manager asks about their schedule, upcoming bookings, or free slots. Do NOT use for changing availability — use manageBusinessSettings for that.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        intent: {
          type: Type.STRING,
          enum: ['list_today', 'list_week', 'list_range', 'check_free_slots'],
          description: 'What calendar data to retrieve',
        },
        dateFrom: { ...DATE_PIECES_SCHEMA, description: 'Range start, as structured date pieces (for list_range). NEVER an ISO/absolute date — report what the manager said.' },
        dateTo: { ...DATE_PIECES_SCHEMA, description: 'Range end, as structured date pieces (for list_range). NEVER an ISO/absolute date.' },
      },
      required: ['intent'],
    },
  },
  {
    name: 'createCalendarEvent',
    description: 'Create a personal or business event on the calendar (team meetings, blocks, personal appointments). This is for non-customer events. To block time from customer bookings, use manageBusinessSettings instead. Report the date/time the manager said as structured pieces — NEVER compute an absolute or ISO date yourself; a deterministic system resolves them.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING },
        date: DATE_PIECES_SCHEMA,
        startTime: timeSchema('Start clock time the manager said, 24-hour'),
        endTime: timeSchema('End clock time the manager said, 24-hour'),
        notes: { type: Type.STRING },
      },
      required: ['title', 'date', 'startTime', 'endTime'],
    },
  },
  {
    name: 'scheduleGroupSession',
    description: 'Proactively place a group session / class on the calendar (e.g. "schedule a Vinyasa class Tuesday 11:00–12:00, 10 spots"). Use this when the manager wants to put a class on the calendar BEFORE any customer books it. Links to an existing service by name when given. For 1-on-1 personal events use createCalendarEvent; to change recurring weekly hours use manageBusinessSettings. Report the date/time as structured pieces — NEVER compute an absolute or ISO date yourself.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        serviceName: { type: Type.STRING, description: 'Name of the existing group service this class is an instance of (optional; matched fuzzily)' },
        title: { type: Type.STRING, description: 'Display title if no service is linked (optional)' },
        date: DATE_PIECES_SCHEMA,
        startTime: timeSchema('Start clock time the manager said, 24-hour'),
        endTime: timeSchema('End clock time, 24-hour. Provide this OR durationMinutes.'),
        durationMinutes: { type: Type.NUMBER, description: 'Session length in minutes, if the manager gave a duration instead of an end time (e.g. "a 1-hour class" → 60). Provide this OR endTime.' },
        maxParticipants: { type: Type.NUMBER, description: 'Capacity for this session (optional; defaults to the linked service capacity)' },
      },
      required: ['date', 'startTime'],
    },
  },
  {
    name: 'deleteCalendarEvent',
    description: 'Delete a personal/business event, intra-day block, or scheduled class from the calendar. Only for events the manager created (meetings, blocks, personal appointments, group sessions). Never use this to cancel a customer booking — use manageBusinessSettings for booking cancellations.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        eventId: {
          type: Type.STRING,
          description: 'Google Calendar event ID, as returned by listCalendarEvents or createCalendarEvent',
        },
        confirmationHint: {
          type: Type.STRING,
          description: 'Brief description of the event being deleted, for confirmation message generation',
        },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'manageBusinessSettings',
    description: "Change business configuration: hours, services, booking policies, staff permissions, or cancel a customer booking. Use this when the manager wants to change what customers can book, when they can book, what services are offered, pricing, who has access, or wants to cancel a specific booking. Pass the manager's exact instruction.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        instruction: {
          type: Type.STRING,
          description: "The manager's exact words describing what they want to change or cancel",
        },
      },
      required: ['instruction'],
    },
  },
  {
    name: 'searchWeb',
    description: 'Search the internet for current information the manager needs — competitor research, pricing trends, local events, regulatory changes, supplier information, etc.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: "Search query in the manager's language or English" },
        depth: {
          type: Type.STRING,
          enum: ['basic', 'advanced'],
          description: 'basic = fast (5 results), advanced = comprehensive (use sparingly)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'lookupCustomer',
    description: 'Find a customer by name or phone number, view their booking history, or query a segment of customers (e.g. inactive customers, frequent visitors).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        queryType: {
          type: Type.STRING,
          enum: ['find_by_name', 'find_by_phone', 'booking_history', 'segment'],
        },
        identifier: {
          type: Type.STRING,
          description: 'Name, phone number, or identityId depending on queryType',
        },
        segmentFilter: {
          type: Type.OBJECT,
          description: 'For segment queries: { serviceTypeId?, inactiveSinceDays?, hasBooking? }',
        },
      },
      required: ['queryType'],
    },
  },
  {
    name: 'saveContactNote',
    description: 'Save a note about a customer or business contact. Use for customer preferences, instructions, or any information the manager wants to remember.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        targetType: { type: Type.STRING, enum: ['customer', 'business_contact'] },
        identifier: {
          type: Type.STRING,
          description: 'identityId for customers, name for business contacts',
        },
        note: { type: Type.STRING },
      },
      required: ['targetType', 'identifier', 'note'],
    },
  },
  {
    name: 'pauseConversation',
    description: 'Pause PA responses for one customer so the manager can handle the conversation manually via Meta Business Suite. The PA will go completely silent for that customer until the pause expires or is manually lifted.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        customer_identifier: {
          type: Type.STRING,
          description: 'Customer name (partial match) or full phone number (E.164)',
        },
        duration_minutes: {
          type: Type.NUMBER,
          description: 'How long to pause in minutes. Defaults to 30 if not specified.',
        },
      },
      required: ['customer_identifier'],
    },
  },
  {
    name: 'resumeConversation',
    description: 'Resume PA responses for a customer whose conversation was previously paused. The PA will start responding to that customer again immediately.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        customer_identifier: {
          type: Type.STRING,
          description: 'Customer name (partial match) or full phone number (E.164)',
        },
      },
      required: ['customer_identifier'],
    },
  },
]

// ── System prompt builder ─────────────────────────────────────────────────────

function buildBusinessKnowledgeBlock(bk: BusinessKnowledge | null): string {
  if (!bk?.brandVoice && (!bk?.faqs || bk.faqs.length === 0)) return ''

  const lines: string[] = []

  if (bk.brandVoice) {
    lines.push(`Business description: ${bk.brandVoice}`)
  }

  if (bk.communicationStyle) {
    const cs = bk.communicationStyle
    const parts: string[] = []
    if ('formality' in cs && cs.formality) parts.push(cs.formality === 'formal' ? 'Formal tone' : 'Casual tone')
    if ('emojiUse' in cs) parts.push(cs.emojiUse === 'none' ? 'No emojis' : cs.emojiUse === 'frequent' ? 'Use emojis frequently' : 'Occasional emojis')
    if ('useCustomerName' in cs && cs.useCustomerName) parts.push("Use customer's first name")
    if (parts.length > 0) lines.push(`Communication style: ${parts.join(', ')}.`)
  }

  if (bk.faqs && bk.faqs.length > 0) {
    lines.push('FAQs:')
    bk.faqs.slice(0, 10).forEach((faq) => {
      lines.push(`- Q: ${faq.question}`)
      lines.push(`  A: ${faq.answer}`)
    })
  }

  return lines.join('\n')
}

function buildSystemPrompt(params: {
  businessName: string
  timezone: string
  lang: Lang
  businessKnowledge: BusinessKnowledge | null
  managerMemorySummaries: string[]
  conversationHistory: TranscriptTurn[]
}): string {
  const { businessName, timezone, lang, businessKnowledge, managerMemorySummaries, conversationHistory } = params
  const now = new Date()
  const locale = lang === 'he' ? 'he-IL' : 'en-GB'
  const currentDateTime = now.toLocaleString(locale, {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  const language = lang === 'he' ? 'Hebrew' : 'English'

  const knowledgeBlock = buildBusinessKnowledgeBlock(businessKnowledge)

  const memorySummary = managerMemorySummaries.length > 0
    ? managerMemorySummaries.map((s, i) => `[Session ${i + 1}] ${s}`).join('\n')
    : (lang === 'he' ? 'אין היסטוריה קודמת.' : 'No prior session history.')

  const historyBlock = conversationHistory.length > 0
    ? conversationHistory.map((t) => `${t.role === 'customer' ? 'Manager' : 'Assistant'}: ${t.text}`).join('\n')
    : ''

  return `You are the PA admin assistant for ${businessName}, texting the business owner as the business. Today is ${currentDateTime} in ${timezone}.

${buildVoiceCore('manager')}

The manager is texting you on WhatsApp. You have access to tools. Use them when the manager needs information or action. For straightforward questions you can answer from context, reply directly without calling any tool.

## Tool results are raw data — never echo them
Every tool returns structured facts FOR YOU, not text to send. Never quote a tool's fields, status strings, or confirmation text back to the manager. Read what happened, then say it in your own fresh, human words — varied each time (see the voice rules above). A passive "X was created / updated / deleted" is a failure; say "added X", "moved it to…", "done — that's off the calendar".

## Language
Reply entirely in ${language}. All WhatsApp formatting rules apply:
- No HTML. No markdown except *bold* and line breaks.
- Numbered lists for sequences. Line break separation between items.
- URLs on their own line.

## Dates and times — classify, never compute
For createCalendarEvent, scheduleGroupSession, and listCalendarEvents(list_range), report the date/time the manager said as structured pieces (relativeDay / weekday / explicitDate, and {hour,minute} times). NEVER compute or output an absolute or ISO date — a deterministic system resolves the pieces and validates them. If a calendar tool returns needsClarification: true, the date/time couldn't be resolved (ambiguous, already past, impossible, or a clock time that doesn't exist that day) — do NOT retry the tool with a guessed date; ask the manager for a workable day/time in your own words, without echoing the unusable value.

## Tool usage rules
- manageBusinessSettings: ALWAYS use this for any change to recurring weekly hours, services, pricing, policies, staff access, or booking cancellations. Also use it to block time from customer bookings (e.g. "block 2–4pm Tuesday"). Never handle these as conversational replies.
- listCalendarEvents: use for schedule questions. Use intent check_free_slots when the manager asks what times are open/free — it returns real bookable openings. Do not call it unless the manager is asking about their calendar.
- createCalendarEvent: personal/business 1-on-1 events only (e.g. "dentist 3pm"). Do not use for blocking customer booking slots — that is manageBusinessSettings.
- scheduleGroupSession: use when the manager wants to put a class/group session on the calendar ahead of bookings (e.g. "add a yoga class Tuesday 11am, 10 spots").
- deleteCalendarEvent: only for personal/business events, blocks, or classes the manager created. NEVER use for customer bookings — use manageBusinessSettings with a cancellation instruction for those.
- searchWeb: only when the manager explicitly needs external information.
- lookupCustomer / saveContactNote: only for customer or contact management requests.
${knowledgeBlock ? `\n## Business knowledge\n${knowledgeBlock}` : ''}

## After completing actions
If the action you just completed has downstream effects on customers (cancellations, schedule changes), end your reply with a brief offer to notify them — phrased naturally, never the same way twice. Do not notify customers automatically — ask first.

## Memory
Cross-session context:
${memorySummary}
${historyBlock ? `\n## Recent conversation\n${historyBlock}` : ''}`
}

// ── Manager memory loader ─────────────────────────────────────────────────────

async function loadManagerMemorySummaries(identityId: string): Promise<string[]> {
  const rows = await db
    .select({ summary: managerMemory.summary })
    .from(managerMemory)
    .where(eq(managerMemory.identityId, identityId))
    .orderBy(desc(managerMemory.createdAt))
    .limit(3)
  return rows.map((r) => r.summary)
}

// ── Tool dispatcher ───────────────────────────────────────────────────────────

async function dispatchTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<object> {
  // Args come from Gemini as Record<string, unknown>; cast via unknown for each executor
  switch (name) {
    case 'listCalendarEvents':
      return executeListCalendarEvents(args as unknown as Parameters<typeof executeListCalendarEvents>[0], ctx)
    case 'createCalendarEvent':
      return executeCreateCalendarEvent(args as unknown as Parameters<typeof executeCreateCalendarEvent>[0], ctx)
    case 'scheduleGroupSession':
      return executeScheduleGroupSession(args as unknown as Parameters<typeof executeScheduleGroupSession>[0], ctx)
    case 'deleteCalendarEvent':
      return executeDeleteCalendarEvent(args as unknown as Parameters<typeof executeDeleteCalendarEvent>[0], ctx)
    case 'manageBusinessSettings':
      return executeManageBusinessSettings(args as unknown as Parameters<typeof executeManageBusinessSettings>[0], ctx)
    case 'searchWeb':
      return executeSearchWeb(args as unknown as Parameters<typeof executeSearchWeb>[0], ctx)
    case 'lookupCustomer':
      return executeLookupCustomer(args as unknown as Parameters<typeof executeLookupCustomer>[0], ctx)
    case 'saveContactNote':
      return executeSaveContactNote(args as unknown as Parameters<typeof executeSaveContactNote>[0], ctx)
    case 'pauseConversation':
      return executePauseConversation(args as unknown as Parameters<typeof executePauseConversation>[0], ctx)
    case 'resumeConversation':
      return executeResumeConversation(args as unknown as Parameters<typeof executeResumeConversation>[0], ctx)
    default:
      return { error: `Unknown tool: ${name}` }
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

export interface OrchestratorParams {
  messageId: string
  message: string
  sessionId: string
  businessId: string
  identityId: string
  businessName: string
  timezone: string
  lang: Lang
  calendar: CalendarClient
  transcript: TranscriptTurn[]
  businessKnowledge: BusinessKnowledge | null
  // ── Test seams (optional; production never sets these) ─────────────────────
  // Let the quality harness grade the real Gemini function-calling loop + the
  // real system prompt against FIXED tool results, with no DB or calendar. When
  // omitted, the loop uses the production dispatcher and DB-backed memory loader,
  // so runtime behaviour is unchanged. See tests/quality/scenarios.test.ts.
  dispatchToolFn?: (name: string, args: Record<string, unknown>, ctx: ToolContext) => Promise<object>
  loadMemoryFn?: (identityId: string) => Promise<string[]>
}

export async function runManagerOrchestratorLoop(params: OrchestratorParams): Promise<string> {
  const {
    messageId, message, sessionId, businessId, identityId,
    businessName, timezone, lang, calendar, transcript, businessKnowledge,
  } = params

  const loadMemory = params.loadMemoryFn ?? loadManagerMemorySummaries
  const dispatch = params.dispatchToolFn ?? dispatchTool

  const managerMemorySummaries = await loadMemory(identityId)

  const systemPrompt = buildSystemPrompt({
    businessName,
    timezone,
    lang,
    businessKnowledge,
    managerMemorySummaries,
    conversationHistory: transcript.slice(-20),
  })

  const ctx: ToolContext = { db, businessId, identityId, timezone, lang, calendar }

  const tools = [{ functionDeclarations: MANAGER_TOOLS }]

  const contents: Content[] = [
    { role: 'user', parts: [{ text: message }] },
  ]

  let iterations = 0
  const loopStart = Date.now()
  const fallback = lang === 'he' ? 'רגע, משהו נתקע לי — אפשר לנסות שוב?' : 'Hmm, something got stuck on my end — mind trying that again?'

  while (iterations < MAX_ITERATIONS) {
    const iterStart = Date.now()
    let result
    try {
      result = await generateOrchestratorTurn(contents, {
        systemInstruction: systemPrompt,
        tools,
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
        maxOutputTokens: 1024,
      })
    } catch (err) {
      logOrchestratorError({ businessId, sessionId, messageId, error: err, iteration: iterations })
      return fallback
    }

    const candidate = result.candidates?.[0]
    const parts = candidate?.content?.parts ?? []

    // Collect all function calls in this response (Gemini may batch multiple)
    const fnCalls = parts.filter((p) => p.functionCall).map((p) => p.functionCall!)
    const textPart = parts.find((p) => p.text)?.text

    if (fnCalls.length > 0) {
      const toolCalls: Array<{ name: string; args: unknown }> = []
      const toolResults: Array<{ name: string; status: 'ok' | 'error'; result: unknown }> = []

      // Append model turn with all function calls
      contents.push({ role: 'model', parts: fnCalls.map((fc) => ({ functionCall: fc })) })

      // Execute each tool and collect results
      const functionResponseParts: Content['parts'] = []
      for (const fc of fnCalls) {
        const toolName = fc.name ?? ''
        const toolArgs = (fc.args ?? {}) as Record<string, unknown>
        toolCalls.push({ name: toolName, args: toolArgs })

        let toolResult: object
        let status: 'ok' | 'error' = 'ok'
        try {
          toolResult = await dispatch(toolName, toolArgs, ctx)
          if ('error' in toolResult) status = 'error'
        } catch (err) {
          toolResult = { error: err instanceof Error ? err.message : String(err) }
          status = 'error'
        }

        toolResults.push({ name: toolName, status, result: toolResult })
        functionResponseParts.push({
          functionResponse: { name: toolName, response: { result: toolResult } },
        })
      }

      contents.push({ role: 'user', parts: functionResponseParts })

      logOrchestratorIteration({
        businessId, sessionId, messageId, iteration: iterations,
        toolCalls, toolResults,
        durationMs: Date.now() - iterStart,
      })

      iterations++
      continue
    }

    if (textPart) {
      logOrchestratorCompletion({
        businessId, sessionId, messageId,
        totalIterations: iterations,
        finalReply: textPart,
        totalDurationMs: Date.now() - loopStart,
      })
      return textPart
    }

    // No function calls, no text — shouldn't happen; break out
    break
  }

  logOrchestratorError({ businessId, sessionId, messageId, error: `Loop exhausted after ${iterations} iterations` })
  return fallback
}
