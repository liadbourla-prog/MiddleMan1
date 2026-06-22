/**
 * Branch 3 manager orchestrator — Gemini native function-calling loop.
 * Replaces the classify→apply pipeline for post-onboarding manager messages.
 */

import { GoogleGenAI, Type, FunctionCallingConfigMode } from '@google/genai'
import type { Content, FunctionDeclaration } from '@google/genai'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { managerMemory, identities, businesses as businessesTable } from '../../db/schema.js'
import type { IdentityRole } from '../../db/schema.js'
import type { Action } from '../../domain/authorization/check.js'
import { buildInstructorRosterBlock, buildTeachingScheduleBlock, type InstructorRosterEntry, type TeachingSlot } from '../../domain/provider/roster.js'
import type { CalendarClient } from '../calendar/client.js'
import type { TranscriptTurn } from './types.js'
import type { Lang } from '../../domain/i18n/t.js'
import type { BusinessKnowledge } from '../../shared/skill-types.js'
import { buildVoiceCore } from './voice.js'
import { MODELS } from './models.js'
import {
  executeListCalendarEvents,
  executeCreateCalendarEvent,
  executeSelectCalendar,
  executeScheduleGroupSession,
  executeDeleteCalendarEvent,
  executeEditClassSession,
  executeScheduleRecurringClasses,
  executeManageBusinessSettings,
  executeSearchWeb,
  executeLookupCustomer,
  executeSaveContactNote,
  executePauseConversation,
  executeResumeConversation,
  executeApproveReshuffle,
  executeRejectReshuffle,
  executeAmendReshuffle,
  executeConfigureReshuffle,
  executeDecideFreedSlotOffer,
  executeCheckCalendarIntegrity,
  executeConnectGoogleCalendar,
  executeMessageCustomer,
  type ToolContext,
} from '../../domain/manager/orchestrator-tools.js'
import { executeCoordinateMeeting, executeResolveMeetingCoordination } from '../../domain/manager/coordination-tools.js'
import { findActiveByBusiness } from '../../domain/coordination/repository.js'
import {
  logOrchestratorIteration,
  logOrchestratorCompletion,
  logOrchestratorError,
} from '../../domain/orchestrator-log.js'
import { buildActionLedgerBlock, hasCalendarConnected } from '../../domain/audit/ledger-block.js'
import { detectActionClaims, type ActionClaim } from '../../domain/flows/reply-guard.js'
import { logAudit } from '../../domain/audit/logger.js'

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
    name: 'selectCalendar',
    description: 'List the connected Google account\'s calendars, or change WHICH calendar the PA manages (supports a secondary calendar, e.g. "use my Testing calendar", "which calendar are you using?", "switch to the Work calendar"). Use action "list" to show the available calendars and which is active; use action "switch" with the calendar name the manager said. Only for choosing the target calendar — NOT for creating events (createCalendarEvent) or changing working hours (manageBusinessSettings).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: { type: Type.STRING, enum: ['list', 'switch'], description: '"list" to show calendars, "switch" to change the active one' },
        calendarName: { type: Type.STRING, description: 'For "switch": the calendar name the manager named (matched against the calendar titles; required to switch)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'scheduleGroupSession',
    description: 'Proactively place a SINGLE group session / class on the calendar for one specific date (e.g. "schedule a Vinyasa class this Tuesday 11:00–12:00 with Dana, 10 spots"). Use this when the manager wants to put a one-off class on the calendar BEFORE any customer books it. Capture the instructor when the manager names one ("with Dana" → instructor: "Dana"). Links to an existing service by name when given. For 1-on-1 personal events use createCalendarEvent; to change recurring weekly hours use manageBusinessSettings; to set up a class that REPEATS every week ("yoga every Monday") use scheduleRecurringClasses. Report the date/time as structured pieces — NEVER compute an absolute or ISO date yourself.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        serviceName: { type: Type.STRING, description: 'Name of the existing group service this class is an instance of (optional; matched fuzzily)' },
        instructor: { type: Type.STRING, description: 'Name of the instructor teaching this class, if the manager named one (e.g. "with Dana" → "Dana"). Must be an instructor that already exists; optional.' },
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
    description: 'Delete a personal/business event, intra-day block, or scheduled class/group session from the calendar. Only for events the manager created (meetings, blocks, personal appointments, group sessions). Use this to cancel a whole class/group SESSION — it automatically cancels every booking on that session, sends each booked customer a cancellation notice that offers to rebook them, and notifies the session instructor. Do NOT use it to cancel a single customer\'s individual (1-on-1) booking — use manageBusinessSettings for that.',
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
    name: 'editClassSession',
    description: 'Change an ALREADY-scheduled class/group session that is on the calendar — swap its instructor, move its time, or change its capacity — WITHOUT deleting and recreating it (which would drop the people booked into it). Use this for "change the instructor of tomorrow\'s 10:00 yoga to Dana", "move the Tuesday breathing session to 17:00", "make the Monday class hold 15". First call listCalendarEvents to get the session\'s eventId, then pass it here. Only set the fields that change. Report date/time as structured pieces — never compute an ISO date yourself. (For a brand-new one-off session use scheduleGroupSession; for a weekly recurring series use manageBusinessSettings.)',
    parameters: {
      type: Type.OBJECT,
      properties: {
        eventId: { type: Type.STRING, description: 'The session\'s event ID from listCalendarEvents (the calendar block to edit)' },
        instructor: { type: Type.STRING, description: 'New instructor name, if changing who teaches it (must already exist as an instructor). Optional.' },
        date: DATE_PIECES_SCHEMA,
        startTime: timeSchema('New start clock time, 24-hour, if moving the session. Optional — omit to keep the current time.'),
        endTime: timeSchema('New end clock time, 24-hour. Optional; provide this OR durationMinutes when changing length.'),
        durationMinutes: { type: Type.NUMBER, description: 'New length in minutes, if changing duration. Optional. Provide this OR endTime.' },
        maxParticipants: { type: Type.NUMBER, description: 'New capacity, if changing how many people the session holds. Optional.' },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'scheduleRecurringClasses',
    description: 'Set up one OR MANY recurring weekly classes in a single step — use this for dense requests like "yoga and pilates every hour 09:00–20:00 Sunday to Thursday" or "breathing workshop every Monday and Wednesday at 10:00 and 16:00". Expand the request yourself into explicit specs: one entry per service, each with the days of week and the list of start times. The class repeats weekly on each (day, time). Only links to services that already exist; the service must have a group capacity (>1) or you must pass maxParticipants. Capture the instructor when named. For a SINGLE one-off class on one date use scheduleGroupSession instead; to change ONE existing session use editClassSession.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        classes: {
          type: Type.ARRAY,
          description: 'One entry per service. Each entry repeats weekly on every (dayOfWeek × time) combination it lists.',
          items: {
            type: Type.OBJECT,
            properties: {
              serviceName: { type: Type.STRING, description: 'Name of the existing group service (matched fuzzily)' },
              instructor: { type: Type.STRING, description: 'Instructor name if the manager named one for these classes (must already exist). Optional.' },
              daysOfWeek: { type: Type.ARRAY, items: { type: Type.NUMBER }, description: 'Days this class runs: 0=Sunday … 6=Saturday. E.g. Sun–Thu = [0,1,2,3,4].' },
              times: { type: Type.ARRAY, items: timeSchema('A start clock time, 24-hour'), description: 'All weekly start times. Expand a range like "every hour 9–20" into [{hour:9,minute:0}, … {hour:20,minute:0}].' },
              durationMinutes: { type: Type.NUMBER, description: 'Session length in minutes (optional; defaults to the service duration)' },
              maxParticipants: { type: Type.NUMBER, description: 'Capacity per session (optional; defaults to the service capacity). Required if the service is otherwise 1-on-1.' },
              startDate: DATE_PIECES_SCHEMA,
              endDate: DATE_PIECES_SCHEMA,
            },
            required: ['serviceName', 'daysOfWeek', 'times'],
          },
        },
      },
      required: ['classes'],
    },
  },
  {
    name: 'manageBusinessSettings',
    description: "Change business configuration: hours, services, booking policies, staff permissions, instructors/teaching staff, or cancel a customer booking. Use this when the manager wants to change what customers can book, when they can book, what services are offered, pricing, who has access, to add or manage instructors and their weekly hours (e.g. 'add Dana as a yoga instructor Mon/Wed 9–13', 'change Dana's hours', 'remove Dana'), or wants to cancel a specific booking. Pass the manager's exact instruction.",
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
    description: "Find a customer by name or phone, view their booking history, read their recent messages, or query a segment of customers. ALWAYS use recent_messages to check whether a customer has replied (e.g. after you messaged them on the owner's behalf) — never guess or claim from memory whether someone wrote back.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        queryType: {
          type: Type.STRING,
          enum: ['find_by_name', 'find_by_phone', 'booking_history', 'recent_messages', 'segment'],
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
    name: 'connectGoogleCalendar',
    description: "Generate the link the owner taps to connect their Google Calendar. Use this WHENEVER the owner wants to connect/sync/link Google Calendar. It returns the real sign-in URL — you then send that link to the owner here in WhatsApp. You have NO email and cannot send anything by email; never say you emailed a link or ask which email to use.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'messageCustomer',
    description: "Send a WhatsApp message to ONE specific customer on the owner's behalf (e.g. \"text Harel and ask when he's free this week\", \"let Dana know class is cancelled\"). Compose the message yourself and confirm with the owner before calling. Pass the customer's phone number when the owner gives one (lets you reach someone new); otherwise pass the name to match a customer on file. Only report the message as sent if this tool returns ok:true — it may report the customer can't be reached, in which case tell the owner the truth.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        phoneNumber: { type: Type.STRING, description: "Customer phone in E.164 (e.g. +972541234567) when the owner provides it. Preferred — lets you message a new contact." },
        name: { type: Type.STRING, description: 'Customer name to match an existing customer, when no phone number is given.' },
        message: { type: Type.STRING, description: "The full message text to send, composed in the customer's language. Warm and natural — this is what the customer receives verbatim." },
      },
      required: ['message'],
    },
  },
  {
    name: 'coordinateMeeting',
    description: 'Coordinate a NEW meeting with someone on the owner\'s behalf — only when the owner has NOT already agreed a time and wants the PA to reach out. The counterparty may be a brand-new person OR an existing customer. First confirm the owner wants you to coordinate (vs. they already set it). Provide EITHER a primary time + one or two fallbacks (discrete times) OR day/time "windows" (ranges like "Tue 10–16, Wed 11–15") plus durationMinutes. Report all dates/times as structured pieces — NEVER an absolute/ISO date. If the owner has not told you how to introduce yourself when reaching out (and there is no saved preference shown under "Outreach identity"), ask them first and pass identifyAs (and ownerName if they choose their own name). For a meeting whose time is already agreed, use createCalendarEvent instead.',
    parameters: { type: Type.OBJECT, properties: {
      contactName: { type: Type.STRING, description: 'Name of the person to meet, if given.' },
      phoneNumber: { type: Type.STRING, description: 'Their phone in E.164 — required to reach someone new (an existing customer can be matched by this too).' },
      title: { type: Type.STRING, description: 'What the meeting is about (e.g. "Meeting with the accountant").' },
      date: DATE_PIECES_SCHEMA,
      startTime: timeSchema('Primary start clock time the owner said, 24-hour (discrete-times path)'),
      endTime: timeSchema('Primary end clock time, 24-hour. Provide this OR durationMinutes.'),
      durationMinutes: { type: Type.NUMBER, description: 'Meeting length in minutes. REQUIRED when using windows; otherwise provide this OR endTime.' },
      fallbacks: { type: Type.ARRAY, description: 'One or two backup discrete times to offer if the primary does not work.', items: { type: Type.OBJECT, properties: { date: DATE_PIECES_SCHEMA, startTime: timeSchema('Fallback start time, 24-hour') }, required: ['date', 'startTime'] } },
      windows: { type: Type.ARRAY, description: 'Day/time RANGES the owner is available within (e.g. "Tue 10–16, Wed 11–15"). Use this when the owner gives ranges rather than exact times. Each window has a date and a start..end clock time. Requires durationMinutes.', items: { type: Type.OBJECT, properties: { date: DATE_PIECES_SCHEMA, startTime: timeSchema('Window start clock time, 24-hour'), endTime: timeSchema('Window end clock time, 24-hour') }, required: ['date', 'startTime', 'endTime'] } },
      identifyAs: { type: Type.STRING, enum: ['business', 'owner_name'], description: 'How to introduce yourself in the outreach: as the business, or as the owner\'s assistant. Pass this once the owner has answered; it is then saved.' },
      ownerName: { type: Type.STRING, description: "The owner's real name, when they choose to be identified by name and you don't already have it. It will be saved." },
    }, required: ['title'] },
  },
  {
    name: 'resolveMeetingCoordination',
    description: 'Act on an in-progress meeting coordination after the counterparty replied — confirm the agreed time (books it), offer a different time, or abandon it. The active coordination id is given to you in context. Report any counter time as structured pieces, never an absolute date.',
    parameters: { type: Type.OBJECT, properties: {
      coordinationId: { type: Type.STRING, description: 'Id of the coordination from context.' },
      action: { type: Type.STRING, enum: ['confirm', 'counter_offer', 'abandon'] },
      counterTime: { type: Type.OBJECT, description: 'For counter_offer: the new time to offer.', properties: { date: DATE_PIECES_SCHEMA, startTime: timeSchema('New offer start, 24-hour') }, required: ['date', 'startTime'] },
    }, required: ['coordinationId', 'action'] },
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
  {
    name: 'approveReshuffle',
    description: 'Approve the reschedule swap plan that is waiting for the owner. Only call this when the owner clearly says to go ahead. It applies the agreed moves atomically; everyone involved already consented.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'rejectReshuffle',
    description: 'Reject the pending reschedule swap plan. Nothing changes and anyone contacted is told never mind. Use when the owner declines the plan.',
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'amendReshuffle',
    description: 'The owner wants to tweak the pending reschedule plan (e.g. a different time, or move someone else). Pass their requested change in plain words.',
    parameters: {
      type: Type.OBJECT,
      properties: { change: { type: Type.STRING, description: "The owner's requested modification, verbatim or paraphrased" } },
      required: ['change'],
    },
  },
  {
    name: 'configureReshuffle',
    description: 'Change the proactive reschedule (swap) engine settings for this business. Use when the owner adjusts how it behaves — turn it on/off, batch size for outreach, whether to require approval, how many people to contact, the protect window, who to contact.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        enabled: { type: Type.BOOLEAN, description: 'Turn the swap engine on or off' },
        approvalMode: { type: Type.STRING, enum: ['require_approval', 'auto_apply'], description: 'Whether the owner must approve each plan (default) or it applies automatically' },
        batchSize: { type: Type.NUMBER, description: 'How many customers to message per outreach wave (0 = no cap)' },
        maxChainLength: { type: Type.NUMBER, description: 'Max number of people a single swap may move' },
        maxOutreachPerCampaign: { type: Type.NUMBER, description: 'Hard cap on total customers messaged for one request' },
        protectWindowHours: { type: Type.NUMBER, description: "Don't disturb anyone whose appointment is within this many hours" },
        protectVip: { type: Type.BOOLEAN, description: 'Never move VIP customers to accommodate others' },
        contactScope: { type: Type.STRING, enum: ['conflicting_only', 'service_match', 'all_booked'], description: 'Who may be contacted for a swap' },
      },
    },
  },
  {
    name: 'decideFreedSlotOffer',
    description: "Decide what to do with a slot that just freed up (after a cancellation) when customers are waiting for it. Use this when you previously asked the owner whether to offer a freed slot and they answered — 'yes/offer it' → decision 'offer'; 'no/leave it' → decision 'leave_open'. Also use it to set a standing preference when the owner says how to handle these going forward: 'always do it automatically' → setStandingPreference 'always_auto'; 'always ask me' → 'always_ask'; 'never offer' → 'never'. The owner can set a preference with or without a slot currently waiting.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        decision: { type: Type.STRING, enum: ['offer', 'leave_open'], description: "'offer' to offer the freed slot to the waiting customers; 'leave_open' to keep it open and offer it to no one." },
        setStandingPreference: { type: Type.STRING, enum: ['always_auto', 'always_ask', 'never'], description: 'Optional. Persist how future freed slots are handled: always_auto = offer automatically; always_ask = ask each time; never = never offer.' },
      },
    },
  },
  {
    name: 'checkCalendarIntegrity',
    description: "Run a live calendar integrity check and report whether everything is correct. Use WHENEVER the owner asks if the calendar is OK, if there are any mistakes/double-bookings/problems, or to verify everything is in order (e.g. \"is everything correct?\", \"any double bookings?\", \"is the calendar OK?\"). It checks for double-bookings, bookings missing from Google, calendar collisions, wrong times, and bookings inside breaks. ALWAYS base your answer on this tool's result — never claim the calendar is fine from memory.",
    parameters: { type: Type.OBJECT, properties: {} },
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
  instructorRoster: InstructorRosterEntry[]
  teachingSchedule: TeachingSlot[]
  managerMemorySummaries: string[]
  actionLedger: string
  activeCoordinations: string
  outreachIdentity: string
  conversationHistory: TranscriptTurn[]
}): string {
  const { businessName, timezone, lang, businessKnowledge, instructorRoster, teachingSchedule, managerMemorySummaries, actionLedger, activeCoordinations, outreachIdentity, conversationHistory } = params
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
  const rosterBlock = buildInstructorRosterBlock(instructorRoster, lang)
  const teachingScheduleBlock = buildTeachingScheduleBlock(teachingSchedule, lang)

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
- manageBusinessSettings: ALWAYS use this for any change to recurring weekly hours, services, pricing, policies, staff access, or booking cancellations. Also use it to block time from customer bookings (e.g. "block 2–4pm Tuesday"). Use it to STOP or SKIP one date of a recurring weekly class (e.g. "stop the weekly pilates class", "no spin class this coming Tuesday") — but to CREATE/SET UP recurring classes use scheduleRecurringClasses, not this. Also use it to add or manage instructors / teaching staff and their weekly hours (e.g. "add Dana as a yoga instructor Mon/Wed 9–13", "change Dana's hours", "Dana also teaches pilates", "remove Dana"). Never handle these as conversational replies.
- scheduleRecurringClasses: use to CREATE recurring weekly classes — one or many at once (e.g. "yoga every Monday 10am", "yoga and pilates every hour 9–20 Sun–Thu", "breathing Mon & Wed at 10:00 and 16:00"). Expand ranges into explicit days and times yourself. The service must already exist and have a group capacity (>1) or you pass maxParticipants.
- listCalendarEvents: use for schedule questions. Use intent check_free_slots when the manager asks what times are open/free — it returns real bookable openings. Do not call it unless the manager is asking about their calendar.
- createCalendarEvent: personal/business 1-on-1 events only (e.g. "dentist 3pm"). Do not use for blocking customer booking slots — that is manageBusinessSettings.
- scheduleGroupSession: use when the manager wants to put a SINGLE class/group session on the calendar for one specific date ahead of bookings (e.g. "add a yoga class this Tuesday 11am with Dana, 10 spots"). Capture the instructor when named ("with Dana"). For a class that repeats every week ("every Monday", "weekly"), use scheduleRecurringClasses instead.
- editClassSession: use to change an ALREADY-scheduled class on the calendar — its instructor, time, or capacity (e.g. "change tomorrow's 10:00 yoga to Dana", "move the Tuesday breathing to 17:00"). Get its eventId from listCalendarEvents first. Never delete+recreate a class to "edit" it — that drops its bookings.
- deleteCalendarEvent: only for personal/business events, blocks, or classes the manager created. NEVER use for customer bookings — use manageBusinessSettings with a cancellation instruction for those.
- searchWeb: only when the manager explicitly needs external information.
- lookupCustomer / saveContactNote: only for customer or contact management requests. When the owner asks whether a customer has replied or what they said, you MUST call lookupCustomer with recent_messages and answer from the result — never say "not yet" or "they replied" from memory or assumption.
- connectGoogleCalendar: ALWAYS use this when the owner wants to connect, sync, or link Google Calendar. It returns the real sign-in link — send that link to the owner here in WhatsApp, on its own line. You have NO email and no way to send email: never offer to email the link, never ask for an email address, and never claim you emailed anything.
- messageCustomer: use to actually send a WhatsApp message to a specific customer the owner names (e.g. "ask Harel when he's free"). Compose the message and confirm with the owner first, then call the tool. Only tell the owner the message was sent if the tool returns ok:true; if it reports the customer can't be reached (e.g. they haven't messaged recently), relay that honestly and never pretend it went out.
- coordinateMeeting: use ONLY when the owner wants you to reach out and arrange a meeting whose time is NOT yet agreed — with anyone, INCLUDING an existing customer. First ask, in ONE question, whether they already set a time (then use createCalendarEvent) or want you to coordinate. When coordinating, capture either a primary time + one or two fallbacks, OR day/time windows (ranges) + how long the meeting runs. ALL meeting coordination goes through this tool — never improvise a coordination with messageCustomer + createCalendarEvent. NEVER invent or guess a person's name (the owner's or anyone else's). If you don't know how to introduce yourself for outreach and no preference is shown under "Outreach identity" below, ask the owner once: whether to say you're from {business name} or {owner}'s assistant — and if they pick their own name and you don't have it, ask for it; pass identifyAs (and ownerName) to save it.
- messageCustomer is for a SINGLE one-off ping the owner dictates (e.g. "let Dana know class is cancelled") — never for negotiating a meeting time, and never to work around coordinateMeeting. Do not use createCalendarEvent to book a meeting you coordinated; confirm it with resolveMeetingCoordination instead.
- resolveMeetingCoordination: after the contact replies (you will see active meeting coordinations in your context), use this to confirm the agreed time (which books it and tells them), offer a different time, or abandon it. Only confirm a booking when the owner says to.

