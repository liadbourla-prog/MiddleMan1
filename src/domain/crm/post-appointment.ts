// Post-appointment due-window math — pure, no I/O. The post-appointment worker ticks
// hourly; these helpers translate "now" into the booking time-ranges that are due for an
// autonomous customer send this tick. Tick-tolerant windows (a band, not a point) make the
// hourly scan idempotent at the booking level via the initiation_log dedup ledger.

const HOUR_MS = 60 * 60 * 1000

// Review request: ~1 day after the appointment ended. A 24h-wide band [now-48h, now-24h]
// means a booking whose slotEnd lands in that band is "about a day ago" — the band absorbs
// tick jitter while the per-booking dedupKey guarantees exactly one review per booking.
const REVIEW_AFTER_MS = 48 * HOUR_MS
const REVIEW_BEFORE_MS = 24 * HOUR_MS

// No-show follow-up: gentle nudge soon after a missed appointment. A booking marked no_show
// is due as long as its slotStart is within the last 48h (a one-sided lower bound — the
// dedup ledger prevents a second nudge once the first has fired).
const NO_SHOW_LOOKBACK_MS = 48 * HOUR_MS

/**
 * Attended bookings whose slotEnd falls in [now-48h, now-24h] are due for a review request.
 * `after` is the inclusive lower bound, `before` the inclusive upper bound on slotEnd.
 */
export function reviewDueWindow(now: Date): { after: Date; before: Date } {
  const ms = now.getTime()
  return {
    after: new Date(ms - REVIEW_AFTER_MS),
    before: new Date(ms - REVIEW_BEFORE_MS),
  }
}

/**
 * No_show bookings with slotStart >= now-48h are due for a follow-up.
 * `after` is the inclusive lower bound on slotStart.
 */
export function noShowFollowupWindow(now: Date): { after: Date } {
  return { after: new Date(now.getTime() - NO_SHOW_LOOKBACK_MS) }
}
