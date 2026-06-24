// Blast-radius circuit breaker (Phase 5.4; design §4.6) — pure. A mass campaign (cold-fill batch,
// broadcast, dunning sweep) consults this before each send. It enforces a hard per-run ceiling and,
// after a minimum sample, ABORTS the rest of the run if the error or opt-out rate spikes — so a bad
// template or segment can't hit hundreds before anyone notices ("failure is explicit" at scale,
// CLAUDE.md Principle 5). Generalizes reshuffle's batchSize / maxOutreachPerCampaign caps.

export interface BlastBreakerConfig {
  maxPerRun: number             // hard ceiling on sends in one campaign run; 0 = unlimited
  minSampleK: number            // don't evaluate rate-aborts until this many attempts
  abortIfErrorRateOver: number  // 0..1 — abort when errors/attempts exceeds this (after K)
  abortIfOptOutRateOver: number // 0..1 — abort when optOuts/attempts exceeds this (after K)
}

export interface BlastTally {
  sent: number     // successful sends so far
  optOuts: number  // recipients skipped as opted-out so far
  errors: number   // send failures so far
}

export type BlastVerdict = 'continue' | 'ceiling_reached' | 'abort_error_spike' | 'abort_optout_spike'

// Conservative interim defaults (tunable per-business later, Phase 5.5).
export const DEFAULT_BLAST_BREAKER: BlastBreakerConfig = {
  maxPerRun: 200,
  minSampleK: 5,
  abortIfErrorRateOver: 0.3,
  abortIfOptOutRateOver: 0.2,
}

/**
 * Decide whether a campaign run may continue given its running tally. Ceiling is checked first;
 * then, once at least minSampleK attempts have been made, an error-rate spike (checked before
 * opt-out) or opt-out-rate spike aborts the run. Otherwise continue.
 */
export function evaluateBlastBreaker(tally: BlastTally, cfg: BlastBreakerConfig): BlastVerdict {
  if (cfg.maxPerRun > 0 && tally.sent >= cfg.maxPerRun) return 'ceiling_reached'
  const attempts = tally.sent + tally.optOuts + tally.errors
  if (attempts >= cfg.minSampleK) {
    if (tally.errors / attempts > cfg.abortIfErrorRateOver) return 'abort_error_spike'
    if (tally.optOuts / attempts > cfg.abortIfOptOutRateOver) return 'abort_optout_spike'
  }
  return 'continue'
}

/** Merge an initiator's optional partial breaker config over the defaults. */
export function resolveBlastBreaker(partial: Partial<BlastBreakerConfig> | undefined): BlastBreakerConfig {
  return { ...DEFAULT_BLAST_BREAKER, ...(partial ?? {}) }
}
