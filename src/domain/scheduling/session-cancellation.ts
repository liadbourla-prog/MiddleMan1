import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import type { CalendarBlock } from '../../db/schema.js'
import { bookings, identities, serviceTypes } from '../../db/schema.js'
import { enqueueMessage } from '../../workers/message-retry.js'
import { enqueueBookingDeletion } from '../../workers/calendar-mirror.js'
import { findClassBlockProviderForSlot } from '../availability/blocks.js'
import { logAudit } from '../audit/logger.js'
import { notifyBusinessBookingChange, notifyOwnerBookingChange } from '../initiations/booking-notify.js'
import { i18n, type Lang } from '../i18n/t.js'

// Cancelling a class session is a state change that touches three parties: the booked
// customers, the instructor, and the calendar. The old deleteCalendarEvent block-path just
// removed the block, silently ORPHANING the roster (no cancellation, no notice) and never
// told the instructor. This helper closes both gaps deterministically: it cancels every
// active booking on the slot, sends each customer a cancellation notice that offers to
// rebook them, and notifies the session's instructor — before the block is removed.
//
// Delivery is best-effort and queued (free-form via the message-retry worker, matching the
// existing schedule-change cancellation path in apply.ts). It is NOT confirmed here, so the
// manager-facing wording must never promise guaranteed delivery (§7.4) — see
// summarizeSessionCancellation.

export interface CancelClassSessionInput {
  businessId: string
  block: CalendarBlock
  actorId: string
  lang: Lang
}

export interface CancelClassSessionResult {
  cancelledCount: number
  instructorNotified: boolean
}

function slotDateStr(when: Date, lang: Lang): string {
  const locale = lang === 'he' ? 'he-IL' : 'en-GB'
  return when.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
}

export async function cancelClassSessionBookings(
  db: Db,
  input: CancelClassSessionInput,
): Promise<CancelClassSessionResult> {
  const { businessId, block, actorId, lang } = input
  let cancelledCount = 0

  // Roster of a class slot is keyed by (serviceTypeId, slotStart) — the same linkage
  // editClassSession and the booking engine use. A block with no linked service has no
  // bookings to cancel.
  if (block.serviceTypeId) {
    const roster = await db
      .select({
        id: bookings.id,
        customerId: bookings.customerId,
        calendarEventId: bookings.calendarEventId,
      })
      .from(bookings)
      .where(and(
        eq(bookings.businessId, businessId),
        eq(bookings.serviceTypeId, block.serviceTypeId),
        eq(bookings.slotStart, block.startTs),
        inArray(bookings.state, ['held', 'pending_payment', 'confirmed']),
      ))

    for (const b of roster) {
      await db
        .update(bookings)
        .set({ state: 'cancelled', cancellationReason: 'Session cancelled by manager', cancelledByRole: 'manager', updatedAt: new Date() })
        .where(eq(bookings.id, b.id))

      // Durable mirror: remove the cancelled booking's Google event when present.
      if (b.calendarEventId) {
        await enqueueBookingDeletion(businessId, b.id, b.calendarEventId).catch(() => { /* non-fatal */ })
      }

      // Notify the customer through the initiation spine: in-window it phrases a warm note that
      // offers to rebook, out of window it falls back to the booking_cancelled_by_business
      // template instead of being silently dropped by Meta (the old free-form enqueueMessage
      // failed for cold customers). Best-effort.
      await notifyBusinessBookingChange(db, businessId, {
        kind: 'cancelled',
        bookingId: b.id,
        customerId: b.customerId,
        serviceTypeId: block.serviceTypeId,
        slotStart: block.startTs,
      })

      // Owner-facing: a session cancellation is a PA-initiated movement the owner has no other
      // notice of. Rules-gated, so an owner who muted 'cancellation' won't be pinged. Best-effort.
      notifyOwnerBookingChange(db, businessId, {
        kind: 'cancelled',
        origin: 'pa',
        actorIsManager: false,
        bookingId: b.id,
        customerId: b.customerId,
        serviceTypeId: block.serviceTypeId,
        slotStart: block.startTs,
      }).catch(() => { /* non-fatal */ })

      await logAudit(db, {
        businessId,
        actorId,
        action: 'booking.manager_cancelled',
        entityType: 'booking',
        entityId: b.id,
        metadata: { reason: 'session_cancelled' },
      }).catch(() => { /* ledger write is best-effort */ })

      cancelledCount++
    }
  }

  // Notify the instructor (the provider on the block), if one is assigned and reachable.
  let instructorNotified = false
  if (block.providerId) {
    const [instructor] = await db
      .select({ phoneNumber: identities.phoneNumber, preferredLanguage: identities.preferredLanguage })
      .from(identities)
      .where(eq(identities.id, block.providerId))
      .limit(1)
    if (instructor?.phoneNumber) {
      const insLang: Lang = (instructor.preferredLanguage as Lang | null | undefined) ?? lang
      const className = block.title ?? (insLang === 'he' ? 'השיעור' : 'the class')
      await enqueueMessage(instructor.phoneNumber, i18n.class_cancelled_instructor[insLang](className, slotDateStr(block.startTs, insLang)))
        .catch(() => { /* non-fatal — queued send */ })
      await logAudit(db, {
        businessId,
        actorId,
        action: 'outreach.instructor_notified',
        entityType: 'identity',
        entityId: block.providerId,
        metadata: { to: instructor.phoneNumber, sessionTitle: className },
      }).catch(() => { /* ledger write is best-effort */ })
      instructorNotified = true
    }
  }

  return { cancelledCount, instructorNotified }
}

