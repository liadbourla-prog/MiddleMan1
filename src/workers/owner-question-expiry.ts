import { Worker, Queue } from 'bullmq'
import { db } from '../db/client.js'
import { redisConnection } from '../redis.js'
import { expireStaleOwnerQuestions } from '../domain/escalation/engine.js'

// F3a/S3 — sweep pending owner questions the owner never answered to 'expired' so they don't
// dangle forever. The customer was only told "they'll get back to you", so no customer message
// is needed on expiry.
const QUEUE_NAME = 'owner-question-expiry'
const REPEAT_EVERY_MS = 60 * 60_000 // hourly
const EXPIRY_HOURS = parseInt(process.env['OWNER_QUESTION_EXPIRY_HOURS'] ?? '72', 10)

export const ownerQuestionExpiryQueue = new Queue(QUEUE_NAME, { connection: redisConnection })

async function processTick(): Promise<void> {
  const olderThan = new Date(Date.now() - EXPIRY_HOURS * 60 * 60_000)
  const n = await expireStaleOwnerQuestions(db, olderThan)
  if (n > 0) console.log(`[owner-question-expiry] expired ${n} stale question(s)`)
}

export function startOwnerQuestionExpiryWorker() {
  const worker = new Worker(QUEUE_NAME, async () => processTick(), { connection: redisConnection })
  worker.on('failed', (job, err) => {
    console.error('[owner-question-expiry] Job failed', { jobId: job?.id, err: err.message })
  })
  ownerQuestionExpiryQueue
    .add('tick', {}, { repeat: { every: REPEAT_EVERY_MS }, jobId: 'owner-question-expiry-tick' })
    .catch((err) => console.error('[owner-question-expiry] Failed to schedule job', err))
  return worker
}
