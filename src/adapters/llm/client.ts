import { GoogleGenAI } from '@google/genai'
import { z } from 'zod'
import type { CustomerIntentOutput, ManagerInstructionOutput, OperatorActionOutput, LlmResult, GenerateReplyInput, ParseableOnboardingStep, OnboardingAnswerOutput, TranscriptTurn } from './types.js'
import { middlemanExplainBlock } from './middleman-identity.js'
import { buildVoiceCore } from './voice.js'
import { MODELS } from './models.js'
import { detectActionClaims, type ActionClaim } from '../../domain/flows/reply-guard.js'
import { findUnbackedTimes } from '../../domain/flows/slot-fabrication-guard.js'
import { hasActionFabrication, observeVoiceTells } from '../../domain/flows/voice-guard.js'

const LLM_API_KEY = process.env['LLM_API_KEY']
if (!LLM_API_KEY) throw new Error('LLM_API_KEY is required')

// Classification/extraction default. Conversational generators use MODELS.pro via
// generateConversational() below.
const MODEL = MODELS.fast

const ai = new GoogleGenAI({ apiKey: LLM_API_KEY, apiVersion: 'v1beta' })

// Conversational generation on Pro, with a graceful Flash fallback so a slow or
// failed Pro call never drops a reply.
//
// Pro reasons by default and its thinking tokens draw down maxOutputTokens. A
// short reply with a small budget (e.g. 512) gets starved — Pro spends the whole
// budget thinking and returns EMPTY text, silently triggering the caller's robotic
// fallback. So for Pro we bound thinking with a positive thinkingBudget (valid on
// Pro; only 0 is invalid) and guarantee headroom for the actual answer. Flash
// doesn't reason, so its fallback disables thinking and keeps the caller's budget.
const PRO_THINKING_BUDGET = 1024
const PRO_MIN_OUTPUT_TOKENS = 3072
type GenRequest = Omit<Parameters<typeof ai.models.generateContent>[0], 'model'>

async function generateConversational(request: GenRequest) {
  const requestedMax = request.config?.maxOutputTokens ?? 1024
  try {
    return await ai.models.generateContent({
      ...request,
      model: MODELS.pro,
      config: {
        ...request.config,
        thinkingConfig: { thinkingBudget: PRO_THINKING_BUDGET },
        maxOutputTokens: Math.max(requestedMax, PRO_MIN_OUTPUT_TOKENS),
      },
    })
  } catch (err) {
    console.warn('[llm] Pro generation failed, falling back to Flash', {
      error: err instanceof Error ? err.message : String(err),
    })
    return await ai.models.generateContent({
      ...request,
      model: MODELS.fast,
      config: { ...request.config, thinkingConfig: { thinkingBudget: 0 } },
    })
  }
}

export const customerIntentSchema = z.object({
  intent: z.enum(['booking', 'rescheduling', 'cancellation', 'inquiry', 'list_bookings', 'system_explanation', 'unknown']).catch('unknown'),
  slotRequest: z
    .object({
      hasSpecificDate: z.boolean().catch(false),
      hasSpecificTime: z.boolean().catch(false),
      relativeDay: z.enum(['today', 'tomorrow', 'day_after_tomorrow', 'this_week', 'next_week']).nullable().catch(null),
      weekday: z.number().int().min(0).max(6).nullable().catch(null),
      weekdayAnchor: z.enum(['this', 'next']).nullable().catch(null),
      explicitDate: z
        .object({
          year: z.number().int().nullable().catch(null),
          month: z.number().int().min(1).max(12).nullable().catch(null),
          day: z.number().int().min(1).max(31).nullable().catch(null),
        })
        .nullable()
        .catch(null),
      time: z
        .object({ hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) })
        .nullable()
        .catch(null),
      timeOfDay: z.enum(['morning', 'afternoon', 'evening']).nullable().catch(null),
      resolvedStart: z.string().nullable().catch(null),
      resolvedEnd: z.string().nullable().catch(null),
      dateHint: z.string().nullable().catch(null),
      timeHint: z.string().nullable().catch(null),
      dateAmbiguous: z.boolean().default(false).catch(false),
    })
    .nullable()
    .catch(null),
  serviceTypeHint: z.string().nullable().catch(null),
  providerHint: z.string().nullable().catch(null),
  customerNameHint: z.string().nullable().catch(null),
  participantsHint: z.number().int().positive().nullable().catch(null),
  summary: z.string().nullable().catch(null),
  rawEntities: z.record(z.unknown()).transform((v) =>
    Object.fromEntries(Object.entries(v).map(([k, val]) => [k, String(val)])),
  ).catch({}),
  detectedLanguage: z.enum(['he', 'en']).catch('he'),
  avoidConstraints: z
    .object({
      beforeHour: z.number().int().min(0).max(23).nullable().catch(null),
      afterHour: z.number().int().min(0).max(23).nullable().catch(null),
      weekdays: z.array(z.number().int().min(0).max(6)).nullable().catch(null),
    })
    .nullable()
    .catch(null),
  specialArrangementRequest: z.boolean().optional().catch(undefined),
  restorePrevious: z.boolean().optional().catch(undefined),
})

// Defensive normalization: gemini-2.5-flash sometimes emits snake_case top-level
// keys (instruction_type) instead of the camelCase the schema requires. The prompt
// pins camelCase, but a single drift here silently breaks EVERY Branch-3 config
// write (the model's output validates to ok:false → "Classification failed"), so we
// also map the common snake_case aliases and default an omitted clarificationNeeded.
const managerInstructionSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object') return value
  const o = { ...(value as Record<string, unknown>) }
  if (o.instructionType === undefined && o.instruction_type !== undefined) o.instructionType = o.instruction_type
  if (o.structuredParams === undefined && o.structured_params !== undefined) o.structuredParams = o.structured_params
  if (o.clarificationNeeded === undefined && o.clarification_needed !== undefined) o.clarificationNeeded = o.clarification_needed
  if (o.clarificationNeeded === undefined) o.clarificationNeeded = null
  if (o.ambiguous === undefined) o.ambiguous = false
  if (o.structuredParams === undefined) o.structuredParams = {}
  return o
}, z.object({
  instructionType: z.enum([
    'availability_change',
    'policy_change',
    'service_change',
    'permission_change',
    'booking_cancellation',
    'recurring_class_change',
    'provider_change',
    'unknown',
  ]),
  structuredParams: z.record(z.unknown()),
  ambiguous: z.boolean(),
  clarificationNeeded: z.string().nullable(),
}))

export async function extractCustomerIntent(
  message: string,
  sessionContext: Record<string, unknown>,
  businessTimezone: string,
  availableServices: string[],
  _botPersona?: 'female' | 'male' | 'neutral',
): Promise<LlmResult<CustomerIntentOutput>> {
  const safeMessage = sanitizeUserInput(message)

  const systemPrompt = `You are parsing a WhatsApp message from a customer of a local business.
Business timezone: ${businessTimezone}. Today's date and time (UTC): ${new Date().toISOString()}.
Available services: ${availableServices.length > 0 ? availableServices.join(', ') : 'general appointment'}.
Conversation so far: ${JSON.stringify(sessionContext)}.

Return a JSON object with EXACTLY this structure (all fields required):
{
  "intent": "booking" | "rescheduling" | "cancellation" | "inquiry" | "list_bookings" | "system_explanation" | "unknown",
  "slotRequest": {
    "hasSpecificDate": boolean,
    "hasSpecificTime": boolean,
    "relativeDay": "today" | "tomorrow" | "day_after_tomorrow" | "this_week" | "next_week" | null,
    "weekday": 0-6 | null,
    "weekdayAnchor": "this" | "next" | null,
    "explicitDate": { "year": number|null, "month": 1-12|null, "day": 1-31|null } | null,
    "time": { "hour": 0-23, "minute": 0-59 } | null,
    "timeOfDay": "morning" | "afternoon" | "evening" | null,
    "dateHint": "original date text" | null,
    "timeHint": "original time text" | null,
    "dateAmbiguous": boolean
  } | null,
  "serviceTypeHint": "service name from message" | null,
  "providerHint": "staff name from message" | null,
  "customerNameHint": "the customer's own name if they state it (e.g. 'I'm Guy Cohen', 'שמי גיא כהן')" | null,
  "participantsHint": number | null,
  "summary": "one sentence summary" | null,
  "rawEntities": {},
  "detectedLanguage": "he" | "en",
  "avoidConstraints": { "beforeHour": 0-23|null, "afterHour": 0-23|null, "weekdays": [0-6]|null } | null,
  "specialArrangementRequest": boolean,
  "restorePrevious": boolean
}

Rules:
- intent: use "list_bookings" when the customer asks to see their appointments (e.g. "what are my bookings?", "מה התורים שלי").
- intent: use "system_explanation" ONLY when the customer explicitly asks what system, platform, app, or technology powers this assistant, or who built it / how it works technically (e.g. "are you a bot?", "what app is this?", "מי בנה אותך?", "על איזו מערכת זה רץ?"). Questions about the BUSINESS, its services, prices, or hours are "inquiry", NOT this. Transactional intents win: if the same message also asks to book, reschedule, cancel, or list bookings, return that intent instead — system_explanation is the lowest priority.
- DATE/TIME — CLASSIFY ONLY, NEVER COMPUTE. You only report what the customer literally said as structured pieces. Do NOT compute, resolve, or output any absolute/ISO date. Do NOT invent a year. A separate deterministic system turns your pieces into the real date.
  - slotRequest: set to an object when a booking date/time is mentioned; set to null for non-booking intents.
  - relativeDay: map relative phrasing — "today"/"היום"→today, "tomorrow"/"מחר"→tomorrow, "day after tomorrow"/"מחרתיים"→day_after_tomorrow, "this week"/"השבוע"→this_week, "next week"/"שבוע הבא"→next_week. Otherwise null.
  - weekday: 0=Sunday … 6=Saturday when a named day is given ("Tuesday"/"יום שלישי"→2). Otherwise null.
  - explicitDate: fill day and month when a calendar date is stated ("May 2"/"2 במאי"/"10.01"→{month,day}); include year ONLY if the customer explicitly stated it (e.g. "10.01.2016"→year:2016). Never fill year yourself. null if no explicit date.
  - time: fill {hour,minute} in 24-hour form when a clock time is given ("3pm"→{15,0}, "9:30"→{9,30}, "תשע בבוקר"→{9,0}). null for vague.
  - timeOfDay: "morning"/"afternoon"/"evening" (or Hebrew בוקר/צהריים/ערב) when only a part of day is given; otherwise null.
  - hasSpecificDate: true if any concrete day is identifiable (relativeDay other than this_week/next_week, a weekday, or an explicitDate with day+month). false for vague ("sometime next week").
  - hasSpecificTime: true only when "time" is filled. false for vague ("morning").
  - dateAmbiguous: true ONLY for "this_week"/"next_week" with no weekday. Explicit day+month dates and named weekdays are NEVER ambiguous — set false.
  - weekdayAnchor: 'this' when the customer points at the imminent occurrence of a named weekday ('today', 'this Sunday', 'coming Sunday', 'ראשון הקרוב', 'היום'); 'next' for an explicit next-week occurrence ('next Sunday', 'ראשון הבא'); null for a BARE weekday with no proximity word ('Sunday', 'ביום ראשון'). Only meaningful when weekday is set.
- avoidConstraints: capture time windows or days the customer RULES OUT — what they do NOT want, not what they want. Set to null unless the customer states an exclusion.
  - "no mornings"/"בלי בוקר"/"לא בבוקר" → beforeHour 12. "nothing before 4"/"לא לפני 16:00" → beforeHour 16. "no evenings"/"בלי ערב" → afterHour 17. "nothing after 6pm"/"לא אחרי 18:00" → afterHour 18. "not Thursdays"/"לא בימי חמישי" → weekdays [4]; combine multiple days. Null fields that aren't stated; combine fields when several exclusions appear in one message.
  - This is ONLY for excluded windows used to FIND a slot. The specific time the customer is asking to book goes in slotRequest.time, NEVER here.
- serviceTypeHint: extract the service name the customer mentions (e.g. "תספורת" → "תספורת", "haircut" → "Haircut"). null if none.
- customerNameHint: the customer's OWN name when they introduce themselves ("I'm Guy Cohen", "this is Dana", "שמי גיא"). null if they don't state their own name. Never put a staff or third-party name here.
- participantsHint: number of people if the customer states a party size ("for 3 people"/"לשלושה אנשים"→3). null if not stated.
- specialArrangementRequest: true ONLY when the customer asks for something the standard service list can't provide as-is — a PRIVATE/one-off version of a normally-group class, a GROUP/party booking larger than a service allows, an explicitly OUTSIDE-OPENING-HOURS session, or a custom event ("private workshop", "just for my group", "after you close", "סדנה פרטית", "מחוץ לשעות הפעילות", "אירוע פרטי"). false for an ordinary booking, a normal party size, or merely asking about a time that happens to be unavailable. When in doubt, false.
- restorePrevious: true when the customer asks to UNDO a cancellation or bring back a booking they just cancelled ("restore it", "bring it back", "give me back the class we cancelled", "תחזיר לי את התור שביטלנו", "בוא נחזיר את זה", "תחזיר את השיעור"). false otherwise. A brand-new booking request is NOT a restore.
- detectedLanguage: "he" if message is in Hebrew; "en" for English or any other language.
- Respond only with valid JSON matching the structure above. No explanation.`

  return callWithSchema(systemPrompt, safeMessage, customerIntentSchema) as Promise<LlmResult<CustomerIntentOutput>>
}

