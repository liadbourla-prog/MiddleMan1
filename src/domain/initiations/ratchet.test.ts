import { describe, it, expect } from 'vitest'
import { evaluateRatchet } from './ratchet.js'
import type { RatchetConfig } from './ratchet.js'

// The design's named "trust-ratchet test": the truth table over precision/sample (promote),
// veto (block), and post-promotion opt-out spike (demote).
describe('evaluateRatchet', () => {
  it('ai_proposed, 5 decided all approved (5/0) → promote', () => {
    expect(evaluateRatchet('ai_proposed', false, { approved: 5, declined: 0 }, { total: 0, optOuts: 0 })).toBe('promote')
  })

  it('ai_proposed, 4/0 (below minSample) → hold', () => {
    expect(evaluateRatchet('ai_proposed', false, { approved: 4, declined: 0 }, { total: 0, optOuts: 0 })).toBe('hold')
  })

  it('ai_proposed, 4 approved 1 declined (0.8 exactly, 5 sample) → promote (>= θ)', () => {
    expect(evaluateRatchet('ai_proposed', false, { approved: 4, declined: 1 }, { total: 0, optOuts: 0 })).toBe('promote')
  })

  it('ai_proposed, 3 approved 2 declined (0.6) → hold', () => {
    expect(evaluateRatchet('ai_proposed', false, { approved: 3, declined: 2 }, { total: 0, optOuts: 0 })).toBe('hold')
  })

  it('ai_proposed but vetoed=true, 5/0 → hold (veto blocks promotion)', () => {
    expect(evaluateRatchet('ai_proposed', true, { approved: 5, declined: 0 }, { total: 0, optOuts: 0 })).toBe('hold')
  })

  it('owner_configured, recentSends {total:10, optOuts:3} (0.3 > 0.2, >=2) → demote', () => {
    expect(evaluateRatchet('owner_configured', false, { approved: 0, declined: 0 }, { total: 10, optOuts: 3 })).toBe('demote')
  })

  it('owner_configured, recentSends {total:10, optOuts:1} (1 < demoteMinOptOuts) → hold', () => {
    expect(evaluateRatchet('owner_configured', false, { approved: 0, declined: 0 }, { total: 10, optOuts: 1 })).toBe('hold')
  })

  it('owner_configured, recentSends {total:5, optOuts:2} (0.4 > 0.2, >=2) → demote', () => {
    expect(evaluateRatchet('owner_configured', false, { approved: 0, declined: 0 }, { total: 5, optOuts: 2 })).toBe('demote')
  })

  it('owner_configured, recentSends {total:0, optOuts:0} → hold (no sends yet)', () => {
    expect(evaluateRatchet('owner_configured', false, { approved: 0, declined: 0 }, { total: 0, optOuts: 0 })).toBe('hold')
  })

  it('owner_configured, healthy (total:20, optOuts:1) → hold', () => {
    expect(evaluateRatchet('owner_configured', false, { approved: 0, declined: 0 }, { total: 20, optOuts: 1 })).toBe('hold')
  })

  it('custom cfg (minSample:3) promotes earlier', () => {
    const cfg: RatchetConfig = { minSample: 3, promotePrecision: 0.8, demoteOptOutRate: 0.2, demoteMinOptOuts: 2 }
    expect(evaluateRatchet('ai_proposed', false, { approved: 3, declined: 0 }, { total: 0, optOuts: 0 }, cfg)).toBe('promote')
  })
})
