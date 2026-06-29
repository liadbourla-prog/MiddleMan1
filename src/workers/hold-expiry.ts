import { Worker, Queue } from 'bullmq'
import { eq, and, lt, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { bookings, businesses, identities } from '../db/schema.js'
import { createCalendarClient } from '../adapters/calendar/client.js'
import { logAudit } from '../domain/audit/logger.js'
import { redisConnection } from '../redis.js'
import { enqueueMessage } from './message-retry.js'
import { t } from '../domain/i18n/t.js'
import { generateProactiveCustomerMessage } from '../adapters/llm/client.js'
import { notifyOwnerApprovalExpired } from '../domain/initiations/booking-notify.js'
import { isApprovalExpiry } from '../domain/booking/approval.js'
import { isIdentityLocked } from '../domain/flows/concurrency-lock.js'

const QUEUE_NAME = 'hold-expiry'
const REPEAT_EVERY_MS = 60_000

// Grace period: only expire holds that expired at least this many seconds ago.
// Prevents premature expiry while the customer is mid-confirmation.
const GRACE_PERIOD_SECONDS = parseInt(process.env['HOLD_GRACE_PERIOD_SECONDS'] ?? '60', 10)

export const holdExpiryQueue = new Queue(QUEUE_NAME, { connection: redisConnection })

export async function expireHeldBookings() {
  const cutoff = new Date(Date.now() - GRACE_PERIOD_SECONDS * 1000)

  const expiredRows = await db
    .select({
      id: bookings.id,
      businessId: bookings.businessId,
      calendarEventId: bookings.calendarEventId,
      customerId: bookings.customerId,
      // Owner-approval bookings (design 2026-06-25) expire on the SAME holdExpiresAt key, but get
      // an approval-flavored customer message + an owner "request expired" note.
      approvalStatus: bookings.approvalStatus,
      serviceTypeId: bookings.serviceTypeId,
      slotStart: bookings.slotStart,
    })
    .from(bookings)
    .where(and(eq(bookings.state, 'held'), lt(bookings.holdExpiresAt, cutoff)))

  let expiredCount = 0
  for (const booking of expiredRows) {
    // ── Belt-and-suspenders: skip rows under an active identity lock ─────────
    // If the customer is mid-turn (possibly confirming), skip this tick entirely.
    // The CAS below is the primary arbiter; this avoids initiating a race with an
    // in-flight confirm at all.  A later tick will pick up the row if it is still
    // 'held' once the turn ends and the lock has released.
    if (await isIdentityLocked(booking.customerId)) {
      console.info('[hold-expiry] Skipping booking', booking.id, '— identity lock active for customer', booking.customerId)
      continue
    }

    // ── E4: CAS flip as the atomic arbiter ───────────────────────────────────
    // UPDATE … WHERE id=? AND state='held' RETURNING id.
    // This is the exclusive gate: exactly one concurrent actor (this worker or
    // confirmBooking) can flip the row.  If the confirm winner already set
    // state='confirmed', the WHERE predicate misses and we get 0 rows — skip all
    // side effects so a confirmed booking is never expired or its event deleted.
    //
    // CONTRACT (T1.7, E4/P1):
    //   1. CAS runs FIRST — before any calendar delete, audit, or messaging.
    //   2. Side effects (calendar delete, audit, messages) only run if CAS returns 1 row.
    //   3. Lock-skip above prevents racing an in-flight confirm.
    const [flipped] = await db
      .update(bookings)
      .set({ state: 'expired', holdExpiresAt: null, updatedAt: new Date() })
      .where(and(eq(bookings.id, booking.id), eq(bookings.state, 'held')))
      .returning({ id: bookings.id })

    if (!flipped) {
      // A concurrent confirm (or cancellation) already flipped this row.
      // Do NOT delete the calendar event; do NOT audit; do NOT message.
      console.info('[hold-expiry] Skipping booking', booking.id, '— CAS missed (already confirmed/cancelled)')
      continue
    }

    expiredCount++

    // ── Winner path: fire side effects after the CAS ─────────────────────────
    const [business] = await db
      .select({
        googleRefreshToken: businesses.googleRefreshToken,
        googleCalendarId: businesses.googleCalendarId,
        defaultLanguage: businesses.defaultLanguage,
        name: businesses.name,
      })
      .from(businesses)
      .where(eq(businesses.id, booking.businessId))
      .limit(1)

    // Calendar delete only if this worker won the CAS — a confirmed booking's
    // event must never be deleted.
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
        // Log but still proceed — orphaned Calendar event is better than stuck hold
        console.warn('[hold-expiry] Calendar delete failed for event', booking.calendarEventId, deleteResult.reason)
      }
    }

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

    if (business) {
      const [customer] = await db
        .select({ phoneNumber: identities.phoneNumber, preferredLanguage: identities.preferredLanguage })
        .from(identities)
        .where(eq(identities.id, booking.customerId))
        .limit(1)

      if (customer) {
        const lang: 'he' | 'en' = ((customer.preferredLanguage ?? business.defaultLanguage) as 'he' | 'en' | null) ?? 'he'
        const isApproval = isApprovalExpiry(booking.approvalStatus)
        // Approval-pending holds expire because the BUSINESS didn't decide in time — not because the
        // customer failed to confirm. Use approval-flavored wording, and brief the owner separately.
        const fallback = isApproval ? t('approval_expired_customer', lang) : t('hold_expired', lang)
        const situation = isApproval
          ? 'The customer\'s booking request expired because the business did not confirm it in time, so it was not booked. Let them know warmly and without blame, and invite them to try another time whenever they\'re ready.'
          : 'The customer\'s booking hold has expired because they did not confirm in time. Let them know briefly and invite them to book again whenever they\'re ready.'
        const msg = await generateProactiveCustomerMessage({
          businessName: business.name,
          language: lang,
          situation,
          fallback,
          timeoutMs: 2500,
        })
        await enqueueMessage(booking.businessId, customer.phoneNumber, msg)

        if (isApproval) {
          await notifyOwnerApprovalExpired(db, booking.businessId, {
            customerId: booking.customerId,
            serviceTypeId: booking.serviceTypeId,
            slotStart: booking.slotStart,
          }).catch(() => { /* non-fatal */ })
        }
      }
    }
  }

  return expiredCount
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