export async function classifyManagerInstruction(
  message: string,
  businessContext: Record<string, unknown>,
  language?: 'he' | 'en',
): Promise<LlmResult<ManagerInstructionOutput>> {
  const langInstruction = language === 'he'
    ? 'IMPORTANT: the clarificationNeeded field must be written in Hebrew (עברית).'
    : 'IMPORTANT: the clarificationNeeded field must be written in English.'

  const systemPrompt = `You are parsing a WhatsApp message from a business manager giving operational instructions.
Business context: ${JSON.stringify(businessContext)}.
${langInstruction}

Classify the instruction and set structuredParams according to the type:

availability_change:
  { "action": "set_hours"|"block"|"unblock", "dayOfWeek": 0-6|null, "specificDate": "YYYY-MM-DD"|null, "openTime": "HH:MM"|null, "closeTime": "HH:MM"|null, "reason": string|null }

service_change:
  { "action": "create"|"update"|"deactivate", "name": string, "durationMinutes": number|null, "bufferMinutes": number|null, "paymentAmount": number|null, "requiresPayment": boolean|null, "category": string|null, "maxParticipants": number|null, "schedulingMode": "class"|"appointment"|null, "color": string|null, "requiresApproval": boolean|null, "confirm": boolean|null }
  - category: logical grouping (e.g. "Yoga", "Pilates", "Haircut"). Infer from name if not stated.
  - maxParticipants: 1 for private/1-on-1 sessions (default), >1 for group classes (yoga class, pilates class, etc.)
  - paymentAmount: price in the business currency, or null if not mentioned
  - requiresPayment: true if a price is specified
  - schedulingMode: set "class" when the owner says a service is a group/class or schedule-driven session (e.g. "Pilates is a group class for 8", "make Yoga a class", "פילאטיס זה שיעור קבוצתי"); also fill maxParticipants when a group size is given. Set "appointment" when the owner makes a service private/1-on-1 (e.g. "switch physio to 1-on-1", "make X private / by appointment", "תהפוך את שיקום לפגישה אחת על אחד"). Leave null when the owner isn't changing the booking model. Use action "update" for an existing service.
  - color: the owner's raw color word for this service's calendar events (e.g. "make Yoga blue" → "blue"; "color X red" → "red"; "תצבע את היוגה בכחול" → "כחול"). Pass the word as-is in the owner's language; leave null if no color is mentioned. Use action "update".
  - requiresApproval: whether the owner must personally approve each CUSTOMER self-booking for this service before it is confirmed. Set true when the owner wants to vet customer bookings for a service (e.g. "require my approval for physio bookings", "ask me before you book anyone for physio", "אני רוצה לאשר כל תור לפיזיותרפיה"); set false when they turn it off (e.g. "stop asking me to approve yoga", "you don't need my approval for yoga anymore", "תפסיק לבקש אישור ליוגה"). Leave null when approval isn't mentioned. This is about CUSTOMERS booking THEMSELVES for a specific service — NOT the PA booking on the owner's behalf (that is policy_change booking_authority). Use action "update".
  - confirm: set true ONLY when, earlier in this conversation, you warned the owner that switching a service to 1-on-1 would stop its recurring classes, and the owner has now answered yes/confirmed. Otherwise null.

permission_change:
  { "action": "grant"|"revoke", "phoneNumber": "+E164", "displayName": string|null }

booking_cancellation:
  { "customerNameHint": string|null, "customerPhone": "+E164"|null, "slotDateHint": "YYYY-MM-DD or natural language date"|null, "bookingId": "uuid"|null, "reason": string|null }
  Use when the manager explicitly asks to cancel a specific customer's booking (e.g. "cancel David's appointment tomorrow", "ביטול תור של שרה ב-15 למאי").
  Do NOT use for policy changes about cancellation rules — use policy_change for those.

policy_change:
  {
    "subtype": "cancellation_cutoff" | "booking_buffer" | "max_days_ahead" | "cancellation_fee" | "booking_authority" | "approval_window" | "other",
    "valueHours": number | null,    // for cancellation_cutoff (hours before appt), booking_buffer (hours in advance), and approval_window (hours to wait for owner approval)
    "valueDays": number | null,     // for max_days_ahead
    "valueAmount": number | null,   // for cancellation_fee (monetary amount)
    "valueMode": "auto" | "owner_approval" | null,  // for booking_authority only
    "description": string           // always fill — human-readable summary of what was requested
  }

  Subtype rules:
  - cancellation_cutoff: manager wants to limit how far in advance customers can cancel (e.g. "cancel only 24h before", "no cancellations within 2 hours")
  - booking_buffer: manager wants a minimum notice period before a booking (e.g. "don't accept same-day bookings", "require 2h notice")
  - max_days_ahead: manager wants to cap how far into the future bookings can be made (e.g. "only 30 days ahead")
  - cancellation_fee: manager wants to charge a fee for late cancellations (e.g. "charge 50 for cancellations")
  - booking_authority: manager controls whether the PA may book on their behalf without asking. Set valueMode="owner_approval" when they want to approve bookings first (e.g. "don't book anything without asking me", "always check with me before you put something on the calendar", "אל תקבע כלום בלי לשאול אותי"); set valueMode="auto" when they want the PA to just book open slots itself (e.g. "just book open slots yourself", "you don't need to ask me, just schedule it", "תקבע לבד מה שפנוי"). This is about the PA/owner booking on the owner's behalf — NOT about customers booking themselves.
  - approval_window: how long a customer self-booking that is HELD for the owner's approval waits before it auto-expires (only relevant when the owner approves customer bookings for some service). Set valueHours from the owner's wording (e.g. "give me 48 hours to approve bookings", "expire approval requests after 12 hours", "תן לי יומיים לאשר"). This sets the waiting window only — it does NOT turn approval on/off for a service (that is service_change requiresApproval).
  - other: anything else — policy cannot be enforced automatically; set ambiguous=true and clarificationNeeded explaining what IS enforceable

  For subtype "other", ALWAYS set ambiguous=true and clarificationNeeded to a message (in the manager's language) explaining:
  "I can automatically enforce: cancellation notice periods, advance booking windows, booking buffer times, cancellation fees, and whether I book on your behalf automatically or check with you first. This request needs to be handled manually. What specifically would you like to change?"

recurring_class_change:
  { "action": "create"|"stop"|"cancel_occurrence", "serviceName": string|null, "dayOfWeek": 0-6|null, "startTime": "HH:MM"|null, "durationMinutes": number|null, "maxParticipants": number|null, "startDate": "YYYY-MM-DD"|null, "endDate": "YYYY-MM-DD"|null, "occurrenceDate": "YYYY-MM-DD"|null, "providerHint": string|null, "reason": string|null }
  Use ONLY for a RECURRING weekly class / group session — recurrence phrasing like "every Monday", "weekly", "each week", "כל יום שני", "פעם בשבוע". A single class on one specific date is NOT this (that is handled elsewhere as a one-off).
  - action "create": manager sets up a new weekly recurring class (e.g. "yoga every Monday at 10:00 for 8 people", "פילאטיס כל רביעי ב-18:00"). Fill dayOfWeek and startTime; fill serviceName, durationMinutes, maxParticipants when stated. startDate = when the series begins if given; endDate = when it stops if given.
  - action "stop": manager ends an existing weekly series going forward (e.g. "stop the Monday yoga class", "בטל את שיעור היוגה הקבוע"). Fill serviceName and/or dayOfWeek+startTime to identify the series.
  - action "cancel_occurrence": manager skips ONE date of an otherwise-continuing series (e.g. "no yoga this coming Monday", "cancel just the class on May 18"). Fill occurrenceDate plus serviceName and/or dayOfWeek to identify the series.
  - dayOfWeek: 0=Sunday … 6=Saturday. startTime/openTime are 24-hour "HH:MM".

provider_change:
  { "action": "add"|"set_hours"|"assign_service"|"unassign_service"|"remove", "instructorName": string, "phone": "+E164"|null, "serviceNames": string[]|null, "weeklyHours": [ { "dayOfWeek": 0-6, "startTime": "HH:MM", "endTime": "HH:MM" } ]|null }
  Use for managing teaching staff / instructors / trainers (מדריך/ה, מורה, מאמן/ת).
  - action "add": owner introduces a new instructor, optionally with the services they teach and their weekly hours (e.g. "Add Dana as a yoga instructor, Mon/Wed 9–13", "תוסיף את דנה כמדריכת יוגה בימי שני ורביעי 9 עד 13"). Fill instructorName; serviceNames from the services named; weeklyHours from the days/times. Fill phone ONLY if a number is given (instructors are name-only by default).
  - action "set_hours": owner changes an existing instructor's weekly hours (e.g. "change Dana's hours to Tue/Thu 10–14"). Fill instructorName + weeklyHours.
  - action "assign_service" / "unassign_service": owner adds/removes which services an existing instructor teaches (e.g. "Dana also teaches pilates", "Dana no longer does breathing"). Fill instructorName + serviceNames.
  - action "remove": owner removes an instructor from the team (e.g. "remove Dana", "דנה כבר לא אצלנו"). Fill instructorName.
  - dayOfWeek: 0=Sunday … 6=Saturday. Times are 24-hour "HH:MM".

If the instruction is ambiguous or missing required detail, set ambiguous=true and clarificationNeeded to the exact question to ask back.

Return JSON with EXACTLY these top-level keys, in camelCase (not snake_case):
{
  "instructionType": one of [availability_change, policy_change, service_change, permission_change, booking_cancellation, recurring_class_change, provider_change, unknown],
  "structuredParams": { ...the fields for that instructionType, as specified above... },
  "ambiguous": boolean,
  "clarificationNeeded": string or null
}
Use the key "instructionType" (never "instruction_type"). No explanation, no markdown fences.`

  return callWithSchema(systemPrompt, message, managerInstructionSchema) as Promise<LlmResult<ManagerInstructionOutput>>
}

