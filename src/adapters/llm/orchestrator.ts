/**
 * Branch 3 manager orchestrator — Gemini native function-calling loop.
 * Replaces the classify→apply pipeline for post-onboarding manager messages.
 */

import { GoogleGenAI, Type, FunctionCallingConfigMode } from '@google/genai'
import type { Content, FunctionDeclaration } from '@google/genai'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { managerMemory, identities, businesses as businessesTable, serviceTypes, pendingOwnerQuestions } from '../../db/schema.js'
import type { IdentityRole } from '../../db/schema.js'
import type { Action } from '../../domain/authorization/check.js'
import { buildInstructorRosterBlock, buildTeachingScheduleBlock, type InstructorRosterEntry, type TeachingSlot } from '../../domain/provider/roster.js'
import type { CalendarClient } from '../calendar/client.js'
import type { TranscriptTurn } from './types.js'
import type { Lang } from '../../domain/i18n/t.js'
import type { BusinessKnowledge } from '../../shared/skill-types.js'
import type { NegotiationConstraints } from '../../domain/flows/negotiation-constraints.js'
import { buildVoiceCore } from './voice.js'
import { MODELS } from './models.js'
import {
  executeListCalendarEvents,
  executeCreateCalendarEvent,
  executeSelectCalendar,
  executeScheduleGroupSession,
  executeBlockOpenTimeAroundClasses,
  executeDeleteCalendarEvent,
  executeEditClassSession,
  executeScheduleRecurringClasses,
  executeManageBusinessSettings,
  executeGetSessionRoster,
  executeSearchWeb,
  executeLookupCustomer,
  executeSaveContactNote,
  executePauseConversation,
  executeResumeConversation,
  executeApproveReshuffle,
  executeRejectReshuffle,
  executeResolveProactiveProposal,
  executeResolveBookingApproval,
  executeAmendReshuffle,
  executeConfigureReshuffle,
  executeConfigureNotifications,
  executeConfigureDailyBriefing,
  executeManageAllowedContacts,
  executeConfigurePaymentTiming,
  executeSetInitiationAutonomy,
  executeDecideFreedSlotOffer,
  executeCheckCalendarIntegrity,
  executeConnectGoogleCalendar,
  executeConnectPayments,
  executeRequestPayment,
  executeRefundPayment,
  executeMessageCustomer,
  executeAnswerCustomerQuestion,
  executeBroadcastAnnouncement,
  executeSetCustomerName,
  type ToolContext,
} from '../../domain/manager/orchestrator-tools.js'
import { executeViewWaitlist } from '../../domain/manager/waitlist-view.js'
import { executeCoordinateMeeting, executeResolveMeetingCoordination } from '../../domain/manager/coordination-tools.js'
import { findActiveByBusiness } from '../../domain/coordination/repository.js'
import {
  logOrchestratorIteration,
  logOrchestratorCompletion,
  logOrchestratorError,
} from '../../domain/orchestrator-log.js'
import { buildActionLedgerBlock, hasCalendarConnected } from '../../domain/audit/ledger-block.js'
import { detectActionClaims, type ActionClaim } from '../../domain/flows/reply-guard.js'
import { extractClockTimes, extractMentionedTimes } from '../../domain/flows/slot-fabrication-guard.js'
import { observeVoiceTells } from '../../domain/flows/voice-guard.js'
import { logAudit } from '../../domain/audit/logger.js'
import { buildTurnLedger, type OccupancySpine, type TurnLedger } from '../../domain/grounding/turn-ledger.js'
import { gateReply, makeRegenBudget, tryConsumeRegen, type RegenBudget } from '../../domain/grounding/output-gate.js'
import { listDayOptions, type DayOptions } from '../../domain/availability/day-options.js'
import { resolveRequestedDate, type RequestedDateParts, type RelativeDay } from '../../domain/availability/resolve-slot.js'

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
    name: 'getSessionRoster',
    description: 'Get the LIVE, authoritative roster for ONE specific class/group session — how many people are booked, how many spots are left, the capacity, and the participants\' names. Use this WHENEVER the owner asks how many are booked for a session, who is booked, whether a session is full, or whether a session\'s roster/headcount changed (e.g. "how many in tomorrow\'s 10:00 yoga?", "who\'s in the Tuesday pilates?", "did anyone drop the morning class?"). It excludes cancelled and rescheduled-out bookings, so it reflects the true current count. Identify the session by service name + date + start time. Report the date/time as structured pieces — NEVER compute an absolute or ISO date yourself.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        serviceName: { type: Type.STRING, description: 'Name of the class/service for the session (matched fuzzily). Optional only when the business has a single service; otherwise required so the right session is found.' },
        date: DATE_PIECES_SCHEMA,
        time: timeSchema('Start clock time of the session, 24-hour, as the owner said it'),
      },
      required: ['date', 'time'],
    },
  },
  {
    name: 'viewWaitlist',
    description: 'See WHO is on the waitlist for a full class/service — the people waiting for a spot to open. Use this whenever the owner asks who is waiting, how many are on the list, or who is next for a session (e.g. "who\'s on the waitlist for yoga?", "anyone waiting for tomorrow\'s 10:00 pilates?", "how many waiting for the Tuesday class?"). Read-only: it never adds, offers, or removes anyone. Returns each waiter\'s name, phone, status, and fairness tier ("priority" = nothing else booked this week, offered first; "normal" = already has a session this week), already ordered the way the system would offer a freed seat. Identify the list by service name; add the date + time only if the owner asked about ONE specific session. Report date/time as structured pieces — never compute an absolute or ISO date yourself.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        serviceName: { type: Type.STRING, description: 'Name of the class/service whose waitlist to read (matched fuzzily). Optional only when the business has a single service; otherwise required.' },
        date: { ...DATE_PIECES_SCHEMA, description: 'Only when the owner asks about ONE specific session — the day of that session, as structured pieces. Omit to see the whole service\'s waitlist.' },
        time: timeSchema('Only with date — the session\'s start clock time, 24-hour, as the owner said it. Omit to see the whole service\'s waitlist.'),
      },
    },
  },
  {
    name: 'createCalendarEvent',
    description: 'Create a personal or business event on the calendar (team meetings, blocks, personal appointments). This is for non-customer events. To block time from customer bookings, use manageBusinessSettings instead. Report the date/time the manager said as structured pieces — NEVER compute an absolute or ISO date yourself; a deterministic system resolves them. If this business requires owner approval before bookings, the tool returns status "awaiting_owner_approval" on the first call — relay the proposal to the owner, and only re-call with ownerApproved:true once they say yes.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING },
        date: DATE_PIECES_SCHEMA,
        startTime: timeSchema('Start clock time the manager said, 24-hour'),
        endTime: timeSchema('End clock time the manager said, 24-hour'),
        notes: { type: Type.STRING },
        ownerApproved: { type: Type.BOOLEAN, description: 'Set true ONLY after the owner has explicitly approved this specific event in an owner-approval business. Never set it pre-emptively.' },
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
    name: 'blockOpenTimeAroundClasses',
    description: 'Block all the OPEN in-hours time AROUND the existing scheduled classes for a date range, in ONE step — use this for "this week customers may only book the existing classes, block everything else", "keep the group classes but block all the other hours Sun–Thu", "don\'t let anyone book outside the classes next week". It reads the real class schedule and the business hours and blocks every gap between classes, NEVER touching a class slot (the classes stay fully bookable). It is atomic and finishes immediately — do NOT block hours one-by-one or promise to "go through the rest later". VISIBILITY: ask the owner ONCE whether these should show up as real "blocked time" in their Google calendar (visibility:"google") or just be kept off-limits internally without cluttering their calendar (visibility:"internal"). Default to "internal" when they simply want customers not to book outside the classes (the common case). Either way customers can no longer book those hours. Report date ranges as structured pieces — NEVER compute an ISO date yourself.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        fromDate: DATE_PIECES_SCHEMA,
        toDate: DATE_PIECES_SCHEMA,
        weekdays: {
          type: Type.ARRAY,
          items: { type: Type.NUMBER },
          description: 'Restrict to these weekdays: 0=Sunday … 6=Saturday. E.g. Sun–Thu = [0,1,2,3,4]. Omit to block every day in the range.',
        },
        visibility: {
          type: Type.STRING,
          enum: ['internal', 'google'],
          description: '"internal" = off-limits hours kept inside the system, invisible in the owner\'s Google calendar (default; use for "just don\'t let customers book outside the classes"). "google" = real blocked-time events the owner sees in their Google calendar. Ask the owner once if unclear; default to "internal".',
        },
      },
      required: ['fromDate', 'toDate'],
    },
  },
  {
    name: 'manageBusinessSettings',
    description: "Change business configuration: hours, services, a service's calendar color, whether a service is a group class or a 1-on-1 appointment, booking policies, the business's physical address/location, staff permissions, instructors/teaching staff, or cancel a customer booking. Use this when the manager wants to change what customers can book, when they can book, what services are offered, pricing, a service's Google Calendar color (e.g. 'make Yoga blue', 'color Pilates red'), whether a service is a group class or private 1-on-1 (e.g. 'Pilates is a group class for 8', 'switch physio to 1-on-1'), the business address (e.g. 'our address is Herzl 1 Tel Aviv', 'we moved to 5 Dizengoff', 'עברנו לכתובת חדשה') — this is the location the PA gives customers who ask where you are, who has access, to add or manage instructors and their weekly hours (e.g. 'add Dana as a yoga instructor Mon/Wed 9–13', 'change Dana's hours', 'remove Dana'), or wants to cancel a specific booking. Pass the manager's exact instruction.",
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
    name: 'setCustomerName',
    description: "Save or correct a customer's name (first/display name and/or last name). Use after the owner tells you a customer's name — e.g. when they clarify WHICH of two same-name customers they meant, or fix a misspelling. Look the customer up first (lookupCustomer) to get their identityId. Pass the full name in displayName; pass lastName when the owner states it explicitly.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        identityId: { type: Type.STRING, description: "The customer's identityId, from lookupCustomer." },
        displayName: { type: Type.STRING, description: "The customer's name as it should be displayed (e.g. \"Guy Cohen\")." },
        lastName: { type: Type.STRING, description: "The customer's last name, when stated explicitly. If omitted, it is derived from displayName." },
      },
      required: ['identityId'],
    },
  },
  {
    name: 'connectGoogleCalendar',
    description: "Generate the link the owner taps to connect their Google Calendar. Use this WHENEVER the owner wants to connect/sync/link Google Calendar. It returns the real sign-in URL — you then send that link to the owner here in WhatsApp. You have NO email and cannot send anything by email; never say you emailed a link or ask which email to use.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'connectPayments',
    description: "Generate the link the owner taps to connect their payments processor (Grow / Meshulam) so the PA can send pay-links and invoices automatically. Use this WHENEVER the owner wants to connect/set up/enable payments, charging, or invoicing. It returns a secure one-time URL — send that link to the owner here in WhatsApp on its own line. The form collects API credentials (not the Grow password). You have NO email; never say you emailed a link.",
    parameters: { type: Type.OBJECT, properties: {} },
  },
  {
    name: 'requestPayment',
    description: "Charge a specific customer — create a pay-link and send it to them — when the owner asks (e.g. \"send Dana a link for the ₪300 session\", \"charge Yossi 150 for the workshop\"). You pass ONLY who to charge, how much, and what it is for; the system creates the real Grow pay-link, delivers it to the customer, and later confirms payment + forwards the invoice automatically. Pass the customer's phone number when the owner gives one (lets you reach someone new); otherwise pass their name to match a customer on file. Only tell the owner the link was sent if this tool returns ok:true — it may report the customer can't be reached or that payments aren't connected, in which case relay that honestly.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        customer: { type: Type.STRING, description: 'The customer to charge — their name on file, or their phone number in E.164.' },
        phoneNumber: { type: Type.STRING, description: "Customer phone in E.164 (e.g. +972541234567) when the owner provides one — preferred, lets you reach a new contact." },
        amount: { type: Type.NUMBER, description: 'Amount to charge, in the business currency (ILS). A positive number.' },
        description: { type: Type.STRING, description: 'Short description of what the charge is for (appears on the pay-link and invoice), e.g. "Reformer session".' },
      },
      required: ['amount', 'description'],
    },
  },
  {
    name: 'refundTransaction',
    description: "Refund a customer's completed payment when the owner asks (e.g. \"refund Dana's payment\", \"give Yossi his ₪300 back\"). You pass only WHO to refund; the system finds their most recent completed payment and refunds it at the processor. Pass the phone number when the owner gives one; otherwise the name on file. Only tell the owner the refund went through if this tool returns ok:true — it may report there's nothing to refund or that the processor refused, in which case relay that honestly.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        customer: { type: Type.STRING, description: 'The customer to refund — their name on file, or phone number in E.164.' },
        phoneNumber: { type: Type.STRING, description: 'Customer phone in E.164 when the owner provides one.' },
      },
    },
  },
  {
    name: 'messageCustomer',
    description: "Send a WhatsApp message to ONE specific customer on the owner's behalf (e.g. \"text Harel and ask when he's free this week\", \"let Dana know class is cancelled\"). Compose the message yourself and confirm with the owner before calling. Pass the customer's phone number when the owner gives one (lets you reach someone new); otherwise pass the name to match a customer on file. Only report the message as sent if this tool returns ok:true — it may report the customer can't be reached, in which case tell the owner the truth. When the owner is asking the customer to MOVE an existing appointment as a favour (\"ask Dana to push her 14:00 to 16:00\"), also pass rescheduleFavor with the current and new times — that lets the message still reach the customer (via an approved template) even if they're outside the 24-hour window.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        phoneNumber: { type: Type.STRING, description: "Customer phone in E.164 (e.g. +972541234567) when the owner provides it. Preferred — lets you message a new contact." },
        name: { type: Type.STRING, description: 'Customer name to match an existing customer, when no phone number is given.' },
        lastName: { type: Type.STRING, description: "The customer's last name, supplied by the owner to disambiguate when several customers share a first name." },
        message: { type: Type.STRING, description: "The full message text to send, composed in the customer's language. Warm and natural — this is what the customer receives verbatim." },
        rescheduleFavor: {
          type: Type.OBJECT,
          description: "Only when the message is asking the customer to move an existing appointment as a favour. Carries the current and new times so an out-of-window send can fall back to the approved reschedule-favour template. Times are short human-readable strings in the customer's language (e.g. \"מחר 14:00\", \"Tomorrow 16:00\").",
          properties: {
            currentTime: { type: Type.STRING, description: "The appointment's current time, human-readable." },
            newTime: { type: Type.STRING, description: 'The proposed new time, human-readable.' },
          },
          required: ['currentTime', 'newTime'],
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'answerCustomerQuestion',
    description: "Answer a customer's question that the PA couldn't answer and relayed to you (see 'Customer questions waiting for your answer'). Call this with the owner's answer and the question's id; your answer is sent straight back to the customer. If exactly one question is waiting and the owner just types the answer, you may omit questionId — the single open question is used. Only relay an answer the owner actually gave; never invent one. After it returns ok:true, tell the owner you passed their answer on.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        questionId: { type: Type.STRING, description: "The waiting question's id (the [bracketed] id in the 'Customer questions waiting' list). Omit only when exactly one question is open." },
        answer: { type: Type.STRING, description: "The answer to send the customer, in the customer's language, composed from what the owner told you. Sent verbatim (with a short lead-in)." },
      },
      required: ['answer'],
    },
  },
  {
    name: 'broadcastAnnouncement',
    description: "Send a one-off announcement to MANY customers at once on the owner's behalf — only one of three fixed kinds: a change of opening HOURS, a change of ADDRESS, or a PROMO/special offer. Use this (not messageCustomer, which is for ONE person) when the owner wants to tell their customers something like \"let everyone know we're closed Friday\" or \"tell my regulars about the holiday sale\". Confirm the exact wording of the detail with the owner first. By default it reaches all customers; pass segmentFilter to narrow it (e.g. only lapsed customers, or only a service's customers). Report the real send counts the tool returns — never inflate them.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        kind: { type: Type.STRING, enum: ['hours_change', 'address_change', 'promo'], description: 'Which fixed-shape announcement: new opening hours, new address, or a promotion.' },
        detail: { type: Type.STRING, description: "The specific detail to announce, in the customers' language — the new hours (\"א-ה 9:00-18:00\"), the new address, or the promo terms (\"20% הנחה עד סוף החודש\"). This is the only free part; keep it short." },
        segmentFilter: { type: Type.OBJECT, description: 'Optional segment to narrow recipients: { serviceTypeId?, inactiveSinceDays?, hasBooking?, lapsed?, vip?, providerId? }. Omit to reach all customers.' },
      },
      required: ['kind', 'detail'],
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
    name: 'resolveProactiveProposal',
    description: "Resolve a pending PROACTIVE suggestion the PA asked the owner about — e.g. a win-back check-in for a lapsed customer (\"Dana hasn't visited in a while — send her a friendly check-in?\"). Only call this when the owner clearly approves or declines such a suggestion ('yes, message Dana' → decision 'approve'; 'no, she's away' → decision 'decline'). On approve, the PA composes and sends the check-in itself; do not also use messageCustomer. Pass recipientName if the owner names the customer, so the right suggestion is picked when several are waiting.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        decision: { type: Type.STRING, enum: ['approve', 'decline'], description: 'Whether the owner approved (send it) or declined (do not send) the suggestion' },
        recipientName: { type: Type.STRING, description: "The customer's name if the owner named one (partial match), to disambiguate when several suggestions are pending" },
      },
      required: ['decision'],
    },
  },
  {
    name: 'resolveBookingApproval',
    description: "Approve or decline a CUSTOMER's self-booking that is waiting for the owner's OK (only for services where the owner turned on \"require my approval\"). Call this when the owner answers a pending approval request — 'yes, approve Dana's yoga' / 'go ahead' → decision 'approve'; 'no, decline that' / 'turn it down' → decision 'decline'. On approve the booking is confirmed (or, for a paid service, the customer gets a pay-link); on decline it's cancelled and the customer is invited to rebook. Pass customerHint and/or serviceHint (the customer name/phone and service the owner referred to) so the right request is picked when several are waiting — if it's still ambiguous the tool will ask which one. This is for customers booking THEMSELVES; it is NOT the PA-books-on-owner's-behalf approval (that is the createCalendarEvent ownerApproved flow).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        decision: { type: Type.STRING, enum: ['approve', 'decline'], description: "Whether the owner approved (book it) or declined (turn it down) the customer's request" },
        customerHint: { type: Type.STRING, description: "The customer's name or phone if the owner named one, to pick the right pending request" },
        serviceHint: { type: Type.STRING, description: 'The service the owner referred to, to pick the right pending request' },
        bookingId: { type: Type.STRING, description: 'The exact booking id, if known from a prior lookup (wins over the hints)' },
      },
      required: ['decision'],
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
    name: 'configureNotifications',
    description: "Set how the owner wants to be notified about a business event. Use when the owner says things like 'only tell me about cancellations within 24 hours', 'stop pinging me on every new booking', 'handle no-shows silently', or 'let me know when someone pays'. One event per call. Note: payment_received is SILENT by default (the PA handles payments end to end) — use it when the owner wants to start (or stop) being told about incoming payments. Use action 'digest' when the owner says things like 'don't ping me every time, just put cancellations in my daily summary' or 'batch the reschedules'.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        event: { type: Type.STRING, enum: ['new_booking', 'first_time_customer', 'cancellation', 'reschedule', 'no_show', 'refund_request', 'vip_return', 'payment_received'], description: 'Which business event this rule is about' },
        action: { type: Type.STRING, enum: ['notify', 'notify_with_actions', 'handle_silently', 'digest'], description: 'notify = tell me right away; notify_with_actions = tell me with quick action buttons; handle_silently = do not tell me; digest = do not ping me live, collect these and include them in my daily briefing' },
        withinHours: { type: Type.NUMBER, description: 'Optional: only apply when the affected booking is within this many hours (e.g. 24 for "cancellations inside 24h")' },
        remove: { type: Type.BOOLEAN, description: 'Remove the existing rule for this event instead of setting one' },
      },
      required: ['event'],
    },
  },
  {
    name: 'configureDailyBriefing',
    description: "Turn the owner's daily briefing on or off and set the time it's sent. Use when the owner says things like 'send me a daily summary at 8am', 'turn on the morning briefing', 'stop the daily summary', or 'move my briefing to 18:00'. The daily briefing is also when batched ('digest') notifications are delivered. Provide enabled and/or time (24-hour HH:MM, business-local). Convert the owner's wording (e.g. '8am') into HH:MM yourself.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        enabled: { type: Type.BOOLEAN, description: 'Turn the daily briefing on (true) or off (false)' },
        time: { type: Type.STRING, description: "Time of day to send it, 24-hour HH:MM business-local, e.g. '08:00' or '18:30'" },
      },
    },
  },
  {
    name: 'manageAllowedContacts',
    description: "Control which phone numbers the PA is allowed to talk to. Use when the owner says things like 'only respond to numbers I approve', 'just talk to these clients', 'add +972501234567 to the allowed list', 'allow 0501234567', 'stop the restriction', or 'who's on the allowed list?'. When restriction is ON, only allowed numbers (and you, your staff, and coordination contacts) reach the PA — everyone else is silently ignored and you get a heads-up. Adding a number turns the restriction ON automatically if it was off. One operation per call. Convert any local number the owner gives into full international (E.164) format yourself before calling.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        op: { type: Type.STRING, enum: ['enable', 'disable', 'add', 'remove', 'list'], description: 'enable/disable the restriction mode, add/remove a number, or list the current list' },
        phone: { type: Type.STRING, description: 'Required for add/remove. Full international format, e.g. +972501234567' },
        label: { type: Type.STRING, description: 'Optional name for the number when adding (e.g. the client name)' },
      },
      required: ['op'],
    },
  },
  {
    name: 'configurePaymentTiming',
    description: "Set WHEN the PA sends the pay-link for a booking that needs payment, relative to the appointment. Use when the owner says things like 'send pay-links 24 hours before the appointment', 'send the payment request at booking', or 'charge them an hour after the session'. Pass policy 'at_booking' to send as soon as the booking is made (the default), or policy 'offset' with offsetMinutes = how far from the appointment start to send: NEGATIVE for before (24h before = -1440, 1h before = -60), POSITIVE for after (1h after = 60). Convert the owner's wording into minutes yourself.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        policy: { type: Type.STRING, enum: ['at_booking', 'offset'], description: "'at_booking' = send the pay-link as soon as the booking is made; 'offset' = send it a fixed time before/after the appointment (provide offsetMinutes)" },
        offsetMinutes: { type: Type.NUMBER, description: 'Required when policy is offset. Minutes relative to the appointment start: negative = before (24h before = -1440), positive = after (1h after = 60)' },
      },
      required: ['policy'],
    },
  },
  {
    name: 'setInitiationAutonomy',
    description: "Control whether the PA handles a category of proactive outreach automatically or asks the owner to approve each one. Use when the owner says things like 'keep asking me before win-backs' or 'just handle win-backs yourself from now on'.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        category: { type: Type.STRING, enum: ['winback', 'coldfill', 'review', 'no_show', 'reshuffle'], description: 'Which outreach category' },
        mode: { type: Type.STRING, enum: ['auto', 'ask'], description: 'auto = PA sends without asking; ask = PA proposes each one for approval (and will not auto-promote again)' },
      },
      required: ['category', 'mode'],
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

