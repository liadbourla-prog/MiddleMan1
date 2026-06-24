// Subscription renewal-reminder tier math — pure, no I/O, no `new Date()` inside the decision
// functions (the worker passes `now` in). A subscription's `renewsAt` is the anchor; there is
// NO external processor, so these helpers only decide which time-before reminder rung is due
// this tick. The renewal worker ticks daily; `renewalScanWindow` bounds the DB scan to active
// subscriptions renewing within the next 7 days, and per-row `renewalTierForRenewsAt` picks the
// rung. The windows are disjoint bands so each `renewsAt` maps to at most one rung; per
// subscription+cycle dedup in the initiation_log ledger makes the daily scan idempotent.

const DAY_MS = 24 * 60 * 60 * 1000

export type RenewalTier = 'renewal_7d' | 'renewal_1d'

// How far before `renewsAt` each rung fires.
//   7d rung : renewsAt in [now+6d, now+7d]
//   1d rung : renewsAt in [now,    now+1d]
// (a gap in (now+1d, now+6d) — no reminder there.)
export const RENEWAL_7D_BEFORE_MS = 7 * DAY_MS
export const RENEWAL_1D_BEFORE_MS = 1 * DAY_MS

/**
 * The DB-scan bound: active subscriptions whose `renewsAt` is in [now, now+7d] are candidates
 * for SOME rung this tick. Per-row tier selection then picks the exact rung (or skips).
 */
export function renewalScanWindow(now: Date): { after: Date; before: Date } {
  const ms = now.getTime()
  return {
    after: now,
    before: new Date(ms + RENEWAL_7D_BEFORE_MS),
  }
}

/**
 * 7d reminder band: `renewsAt` in [now+6d, now+7d] → the 7-days-before rung is due.
 */
export function renewal7dWindow(now: Date): { after: Date; before: Date } {
  const ms = now.getTime()
  return {
    after: new Date(ms + RENEWAL_7D_BEFORE_MS - RENEWAL_1D_BEFORE_MS),
    before: new Date(ms + RENEWAL_7D_BEFORE_MS),
  }
}

/**
 * 1d reminder band: `renewsAt` in [now, now+1d] → the 1-day-before rung is due.
 */
export function renewal1dWindow(now: Date): { after: Date; before: Date } {
  const ms = now.getTime()
  return {
    after: now,
    before: new Date(ms + RENEWAL_1D_BEFORE_MS),
  }
}

/**
 * Which renewal rung is due for a subscription renewing at `renewsAt`. Checks the 1d band
 * first (it takes precedence; the bands don't overlap so order is moot, but 1d wins). Returns
 * null when `renewsAt` is in the past, in the gap (now+1d, now+6d), or beyond now+7d.
 */
export function renewalTierForRenewsAt(now: Date, renewsAt: Date): RenewalTier | null {
  const t = renewsAt.getTime()
  const w1 = renewal1dWindow(now)
  if (t >= w1.after.getTime() && t <= w1.before.getTime()) return 'renewal_1d'
  const w7 = renewal7dWindow(now)
  if (t >= w7.after.getTime() && t <= w7.before.getTime()) return 'renewal_7d'
  return null
}

// Each tier maps to its registry initiator id. An explicit map (not a template literal) keeps
// the result type narrow so getInitiator() type-checks against the registry.
const TIER_INITIATOR: Record<RenewalTier, 'subscription.renewal_7d' | 'subscription.renewal_1d'> = {
  renewal_7d: 'subscription.renewal_7d',
  renewal_1d: 'subscription.renewal_1d',
}

/** Resolve the registry initiator id for a renewal tier (type-safe against the registry). */
export function initiatorIdForRenewalTier(tier: RenewalTier): 'subscription.renewal_7d' | 'subscription.renewal_1d' {
  return TIER_INITIATOR[tier]
}
