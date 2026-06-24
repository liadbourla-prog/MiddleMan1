// Attention budget (Phase 5.3; design §4.4) — pure. The per-customer promotional budget is a
// knapsack, NOT independent per-category rate limits: when several promotional initiations are
// eligible, they COMPETE by priority × expValue and the budget admits the best until spent; the
// rest are deferred with a logged reason ("failure is explicit"). The dispatcher enforces this as
// a rolling window by passing the already-spent count + the single current candidate; the same
// function handles multi-candidate contention (the §4.4 test). expValue defaults to 1 until Phase 6
// supplies value models, so today ranking is effectively by priority.

// Conservative interim defaults (design open-Q3): ≈1 promotional send per 7 days, transactional
// unlimited. Tunable per-business later (Phase 5.5).
export const DEFAULT_PROMOTIONAL_BUDGET = 1
export const PROMOTIONAL_BUDGET_WINDOW_DAYS = 7

export interface BudgetCandidate {
  id: string        // initiator id, echoed in the decision
  priority: number  // higher = more important (contention rank)
  expValue: number  // expected value; defaults to 1 until Phase 6
}

export interface BudgetAllocation {
  id: string
  admit: boolean
  reason?: 'budget_exhausted'
}

/**
 * Admit candidates against a rolling budget. `alreadySpent` is how many promotional sends the
 * customer already received this window; `budget` is the cap. Candidates are ranked by
 * priority × expValue (descending; stable by input order on ties) and admitted until the
 * remaining budget is spent. The rest are deferred with reason 'budget_exhausted'.
 */
export function allocateBudget(
  candidates: BudgetCandidate[],
  alreadySpent: number,
  budget: number,
): BudgetAllocation[] {
  const remaining = Math.max(0, budget - alreadySpent)
  // Stable sort by score desc: decorate with original index for deterministic ties.
  const ranked = candidates
    .map((c, i) => ({ c, i, score: c.priority * c.expValue }))
    .sort((a, b) => (b.score - a.score) || (a.i - b.i))
  // Rank-and-slice by index (not id) to stay correct even if two candidates share an id.
  const admittedIndices = new Set(ranked.slice(0, remaining).map((r) => r.i))
  // Preserve input order in the result.
  return candidates.map((c, idx) =>
    admittedIndices.has(idx)
      ? { id: c.id, admit: true }
      : { id: c.id, admit: false, reason: 'budget_exhausted' as const },
  )
}
