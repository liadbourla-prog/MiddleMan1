import { Worker, Queue } from 'bullmq'
import { eq } from 'drizzle-orm'
import { sendMessage } from '../adapters/whatsapp/sender.js'
import { db } from '../db/client.js'
import { bookings } from '../db/schema.js'
import { redisConnection } from '../redis.js'

const QUEUE_NAME = 'message-retry'
const MAX_ATTEMPTS = 3

interface MessageJob {
  toNumber: string
  body: string
  bookingId?: string // if set, skip send if booking is cancelled/expired/failed
}

export const messageRetryQueue = new Queue<MessageJob>(QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: MAX_ATTEMPTS,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
})

export async function enqueueMessage(toNumber: string, body: string, bookingId?: string) {
  await messageRetryQueue.add('send', {
    toNumber,
    body,
    ...(bookingId ? { bookingId } : {}),
  })
}

export function startMessageRetryWorker() {
  const worker = new Worker<MessageJob>(
    QUEUE_NAME,
    async (job) => {
      // Reminder guard: skip if booking is in a terminal inactive state
      if (job.data.bookingId) {
        const [booking] = await db
          .select({ state: bookings.state })
          .from(bookings)
          .where(eq(bookings.id, job.data.bookingId))
          .limit(1)

        const skipStates = new Set(['cancelled', 'expired', 'failed'])
        if (booking && skipStates.has(booking.state)) return
      }

      const result = await sendMessage({ toNumber: job.data.toNumber, body: job.data.body })
      if (!result.ok) {
        throw new Error(result.error)
      }
    },
    { connection: redisConnection },
  )

  worker.on('failed', (job, err) => {
    if (job && job.attemptsMade >= MAX_ATTEMPTS) {
      console.error('[message-retry] Message permanently failed after retries', {
        toNumber: job.data.toNumber,
        err: err.message,
      })
    }
  })

  return worker
}
