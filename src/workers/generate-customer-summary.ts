import { Worker, Queue } from 'bullmq'
import { eq, and, desc, lt } from 'drizzle-orm'
import { GoogleGenAI } from '@google/genai'
import { db } from '../db/client.js'
import { conversationMessages, businesses, customerSessionNotes } from '../db/schema.js'
import { redisConnection } from '../redis.js'

const QUEUE_NAME = 'generate-customer-summary'
const MODEL = 'gemini-2.5-flash'
const KEEP_NEWEST = 10
const MAX_AGE_DAYS = 180

const ai = new GoogleGenAI({ apiKey: process.env['LLM_API_KEY'] ?? '', apiVersion: 'v1beta' })

export interface CustomerSummaryJob {
  sessionId: string
  businessId: string
  identityId: string
}

export const customerSummaryQueue = new Queue<CustomerSummaryJob>(QUEUE_NAME, { connection: redisConnection })

// Best-effort: enqueue a conversation-summary job when a customer session ends
// (a terminal action or an idle expiry). De-duped per session via jobId so the
// terminal-complete and expiry paths can't both summarize the same session twice.
export async function enqueueCustomerSummary(
  sessionId: string,
  businessId: string,
  identityId: string,
): Promise<void> {
  await customerSummaryQueue.add(
    'summarize',
    { sessionId, businessId, identityId },
    { attempts: 2, backoff: { type: 'fixed', delay: 10_000 }, jobId: `customer-summary-${sessionId}` },
  )
}

async function processJob(job: { data: CustomerSummaryJob }): Promise<void> {
  const { sessionId, businessId, identityId } = job.data

  const messages = await db
    .select({ role: conversationMessages.role, text: conversationMessages.text, createdAt: conversationMessages.createdAt })
    .from(conversationMessages)
    .where(eq(conversationMessages.sessionId, sessionId))
    .orderBy(conversationMessages.createdAt)
    .limit(100)

  if (messages.length < 2) return // too short to be worth remembering

  const [biz] = await db
    .select({ name: businesses.name, defaultLanguage: businesses.defaultLanguage })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)
  if (!biz) return

  const lang = (biz.defaultLanguage as 'he' | 'en' | null | undefined) ?? 'he'

  const transcript = messages
    .map((m) => `${m.role === 'customer' ? 'Customer' : 'Assistant'}: ${m.text}`)
    .join('\n')

  const periodStart = messages[0]!.createdAt
  const periodEnd = messages[messages.length - 1]!.createdAt

  const systemPrompt = `You are writing a private memory note for the assistant of "${biz.name}", a local business that books appointments over WhatsApp. This note will be re-read at the start of this customer's NEXT conversation so the assistant can greet them like a regular it remembers — not a database.

Write a 1–2 sentence note in ${lang === 'he' ? 'Hebrew' : 'English'} capturing only what's worth remembering for next time:
- What they were interested in or asked about (a service, a day/time preference, a question they had)
- Anything personal or contextual they shared (a preference, a constraint, an occasion)
- Anything left open (wanted to book later, was checking for a friend, asked you to follow up)

Do NOT restate confirmed bookings (those are tracked separately). If nothing meaningful happened (e.g. a one-line confirmation), output the single word: NONE. Output the note only, no preamble.`

  try {
    const result = await ai.models.generateContent({
      model: MODEL,
      contents: `Conversation transcript:\n\n${transcript}`,
      config: { systemInstruction: systemPrompt, maxOutputTokens: 512, temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } },
    })

    const summary = result.text?.trim()
    if (!summary || summary.toUpperCase() === 'NONE') return

    await db.insert(customerSessionNotes).values({ businessId, identityId, periodStart, periodEnd, summary })

    // Prune: keep the newest KEEP_NEWEST per customer, and drop anything older
    // than MAX_AGE_DAYS — bounded, recency-biased memory.
    const existing = await db
      .select({ id: customerSessionNotes.id })
      .from(customerSessionNotes)
      .where(eq(customerSessionNotes.identityId, identityId))
      .orderBy(desc(customerSessionNotes.createdAt))
    for (const row of existing.filter((_, i) => i >= KEEP_NEWEST)) {
      await db.delete(customerSessionNotes).where(eq(customerSessionNotes.id, row.id))
    }
    const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60_000)
    await db.delete(customerSessionNotes)
      .where(and(eq(customerSessionNotes.identityId, identityId), lt(customerSessionNotes.createdAt, cutoff)))

    console.info(JSON.stringify({ event: 'customer_summary.generated', businessId, identityId, sessionId, summaryLength: summary.length }))
  } catch (err) {
    console.error('[generate-customer-summary] LLM failed', { sessionId, err: err instanceof Error ? err.message : String(err) })
    throw err
  }
}

export function startCustomerSummaryWorker() {
  const worker = new Worker<CustomerSummaryJob>(
    QUEUE_NAME,
    async (job) => processJob(job),
    { connection: redisConnection, concurrency: 3 },
  )

  worker.on('failed', (job, err) => {
    console.error('[generate-customer-summary] Job failed', { jobId: job?.id, err: err.message })
  })

  return worker
}
