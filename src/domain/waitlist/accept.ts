/**
 * WL-AX — Waitlist accept / decline domain (Path C, plan §3.3).
 *
 * The correctness crux of Path C (races, H1, H2). This module owns three things:
 *
 *   1. getLiveWaitlistOffer — the live `offered` row for a customer (fallback binding when the
 *      pendingDecision context was lost).
 *   2. acceptWaitlistOffer — "yes" turns the WL-5 hold into a real booking. It CONFIRMS the held
 *      booking via the hardened engine (`confirmBooking`, T1.5 CAS + re-validate — never a
 *      hand-rolled write) and CAS-flips the waitlist row offered→accepted. Both-or-neither: a lost
 *      race (hold expired/clobbered) returns `just_went` and never flips the row to accepted.
 *   3. declineWaitlistOffer — explicit "no thanks" (plan §5 Q5): release the held booking FIRST,
 *      then flip the row, then cascade to the next in line. Releasing before the cascade avoids a
 *      transient `cap+1` that would trip INV-11 and fail the next hold's capacity lock.
 *
 * The release of a waitlist-created hold (CAS held→expired + calendar cleanup) is factored into a
 * single internal `releaseWaitlistHold` so explicit decline and the worker's `expire_offer`
 * single-releaser (H1) share ONE releaser — mirroring hold-expiry.ts's canonical pattern.
 *
 * No schema change. Models its imports on freed-slot.ts (same dir).
 */
import { and, desc, eq, gt } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { bookings, waitlist } from '../../db/schema.js'
import type { CalendarClient } from '../../adapters/calendar/client.js'
import type { ResolvedIdentity } from '../identity/types.js'
import { confirmBooking } from '../booking/engine.js'
import { triggerWaitlistForSlot } from '../../workers/waitlist.js'
import { logAudit } from '../audit/logger.js'

/**
 * The customer's currently-live waitlist offer: a `status='offered'` row whose
 * `offerExpiresAt > now`. Most-recent if somehow several. Null if none.
 *
 * Fallback binding when the pendingDecision (T3.2) context was lost — a yes/no-shaped reply can
 * still be resolved against this.
 */
export async function getLiveWaitlistOffer(
  db: Db,
  businessId: string,
  customerId: string,
): Promise<{ id: string; serviceTypeId: string; slotStart: Date; slotEnd: Date } | null> {
  const [row] = await db
    .select({
      id: waitlist.id,
      serviceTypeId: waitlist.serviceTypeId,
      slotStart: waitlist.slotStart,
      slotEnd: waitlist.slotEnd,
    })
    .from(waitlist)
    .where(
      and(
        eq(waitlist.businessId, businessId),
        eq(waitlist.customerId, customerId),
        eq(waitlist.status, 'offered'),
        gt(waitlist.offerExpiresAt, new Date()),
      ),
    )
    .orderBy(desc(waitlist.offeredAt))
    .limit(1)

  return row ?? null
}

export type AcceptOutcome =
  | { kind: 'accepted'; bookingId: string }
  | { kind: 'just_went' } // lost the race — hold gone; warm fallback, never a dead-end

/**
 * Accept = confirm the WL-5 held booking + CAS-flip the waitlist row offered→accepted. Both or
 * neither: a lost race (hold expired/clobbered) returns `just_went` and does NOT flip the row.
 */
export async function acceptWaitlistOffer(
  db: Db,
  calendar: CalendarClient,
  actor: ResolvedIdentity,
  customerName: string,
  offer: { id: string; serviceTypeId: string; slotStart: Date; slotEnd: Date },
): Promise<AcceptOutcome> {
  // 1. Find the WL-5 hold: the customer's own held booking for this exact slot/service.
  const [held] = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.businessId, actor.businessId),
        eq(bookings.customerId, actor.id),
        eq(bookings.serviceTypeId, offer.serviceTypeId),
        eq(bookings.slotStart, offer.slotStart),
        eq(bookings.state, 'held'),
      ),
    )
    .limit(1)

  if (!held) {
    // No hold to confirm — it expired/was released. Warm fallback, keep them listed.
    return { kind: 'just_went' }
  }

  // 2. Confirm the hold through the hardened engine (T1.5 CAS + block/capacity re-validate,
  //    group-aware via WL-7E). A lost race surfaces as ok:false — do NOT flip the row.
  const confirmResult = await confirmBooking(db, calendar, actor, held.id, customerName)
  if (!confirmResult.ok) {
    return { kind: 'just_went' }
  }

  // 3. CAS-flip the waitlist row offered→accepted (both-or-neither w.r.t. the confirm above).
  const flipped = await db
    .update(waitlist)
    .set({ status: 'accepted' })
    .where(and(eq(waitlist.id, offer.id), eq(waitlist.status, 'offered')))
    .returning({ id: waitlist.id })

  // If the flip got 0 rows because a concurrent expire already moved the row, the booking is still
  // validly confirmed by the CAS above — the seat is theirs. Still return accepted.
  await logAudit(db, {
    businessId: actor.businessId,
    actorId: actor.id,
    action: 'waitlist.accepted',
    entityType: 'waitlist',
    entityId: offer.id,
    metadata: {
      serviceTypeId: offer.serviceTypeId,
      slotStart: offer.slotStart.toISOString(),
      bookingId: confirmResult.bookingId,
      rowFlipped: flipped.length > 0,
    },
  }).catch(() => { /* best-effort */ })

  return { kind: 'accepted', bookingId: confirmResult.bookingId }
}