// Authoritative, closed-world list of what the business ACTUALLY offers — built from
// the live `service_types` rows (the same operational source of truth customers book
// against), NOT from the curated brand description / FAQs, which can lag reality. The
// orchestrator otherwise inferred "services" from the knowledge block, so when a
// service was added later (e.g. physiotherapy) the FAQ doc didn't mention it and the
// PA confidently DENIED a real, bookable service — while Branch 4 correctly offered
// it. This block grounds Branch 3 in the same truth and is marked as overriding.
function buildActiveServicesBlock(
  services: Array<{ name: string; schedulingMode: 'appointment' | 'class'; maxParticipants: number; narrative?: string | null }>,
): string {
  if (services.length === 0) {
    return '## Services offered (authoritative)\nThis business has NO active bookable services configured. Do not claim any service is offered.'
  }
  const lines = services.flatMap((s) => {
    const model = s.schedulingMode === 'class'
      ? (s.maxParticipants > 1 ? `group class, up to ${s.maxParticipants}` : 'class')
      : '1-on-1 appointment'
    const out = [`- ${s.name} (${model})`]
    // T2b.1: surface the owner-authored narrative closed-world so Branch 3 grounds on the
    // same real attribute text as Branch 4 (no divergence between the two service blocks).
    const narrative = s.narrative?.trim()
    if (narrative) out.push(`  · ${s.name} — about this service (owner's own description): ${narrative}`)
    return out
  })
  return [
    '## Services offered (authoritative — the COMPLETE list of what customers can book right now)',
    'This comes from the live booking configuration and OVERRIDES anything implied by the business description or FAQs below. Never deny a service listed here, and never claim a service exists if it is not here. If the owner asks what is offered, answer from THIS list.',
    ...lines,
  ].join('\n')
}

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
  activeServices: Array<{ name: string; schedulingMode: 'appointment' | 'class'; maxParticipants: number; narrative?: string | null }>
  instructorRoster: InstructorRosterEntry[]
  teachingSchedule: TeachingSlot[]
  managerMemorySummaries: string[]
  actionLedger: string
  activeCoordinations: string
  openQuestions: string
  outreachIdentity: string
  bookingAuthority: 'auto' | 'owner_approval'
  conversationHistory: TranscriptTurn[]
}): string {
  const { businessName, timezone, lang, businessKnowledge, activeServices, instructorRoster, teachingSchedule, managerMemorySummaries, actionLedger, activeCoordinations, openQuestions, outreachIdentity, bookingAuthority, conversationHistory } = params
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
  const servicesBlock = buildActiveServicesBlock(activeServices)
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
- *bold* — use RARELY: at most one bolded item per message, usually none. It's for the single fact the eye should catch, not decoration. Do NOT bold every service name, time, date, or number — that reads as cluttered and bot-like. Default to plain text; never bold whole sentences.
- Numbered lists for sequences. Line break separation between items.
- URLs on their own line.

## Dates and times — classify, never compute
For createCalendarEvent, scheduleGroupSession, and listCalendarEvents(list_range), report the date/time the manager said as structured pieces (relativeDay / weekday / explicitDate, and {hour,minute} times). NEVER compute or output an absolute or ISO date — a deterministic system resolves the pieces and validates them. If a calendar tool returns needsClarification: true, the date/time couldn't be resolved (ambiguous, already past, impossible, or a clock time that doesn't exist that day) — do NOT retry the tool with a guessed date; ask the manager for a workable day/time in your own words, without echoing the unusable value.

