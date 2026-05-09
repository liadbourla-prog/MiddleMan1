import { Worker, Queue } from 'bullmq'
import { eq, and, desc, gte } from 'drizzle-orm'
import { GoogleGenAI } from '@google/genai'
import { db } from '../db/client.js'
import { conversationSessions, conversationMessages, identities, businesses, managerMemory } from '../db/schema.js'
import { redisConnection } from '../redis.js'

const QUEUE_NAME = 'generate-manager-summary'
const MODEL = 'gemini-2.5-flash'

const ai = new GoogleGenAI({ apiKey: process.env['LLM_API_KEY'] ?? '', apiVersion: 'v1beta' })

export interface ManagerSummaryJob {
  sessionId: string
  businessId: string
  identityId: string
  periodStart: string
  periodEnd: string
}

export const managerSummaryQueue = new Queue<ManagerSummaryJob>(QUEUE_NAME, { connection: redisConnection })

export async function enqueueManagerSummary(
  sessionId: string,
  businessId: string,
  identityId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<void> {
  await managerSummaryQueue.add(
    'summarize',
    { sessionId, businessId, identityId, periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString() },
    { attempts: 2, backoff: { type: 'fixed', delay: 10_000 }, jobId: `summary-${sessionId}` },
  )
}

async function processJob(job: { data: ManagerSummaryJob }): Promise<void> {
  const { sessionId, businessId, identityId, periodStart, periodEnd } = job.data

  // Load transcript
  const messages = await db
    .select({ role: conversationMessages.role, text: conversationMessages.text, createdAt: conversationMessages.createdAt })
    .from(conversationMessages)
    .where(eq(conversationMessages.sessionId, sessionId))
    .orderBy(conversationMessages.createdAt)
    .limit(100)

  if (messages.length < 2) return // Too short to summarize

  const [biz] = await db
    .select({ name: businesses.name, defaultLanguage: businesses.defaultLanguage })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)

  if (!biz) return

  const lang = (biz.defaultLanguage as 'he' | 'en' | null | undefined) ?? 'he'

  const transcript = messages
    .map((m) => `${m.role === 'customer' ? 'Manager' : 'Assistant'}: ${m.text}`)
    .join('\n')

  const systemPrompt = `You are summarizing a WhatsApp conversation between a business manager and their PA assistant for "${biz.name}".

Write a 2–3 sentence summary in ${lang === 'he' ? 'Hebrew' : 'English'} covering:
- Key decisions or changes made (availability, services, policies)
- Important preferences the manager expressed
- Any pending items or follow-ups mentioned

Be specific and factual. Do not include pleasantries or filler. Output the summary only.`

  try {
    const result = await ai.models.generateContent({
      model: MODEL,
      contents: `Conversation transcript:\n\n${transcript}`,
      config: { systemInstruction: systemPrompt, maxOutputTokens: 512, temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } },
    })

    const summary = result.text?.trim()
    if (!summary) return

    await db.insert(managerMemory).values({
      businessId,
      identityId,
      periodStart: new Date(periodStart),
      periodEnd: new Date(periodEnd),
      summary,
    })

    // Prune old summaries — keep last 30 days per identity
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60_000)
    const old = await db
      .select({ id: managerMemory.id })
      .from(managerMemory)
      .where(and(eq(managerMemory.identityId, identityId), and()))
      .orderBy(desc(managerMemory.createdAt))

    // Delete anything beyond 30 entries or older than 30 days
    const toDelete = old.filter((_, i) => i >= 30)
    for (const row of toDelete) {
      await db.delete(managerMemory).where(eq(managerMemory.id, row.id))
    }
    await db.delete(managerMemory)
      .where(and(eq(managerMemory.identityId, identityId), and(eq(managerMemory.createdAt, cutoff))))

    console.info(JSON.stringify({ event: 'manager_summary.generated', businessId, identityId, sessionId, summaryLength: summary.length }))
  } catch (err) {
    console.error('[generate-manager-summary] LLM failed', { sessionId, err: err instanceof Error ? err.message : String(err) })
    throw err
  }
}

export function startManagerSummaryWorker() {
  const worker = new Worker<ManagerSummaryJob>(
    QUEUE_NAME,
    async (job) => processJob(job),
    { connection: redisConnection, concurrency: 3 },
  )

  worker.on('failed', (job, err) => {
    console.error('[generate-manager-summary] Job failed', { jobId: job?.id, err: err.message })
  })

  return worker
}
