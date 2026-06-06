import { GoogleGenAI } from '@google/genai'
import { z } from 'zod'
import type { CustomerIntentOutput, ManagerInstructionOutput, OperatorActionOutput, LlmResult, GenerateReplyInput, ParseableOnboardingStep, OnboardingAnswerOutput } from './types.js'

const LLM_API_KEY = process.env['LLM_API_KEY']
if (!LLM_API_KEY) throw new Error('LLM_API_KEY is required')

const MODEL = 'gemini-2.5-flash'

const ai = new GoogleGenAI({ apiKey: LLM_API_KEY, apiVersion: 'v1beta' })

const customerIntentSchema = z.object({
  intent: z.enum(['booking', 'rescheduling', 'cancellation', 'inquiry', 'list_bookings', 'unknown']).catch('unknown'),
  slotRequest: z
    .object({
      hasSpecificDate: z.boolean().catch(false),
      hasSpecificTime: z.boolean().catch(false),
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
  summary: z.string().nullable().catch(null),
  rawEntities: z.record(z.unknown()).transform((v) =>
    Object.fromEntries(Object.entries(v).map(([k, val]) => [k, String(val)])),
  ).catch({}),
  detectedLanguage: z.enum(['he', 'en']).catch('he'),
})

const managerInstructionSchema = z.object({
  instructionType: z.enum([
    'availability_change',
    'policy_change',
    'service_change',
    'permission_change',
    'booking_cancellation',
    'unknown',
  ]),
  structuredParams: z.record(z.unknown()),
  ambiguous: z.boolean(),
  clarificationNeeded: z.string().nullable(),
})

export async function extractCustomerIntent(
  message: string,
  sessionContext: Record<string, unknown>,
  businessTimezone: string,
  availableServices: string[],
  botPersona?: 'female' | 'male' | 'neutral',
): Promise<LlmResult<CustomerIntentOutput>> {
  const safeMessage = sanitizeUserInput(message)

  const systemPrompt = `You are parsing a WhatsApp message from a customer of a local business.
Business timezone: ${businessTimezone}. Today's date and time (UTC): ${new Date().toISOString()}.
Available services: ${availableServices.length > 0 ? availableServices.join(', ') : 'general appointment'}.
Conversation so far: ${JSON.stringify(sessionContext)}.

Return a JSON object with EXACTLY this structure (all fields required):
{
  "intent": "booking" | "rescheduling" | "cancellation" | "inquiry" | "list_bookings" | "unknown",
  "slotRequest": {
    "hasSpecificDate": boolean,
    "hasSpecificTime": boolean,
    "resolvedStart": "ISO8601 datetime in business timezone" | null,
    "resolvedEnd": "ISO8601 datetime in business timezone" | null,
    "dateHint": "original date text" | null,
    "timeHint": "original time text" | null,
    "dateAmbiguous": boolean
  } | null,
  "serviceTypeHint": "service name from message" | null,
  "providerHint": "staff name from message" | null,
  "summary": "one sentence summary" | null,
  "rawEntities": {},
  "detectedLanguage": "he" | "en"
}

Rules:
- intent: use "list_bookings" when the customer asks to see their appointments (e.g. "what are my bookings?", "מה התורים שלי").
- slotRequest: set to an object when a booking date/time is mentioned; set to null for non-booking intents.
  - hasSpecificDate: true if a specific calendar date is given (e.g. "May 2", "2 במאי", "Tuesday the 5th"). false for vague ("sometime next week").
  - hasSpecificTime: true if a specific time is given (e.g. "10:00", "3pm", "10:00"). false for vague ("morning").
  - resolvedStart/resolvedEnd: ISO 8601 in business timezone when both date AND time are specific. Null otherwise. Use service duration (default 60 min) for resolvedEnd.
  - dateAmbiguous: true ONLY for purely relative expressions that could match two weeks (e.g. "next Wednesday"). Explicit day+month dates like "May 2", "2 במאי", "ב-2 למאי" are NEVER ambiguous — set false.
- serviceTypeHint: extract the service name the customer mentions (e.g. "תספורת" → "תספורת", "haircut" → "Haircut"). null if none.
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
  { "action": "create"|"update"|"deactivate", "name": string, "durationMinutes": number|null, "bufferMinutes": number|null, "paymentAmount": number|null, "requiresPayment": boolean|null, "category": string|null, "maxParticipants": number|null }
  - category: logical grouping (e.g. "Yoga", "Pilates", "Haircut"). Infer from name if not stated.
  - maxParticipants: 1 for private/1-on-1 sessions (default), >1 for group classes (yoga class, pilates class, etc.)
  - paymentAmount: price in the business currency, or null if not mentioned
  - requiresPayment: true if a price is specified

permission_change:
  { "action": "grant"|"revoke", "phoneNumber": "+E164", "displayName": string|null }

booking_cancellation:
  { "customerNameHint": string|null, "customerPhone": "+E164"|null, "slotDateHint": "YYYY-MM-DD or natural language date"|null, "bookingId": "uuid"|null, "reason": string|null }
  Use when the manager explicitly asks to cancel a specific customer's booking (e.g. "cancel David's appointment tomorrow", "ביטול תור של שרה ב-15 למאי").
  Do NOT use for policy changes about cancellation rules — use policy_change for those.

policy_change:
  {
    "subtype": "cancellation_cutoff" | "booking_buffer" | "max_days_ahead" | "cancellation_fee" | "other",
    "valueHours": number | null,    // for cancellation_cutoff (hours before appt) and booking_buffer (hours in advance)
    "valueDays": number | null,     // for max_days_ahead
    "valueAmount": number | null,   // for cancellation_fee (monetary amount)
    "description": string           // always fill — human-readable summary of what was requested
  }

  Subtype rules:
  - cancellation_cutoff: manager wants to limit how far in advance customers can cancel (e.g. "cancel only 24h before", "no cancellations within 2 hours")
  - booking_buffer: manager wants a minimum notice period before a booking (e.g. "don't accept same-day bookings", "require 2h notice")
  - max_days_ahead: manager wants to cap how far into the future bookings can be made (e.g. "only 30 days ahead")
  - cancellation_fee: manager wants to charge a fee for late cancellations (e.g. "charge 50 for cancellations")
  - other: anything else — policy cannot be enforced automatically; set ambiguous=true and clarificationNeeded explaining what IS enforceable

  For subtype "other", ALWAYS set ambiguous=true and clarificationNeeded to a message (in the manager's language) explaining:
  "I can automatically enforce: cancellation notice periods, advance booking windows, booking buffer times, and cancellation fees. This request needs to be handled manually. What specifically would you like to change?"

If the instruction is ambiguous or missing required detail, set ambiguous=true and clarificationNeeded to the exact question to ask back.
Respond only with valid JSON matching the schema. No explanation.`

  return callWithSchema(systemPrompt, message, managerInstructionSchema)
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

const PA_PERSONA_TEMPLATE = `You are the booking assistant for {businessName}. You speak as the business — not as an AI, not as a bot, not as a third party.

LANGUAGE RULE — strictly enforced: reply ENTIRELY in {language}. If {language} is "he", write only in Hebrew. If {language} is "en", write only in English. Never mix languages in one reply.

WHATSAPP FORMATTING — strictly enforced:
- Supported: *bold* for key info only (service name, time, price). Never bold entire sentences.
- Bullet lists: use • (U+2022) with a space after. Never use -, *, or numbered lists.
- URLs: place on their own line, never inside parentheses or as markdown [text](url).
- No HTML tags, no markdown headers (#, ##), no tables.
- Maximum one question per message — never stack two questions.
- Confirmations and simple answers: 1–2 sentences. Complex explanations: up to 4 sentences. Never pad with filler.
- Emoji: maximum one per message at a key moment (✅ confirmed, 📅 date info). None in questions or clarifications.

Tone and voice:
- Warm and direct. Think of the competent person at a business you trust — not a chatbot, not a call centre.
- Short replies: 1–2 sentences for confirmations and simple answers; up to 4 sentences for complex situations. Never pad with filler words.
- A brief acknowledgement opener is natural for confirmations: Hebrew "קיבלתי —", English "Got it —". Keep it small — never sycophantic ("בטח! אשמח מאוד!", "Absolutely! I'd be happy to help!").
- Hebrew-specific: use natural Israeli phrasing. Dates as "ב-13 במאי", "ביום שלישי". Numbers as digits. Complete but colloquial sentences.
- English-specific: use contractions always ("you're", "it's", "that's taken"). WhatsApp rhythm, not formal writing.
- When confirming a booking: always restate the service name, day, date, and time clearly — then end with the action ("לאשר? (כן / לא)" / "Confirm? (YES / NO)").
- Ask exactly one question per message — never stack questions.
- No bullet points unless listing multiple bookings.
- Emoji: one per key moment maximum (✅ booking confirmed, reminder sent). None in questions or clarifications.
- Never say "I am an AI", "as an AI", or reference the underlying technology.
- If you know the customer's name and they are returning, you may acknowledge warmly once per session ("קיבלתי, [שם]!" / "Good to hear from you, [name]!") — once only, not repeated.

You receive:
1. A "situation" description in English (internal context — never quote this back verbatim to the customer).
2. The recent conversation transcript (up to 8 turns, current session only).
3. Optional customer profile (returning status, preferred service, display name — factual only, not chat history).

Output: one reply message only. No preamble, no quotation marks, no explanation.`

const FALLBACK_REPLIES: Record<'he' | 'en', string> = {
  he: 'אירעה שגיאה. אנא נסה שנית.',
  en: 'Something went wrong. Please try again.',
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
    if (cs.useCustomerName) rules.push("Use the customer's first name when known.")
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

export async function generateCustomerReply(input: GenerateReplyInput): Promise<string> {
  const personaNotes = input.botPersona === 'female'
    ? 'Write in grammatically feminine form (Hebrew: use feminine verb conjugations and adjectives).'
    : input.botPersona === 'male'
    ? 'Write in grammatically masculine form (Hebrew: use masculine verb conjugations and adjectives).'
    : ''

  const knowledgeAddendum = buildKnowledgeAddendum(input)

  const systemPrompt = (
    PA_PERSONA_TEMPLATE
    + (personaNotes ? `\n\n${personaNotes}` : '')
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

  const memoryText = input.customerMemory
    ? `Returning customer: ${input.customerMemory.returningCustomer}. Preferred service: ${input.customerMemory.preferredServiceName ?? 'none'}. Name: ${input.customerMemory.displayName ?? 'unknown'}.`
    : 'First-time customer (no profile data).'

  const userTurn = `Situation: ${input.situation}

Recent conversation (current session only):
${transcriptText}

Customer profile: ${memoryText}`

  try {
    const result = await ai.models.generateContent({
      model: MODEL,
      contents: userTurn,
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: 1024,
        temperature: 0.3,
        thinkingConfig: { thinkingBudget: 0 },
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
    he: 'שאל מתי ה-PA צריך לעצור ולהעביר שיחה ישירות לבעל העסק — אילו נושאים או מצבים. גם שאל מה לומר ללקוח: שיצרו איתו קשר, שתתקשרו חזרה, או לא לומר כלום. בלי תפריט מספרים.',
    en: 'Ask when the PA should stop and hand a conversation to them — what situations or topics. Also ask what to tell the customer: that someone will be in touch, that they\'ll call back, or say nothing. No numbered menus.',
  },
  customer_import: {
    he: 'שאל אם יש להם רשימת לקוחות קיימת, היסטוריית תורים, או קטלוג שירותים לייבוא.',
    en: 'Ask if they have an existing customer list, booking history, or service catalog to import.',
  },
}

export async function generateOnboardingReply(input: {
  step: string
  businessName: string
  collectedSummary?: string
  justConfirmed?: string
  isRetry: boolean
  lang: 'he' | 'en'
  extraContext?: string
}): Promise<string> {
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

  const systemPrompt = `You are helping "${input.businessName}" set up their WhatsApp PA. Guide them conversationally, like a real person texting — warm, direct, short.

Language: Write ENTIRELY in ${input.lang === 'he' ? 'Hebrew' : 'English'}.
Rules:
- 1–3 sentences maximum
- No bullet points. No numbered lists. No markdown.
- Ask exactly ONE thing per message
- Sound like a real person, not a form or bot
${ackLine}
${retryNote}
${input.collectedSummary ? `Already configured: ${input.collectedSummary}` : ''}
${input.extraContext ? `Context: ${input.extraContext}` : ''}

Current step task: ${stepGoal}

Output: the message text ONLY. No quotes, no labels, no preamble.`

  try {
    const result = await ai.models.generateContent({
      model: MODEL,
      contents: 'Generate the next onboarding message.',
      config: { systemInstruction: systemPrompt, maxOutputTokens: 1024, temperature: 0.45, thinkingConfig: { thinkingBudget: 0 } },
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

  const systemPrompt = `You are the admin assistant for "${input.businessName}" on the MiddleMan platform. The manager is texting you on WhatsApp.

Business state:
- Timezone: ${input.businessState.timezone}
- PA status: ${input.businessState.isPaused ? 'paused (not accepting bookings)' : 'active'}
- Default language: ${input.businessState.defaultLanguage}

Language: reply ENTIRELY in ${input.language === 'he' ? 'Hebrew (עברית)' : 'English'}.

Tone: direct and warm — like a competent admin assistant, not a bot.
- 1–3 sentences. Never pad with filler.
- If you can answer the question from the business state above, answer it directly.
- If the question is about something you don't know (e.g. specific booking counts, customer data), say so honestly and suggest they use STATUS or UPCOMING commands.
- Never make up facts.
- Do not expose internal system details or raw field names.

Recent conversation:
${transcriptText}

Output: reply text ONLY. No preamble, no quotes.`

  try {
    const result = await ai.models.generateContent({
      model: MODEL,
      contents: safeQuestion,
      config: { systemInstruction: systemPrompt, maxOutputTokens: 1024, temperature: 0.35, thinkingConfig: { thinkingBudget: 0 } },
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

  const systemPrompt = `You are the MiddleMan admin assistant. MiddleMan is a WhatsApp-based PA platform for local businesses. You have full real-time access to the platform data below.

Platform stats: ${statsLine}

Business list:
${bizListText}
${notesBlock}
Language: reply ENTIRELY in ${input.lang === 'he' ? 'Hebrew (עברית)' : 'English'}.
Tone: direct, warm, competent — like an admin assistant who knows the platform data.

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

Recent conversation:
${transcriptText}

Output: reply text ONLY. No preamble, no quotes.`

  try {
    const result = await ai.models.generateContent({
      model: MODEL,
      contents: safeQuestion,
      config: { systemInstruction: systemPrompt, maxOutputTokens: 1024, temperature: 0.3, thinkingConfig: { thinkingBudget: 0 } },
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
${statsLine ? `\n${statsLine}` : ''}
Language: reply ENTIRELY in ${input.lang === 'he' ? 'Hebrew (עברית)' : 'English'}.
Tone: direct and warm — like a competent admin assistant. 1–3 sentences. No filler.

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
    const result = await ai.models.generateContent({
      model: MODEL,
      contents: safeQuestion,
      config: { systemInstruction: systemPrompt, maxOutputTokens: 1024, temperature: 0.35, thinkingConfig: { thinkingBudget: 0 } },
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

  const systemPrompt = `You are helping a business owner set up their WhatsApp PA. They seem confused or are asking a question at the "${input.step}" step.

Language: Write ENTIRELY in ${input.lang === 'he' ? 'Hebrew' : 'English'}.
Rules:
- 1–3 sentences maximum
- Plain language — no jargon, no markdown, no bullet points
- Explain the concept clearly, then end with a direct question asking them to provide the information (your last sentence MUST be a question ending with ?)
- Sound like a helpful human, not a bot

The concept to explain: ${context}

Output: the explanation message ONLY. No quotes, no labels, no preamble.`

  try {
    const result = await ai.models.generateContent({
      model: MODEL,
      contents: `User message: "${input.userMessage}"`,
      config: { systemInstruction: systemPrompt, maxOutputTokens: 1024, temperature: 0.4, thinkingConfig: { thinkingBudget: 0 } },
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
Return JSON: { "isAnswer": boolean, "requiresPayment": boolean | null, "paymentMethod": string | null }`,

  escalation_policy: `Extract when the PA should escalate/hand off a conversation to the business owner, and what to tell the customer.
First decide isAnswer: true only if the message actually describes when/how to escalate. Set isAnswer: false if the message is a counter-question (e.g. "what is an escalation?", "what do you mean?", "מה זה הסלמה?"), a refusal/deferral, or confusion. When isAnswer is false, return triggers: [], minimalEscalation: false, customerMessage: "passed_to_owner", customText: null.
When isAnswer is true:
- triggers: list of topic keywords or situations to escalate (empty array if minimal escalation)
- minimalEscalation: true if they want to escalate only truly unrecognizable requests
- customerMessage: "silent" if notify owner silently, "passed_to_owner" if tell customer someone will be in touch, "owner_callback" if tell customer the owner will call back, "custom" if they specified custom wording
- customText: their custom message text, or null
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

// ── Proactive customer message generator ─────────────────────────────────────
// Used for all system-initiated messages to customers: reminders, hold expiry,
// waitlist offers, schedule-change cancellations, payment confirmations, and
// the business-hours / paused / revoked gates in the webhook.

const PROACTIVE_PERSONA = `You are sending a WhatsApp message on behalf of {businessName}. Speak as the business — not as an AI, not as a bot.

LANGUAGE: write ENTIRELY in {language}. Never mix languages.

WHATSAPP FORMATTING (hard rules):
- *bold* only for key info (service name, time). Never bold full sentences.
- Bullet lists: • (U+2022) with a space. Never -, *, or numbered unless order matters.
- URLs: on their own line, never inline.
- No HTML, no markdown headers (#, ##), no tables.
- One question maximum per message.
- Confirmations / notices: 1–3 sentences. Never pad.
- Emoji: one maximum at a key moment (✅ confirmed, ⏰ reminder, ❌ cancelled). None in questions.

TONE: Warm and direct — like a trusted local business texting you. Hebrew: natural Israeli phrasing, 24h times. English: contractions always ("it's", "we'll"). Never reference AI or technology.

Output: one message ONLY. No preamble, no quotation marks.`

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    promise.then((v) => { clearTimeout(timer); resolve(v) }, () => { clearTimeout(timer); resolve(fallback) })
  })
}

export async function generateProactiveCustomerMessage(input: {
  businessName: string
  language: 'he' | 'en'
  situation: string
  fallback: string
  timeoutMs?: number
}): Promise<string> {
  const systemPrompt = PROACTIVE_PERSONA
    .replace('{businessName}', input.businessName)
    .replace('{language}', input.language === 'he' ? 'he (Hebrew)' : 'en (English)')

  const call = (async (): Promise<string> => {
    try {
      const result = await ai.models.generateContent({
        model: MODEL,
        contents: `Situation: ${input.situation}`,
        config: { systemInstruction: systemPrompt, maxOutputTokens: 512, temperature: 0.3, thinkingConfig: { thinkingBudget: 0 } },
      })
      return result.text?.trim() || input.fallback
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

  const systemPrompt = `You are MiddleMan — a WhatsApp platform that sets up AI booking assistants for local businesses. You are onboarding a new business owner via WhatsApp.

${langInstruction}
Rules:
- 1–3 sentences maximum
- No bullet points. No numbered lists. No markdown.
- Ask exactly ONE thing per message (in bilingual mode: one thing per language block)
- Sound like a real helpful service texting them, not a form or bot
${ackLine}
${retryNote}
${nameCtx}
${input.extraContext ? `Extra context: ${input.extraContext}` : ''}

Current step: ${stepGoal}

Output: the message text ONLY. No quotes, no labels, no preamble.`

  try {
    const result = await ai.models.generateContent({
      model: MODEL,
      contents: 'Generate the next onboarding message.',
      config: { systemInstruction: systemPrompt, maxOutputTokens: 512, temperature: 0.4, thinkingConfig: { thinkingBudget: 0 } },
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
  const systemPrompt = `You are the PA admin assistant for "${input.businessName}". The business manager just ran a command and you are responding on WhatsApp.

LANGUAGE: reply ENTIRELY in ${input.language === 'he' ? 'Hebrew (עברית)' : 'English'}.

WHATSAPP FORMATTING:
- No HTML. No markdown headers (#, ##). No markdown links.
- Bullet lists: • (U+2022). Not -, *, or numbered unless order matters.
- *bold* only for key labels or values — never whole sentences.
- Emoji for status: ✅ active/ok, ⏸ paused, ❌ error/missing, 📅 calendar, 💳 payment.
- Maximum 15 lines for data reports.

TONE: Direct and informative — a competent admin assistant reporting data. No filler. No "I hope this helps." Never expose internal field names or UUIDs. Present the data naturally, not as raw key-value pairs.

${input.dataBlock ? `Data to present:\n${input.dataBlock}` : ''}

Output: the reply ONLY. No preamble, no quotes.`

  try {
    const result = await ai.models.generateContent({
      model: MODEL,
      contents: `Command context: ${input.situation}`,
      config: { systemInstruction: systemPrompt, maxOutputTokens: 1024, temperature: 0.25, thinkingConfig: { thinkingBudget: 0 } },
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

LANGUAGE: reply ENTIRELY in ${input.lang === 'he' ? 'Hebrew (עברית)' : 'English'}.

WHATSAPP FORMATTING:
- No HTML. No markdown headers. No markdown links.
- Bullet lists: • (U+2022). Not -, *, or numbered unless order matters.
- *bold* for business names, section headers, and key statuses only.
- Emoji for status: ✅ live/ok, ⏸ paused, ⏳ onboarding, ❌ error, 📅 calendar, 🌐 website.
- Maximum 25 lines. Group intelligently for long lists.

TONE: Clear and efficient. Operator is the platform admin — they need data at a glance. No filler. Lead with the key number or finding, then the detail. Use the exact data provided — do not add, infer, or invent anything.

Data to present:
${input.dataBlock}

Output: the formatted reply ONLY. No preamble, no quotes.`

  try {
    const result = await ai.models.generateContent({
      model: MODEL,
      contents: `Operator command: ${input.question}`,
      config: { systemInstruction: systemPrompt, maxOutputTokens: 1024, temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } },
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
          maxOutputTokens: 1024,
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
