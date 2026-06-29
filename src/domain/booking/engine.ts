import { eq, and, or, lt, lte, gt, gte, count, isNotNull, ne, sql, inArray } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { bookings, serviceTypes, businesses, identities } from '../../db/schema.js'
import { enqueueMessage } from '../../workers/message-retry.js'
import { resolveProvider } from '../provider/resolver.js'
import { getInstructorHours } from '../provider/roster.js'
import { handleFreedSlot } from '../waitlist/freed-slot.js'
import type { ResolvedIdentity } from '../identity/types.js'
import { authorize } from '../authorization/check.js'
import { transition } from './state-machine.js'
import type { BookingSlotRequest } from './types.js'
import { logAudit } from '../audit/logger.js'
import { buildBookingAuditMeta, initiatorFromActor } from './audit-meta.js'
import type { CalendarClient } from '../../adapters/calendar/client.js'
import { recordCompletedBooking } from '../customer/profile.js'
import { scheduleReminders, cancelReminders } from '../../workers/reminder.js'
import { notifyBusinessBookingChange, notifyOwnerNewBooking, notifyOwnerApprovalRequest, notifyOwnerBookingChange } from '../initiations/booking-notify.js'
import { shouldHoldForApproval } from './approval.js'
import { i18n, type Lang } from '../i18n/t.js'
import { generateProactiveCustomerMessage } from '../../adapters/llm/client.js'
import { isSlotBookable } from '../availability/service.js'
import { buildOneOnOneEventContent, refreshGroupEventRoster } from '../calendar/booking-event.js'
import { findClassBlockProviderForSlot } from '../availability/blocks.js'
import type { CalendarBlockType, Booking } from '../../db/schema.js'

const HOLD_EXPIRY_MINUTES = parseInt(process.env['HOLD_EXPIRY_MINUTES'] ?? '15', 10)

// Structured failure discriminator so callers branch deterministically instead of
// string-matching `reason`. `already_booked`: the customer already holds an active
// booking for this exact (service, slot) — a POSITIVE state to reassure on, never a
// re-offer of a different time (F1d/S1: the duplicate guard was being laundered into a
// "that's unavailable, here's another date" substitute).
export type BookingFailureCode = 'already_booked'
export type BookingEngineResult =
  | { ok: true; bookingId: string; message: string; directlyConfirmed?: boolean; pendingPayment?: boolean; pendingApproval?: boolean }
  | { ok: false; reason: string; code?: BookingFailureCode }

// Temporal policy gate: past-slot, min-buffer, max-days-ahead. Returns a human
// English sentence (sanitised into customer wording downstream) or null when OK.
// Exported so Branch 4 can run the SAME check at slot-resolution time — catching
// out-of-policy times BEFORE the customer is asked to confirm, not after YES.
export function validateSlotTiming(
  slotStart: Date,
  slotEnd: Date,
  bufferMinutes: number,
  maxDaysAhead: number,
): string | null {
  const now = new Date()

  if (slotStart <= now) return 'Cannot book a slot in the past'

  const minStart = new Date(now.getTime() + bufferMinutes * 60 * 1000)
  if (slotStart < minStart) {
    return `Bookings must be made at least ${bufferMinutes} minutes in advance`
  }

  const maxStart = new Date(now.getTime() + maxDaysAhead * 24 * 60 * 60 * 1000)
  if (slotStart > maxStart) {
    return `Bookings can only be made up to ${maxDaysAhead} days in advance`
  }

  if (slotEnd <= slotStart) return 'Slot end must be after slot start'

  return null
}

// ── Advisory-lock key for private (1-on-1) booking slots ─────────────────────
// Derives the Postgres advisory transaction lock key used by requestPrivateBooking
// to serialize concurrent conflict-check+insert pairs for the same slot.
//
// I/O contract (pinned; the DB lock call is integration-level):
//   • Same (businessId, slotStartIso) → identical key every time (deterministic).
//   • Different slotStart → different key (distinct slots never share a lock).
//   • Different businessId → different key (cross-business isolation).
//   • Provider-agnostic: providerId is deliberately EXCLUDED from the key because
//     the private conflict SELECT (engine.ts ~line 255) does NOT filter by providerId.
//     Including providerId would make the lock FINER than the conflict check and let a
//     same-slot/different-provider race slip through. The lock must be at least as
//     coarse as the SELECT it guards.
//   • Partial-overlap-but-different-start races (14:00–15:00 vs 14:30–15:30) are NOT
//     covered by this key (different slotStart → different lock). They are closed at the
//     DB level by the T1.1b `bookings_exclusive_no_overlap` GiST EXCLUDE constraint
//     (migration 0049): the loser's requested→held transition raises 23P01 and is mapped
//     to a graceful "slot taken" failure (see isOverlapExclusionViolation). This advisory
//     key remains the fast path for the dominant race (two customers grabbing the EXACT
//     same advertised slot — resolved without ever reaching the constraint).
export function privateBookingLockKey(businessId: string, slotStartIso: string): string {
  return `${businessId}:${slotStartIso}`
}

// T1.1b: detect that an exclusive (1-on-1) requested→held transition lost the overlap race
// against the `bookings_exclusive_no_overlap` GiST EXCLUDE constraint. Two shapes occur:
//   • 23P01 (exclusion_violation): the other booking already committed its held row, so this
//     transition is rejected outright.
//   • 40P01 (deadlock_detected): both racers insert their conflicting index entry at the same
//     instant and wait on each other; Postgres aborts ONE victim. The victim is, by definition,
//     the loser of a mutually-exclusive overlap — exactly one survivor commits, so treating the
//     victim as an overlap-loss preserves the "exactly one winner" invariant.
// postgres-js surfaces the SQLSTATE on `err.code`. This guard is applied ONLY around the
// held-transition UPDATE (runExclusiveTransition), where the exclusion constraint is the sole
// lock interaction — so a deadlock there can only be this race, never an unrelated cycle.
function isOverlapExclusionViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const code = (err as { code?: unknown }).code
  return code === '23P01' || code === '40P01'
}

// T1.1b: run an exclusive (1-on-1) requested→held / requested→pending_payment transition,
// converting a GiST-exclusion violation (the loser of a partial-overlap race) into a clean
// "slot no longer available" failure. The orphaned `requested` row is flipped to `failed`
// (markFailed) so it can't strand a seat. A non-23P01 error is rethrown untouched.
async function runExclusiveTransition(
  db: Db,
  businessId: string,
  bookingId: string,
  actorId: string,
  apply: () => Promise<unknown>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    await apply()
    return { ok: true }
  } catch (err) {
    if (isOverlapExclusionViolation(err)) {
      await markFailed(db, businessId, bookingId, actorId, 'Slot taken by a concurrent overlapping booking')
      return { ok: false, reason: 'Slot is no longer available' }
    }
    throw err
  }
}

// Map a spatial BookableReason to an upstream reason string. These are sanitised
// into customer-facing wording by the Branch 4 flow (sanitiseReason); managers
// see them via the orchestrator. Kept stable so REASON_MAP can phrase them.
function spatialReason(reason: 'invalid_slot' | 'outside_hours' | 'busy' | 'ok'): string {
  switch (reason) {
    case 'outside_hours':
      return 'Requested time is outside business hours'
    case 'busy':
      return 'Slot is not available'
    case 'invalid_slot':
      return 'Slot end must be after slot start'
    default:
      return 'Slot is not available'
  }
}

