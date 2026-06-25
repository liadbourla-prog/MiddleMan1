// ── Per-service owner approval of customer self-bookings (design 2026-06-25) ─────
//
// When an owner turns on requires_owner_approval for a specific service, a Branch-4
// customer self-booking for that service is HELD (approval_status='pending') until the
// owner confirms in Branch 3. This module owns the two seams that are NOT the engine gate:
//   • the deterministic resolver (owner says yes/no → confirm / pending_payment / cancel), and
//   • the pure decision cores that the engine, the worker, and the orchestrator tool reuse.
//
// Every state change passes through the booking state machine transition() (Principle:
// deterministic core). The held→confirmed | pending_payment | cancelled edges already exist
// in VALID_TRANSITIONS — no state-machine change is needed.

import { eq } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { bookings, businesses } from '../../db/schema.js'
import type { BookingState } from '../../db/schema.js'
import { transition } from './state-machine.js'
import { logAudit } from '../audit/logger.js'
import { recordCompletedBooking } from '../customer/profile.js'
import { scheduleReminders } from '../../workers/reminder.js'
import { enqueueBookingMirror, enqueueBookingDeletion } from '../../workers/calendar-mirror.js'
import { notifyBusinessBookingChange, notifyCustomerApprovalDeclined } from '../initiations/booking-notify.js'

export type ApprovalDecision = 'approve' | 'decline'

// ── Pure: engine gate decision ──────────────────────────────────────────────────
// Whether a booking-confirm seam must hold the request for the owner instead of
// committing it. The never-default guarantee lives here: the gate fires ONLY when the
// service opted in AND the caller is a customer (Branch 4). PA/owner-initiated bookings
// (role manager / delegated_user / contact / system) are never gated (decision D1).
export function shouldHoldForApproval(requiresOwnerApproval: boolean, actorRole: string): boolean {
  return requiresOwnerApproval === true && actorRole === 'customer'
}

// ── Pure: hold-expiry flavor ────────────────────────────────────────────────────
// An expiring held booking marked 'pending' is an owner-approval request that timed out
// (the business didn't decide) — it gets approval-flavored customer wording + an owner note.
// Any other held booking is an ordinary short-TTL customer hold (the customer didn't confirm).
export function isApprovalExpiry(approvalStatus: string | null): boolean {
  return approvalStatus === 'pending'
}

// ── Pure: resolver transition decision ──────────────────────────────────────────
// Given the booking's current state + approval marker and the owner's decision, decide
// the target booking state. Already-resolved (not a held+pending request) returns ok:false
// so the resolver is idempotent. Approve respects the payment gate (approve-first-then-pay,
// decision 6): a payment-gated service goes held→pending_payment; otherwise held→confirmed.
export type ApprovalResolution =
  | { ok: true; targetState: Extract<BookingState, 'confirmed' | 'pending_payment' | 'cancelled'>; newApprovalStatus: 'approved' | 'declined' }
  | { ok: false; reason: 'already_resolved' }

export function nextApprovalResolution(
  state: BookingState,
  approvalStatus: string | null,
  decision: ApprovalDecision,
  confirmationGate: 'immediate' | 'post_payment',
): ApprovalResolution {
  // A resolvable request is exactly a held booking still marked pending. Anything else
  // (already approved/declined, expired, cancelled, never an approval booking) is a no-op.
  if (state !== 'held' || approvalStatus !== 'pending') {
    return { ok: false, reason: 'already_resolved' }
  }
  if (decision === 'approve') {
    return {
      ok: true,
      targetState: confirmationGate === 'post_payment' ? 'pending_payment' : 'confirmed',
      newApprovalStatus: 'approved',
    }
  }
  return { ok: true, targetState: 'cancelled', newApprovalStatus: 'declined' }
}

// ── Pure: pending-request selection for the free-text resolution tool ────────────
// Maps the owner's free-text reference ("approve Dana's yoga") onto one pending request.
// An explicit bookingId wins. Otherwise filter the business's pending requests by the
// customer / service hints. Exactly one survivor → resolve it. Several → ask which (never
// guess). None → tell the owner there is nothing waiting (matching the hint, if one given).
export interface PendingApprovalCandidate {
  bookingId: string
  customerName: string | null
  customerPhone: string | null
  serviceName: string | null
  slotLabel: string
}

