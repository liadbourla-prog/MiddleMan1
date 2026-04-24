import { Worker, Queue } from 'bullmq'
import { db } from '../db/client.js'
import { expireOldSessions } from '../domain/session/manager.js'
import { redisConnection } from '../redis.js'

const QUEUE_NAME = 'session-expiry'
const REPEAT_EVERY_MS = 5 * 60_000 // every 5 minutes

export const sessionExpiryQueue = new Queue(QUEUE_NAME, { connection: redisConnection })

export function startSessionExpiryWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      const count = await expireOldSessions(db)
      if (count > 0) {
        console.info(`[session-expiry] Expired ${count} stale session(s)`)
      }
    },
    { connection: redisConnection },
  )

  worker.on('failed', (job, err) => {
    console.error('[session-expiry] Job failed', { jobId: job?.id, err })
  })

  sessionExpiryQueue
    .add('tick', {}, { repeat: { every: REPEAT_EVERY_MS }, jobId: 'session-expiry-tick' })
    .catch((err) => console.error('[session-expiry] Failed to schedule job', err))

  return worker
}
