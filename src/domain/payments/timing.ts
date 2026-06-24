// Pay-link send-timing decision — pure, no I/O, no `new Date()` inside (the worker passes
// `now` in). The owner picks WHEN the first pay-link goes out relative to the appointment
// (design §3.1); this translates that policy + the booking's slot_start into "is the link due
// this tick?". Structurally the payment analog of the reminder.24h/reminder.1h offset math.

export type PaymentLinkSendPolicy = 'at_booking' | 'offset'

// Clamp the owner-set offset to a sane band so a fat-fingered value can't push the send wildly
// out (±7 days). Negative = before slot_start, positive = after.
export const PAYMENT_OFFSET_MIN_MINUTES = -7 * 24 * 60
export const PAYMENT_OFFSET_MAX_MINUTES = 7 * 24 * 60

export function clampPaymentOffsetMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return 0
  const rounded = Math.round(minutes)
  return Math.max(PAYMENT_OFFSET_MIN_MINUTES, Math.min(PAYMENT_OFFSET_MAX_MINUTES, rounded))
}

/**
 * Whether the first pay-link for a pending_payment booking is due to be sent now.
 *
 *  - 'at_booking' (default): always due — the booking is already in pending_payment, so the
 *    link goes out on the next scan (reproduces today's send-on-booking behavior).
 *  - 'offset': due once `now >= slot_start + offsetMinutes`. offsetMinutes is negative to send
 *    BEFORE the slot (e.g. -1440 → 24h before), positive to send after. A null/undefined offset
 *    or a missing slot_start degrades safely to at_booking (send now rather than never).
 */
export function isPaymentLinkDue(
  policy: PaymentLinkSendPolicy | null | undefined,
  offsetMinutes: number | null | undefined,
  slotStart: Date | null | undefined,
  now: Date,
): boolean {
  if (policy !== 'offset') return true
  if (offsetMinutes == null || !slotStart) return true
  const sendAt = slotStart.getTime() + offsetMinutes * 60_000
  return now.getTime() >= sendAt
}