export interface ApprovalSelectionHint {
  bookingId?: string | null
  customerHint?: string | null
  serviceHint?: string | null
}

export type ApprovalSelection =
  | { kind: 'one'; booking: PendingApprovalCandidate }
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: PendingApprovalCandidate[] }

export function selectPendingApproval(
  candidates: PendingApprovalCandidate[],
  hint: ApprovalSelectionHint,
): ApprovalSelection {
  if (candidates.length === 0) return { kind: 'none' }

  if (hint.bookingId) {
    const exact = candidates.find((c) => c.bookingId === hint.bookingId)
    return exact ? { kind: 'one', booking: exact } : { kind: 'none' }
  }

  let pool = candidates
  const cust = hint.customerHint?.trim().toLowerCase()
  if (cust) {
    pool = pool.filter((c) =>
      (c.customerName ?? '').toLowerCase().includes(cust) || (c.customerPhone ?? '').includes(cust),
    )
  }
  const svc = hint.serviceHint?.trim().toLowerCase()
  if (svc) {
    pool = pool.filter((c) => (c.serviceName ?? '').toLowerCase().includes(svc))
  }

  if (pool.length === 0) return { kind: 'none' }
  if (pool.length === 1) return { kind: 'one', booking: pool[0]! }
  return { kind: 'ambiguous', candidates: pool }
}

// ── Deterministic resolver ──────────────────────────────────────────────────────
// I/O contract (pinned; the DB path is integration-level, no unit DB harness):
//   • booking missing                               → { ok:false, reason:'not_found' }
//   • not a held+pending request (already resolved) → { ok:false, reason:'already_resolved' } (idempotent)
//   • approve, immediate gate                       → held→confirmed,  approval='approved',
//                                                      mirror + customer-confirm notify + spend/reminders
//   • approve, post_payment gate                    → held→pending_payment, approval='approved',
//                                                      paymentStatus='pending' (payment-request worker sends the link)
//   • decline                                       → held→cancelled, approval='declined',
//                                                      reason 'declined_by_owner', delete hold event, notify customer + invite rebook
export type ResolveApprovalResult =
  | { ok: true; outcome: 'confirmed' | 'pending_payment' | 'declined'; bookingId: string }
  | { ok: false; reason: 'not_found' | 'already_resolved' | 'state_error' }