export async function requestBooking(
  db: Db,
  calendar: CalendarClient,
  actor: ResolvedIdentity,
  request: BookingSlotRequest,
  opts?: { suppressOwnerNewBookingNotice?: boolean },
): Promise<BookingEngineResult> {
  const auth = authorize({ role: actor.role, ...(actor.delegatedPermissions ? { delegatedPermissions: actor.delegatedPermissions } : {}) }, 'booking.request')
  if (!auth.allowed) return { ok: false, reason: auth.reason }

  const [service] = await db
    .select()
    .from(serviceTypes)
    .where(and(eq(serviceTypes.id, request.serviceTypeId), eq(serviceTypes.businessId, actor.businessId)))
    .limit(1)

  if (!service) return { ok: false, reason: 'Service type not found' }
  if (!service.isActive) return { ok: false, reason: 'Service type is not currently available' }

  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.id, actor.businessId))
    .limit(1)

  const bufferMinutes = business?.minBookingBufferMinutes ?? 30
  const maxDaysAhead = business?.maxBookingDaysAhead ?? 365
  const businessTz = business?.timezone ?? 'UTC'
  const confirmationGate = business?.confirmationGate ?? 'immediate'
  const paymentMethod = business?.paymentMethod ?? null

  const timingError = validateSlotTiming(request.slotStart, request.slotEnd, bufferMinutes, maxDaysAhead)
  if (timingError) return { ok: false, reason: timingError }

  const isGroupClass = (service.maxParticipants ?? 1) > 1

  let effectiveProviderId: string | null
  let providerDisplayName: string | null = null
  // Per-instance capacity (CRM_STANDARD.md invariant #2): the scheduled class
  // block's capacity for THIS occurrence overrides the service-type default. Null
  // when no block exists for the slot (legacy materialize-on-first-booking) — the
  // group path then falls back to the service capacity.
  let instanceCapacity: number | null = null

  if (isGroupClass) {
    // D1: a booking into a class inherits THAT class's instructor. The scheduled
    // class block (calendar_blocks type='class' at this slot) is the SoT — this
    // bypasses resolveProvider (studio instructors carry no availability rows;
    // their schedule IS their classes). An explicit request.providerId still wins.
    const classBlock = await findClassBlockProviderForSlot(db, actor.businessId, request.serviceTypeId, request.slotStart)
    effectiveProviderId = request.providerId ?? (classBlock.found ? classBlock.providerId : null)
    if (classBlock.found) instanceCapacity = classBlock.maxParticipants
    // Bug E: a schedule-driven ('class') service is bookable ONLY into a real
    // scheduled class instance. If there's no class block at this slot, refuse here
    // instead of falling through to materialize-on-first-booking (which would create
    // a class at an arbitrary time the owner never scheduled — e.g. a 17:00 Pilates
    // when Pilates only runs 09/11/14/18). 'appointment'-mode group services keep the
    // legacy fallback.
    if (!classBlock.found && service.schedulingMode === 'class') {
      return { ok: false, reason: 'no_class_at_time' }
    }
  } else {
    // Private (1-on-1) booking: resolve provider by assignment + availability.
    const resolvedProvider = request.providerId
      ? { identityId: request.providerId, displayName: null, phoneNumber: '' }
      : await resolveProvider(db, actor.businessId, request.serviceTypeId, request.slotStart, request.slotEnd, request.providerHint, businessTz)

    // Reactive instructor gating: if the customer NAMED an instructor (providerHint)
    // who actually teaches this service but isn't free for this slot, fail with a
    // structured reason instead of silently booking provider-less. If no assigned
    // instructor matches the hint, fall through to normal (provider-agnostic) booking.
    if (!resolvedProvider && request.providerHint && request.providerHint.trim().length > 0) {
      const named = await getInstructorHours(db, actor.businessId, request.serviceTypeId, request.providerHint)
      if (named) {
        const hours = named.weeklyHours.map((h) => `${h.dayOfWeek}:${h.startTime}-${h.endTime}`).join(';')
        return { ok: false, reason: `provider_unavailable|${named.name}|${hours}` }
      }
    }

    effectiveProviderId = resolvedProvider?.identityId ?? null
    providerDisplayName = resolvedProvider?.displayName ?? null
  }

  const effectiveRequest: typeof request = effectiveProviderId
    ? { ...request, providerId: effectiveProviderId }
    : { ...request }

  // Spatial pre-flight: enforce working hours + manager-occupied blocks for BOTH
  // calendar modes, independent of provider assignment. This is the canonical
  // availability spine (CALENDAR_UX_DESIGN.md §5.2) — it closes the gap where
  // solo internal-mode businesses got no hours/block enforcement at all.
  // Booking-vs-booking conflicts stay with the per-flow transactional FOR UPDATE
  // check (the race-safe authority), so we exclude bookings here. A class can be
  // booked into even though its container 'class' block overlaps, so group
  // bookings ignore class-type blocks.
  if (business) {
    const blockTypes: CalendarBlockType[] = isGroupClass
      ? ['block', 'personal']
      : ['block', 'personal', 'class']
    const spatial = await isSlotBookable(
      db,
      business,
      { start: request.slotStart, end: request.slotEnd },
      { blockTypes, includeBookings: false },
    )
    if (!spatial.bookable) {
      return { ok: false, reason: spatialReason(spatial.reason) }
    }

    // Write-time freebusy guard (CALENDAR_UX_DESIGN.md §6, decision 6). In
    // connected mode the internal model can lag owner-created Google events that
    // inbound sync (Phase 3) has not yet ingested. Layer one live freebusy probe
    // on top of the internal composition at the approval seam so we never book a
    // customer into a slot the owner has already taken in Google. Internal SoT
    // stays authoritative: a freebusy *error* fails open (we don't block a valid
    // booking just because Google is unreachable).
    //
    // SKIP for group classes. A class slot is, by design, an event already on the
    // calendar (its own mirrored 'class' event), and many customers book INTO it up
    // to capacity. freebusy.query returns that class event as busy, so the probe would
    // report EVERY class slot 'occupied' and make group classes unbookable in Google
    // mode. Capacity for the instance is enforced authoritatively inside
    // requestGroupClassBooking (advisory-lock + count vs maxParticipants) — NOT here —
    // so skipping the freebusy probe never loosens the per-class limit.
    if (business.calendarMode === 'google' && !isGroupClass) {
      const fb = await calendar.checkAvailability({ start: request.slotStart, end: request.slotEnd })
      if (fb.status === 'occupied') {
        return { ok: false, reason: 'Slot is no longer available' }
      }
    }
  }

  if (isGroupClass) {
    // Owner-approval is scoped to private/1-on-1 (appointment) services in v1. Group-class
    // bookings carry per-instance capacity + a shared calendar event whose hold/confirm/roster
    // mechanics don't compose with the held-for-approval reservation, so a class service keeps
    // today's direct-confirm path even if requires_owner_approval is on (documented limitation;
    // never gated → no behavior change, only "approval not yet honored for classes").
    return requestGroupClassBooking(db, calendar, actor, effectiveRequest, service, businessTz, confirmationGate, paymentMethod, providerDisplayName, instanceCapacity, opts?.suppressOwnerNewBookingNotice ?? false)
  }

  // Per-service owner-approval gate (design 2026-06-25, §2). Fires ONLY when the service opted in
  // AND the caller is a customer (never-default guarantee, enforced in the core via
  // shouldHoldForApproval). PA/owner-initiated bookings never reach with role 'customer', so they
  // are not gated (decision D1). When it fires, the booking is held + pending the owner's decision
  // for the business's approval window instead of confirming/charging now.
  const requiresApproval = shouldHoldForApproval(service.requiresOwnerApproval, actor.role)
  const approvalWindowHours = business?.bookingApprovalWindowHours ?? 24

  return requestPrivateBooking(db, calendar, actor, effectiveRequest, service, businessTz, confirmationGate, paymentMethod, providerDisplayName, requiresApproval, approvalWindowHours)
}

