import { Worker, Queue } from 'bullmq'
import { and, eq, lt, or } from 'drizzle-orm'
import { db } from '../db/client.js'
import { conversationSessions, identities } from '../db/schema.js'
import { expireOldSessions } from '../domain/session/manager.js'
import { enqueueManagerSummary } from './generate-manager-summary.js'
import { enqueueCustomerSummary } from './generate-customer-summary.js'
import { redisConnection } from '../redis.js'

const QUEUE_NAME = 'session-expiry'
const REPEAT_EVERY_MS = 5 * 60_000 // every 5 minutes

export const sessionExpiryQueue = new Queue(QUEUE_NAME, { connection: redisConnection })

export function startSessionExpiryWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      // Find manager sessions that are about to expire — enqueue summaries before sweeping
      const now = new Date()
      const expiringSessions = await db
        .select({
          id: conversationSessions.id,
          businessId: conversationSessions.businessId,
          identityId: conversationSessions.identityId,
          createdAt: conversationSessions.createdAt,
          lastMessageAt: conversationSessions.lastMessageAt,
          role: identities.role,
        })
        .from(conversationSessions)
        .innerJoin(identities, eq(identities.id, conversationSessions.identityId))
        .where(
          and(
            lt(conversationSessions.expiresAt, now),
            or(
              eq(conversationSessions.state, 'active'),
              eq(conversationSessions.state, 'waiting_confirmation'),
              eq(conversationSessions.state, 'waiting_clarification'),
            ),
            or(eq(identities.role, 'manager'), eq(identities.role, 'customer')),
          ),
        )

      // Summarize each expiring session for cross-session memory before sweeping.
      // (Terminal customer sessions already summarized at completion; those are
      // 'completed' and not in the active/waiting set, so no double-summary.)
      for (const session of expiringSessions) {
        const enqueue = session.role === 'customer'
          ? enqueueCustomerSummary(session.id, session.businessId, session.identityId)
          : enqueueManagerSummary(session.id, session.businessId, session.identityId, session.createdAt, session.lastMessageAt)
        await enqueue.catch((err) => console.warn('[session-expiry] Failed to enqueue summary', { sessionId: session.id, err }))
      }

      const count = await expireOldSessions(db)
      if (count > 0) {
        console.info(`[session-expiry] Expired ${count} stale session(s), enqueued ${expiringSessions.length} summary job(s)`)
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
