import { describe, it, expect } from 'vitest'
import { dunningActiveWindow, dunningTierForAge, initiatorIdForTier } from './dunning.js'

const HOUR = 60 * 60 * 1000
const NOW = new Date('2026-06-22T12:00:00Z')

describe('dunningActiveWindow', () => {
  it('opens 96h back (give-up bound) and closes 2h back (tier-1 entry)', () => {
    const w = dunningActiveWindow(NOW)
    expect(w.after).toEqual(new Date(NOW.getTime() - 96 * HOUR))
    expect(w.before).toEqual(new Date(NOW.getTime() - 2 * HOUR))
  })

  it('after is always strictly earlier than before (non-empty band)', () => {
    const w = dunningActiveWindow(NOW)
    expect(w.after.getTime()).toBeLessThan(w.before.getTime())
  })
})

describe('dunningTierForAge', () => {
  // Truth table over half-open bands: [2h,24h)→1, [24h,72h)→2, [72h,96h)→final, else null.
  const cases: Array<{ name: string; hoursOld: number; tier: ReturnType<typeof dunningTierForAge> }> = [
    { name: '1h old — too fresh', hoursOld: 1, tier: null },
    { name: '2h old — tier 1 entry', hoursOld: 2, tier: 'dunning_1' },
    { name: '23h old — still tier 1', hoursOld: 23, tier: 'dunning_1' },
    { name: '24h old — tier 2 entry', hoursOld: 24, tier: 'dunning_2' },
    { name: '71h old — still tier 2', hoursOld: 71, tier: 'dunning_2' },
    { name: '72h old — final entry', hoursOld: 72, tier: 'dunning_final' },
    { name: '95h old — still final', hoursOld: 95, tier: 'dunning_final' },
    { name: '96h old — give up', hoursOld: 96, tier: null },
    { name: '200h old — long gone', hoursOld: 200, tier: null },
  ]
  for (const c of cases) {
    it(`age ${c.name} → tier=${c.tier}`, () => {
      expect(dunningTierForAge(c.hoursOld * HOUR)).toBe(c.tier)
    })
  }
})

describe('initiatorIdForTier', () => {
  it('maps each tier to its registry initiator id', () => {
    expect(initiatorIdForTier('dunning_1')).toBe('payment.dunning_1')
    expect(initiatorIdForTier('dunning_2')).toBe('payment.dunning_2')
    expect(initiatorIdForTier('dunning_final')).toBe('payment.dunning_final')
  })
})