// ── Private (1-on-1) booking — hold/confirm two-step flow ────────────────────

async function requestPrivateBooking(
  db: Db,
  calendar: CalendarClient,
  actor: ResolvedIdentity,
  request: BookingSlotRequest,
  service: { id: string; name: string; durationMinutes: number; maxParticipants: number; paymentAmount: string | null },
  businessTz: string,
  confirmationGate: string,
  paymentMethod: string | null,
  providerDisplayName: string | null = null,
  requiresApproval = false,
  approvalWindowHours = 24,
): Promise<BookingEngineResult> {
  // An approval-gated request reserves the slot for the whole owner-decision window (default 24h),
  // not the short interactive hold TTL — the owner, not a re-prompt, is what releases it.
  const holdExpiresAt = requiresApproval
    ? new Date(Date.now() + approvalWindowHours * 60 * 60 * 1000)
    : new Date(Date.now() + HOLD_EXPIRY_MINUTES * 60 * 1000)

  // Wrap conflict check + insert in a transaction to prevent race conditions.
  // An advisory transaction lock (acquired at the top of the transaction, before any
  // SELECT) serializes concurrent requestPrivateBooking calls for the SAME slot.
  //
  // Why FOR UPDATE alone is insufficient: when the slot is FREE the conflict SELECT
  // returns zero rows, so FOR UPDATE locks nothing — two concurrent requests both see
  // zero conflicts and both insert (TOCTOU double-book, finding A1, root P1).
  //
  // Fix (mirrors the group path at engine.ts:~line 501):
  //   pg_advisory_xact_lock(hashtext(lockKey)::bigint)
  //   where lockKey = `${businessId}:${slotStart.toISOString()}` (provider-agnostic —
  //   see privateBookingLockKey docblock for the granularity rationale).
  // Postgres releases the advisory lock automatically at transaction end.
  //
  // Residual: partial-overlap-but-different-start races (e.g. two bookings that
  // overlap but start at different times) are NOT closed by this key and remain a
  // known gap; they are addressed only by the optional T1.1b GiST EXCLUDE constraint
  // and the existing A6 freebusy probe. This fix targets the dominant race.
  const result = await (db as unknown as { transaction: <T>(fn: (tx: typeof db) => Promise<T>) => Promise<T> })
    .transaction(async (tx) => {
      const lockKey = privateBookingLockKey(actor.businessId, request.slotStart.toISOString())
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`)

      const conflicts = await tx
        .select({ id: bookings.id })
        .from(bookings)
        .where(
          and(
            eq(bookings.businessId, actor.businessId),
            or(
              and(lte(bookings.slotStart, request.slotStart), gt(bookings.slotEnd, request.slotStart)),
              and(lt(bookings.slotStart, request.slotEnd), gte(bookings.slotEnd, request.slotEnd)),
              and(gte(bookings.slotStart, request.slotStart), lte(bookings.slotEnd, request.slotEnd)),
            ),
            or(
              eq(bookings.state, 'held'),
              eq(bookings.state, 'pending_payment'),
              eq(bookings.state, 'confirmed'),
            ),
          ),
        )
        // Retained as defense-in-depth: the advisory lock above already serializes the
        // free-slot race (the phantom-insert case FOR UPDATE could not cover). FOR UPDATE
        // still adds value when the SELECT *does* find an already-conflicting row — it locks
        // that row so a concurrent state-change can't slip past us. Belt-and-suspenders.
        .for('update')
        .limit(1)

      if (conflicts.length > 0) return { ok: false as const, reason: 'Slot is not available' }

      const [newBooking] = await tx
        .insert(bookings)
        .values({
          businessId: actor.businessId,
          serviceTypeId: request.serviceTypeId,
          customerId: actor.id,
          providerId: request.providerId ?? null,
          requestedAt: new Date(),
          slotStart: request.slotStart,
          slotEnd: request.slotEnd,
          slotTzAtCreation: businessTz,
          state: 'requested',
          // T1.1b: a 1-on-1 booking exclusively owns its time range — backs the GiST
          // EXCLUDE constraint that rejects partial-overlap double-books (finding A1).
          isExclusive: true,
          // Pin the price at booking time for accurate lifetime-spend (Phase 3).
          amount: service.paymentAmount ?? null,
        })
        .returning()

      if (!newBooking) return { ok: false as const, reason: 'Failed to create booking record' }

      return { ok: true as const, bookingId: newBooking.id }
    })

  if (!result.ok) return result

  const eventTitle = providerDisplayName ? `${service.name} — ${providerDisplayName}` : service.name
  const holdResult = await calendar.placeHold(
    { start: request.slotStart, end: request.slotEnd },
    result.bookingId,
    eventTitle,
    holdExpiresAt,
  )

  if (holdResult.status === 'conflict') {
    await markFailed(db, actor.businessId, result.bookingId, actor.id, 'Calendar slot became occupied')
    return { ok: false, reason: 'Slot is no longer available' }
  }

  if (holdResult.status === 'error') {
    await markFailed(db, actor.businessId, result.bookingId, actor.id, holdResult.reason)
    return { ok: false, reason: 'Could not place hold — please try again' }
  }

  // Owner-approval gate (design 2026-06-25, §2). Hold the slot + mark it pending the owner's
  // Branch-3 decision, and fire the MANDATORY owner notification (NOT governed by notificationRules).
  // Takes precedence over the payment gate — approve-first-then-pay (decision 6): a payment-gated
  // service only sends the pay-link after the owner approves (handled in resolveBookingApproval).
  // The customer is told their request is received and pending the business's confirmation; they
  // are NOT asked to confirm again.
  if (requiresApproval) {
    const toHeld = transition('requested', 'held')
    if (!toHeld.ok) {
      await markFailed(db, actor.businessId, result.bookingId, actor.id, toHeld.reason)
      return { ok: false, reason: 'Internal state error' }
    }

    const approvalHeld = await runExclusiveTransition(db, actor.businessId, result.bookingId, actor.id, () =>
      db
        .update(bookings)
        .set({
          state: 'held',
          approvalStatus: 'pending',
          holdExpiresAt,
          calendarEventId: holdResult.eventId,
          googleEtag: holdResult.etag ?? null,
          updatedAt: new Date(),
        })
        .where(eq(bookings.id, result.bookingId)),
    )
    if (!approvalHeld.ok) return approvalHeld

    await logAudit(db, {
      businessId: actor.businessId,
      actorId: actor.id,
      action: 'booking.held_for_approval',
      entityType: 'booking',
      entityId: result.bookingId,
      beforeState: { state: 'requested' },
      afterState: { state: 'held', approvalStatus: 'pending', holdExpiresAt, calendarEventId: holdResult.eventId },
    })

    await notifyOwnerApprovalRequest(db, actor.businessId, {
      customerId: actor.id,
      serviceTypeId: service.id,
      slotStart: request.slotStart,
    }).catch(() => { /* non-fatal — the held request still stands; the owner can also see it on lookup */ })

    return {
      ok: true,
      bookingId: result.bookingId,
      message: 'Request received — pending the business\'s confirmation.',
      pendingApproval: true,
    }
  }

  if (confirmationGate === 'post_payment') {
    // Payment-first flow: set state to pending_payment, notify customer to pay
    const toPayment = transition('requested', 'pending_payment')
    if (!toPayment.ok) {
      await markFailed(db, actor.businessId, result.bookingId, actor.id, toPayment.reason)
      return { ok: false, reason: 'Internal state error' }
    }

    const toPaymentHeld = await runExclusiveTransition(db, actor.businessId, result.bookingId, actor.id, () =>
      db
        .update(bookings)
        .set({
          state: 'pending_payment',
          holdExpiresAt,
          calendarEventId: holdResult.eventId,
          googleEtag: holdResult.etag ?? null,
          paymentStatus: 'pending',
          updatedAt: new Date(),
        })
        .where(eq(bookings.id, result.bookingId)),
    )
    if (!toPaymentHeld.ok) return toPaymentHeld

    await logAudit(db, {
      businessId: actor.businessId,
      actorId: actor.id,
      action: 'booking.pending_payment',
      entityType: 'booking',
      entityId: result.bookingId,
      beforeState: { state: 'requested' },
      afterState: { state: 'pending_payment', holdExpiresAt },
    })

    const paymentNote = paymentMethod
      ? `Please send payment via ${paymentMethod} to confirm your slot.`
      : 'Please complete payment to confirm your slot.'

    return {
      ok: true,
      bookingId: result.bookingId,
      message: paymentNote,
      pendingPayment: true,
    }
  }

  // Immediate confirmation flow (default)
  const toHeld = transition('requested', 'held')
  if (!toHeld.ok) {
    await markFailed(db, actor.businessId, result.bookingId, actor.id, toHeld.reason)
    return { ok: false, reason: 'Internal state error' }
  }

  const immediateHeld = await runExclusiveTransition(db, actor.businessId, result.bookingId, actor.id, () =>
    db
      .update(bookings)
      .set({
        state: 'held',
        holdExpiresAt,
        calendarEventId: holdResult.eventId,
        googleEtag: holdResult.etag ?? null,
        updatedAt: new Date(),
      })
      .where(eq(bookings.id, result.bookingId)),
  )
  if (!immediateHeld.ok) return immediateHeld

  await logAudit(db, {
    businessId: actor.businessId,
    actorId: actor.id,
    action: 'booking.held',
    entityType: 'booking',
    entityId: result.bookingId,
    beforeState: { state: 'requested' },
    afterState: { state: 'held', holdExpiresAt, calendarEventId: holdResult.eventId },
  })

  const displayTime = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: businessTz,
  }).format(holdExpiresAt)

  return {
    ok: true,
    bookingId: result.bookingId,
    message: `Slot held until ${displayTime}. Reply CONFIRM to book.`,
  }
}

// ── Group class booking — capacity check, direct confirm ──────────────────────

async function requestGroupClassBooking(
  db: Db,
  calendar: CalendarClient,
  actor: ResolvedIdentity,
  request: BookingSlotRequest,
  service: { id: string; name: string; durationMinutes: number; maxParticipants: number; paymentAmount: string | null },
  businessTz: string,
  confirmationGate: string,
  paymentMethod: string | null,
  providerDisplayName: string | null = null,
  instanceCapacity: number | null = null,
  suppressOwnerNewBookingNotice = false,
): Promise<BookingEngineResult> {
  // Per-instance capacity wins over the service-type default (CRM_STANDARD.md
  // invariant #2): the scheduled class block decides how many fit in THIS slot.
  const maxParticipants = instanceCapacity ?? service.maxParticipants

  const txResult = await (db as unknown as { transaction: <T>(fn: (tx: typeof db) => Promise<T>) => Promise<T> })
    .transaction(async (tx) => {
      // Serialize concurrent bookings into THIS class instance. Postgres rejects
      // `SELECT count(*) … FOR UPDATE` (FOR UPDATE is not allowed with aggregates),
      // and a row-level FOR UPDATE would not block a phantom INSERT from a racing
      // first-booker anyway. An advisory transaction lock keyed on
      // (business, service, slot) is the correct slot-level mutex: it forces
      // concurrent bookers of the same class to take turns through the count→insert
      // window, and Postgres releases it automatically at transaction end.
      //
      // A2 — canonical-key invariant (finding A2, T1.2):
      //   `request.slotStart` is canonical by construction. Offered class slots come
      //   directly from `calendarBlocks.startTs` (the DB-authoritative schedule) and
      //   are stored as ISO strings in `pendingSlot.start`, round-tripped via
      //   `new Date(pendingSlot.start)` — bit-identical to the original. For
      //   `schedulingMode:'class'` services the `no_class_at_time` gate (engine.ts
      //   line ~156) rejects any slotStart that doesn't exactly match a DB block, so
      //   only canonical values reach this function. The advisory lock key and the
      //   capacity COUNT below both key on this same `request.slotStart`, so they are
      //   guaranteed consistent — no separate canonical-block lookup is needed.
      //   NO DB construct added (gated per §A2 backfill requirement).
      const lockKey = `${actor.businessId}:${request.serviceTypeId}:${request.slotStart.toISOString()}`
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`)

      // Count active bookings for this exact class slot
      const [row] = await tx
        .select({ total: count() })
        .from(bookings)
        .where(
          and(
            eq(bookings.businessId, actor.businessId),
            eq(bookings.serviceTypeId, request.serviceTypeId),
            eq(bookings.slotStart, request.slotStart),
            or(
              eq(bookings.state, 'requested'),
              eq(bookings.state, 'confirmed'),
              eq(bookings.state, 'pending_payment'),
            ),
          ),
        )

      const currentCount = Number(row?.total ?? 0)
      if (currentCount >= maxParticipants) {
        return { ok: false as const, reason: `Class is full (${currentCount}/${maxParticipants} spots taken)` }
      }

      // Also prevent the same customer from double-booking the same class.
      // A5 fix (T1.2): include `pending_payment` in the state set so a customer
      // with an unpaid-but-active seat cannot slip a second booking through while
      // payment is outstanding. Mirrors the state set used by the capacity count
      // above (requested | confirmed | pending_payment) — both guards must agree
      // on what counts as an "occupying" booking.
      const [duplicate] = await tx
        .select({ id: bookings.id })
        .from(bookings)
        .where(
          and(
            eq(bookings.businessId, actor.businessId),
            eq(bookings.serviceTypeId, request.serviceTypeId),
            eq(bookings.slotStart, request.slotStart),
            eq(bookings.customerId, actor.id),
            or(
              eq(bookings.state, 'requested'),
              eq(bookings.state, 'confirmed'),
              eq(bookings.state, 'pending_payment'),
            ),
          ),
        )
        .limit(1)

      if (duplicate) {
        return { ok: false as const, reason: "You're already booked into this class", code: 'already_booked' as const }
      }

      const [newBooking] = await tx
        .insert(bookings)
        .values({
          businessId: actor.businessId,
          serviceTypeId: request.serviceTypeId,
          customerId: actor.id,
          providerId: request.providerId ?? null,
          requestedAt: new Date(),
          slotStart: request.slotStart,
          slotEnd: request.slotEnd,
          slotTzAtCreation: businessTz,
          state: 'requested',
          // T1.1b: a class booking is NON-exclusive — many customers share one class slot
          // up to capacity. is_exclusive=false keeps these rows OUT of the overlap-exclusion
          // constraint so legitimate class co-bookings are never rejected (the G1 trap).
          isExclusive: false,
          // Pin the price at booking time for accurate lifetime-spend (Phase 3).
          amount: service.paymentAmount ?? null,
        })
        .returning()

      if (!newBooking) return { ok: false as const, reason: 'Failed to create booking record' }

      return { ok: true as const, bookingId: newBooking.id, currentCount }
    })

  if (!txResult.ok) return txResult

  // Find if a calendar event already exists for this class slot (from another participant)
  const [existingParticipant] = await db
    .select({ calendarEventId: bookings.calendarEventId })
    .from(bookings)
    .where(
      and(
        eq(bookings.businessId, actor.businessId),
        eq(bookings.serviceTypeId, request.serviceTypeId),
        eq(bookings.slotStart, request.slotStart),
        eq(bookings.state, 'confirmed'),
        isNotNull(bookings.calendarEventId),
        ne(bookings.id, txResult.bookingId),
      ),
    )
    .limit(1)

  let calendarEventId: string | null = existingParticipant?.calendarEventId ?? null
  let groupGoogleEtag: string | null = null

  if (!calendarEventId) {
    // First participant — create the calendar event
    const groupEventTitle = providerDisplayName ? `${service.name} — ${providerDisplayName}` : service.name
    const holdResult = await calendar.placeHold(
      { start: request.slotStart, end: request.slotEnd },
      txResult.bookingId,
      groupEventTitle,
      new Date(Date.now() + 60 * 60 * 1000), // dummy expiry; we confirm immediately
      // Skip the freebusy probe: the class instance is its own mirrored Google event,
      // so the probe would report this slot busy and falsely reject the first booking
      // into the class. Per-instance capacity is enforced above (advisory-lock + count).
      { skipConflictCheck: true },
    )

    if (holdResult.status !== 'held') {
      const reason = holdResult.status === 'error' ? holdResult.reason : 'Calendar slot conflict'
      await markFailed(db, actor.businessId, txResult.bookingId, actor.id, reason)
      return { ok: false, reason: 'Could not create calendar event — please try again' }
    }

    // Seed with the service name; refreshGroupEventRoster (below) immediately
    // overwrites title + description with the live roster once the booking is stored.
    const confirmResult = await calendar.confirmHold(holdResult.eventId, service.name, '')
    if (confirmResult.status === 'error') {
      await markFailed(db, actor.businessId, txResult.bookingId, actor.id, 'Calendar confirm failed')
      return { ok: false, reason: 'Could not confirm calendar event — please try again' }
    }

    calendarEventId = confirmResult.eventId
    groupGoogleEtag = confirmResult.etag ?? null
  }

  // Transition to confirmed
  await db
    .update(bookings)
    .set({ state: 'confirmed', calendarEventId, googleEtag: groupGoogleEtag, updatedAt: new Date() })
    .where(eq(bookings.id, txResult.bookingId))

  // Refresh the shared class event so the owner sees the live headcount + roster.
  // Best-effort (never throws); runs for every participant — first creates it, the
  // rest update the count and attendee list.
  await refreshGroupEventRoster(db, calendar, actor.businessId, request.serviceTypeId, request.slotStart)

  await logAudit(db, {
    businessId: actor.businessId,
    actorId: actor.id,
    action: 'booking.confirmed',
    entityType: 'booking',
    entityId: txResult.bookingId,
    beforeState: { state: 'requested' },
    afterState: { state: 'confirmed', calendarEventId, groupClass: true },
    metadata: await buildBookingAuditMeta(db, {
      customerId: actor.id,
      serviceTypeId: request.serviceTypeId,
      slotStart: request.slotStart,
      slotEnd: request.slotEnd,
      initiator: initiatorFromActor(actor),
      customerName: actor.displayName ?? actor.phoneNumber,
      serviceName: service.name,
    }),
  })

  await recordCompletedBooking(db, actor.businessId, actor.id, txResult.bookingId, request.serviceTypeId)
    .catch((err: unknown) => console.error('[engine] recordCompletedBooking failed (group):', err))
  await scheduleReminders(actor.businessId, actor.id, txResult.bookingId, request.serviceTypeId, request.slotStart).catch(() => { /* non-fatal */ })

  // Reflect a customer self-booking to the owner (INV-3 proactive). Owner-/PA-initiated bookings
  // don't reach this customer-booking engine, so this is always a customer self-commit. Suppressed
  // on a reschedule replacement: the move surfaces as a single 'moved' owner notice instead.
  if (initiatorFromActor(actor) === 'customer_self' && !suppressOwnerNewBookingNotice) {
    await notifyOwnerNewBooking(db, actor.businessId, {
      bookingId: txResult.bookingId,
      customerId: actor.id,
      serviceTypeId: request.serviceTypeId,
      slotStart: request.slotStart,
    }).catch(() => { /* non-fatal */ })
  }

  const spotsLeft = maxParticipants - txResult.currentCount - 1

  return {
    ok: true,
    bookingId: txResult.bookingId,
    message: `Spot reserved in class. ${spotsLeft} spot${spotsLeft !== 1 ? 's' : ''} remaining.`,
    directlyConfirmed: true,
  }
}

