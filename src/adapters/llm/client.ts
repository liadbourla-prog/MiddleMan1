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
    he: 'שאל כמה שעות לפני תור לקוחות יכולים לבטל. אם אין הגבלה — יכולים לומר "ללא הגבלה" או "0".',
    en: 'Ask how many hours before an appointment customers can cancel. They can say "no restriction" for unrestricted.',
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
      config: { systemInstruction: systemPrompt, maxOutputTokens: 200, temperature: 0.45 },
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
      config: { systemInstruction: systemPrompt, maxOutputTokens: 400, temperature: 0.35 },
    })
    const text = result.text?.trim()
    if (text) return text
  } catch {
    // fall through to empty — caller uses i18n fallback
  }
  return ''
}

// ── Operator: conversational reply ───────────────────────────────────────────

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

Available commands the operator can use (mention only if directly relevant):
- STATUS / STATUS [business name] — business status
- ESCALATIONS — open escalations
- UPDATE ALL: [instruction] — push change to all businesses
- FEATURES — deferred feature requests
- RETRIGGER [business] [skill] — restart a skill workflow

Recent conversation:
${transcriptText}

Output: reply text ONLY. No preamble, no quotes.`

  try {
    const result = await ai.models.generateContent({
      model: MODEL,
      contents: safeQuestion,
      config: { systemInstruction: systemPrompt, maxOutputTokens: 300, temperature: 0.35 },
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
  credentials: "Two values from Meta (WhatsApp Business API): a Phone Number ID (a long number) and an Access Token (starts with EAA). Both are found in the Meta Business Suite under the WhatsApp section.",
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
- 2–4 sentences maximum
- Plain language — no jargon, no markdown, no bullet points
- Explain the concept clearly, then end with a gentle re-ask of what you need from them
- Sound like a helpful human, not a bot

The concept to explain: ${context}

Output: the explanation message ONLY. No quotes, no labels, no preamble.`

  try {
    const result = await ai.models.generateContent({
      model: MODEL,
      contents: `User message: "${input.userMessage}"`,
      config: { systemInstruction: systemPrompt, maxOutputTokens: 300, temperature: 0.4 },
    })
    const text = result.text?.trim()
    if (text) return text
  } catch {
    // fall through — caller uses static fallback
  }
  return ''
}

// ── Onboarding: structured answer parser ─────────────────────────────────────

const cancellationSchema = z.object({ hours: z.number().int().min(0) })
const paymentSchema = z.object({
  requiresPayment: z.boolean(),
  paymentMethod: z.string().nullable(),
})
const escalationSchema = z.object({
  triggers: z.array(z.string()),
  minimalEscalation: z.boolean(),
  customerMessage: z.enum(['silent', 'passed_to_owner', 'owner_callback', 'custom']),
  customText: z.string().nullable(),
})

const PARSE_PROMPTS: Record<ParseableOnboardingStep, string> = {
  cancellation_policy: `Extract how many hours before an appointment the customer wants to allow cancellations.
If they say "any time", "no restriction", "ללא הגבלה", "כל עת", "0", "whenever", etc. → hours: 0.
If they mention days (e.g. "two days") convert to hours (48).
Return JSON: { "hours": number }`,

  payment: `Extract whether customers must pay before their booking is confirmed, and if so what payment method.
If they say "yes", "כן", "תשלום מראש", "pay first" etc. → requiresPayment: true.
If they say "no", "לא", "immediately", "מיידי" etc. → requiresPayment: false, paymentMethod: null.
Extract the payment method if mentioned (e.g. "Bit", "PayPal", "bank transfer", "ביט", "כרטיס אשראי").
Return JSON: { "requiresPayment": boolean, "paymentMethod": string | null }`,

  escalation_policy: `Extract when the PA should escalate/hand off a conversation to the business owner, and what to tell the customer.
- triggers: list of topic keywords or situations to escalate (empty array if minimal escalation)
- minimalEscalation: true if they want to escalate only truly unrecognizable requests
- customerMessage: "silent" if notify owner silently, "passed_to_owner" if tell customer someone will be in touch, "owner_callback" if tell customer the owner will call back, "custom" if they specified custom wording
- customText: their custom message text, or null
Return JSON: { "triggers": string[], "minimalEscalation": boolean, "customerMessage": "silent"|"passed_to_owner"|"owner_callback"|"custom", "customText": string|null }`,
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
