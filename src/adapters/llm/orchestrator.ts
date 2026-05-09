/**
 * Branch 3 manager orchestrator — Gemini native function-calling loop.
 * Replaces the classify→apply pipeline for post-onboarding manager messages.
 */

import { GoogleGenAI, Type, FunctionCallingConfigMode } from '@google/genai'
import type { Content, FunctionDeclaration } from '@google/genai'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { managerMemory } from '../../db/schema.js'
import type { CalendarClient } from '../calendar/client.js'
import type { TranscriptTurn } from './types.js'
import type { Lang } from '../../domain/i18n/t.js'
import type { BusinessKnowledge } from '../../shared/skill-types.js'
import {
  executeListCalendarEvents,
  executeCreateCalendarEvent,
  executeDeleteCalendarEvent,
  executeManageBusinessSettings,
  executeSearchWeb,
  executeLookupCustomer,
  executeSaveContactNote,
  type ToolContext,
} from '../../domain/manager/orchestrator-tools.js'
import {
  logOrchestratorIteration,
  logOrchestratorCompletion,
  logOrchestratorError,
} from '../../domain/orchestrator-log.js'

const LLM_API_KEY = process.env['LLM_API_KEY']
const MODEL = 'gemini-2.5-flash'
const MAX_ITERATIONS = 5

const ai = new GoogleGenAI({ apiKey: LLM_API_KEY ?? '', apiVersion: 'v1beta' })

// ── Tool declarations ─────────────────────────────────────────────────────────

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
        dateFrom: { type: Type.STRING, description: 'Start date ISO 8601 (for list_range)' },
        dateTo: { type: Type.STRING, description: 'End date ISO 8601 (for list_range)' },
      },
      required: ['intent'],
    },
  },
  {
    name: 'createCalendarEvent',
    description: 'Create a personal or business event on the calendar (team meetings, blocks, personal appointments). This is for non-customer events. To block time from customer bookings, use manageBusinessSettings instead.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING },
        startDatetime: { type: Type.STRING, description: 'ISO 8601 in business timezone' },
        endDatetime: { type: Type.STRING, description: 'ISO 8601 in business timezone' },
        notes: { type: Type.STRING },
      },
      required: ['title', 'startDatetime', 'endDatetime'],
    },
  },
  {
    name: 'deleteCalendarEvent',
    description: 'Delete a personal or business event from the calendar. Only for events the manager created (meetings, blocks, personal appointments). Never use this to cancel a customer booking — use manageBusinessSettings for booking cancellations.',
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

  return `You are the PA admin assistant for ${businessName}. Today is ${currentDateTime} in ${timezone}.

The manager is texting you on WhatsApp. You have access to tools. Use them when the manager needs information or action. For straightforward questions you can answer from context, reply directly without calling any tool.

## Language
Reply entirely in ${language}. All WhatsApp formatting rules apply:
- No HTML. No markdown except *bold* and line breaks.
- Numbered lists for sequences. Line break separation between items.
- URLs on their own line.

## Tool usage rules
- manageBusinessSettings: ALWAYS use this for any change to hours, services, pricing, policies, staff access, or booking cancellations. Never handle these as conversational replies.
- listCalendarEvents: use for schedule questions. Do not call it unless the manager is asking about their calendar.
- createCalendarEvent: personal/business events only. Do not use for blocking customer booking slots — that is manageBusinessSettings.
- deleteCalendarEvent: only for personal/business events the manager created. NEVER use for customer bookings — use manageBusinessSettings with a cancellation instruction for those.
- searchWeb: only when the manager explicitly needs external information.
- lookupCustomer / saveContactNote: only for customer or contact management requests.
${knowledgeBlock ? `\n## Business knowledge\n${knowledgeBlock}` : ''}

## After completing actions
If the action you just completed has downstream effects on customers (cancellations, schedule changes), end your reply with a brief offer to notify them. Do not notify customers automatically — ask first.

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
}

export async function runManagerOrchestratorLoop(params: OrchestratorParams): Promise<string> {
  const {
    messageId, message, sessionId, businessId, identityId,
    businessName, timezone, lang, calendar, transcript, businessKnowledge,
  } = params

  const managerMemorySummaries = await loadManagerMemorySummaries(identityId)

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
  const fallback = lang === 'he' ? 'אירעה שגיאה בעיבוד הבקשה.' : 'Something went wrong processing your request.'

  while (iterations < MAX_ITERATIONS) {
    const iterStart = Date.now()
    let result
    try {
      result = await ai.models.generateContent({
        model: MODEL,
        contents,
        config: {
          systemInstruction: systemPrompt,
          tools,
          toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
          thinkingConfig: { thinkingBudget: 0 },
          maxOutputTokens: 1024,
        },
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
          toolResult = await dispatchTool(toolName, toolArgs, ctx)
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
