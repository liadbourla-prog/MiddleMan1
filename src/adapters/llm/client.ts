import { GoogleGenAI } from '@google/genai'
import { z } from 'zod'
import type { CustomerIntentOutput, ManagerInstructionOutput, LlmResult, GenerateReplyInput } from './types.js'

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
  { "description": string }

If the instruction is ambiguous or missing required detail, set ambiguous=true and clarificationNeeded to the exact question to ask back.
Respond only with valid JSON matching the schema. No explanation.`

  return callWithSchema(systemPrompt, message, managerInstructionSchema)
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

export async function generateCustomerReply(input: GenerateReplyInput): Promise<string> {
  const personaNotes = input.botPersona === 'female'
    ? 'Write in grammatically feminine form (Hebrew: use feminine verb conjugations and adjectives).'
    : input.botPersona === 'male'
    ? 'Write in grammatically masculine form (Hebrew: use masculine verb conjugations and adjectives).'
    : ''

  const systemPrompt = (PA_PERSONA_TEMPLATE + (personaNotes ? `\n\n${personaNotes}` : ''))
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
