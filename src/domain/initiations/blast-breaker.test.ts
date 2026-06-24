import { describe, it, expect } from 'vitest'
import {
  evaluateBlastBreaker,
  resolveBlastBreaker,
  DEFAULT_BLAST_BREAKER,
} from './blast-breaker.js'
import type { BlastBreakerConfig, BlastTally } from './blast-breaker.js'

describe('evaluateBlastBreaker', () => {
  const cfg = DEFAULT_BLAST_BREAKER

  it('healthy tally → continue', () => {
    const tally: BlastTally = { sent: 10, optOuts: 0, errors: 0 }
    expect(evaluateBlastBreaker(tally, cfg)).toBe('continue')
  })

  it('sample too small → continue even at 100% error rate (headline guard against premature abort)', () => {
    // errors=2, attempts=2 < minSampleK (5): do not abort yet.
    const tally: BlastTally = { sent: 0, optOuts: 0, errors: 2 }
    expect(evaluateBlastBreaker(tally, cfg)).toBe('continue')
  })

  it('after K, error rate over threshold → abort_error_spike', () => {
    // sent=3, errors=4 → attempts 7, 4/7 ≈ 0.57 > 0.3.
    const tally: BlastTally = { sent: 3, optOuts: 0, errors: 4 }
    expect(evaluateBlastBreaker(tally, cfg)).toBe('abort_error_spike')
  })

  it('after K, opt-out rate over threshold (error under) → abort_optout_spike', () => {
    // sent=4, optOuts=4, errors=0 → attempts 8, optOuts 0.5 > 0.2, errors 0.
    const tally: BlastTally = { sent: 4, optOuts: 4, errors: 0 }
    expect(evaluateBlastBreaker(tally, cfg)).toBe('abort_optout_spike')
  })

  it('error spike takes precedence over opt-out spike when both exceed', () => {
    // sent=2, optOuts=4, errors=4 → attempts 10, errors 0.4 > 0.3, optOuts 0.4 > 0.2.
    const tally: BlastTally = { sent: 2, optOuts: 4, errors: 4 }
    expect(evaluateBlastBreaker(tally, cfg)).toBe('abort_error_spike')
  })

  it('ceiling checked before rate logic: tally hitting ceiling AND error-abort → ceiling_reached', () => {
    const ceilingCfg: BlastBreakerConfig = { ...cfg, maxPerRun: 5 }
    // sent=5 hits ceiling; errors=4 would also error-abort — ceiling wins.
    const tally: BlastTally = { sent: 5, optOuts: 0, errors: 4 }
    expect(evaluateBlastBreaker(tally, ceilingCfg)).toBe('ceiling_reached')
  })

  it('§4.6 headline: high error rate after K aborts BEFORE reaching the ceiling', () => {
    const ceilingCfg: BlastBreakerConfig = { ...cfg, maxPerRun: 200 }
    // sent=3 (< 200 ceiling), errors=4 → attempts 7, 4/7 > 0.3.
    const tally: BlastTally = { sent: 3, optOuts: 0, errors: 4 }
    expect(tally.sent).toBeLessThan(ceilingCfg.maxPerRun)
    expect(evaluateBlastBreaker(tally, ceilingCfg)).toBe('abort_error_spike')
  })
})

describe('resolveBlastBreaker', () => {
  it('undefined → DEFAULT_BLAST_BREAKER', () => {
    expect(resolveBlastBreaker(undefined)).toEqual(DEFAULT_BLAST_BREAKER)
  })

  it('partial overrides only the given key', () => {
    expect(resolveBlastBreaker({ minSampleK: 2 })).toEqual({
      ...DEFAULT_BLAST_BREAKER,
      minSampleK: 2,
    })
  })
})