export async function confirmBooking(
  db: Db,
  calendar: CalendarClient,
  actor: ResolvedIdentity,
  bookingId: string,
  customerName: string,
  opts?: { suppressOwnerNewBookingNotice?: boolean },
): Promise<BookingEngineResult> {
  // ── Ordering + loser-resolution contract (T1.5, A4/P1) ───────────────────
  //
  // 1. Up-front guards: booking exists, auth, state='held', hold not expired,
  //    eventId present.
  // 2. Block re-validation (A4): load the business row, then call isSlotBookable
  //    with includeBookings:false so the check targets owner blocks + availability
  //    hours only (a block/personal row or out-of-hours created during the hold).
  //    excludeBookingId:bookingId excludes this hold itself. Not bookable → fail
  //    with markFailed; do NOT flip to confirmed.
  // 3. CAS flip as the atomic arbiter (P1): UPDATE … WHERE id=? AND state='held'
  //    RETURNING id. Exactly one concurrent caller flips; the other sees 0 rows.
  // 4. Side effects (calendar.confirmHold, audit, recordCompletedBooking,
  //    scheduleReminders, owner notice) are gated on the CAS winner (1 row).
  //    Loser (0 rows) → re-read state:
  //      - 'confirmed' (a concurrent confirm won) → ok:true idempotent success, NO side effects.
  //      - anything else (expired/cancelled — hold-expiry or cancel won) → ok:false.
  // 5. confirmHold failure after a successful flip: the booking is already confirmed
  //    in the DB. Do NOT roll back. Log for reconciliation and still return ok:true.

  const [booking] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.businessId, actor.businessId)))
    .limit(1)

  if (!booking) return { ok: false, reason: 'Booking not found' }

  if (actor.role === 'customer' && booking.customerId !== actor.id) {
    return { ok: false, reason: 'Not authorized to confirm this booking' }
  }

  if (booking.state !== 'held') {
    return { ok: false, reason: `Cannot confirm booking in state '${booking.state}'` }
  }

  if (booking.holdExpiresAt && booking.holdExpiresAt < new Date()) {
    return { ok: false, reason: 'Hold has expired — please start a new booking' }
  }

  const [service] = await db
    .select({ name: serviceTypes.name })
    .from(serviceTypes)
    .where(eq(serviceTypes.id, booking.serviceTypeId))
    .limit(1)

  const eventId = booking.calendarEventId
  if (!eventId) return { ok: false, reason: 'Booking has no calendar event' }

  // ── A4: Re-validate blocks created during the hold ────────────────────────
  // Load the business row (needed by isSlotBookable for timezone + available247).
  // A4 makes block re-validation an INVARIANT: if the business row can't be loaded
  // we must NOT silently confirm without it — a booking always references a real
  // businessId, so a missing row is a genuine anomaly, not a normal degrade path.
  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.id, actor.businessId))
    .limit(1)

  if (!business) return { ok: false, reason: 'Business not found' }

  const bookable = await isSlotBookable(
    db,
    business,
    { start: booking.slotStart, end: booking.slotEnd },
    {
      excludeBookingId: bookingId,   // exclude this hold itself
      includeBookings: false,        // only blocks + availability hours (not competing bookings)
    },
  )
  if (!bookable.bookable) {
    await markFailed(db, actor.businessId, bookingId, actor.id, 'Slot blocked during hold')
    return {
      ok: false,
      reason: "That time is no longer available — the studio blocked it. Let's find another.",
    }
  }

  // ── Prepare calendar event content (before CAS so render errors bail early) ─
  const rendered = await buildOneOnOneEventContent(db, actor.businessId, {
    serviceTypeId: booking.serviceTypeId,
    customerId: booking.customerId,
    providerId: booking.providerId,
  })
  const confirmTitle = rendered?.title ?? `${service?.name ?? 'Appointment'} — ${customerName}`
  const confirmDescription = rendered?.description ?? `${customerName}`

  // ── P1: CAS flip — the atomic arbiter ─────────────────────────────────────
  // The WHERE predicate gates on state='held', so exactly one concurrent caller
  // (confirm or hold-expiry) flips the row. The other sees 0 rows returned.
  // ALL side effects (calendar write, audit, reminders, owner notice) are gated
  // on 1 row returned.
  const [flipped] = await db
    .update(bookings)
    .set({ state: 'confirmed', holdExpiresAt: null, updatedAt: new Date() })
    .where(and(eq(bookings.id, bookingId), eq(bookings.state, 'held')))
    .returning({ id: bookings.id })

  // ── Loser path (0 rows): a concurrent operation already flipped the row ────
  if (!flipped) {
    // Re-read to determine what happened.
    const [current] = await db
      .select({ state: bookings.state })
      .from(bookings)
      .where(eq(bookings.id, bookingId))
      .limit(1)
    if (current?.state === 'confirmed') {
      // A concurrent confirm won — idempotent success, no side effects.
      return { ok: true, bookingId, message: 'Booking confirmed.' }
    }
    // Hold expired or was cancelled while we were in flight.
    return { ok: false, reason: 'Hold has expired — please start a new booking' }
  }

  // ── Winner path: fire side effects ────────────────────────────────────────
  // calendar.confirmHold runs AFTER the CAS so the DB state is canonical first.
  // If it fails the booking is already confirmed — do NOT roll back, log and continue.
  const confirmResult = await calendar.confirmHold(eventId, confirmTitle, confirmDescription)
  if (confirmResult.status === 'error') {
    console.error('[engine] confirmHold failed after state flip — booking confirmed in DB, calendar event not updated (id:', bookingId, ')')
    // Update etag only if we have one; leave existing etag if confirmHold errored
  } else {
    // Store the updated etag from the successful confirmHold
    await db
      .update(bookings)
      .set({ googleEtag: confirmResult.etag ?? null })
      .where(eq(bookings.id, bookingId))
  }

  await logAudit(db, {
    businessId: actor.businessId,
    actorId: actor.id,
    action: 'booking.confirmed',
    entityType: 'booking',
    entityId: bookingId,
    beforeState: { state: 'held' },
    afterState: { state: 'confirmed' },
    metadata: await buildBookingAuditMeta(db, {
      customerId: booking.customerId,
      serviceTypeId: booking.serviceTypeId,
      slotStart: booking.slotStart,
      slotEnd: booking.slotEnd,
      initiator: initiatorFromActor(actor),
      customerName,
      serviceName: service?.name ?? null,
    }),
  })

  await recordCompletedBooking(db, actor.businessId, actor.id, bookingId, booking.serviceTypeId)
    .catch((err: unknown) => console.error('[engine] recordCompletedBooking failed (confirm):', err))
  await scheduleReminders(actor.businessId, actor.id, bookingId, booking.serviceTypeId, booking.slotStart).catch(() => { /* non-fatal */ })

  // Suppressed on a reschedule replacement: the move surfaces as a single 'moved' owner notice
  // (fired by the flow's releaseSupersededBooking) instead of a 'new booking' + 'moved' pair.
  if (initiatorFromActor(actor) === 'customer_self' && !(opts?.suppressOwnerNewBookingNotice ?? false)) {
    await notifyOwnerNewBooking(db, actor.businessId, {
      bookingId,
      customerId: booking.customerId,
      serviceTypeId: booking.serviceTypeId,
      slotStart: booking.slotStart,
    }).catch(() => { /* non-fatal */ })
  }

  return { ok: true, bookingId, message: 'Booking confirmed.' }
}

