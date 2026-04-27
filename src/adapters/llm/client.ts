import { VertexAI } from '@google-cloud/vertexai'
import { z } from 'zod'
import type { CustomerIntentOutput, ManagerInstructionOutput, LlmResult, GenerateReplyInput } from './types.js'

const PROJECT_ID = process.env['GOOGLE_CLOUD_PROJECT']
if (!PROJECT_ID) throw new Error('GOOGLE_CLOUD_PROJECT is required')

const LOCATION = process.env['VERTEX_AI_LOCATION'] ?? 'us-central1'
const MODEL = 'gemini-2.0-flash'

const vertexai = new VertexAI({ project: PROJECT_ID, location: LOCATION })

// Extraction model — deterministic structured output
const generativeModel = vertexai.getGenerativeModel({
  model: MODEL,
  generationConfig: {
    responseMimeType: 'application/json',
    maxOutputTokens: 512,
    temperature: 0,
  },
})

// Reply model — free-text conversational output
const replyModel = vertexai.getGenerativeModel({
  model: MODEL,
  generationConfig: {
    maxOutputTokens: 1024,
    temperature: 0.3,
  },
})

const customerIntentSchema = z.object({
  intent: z.enum(['booking', 'rescheduling', 'cancellation', 'inquiry', 'list_bookings', 'unknown']),
  slotRequest: z
    .object({
      hasSpecificDate: z.boolean(),
      hasSpecificTime: z.boolean(),
      resolvedStart: z.string().nullable(),
      resolvedEnd: z.string().nullable(),
      dateHint: z.string().nullable(),
      timeHint: z.string().nullable(),
      dateAmbiguous: z.boolean().default(false),
    })
    .nullable(),
  serviceTypeHint: z.string().nullable(),
  // Name of a specific staff member / instructor the customer requested
  providerHint: z.string().nullable().catch(null),
  summary: z.string().nullable(),
  rawEntities: z.record(z.string()),
  detectedLanguage: z.enum(['he', 'en']),
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

Extract the customer's intent. Rules:
- intent: "booking" | "rescheduling" | "cancellation" | "inquiry" | "list_bookings" | "unknown".
  - Use "list_bookings" when the customer asks to see their appointments (e.g. "what are my bookings?", "show my appointments", "מה התורים שלי").
- If they want to book and give a specific date AND time, set resolvedStart/resolvedEnd as ISO 8601 in the business timezone, using the service duration from context if available, otherwise 60 minutes.
- If date or time is vague (e.g. "sometime next week", "morning"), set hasSpecificDate/hasSpecificTime to false and resolvedStart/resolvedEnd to null.
- dateAmbiguous: true if the date expression is relative and could refer to two different calendar dates (e.g. "next Wednesday" could mean this coming Wednesday or the one after). Set resolvedStart to the nearest candidate when ambiguous.
- providerHint: if the customer names a specific staff member or instructor (e.g. "with Daniel", "by Efrat"), extract that name. Otherwise null.
- summary: one short sentence confirming what you understood (e.g. "Haircut with Daniel on Tuesday 3 May at 3:00 PM"), or null if unclear.
- detectedLanguage: "he" if the message is in Hebrew, "en" for English or any other language.
- Respond only with valid JSON. No explanation.`

  return callWithSchema(systemPrompt, safeMessage, customerIntentSchema) as Promise<LlmResult<CustomerIntentOutput>>
}

export async function classifyManagerInstruction(
  message: string,
  businessContext: Record<string, unknown>,
): Promise<LlmResult<ManagerInstructionOutput>> {
  const systemPrompt = `You are parsing a WhatsApp message from a business manager giving operational instructions.
Business context: ${JSON.stringify(businessContext)}.

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
    const result = await replyModel.generateContent({
      systemInstruction: systemPrompt,
      contents: [{ role: 'user' as const, parts: [{ text: userTurn }] }],
    })

    const text = result.response.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
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
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await generativeModel.generateContent({
        systemInstruction: systemPrompt,
        contents: [{ role: 'user' as const, parts: [{ text: userMessage }] }],
      })

      const text = result.response.candidates?.[0]?.content?.parts?.[0]?.text
      if (!text) continue

      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        continue
      }

      const validation = schema.safeParse(parsed)
      if (validation.success) return { ok: true, data: validation.data }
    } catch (err) {
      if (isQuotaError(err)) {
        return { ok: false, error: 'quota_exceeded' }
      }
      if (attempt === 1) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  }

  return { ok: false, error: 'LLM returned invalid structured output after 2 attempts' }
}