/**
 * Explicit decline (plan §5 Q5): release the held booking FIRST, then flip the waitlist row
 * offered→expired, then cascade. Releasing before the cascade avoids a transient cap+1.
 */
export async function declineWaitlistOffer(
  db: Db,
  calendar: CalendarClient,
  offer: {
    id: string
    businessId: string
    customerId: string
    serviceTypeId: string
    slotStart: Date
    slotEnd: Date
  },
): Promise<void> {
  // 1. Release the held booking FIRST (CAS held→expired + calendar cleanup).
  await releaseWaitlistHold(db, calendar, offer.businessId, offer.customerId, offer.serviceTypeId, offer.slotStart, 'waitlist-decline')

  // 2. Flip the waitlist row offered→expired (CAS).
  const flipped = await db
    .update(waitlist)
    .set({ status: 'expired' })
    .where(and(eq(waitlist.id, offer.id), eq(waitlist.status, 'offered')))
    .returning({ id: waitlist.id })

  if (flipped.length > 0) {
    await logAudit(db, {
      businessId: offer.businessId,
      actorId: offer.customerId,
      action: 'waitlist.declined',
      entityType: 'waitlist',
      entityId: offer.id,
      metadata: { serviceTypeId: offer.serviceTypeId, slotStart: offer.slotStart.toISOString() },
    }).catch(() => { /* best-effort */ })
  } else {
    // Row already moved (e.g. a concurrent expire_offer). Still cascade — the seat is free.
    await logAudit(db, {
      businessId: offer.businessId,
      actorId: offer.customerId,
      action: 'waitlist.declined',
      entityType: 'waitlist',
      entityId: offer.id,
      metadata: { serviceTypeId: offer.serviceTypeId, slotStart: offer.slotStart.toISOString(), rowAlreadyMoved: true },
    }).catch(() => { /* best-effort */ })
  }

  // 3. Cascade to the next in line.
  await triggerWaitlistForSlot(offer.businessId, offer.serviceTypeId, offer.slotStart, offer.slotEnd)
}

/**
 * Shared single releaser of a waitlist-created hold — used by explicit decline AND the worker's
 * `expire_offer` single-releaser (H1). Mirrors hold-expiry.ts's canonical pattern: CAS held→expired
 * FIRST (the atomic arbiter), then — only on the 1-row winner — delete the calendar event (if the
 * hold has one; GROUP-class holds carry calendarEventId=null → state flip only) and audit
 * `booking.expired`. A 0-row CAS means a concurrent actor (confirm / hold-expiry backstop) already
 * moved the row — skip all side effects.
 *
 * Returns true iff this caller won the CAS (released the hold).
 */
export async function releaseWaitlistHold(
  db: Db,
  calendar: CalendarClient,
  businessId: string,
  customerId: string,
  serviceTypeId: string,
  slotStart: Date,
  triggeredBy: string,
): Promise<boolean> {
  const [held] = await db
    .select({ id: bookings.id, calendarEventId: bookings.calendarEventId })
    .from(bookings)
    .where(
      and(
        eq(bookings.businessId, businessId),
        eq(bookings.customerId, customerId),
        eq(bookings.serviceTypeId, serviceTypeId),
        eq(bookings.slotStart, slotStart),
        eq(bookings.state, 'held'),
      ),
    )
    .limit(1)

  if (!held) return false

  // CAS held→expired as the atomic arbiter (mirrors hold-expiry.ts). Side effects only on 1 row.
  const flipped = await db
    .update(bookings)
    .set({ state: 'expired', holdExpiresAt: null, updatedAt: new Date() })
    .where(and(eq(bookings.id, held.id), eq(bookings.state, 'held')))
    .returning({ id: bookings.id })

  if (flipped.length === 0) {
    // A concurrent confirm / backstop already flipped it — do NOT delete the calendar event.
    return false
  }

  // Calendar cleanup only on the CAS winner, and only if the hold owns an event (PRIVATE holds do;
  // GROUP holds carry null until accept attaches the shared class event).
  if (held.calendarEventId) {
    const deleteResult = await calendar.deleteEvent(held.calendarEventId)
    if (deleteResult.status === 'error') {
      // Orphaned calendar event is better than a stuck hold — log and proceed.
      console.warn('[waitlist] Calendar delete failed for event', held.calendarEventId, deleteResult.reason)
    }
  }

  await logAudit(db, {
    businessId,
    actorId: null,
    action: 'booking.expired',
    entityType: 'booking',
    entityId: held.id,
    beforeState: { state: 'held' },
    afterState: { state: 'expired' },
    metadata: { triggeredBy },
  }).catch(() => { /* best-effort */ })

  return true
}
