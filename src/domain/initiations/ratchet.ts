// Trust ratchet (Phase 6; design §5) — pure. The owner-confirm gate is training wheels, not a
// permanent fixture: each (business, category) accrues a track record of owner approve/decline
// decisions. When precision clears θ over a minimum sample, the category auto-PROMOTES
// ai_proposed → owner_configured (stop confirming each send; fire under the gate, surface only
// anomalies). A post-promotion opt-out spike auto-DEMOTES (safety backstop). The owner can veto a
// promotion (vetoed=true → never auto-promote again). This is the single mechanism that converts a
// safe system into a zero-attention one. Pure; the autonomy repository + 6.2 wiring are the I/O.

export type AutonomyState = 'ai_proposed' | 'owner_configured'
export type RatchetVerdict = 'promote' | 'demote' | 'hold'

export interface RatchetHistory {
  approved: number
  declined: number
}

export interface RecentSends {
  total: number   // category sends in the post-promotion window
  optOuts: number // recipients among them who then opted out
}

export interface RatchetConfig {
  minSample: number        // N — don't promote before this many decided proposals
  promotePrecision: number // θ — approve/(approve+decline) must reach this to promote
  demoteOptOutRate: number // demote when opt-out rate among recent sends exceeds this
  demoteMinOptOuts: number // ...and at least this many opt-outs (absolute backstop)
}

// Conservative interim defaults (design open-Q4 "start strict"; owner-approved).
export const DEFAULT_RATCHET: RatchetConfig = {
  minSample: 5,
  promotePrecision: 0.8,
  demoteOptOutRate: 0.2,
  demoteMinOptOuts: 2,
}

/**
 * Decide the ratchet move for a (business, category). Demote is checked first as the safety
 * backstop: a promoted category with an opt-out spike falls back to ai_proposed. An ai_proposed
 * category promotes when precision >= θ over >= N decided proposals, unless the owner vetoed.
 */
export function evaluateRatchet(
  state: AutonomyState,
  vetoed: boolean,
  history: RatchetHistory,
  recentSends: RecentSends,
  cfg: RatchetConfig = DEFAULT_RATCHET,
): RatchetVerdict {
  if (state === 'owner_configured') {
    if (
      recentSends.total > 0 &&
      recentSends.optOuts >= cfg.demoteMinOptOuts &&
      recentSends.optOuts / recentSends.total > cfg.demoteOptOutRate
    ) {
      return 'demote'
    }
    return 'hold'
  }
  // state === 'ai_proposed'
  if (vetoed) return 'hold'
  const decided = history.approved + history.declined
  if (decided >= cfg.minSample && history.approved / decided >= cfg.promotePrecision) return 'promote'
  return 'hold'
}