## Tool usage rules
- manageBusinessSettings: ALWAYS use this for any change to recurring weekly hours, services, pricing, policies, staff access, or booking cancellations. Also use it to set a service's calendar color (e.g. "make Yoga blue", "color Pilates red", "תצבע את היוגה בכחול") and to set whether a service is a group class or a private 1-on-1 appointment (e.g. "Pilates is a group class for 8", "make Yoga a class", "switch physio to 1-on-1"). Also use it to block time from customer bookings (e.g. "block 2–4pm Tuesday"). Use it to STOP or SKIP one date of a recurring weekly class (e.g. "stop the weekly pilates class", "no spin class this coming Tuesday") — but to CREATE/SET UP recurring classes use scheduleRecurringClasses, not this. Also use it to add or manage instructors / teaching staff and their weekly hours (e.g. "add Dana as a yoga instructor Mon/Wed 9–13", "change Dana's hours", "Dana also teaches pilates", "remove Dana"). Also use it to set or change the business's physical ADDRESS / location — the place the PA tells customers who ask where you are (e.g. "our address is Herzl 1 Tel Aviv", "we moved to 5 Dizengoff", "עברנו לכתובת חדשה"). Never handle these as conversational replies. One manageBusinessSettings call handles exactly ONE service — when the owner changes MORE THAN ONE service in a single message (e.g. "make Pilates green and Yoga purple", "Pilates and Yoga are group classes for 8"), call manageBusinessSettings SEPARATELY for each service, once per named service, so every change actually applies. Never pack two services into one instruction — that gets only a clarification back and applies nothing.
- scheduleRecurringClasses: use to CREATE recurring weekly classes — one or many at once (e.g. "yoga every Monday 10am", "yoga and pilates every hour 9–20 Sun–Thu", "breathing Mon & Wed at 10:00 and 16:00"). Expand ranges into explicit days and times yourself. The service must already exist and have a group capacity (>1) or you pass maxParticipants.
- listCalendarEvents: use for schedule questions. Use intent check_free_slots when the manager asks what times are open/free — it returns real bookable openings. Do not call it unless the manager is asking about their calendar.
- getSessionRoster: use for the live headcount/roster of ONE specific session — how many are booked, who is booked, whether a session is full, or whether its roster changed (e.g. "how many in tomorrow's 10:00 yoga?", "who's in the Tuesday class?", "did anyone drop?"). It excludes cancelled/rescheduled-out bookings, so it is the only correct source for participant counts and names.
- createCalendarEvent: personal/business 1-on-1 events only (e.g. "dentist 3pm"). Do not use for blocking customer booking slots — that is manageBusinessSettings.
- scheduleGroupSession: use when the manager wants to put a SINGLE class/group session on the calendar for one specific date ahead of bookings (e.g. "add a yoga class this Tuesday 11am with Dana, 10 spots"). Capture the instructor when named ("with Dana"). For a class that repeats every week ("every Monday", "weekly"), use scheduleRecurringClasses instead.
- editClassSession: use to change an ALREADY-scheduled class on the calendar — its instructor, time, or capacity (e.g. "change tomorrow's 10:00 yoga to Dana", "move the Tuesday breathing to 17:00"). Get its eventId from listCalendarEvents first. Never delete+recreate a class to "edit" it — that drops its bookings.
- deleteCalendarEvent: only for personal/business events, blocks, or classes the manager created. NEVER use for customer bookings — use manageBusinessSettings with a cancellation instruction for those.
- searchWeb: only when the manager explicitly needs external information.
- lookupCustomer / saveContactNote: only for customer or contact management requests. When the owner asks whether a customer has replied or what they said, you MUST call lookupCustomer with recent_messages and answer from the result — never say "not yet" or "they replied" from memory or assumption.
- connectGoogleCalendar: ALWAYS use this when the owner wants to connect, sync, or link Google Calendar. It returns the real sign-in link — send that link to the owner here in WhatsApp, on its own line. You have NO email and no way to send email: never offer to email the link, never ask for an email address, and never claim you emailed anything.
- connectPayments: ALWAYS use this when the owner wants to connect, set up, or enable payments/charging/invoicing (Grow / Meshulam). It returns a secure one-time link — send that link to the owner here on its own line. The form collects API credentials, not the Grow password. If the tool reports payments are already connected, just reassure them. Same email rule: you have NO email, never offer to email the link.
- configurePaymentTiming: use when the owner sets WHEN pay-links go out relative to the appointment (e.g. "send the payment request 24h before", "charge at booking", "1 hour after the session"). Convert their wording into policy + offsetMinutes (negative = before the appointment, positive = after) yourself, then confirm the change in plain words.
- requestPayment: use when the owner wants to charge a specific customer now (e.g. "send Dana a link for the ₪300 session", "charge Yossi 150"). Pass only who/how much/what for — the system makes the real pay-link, sends it, and later confirms payment and forwards the invoice on its own. Only say the link was sent if the tool returns ok:true; if it reports the customer can't be reached or payments aren't connected, relay that truthfully and never pretend a link went out.
- refundTransaction: use when the owner wants to refund a customer's completed payment (e.g. "refund Dana", "give Yossi his money back"). Pass only who to refund — the system finds their most recent completed payment and refunds it. Only say the refund went through if the tool returns ok:true; if it reports there is nothing to refund or the processor refused, relay that honestly and never claim a refund that did not happen.
- messageCustomer: use to actually send a WhatsApp message to a specific customer the owner names (e.g. "ask Harel when he's free"). Compose the message and confirm with the owner first, then call the tool. Only tell the owner the message was sent if the tool returns ok:true; if it reports the customer can't be reached (e.g. they haven't messaged recently), relay that honestly and never pretend it went out.
- coordinateMeeting: use ONLY when the owner wants you to reach out and arrange a meeting whose time is NOT yet agreed — with anyone, INCLUDING an existing customer. First ask, in ONE question, whether they already set a time (then use createCalendarEvent) or want you to coordinate. When coordinating, capture either a primary time + one or two fallbacks, OR day/time windows (ranges) + how long the meeting runs. ALL meeting coordination goes through this tool — never improvise a coordination with messageCustomer + createCalendarEvent. NEVER invent or guess a person's name (the owner's or anyone else's). If you don't know how to introduce yourself for outreach and no preference is shown under "Outreach identity" below, ask the owner once: whether to say you're from {business name} or {owner}'s assistant — and if they pick their own name and you don't have it, ask for it; pass identifyAs (and ownerName) to save it.
- messageCustomer is for a SINGLE one-off ping the owner dictates (e.g. "let Dana know class is cancelled") — never for negotiating a meeting time, and never to work around coordinateMeeting. Do not use createCalendarEvent to book a meeting you coordinated; confirm it with resolveMeetingCoordination instead.
- resolveMeetingCoordination: after the contact replies (you will see active meeting coordinations in your context), use this to confirm the agreed time (which books it and tells them), offer a different time, or abandon it. Only confirm a booking when the owner says to.
- resolveProactiveProposal: use when the owner replies to a proactive check-in YOU suggested for a lapsed customer (e.g. you asked "send Dana a friendly check-in?" and they say "yes, message Dana" → decision 'approve'; "no, she's away" → decision 'decline'). On approve the PA sends the check-in itself — do NOT also call messageCustomer. Pass recipientName when the owner names the customer.

