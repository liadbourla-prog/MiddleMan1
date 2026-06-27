import { Worker, Queue } from 'bullmq'
import { eq } from 'drizzle-orm'
import { sendMessage } from '../adapters/whatsapp/sender.js'
import { db } from '../db/client.js'
import { bookings, businesses } from '../db/schema.js'
import { redisConnection } from '../redis.js'

const QUEUE_NAME = 'message-retry'
const MAX_ATTEMPTS = 3

interface MessageJob {
  businessId: string
  toNumber: string
  body: string
  bookingId?: string
  useGlobalCredentials?: boolean
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

export async function enqueueMessage(
  businessId: string,
  toNumber: string,
  body: string,
  opts?: { bookingId?: string; useGlobalCredentials?: boolean },
) {
  await messageRetryQueue.add('send', {
    businessId,
    toNumber,
    body,
    ...(opts?.bookingId ? { bookingId: opts.bookingId } : {}),
    ...(opts?.useGlobalCredentials ? { useGlobalCredentials: true } : {}),
  })
}

// Exported for unit testing: resolve the recipient + per-business WhatsApp credentials.
export async function buildSendArgs(
  data: Pick<MessageJob, 'businessId' | 'toNumber' | 'body'> & { useGlobalCredentials?: boolean },
) {
  if (data.useGlobalCredentials) {
    // Operator-audience messages must use the global/provider WABA (env creds),
    // not a per-business WABA — the operator's 24h window is with the platform number.
    return { toNumber: data.toNumber, body: data.body, credentials: undefined }
  }

  const [biz] = await db
    .select({ phoneNumberId: businesses.whatsappPhoneNumberId, accessToken: businesses.whatsappAccessToken })
    .from(businesses)
    .where(eq(businesses.id, data.businessId))
    .limit(1)
  const credentials = biz?.phoneNumberId && biz?.accessToken
    ? { accessToken: biz.accessToken, phoneNumberId: biz.phoneNumberId }
    : undefined
  if (!credentials) {
    console.warn('[message-retry] no per-business WA credentials; falling back to env', { businessId: data.businessId })
  }
  return { toNumber: data.toNumber, body: data.body, credentials }
}

export function startMessageRetryWorker() {
  const worker = new Worker<MessageJob>(
    QUEUE_NAME,
    async (job) => {
      if (job.data.bookingId) {
        const [booking] = await db
          .select({ state: bookings.state })
          .from(bookings)
          .where(eq(bookings.id, job.data.bookingId))
          .limit(1)
        const skipStates = new Set(['cancelled', 'expired', 'failed'])
        if (booking && skipStates.has(booking.state)) return
      }

      const { toNumber, body, credentials } = await buildSendArgs(job.data)
      const result = await sendMessage({ toNumber, body }, credentials)
      if (!result.ok) throw new Error(result.error)
    },
    { connection: redisConnection },
  )

  worker.on('failed', (job, err) => {
    if (job && job.attemptsMade >= MAX_ATTEMPTS) {
      console.error('[message-retry] Message permanently failed after retries', {
        businessId: job.data.businessId,
        toNumber: job.data.toNumber,
        err: err.message,
      })
    }
  })

  return worker
}