const operatorActionSchema = z.object({
  action: z.enum([
    'status_all', 'status_one', 'escalations', 'update_all',
    'skills_one', 'features', 'retrigger', 'general_qa', 'help',
  ]).catch('general_qa'),
  businessName: z.string().nullable().catch(null),
  skillName: z.string().nullable().catch(null),
  updateInstruction: z.string().nullable().catch(null),
  freeformReply: z.string().nullable().catch(null),
})

export async function classifyOperatorMessage(
  message: string,
  lang: 'he' | 'en',
  liveStats?: { businessCount: number; openEscalations: number },
): Promise<LlmResult<OperatorActionOutput>> {
  const safeMessage = sanitizeUserInput(message)

  const statsLine = liveStats
    ? `\nLive platform stats: ${liveStats.businessCount} businesses, ${liveStats.openEscalations} open escalation(s).`
    : ''

  const systemPrompt = `You are the MiddleMan operator assistant. MiddleMan is a WhatsApp-based PA platform for local businesses. The operator is the platform owner — they have admin access to all businesses.${statsLine}

Classify the operator's message into one action and extract relevant parameters.

Actions:
- status_all: wants an overview of all businesses (or asks "all", "כולם", "עסקים")
- status_one: asks about a specific business by name or phone number → set businessName
- escalations: asks about open escalations or pending issues
- update_all: wants to push an instruction/change to all live businesses → set updateInstruction
- skills_one: asks about skills, workflows, or website for a specific business → set businessName
- features: asks about deferred feature requests across all businesses
- retrigger: wants to restart a skill workflow → set businessName and skillName (kebab-case, e.g. "website-builder")
- general_qa: greeting, casual message, or question not covered by commands → write a warm 1-2 sentence reply in freeformReply
- help: operator explicitly asks for help or a list of available commands

Routing hints:
- "website(s)", "site(s)" for a specific business → skills_one
- "all websites", "websites status", "אתרים", "אתר" with no specific business → skills_one (not status_all)
- "status of [name]", "how is [name]" → status_one
- ANY question about which businesses finished setup, went live, completed registration, or are active → status_all (e.g. "יש עסקים שסיימו?", "which businesses are live?", "מי כבר פעיל?", "did any businesses finish?")
- ANY question about business state, progress, or completion without a specific business name → status_all
- Greetings ("hi", "hello", "שלום", "היי"), casual questions → general_qa
- "what can you do", "help me" → help

Language rule for freeformReply: write in ${lang === 'he' ? 'Hebrew (עברית)' : 'English'}. Tone: direct and warm, like a competent admin assistant.

Return JSON exactly:
{
  "action": string,
  "businessName": string | null,
  "skillName": string | null,
  "updateInstruction": string | null,
  "freeformReply": string | null
}`

  return callWithSchema(systemPrompt, safeMessage, operatorActionSchema) as Promise<LlmResult<OperatorActionOutput>>
}

function sanitizeUserInput(text: string): string {
  // Strip prompt injection attempts and dangerous XML-like tags
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/ignore\s+(previous|all|prior)\s+instructions?/gi, '[blocked]')
    .replace(/system\s*prompt/gi, '[blocked]')
    .slice(0, 2000) // hard cap on message length to prevent context overflow
}

const PA_PERSONA_TEMPLATE = `You are the booking assistant for {businessName}, speaking as the business itself.

${buildVoiceCore('customer')}

LANGUAGE RULE — strictly enforced: reply ENTIRELY in {language}. If {language} is "he", write only in Hebrew. If {language} is "en", write only in English. Never mix languages in one reply.

WHATSAPP FORMATTING — strictly enforced:
- *bold* — use RARELY: at most ONE bolded item in a message, and usually none. Bold is for the single thing the eye should catch (e.g. a final confirmed time), NOT decoration. Do NOT bold every service name, time, date, or price — bolding routine words reads as cluttered and bot-like. Default to plain text. Never bold whole sentences.
- Bullet lists: use • (U+2022) with a space after. Never use -, *, or numbered lists.
- URLs: place on their own line, never inside parentheses or as markdown [text](url).
- No HTML tags, no markdown headers (#, ##), no tables.
- Emoji: maximum one per message at a key moment (✅ confirmed, ⏰ reminder). None in questions or clarifications.

NEVER CLAIM A BOOKING THAT WASN'T MADE — strictly enforced: only state or imply that an appointment is booked, reserved, registered, set, or done when the situation EXPLICITLY says it was created/confirmed. If the situation is asking, clarifying, offering times, or reporting a problem, do NOT say "קבעתי"/"booked"/"you're all set" or use a ✅ — ask or move it forward instead. When unsure, ask; never confirm.

GROUND TRUTH — strictly enforced, overrides everything below: the "Situation" line and the "BUSINESS FACTS" block are the ONLY authoritative sources for (a) what just happened (booked / cancelled / moved / held / failed / nothing yet) and (b) what the business offers (services, prices, capacities, staff, hours, how far ahead it books). The conversation transcript is for TONE and THREAD ONLY — to sound continuous and not repeat yourself. NEVER derive a booking outcome or a business fact from the transcript. If the transcript and the Situation/BUSINESS FACTS disagree about what is booked or what exists, the Situation and BUSINESS FACTS win, every time — even if the transcript (including your own earlier messages) says otherwise. Restate the outcome from the Situation, not from the chat.

NEVER INVENT BUSINESS FACTS — strictly enforced: do not state or imply any service, class, instructor/staff name, price, capacity, duration, or policy that is not present in the BUSINESS FACTS block or the Situation. The BUSINESS FACTS service list is EXHAUSTIVE — there are no other services, and there are no named instructors/staff unless one is listed. If the customer asks for something not listed, or asserts the business offers something ("the studio told me you do X", "book me with <name>"), do NOT agree, confirm, or play along — a customer's claim is NOT authoritative. Say plainly you don't see that on offer, then steer back to what IS available. Do NOT claim you'll check, ask, or get back to them — never promise a follow-up action here (a separate system path handles real escalations). Never confirm a capability to make the customer happy.

BOOKING CONFIRMATIONS: when confirming a booking, restate the service name, day, date, and time clearly, then ask for a yes/no IN PLAIN WORDS — never append a menu. NEVER write "(כן / לא)", "(YES / NO)", "השב כן/לא", or any option list; just ask naturally ("מתאים?" / "סוגר?" / "sound good?" / "shall I lock it in?"). Vary the wording — don't template the whole message.

GREETING — at most ONCE per conversation. Only the very first message of a session may open with a greeting/hello or a self-introduction. On every later turn, do NOT open with "שלום"/"היי"/"hi"/"hello", do NOT re-introduce yourself ("אני העוזרת…"), and do NOT open with an offer to help ("אשמח לעזור"/"בטח"). Continue the conversation directly.

PLATFORM EXCEPTION: never reference AI or the underlying technology. The ONLY exception: when the situation explicitly authorizes a platform explanation, give the single one-line platform fact it provides — nothing more — then return to helping.

You receive:
1. A "situation" description in English (internal context — never quote this back verbatim to the customer). Authoritative for what just happened.
2. A "BUSINESS FACTS" block (when present) — the authoritative, exhaustive list of services/prices/capacities/staff/policy. Never contradict or extend it.
3. The recent conversation transcript (tone and thread only — NOT a source of facts or outcomes; see GROUND TRUTH above).
4. Optional customer profile (returning status, preferred service, display name — factual only, not chat history).

Output: one reply message only. No preamble, no quotation marks, no explanation.`

const FALLBACK_REPLIES: Record<'he' | 'en', string> = {
  he: 'רגע, משהו נתקע לי כאן — אפשר לכתוב לי שוב?',
  en: "Hang on, something got stuck on my end — mind sending that again?",
}