## Never claim an action you did not take
Only state something happened — a message sent, a calendar connected, a booking changed — when a tool actually returned success for it. If you have no tool for what the owner asked, or a tool reports it failed or couldn't proceed, say so plainly and offer a real next step. Never fabricate a confirmation, a link, or an email.
A tool result with success:false, an error, or a clarificationNeeded/needsClarification field means the action did NOT happen and nothing is queued. In that case relay that exact clarification or problem to the owner in your own words and ask for what's needed — NEVER respond as if it succeeded or is in progress. Specifically, never say a change is "done", "updated", "being applied", "saved", or "will show up in a few minutes / shortly" off a failed or clarification result — there is no background job; if you did not get success, it is not happening.
Never say you "checked", "verified", "confirmed", or "made sure" of anything unless you actually called a tool to read it in THIS turn. If you have not verified, do not claim you did — say what you'll do, then do it.

## Never promise to keep working after this turn — there is no background job
You act ONLY within the current turn. You cannot work in the background, continue after you reply, or pick a task back up "in a few moments". After you have done PART of a multi-step request, NEVER say you will "go through the rest", "keep working on it", "finish it shortly", "continue blocking the other days", "update you when I'm done", or "it'll take a few moments" — these are forbidden because nothing runs after your reply, so the promise is always false. Instead: do as much as the turn's tools allow, then state EXACTLY what was done and what still remains, and ask the owner to tell you to continue (each owner message is what lets you do the next part). When a single tool can do the whole job in one call — e.g. blockOpenTimeAroundClasses blocks the open time around the classes for an entire date range at once — use THAT instead of doing it piece by piece, and report the real total it returned. If you genuinely cannot finish in this turn, say so plainly; do not paper over it with a promise to continue.

