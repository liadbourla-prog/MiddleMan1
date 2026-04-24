import { Worker, Queue } from 'bullmq'
import { eq, and, lt, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { bookings, businesses, identities } from '../db/schema.js'
import { createCalendarClient } from '../adapters/calendar/client.js'
import { logAudit } from '../domain/audit/logger.js'
import { redisConnection } from '../redis.js'

const QUEUE_NAME = 'hold-expiry'
const REPEAT_EVERY_MS = 60_000

// Grace period: only expire holds that expired at least this many seconds ago.
// Prevents premature expiry while the customer is mid-confirmation.
const GRACE_PERIOD_SECONDS = parseInt(process.env['HOLD_GRACE_PERIOD_SECONDS'] ?? '60', 10)

export const holdExpiryQueue = new Queue(QUEUE_NAME, { connection: redisConnection })

async function expireHeldBookings() {
  const cutoff = new Date(Date.now() - GRACE_PERIOD_SECONDS * 1000)

  const expiredRows = await db
    .select({
      id: bookings.id,
      businessId: bookings.businessId,
      calendarEventId: bookings.calendarEventId,
    })
    .from(bookings)
    .where(and(eq(bookings.state, 'held'), lt(bookings.holdExpiresAt, cutoff)))

  for (const booking of expiredRows) {
    const [business] = await db
      .select({
        googleRefreshToken: businesses.googleRefreshToken,
        googleCalendarId: businesses.googleCalendarId,
      })
      .from(businesses)
      .where(eq(businesses.id, booking.businessId))
      .limit(1)

    if (booking.calendarEventId && business?.googleRefreshToken) {
      const [manager] = await db
        .select({ phoneNumber: identities.phoneNumber })
        .from(identities)
        .where(
          and(
            eq(identities.businessId, booking.businessId),
            eq(identities.role, 'manager'),
            isNull(identities.revokedAt),
          ),
        )
        .limit(1)

      const calendar = createCalendarClient({
        accessToken: '',
        refreshToken: business.googleRefreshToken,
        calendarId: business.googleCalendarId,
        ...(manager ? { managerPhoneNumber: manager.phoneNumber } : {}),
      })

      const deleteResult = await calendar.deleteEvent(booking.calendarEventId)
      if (deleteResult.status === 'error') {
        // Log but still expire the DB record — orphaned Calendar event is better than stuck hold
        console.warn('[hold-expiry] Calendar delete failed for event', booking.calendarEventId, deleteResult.reason)
      }
    }

    await db
      .update(bookings)
      .set({ state: 'expired', holdExpiresAt: null, updatedAt: new Date() })
      .where(eq(bookings.id, booking.id))

    await logAudit(db, {
      businessId: booking.businessId,
      actorId: null,
      action: 'booking.expired',
      entityType: 'booking',
      entityId: booking.id,
      beforeState: { state: 'held' },
      afterState: { state: 'expired' },
      metadata: { triggeredBy: 'hold-expiry-worker' },
    })
  }

  return expiredRows.length
}

export function startHoldExpiryWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      const count = await expireHeldBookings()
      if (count > 0) {
        console.info(`[hold-expiry] Expired ${count} held booking(s)`)
      }
    },
    { connection: redisConnection },
  )

  worker.on('failed', (job, err) => {
    console.error('[hold-expiry] Job failed', { jobId: job?.id, err })
  })

  return worker
}

export async function scheduleHoldExpiryJob() {
  await holdExpiryQueue.add(
    'tick',
    {},
    {
      repeat: { every: REPEAT_EVERY_MS },
      jobId: 'hold-expiry-tick',
    },
  )
}