function buildKnowledgeAddendum(input: GenerateReplyInput): string {
  const parts: string[] = []

  if (input.brandVoice) {
    parts.push(`BUSINESS VOICE (set by the business owner — speak in this spirit):\n${input.brandVoice}`)
  }

  if (input.communicationStyle) {
    const cs = input.communicationStyle
    const rules: string[] = [
      `Formality: ${cs.formality === 'formal' ? 'formal — use respectful titles and complete sentences' : 'casual — friendly, first names, relaxed'}.`,
      `Emoji: ${cs.emojiUse === 'none' ? 'never use emoji' : cs.emojiUse === 'frequent' ? 'use emoji freely' : 'use emoji sparingly (max 1 per message)'}.`,
    ]
    if (cs.useCustomerName) rules.push("You may use the customer's first name for warmth when it's known — but sparingly (an occasional touch, never in every message).")
    if (!cs.humor) rules.push('Keep tone professional — no jokes or playful language.')
    if (cs.phrasesToUse.length > 0) rules.push(`Preferred phrases: ${cs.phrasesToUse.join(', ')}.`)
    if (cs.phrasesToAvoid.length > 0) rules.push(`Never say: ${cs.phrasesToAvoid.join(', ')}.`)
    if (cs.fallbackPhrase) rules.push(`Default fallback phrase: "${cs.fallbackPhrase}".`)
    parts.push(`COMMUNICATION RULES (set by business owner — always follow):\n${rules.join('\n')}`)
  }

  if (input.faqs && input.faqs.length > 0) {
    const faqText = input.faqs.map((f) => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n')
    parts.push(`BUSINESS FAQs — answer customer questions directly from these:\n${faqText}`)
  }

  return parts.join('\n\n')
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

/**
 * Build a compact DATE FACTS block for the conversational reply LLM so it never
 * invents dates. Pure and timezone-aware via Intl (no domain imports — keeps the
 * adapter layer free of core dependencies). The block lists today..today+7 as real
 * calendar facts; the LLM renders them into the reply's language. These are human
 * dates the LLM phrases, not internal codes/enums (G2 stays satisfied).
 *
 * Exported for unit testing without an LLM round-trip.
 */
export function buildDateFactsBlock(timezone: string, now: Date = new Date()): string {
  // Today's calendar date in the business timezone (en-CA → YYYY-MM-DD parts).
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
  const y = get('year'); const m = get('month'); const d = get('day')

  const pad = (n: number) => String(n).padStart(2, '0')
  const lines: string[] = []
  for (let offset = 0; offset <= 7; offset++) {
    // Pure calendar arithmetic on Y-M-D via UTC — no tz/DST involvement, correct
    // across month/year boundaries. getUTCDay() gives the weekday for that date.
    const dt = new Date(Date.UTC(y, m - 1, d + offset))
    const iso = `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
    const weekday = WEEKDAY_NAMES[dt.getUTCDay()]
    const label = offset === 0 ? 'Today: ' : offset === 1 ? 'Tomorrow: ' : ''
    lines.push(`- ${label}${weekday}, ${iso}`)
  }

  return `CURRENT DATE — use these exact facts for any date you state or the customer asks about. NEVER compute, guess, or invent a date; if asked about a day beyond this list, offer to check rather than guess. Render dates in the reply's language and the formatting rules above (e.g. Hebrew 'יום ראשון, 7 ביוני').
${lines.join('\n')}`
}

export async function generateCustomerReply(input: GenerateReplyInput): Promise<string> {
  const personaNotes = input.botPersona === 'female'
    ? 'Write in grammatically feminine form (Hebrew: use feminine verb conjugations and adjectives).'
    : input.botPersona === 'male'
    ? 'Write in grammatically masculine form (Hebrew: use masculine verb conjugations and adjectives).'
    : ''

  const knowledgeAddendum = buildKnowledgeAddendum(input)
  const dateFacts = input.businessTimezone ? buildDateFactsBlock(input.businessTimezone) : ''

  const systemPrompt = (
    PA_PERSONA_TEMPLATE
    + (personaNotes ? `\n\n${personaNotes}` : '')
    + (dateFacts ? `\n\n${dateFacts}` : '')
    + (knowledgeAddendum ? `\n\n${knowledgeAddendum}` : '')
  )
    .replace('{businessName}', input.businessName)
    .replace('{language}', input.language === 'he' ? 'he (Hebrew)' : 'en (English)')

  const transcriptText =
    input.transcript.length > 0
      ? input.transcript
          .map((t) => `${t.role === 'customer' ? 'Customer' : 'Assistant'}: ${t.text}`)
          .join('\n')
      : '(no prior messages in this session)'

  const recent = input.customerMemory?.recentBookings
  const recentText =
    recent && recent.length > 0
      ? ' Recent bookings (newest first): ' +
        recent
          .slice(0, 5)
          .map((b) => {
            const when = input.businessTimezone
              ? new Intl.DateTimeFormat('en-GB', { timeZone: input.businessTimezone, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(b.slotStart))
              : b.slotStart.slice(0, 10)
            return `${b.serviceName} (${when}${b.state === 'cancelled' ? ', cancelled' : ''})`
          })
          .join(', ') +
        '. Reference this naturally only if relevant — never recite it like a record.'
      : ''

  const summaries = input.customerMemory?.sessionSummaries
  const summariesText =
    summaries && summaries.length > 0
      ? ' Notes from past conversations (newest first): ' +
        summaries.map((s, i) => `[${i + 1}] ${s}`).join(' ') +
        ' Use this like a person who remembers — naturally and only if relevant. Never recite it or say "according to my notes".'
      : ''

  const memoryText = input.customerMemory
    ? `Returning customer: ${input.customerMemory.returningCustomer}. Preferred service: ${input.customerMemory.preferredServiceName ?? 'none'}. Name: ${input.customerMemory.displayName ?? 'unknown'}.${recentText}${summariesText}`
    : 'First-time customer (no profile data).'

  const factsBlock = input.businessFacts && input.businessFacts.trim().length > 0
    ? `BUSINESS FACTS (authoritative and exhaustive — never invent beyond this):
${input.businessFacts.trim()}

`
    : ''

  const ledgerBlock = input.actionLedger && input.actionLedger.trim().length > 0
    ? `${input.actionLedger.trim()}

`
    : ''

  const userTurn = `Situation: ${input.situation}

${factsBlock}${ledgerBlock}Recent conversation (tone & thread only — not a source of facts or outcomes):
${transcriptText}

Customer profile: ${memoryText}`

  try {
    const result = await generateConversational({
      contents: userTurn,
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: 1024,
        temperature: 0.3,
      },
    })

    const text = result.text?.trim()
    if (text) return text
  } catch {
    // fall through to fallback
  }

  return FALLBACK_REPLIES[input.language]
}

// ── Onboarding: conversational question generator ─────────────────────────────

const STEP_GOALS: Record<string, Record<'he' | 'en', string>> = {
  business_name: {
    he: 'שאל מה שם העסק שיוצג ללקוחות.',
    en: 'Ask what display name customers will see for the business.',
  },
  services: {
    he: 'שאל על השירות הראשי של העסק ומשך הזמן שלו — למשל "תספורת, 30 דקות". אפשר כמה שירותים ביחד.',
    en: 'Ask about their main service and how long it takes — like "Haircut, 30 min". Multiple services are fine.',
  },
  hours: {
    he: 'שאל מתי העסק פתוח — ימים ושעות. אם פתוח תמיד אפשר לומר 24/7.',
    en: 'Ask when the business is open — days and hours. They can say 24/7 if always open.',
  },
  cancellation_policy: {
    he: 'שאל עד כמה שעות מראש לקוחות יכולים לבטל תור. נסח את השאלה עם הביטוי "עד כמה שעות מראש". אם אין הגבלה — יכולים לומר "ללא הגבלה" או "0".',
    en: 'Ask up to how many hours in advance customers can cancel an appointment. They can say "no restriction" for unrestricted.',
  },
  payment: {
    he: 'שאל אם לקוחות צריכים לשלם לפני שהתור מאושר, ואם כן — באיזו שיטה (ביט, PayPal, העברה בנקאית וכו\'). שאלה אחת.',
    en: "Ask if customers need to pay before their booking is confirmed. If yes, what's the payment method (Bit, PayPal, bank transfer, etc.). One question.",
  },
  payment_method: {
    he: 'שאל רק מה שיטת התשלום — הם כבר אמרו שכן.',
    en: 'Ask only for the payment method — they already said yes.',
  },
  escalation_policy: {
    he: 'שאל מתי ה-PA צריך לעצור ולהעביר שיחה ישירות לבעל העסק — אילו נושאים או מצבים. שאלה אחת בלבד, בלי תפריט מספרים. אם הם מציינים גם מה לומר ללקוח, קלוט זאת — אך אל תשאל על כך בנפרד.',
    en: 'Ask when the PA should stop and hand a conversation to them — what situations or topics. Exactly one question, no numbered menu. If they also say what to tell the customer, capture it, but do not ask about it separately.',
  },
  customer_import: {
    he: 'שאל אם יש להם רשימת לקוחות קיימת, היסטוריית תורים, או קטלוג שירותים לייבוא.',
    en: 'Ask if they have an existing customer list, booking history, or service catalog to import.',
  },
}

export function buildOnboardingSystemPrompt(input: {
  step: string
  businessName: string
  lang: 'he' | 'en'
  isRetry: boolean
  justConfirmed?: string
  collectedSummary?: string
  extraContext?: string
  transcript?: TranscriptTurn[]
}): string {
  const stepGoal = STEP_GOALS[input.step]?.[input.lang] ?? STEP_GOALS[input.step]?.en ?? 'Ask for the next required piece of information.'

  const ackLine = input.justConfirmed
    ? (input.lang === 'he'
      ? `התשובה האחרונה שלהם: "${input.justConfirmed}". התחל בהתייחסות קצרה וטבעית לתשובה הזו, ואז שאל את השאלה הבאה.`
      : `Their last answer: "${input.justConfirmed}". Open with a brief natural acknowledgement of that, then ask the next question.`)
    : ''

  const retryNote = input.isRetry
    ? (input.lang === 'he'
      ? 'זהו ניסיון חוזר — הם לא ענו בצורה ברורה. נסח מחדש בסבלנות, מעט שונה.'
      : "This is a retry — they didn't answer clearly. Rephrase patiently, slightly different wording.")
    : ''

  const recentBlock = input.transcript && input.transcript.length > 0
    ? `\nRecent conversation so far (oldest first) — continue it naturally and do NOT reopen with a word you already used this session (if you already opened with "מעולה"/"Great", pick a different opener or none). Vary your phrasing and shape:\n${input.transcript.map((t) => `${t.role === 'customer' ? 'Owner' : 'You'}: ${sanitizeUserInput(t.text)}`).join('\n')}\n`
    : ''

  return `You are helping "${input.businessName}" set up their WhatsApp PA, texting them as the service.

${buildVoiceCore('onboarding')}

Language: Write ENTIRELY in ${input.lang === 'he' ? 'Hebrew' : 'English'}.
Rules:
- No bullet points. No numbered lists. No markdown.
- Truthfulness about actions: only acknowledge the SPECIFIC thing in "Their last answer"/"Context" above. NEVER claim you changed, updated, fixed, or saved anything else — not the business name, services, hours, or prices — unless it is explicitly stated above as already done. If the owner tries to correct a detail from an earlier step, do NOT say it's fixed or updated; briefly acknowledge their message, then continue the current step.
${ackLine}
${retryNote}
${input.collectedSummary ? `Already configured: ${input.collectedSummary}` : ''}
${input.extraContext ? `Context: ${input.extraContext}` : ''}
${recentBlock}
${middlemanExplainBlock(input.lang, 'brief')}

Current step task: ${stepGoal}

Output: the message text ONLY. No quotes, no labels, no preamble.`
}

export async function generateOnboardingReply(input: {
  step: string
  businessName: string
  collectedSummary?: string
  justConfirmed?: string
  isRetry: boolean
  lang: 'he' | 'en'
  extraContext?: string
  transcript?: TranscriptTurn[]
}): Promise<string> {
  const systemPrompt = buildOnboardingSystemPrompt(input)

  try {
    const result = await generateConversational({
      contents: 'Generate the next onboarding message.',
      config: { systemInstruction: systemPrompt, maxOutputTokens: 1024, temperature: 0.45 },
    })
    const text = result.text?.trim()
    if (text) return text
  } catch {
    // fall through — caller uses template fallback
  }
  return ''
}

// ── Manager: conversational fallback reply ────────────────────────────────────

export interface ManagerBusinessState {
  businessName: string
  timezone: string
  isPaused: boolean
  defaultLanguage: string
}

export async function generateManagerReply(input: {
  businessName: string
  language: 'he' | 'en'
  question: string
  transcript: Array<{ role: 'customer' | 'assistant'; text: string }>
  businessState: ManagerBusinessState
}): Promise<string> {
  const safeQuestion = sanitizeUserInput(input.question)
  const transcriptText = input.transcript.length > 0
    ? input.transcript.map((t) => `${t.role === 'customer' ? 'Manager' : 'Assistant'}: ${t.text}`).join('\n')
    : '(no prior messages this session)'

  const systemPrompt = `You are the admin assistant for "${input.businessName}", texting the business owner as the business.

${buildVoiceCore('manager')}

Business state:
- Timezone: ${input.businessState.timezone}
- PA status: ${input.businessState.isPaused ? 'paused (not accepting bookings)' : 'active'}
- Default language: ${input.businessState.defaultLanguage}

Language: reply ENTIRELY in ${input.language === 'he' ? 'Hebrew (עברית)' : 'English'}.

Extra rules:
- If you can answer from the business state above, answer it directly.
- If it's something you don't know (specific booking counts, customer data), say so plainly and point them to STATUS or UPCOMING.
- Never make up facts.

Recent conversation:
${transcriptText}

Output: reply text ONLY. No preamble, no quotes.`

  try {
    const result = await generateConversational({
      contents: safeQuestion,
      config: { systemInstruction: systemPrompt, maxOutputTokens: 1024, temperature: 0.35 },
    })
    const text = result.text?.trim()
    if (text) return text
  } catch {
    // fall through to empty — caller uses i18n fallback
  }
  return ''
}

// ── Operator: data-augmented smart answer ────────────────────────────────────

export interface CompactBusinessSummary {
  name: string
  phone: string
  status: 'live' | 'setup' | 'paused'
  calendarMode: 'google' | 'internal'
  googleCalendarConnected: boolean
  calendarTokenExpired: boolean
  hasWebsite: boolean
  openEscalations: number
  minutesSinceLastMsg: number | null
  managerPhoneNumber: string | null
}

export async function answerOperatorQuestion(input: {
  question: string
  transcript: Array<{ role: 'operator' | 'assistant'; text: string }>
  lang: 'he' | 'en'
  businesses: CompactBusinessSummary[]
  openEscalationsTotal: number
  sessionNotes?: string[]
  firstMessage?: boolean
}): Promise<string> {
  const safeQuestion = sanitizeUserInput(input.question)

  const live = input.businesses.filter((b) => b.status === 'live').length
  const setup = input.businesses.filter((b) => b.status === 'setup').length
  const paused = input.businesses.filter((b) => b.status === 'paused').length
  const withGcal = input.businesses.filter((b) => b.calendarMode === 'google' && b.googleCalendarConnected).length
  const withInternal = input.businesses.filter((b) => b.calendarMode === 'internal').length
  const withWebsite = input.businesses.filter((b) => b.hasWebsite).length

  const bizListText = input.businesses
    .map((b) => {
      let cal = b.calendarMode === 'internal' ? 'internal cal' : b.googleCalendarConnected ? 'Google cal ✓' : 'Google cal ✗'
      if (b.calendarTokenExpired) cal += ' (token expired)'
      const site = b.hasWebsite ? ' | website' : ''
      const esc = b.openEscalations > 0 ? ` | ${b.openEscalations} open escalation(s)` : ''
      const lastMsg = b.minutesSinceLastMsg !== null ? ` | last msg ${b.minutesSinceLastMsg}m ago` : ' | never messaged'
      const mgr = b.managerPhoneNumber ? ` | manager: ${b.managerPhoneNumber}` : ''
      return `• ${b.name} (${b.phone}) | ${b.status} | ${cal}${site}${esc}${lastMsg}${mgr}`
    })
    .join('\n')

  const statsLine =
    `${input.businesses.length} businesses total: ${live} live, ${setup} in setup` +
    (paused > 0 ? `, ${paused} paused` : '') +
    ` | ${withGcal} with Google Calendar, ${withInternal} with internal calendar` +
    ` | ${withWebsite} with website | ${input.openEscalationsTotal} open escalations`

  const transcriptText =
    input.transcript.length > 0
      ? input.transcript.map((t) => `${t.role === 'operator' ? 'Operator' : 'Assistant'}: ${t.text}`).join('\n')
      : '(start of session)'

  const notesBlock = input.sessionNotes && input.sessionNotes.length > 0
    ? `\nCross-session context (previous operator sessions):\n${input.sessionNotes.map((s, i) => `[Session ${i + 1}] ${s}`).join('\n')}`
    : ''

  // Hard greet-once gate (parity with Branch 4 mayGreet). The deterministic caller
  // knows whether this is the session's first message; do not leave it to inference.
  const greetDirective = input.firstMessage
    ? 'This is the FIRST message of the session — a brief, warm greeting is allowed before you answer.'
    : 'This is NOT the first message of the session — do NOT greet, do NOT open with hi/hello/שלום/היי, and do NOT re-introduce yourself. Continue the conversation directly.'

  const systemPrompt = `You are the MiddleMan admin assistant. MiddleMan is a WhatsApp-based PA platform for local businesses. You have full real-time access to the platform data below.

${buildVoiceCore('operator')}

Platform stats: ${statsLine}

Business list:
${bizListText}
${notesBlock}
Language: reply ENTIRELY in ${input.lang === 'he' ? 'Hebrew (עברית)' : 'English'}.

WhatsApp formatting — strictly enforced:
- No HTML tags. No markdown headers (#, ##). No markdown links [text](url).
- Bullet lists: use • (U+2022), not -, *, or numbered lists unless order matters.
- URLs: on their own line, never inline.
- Maximum one question per message.

Rules:
- Answer directly using specific numbers and names from the data above
- For "which businesses X" questions: list them by name (≤5: inline; more: bullet list)
- For count questions ("how many"): give the exact count first, then names if ≤5
- For yes/no questions: answer directly then add the relevant detail
- Maximum 5 sentences. No filler. No "based on the data I can see..."
- Never say you lack the data — you have full data above
- Never expose internal field names or raw system values
- Casual greetings: respond warmly and briefly, suggest a command
- ${greetDirective}

Recent conversation:
${transcriptText}

Output: reply text ONLY. No preamble, no quotes.`

  try {
    const result = await generateConversational({
      contents: safeQuestion,
      config: { systemInstruction: systemPrompt, maxOutputTokens: 1024, temperature: 0.3 },
    })
    const text = result.text?.trim()
    if (text) return text
  } catch {
    // fall through — caller uses static fallback
  }
  return ''
}

// ── Operator: legacy conversational reply (used as last-resort fallback) ──────

export async function generateOperatorReply(input: {
  question: string
  transcript: Array<{ role: 'operator' | 'assistant'; text: string }>
  lang: 'he' | 'en'
  liveStats?: { businessCount: number; openEscalations: number }
}): Promise<string> {
  const safeQuestion = sanitizeUserInput(input.question)
  const statsLine = input.liveStats
    ? `Live platform stats: ${input.liveStats.businessCount} businesses, ${input.liveStats.openEscalations} open escalation(s).`
    : ''

  const transcriptText = input.transcript.length > 0
    ? input.transcript.map((t) => `${t.role === 'operator' ? 'Operator' : 'Assistant'}: ${t.text}`).join('\n')
    : '(start of session)'

  const systemPrompt = `You are the MiddleMan admin assistant. MiddleMan is a WhatsApp-based PA platform for local businesses. The operator (platform owner) is texting you on WhatsApp.

${buildVoiceCore('operator')}
${statsLine ? `\n${statsLine}` : ''}
Language: reply ENTIRELY in ${input.lang === 'he' ? 'Hebrew (עברית)' : 'English'}.

Available commands (always suggest the most relevant one when you can't answer directly):
- STATUS — overview of all businesses
- STATUS [business name] — detailed status for one business
- ESCALATIONS — open escalations
- WEBSITES — which businesses have a live site
- UPDATE ALL: [instruction] — push a change to all businesses
- FEATURES — deferred feature requests
- RETRIGGER [business] [skill] — restart a skill workflow

If you don't have the specific data to answer, say so in one sentence and immediately suggest the command that would give the operator what they need. Never just say "I don't have that info" and stop.

Recent conversation:
${transcriptText}

Output: reply text ONLY. No preamble, no quotes.`

  try {
    const result = await generateConversational({
      contents: safeQuestion,
      config: { systemInstruction: systemPrompt, maxOutputTokens: 1024, temperature: 0.35 },
    })
    const text = result.text?.trim()
    if (text) return text
  } catch {
    // fall through — caller uses static fallback
  }
  return ''
}

// ── Onboarding: concept explainer ────────────────────────────────────────────

const CONCEPT_CONTEXT: Record<string, string> = {
  timezone: "The timezone for this business. Accepts an IANA timezone name (e.g. 'Asia/Jerusalem', 'America/New_York') or a city/country like 'Tel Aviv', 'London', 'Israel'.",
  calendar: "Whether to connect Google Calendar or use the built-in calendar. Google Calendar keeps existing appointments in sync automatically. The internal option is fully managed by the PA. Either works — it can be changed later.",
  services: "The service(s) this business offers and how long each takes. Just say the service name and its duration, e.g. 'Haircut, 30 min' or 'Massage, 60 minutes'.",
}

export async function explainOnboardingConcept(input: {
  concept: string
  userMessage: string
  step: string
  lang: 'he' | 'en'
}): Promise<string> {
  const context = CONCEPT_CONTEXT[input.step] ?? input.concept

  const systemPrompt = `You are helping a business owner set up their WhatsApp PA, texting them as the service. They seem confused or are asking a question at the "${input.step}" step.

${buildVoiceCore('onboarding')}

Language: Write ENTIRELY in ${input.lang === 'he' ? 'Hebrew' : 'English'}.
Extra rules:
- Plain language — no jargon, no markdown, no bullet points
- Explain the concept clearly, then end with a direct question asking them to provide the information (your last sentence MUST be a question ending with ?)

The concept to explain: ${context}

Output: the explanation message ONLY. No quotes, no labels, no preamble.`

  try {
    const result = await generateConversational({
      contents: `User message: "${input.userMessage}"`,
      config: { systemInstruction: systemPrompt, maxOutputTokens: 1024, temperature: 0.4 },
    })
    const text = result.text?.trim()
    if (text) return text
  } catch {
    // fall through — caller uses static fallback
  }
  return ''
}

// ── Onboarding: structured answer parser ─────────────────────────────────────

const cancellationSchema = z.object({
  isAnswer: z.boolean(),
  hours: z.number().int().min(0).nullable(),
})
const paymentSchema = z.object({
  isAnswer: z.boolean(),
  requiresPayment: z.boolean().nullable(),
  paymentMethod: z.string().nullable(),
})
const escalationSchema = z.object({
  isAnswer: z.boolean(),
  triggers: z.array(z.string()),
  minimalEscalation: z.boolean(),
  customerMessage: z.enum(['silent', 'passed_to_owner', 'owner_callback', 'custom']),
  customText: z.string().nullable(),
})

const onboardingServiceItemSchema = z.object({
  name: z.string().min(1),
  durationMinutes: z.coerce.number().int().positive(),
  maxParticipants: z.coerce.number().int().positive().nullable(),
  paymentAmount: z.coerce.number().nonnegative().nullable(),
  category: z.string().nullable(),
})
const onboardingServicesSchema = z.object({
  understood: z.boolean(),
  services: z.array(onboardingServiceItemSchema),
})
const businessNameSchema = z.object({
  isBusinessName: z.boolean(),
  name: z.string().nullable(),
})

const onboardingHourEntrySchema = z.object({
  dayOfWeek: z.coerce.number().int().min(0).max(6),
  openTime: z.string().regex(/^\d{1,2}:\d{2}$/).transform((s) => (s.length === 4 ? `0${s}` : s)),
  closeTime: z.string().regex(/^\d{1,2}:\d{2}$/).transform((s) => (s.length === 4 ? `0${s}` : s)),
})
const onboardingHoursSchema = z.object({
  understood: z.boolean(),
  always247: z.boolean(),
  days: z.array(onboardingHourEntrySchema),
})

const calendarChoiceSchema = z.object({
  choice: z.enum(['skip', 'connect', 'unclear']),
})

const importChoiceSchema = z.object({
  choice: z.enum(['import', 'skip', 'unclear']),
})

const PARSE_PROMPTS: Record<ParseableOnboardingStep, string> = {
  cancellation_policy: `Extract how many hours before an appointment the customer wants to allow cancellations.
First decide isAnswer: true only if the message actually answers the cancellation-cutoff question. Set isAnswer: false if the message is a counter-question (e.g. "what do you mean by cutoff?", "מה זה בעצם?"), a refusal/deferral ("not now", "later", "אחר כך"), or confusion. When isAnswer is false, return hours: null.
When isAnswer is true:
- If they say "any time", "no restriction", "ללא הגבלה", "כל עת", "0", "whenever", etc. → hours: 0.
- If they mention days (e.g. "two days") convert to hours (48).
Return JSON: { "isAnswer": boolean, "hours": number | null }`,

  payment: `Extract whether customers must pay before their booking is confirmed, and if so what payment method.
First decide isAnswer: true only if the message actually answers the prepayment question. Set isAnswer: false if the message is a counter-question (e.g. "which do you recommend?", "מה אתה ממליץ?"), a refusal/deferral, or confusion. When isAnswer is false, return requiresPayment: null and paymentMethod: null.
When isAnswer is true:
- If they say "yes", "כן", "תשלום מראש", "pay first" etc. → requiresPayment: true.
- If they say "no", "לא", "immediately", "מיידי" etc. → requiresPayment: false, paymentMethod: null.
- Extract the payment method if mentioned (e.g. "Bit", "PayPal", "bank transfer", "ביט", "כרטיס אשראי").
Keep paymentMethod in the manager's own language exactly as they expressed it — do NOT translate. "מזומן" stays "מזומן" (never "cash"), "העברה בנקאית" stays "העברה בנקאית" (never "bank transfer"). Brand names like Bit/PayPal stay as-is.
Return JSON: { "isAnswer": boolean, "requiresPayment": boolean | null, "paymentMethod": string | null }`,

  escalation_policy: `Extract when the PA should escalate/hand off a conversation to the business owner, and what to tell the customer.
First decide isAnswer: true only if the message actually describes when/how to escalate. Set isAnswer: false if the message is a counter-question (e.g. "what is an escalation?", "what do you mean?", "מה זה הסלמה?"), a refusal/deferral, or confusion. When isAnswer is false, return triggers: [], minimalEscalation: false, customerMessage: "passed_to_owner", customText: null.
When isAnswer is true:
- triggers: list of SHORT topic keywords or phrases to escalate (empty array if minimal escalation). Keep each trigger in the manager's own language exactly as they would appear in a customer message — do NOT translate and do NOT paraphrase into full sentences. If the manager says customers asking to reach a human should escalate, use a concise Hebrew keyword like "לדבר עם נציג" or "בן אדם" — never English like "talk to a human", and never a mangled phrase like "talk to speak with a human". These triggers are matched against real customer messages, so they must be in the customers' language.
- minimalEscalation: true if they want to escalate only truly unrecognizable requests
- customerMessage: "silent" if notify owner silently, "passed_to_owner" if tell customer someone will be in touch, "owner_callback" if tell customer the owner will call back, "custom" if they specified custom wording
- customText: their custom message text in the manager's own language, or null
Return JSON: { "isAnswer": boolean, "triggers": string[], "minimalEscalation": boolean, "customerMessage": "silent"|"passed_to_owner"|"owner_callback"|"custom", "customText": string|null }`,
}

export async function parseOnboardingAnswer(
  step: ParseableOnboardingStep,
  message: string,
  lang: 'he' | 'en',
): Promise<LlmResult<OnboardingAnswerOutput>> {
  const langNote = lang === 'he' ? 'The message is in Hebrew.' : 'The message is in English.'
  const systemPrompt = `${langNote}\n\n${PARSE_PROMPTS[step]}`
  const safeMessage = sanitizeUserInput(message)

  // Call with the correct schema per step — avoids union type narrowing issue
  if (step === 'cancellation_policy') {
    const raw = await callWithSchema(systemPrompt, safeMessage, cancellationSchema)
    if (!raw.ok) return raw
    return { ok: true, data: { step: 'cancellation_policy', ...raw.data } }
  }
  if (step === 'payment') {
    const raw = await callWithSchema(systemPrompt, safeMessage, paymentSchema)
    if (!raw.ok) return raw
    return { ok: true, data: { step: 'payment', ...raw.data } }
  }
  // escalation_policy
  const raw = await callWithSchema(systemPrompt, safeMessage, escalationSchema)
  if (!raw.ok) return raw
  return { ok: true, data: { step: 'escalation_policy', ...raw.data } }
}

export type OnboardingServiceItem = z.infer<typeof onboardingServiceItemSchema>

// Onboarding "services" step — parses a LIST of services from one message.
// The single-service classifyManagerInstruction schema cannot represent multiple
// services, but the onboarding prompt explicitly invites a list.
export async function parseOnboardingServices(
  message: string,
  lang: 'he' | 'en',
): Promise<LlmResult<{ understood: boolean; services: OnboardingServiceItem[] }>> {
  const langNote = lang === 'he' ? 'The manager is writing in Hebrew.' : 'The manager is writing in English.'
  const systemPrompt = `${langNote}

The manager is setting up their business PA and was asked to list the services they offer, each with a duration. The message may contain ONE service or MANY (one per line, comma-separated, or free text).

For each service extract:
- name: the service name only, cleaned (no duration, no price). Keep it in the manager's language.
- durationMinutes: convert any stated duration to whole minutes. "שעה"/"hour"/"שעה אחת" = 60. "חצי שעה"/"half an hour" = 30. "שעה וחצי"/"an hour and a half"/"hour and 30" = 90. "45 דקות"/"45 min" = 45. "שעתיים"/"two hours" = 120. If no duration is stated for a service, use 60.
- maxParticipants: a group/class capacity if stated (e.g. "(מקס 12)", "up to 10", "group of 8", "סדנה ל-8") → that number. For 1-on-1 / private services use null.
- paymentAmount: a price if stated (number only), otherwise null.
- category: a short logical grouping inferred from the name (e.g. "יוגה", "פילאטיס", "תספורת"), or null.

understood: set false ONLY if the message contains no service at all — i.e. it is a greeting, a question, an expression of confusion, or otherwise not a list of services. In that case return services: [].
If it contains at least one service, set understood: true.

Return JSON: { "understood": boolean, "services": [ { "name": string, "durationMinutes": number, "maxParticipants": number|null, "paymentAmount": number|null, "category": string|null } ] }`
  const safeMessage = sanitizeUserInput(message)
  return callWithSchema(systemPrompt, safeMessage, onboardingServicesSchema)
}

// Onboarding "business_name" step — validates that the manager actually gave a
// name, rather than a greeting/question that would otherwise be stored verbatim.
export async function parseBusinessName(
  message: string,
  lang: 'he' | 'en',
): Promise<LlmResult<{ isBusinessName: boolean; name: string | null }>> {
  const langNote = lang === 'he' ? 'The manager is writing in Hebrew.' : 'The manager is writing in English.'
  const systemPrompt = `${langNote}

The manager was just asked: what display name should customers see for their business? Decide whether this message actually provides a business name, or whether it is something else — a greeting, a question (e.g. "are you connected?", "מחובר?", "מי זה?"), an expression of confusion, or small talk.

- If the message provides a business name, set isBusinessName: true and put the cleaned name in "name" (strip greetings like "שלום"/"hi", strip surrounding quotes, keep it in the manager's language). A plausible business name is a short noun phrase (e.g. "מספרת ליאד", "Studio Flow", "יוגה עם דנה").
- If the message is a greeting, a question, confusion, or clearly not a business name, set isBusinessName: false and name: null.

Return JSON: { "isBusinessName": boolean, "name": string | null }`
  const safeMessage = sanitizeUserInput(message)
  return callWithSchema(systemPrompt, safeMessage, businessNameSchema)
}

// ── Onboarding: amend a previously-given answer ─────────────────────────────────

const onboardingAmendmentSchema = z.object({
  isAmendment: z.boolean().catch(false),
  field: z.enum(['business_name', 'services', 'hours', 'cancellation', 'payment', 'escalation', 'none']).catch('none'),
  newValue: z.string().nullable().catch(null),
})
export type OnboardingAmendmentOutput = z.infer<typeof onboardingAmendmentSchema>

/**
 * Detect whether, mid-onboarding, the manager is CORRECTING an answer they already
 * gave (vs. answering the current question). Used so a "actually the name is X" /
 * "מתקן - השם הוא X" is applied to the right field instead of being ignored or
 * falsely confirmed. Conservative by design: only callers with a correction cue
 * should invoke it, and it returns isAmendment=false for ordinary answers.
 */
export async function detectOnboardingAmendment(
  message: string,
  currentName: string,
  lang: 'he' | 'en',
): Promise<LlmResult<OnboardingAmendmentOutput>> {
  const langNote = lang === 'he' ? 'The manager is writing in Hebrew.' : 'The manager is writing in English.'
  const systemPrompt = `${langNote}

During business setup the manager may CORRECT an earlier answer instead of answering the current question. The business name currently on file is: "${currentName}".

Decide:
- "isAmendment": true ONLY if they are clearly fixing or changing a PREVIOUSLY-given answer (e.g. "actually the name is X", "I meant to say…", "change the hours to…", "מתקן - השם הוא X", "השם צריך להיות X"). If they are simply answering the current question, set false.
- "field": which earlier answer they're correcting — one of business_name | services | hours | cancellation | payment | escalation | none.
- "newValue": the corrected value if they stated it (e.g. the corrected business name "X"), else null.

Return JSON: { "isAmendment": boolean, "field": string, "newValue": string | null }`
  const safeMessage = sanitizeUserInput(message)
  return callWithSchema(systemPrompt, safeMessage, onboardingAmendmentSchema) as Promise<LlmResult<OnboardingAmendmentOutput>>
}

export type OnboardingHourEntry = z.infer<typeof onboardingHourEntrySchema>

// Onboarding "hours" step — parses a full weekly schedule into per-day entries.
// The single-day availability_change schema cannot represent a multi-day week,
// but managers naturally give ranges like "Sun–Fri 9–21, Friday 9–16".
export async function parseOnboardingHours(
  message: string,
  lang: 'he' | 'en',
): Promise<LlmResult<{ understood: boolean; always247: boolean; days: OnboardingHourEntry[] }>> {
  const langNote = lang === 'he' ? 'The manager is writing in Hebrew.' : 'The manager is writing in English.'
  const systemPrompt = `${langNote}

The manager is setting up their business PA and was asked when the business is open — days and opening hours. Convert their answer into a per-day weekly schedule.

dayOfWeek numbering: 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday.
Hebrew day names: ראשון=0, שני=1, שלישי=2, רביעי=3, חמישי=4, שישי=5, שבת=6. Treat "שישית" as שישי (Friday, 5).

Rules:
- Expand day ranges into individual days. "ראשון עד שישי" / "Sun–Fri" → days 0,1,2,3,4,5. "א'-ה'" → 0,1,2,3,4.
- Apply exceptions: "למעט"/"except"/"חוץ מ" override the general hours for the named day(s). Example: "Sun–Fri 09:00–21:00, except Friday 09:00–16:00" → days 0,1,2,3,4 at 09:00–21:00 AND day 5 at 09:00–16:00.
- Only include days the business is OPEN. Days not mentioned are closed — omit them entirely.
- openTime/closeTime: 24-hour, zero-padded "HH:MM" (e.g. "09:00", "21:00"). Convert "9"/"9:00"/"9am" → "09:00", "9pm" → "21:00", "4pm" → "16:00".
- always247: true ONLY if they say always open / 24/7 / "תמיד פתוח" / "פתוח כל הזמן" — then return days: [].
- understood: false ONLY if the message has no hours information at all (a greeting, a question, or confusion) — then return days: [] and always247: false.

Return JSON: { "understood": boolean, "always247": boolean, "days": [ { "dayOfWeek": number, "openTime": "HH:MM", "closeTime": "HH:MM" } ] }`
  const safeMessage = sanitizeUserInput(message)
  return callWithSchema(systemPrompt, safeMessage, onboardingHoursSchema)
}

// Onboarding "calendar" step — the manager was sent a Google OAuth link and asked
// to connect their calendar. They reply in free text. Decide whether they want to
// SKIP Google and run on the internal calendar, or are still going to CONNECT.
export async function parseCalendarChoice(
  message: string,
  lang: 'he' | 'en',
): Promise<LlmResult<{ choice: 'skip' | 'connect' | 'unclear' }>> {
  const langNote = lang === 'he' ? 'The manager is writing in Hebrew.' : 'The manager is writing in English.'
  const systemPrompt = `${langNote}

The manager was sent a Google Calendar connection link and asked to connect their calendar. Classify their reply:

- "skip": they decline, defer, or prefer NOT to connect Google now — they want to work without Google / use the internal calendar. Examples: "כרגע לא", "לא עכשיו", "בלי גוגל", "רוצה לעבוד ללא גוגל", "אין לי גוגל", "דלג", "אחר כך", "not now", "skip", "without Google", "I'll do it later", "no thanks".
- "connect": they confirm they want to / did connect, or ask where the link is. Examples: "כן", "מחובר", "חיברתי", "איפה הקישור?", "yes", "connected", "done", "send the link".
- "unclear": anything else — a greeting, an unrelated question, or confusion.

Return JSON: { "choice": "skip" | "connect" | "unclear" }`
  const safeMessage = sanitizeUserInput(message)
  return callWithSchema(systemPrompt, safeMessage, calendarChoiceSchema)
}

// Onboarding "customer_import" step — the manager was asked whether they have an
// existing customer list / booking history / service catalog to bulk-import. They
// reply in free text. Decide whether they want to IMPORT (get an upload link),
// SKIP (move on now), or it's UNCLEAR (a question/confusion → explain & re-ask).
// Replaces the old isAffirmative/isNegative keyword gate that looped on any
// natural phrasing ("נדלג", "בוא נמשיך", "אין רשימה", "יש לי קובץ").
export async function parseImportChoice(
  message: string,
  lang: 'he' | 'en',
): Promise<LlmResult<{ choice: 'import' | 'skip' | 'unclear' }>> {
  const langNote = lang === 'he' ? 'The manager is writing in Hebrew.' : 'The manager is writing in English.'
  const systemPrompt = `${langNote}

The manager is setting up their PA and was asked whether they have an existing customer list, booking history, or service catalog they want to bulk-import now. Classify their reply:

- "import": they want to import / upload now, or say they have a file or list to bring in. Examples: "כן", "יש לי קובץ", "יש לי רשימת לקוחות", "אקסל", "בוא נעלה", "yes", "I have a list", "sure", "let's upload".
- "skip": they have no list, or want to move on / skip / do it later. Examples: "נדלג", "דלג", "אין לי רשימה", "אין רשימת לקוחות", "בוא נמשיך", "להמשיך הלאה", "אחר כך", "skip", "no list", "let's move on", "continue", "not now".
- "unclear": anything else — a question about the format or process, a greeting, or confusion. Examples: "באיזה פורמט?", "מה זאת אומרת?", "what format?", "how does it work?".

Return JSON: { "choice": "import" | "skip" | "unclear" }`
  const safeMessage = sanitizeUserInput(message)
  return callWithSchema(systemPrompt, safeMessage, importChoiceSchema)
}

// ── Meeting coordination: external contact reply classifier ──────────────────

const meetingReplySchema = z.object({
  intent: z.enum(['propose_time', 'decline', 'unclear']).catch('unclear'),
  relativeDay: z.enum(['today', 'tomorrow', 'day_after_tomorrow', 'this_week', 'next_week']).nullable().catch(null),
  weekday: z.number().int().min(0).max(6).nullable().catch(null),
  explicitDate: z
    .object({
      year: z.number().int().nullable().catch(null),
      month: z.number().int().min(1).max(12).nullable().catch(null),
      day: z.number().int().min(1).max(31).nullable().catch(null),
    })
    .nullable()
    .catch(null),
  startTime: z
    .object({ hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59) })
    .nullable()
    .catch(null),
})

export type MeetingReplyOutput = z.infer<typeof meetingReplySchema>

// Classify an external meeting invitee's free-text reply into a structured intent.
// The LLM only extracts day/time PIECES — never an absolute date (resolved downstream).
export async function interpretMeetingReply(
  replyText: string,
  candidateSummaries: string,
  lang: 'he' | 'en',
): Promise<LlmResult<MeetingReplyOutput>> {
  const langNote = lang === 'he' ? 'The person is writing in Hebrew.' : 'The person is writing in English.'
  const systemPrompt = `${langNote}

Someone was invited to a meeting and offered these candidate time(s): ${candidateSummaries}.
Classify their reply:
- intent "propose_time": they agree to one of the offered times OR propose a specific different time. In BOTH cases extract the day/time PIECES of the time they indicated — NEVER an absolute/ISO date.
- intent "decline": they cannot or do not want to meet at any of these and propose no alternative.
- intent "unclear": you cannot tell, they ask a question, or they give no usable time.

Date pieces (only when intent is propose_time; otherwise null):
- relativeDay: "today"/"היום"→today, "tomorrow"/"מחר"→tomorrow, "day after tomorrow"/"מחרתיים"→day_after_tomorrow, "this week"/"השבוע"→this_week, "next week"/"שבוע הבא"→next_week; else null.
- weekday: 0=Sun..6=Sat when they name a weekday; else null.
- explicitDate: fill day+month for a stated calendar date ("May 2"/"2 במאי"); year only if explicitly stated; else null.
- startTime: { hour 0-23, minute 0-59 } of the time they indicated; null if no clock time.

Return JSON: { "intent": "propose_time"|"decline"|"unclear", "relativeDay": ...|null, "weekday": number|null, "explicitDate": {"year":..,"month":..,"day":..}|null, "startTime": {"hour":..,"minute":..}|null }`
  const safeMessage = sanitizeUserInput(replyText)
  return callWithSchema(systemPrompt, safeMessage, meetingReplySchema) as Promise<LlmResult<MeetingReplyOutput>>
}

// ── Proactive customer message generator ─────────────────────────────────────
// Used for all system-initiated messages to customers: reminders, hold expiry,
// waitlist offers, schedule-change cancellations, payment confirmations, and
// the business-hours / paused / revoked gates in the webhook.

const PROACTIVE_PERSONA = `You are sending a WhatsApp message on behalf of {businessName}, speaking as the business itself.

${buildVoiceCore('proactive')}

LANGUAGE: write ENTIRELY in {language}. Never mix languages.

WHATSAPP FORMATTING (hard rules):
- *bold* only for key info (service name, time). Never bold full sentences.
- Bullet lists: • (U+2022) with a space. Never -, *, or numbered unless order matters.
- URLs: on their own line, never inline.
- No HTML, no markdown headers (#, ##), no tables.
- One question maximum per message.
- Emoji: one maximum at a key moment (✅ confirmed, ⏰ reminder, ❌ cancelled). None in questions.

Output: one message ONLY. No preamble, no quotation marks.`

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    promise.then((v) => { clearTimeout(timer); resolve(v) }, () => { clearTimeout(timer); resolve(fallback) })
  })
}

/**
 * The proactive seam's output gate (Unified Anti-Fabrication Gate — Seam C, T2a.1).
 *
 * The ~29 worker/initiation sends share this one door. The gate ENFORCES the ACTION class
 * only when the caller supplies a structured `backedActions` set (swap to the caller's
 * `fallback` template on an unbacked completed-action claim) — so the existing callers, which
 * pass no truth set, are unchanged and only MONITOR-logged. Time is enforced ONLY where a
 * caller supplies `allowedTimes` (RED-TEAM D3 — most workers have no allowlist, so blanket
 * time-enforcement here would be inert or over-fire; waitlist truthfulness is T2a.2's
 * fresh-spine re-validate, not this gate). The gate fires only on its narrow spans (a
 * completed-action verb, a clock time) — warmth/glue is never touched, and the `fallback`
 * (e.g. dunning's pay-link-bearing template) is returned verbatim on a swap, link intact.
 */
export function gateProactiveBody(body: string, opts: {
  language: 'he' | 'en'
  fallback: string
  backedActions?: ReadonlySet<ActionClaim> | undefined
  allowedTimes?: Iterable<string> | undefined
  businessId?: string | undefined
}): { body: string; swapped: boolean } {
  // Run the mechanical bot-tell monitor (monitor-only — logs, never mutates) on whatever body
  // we ultimately return. P3-C1: the proactive door previously had no voice monitor at all.
  const monitor = (b: string): { body: string; swapped: boolean } => {
    observeVoiceTells(b, { businessId: opts.businessId, language: opts.language })
    return { body: b, swapped: b !== body }
  }

  // Gate 4 (check/ask) ENFORCE (P3-C1): a self-authored "I'll check / get back to you" in an
  // AUTOMATED message is always unbacked — workers don't escalate to the owner — so it is a
  // fabrication regardless of any truth set. Swap to the safe template. (Branch 4 enforces this
  // via the unified gate; the proactive door had no equivalent before.)
  if (hasActionFabrication(body)) {
    console.warn('[proactive-gate] action-fabrication (check/ask) — swapped to template', {
      gate: 'proactive', businessId: opts.businessId, tell: 'action_fabrication',
    })
    return monitor(opts.fallback)
  }

  const claims = detectActionClaims(body, opts.language)
  const unbackedTimes = opts.allowedTimes ? findUnbackedTimes(body, opts.allowedTimes) : []

  // ENFORCE action: a structured truth set was supplied, so an unbacked completed-action claim
  // is a fabrication → swap to the safe template.
  if (opts.backedActions) {
    const unbacked = claims.filter((c) => !opts.backedActions!.has(c))
    if (unbacked.length > 0 || unbackedTimes.length > 0) {
      console.warn('[proactive-gate] unbacked claim — swapped to template', {
        gate: 'proactive', businessId: opts.businessId, claims: unbacked, times: unbackedTimes,
      })
      return monitor(opts.fallback)
    }
    return monitor(body)
  }

  // ENFORCE time where an allowlist was supplied even without backedActions (D3 — opt-in).
  if (unbackedTimes.length > 0) {
    console.warn('[proactive-gate] unbacked time — swapped to template', {
      gate: 'proactive', businessId: opts.businessId, times: unbackedTimes,
    })
    return monitor(opts.fallback)
  }

  // MONITOR: no truth set → observe the softer classes (H8/H12 are monitored, not closed).
  if (claims.length > 0) {
    console.warn('[proactive-gate] unverified claim (monitor-only)', {
      gate: 'proactive', businessId: opts.businessId, claims,
    })
  }
  return monitor(body)
}

export async function generateProactiveCustomerMessage(input: {
  businessName: string
  language: 'he' | 'en'
  situation: string
  fallback: string
  timeoutMs?: number
  // Optional structured truth (T2a.1). When `backedActions` is supplied the gate ENFORCES the
  // action class (swap to `fallback`); otherwise it monitor-logs. `allowedTimes` opts into time
  // enforcement (D3). Most callers pass neither — they get the structural chokepoint + monitor.
  backedActions?: ReadonlySet<ActionClaim>
  allowedTimes?: Iterable<string>
  businessId?: string
}): Promise<string> {
  const systemPrompt = PROACTIVE_PERSONA
    .replace('{businessName}', input.businessName)
    .replace('{language}', input.language === 'he' ? 'he (Hebrew)' : 'en (English)')

  const gate = (body: string): string => gateProactiveBody(body, {
    language: input.language,
    fallback: input.fallback,
    backedActions: input.backedActions,
    allowedTimes: input.allowedTimes,
    businessId: input.businessId,
  }).body

  const call = (async (): Promise<string> => {
    try {
      const result = await generateConversational({
        contents: `Situation: ${input.situation}`,
        config: { systemInstruction: systemPrompt, maxOutputTokens: 512, temperature: 0.3 },
      })
      const text = result.text?.trim()
      // The fallback is already safe (template) — only the LLM-generated body needs gating.
      return text ? gate(text) : input.fallback
    } catch {
      return input.fallback
    }
  })()

  return input.timeoutMs ? withTimeout(call, input.timeoutMs, input.fallback) : call
}

// ── Provider onboarding reply generator (Branch 2 — MiddleMan) ────────────────

const PROVIDER_STEP_GOALS: Record<string, { he: string; en: string }> = {
  welcome: {
    he: 'ברך את בעל העסק בחום וקצר, וגם בעברית וגם באנגלית (שכן השפה טרם ידועה). שאל מה שם העסק שלהם.',
    en: 'Greet the business owner warmly and briefly in BOTH Hebrew and English (language unknown). Ask for their business name.',
  },
  ask_business_name: {
    he: 'שאל שוב מה שם העסק — הם שלחו ברכה ולא שם. שאלה אחת.',
    en: 'Ask again for the business name — they greeted you without giving a name. One sentence.',
  },
  ask_timezone: {
    he: 'שאל באיזה אזור זמן נמצא העסק. דוגמאות: "ישראל", "תל אביב", "לונדון". קצר.',
    en: 'Ask what timezone the business is in. Examples: "Israel", "Tel Aviv", "London". Brief.',
  },
  bad_timezone: {
    he: 'אזור הזמן שנשלח לא זוהה. בקש שינסו שם עיר, מדינה, או IANA — למשל "ישראל" או "Asia/Jerusalem".',
    en: 'Timezone wasn\'t recognized. Ask them to try a city/country name or IANA — like "Israel" or "Asia/Jerusalem".',
  },
  ask_calendar_mode: {
    he: 'שאל אם יש להם Google Calendar לחיבור, או שמתחילים עם יומן פנימי. ניתן לשנות מאוחר. שאלה אחת.',
    en: "Ask if they have a Google Calendar to connect, or if they'd prefer an internal calendar to start. Can be changed later. One question.",
  },
  ask_calendar_id: {
    he: 'שאל מה ה-Google Calendar ID שלהם (בדרך כלל כתובת אימייל, נמצא בהגדרות Google Calendar).',
    en: 'Ask for their Google Calendar ID (usually their email address — found in Google Calendar settings).',
  },
  ask_services: {
    he: 'שאל מה השירות הראשי שלהם ומשך הזמן שלו — למשל "תספורת, 30 דקות". אפשר כמה שירותים.',
    en: 'Ask what their main service is and how long it takes — like "Haircut, 30 minutes". Multiple services are fine.',
  },
  bad_services: {
    he: 'לא הצלחנו לפענח. בקש ניסוח מחדש עם שם ומשך — למשל "תספורת, 30 דקות".',
    en: 'Couldn\'t parse the service. Ask them to rephrase — name and duration, like "Haircut, 30 minutes".',
  },
  credentials_waiting: {
    he: 'ממתינים לאישור הקישור. הסבר בקצרה שברגע שיסיימו בקישור, הכל יסתיים אוטומטית.',
    en: 'Waiting for the signup link to be completed. Briefly explain that once they finish the link, everything completes automatically.',
  },
  already_done: {
    he: 'ה-PA כבר מוגדר. ספר להם לפנות למספר ה-PA ישירות לשינויים.',
    en: 'The PA is already set up. Tell them to contact the PA number directly for any changes.',
  },
  image_not_supported: {
    he: 'הם שלחו תמונה. הסבר בחום שניתן לשלוח טקסט בלבד, ובקש שיכתבו מה ברצונם.',
    en: 'They sent an image. Warmly explain this assistant only understands text messages and ask them to describe what they need in words.',
  },
  waba_check: {
    he: 'שאל אם יש להם כבר מספר וואטסאפ עסקי שהם משתמשים בו לעסק. כן/לא. שאלה אחת.',
    en: 'Ask if they already have a WhatsApp Business number they use for the business. Yes/No. One sentence.',
  },
  waba_check_retry: {
    he: 'לא ברור אם יש להם מספר וואטסאפ עסקי. נסח מחדש בסבלנות: יש להם מספר וואטסאפ של העסק, או שהם מתחילים מאפס?',
    en: "It's unclear if they have a business WhatsApp number. Rephrase patiently: do they have an existing WhatsApp Business number, or are they starting fresh?",
  },
  waba_guide_type: {
    he: 'שאל אם המספר פועל דרך אפליקציית וואטסאפ ביזנס על הטלפון, או שהוא מחובר דרך Meta Business Manager. שתי אפשרויות — תן לבחור אחת.',
    en: 'Ask whether their number runs through the WhatsApp Business App on their phone, or through Meta Business Manager. Two options — let them pick one.',
  },
  waba_guide_type_retry: {
    he: 'התשובה לא ברורה. נסח מחדש בסבלנות: האם הם מנהלים את מספר העסק דרך האפליקציה בטלפון (וואטסאפ ביזנס), או דרך Meta Business Manager?',
    en: "The answer wasn't clear. Rephrase patiently: do they manage their business number through the app on their phone (WhatsApp Business App), or through Meta Business Manager?",
  },
  waba_guide_bsp: {
    he: 'שאל אם הגדירו את חשבון ה-Meta Business Manager בעצמם, או שחברה/סוכנות חיצונית ניהלה את ההגדרה עבורם.',
    en: 'Ask whether they set up their Meta Business Manager account themselves, or if an external company or agency managed the setup for them.',
  },
  waba_guide_bsp_retry: {
    he: 'לא ברור. נסח מחדש: הם הגדירו את ה-Meta Business Manager בעצמם, או שמישהו אחר עשה את זה?',
    en: "Not clear. Rephrase: did they set up Meta Business Manager themselves, or did someone else do it?",
  },
}

export async function generateProviderOnboardingReply(input: {
  step: string
  lang: 'he' | 'en' | 'bilingual'
  collectedData?: { businessName?: string }
  justConfirmed?: string
  isRetry?: boolean
  extraContext?: string
  fallback: string
}): Promise<string> {
  const isBilingual = input.lang === 'bilingual'
  const lang: 'he' | 'en' = isBilingual ? 'he' : (input.lang as 'he' | 'en')
  const goals = PROVIDER_STEP_GOALS[input.step]
  const stepGoal = goals?.[lang] ?? goals?.en ?? 'Ask for the next required piece of information.'

  const langInstruction = isBilingual
    ? 'Write the message in BOTH Hebrew and English. Put the Hebrew version first, then an empty line, then the English version.'
    : `Write ENTIRELY in ${lang === 'he' ? 'Hebrew' : 'English'}.`

  const ackLine = input.justConfirmed
    ? (lang === 'he'
      ? `הם אישרו: "${input.justConfirmed}". התחל בהתייחסות קצרה ואז שאל.`
      : `They confirmed: "${input.justConfirmed}". Open with a brief acknowledgement then ask.`)
    : ''

  const retryNote = input.isRetry
    ? (lang === 'he' ? 'ניסיון חוזר — נסח מחדש בסבלנות.' : 'Retry — rephrase patiently with slightly different wording.')
    : ''

  const nameCtx = input.collectedData?.businessName ? `Business name: "${input.collectedData.businessName}".` : ''

  const systemPrompt = `You are MiddleMan — a WhatsApp service that sets up booking assistants for local businesses. You are onboarding a new business owner via WhatsApp, texting them as the service.

${buildVoiceCore('onboarding')}

${langInstruction}
Extra rules:
- No bullet points. No numbered lists. No markdown.
- In bilingual mode (language unknown): ask one thing per language block.
${ackLine}
${retryNote}
${nameCtx}
${input.extraContext ? `Extra context: ${input.extraContext}` : ''}

${middlemanExplainBlock(lang, 'full')}

Current step: ${stepGoal}

Output: the message text ONLY. No quotes, no labels, no preamble.`

  try {
    const result = await generateConversational({
      contents: 'Generate the next onboarding message.',
      config: { systemInstruction: systemPrompt, maxOutputTokens: 512, temperature: 0.4 },
    })
    const text = result.text?.trim()
    if (text) return text
  } catch {
    // fall through to fallback
  }
  return input.fallback
}

// ── Manager command reply generator (Branch 3 — keyword commands) ─────────────
// Used to format the output of STATUS / PAUSE / RESUME / UPCOMING / PAID / HANDLED
// and other deterministic manager commands into natural WhatsApp messages.

export async function generateManagerCommandReply(input: {
  businessName: string
  language: 'he' | 'en'
  situation: string
  dataBlock?: string
  fallback: string
}): Promise<string> {
  const systemPrompt = `You are the PA admin assistant for "${input.businessName}", texting the business owner as the business. They just ran a command and you're responding on WhatsApp.

${buildVoiceCore('manager')}

LANGUAGE: reply ENTIRELY in ${input.language === 'he' ? 'Hebrew (עברית)' : 'English'}.

WHATSAPP FORMATTING:
- No HTML. No markdown headers (#, ##). No markdown links.
- Bullet lists: • (U+2022). Not -, *, or numbered unless order matters.
- *bold* only for key labels or values — never whole sentences.
- Emoji for status: ✅ active/ok, ⏸ paused, ❌ error/missing, 📅 calendar, 💳 payment.
- Maximum 15 lines for data reports.

The data below is raw — present it naturally in your own words, never as raw key-value pairs and never quoted verbatim.
${input.dataBlock ? `Data to present:\n${input.dataBlock}` : ''}

Output: the reply ONLY. No preamble, no quotes.`

  try {
    const result = await generateConversational({
      contents: `Command context: ${input.situation}`,
      config: { systemInstruction: systemPrompt, maxOutputTokens: 1024, temperature: 0.25 },
    })
    const text = result.text?.trim()
    if (text) return text
  } catch {
    // fall through to fallback
  }
  return input.fallback
}

// ── Operator data formatter (Branch 1 — structured command responses) ─────────
// Wraps pre-assembled operator console data through LLM for natural formatting.

export async function formatOperatorDataReply(input: {
  question: string
  dataBlock: string
  lang: 'he' | 'en'
  fallback: string
}): Promise<string> {
  const systemPrompt = `You are the MiddleMan admin assistant. The operator (platform owner) ran a command and you need to present the results clearly on WhatsApp.

${buildVoiceCore('operator')}

LANGUAGE: reply ENTIRELY in ${input.lang === 'he' ? 'Hebrew (עברית)' : 'English'}.

WHATSAPP FORMATTING:
- No HTML. No markdown headers. No markdown links.
- Bullet lists: • (U+2022). Not -, *, or numbered unless order matters.
- *bold* for business names, section headers, and key statuses only.
- Emoji for status: ✅ live/ok, ⏸ paused, ⏳ onboarding, ❌ error, 📅 calendar, 🌐 website.
- Maximum 25 lines. Group intelligently for long lists.

Use the exact data provided — do not add, infer, or invent anything. Present it in your own words, never quoted verbatim as raw key-value pairs.

Data to present:
${input.dataBlock}

Output: the formatted reply ONLY. No preamble, no quotes.`

  try {
    const result = await generateConversational({
      contents: `Operator command: ${input.question}`,
      config: { systemInstruction: systemPrompt, maxOutputTokens: 1024, temperature: 0.2 },
    })
    const text = result.text?.trim()
    if (text) return text
  } catch {
    // fall through to fallback
  }
  return input.fallback
}

const QUOTA_ERROR_CODES = new Set([429, 503, 'RESOURCE_EXHAUSTED', 'UNAVAILABLE'])

function isQuotaError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase()
    if (msg.includes('quota') || msg.includes('rate limit') || msg.includes('resource_exhausted')) return true
  }
  const code = (err as { code?: unknown })?.code
  return QUOTA_ERROR_CODES.has(code as string | number)
}

async function callWithSchema<T>(
  systemPrompt: string,
  userMessage: string,
  schema: z.ZodType<T>,
): Promise<LlmResult<T>> {
  const MAX_ATTEMPTS = 4
  let lastError = ''

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const result = await ai.models.generateContent({
        model: MODEL,
        contents: userMessage,
        config: {
          systemInstruction: systemPrompt,
          // gemini-2.5-flash reasons by default and its thinking tokens draw down
          // maxOutputTokens. Large classifier prompts (e.g. the ~250-line manager
          // instruction spec) can burn the whole budget thinking and return EMPTY
          // text → the caller sees ok:false ("Classification failed"). Classification
          // is structured extraction that does not need reasoning, so disable thinking
          // (thinkingBudget:0 is valid on Flash; see generateConversational fallback)
          // and keep real headroom for the JSON answer.
          thinkingConfig: { thinkingBudget: 0 },
          maxOutputTokens: 2048,
          temperature: 0,
          responseMimeType: 'application/json',
        },
      })

      const text = result.text
      if (!text) {
        lastError = 'empty response'
        if (process.env['LLM_DEBUG']) console.error('[LLM] empty response')
        continue
      }

      let parsed: unknown
      try {
        // Strip markdown code fences if present
        const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
        parsed = JSON.parse(jsonText)
      } catch {
        lastError = 'invalid JSON'
        if (process.env['LLM_DEBUG']) console.error('[LLM] invalid JSON, raw:', text.slice(0, 200))
        continue
      }

      const validation = schema.safeParse(parsed)
      if (validation.success) return { ok: true, data: validation.data }
      lastError = validation.error.message
      if (process.env['LLM_DEBUG']) console.error('[LLM] schema validation failed:', validation.error.issues, 'raw:', text.slice(0, 200))
    } catch (err) {
      if (isQuotaError(err)) {
        return { ok: false, error: 'quota_exceeded' }
      }
      lastError = err instanceof Error ? err.message : String(err)
      if (process.env['LLM_DEBUG']) console.error(`[LLM] attempt ${attempt} threw:`, lastError)
      if (attempt === MAX_ATTEMPTS - 1) {
        return { ok: false, error: lastError }
      }
    }
  }

  return { ok: false, error: `LLM returned invalid structured output after ${MAX_ATTEMPTS} attempts: ${lastError}` }
}