## Outbound: attempt the tool — never refuse from your own assumption
When the owner asks you to contact, message, notify, or coordinate with a specific person, you MUST actually call the tool (messageCustomer for a one-off message to a customer or a number the owner gives you; coordinateMeeting to negotiate an unset meeting time). The tool — not you — decides deliverability and enforces the real WhatsApp rules. You do NOT know the messaging window or whether someone wrote recently unless a tool tells you. NEVER decline or stall by inventing a rule such as "they have to message us first", "the 24-hour window is closed", or "I can't text a new number" — those are for the tool to determine and report back; if a send truly can't go out, the tool says so (and often falls back to an approved template), and only then do you relay that honestly. Refusing an outbound request without having called the tool is a hard violation. The owner giving a phone number is explicit permission to reach that person.

## Never invent conversation history
Do not claim you spoke to someone, that a person messaged you, when they messaged, or what they said, unless a tool result IN THIS TURN shows it. To check whether someone wrote — or to find a past exchange — call lookupCustomer with recent_messages and answer only from what it returns. Never substitute a real customer's name or number for the person the owner actually asked about, and never assert "I already messaged them / they replied on <day>" from memory. When you have not checked, say you'll check — then check.

## Never report occupancy or a roster from memory
When the owner asks how many people are booked for a session, who is booked, or whether a session's roster changed, you MUST call getSessionRoster (or listCalendarEvents for a whole-day view) and answer ONLY from the result — never from earlier messages in this conversation. A reschedule that moved someone OUT of a slot reduces that slot's count; never assume a count "returned to" a previous value.

## Reflect committed reality — never ask to approve what is already done
The "What actually happened" block below is the single source of truth about what customers have done. If it shows a customer already booked, cancelled, or changed an appointment themselves, that is FINAL and committed — the customer was already told. REFLECT it to the owner as a done fact ("Yoni already booked Pilates himself for Sunday 17:00"). NEVER ask the owner to approve, confirm, or re-book something the ground truth shows is already done, and never tell the owner an action is "still pending" or "waiting" when the block shows it completed. The first committed action wins; your job is to report it truthfully, not to re-litigate it.
${servicesBlock ? `\n${servicesBlock}` : ''}
${knowledgeBlock ? `\n## Business knowledge\n${knowledgeBlock}` : ''}
${rosterBlock ? `\n## Instructors\n${rosterBlock}` : ''}
${teachingScheduleBlock ? `\n## Upcoming classes\n${teachingScheduleBlock}` : ''}
${activeCoordinations ? `\n## Active meeting coordinations\n${activeCoordinations}` : ''}
${openQuestions ? `\n## Customer questions waiting for your answer\nThese customers asked something the PA couldn't answer and were told you'd get back to them. When you give an answer, it is RELAYED to the customer — so answer them here:\n${openQuestions}` : ''}
${outreachIdentity ? `\n## Outreach identity\n${outreachIdentity}` : ''}

## Booking authority
${bookingAuthority === 'owner_approval'
  ? 'This business requires the OWNER\'S EXPLICIT OK before anything is written to the calendar. When you would create an event, the tool returns status "awaiting_owner_approval" instead of booking — tell the owner what you propose to book and ask whether to go ahead, and do NOT say it is booked. Only after the owner clearly approves, call the tool again with ownerApproved:true. (This applies to PA/owner-initiated bookings — customers booking themselves are unaffected.)'
  : 'This business is in auto-book mode: when the owner asks you to put something on the calendar and the slot is open, just book it and confirm — you do not need a second approval step.'}

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
    case 'blockOpenTimeAroundClasses':
      return executeBlockOpenTimeAroundClasses(args as unknown as Parameters<typeof executeBlockOpenTimeAroundClasses>[0], ctx)
    case 'deleteCalendarEvent':
      return executeDeleteCalendarEvent(args as unknown as Parameters<typeof executeDeleteCalendarEvent>[0], ctx)
    case 'editClassSession':
      return executeEditClassSession(args as unknown as Parameters<typeof executeEditClassSession>[0], ctx)
    case 'scheduleRecurringClasses':
      return executeScheduleRecurringClasses(args as unknown as Parameters<typeof executeScheduleRecurringClasses>[0], ctx)
    case 'manageBusinessSettings':
      return executeManageBusinessSettings(args as unknown as Parameters<typeof executeManageBusinessSettings>[0], ctx)
    case 'getSessionRoster':
      return executeGetSessionRoster(args as unknown as Parameters<typeof executeGetSessionRoster>[0], ctx)
    case 'viewWaitlist':
      return executeViewWaitlist(args as unknown as Parameters<typeof executeViewWaitlist>[0], ctx)
    case 'searchWeb':
      return executeSearchWeb(args as unknown as Parameters<typeof executeSearchWeb>[0], ctx)
    case 'lookupCustomer':
      return executeLookupCustomer(args as unknown as Parameters<typeof executeLookupCustomer>[0], ctx)
    case 'saveContactNote':
      return executeSaveContactNote(args as unknown as Parameters<typeof executeSaveContactNote>[0], ctx)
    case 'setCustomerName':
      return executeSetCustomerName(args as unknown as Parameters<typeof executeSetCustomerName>[0], ctx)
    case 'connectGoogleCalendar':
      return executeConnectGoogleCalendar(args as unknown as Parameters<typeof executeConnectGoogleCalendar>[0], ctx)
    case 'connectPayments':
      return executeConnectPayments(args as unknown as Parameters<typeof executeConnectPayments>[0], ctx)
    case 'requestPayment':
      return executeRequestPayment(args as unknown as Parameters<typeof executeRequestPayment>[0], ctx)
    case 'refundTransaction':
      return executeRefundPayment(args as unknown as Parameters<typeof executeRefundPayment>[0], ctx)
    case 'messageCustomer':
      return executeMessageCustomer(args as unknown as Parameters<typeof executeMessageCustomer>[0], ctx)
    case 'answerCustomerQuestion':
      return executeAnswerCustomerQuestion(args as unknown as Parameters<typeof executeAnswerCustomerQuestion>[0], ctx)
    case 'broadcastAnnouncement':
      return executeBroadcastAnnouncement(args as unknown as Parameters<typeof executeBroadcastAnnouncement>[0], ctx)
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
    case 'resolveProactiveProposal':
      return executeResolveProactiveProposal(args as unknown as Parameters<typeof executeResolveProactiveProposal>[0], ctx)
    case 'resolveBookingApproval':
      return executeResolveBookingApproval(args as unknown as Parameters<typeof executeResolveBookingApproval>[0], ctx)
    case 'amendReshuffle':
      return executeAmendReshuffle(args as unknown as Parameters<typeof executeAmendReshuffle>[0], ctx)
    case 'configureReshuffle':
      return executeConfigureReshuffle(args as unknown as Parameters<typeof executeConfigureReshuffle>[0], ctx)
    case 'configureNotifications':
      return executeConfigureNotifications(args as unknown as Parameters<typeof executeConfigureNotifications>[0], ctx)
    case 'configureDailyBriefing':
      return executeConfigureDailyBriefing(args as unknown as Parameters<typeof executeConfigureDailyBriefing>[0], ctx)
    case 'manageAllowedContacts':
      return executeManageAllowedContacts(args as unknown as Parameters<typeof executeManageAllowedContacts>[0], ctx)
    case 'configurePaymentTiming':
      return executeConfigurePaymentTiming(args as unknown as Parameters<typeof executeConfigurePaymentTiming>[0], ctx)
    case 'setInitiationAutonomy':
      return executeSetInitiationAutonomy(args as unknown as Parameters<typeof executeSetInitiationAutonomy>[0], ctx)
    case 'decideFreedSlotOffer':
      return executeDecideFreedSlotOffer(args as unknown as Parameters<typeof executeDecideFreedSlotOffer>[0], ctx)
    case 'checkCalendarIntegrity':
      return executeCheckCalendarIntegrity(args as unknown as Parameters<typeof executeCheckCalendarIntegrity>[0], ctx)
    default:
      return { error: `Unknown tool: ${name}` }
  }
}

