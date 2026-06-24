import { describe, it, expect } from 'vitest'
import {
  renewalScanWindow,
  renewal7dWindow,
  renewal1dWindow,
  renewalTierForRenewsAt,
  initiatorIdForRenewalTier,
} from './subscription-renewal.js'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const NOW = new Date('2026-06-23T12:00:00Z')

describe('renewalScanWindow', () => {
  it('opens at now and closes 7d ahead', () => {
    const w = renewalScanWindow(NOW)
    expect(w.after).toEqual(NOW)
    expect(w.before).toEqual(new Date(NOW.getTime() + 7 * DAY))
  })

  it('after is always strictly earlier than before (non-empty band)', () => {
    const w = renewalScanWindow(NOW)
    expect(w.after.getTime()).toBeLessThan(w.before.getTime())
  })
})

describe('renewal7dWindow', () => {
  it('spans [now+6d, now+7d]', () => {
    const w = renewal7dWindow(NOW)
    expect(w.after).toEqual(new Date(NOW.getTime() + 6 * DAY))
    expect(w.before).toEqual(new Date(NOW.getTime() + 7 * DAY))
  })

  it('after is strictly earlier than before (non-empty band)', () => {
    const w = renewal7dWindow(NOW)
    expect(w.after.getTime()).toBeLessThan(w.before.getTime())
  })
})

describe('renewal1dWindow', () => {
  it('spans [now, now+1d]', () => {
    const w = renewal1dWindow(NOW)
    expect(w.after).toEqual(NOW)
    expect(w.before).toEqual(new Date(NOW.getTime() + 1 * DAY))
  })

  it('after is strictly earlier than before (non-empty band)', () => {
    const w = renewal1dWindow(NOW)
    expect(w.after.getTime()).toBeLessThan(w.before.getTime())
  })
})

describe('renewalTierForRenewsAt', () => {
  // Truth table over the disjoint bands: 1d → [now, now+1d], 7d → [now+6d, now+7d], gap and
  // out-of-range → null. offsetMs is added to NOW to build `renewsAt`.
  const cases: Array<{ name: string; offsetMs: number; tier: ReturnType<typeof renewalTierForRenewsAt> }> = [
    { name: 'now — in 1d window', offsetMs: 0, tier: 'renewal_1d' },
    { name: '+12h — 1d window', offsetMs: 12 * HOUR, tier: 'renewal_1d' },
    { name: '+1d — 1d boundary', offsetMs: 1 * DAY, tier: 'renewal_1d' },
    { name: '+2d — the gap', offsetMs: 2 * DAY, tier: null },
    { name: '+6d — 7d boundary', offsetMs: 6 * DAY, tier: 'renewal_7d' },
    { name: '+6.5d — 7d window', offsetMs: 6.5 * DAY, tier: 'renewal_7d' },
    { name: '+7d — 7d boundary', offsetMs: 7 * DAY, tier: 'renewal_7d' },
    { name: '+8d — beyond range', offsetMs: 8 * DAY, tier: null },
    { name: '-1h — past', offsetMs: -1 * HOUR, tier: null },
  ]
  for (const c of cases) {
    it(`renewsAt ${c.name} → tier=${c.tier}`, () => {
      expect(renewalTierForRenewsAt(NOW, new Date(NOW.getTime() + c.offsetMs))).toBe(c.tier)
    })
  }
})

describe('initiatorIdForRenewalTier', () => {
  it('maps each tier to its registry initiator id', () => {
    expect(initiatorIdForRenewalTier('renewal_7d')).toBe('subscription.renewal_7d')
    expect(initiatorIdForRenewalTier('renewal_1d')).toBe('subscription.renewal_1d')
  })
})