export async function cancelBooking(
  db: Db,
  calendar: CalendarClient,
  actor: ResolvedIdentity,
  bookingId: string,
  reason?: string,
): Promise<BookingEngineResult> {
  const [booking] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.businessId, actor.businessId)))
    .limit(1)

  if (!booking) return { ok: false, reason: 'Booking not found' }

  const isOwn = booking.customerId === actor.id
  const action = isOwn ? 'booking.cancel_own' : 'booking.cancel_any'
  const auth = authorize({ role: actor.role, ...(actor.delegatedPermissions ? { delegatedPermissions: actor.delegatedPermissions } : {}) }, action)
  if (!auth.allowed) return { ok: false, reason: auth.reason }

  // Enforce cancellation cutoff policy for customers
  if (actor.role === 'customer') {
    const [biz] = await db
      .select({ cancellationCutoffMinutes: businesses.cancellationCutoffMinutes })
      .from(businesses)
      .where(eq(businesses.id, actor.businessId))
      .limit(1)

    const cutoff = biz?.cancellationCutoffMinutes ?? 0
    if (cutoff > 0 && booking.state === 'confirmed') {
      const minutesUntilSlot = (booking.slotStart.getTime() - Date.now()) / 60_000
      if (minutesUntilSlot < cutoff) {
        return {
          ok: false,
          reason: `Cancellations must be made at least ${cutoff} minutes before the appointment. Please contact the business directly.`,
        }
      }
    }
  }

  // Serial-retry idempotency guard: if the booking is ALREADY cancelled at read
  // time, return success with no side effects. The CAS alone cannot close this —
  // transition('cancelled','cancelled') passes via its from===to idempotent branch,
  // and the CAS predicate (state = booking.state = 'cancelled') would match the
  // already-cancelled row → 1 row "flipped" → side effects would re-fire. This
  // explicit guard is what makes a repeated cancel of a completed cancel a true
  // no-op (no duplicate audit, no duplicate notifications, no second waitlist offer).
  if (booking.state === 'cancelled') {
    return { ok: true, bookingId, message: 'Booking cancelled.' }
  }

  const t = transition(booking.state, 'cancelled')
  if (!t.ok) return { ok: false, reason: t.reason }

  // Computed before the CAS so the same value feeds both the CAS payload and the
  // winner-side audit row below.
  const cancelledByRole =
    actor.role === 'manager' ? 'manager' : actor.role === 'customer' ? 'customer' : 'system'

  // ── Conditional CAS: the state-flip is the atomic arbiter ─────────────────
  //
  // ORDER MATTERS: the CAS runs BEFORE any side effects (calendar delete,
  // notifications, waitlist). This eliminates the TOCTOU race where two
  // concurrent cancels both pass the transition() guard and both fire side
  // effects.
  //
  // The WHERE predicate gates on the exact state observed at read time
  // (AND state = <booking.state>), so exactly one concurrent winner can flip
  // the row. The other sees 0 rows returned and takes the idempotent path.
  //
  // Idempotency contract:
  //   - 0 rows returned  → a concurrent cancel already won; return ok:true
  //     with NO side effects (no calendar delete, no audit, no notifications,
  //     no waitlist offer).
  //   - 1 row returned   → this call is the winner; run all side effects in
  //     order below.
  //
  // Calendar-delete failure after a successful flip: the cancel is already
  // authoritative in the DB. Do NOT roll back or return ok:false — that would
  // leave the state as 'cancelled' in DB but suggest a retry that could
  // double-fire later side effects. Instead, log the orphaned calendar event
  // for reconciliation and return ok:true. (Behavior change from prior code
  // which returned ok:false on delete error before the state flip.)
  const [flipped] = await db
    .update(bookings)
    .set({
      state: 'cancelled',
      cancellationReason: reason ?? null,
      cancelledByRole,
      holdExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(and(eq(bookings.id, bookingId), eq(bookings.businessId, actor.businessId), eq(bookings.state, booking.state)))
    .returning({ id: bookings.id })

  // ── Idempotent: concurrent cancel already won — no side effects ───────────
  if (!flipped) {
    return { ok: true, bookingId, message: 'Booking cancelled.' }
  }

  // ── Winner path: run all side effects gated on the successful flip ────────

  // Calendar: for group classes only delete the event when the last participant
  // cancels; otherwise just refresh the shared event's roster.
  if (booking.calendarEventId) {
    const [service] = await db
      .select({ maxParticipants: serviceTypes.maxParticipants })
      .from(serviceTypes)
      .where(eq(serviceTypes.id, booking.serviceTypeId))
      .limit(1)

    const isGroupClass = (service?.maxParticipants ?? 1) > 1

    const shouldDeleteEvent = !isGroupClass || await (async () => {
      const [row] = await db
        .select({ total: count() })
        .from(bookings)
        .where(
          and(
            eq(bookings.businessId, actor.businessId),
            eq(bookings.serviceTypeId, booking.serviceTypeId),
            eq(bookings.slotStart, booking.slotStart),
            or(eq(bookings.state, 'confirmed'), eq(bookings.state, 'requested')),
            ne(bookings.id, bookingId),
          ),
        )
      return Number(row?.total ?? 0) === 0
    })()

    if (shouldDeleteEvent) {
      const deleteResult = await calendar.deleteEvent(booking.calendarEventId)
      if (deleteResult.status === 'error') {
        // The state flip already committed — do NOT return ok:false or roll back.
        // Log the orphaned event for reconciliation; the cancel is authoritative.
        console.error(
          '[engine] orphaned calendar event after cancel',
          { bookingId, calendarEventId: booking.calendarEventId, reason: deleteResult.reason },
        )
      }
    } else if (isGroupClass) {
      // Now that this booking is no longer active, redraw the remaining class roster.
      await refreshGroupEventRoster(db, calendar, actor.businessId, booking.serviceTypeId, booking.slotStart)
    }
  }

  await logAudit(db, {
    businessId: actor.businessId,
    actorId: actor.id,
    action: 'booking.cancelled',
    entityType: 'booking',
    entityId: bookingId,
    beforeState: { state: booking.state },
    afterState: { state: 'cancelled', reason, cancelledByRole },
    metadata: await buildBookingAuditMeta(db, {
      customerId: booking.customerId,
      serviceTypeId: booking.serviceTypeId,
      slotStart: booking.slotStart,
      slotEnd: booking.slotEnd,
      initiator: initiatorFromActor(actor),
    }),
  })

  // Cancel any pending reminders for this booking
  cancelReminders(bookingId).catch(() => { /* non-fatal */ })

  // Business-originated cancel (manager actor): the customer didn't ask for this, so tell them —
  // through the initiation spine, which falls back to the booking_cancelled_by_business template
  // when they're outside the 24h window. Best-effort; never roll back the cancel on a notify miss.
  if (cancelledByRole === 'manager' && booking.customerId !== actor.id) {
    notifyBusinessBookingChange(db, actor.businessId, {
      kind: 'cancelled',
      bookingId,
      customerId: booking.customerId,
      serviceTypeId: booking.serviceTypeId,
      slotStart: booking.slotStart,
    }).catch(() => { /* non-fatal */ })
  }

  // Owner-facing: notify the owner of customer/PA-originated cancellations (NOT the manager's own
  // action, and NOT a reschedule-supersede — that surfaces as a single 'moved' notice elsewhere).
  if (cancelledByRole !== 'manager' && reason !== 'Superseded by reschedule') {
    notifyOwnerBookingChange(db, actor.businessId, {
      kind: 'cancelled',
      origin: cancelledByRole === 'customer' ? 'customer' : 'pa',
      actorIsManager: false,
      bookingId,
      customerId: booking.customerId,
      serviceTypeId: booking.serviceTypeId,
      slotStart: booking.slotStart,
    }).catch(() => { /* non-fatal */ })
  }

  // Freed-slot handling now passes through the owner-approval gate (WS-C / #6 / #8):
  // it offers automatically only if the owner opted in, otherwise asks first. Best-effort.
  handleFreedSlot(db, {
    businessId: actor.businessId,
    serviceTypeId: booking.serviceTypeId,
    slotStart: booking.slotStart,
    slotEnd: booking.slotEnd,
    sourceBookingId: bookingId,
  }).catch(() => { /* non-fatal — freed-slot handling is best-effort */ })

  return { ok: true, bookingId, message: 'Booking cancelled.' }
}

// ── Manager confirms payment received ─────────────────────────────────────────

export async function confirmPaymentReceived(
  db: Db,
  calendar: CalendarClient,
  businessId: string,
  customerPhone: string,
): Promise<BookingEngineResult> {
  // Find the manager identity to use as actor
  const [manager] = await db
    .select({ id: identities.id, role: identities.role, businessId: identities.businessId, phoneNumber: identities.phoneNumber })
    .from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.role, 'manager')))
    .limit(1)

  if (!manager) return { ok: false, reason: 'Manager identity not found' }

  // Find the customer identity
  const [customer] = await db
    .select({ id: identities.id, preferredLanguage: identities.preferredLanguage })
    .from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.phoneNumber, customerPhone)))
    .limit(1)

  if (!customer) return { ok: false, reason: `No customer found for ${customerPhone}` }

  // Find their pending_payment booking
  const [booking] = await db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.businessId, businessId),
        eq(bookings.customerId, customer.id),
        eq(bookings.state, 'pending_payment'),
      ),
    )
    .orderBy(bookings.createdAt)
    .limit(1)

  if (!booking) return { ok: false, reason: `No pending-payment booking found for ${customerPhone}` }

  return finalizePaidBooking(
    db,
    calendar,
    businessId,
    booking,
    { id: customer.id, preferredLanguage: customer.preferredLanguage, phoneNumber: customerPhone },
    { actorId: manager.id, triggeredBy: 'manager_paid_command' },
  )
}