// ── Per-turn time allowlist accumulator (T1.1 — H1 prep) ─────────────────────────
//
// The Branch-3 analog of Branch-4's `buildAllowedTimes` boundary/booking base: seed the
// allowlist from what the AVAILABILITY tools actually surfaced this turn, so a manager
// reply that states one of those real times is never flagged as a fabrication. The tool
// result strings are system-authored en-GB/he-IL 24h ("Tue, 3 Jun, 14:00" / "14:00"), so
// `extractClockTimes` recovers the canonical HH:MM — verified against orchestrator-tools
// (`freeSlots[].start/.end`, `buildScheduleView` events). Only the availability READ tools
// are scanned: a stray "14:00" inside a searchWeb snippet is NOT a bookable time and must
// never widen the allowlist. The owner's own quoted times this turn are admitted separately
// in the loop (mirrors Branch-4 `extractMentionedTimes`).
//
// KNOWN LATENT GAP (RED-TEAM D2, out of scope per locked D2): English manager *replies* are
// authored 12h am/pm (lawbook §3.3) and `extractClockTimes` is 24h-only, so the ported time
// gate no-ops for am/pm English replies. H1's time leg is "closed for Hebrew/24h; am/pm is a
// documented follow-up." TODO(am/pm): extend extractClockTimes to 12h before claiming am/pm closed.
const TIME_BEARING_TOOLS = new Set(['listCalendarEvents', 'getSessionRoster'])

/** Recursively collect every string value in an arbitrary tool-result object. */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') { out.push(value); return }
  if (Array.isArray(value)) { for (const v of value) collectStrings(v, out); return }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) collectStrings(v, out)
  }
}

/**
 * Canonical HH:MM times an AVAILABILITY tool surfaced in its result this turn. Returns []
 * for non-availability tools, failed/empty results, or null. Order-preserving, deduped.
 */
export function extractAllowedTimesFromToolResult(name: string, result: unknown): string[] {
  if (!TIME_BEARING_TOOLS.has(name)) return []
  const r = (result ?? {}) as Record<string, unknown>
  if ('error' in r || r['ok'] === false || r['success'] === false) return []
  const strings: string[] = []
  collectStrings(result, strings)
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of strings) {
    for (const t of extractClockTimes(s)) {
      if (!seen.has(t)) { seen.add(t); out.push(t) }
    }
  }
  return out
}

// ── Occupancy focus-day derivation (T1.2 / RED-TEAM D4) ──────────────────────────
//
// Branch 4's occupancy gate works because the handler threads a deterministic
// `focusDay {dateStr}` from the resolved intent. Branch 3 is a free-form Gemini loop with
// no resolved-intent day — so per D4 we REUSE the date the manager's own calendar tools
// resolved THIS turn. We re-run the same deterministic `resolveRequestedDate` over the
// tool args (the LLM only classified the pieces; the core resolves them). If exactly ONE
// distinct day was resolved this turn we feed it to the occupancy gate; if zero or many,
// the gate SKIPS rather than guesses (D4).

// Tools carrying a single business-local day in a `date` DATE_PIECES arg.
const DAY_SCOPED_TOOLS = new Set(['getSessionRoster', 'createCalendarEvent', 'scheduleGroupSession', 'editClassSession'])

/** Map a loose Gemini date-pieces object to the resolver's RequestedDateParts (mirror of toDateParts). */
function looseDateParts(d: unknown): RequestedDateParts {
  const o = (d ?? {}) as { relativeDay?: RelativeDay; weekday?: number; explicitDate?: { year?: number; month?: number; day?: number } }
  return {
    relativeDay: o.relativeDay ?? null,
    weekday: o.weekday ?? null,
    explicitDate: o.explicitDate
      ? { year: o.explicitDate.year ?? null, month: o.explicitDate.month ?? null, day: o.explicitDate.day ?? null }
      : null,
  }
}

/**
 * The business-local day(s) a calendar tool resolved from its args this turn. A single-day
 * tool yields its one day; a `list_range` yields BOTH bounds (so a multi-day range never
 * collapses to a false single focus day); multi-day scans (`list_week`/`check_free_slots`)
 * and non-calendar tools yield none. Pure given (tz, now).
 */
export function resolvedDaysFromToolArgs(name: string, args: Record<string, unknown>, tz: string, now: Date): string[] {
  const out: string[] = []
  const tryPush = (d: unknown): void => {
    const r = resolveRequestedDate(looseDateParts(d), tz, now)
    if (r.ok) out.push(r.dateStr)
  }
  if (name === 'listCalendarEvents') {
    const intent = args['intent']
    if (intent === 'list_today') tryPush({ relativeDay: 'today' })
    else if (intent === 'list_range') { tryPush(args['dateFrom']); tryPush(args['dateTo']) }
    return out
  }
  if (DAY_SCOPED_TOOLS.has(name) && args['date']) tryPush(args['date'])
  return out
}

/**
 * Short, real "open options" string for the occupancy gate's corrective — the genuinely-open
 * class sessions (spotsLeft > 0) and private slots for the focused day, rendered 24h. Mirrors
 * Branch-4's open signal (classes with spots OR any private gap). Returns null when nothing is open.
 */
