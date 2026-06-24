// Cold-fill candidate selection — PURE ranking over a lapsed customer segment. No I/O.
// The growth rung of the fill cascade (§7.5): when waitlist + freed-slot offers are
// exhausted, invite the best-fit lapsed customers to take the open capacity. The worker
// (workers/waitlist.ts) fetches the segment and performs the sends; this module only
// decides *who*. Mirrors the pure-core discipline of coordination/state.ts and
// initiations/gate.ts (returns a decision; caller executes).

import type { CustomerSummary } from '../../shared/skill-types.js'

// Exclude customers who flake on half or more of their completed appointments — inviting
// them to a freed slot risks re-freezing it. The backstop is the booking flow's
// availability check, but selection should not lean on unreliable invitees.
const NO_SHOW_EXCLUSION_THRESHOLD = 0.5

/**
 * Rank a lapsed segment for a freed slot and return the best `batchSize` to invite.
 *
 * Best fit = instructor-match first (when the freed slot has a known instructor, customers
 * whose usual instructor is that person rank above everyone else — the strongest fit signal
 * in a studio/salon), then warmest: most-recently-active (`lastBookingAt` desc), tie-broken
 * by lower `noShowRate` (more reliable). Customers with `noShowRate >= 0.5` are excluded.
 * Pure: no clock, no I/O.
 */
export function selectColdFillCandidates(
  candidates: CustomerSummary[],
  opts: { batchSize: number; slotProviderId?: string | null },
): CustomerSummary[] {
  const slotProvider = opts.slotProviderId ?? null
  return candidates
    .filter((c) => (c.noShowRate ?? 0) < NO_SHOW_EXCLUSION_THRESHOLD)
    .sort((a, b) => {
      if (slotProvider) {
        const aFit = a.preferredProviderId === slotProvider ? 1 : 0
        const bFit = b.preferredProviderId === slotProvider ? 1 : 0
        if (bFit !== aFit) return bFit - aFit // customers of this instructor first
      }
      const aLast = a.lastBookingAt ? a.lastBookingAt.getTime() : 0
      const bLast = b.lastBookingAt ? b.lastBookingAt.getTime() : 0
      if (bLast !== aLast) return bLast - aLast // most-recently-active first
      return (a.noShowRate ?? 0) - (b.noShowRate ?? 0) // tie-break: lower no-show rate
    })
    .slice(0, Math.max(0, opts.batchSize))
}