// ── Shared paid-booking finalization ──────────────────────────────────────────
// The single `pending_payment → confirmed/paid` edge (design §7). Drives the calendar
// confirm, state flip, audit (with caller-supplied `triggeredBy`), spend/reminder side
// effects, and the customer confirmation message. Two callers:
//   • confirmPaymentReceived — the manual owner "PAID <phone>" command (triggeredBy
//     'manager_paid_command').
//   • PaymentService.reconcilePayment — the Grow success webhook (triggeredBy
//     'grow_webhook'), which REPLACES the manual command on the critical path.
// Flipping the booking out of `pending_payment` also stops the dunning worker for it
// (that worker scans only `state = 'pending_payment'`), so cancel-on-pay is automatic.
export async function finalizePaidBooking(
  db: Db,
  calendar: CalendarClient,
  businessId: string,
  booking: Booking,
  customer: { id: string; preferredLanguage: string | null; phoneNumber: string },
  opts: { actorId: string | null; triggeredBy: string },
): Promise<BookingEngineResult> {
  const customerPhone = customer.phoneNumber

  const [service] = await db
    .select({ name: serviceTypes.name })
    .from(serviceTypes)
    .where(eq(serviceTypes.id, booking.serviceTypeId))
    .limit(1)

  const eventId = booking.calendarEventId
  if (!eventId) return { ok: false, reason: 'Booking has no calendar event' }

  const rendered = await buildOneOnOneEventContent(db, businessId, {
    serviceTypeId: booking.serviceTypeId,
    customerId: booking.customerId,
    providerId: booking.providerId,
  })
  const confirmTitle = rendered?.title ?? `${service?.name ?? 'Appointment'} — ${customerPhone}`
  const confirmDescription = rendered?.description ?? customerPhone

  const confirmResult = await calendar.confirmHold(eventId, confirmTitle, confirmDescription)
  if (confirmResult.status === 'error') {
    return { ok: false, reason: 'Could not confirm calendar event' }
  }

  await db
    .update(bookings)
    .set({ state: 'confirmed', paymentStatus: 'paid', holdExpiresAt: null, googleEtag: confirmResult.etag ?? null, updatedAt: new Date() })
    .where(eq(bookings.id, booking.id))

  await logAudit(db, {
    businessId,
    actorId: opts.actorId,
    action: 'booking.confirmed',
    entityType: 'booking',
    entityId: booking.id,
    beforeState: { state: 'pending_payment' },
    afterState: { state: 'confirmed', paymentStatus: 'paid' },
    metadata: {
      triggeredBy: opts.triggeredBy,
      ...(await buildBookingAuditMeta(db, {
        customerId: booking.customerId,
        serviceTypeId: booking.serviceTypeId,
        slotStart: booking.slotStart,
        slotEnd: booking.slotEnd,
        initiator: 'customer_self',
        customerName: customerPhone,
        serviceName: service?.name ?? null,
      })),
    },
  })

  await recordCompletedBooking(db, businessId, customer.id, booking.id, booking.serviceTypeId)
    .catch((err: unknown) => console.error('[engine] recordCompletedBooking failed (paid):', err))
  await scheduleReminders(businessId, customer.id, booking.id, booking.serviceTypeId, booking.slotStart).catch(() => { /* non-fatal */ })

  // NOTE: deliberately NO owner new-booking reflection here. This is the post-payment finalize
  // path — the autonomous payment loop, which §10 keeps owner-silent (zero owner involvement on
  // the payment critical path). The owner reflection fires at the booking-confirm moment on the
  // immediate-gate self-book paths instead. (Owner reflection for post_payment bookings is a
  // deferred follow-up — see the 2026-06-25 design §9.)

  // Send confirmation to the customer
  const [biz] = await db
    .select({ name: businesses.name, timezone: businesses.timezone, defaultLanguage: businesses.defaultLanguage })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)

  if (biz && service) {
    const lang: Lang = (customer.preferredLanguage as Lang | null | undefined)
      ?? (biz.defaultLanguage as Lang | null | undefined)
      ?? 'he'
    const locale = lang === 'he' ? 'he-IL' : 'en-GB'
    const tz = biz.timezone
    const dateStr = new Intl.DateTimeFormat(locale, {
      timeZone: tz, weekday: 'long', day: 'numeric', month: 'long',
    }).format(booking.slotStart)
    const timeStr = new Intl.DateTimeFormat(locale, {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(booking.slotStart)
    const paymentFallback = i18n.payment_confirmed[lang](service.name, biz.name, dateStr, timeStr)
    const paymentMsg = await generateProactiveCustomerMessage({
      businessName: biz.name,
      language: lang,
      situation: `The customer's booking for "${service.name}" at ${biz.name} has been confirmed after payment. Let them know their appointment is confirmed for ${dateStr} at ${timeStr}.`,
      fallback: paymentFallback,
      timeoutMs: 2500,
    }).catch(() => paymentFallback)
    await enqueueMessage(businessId, customerPhone, paymentMsg).catch(() => { /* non-fatal */ })
  }

  return { ok: true, bookingId: booking.id, message: `Booking confirmed for ${customerPhone}.` }
}

// Mark an in-flight booking as failed. The state predicate is load-bearing: it
// must NEVER stomp a confirmed/terminal row. The A4 re-validation path in
// confirmBooking calls this while the row is still 'held' — if a concurrent
// confirm WON the CAS and flipped it to 'confirmed' in between, this UPDATE must
// be a no-op (a confirmed booking has a live calendar event + scheduled reminders;
// overwriting it to 'failed' is a data-integrity violation). Every existing caller
// invokes this on a requested/held/pending_payment row, so the guard never blocks
// a legitimate failure — it only closes the confirmed-stomp race.
async function markFailed(db: Db, businessId: string, bookingId: string, actorId: string, reason: string) {
  await db
    .update(bookings)
    .set({ state: 'failed', updatedAt: new Date() })
    .where(and(eq(bookings.id, bookingId), inArray(bookings.state, ['requested', 'held', 'pending_payment'])))

  await logAudit(db, {
    businessId,
    actorId,
    action: 'booking.failed',
    entityType: 'booking',
    entityId: bookingId,
    afterState: { state: 'failed', reason },
  })
}
