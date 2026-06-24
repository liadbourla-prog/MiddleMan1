// Payment-dunning tier math — pure, no I/O, no `new Date()` inside the decision functions
// (the worker passes `now` in). A booking sits in internal `pending_payment` state from the
// moment payment becomes due (engine.requestBooking sets it right after row creation, so
// `createdAt` ≈ that moment). The dunning worker ticks hourly; these helpers translate the
// booking's age — `now - createdAt` — into which escalating rung is due this tick. The bands
// are half-open so each age maps to exactly one rung; per-booking+tier dedup in the
// initiation_log ledger makes the hourly scan idempotent.

const HOUR_MS = 60 * 60 * 1000

export type DunningTier = 'dunning_1' | 'dunning_2' | 'dunning_final'

// Age thresholds (ms) since the booking entered pending_payment (anchored on createdAt).
// Tunable in Phase 5; baked-in defaults here.
//   tier 1     : age in [2h, 24h)
//   tier 2     : age in [24h, 72h)
//   tier final : age in [72h, 96h)
//   else (<2h or >=96h): no send (give up after the final window)
export const DUNNING_1_AFTER_MS = 2 * HOUR_MS
export const DUNNING_2_AFTER_MS = 24 * HOUR_MS
export const DUNNING_FINAL_AFTER_MS = 72 * HOUR_MS
export const DUNNING_GIVE_UP_MS = 96 * HOUR_MS

/**
 * The DB-scan bound: bookings whose `createdAt` is in [now-96h, now-2h] are candidates for
 * SOME rung this tick. `after = now - GIVE_UP` (oldest still worth a final notice), `before =
 * now - DUNNING_1_AFTER` (youngest that has aged into rung 1). Per-row age then picks the rung.
 */
export function dunningActiveWindow(now: Date): { after: Date; before: Date } {
  const ms = now.getTime()
  return {
    after: new Date(ms - DUNNING_GIVE_UP_MS),
    before: new Date(ms - DUNNING_1_AFTER_MS),
  }
}

/**
 * Which dunning rung is due for a booking of the given age (ms since it entered
 * pending_payment). Half-open bands: [2h,24h)→1, [24h,72h)→2, [72h,96h)→final.
 * Returns null when too fresh (<2h) or past the final window (>=96h — give up).
 */
export function dunningTierForAge(ageMs: number): DunningTier | null {
  if (ageMs < DUNNING_1_AFTER_MS) return null
  if (ageMs < DUNNING_2_AFTER_MS) return 'dunning_1'
  if (ageMs < DUNNING_FINAL_AFTER_MS) return 'dunning_2'
  if (ageMs < DUNNING_GIVE_UP_MS) return 'dunning_final'
  return null
}

// Each tier maps to its registry initiator id. An explicit map (not a template literal) keeps
// the result type narrow so getInitiator() type-checks against the registry.
const TIER_INITIATOR: Record<DunningTier, 'payment.dunning_1' | 'payment.dunning_2' | 'payment.dunning_final'> = {
  dunning_1: 'payment.dunning_1',
  dunning_2: 'payment.dunning_2',
  dunning_final: 'payment.dunning_final',
}

/** Resolve the registry initiator id for a dunning tier (type-safe against the registry). */
export function initiatorIdForTier(tier: DunningTier): 'payment.dunning_1' | 'payment.dunning_2' | 'payment.dunning_final' {
  return TIER_INITIATOR[tier]
}
