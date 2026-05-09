import { Worker, Queue } from 'bullmq'
import { eq, asc } from 'drizzle-orm'
import { GoogleGenAI } from '@google/genai'
import { db } from '../db/client.js'
import { operatorSessionNotes } from '../db/schema.js'
import { redisConnection } from '../redis.js'

const QUEUE_NAME = 'generate-operator-summary'
const MODEL = 'gemini-2.5-flash'

const ai = new GoogleGenAI({ apiKey: process.env['LLM_API_KEY'] ?? '', apiVersion: 'v1beta' })

export interface OperatorSummaryJob {
  transcript: Array<{ role: 'operator' | 'assistant'; text: string; ts: number }>
  periodStart: string
  periodEnd: string
}

export const operatorSummaryQueue = new Queue<OperatorSummaryJob>(QUEUE_NAME, { connection: redisConnection })

export async function enqueueOperatorSummary(
  transcript: Array<{ role: 'operator' | 'assistant'; text: string; ts: number }>,
  periodStart: Date,
  periodEnd: Date,
): Promise<void> {
  if (transcript.length < 2) return
  const jobId = `operator-summary-${periodStart.getTime()}`
  await operatorSummaryQueue.add(
    'summarize',
    { transcript, periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString() },
    { attempts: 2, backoff: { type: 'fixed', delay: 10_000 }, jobId },
  )
}

async function processJob(job: { data: OperatorSummaryJob }): Promise<void> {
  const { transcript, periodStart, periodEnd } = job.data

  if (transcript.length < 2) return

  const transcriptText = transcript
    .map((t) => `${t.role === 'operator' ? 'Operator' : 'Assistant'}: ${t.text}`)
    .join('\n')

  const systemPrompt = `You are summarizing a WhatsApp conversation between the MiddleMan platform operator (the platform owner/admin) and the MiddleMan admin assistant.

Write a 2–3 sentence summary in English covering:
- Key questions the operator asked and answers given
- Business changes or actions the operator requested
- Any pending issues or follow-up items mentioned

Be specific and factual. Do not include pleasantries or filler. Output the summary only.`

  try {
    const result = await ai.models.generateContent({
      model: MODEL,
      contents: `Conversation transcript:\n\n${transcriptText}`,
      config: { systemInstruction: systemPrompt, maxOutputTokens: 512, temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } },
    })

    const summary = result.text?.trim()
    if (!summary) return

    await db.insert(operatorSessionNotes).values({
      summary,
      periodStart: new Date(periodStart),
      periodEnd: new Date(periodEnd),
    })

    // Prune old notes — keep last 20
    const all = await db
      .select({ id: operatorSessionNotes.id })
      .from(operatorSessionNotes)
      .orderBy(asc(operatorSessionNotes.createdAt))

    if (all.length > 20) {
      const toDelete = all.slice(0, all.length - 20)
      for (const row of toDelete) {
        await db.delete(operatorSessionNotes).where(eq(operatorSessionNotes.id, row.id))
      }
    }

    console.info(JSON.stringify({ event: 'operator_summary.generated', summaryLength: summary.length }))
  } catch (err) {
    console.error('[generate-operator-summary] LLM failed', { err: err instanceof Error ? err.message : String(err) })
    throw err
  }
}

export function startOperatorSummaryWorker() {
  const worker = new Worker<OperatorSummaryJob>(
    QUEUE_NAME,
    async (job) => processJob(job),
    { connection: redisConnection, concurrency: 1 },
  )

  worker.on('failed', (job, err) => {
    console.error('[generate-operator-summary] Job failed', { jobId: job?.id, err: err.message })
  })

  return worker
}