export async function resolveBookingApproval(
  db: Db,
  bookingId: string,
  decision: ApprovalDecision,
  actorId: string,
): Promise<ResolveApprovalResult> {
  const [booking] = await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1)
  if (!booking) return { ok: false, reason: 'not_found' }

  const [biz] = await db
    .select({ confirmationGate: businesses.confirmationGate })
    .from(businesses)
    .where(eq(businesses.id, booking.businessId))
    .limit(1)
  const confirmationGate = (biz?.confirmationGate ?? 'immediate') as 'immediate' | 'post_payment'

  const plan = nextApprovalResolution(booking.state, booking.approvalStatus, decision, confirmationGate)
  if (!plan.ok) return { ok: false, reason: 'already_resolved' }

  // Defence in depth: the pure plan already guarantees a held→target edge, but route the
  // write through the state machine so the deterministic core remains the single authority.
  const t = transition(booking.state, plan.targetState)
  if (!t.ok) return { ok: false, reason: 'state_error' }

  if (plan.targetState === 'confirmed') {
    await db
      .update(bookings)
      .set({ state: 'confirmed', approvalStatus: 'approved', holdExpiresAt: null, updatedAt: new Date() })
      .where(eq(bookings.id, bookingId))

    await logAudit(db, {
      businessId: booking.businessId,
      actorId,
      action: 'booking.approval_confirmed',
      entityType: 'booking',
      entityId: bookingId,
      beforeState: { state: 'held', approvalStatus: 'pending' },
      afterState: { state: 'confirmed', approvalStatus: 'approved' },
      metadata: { triggeredBy: 'owner_approval' },
    })

    // Reuse the existing confirm side-effects: durable calendar mirror, customer confirmation
    // notice, lifetime-spend + reminders. All best-effort (the state write already committed).
    await enqueueBookingMirror(booking.businessId, bookingId).catch(() => { /* non-fatal */ })
    await notifyBusinessBookingChange(db, booking.businessId, {
      kind: 'confirmed',
      bookingId,
      customerId: booking.customerId,
      serviceTypeId: booking.serviceTypeId,
      slotStart: booking.slotStart,
    }).catch(() => { /* non-fatal */ })
    await recordCompletedBooking(db, booking.businessId, booking.customerId, bookingId, booking.serviceTypeId)
      .catch(() => { /* non-fatal */ })
    await scheduleReminders(booking.businessId, booking.customerId, bookingId, booking.serviceTypeId, booking.slotStart)
      .catch(() => { /* non-fatal */ })

    // Deferred-cancel reschedule: now that the new slot is actually secured (owner-approved →
    // confirmed), release the original booking it supersedes — the held request carried the link.
    // Best-effort; never roll back the confirm on a release miss.
    if (booking.rescheduledFrom) {
      await releaseSupersededBooking(db, booking.businessId, booking.rescheduledFrom).catch(() => { /* non-fatal */ })
    }

    return { ok: true, outcome: 'confirmed', bookingId }
  }

  if (plan.targetState === 'pending_payment') {
    await db
      .update(bookings)
      .set({ state: 'pending_payment', approvalStatus: 'approved', paymentStatus: 'pending', updatedAt: new Date() })
      .where(eq(bookings.id, bookingId))

    await logAudit(db, {
      businessId: booking.businessId,
      actorId,
      action: 'booking.approval_pending_payment',
      entityType: 'booking',
      entityId: bookingId,
      beforeState: { state: 'held', approvalStatus: 'pending' },
      afterState: { state: 'pending_payment', approvalStatus: 'approved' },
      metadata: { triggeredBy: 'owner_approval' },
    })

    // Deferred-cancel reschedule: the owner has approved, so release the original this supersedes
    // (parity with the confirmed branch). Best-effort.
    if (booking.rescheduledFrom) {
      await releaseSupersededBooking(db, booking.businessId, booking.rescheduledFrom).catch(() => { /* non-fatal */ })
    }

    // The pay-link is sent by the existing payment-request worker, which scans
    // state='pending_payment' AND paymentStatus='pending'. No send here (approve-first-then-pay).
    return { ok: true, outcome: 'pending_payment', bookingId }
  }

  // decline → cancelled
  await db
    .update(bookings)
    .set({
      state: 'cancelled',
      approvalStatus: 'declined',
      cancellationReason: 'declined_by_owner',
      cancelledByRole: 'manager',
      holdExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(eq(bookings.id, bookingId))

  await logAudit(db, {
    businessId: booking.businessId,
    actorId,
    action: 'booking.approval_declined',
    entityType: 'booking',
    entityId: bookingId,
    beforeState: { state: 'held', approvalStatus: 'pending' },
    afterState: { state: 'cancelled', approvalStatus: 'declined', reason: 'declined_by_owner' },
    metadata: { triggeredBy: 'owner_approval' },
  })

  // Remove the reserved hold event from Google (no-op in internal mode / for internal: ids).
  if (booking.calendarEventId) {
    await enqueueBookingDeletion(booking.businessId, bookingId, booking.calendarEventId)
      .catch(() => { /* non-fatal */ })
  }

  await notifyCustomerApprovalDeclined(db, booking.businessId, {
    customerId: booking.customerId,
    serviceTypeId: booking.serviceTypeId,
    slotStart: booking.slotStart,
  }).catch(() => { /* non-fatal */ })

  return { ok: true, outcome: 'declined', bookingId }
}

// Cancel the original booking that an approved reschedule supersedes (deferred-cancel release,
// owner-approval path). DB + durable-mirror only — no calendar client needed (parity with the
// business-cancel writes in apply.ts). No customer notice: a reschedule is the customer's own move.
async function releaseSupersededBooking(db: Db, businessId: string, oldBookingId: string): Promise<void> {
  const [old] = await db.select().from(bookings).where(eq(bookings.id, oldBookingId)).limit(1)
  if (!old) return
  const t = transition(old.state, 'cancelled')
  if (!t.ok) return // already terminal — nothing to release

  await db
    .update(bookings)
    .set({ state: 'cancelled', cancellationReason: 'superseded_by_reschedule', cancelledByRole: 'customer', holdExpiresAt: null, updatedAt: new Date() })
    .where(eq(bookings.id, oldBookingId))

  if (old.calendarEventId) {
    await enqueueBookingDeletion(businessId, oldBookingId, old.calendarEventId).catch(() => { /* non-fatal */ })
  }
}
