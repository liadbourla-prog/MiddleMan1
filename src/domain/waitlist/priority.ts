// Waitlist priority tiering — PURE ranking over the pending entries for one freed slot. No I/O.
//
// Owner rule (LOCKED, plan §3.2): a waiting customer with NO active booking in the next 7 days
// is offered the freed seat AHEAD of one who already has a session that week. FIFO is preserved
// *within* each tier. This module is the pure decision; the worker (workers/waitlist.ts) loads
// the pending entries + each candidate's active bookings in the window, then calls this to order
// them. Mirrors the pure-core discipline of crm/cold-fill.ts and waitlist/freed-slot-policy.ts
// (returns an ordering; caller executes the CAS flip + send).

/** The minimal shape a candidate must expose to be ranked. */
export interface RankableEntry {
  id: string
  customerId: string
  createdAt: Date
}

/**
 * Rank the pending waitlist candidates for one freed slot.
 *
 * Tier 1 (offered first) = `hasCommitmentInWindow(entry) === false` — no active booking in
 * `[now, now + 7 days]`. Tier 2 = `true`. Within each tier, oldest `createdAt` first (FIFO).
 *
 * Pure and deterministic: returns a NEW ordered array, never mutates the input, and the sort is
 * STABLE — equal-tier/equal-`createdAt` entries keep their original relative order.
 */
export function rankWaitlistCandidates<T extends RankableEntry>(
  entries: T[],
  hasCommitmentInWindow: (entry: T) => boolean,
): T[] {
  // Decorate with original index so the comparator can fall back to it for a stable sort
  // (Array.prototype.sort is not guaranteed stable across all engines for our key shape).
  return entries
    .map((entry, index) => ({ entry, index, tier: hasCommitmentInWindow(entry) ? 1 : 0 }))
    .sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier // tier 0 (no commitment) first
      const byCreated = a.entry.createdAt.getTime() - b.entry.createdAt.getTime()
      if (byCreated !== 0) return byCreated // oldest createdAt first (FIFO)
      return a.index - b.index // stable: preserve original order
    })
    .map(({ entry }) => entry)
}

/**
 * Label a single entry's tier for audit/owner-read use (the worker tags `waitlist.offer_sent`;
 * WL-9's owner read-side shows it). `priority` = no commitment (tier 1); `normal` = has one.
 */
export function waitlistTier(hasCommitment: boolean): 'priority' | 'normal' {
  return hasCommitment ? 'normal' : 'priority'
}