// ── Time-range cancellations (schedule-change / block) ────────────────────────
// applyAvailabilityChange cancels every booking overlapping a blocked window — which can
// span several sessions taught by DIFFERENT instructors. It already notifies the booked
// customers; this notifies the affected instructors too, deduplicated so a class with many
// cancelled seats pings its instructor once, not once per seat.

export interface CancelledBookingRef {
  providerId: string | null
  serviceTypeId: string
  slotStart: Date
}

/**
 * Collapse cancelled bookings to one ref per distinct session (serviceTypeId + slotStart),
 * preferring a ref that already carries a providerId. Pure — unit-tested.
 */
export function distinctSessions(cancelled: CancelledBookingRef[]): CancelledBookingRef[] {
  const map = new Map<string, CancelledBookingRef>()
  for (const b of cancelled) {
    const key = `${b.serviceTypeId}|${b.slotStart.getTime()}`
    const existing = map.get(key)
    if (!existing || (existing.providerId == null && b.providerId != null)) map.set(key, b)
  }
  return [...map.values()]
}

export async function notifyInstructorsOfCancelledBookings(
  db: Db,
  input: { businessId: string; lang: Lang; actorId?: string | null; cancelled: CancelledBookingRef[] },
): Promise<number> {
  const { businessId, lang, actorId = null } = input
  const sessions = distinctSessions(input.cancelled)

  let notified = 0
  const sentKeys = new Set<string>() // dedup actual sends by (providerId, slotStart)
  const serviceNameCache = new Map<string, string | null>()
  const instructorCache = new Map<string, { phoneNumber: string | null; preferredLanguage: string | null } | null>()

  for (const s of sessions) {
    // Instructor source: the booking's own providerId, else the class block for the slot.
    let providerId = s.providerId
    if (!providerId) {
      const found = await findClassBlockProviderForSlot(db, businessId, s.serviceTypeId, s.slotStart)
      if (found.found) providerId = found.providerId
    }
    if (!providerId) continue

    const sentKey = `${providerId}|${s.slotStart.getTime()}`
    if (sentKeys.has(sentKey)) continue

    let instructor = instructorCache.get(providerId)
    if (instructor === undefined) {
      const [row] = await db
        .select({ phoneNumber: identities.phoneNumber, preferredLanguage: identities.preferredLanguage })
        .from(identities)
        .where(eq(identities.id, providerId))
        .limit(1)
      instructor = row ?? null
      instructorCache.set(providerId, instructor)
    }
    if (!instructor?.phoneNumber) continue

    let name = serviceNameCache.get(s.serviceTypeId)
    if (name === undefined) {
      const [svc] = await db
        .select({ name: serviceTypes.name })
        .from(serviceTypes)
        .where(eq(serviceTypes.id, s.serviceTypeId))
        .limit(1)
      name = svc?.name ?? null
      serviceNameCache.set(s.serviceTypeId, name)
    }

    const insLang: Lang = (instructor.preferredLanguage as Lang | null | undefined) ?? lang
    const className = name ?? (insLang === 'he' ? 'השיעור' : 'the class')
    await enqueueMessage(instructor.phoneNumber, i18n.class_cancelled_instructor[insLang](className, slotDateStr(s.slotStart, insLang)))
      .catch(() => { /* non-fatal — queued send */ })
    await logAudit(db, {
      businessId,
      actorId,
      action: 'outreach.instructor_notified',
      entityType: 'identity',
      entityId: providerId,
      metadata: { to: instructor.phoneNumber, sessionTitle: className },
    }).catch(() => { /* ledger write is best-effort */ })
    sentKeys.add(sentKey)
    notified++
  }
  return notified
}

/**
 * Manager-facing guidance for the orchestrator after a class session is cancelled. Pure so
 * it can be unit-tested. Honest about queued delivery — never promises the notices landed
 * (the 24h-window caveat means out-of-window recipients may not receive a free-form send).
 */
export function summarizeSessionCancellation(cancelledCount: number, instructorNotified: boolean): string {
  const parts: string[] = []
  parts.push(cancelledCount > 0
    ? `${cancelledCount} booked customer(s) were sent a cancellation notice that offers to rebook them`
    : 'no customers were booked')
  if (instructorNotified) parts.push('the instructor was notified')
  return `The session was cancelled and removed from the calendar. ${parts.join(', and ')}. Confirm this to the manager in your own words. The notices are queued and sent on a best-effort basis — anyone outside WhatsApp's 24-hour window may not receive one, so do not promise guaranteed delivery.`
}