## Never claim an action you did not take
Only state something happened — a message sent, a calendar connected, a booking changed — when a tool actually returned success for it. If you have no tool for what the owner asked, or a tool reports it failed or couldn't proceed, say so plainly and offer a real next step. Never fabricate a confirmation, a link, or an email.
${knowledgeBlock ? `\n## Business knowledge\n${knowledgeBlock}` : ''}
${rosterBlock ? `\n## Instructors\n${rosterBlock}` : ''}
${teachingScheduleBlock ? `\n## Upcoming classes\n${teachingScheduleBlock}` : ''}
${activeCoordinations ? `\n## Active meeting coordinations\n${activeCoordinations}` : ''}
${outreachIdentity ? `\n## Outreach identity\n${outreachIdentity}` : ''}

## After completing actions
If the action you just completed has downstream effects on customers (cancellations, schedule changes), end your reply with a brief offer to notify them — phrased naturally, never the same way twice. Do not notify customers automatically — ask first.

## Memory
Cross-session context:
${memorySummary}
${historyBlock ? `\n## Recent conversation\n${historyBlock}` : ''}
${actionLedger ? `\n${actionLedger}` : ''}`
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
    case 'selectCalendar':
      return executeSelectCalendar(args as unknown as Parameters<typeof executeSelectCalendar>[0], ctx)
    case 'scheduleGroupSession':
      return executeScheduleGroupSession(args as unknown as Parameters<typeof executeScheduleGroupSession>[0], ctx)
    case 'deleteCalendarEvent':
      return executeDeleteCalendarEvent(args as unknown as Parameters<typeof executeDeleteCalendarEvent>[0], ctx)
    case 'editClassSession':
      return executeEditClassSession(args as unknown as Parameters<typeof executeEditClassSession>[0], ctx)
    case 'scheduleRecurringClasses':
      return executeScheduleRecurringClasses(args as unknown as Parameters<typeof executeScheduleRecurringClasses>[0], ctx)
    case 'manageBusinessSettings':
      return executeManageBusinessSettings(args as unknown as Parameters<typeof executeManageBusinessSettings>[0], ctx)
    case 'searchWeb':
      return executeSearchWeb(args as unknown as Parameters<typeof executeSearchWeb>[0], ctx)
    case 'lookupCustomer':
      return executeLookupCustomer(args as unknown as Parameters<typeof executeLookupCustomer>[0], ctx)
    case 'saveContactNote':
      return executeSaveContactNote(args as unknown as Parameters<typeof executeSaveContactNote>[0], ctx)
    case 'connectGoogleCalendar':
      return executeConnectGoogleCalendar(args as unknown as Parameters<typeof executeConnectGoogleCalendar>[0], ctx)
    case 'messageCustomer':
      return executeMessageCustomer(args as unknown as Parameters<typeof executeMessageCustomer>[0], ctx)
    case 'coordinateMeeting':
      return executeCoordinateMeeting(args as unknown as Parameters<typeof executeCoordinateMeeting>[0], ctx)
    case 'resolveMeetingCoordination':
      return executeResolveMeetingCoordination(args as unknown as Parameters<typeof executeResolveMeetingCoordination>[0], ctx)
    case 'pauseConversation':
      return executePauseConversation(args as unknown as Parameters<typeof executePauseConversation>[0], ctx)
    case 'resumeConversation':
      return executeResumeConversation(args as unknown as Parameters<typeof executeResumeConversation>[0], ctx)
    case 'approveReshuffle':
      return executeApproveReshuffle(args as unknown as Parameters<typeof executeApproveReshuffle>[0], ctx)
    case 'rejectReshuffle':
      return executeRejectReshuffle(args as unknown as Parameters<typeof executeRejectReshuffle>[0], ctx)
    case 'amendReshuffle':
      return executeAmendReshuffle(args as unknown as Parameters<typeof executeAmendReshuffle>[0], ctx)
    case 'configureReshuffle':
      return executeConfigureReshuffle(args as unknown as Parameters<typeof executeConfigureReshuffle>[0], ctx)
    case 'decideFreedSlotOffer':
      return executeDecideFreedSlotOffer(args as unknown as Parameters<typeof executeDecideFreedSlotOffer>[0], ctx)
    case 'checkCalendarIntegrity':
      return executeCheckCalendarIntegrity(args as unknown as Parameters<typeof executeCheckCalendarIntegrity>[0], ctx)
    default:
      return { error: `Unknown tool: ${name}` }
  }
}

// ── L2 claim auditor ────────────────────────────────────────────────────────────
//
// Generalizes Branch 4's assertsBookingConfirmed guard (decision D3): never let the
// orchestrator's reply assert a high-risk action that did not actually happen. A claim is
// "backed" only by a real successful tool call this turn (or, for calendar_connected, a
// prior real connection). Unbacked claims trigger one corrective regeneration, then a safe
// honest fallback — the same regenerate-or-fall-back shape the booking guard already uses.

// Maps a tool's result to the claims it legitimately backs. Inspects the result object,
// not just ok/error status: messageCustomer returns {ok:false,reason} on a blocked send,
// which is not an "error" and must NOT back a "message sent" claim. connectGoogleCalendar
// is deliberately absent — it only produces a link, it does not connect the calendar.
function actionsFromToolResult(name: string, result: unknown): ActionClaim[] {
  const r = (result ?? {}) as Record<string, unknown>
  const failed = 'error' in r || r['ok'] === false || r['success'] === false || r['needsClarification'] === true
  if (failed) return []
  switch (name) {
    case 'messageCustomer':
      return ['message_sent']
    case 'createCalendarEvent':
    case 'scheduleGroupSession':
    case 'scheduleRecurringClasses':
      return ['booking_made']
    case 'deleteCalendarEvent':
    case 'manageBusinessSettings':
      return ['cancelled']
    default:
      return []
  }
}

const CLAIM_LABEL: Record<ActionClaim, string> = {
  booking_made: 'that a booking was made or confirmed',
  message_sent: 'that a message was sent to a customer',
  calendar_connected: 'that the Google Calendar is connected',
  cancelled: 'that a booking was cancelled',
}

const SAFE_AUDIT_FALLBACK: Record<Lang, string> = {
  he: 'רגע אחד — אני רוצה לוודא לפני שאני אומר שמשהו בוצע. אבדוק ואחזור אליך.',
  en: "One sec — I want to verify before I say anything's done. I'll check and get back to you.",
}

function unbackedClaims(text: string, lang: Lang, backed: Set<ActionClaim>, calendarConnected: boolean): ActionClaim[] {
  return detectActionClaims(text, lang).filter((c) =>
    c === 'calendar_connected' ? !(calendarConnected || backed.has(c)) : !backed.has(c),
  )
}

async function auditReplyClaims(params: {
  draft: string
  lang: Lang
  backed: Set<ActionClaim>
  calendarConnected: boolean
  contents: Content[]
  systemPrompt: string
  businessId: string
  actorId: string
}): Promise<string> {
  const { draft, lang, backed, calendarConnected, contents, systemPrompt, businessId, actorId } = params
  const unbacked = unbackedClaims(draft, lang, backed, calendarConnected)
  if (unbacked.length === 0) return draft

  // L3 (observability): a durable, queryable record of every caught hallucination —
  // outcome filled in below (corrected vs blocked). Best-effort, never blocks the reply.
  const recordIntervention = (outcome: 'corrected' | 'blocked') =>
    logAudit(db, {
      businessId,
      actorId,
      action: 'audit.unbacked_claim',
      entityType: 'conversation',
      metadata: { claims: unbacked, outcome },
    }).catch(() => { /* best-effort */ })

  const list = unbacked.map((c) => CLAIM_LABEL[c]).join('; ')
  const correction = `SYSTEM CHECK — your draft reply implies ${list}, but no such action actually happened this turn and the records do not show it. Rewrite your reply WITHOUT stating it as done. If it still needs doing, say what you will do or ask — never claim a completed action that did not happen. Keep everything else.`

  const correctionContents: Content[] = [
    ...contents,
    { role: 'model', parts: [{ text: draft }] },
    { role: 'user', parts: [{ text: correction }] },
  ]
  // Text-only regeneration (no tools) — we are fixing wording, not taking new actions.
  const result = await generateOrchestratorTurn(correctionContents, { systemInstruction: systemPrompt, maxOutputTokens: 1024 })
  const corrected = result.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text
  if (!corrected || unbackedClaims(corrected, lang, backed, calendarConnected).length > 0) {
    await recordIntervention('blocked')
    return SAFE_AUDIT_FALLBACK[lang]
  }
  await recordIntervention('corrected')
  return corrected
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
  calendarMode?: 'google' | 'internal'
  transcript: TranscriptTurn[]
  businessKnowledge: BusinessKnowledge | null
  instructorRoster: InstructorRosterEntry[]
  teachingSchedule: TeachingSlot[]
  // Caller role + granted actions — threaded into ToolContext so delegated staff
  // are gated to the actions the owner declared. Defaults to manager when omitted.
  role?: IdentityRole
  delegatedPermissions?: Set<Action>
  // ── Test seams (optional; production never sets these) ─────────────────────
  // Let the quality harness grade the real Gemini function-calling loop + the
  // real system prompt against FIXED tool results, with no DB or calendar. When
  // omitted, the loop uses the production dispatcher and DB-backed memory loader,
  // so runtime behaviour is unchanged. See tests/quality/scenarios.test.ts.
  dispatchToolFn?: (name: string, args: Record<string, unknown>, ctx: ToolContext) => Promise<object>
  loadMemoryFn?: (identityId: string) => Promise<string[]>
  loadLedgerFn?: () => Promise<string>
}

export async function runManagerOrchestratorLoop(params: OrchestratorParams): Promise<string> {
  const {
    messageId, message, sessionId, businessId, identityId,
    businessName, timezone, lang, calendar, transcript, businessKnowledge, instructorRoster, teachingSchedule,
  } = params

  const loadMemory = params.loadMemoryFn ?? loadManagerMemorySummaries
  const dispatch = params.dispatchToolFn ?? dispatchTool

  const managerMemorySummaries = await loadMemory(identityId)

  // L1 grounding: the authoritative record of real actions, injected so the model trusts
  // what the system actually did over what the chat prose claims. Best-effort — a ledger
  // read failure must never drop a turn.
  const loadLedger = params.loadLedgerFn
    ?? (() => buildActionLedgerBlock(db, { businessId, timezone, lang, scope: 'business' }))
  const actionLedger = await loadLedger().catch(() => '')

  const coordRows = await findActiveByBusiness(db, businessId)
  const activeCoordinations = coordRows.length
    ? coordRows.map((c) => {
        const when = c.agreedSlotStart
          ? ` (proposed ${new Intl.DateTimeFormat(lang === 'he' ? 'he-IL' : 'en-GB', { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(c.agreedSlotStart)})`
          : ''
        return `[${c.id}] "${c.title}" — ${c.status}${when}. To act on it, call resolveMeetingCoordination with this id.`
      }).join('\n')
    : ''

  const [mgrName] = await db
    .select({ name: identities.displayName })
    .from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.role, 'manager')))
    .limit(1)
    .catch(() => [undefined as { name: string | null } | undefined])
  const [bizRow] = await db
    .select({ mode: businessesTable.outreachIdentityMode })
    .from(businessesTable)
    .where(eq(businessesTable.id, businessId))
    .limit(1)
    .catch(() => [undefined as { mode: 'business' | 'owner_name' | null } | undefined])
  const ownerNameOnFile = mgrName?.name && mgrName.name.trim().toLowerCase() !== 'owner' ? mgrName.name.trim() : null
  const outreachIdentity = bizRow?.mode === 'business'
    ? `When reaching out on the owner's behalf, introduce yourself as "${businessName}".`
    : bizRow?.mode === 'owner_name' && ownerNameOnFile
      ? `When reaching out on the owner's behalf, introduce yourself as "${ownerNameOnFile}'s assistant".`
      : `Not set yet — before your first outreach on the owner's behalf, ask whether to identify as "${businessName}" or the owner's assistant. Owner's name on file: ${ownerNameOnFile ?? '(placeholder — ask for it if they choose to be named)'}.`

  const systemPrompt = buildSystemPrompt({
    businessName,
    timezone,
    lang,
    businessKnowledge,
    instructorRoster,
    teachingSchedule,
    managerMemorySummaries,
    actionLedger,
    activeCoordinations,
    outreachIdentity,
    conversationHistory: transcript.slice(-20),
  })

  const ctx: ToolContext = {
    db, businessId, identityId, timezone, lang, calendar,
    ...(params.calendarMode ? { calendarMode: params.calendarMode } : {}),
    ...(params.role ? { role: params.role } : {}),
    ...(params.delegatedPermissions ? { delegatedPermissions: params.delegatedPermissions } : {}),
  }

  const tools = [{ functionDeclarations: MANAGER_TOOLS }]

  const contents: Content[] = [
    { role: 'user', parts: [{ text: message }] },
  ]

  let iterations = 0
  const loopStart = Date.now()
  const fallback = lang === 'he' ? 'רגע, משהו נתקע לי — אפשר לנסות שוב?' : 'Hmm, something got stuck on my end — mind trying that again?'

  // L2 claim auditor state: which high-risk actions actually succeeded this turn, and
  // whether the calendar was already connected (the only thing that backs a "connected"
  // claim). Both best-effort — never let the auditor's bookkeeping drop a turn.
  const succeededActions = new Set<ActionClaim>()
  const calendarAlreadyConnected = await hasCalendarConnected(db, businessId).catch(() => false)

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
        actionsFromToolResult(toolName, toolResult).forEach((a) => succeededActions.add(a))
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
      // L2: reconcile the reply's claims against what actually happened; correct or
      // fall back if it asserts an unbacked action. Fail-open — never drop the turn.
      const finalReply = await auditReplyClaims({
        draft: textPart,
        lang,
        backed: succeededActions,
        calendarConnected: calendarAlreadyConnected,
        contents,
        systemPrompt,
        businessId,
        actorId: identityId,
      }).catch(() => textPart)
      logOrchestratorCompletion({
        businessId, sessionId, messageId,
        totalIterations: iterations,
        finalReply,
        totalDurationMs: Date.now() - loopStart,
      })
      return finalReply
    }

    // No function calls, no text — shouldn't happen; break out
    break
  }

  logOrchestratorError({ businessId, sessionId, messageId, error: `Loop exhausted after ${iterations} iterations` })
  return fallback
}