function renderOpenDayText(day: DayOptions, tz: string, locale: string): string | null {
  const fmt = (d: Date): string => d.toLocaleTimeString(locale, { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
  const parts: string[] = []
  for (const c of day.classes) if (c.spotsLeft > 0) parts.push(`${c.serviceName} ${fmt(c.start)} (${c.spotsLeft} left)`)
  for (const p of day.privateOpenings) for (const s of p.slots) parts.push(`${p.serviceName} ${fmt(s)}`)
  return parts.length > 0 ? parts.join(', ') : null
}

// ── L2 claim auditor ────────────────────────────────────────────────────────────
//
// Generalizes Branch 4's assertsBookingConfirmed guard (decision D3): never let the
// orchestrator's reply assert a high-risk action that did not actually happen. A claim is
// "backed" only by a real successful tool call this turn (or, for calendar_connected, a
// prior real connection). Unbacked claims trigger one corrective regeneration, then a safe
// honest fallback — the same regenerate-or-fall-back shape the booking guard already uses.

// Maps a tool call to the claims it legitimately backs. Inspects the result object — not
// just ok/error status: messageCustomer returns {ok:false,reason} on a blocked send, which
// is not an "error" and must NOT back a "message sent" claim. Some tools (coordination)
// also need the ARGS to know which action was taken (confirm vs counter vs abandon).
// connectGoogleCalendar is deliberately absent — it only produces a link, not a connection.
//
// PARTIAL≠BACKED (T1.3 / H4): a `{partial:true}` success (e.g. coordinateMeeting saved the
// request but could not message the contact yet) backs NOTHING — a partial action must never
// stand in for a completed one.
export function actionsFromToolResult(name: string, args: Record<string, unknown>, result: unknown): ActionClaim[] {
  const r = (result ?? {}) as Record<string, unknown>
  const failed = 'error' in r || r['ok'] === false || r['success'] === false
    || r['needsClarification'] === true || r['partial'] === true
  if (failed) return []
  switch (name) {
    case 'messageCustomer':
    case 'requestPayment':
      // requestPayment ok:true means the pay-link was actually delivered to the customer
      // (an outside-window / blocked send returns ok:false → caught by `failed` above).
      return ['message_sent']
    case 'resolveProactiveProposal':
      // Approving a proposal sends the check-in ONLY when the customer is in-window
      // (outcome 'sent'). An approved-but-unreachable or a decline sends nothing, so it
      // must NOT back a "message sent" claim.
      return r['outcome'] === 'sent' ? ['message_sent'] : []
    case 'createCalendarEvent':
    case 'scheduleGroupSession':
    case 'scheduleRecurringClasses':
      return ['booking_made']
    case 'resolveBookingApproval':
      // Approving a customer request books it (immediate gate). A paid service goes to
      // pending_payment — not booked yet — and a decline cancels it.
      return r['outcome'] === 'confirmed' ? ['booking_made'] : r['outcome'] === 'declined' ? ['cancelled'] : []
    case 'deleteCalendarEvent':
      return ['cancelled']
    case 'manageBusinessSettings':
      // One tool, two MUTUALLY-EXCLUSIVE outcomes per call: it either CANCELS a customer
      // booking OR CHANGES config (price/hours/capacity/colour/policy/staff). The handler
      // surfaces the classifier's `instructionType` on success (the same value persisted as
      // `classifiedAs`); only 'booking_cancellation' is a cancellation, every other type is a
      // settings write. Back ONLY the outcome that actually happened — backing BOTH on every
      // call would let a price-change turn back a phantom "I cancelled X" (T3.4 / F-rev1).
      return r['instructionType'] === 'booking_cancellation' ? ['cancelled'] : ['settings_changed']
    case 'refundTransaction':
      // ok:true ⇒ the processor actually issued the refund (H5/H20).
      return ['refunded']
    case 'broadcastAnnouncement':
      // Backs "customers were notified" ONLY when something actually went out (H12): a
      // zero-match broadcast is ok:true with sent:0 and must not back the claim.
      return typeof r['sent'] === 'number' && (r['sent'] as number) > 0 ? ['broadcast_sent'] : []
    case 'coordinateMeeting':
      // A full send reaches the counterparty (message_sent). A {partial:true} save was already
      // dropped by the `failed` guard above (H4 — no "texted Harel" off a partial).
      return ['message_sent']
    case 'resolveMeetingCoordination':
      // The action lives in the args (the result is a bare {success:true}). A 'confirm' BOOKS
      // the meeting (H16 → booking_made); a 'counter_offer' messages the contact a new time;
      // an 'abandon' claims nothing.
      return args['action'] === 'confirm' ? ['booking_made']
        : args['action'] === 'counter_offer' ? ['message_sent']
          : []
    default:
      return []
  }
}

const CLAIM_LABEL: Record<ActionClaim, string> = {
  booking_made: 'that a booking was made or confirmed',
  message_sent: 'that a message was sent to a customer',
  calendar_connected: 'that the Google Calendar is connected',
  cancelled: 'that a booking was cancelled',
  waitlist_added: 'that a customer was added to the waitlist',
  refunded: 'that a refund was issued',
  broadcast_sent: 'that an announcement was sent to customers',
  settings_changed: 'that a business setting was changed',
}

// Exported for tests (T-REGEN F-rev4): the safe template every Branch-3 gate/auditor catch
// falls to instead of leaking an ungated draft.
export const SAFE_AUDIT_FALLBACK: Record<Lang, string> = {
  he: 'רגע אחד — אני רוצה לוודא לפני שאני אומר שמשהו בוצע. אבדוק ואחזור אליך.',
  en: "One sec — I want to verify before I say anything's done. I'll check and get back to you.",
}

// `booking_made` is deliberately excluded: the unified gate (gateReply) now owns the
// booking claim in Branch 3 via `opts.bookingConfirmed`, so leaving it here would
// double-regenerate a booking claim (Phase-0 contract / T1.2). The action auditor keeps
// every NON-booking class.
function unbackedClaims(text: string, lang: Lang, backed: Set<ActionClaim>, calendarConnected: boolean): ActionClaim[] {
  return detectActionClaims(text, lang)
    .filter((c) => c !== 'booking_made')
    .filter((c) => (c === 'calendar_connected' ? !(calendarConnected || backed.has(c)) : !backed.has(c)))
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
  budget?: RegenBudget | undefined
}): Promise<string> {
  const { draft, lang, backed, calendarConnected, contents, systemPrompt, businessId, actorId, budget } = params
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

  // T-REGEN — the auditor's regen draws from the SAME per-turn budget as gateReply's gates.
  // If it is exhausted/expired, skip the round-trip and block to the safe fallback (the cap
  // biting; the lock cannot expire from a stacked auditor regen).
  if (!tryConsumeRegen(budget)) {
    await recordIntervention('blocked')
    return SAFE_AUDIT_FALLBACK[lang]
  }

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

// ── Unified output gate for Branch 3 (Seam B — H1, CRITICAL) ─────────────────────
//
// The SAME gateReply Branch 4 uses, fed a Branch-3 ledger, THEN the L2 action auditor for
// the non-booking action classes. Extracted to a module-level helper so the main loop's
// reply-producing region keeps a single voice-wrapped reply-exit (the non-bypass invariant)
// — the regen closure's own `return` lives here, out of that region. Fail-open throughout.
//
// NOTE (RED-TEAM D6 / T-REGEN, cross-cutting, out of Phase-1 scope): gateReply may regen for
// time + occupancy and the auditor may regen once more — up to three sequential text-only
// round-trips under the identity lock. A unified per-turn regen cap + shared deadline + a
// post-regen re-check is the separate T-REGEN task; booking is already de-duplicated here
// (gateReply owns it via bookingConfirmed; the auditor excludes booking_made).
export async function gateAndAuditBranch3Reply(params: {
  draft: string
  ledger: TurnLedger
  lang: Lang
  focusDay?: { dateStr: string; serviceTypeId?: string } | undefined
  bookingConfirmed: boolean
  succeededActions: Set<ActionClaim>
  calendarConnected: boolean
  contents: Content[]
  systemPrompt: string
  businessId: string
  actorId: string
  budget?: RegenBudget | undefined
}): Promise<string> {
  const { draft, ledger, lang, focusDay, bookingConfirmed, succeededActions, calendarConnected, contents, systemPrompt, businessId, actorId, budget } = params

  // Text-only corrective regeneration: re-run the orchestrator over the same contents + the
  // draft + the gate's instruction (mirrors auditReplyClaims). No tools — wording only.
  const gateRegen = async (instruction: string): Promise<string> => {
    const correctionContents: Content[] = [
      ...contents,
      { role: 'model', parts: [{ text: draft }] },
      { role: 'user', parts: [{ text: instruction }] },
    ]
    const r = await generateOrchestratorTurn(correctionContents, { systemInstruction: systemPrompt, maxOutputTokens: 1024 })
    return r.candidates?.[0]?.content?.parts?.find((p) => p.text)?.text ?? ''
  }

  const gated = await gateReply(draft, {
    ledger,
    input: { language: lang },
    opts: { bookingConfirmed, ...(focusDay ? { focusDay } : {}) },
    regen: gateRegen,
    budget,
  }).then((g) => g.reply)
    // F-rev4: a thrown gate must NOT leak the ungated `draft` (potentially the very fabrication
    // the gate exists to catch). Fail to the safe audit template instead.
    .catch(() => SAFE_AUDIT_FALLBACK[lang])

  return auditReplyClaims({
    draft: gated,
    lang,
    backed: succeededActions,
    calendarConnected,
    contents,
    systemPrompt,
    businessId,
    actorId,
    budget,
  })
    // F-rev4: the action auditor is Branch-3's ONLY non-booking action-claim check (gateReply
    // runs with enforceActionClaims OFF here), so on a thrown auditor `gated` may still carry an
    // unbacked action claim — fail safe rather than leak it.
    .catch(() => SAFE_AUDIT_FALLBACK[lang])
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
  // Negotiation memory (Branch 3 read-side filter): the manager session's ruled-out
  // times, subtracted from proactive free-slot suggestions. Capture is deferred, so this
  // is currently always empty — threaded so it's live the moment a capture path exists.
  negotiationConstraints?: NegotiationConstraints
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

  // F3a/S3 — customer questions the PA relayed to the owner and is awaiting an answer for.
  // Surfaced so the model knows to answer them (via answerCustomerQuestion), and so a plain
  // free-text reply binds to the single open one.
  const openQuestionRows = await db
    .select({ id: pendingOwnerQuestions.id, questionText: pendingOwnerQuestions.questionText, customerPhone: pendingOwnerQuestions.customerPhone })
    .from(pendingOwnerQuestions)
    .where(and(eq(pendingOwnerQuestions.businessId, businessId), eq(pendingOwnerQuestions.status, 'pending')))
    .orderBy(desc(pendingOwnerQuestions.createdAt))
    .limit(10)
    .catch(() => [] as Array<{ id: string; questionText: string; customerPhone: string }>)
  const openQuestions = openQuestionRows.length
    ? openQuestionRows.map((q) => `[${q.id}] customer ${q.customerPhone} asked: "${q.questionText}". To answer, call answerCustomerQuestion with this id and the answer; if this is the only one, a plain reply with the answer also works.`).join('\n')
    : ''

  const [mgrName] = await db
    .select({ name: identities.displayName })
    .from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.role, 'manager')))
    .limit(1)
    .catch(() => [undefined as { name: string | null } | undefined])
  const [bizRow] = await db
    .select({ mode: businessesTable.outreachIdentityMode, bookingAuthority: businessesTable.bookingAuthority })
    .from(businessesTable)
    .where(eq(businessesTable.id, businessId))
    .limit(1)
    .catch(() => [undefined as { mode: 'business' | 'owner_name' | null; bookingAuthority: 'auto' | 'owner_approval' } | undefined])
  const bookingAuthority: 'auto' | 'owner_approval' = bizRow?.bookingAuthority ?? 'auto'

  // Authoritative active-service list (source of truth = service_types), so the owner
  // is never told a real bookable service doesn't exist (or a removed one still does).
  const activeServices = await db
    .select({ name: serviceTypes.name, schedulingMode: serviceTypes.schedulingMode, maxParticipants: serviceTypes.maxParticipants, narrative: serviceTypes.narrative })
    .from(serviceTypes)
    .where(and(eq(serviceTypes.businessId, businessId), eq(serviceTypes.isActive, true)))
    .orderBy(serviceTypes.createdAt)
    .catch(() => [] as Array<{ name: string; schedulingMode: 'appointment' | 'class'; maxParticipants: number; narrative: string | null }>)
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
    activeServices,
    instructorRoster,
    teachingSchedule,
    managerMemorySummaries,
    actionLedger,
    activeCoordinations,
    openQuestions,
    outreachIdentity,
    bookingAuthority,
    conversationHistory: transcript.slice(-20),
  })

  const ctx: ToolContext = {
    db, businessId, identityId, timezone, lang, calendar,
    bookingAuthority,
    ...(params.calendarMode ? { calendarMode: params.calendarMode } : {}),
    ...(params.role ? { role: params.role } : {}),
    ...(params.delegatedPermissions ? { delegatedPermissions: params.delegatedPermissions } : {}),
    ...(params.negotiationConstraints ? { negotiationConstraints: params.negotiationConstraints } : {}),
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
  // T-REGEN — ONE shared regen budget for this turn, drawn down by BOTH gateReply's gates and
  // the L2 action auditor (Seam B), so a multi-gate manager turn cannot stack unbounded text
  // round-trips under the 60s identity lock.
  const regenBudget = makeRegenBudget()

  // ── Unified-gate per-turn state (T1.1/T1.2 — closes H1) ──────────────────────
  // The time allowlist seeded from availability tool RESULTS + the owner's own quoted times
  // this turn (mirrors Branch-4 `extractMentionedTimes`); and the business-local day(s) the
  // manager's calendar tools resolved (D4 focus-day source). Both accumulate in the loop.
  const allowedTimes = new Set<string>(extractMentionedTimes(message))
  const resolvedDays = new Set<string>()
  const gateLocale = lang === 'he' ? 'he-IL' : 'en-GB'
  // Full business row for the occupancy spine (genuinely-open capacity for a focused day).
  const [businessRow] = await db
    .select()
    .from(businessesTable)
    .where(eq(businessesTable.id, businessId))
    .limit(1)
    .catch(() => [undefined])
  // Fresh-spine occupancy reader — re-reads the focused day's real class/private capacity so a
  // blanket "fully booked" claim can never launder past the gate. `open` counts ONLY genuinely-
  // open capacity (classes with spotsLeft > 0, or any private gap), exactly as Branch-4's
  // dayHasOpenOptions does. Best-effort — a read failure yields `open:false` (the gate then trusts
  // the reply, never inventing availability).
  const occupancySpine: OccupancySpine = async (dateStr, serviceTypeId) => {
    if (!businessRow) return { open: false, text: null }
    try {
      const day = await listDayOptions(db, businessRow, dateStr, timezone, serviceTypeId ? { serviceTypeId } : {})
      const open = day.classes.some((c) => c.spotsLeft > 0) || day.privateOpenings.some((p) => p.slots.length > 0)
      return { open, text: open ? renderOpenDayText(day, timezone, gateLocale) : null }
    } catch {
      return { open: false, text: null }
    }
  }

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
      // Gate 7 (monitor-only): the LLM-error fallback is a deliberately-terse safe fallback.
      return observeVoiceTells(fallback, { businessId, language: lang }, { isSafeFallback: true })
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
        actionsFromToolResult(toolName, toolArgs, toolResult).forEach((a) => succeededActions.add(a))
        // Unified gate (H1): seed the time allowlist from this availability result, and pin the
        // occupancy focus-day from the day this calendar tool resolved (D4).
        extractAllowedTimesFromToolResult(toolName, toolResult).forEach((t) => allowedTimes.add(t))
        resolvedDaysFromToolArgs(toolName, toolArgs, timezone, new Date()).forEach((d) => resolvedDays.add(d))
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
      // Unified output gate (Seam B — H1, CRITICAL): booking (via bookingConfirmed = a tool-backed
      // booking), fabricated TIME (allowlist seeded from availability tool results + owner-quoted
      // times), blanket OCCUPANCY (fresh-spine re-validate on the single D4-resolved focus-day, else
      // skip), then the L2 action auditor for the non-booking classes. Fail-open — never drop the turn.
      const focusDay = resolvedDays.size === 1 ? { dateStr: [...resolvedDays][0]! } : undefined
      const ledger = buildTurnLedger({
        businessFacts: buildActiveServicesBlock(activeServices),
        actionLedger,
        baseAllowedTimes: { boundaryTimes: [], bookingTimes: [...allowedTimes] },
        occupancySpine,
        backedActions: succeededActions,
        calendarConnected: calendarAlreadyConnected,
        businessId,
      })
      const finalReply = await gateAndAuditBranch3Reply({
        draft: textPart,
        ledger,
        lang,
        focusDay,
        bookingConfirmed: succeededActions.has('booking_made'),
        succeededActions,
        calendarConnected: calendarAlreadyConnected,
        contents,
        systemPrompt,
        businessId,
        actorId: identityId,
        budget: regenBudget,
      })
        // F-rev4: never let a thrown gate/auditor leak the ungated `textPart` (raw model draft).
        .catch(() => SAFE_AUDIT_FALLBACK[lang])
      logOrchestratorCompletion({
        businessId, sessionId, messageId,
        totalIterations: iterations,
        finalReply,
        totalDurationMs: Date.now() - loopStart,
      })
      // Gate 7 (monitor-only): observe the real manager reply for mechanical bot-tells.
      return observeVoiceTells(finalReply, { businessId, language: lang })
    }

    // No function calls, no text — shouldn't happen; break out
    break
  }

  logOrchestratorError({ businessId, sessionId, messageId, error: `Loop exhausted after ${iterations} iterations` })
  // Gate 7 (monitor-only): the loop-exhaustion fallback is a deliberately-terse safe fallback.
  return observeVoiceTells(fallback, { businessId, language: lang }, { isSafeFallback: true })
}
