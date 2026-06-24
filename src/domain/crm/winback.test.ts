import { describe, it, expect } from 'vitest'
import { buildWinbackProposal, epochDay } from './winback.js'
import type { CustomerSummary } from '../../shared/skill-types.js'

const NOW = new Date('2026-06-22T12:00:00Z')

// A normal lapsed candidate: visited 40 days ago, ~14d cadence, low no-show.
const base: CustomerSummary = {
  identityId: 'cust-1',
  phoneNumber: '+972500000000',
  displayName: 'Dana',
  totalBookings: 6,
  lastBookingAt: new Date('2026-05-13T10:00:00Z'), // 40 days before NOW
  cadenceDays: 14,
  preferredServiceTypeId: 'svc-a',
  preferredDayOfWeek: 2,
  preferredTimeBand: 'evening',
  noShowRate: 0.1,
  vip: false,
}

describe('epochDay', () => {
  it('floors to the UTC epoch-day bucket (stable within a calendar day)', () => {
    expect(epochDay(new Date('2026-05-13T00:00:00Z'))).toBe(epochDay(new Date('2026-05-13T23:59:59Z')))
    // 2026-05-13 is day 20586 since 1970-01-01.
    expect(epochDay(new Date('2026-05-13T10:00:00Z'))).toBe(20586)
    // The next UTC day buckets one higher.
    expect(epochDay(new Date('2026-05-14T00:00:00Z'))).toBe(20587)
  })
})

describe('buildWinbackProposal — skip conditions', () => {
  it('skips when there is no lastBookingAt', () => {
    expect(buildWinbackProposal({ ...base, lastBookingAt: null }, 'Glow Studio', 'en', NOW)).toBeNull()
  })

  it('skips an ancient one-timer (>180 days since last visit)', () => {
    const ancient = { ...base, lastBookingAt: new Date('2025-12-01T10:00:00Z') } // 203 days before NOW
    expect(buildWinbackProposal(ancient, 'Glow Studio', 'en', NOW)).toBeNull()
  })

  it('keeps a candidate exactly at the 180-day boundary', () => {
    const exactly180 = { ...base, lastBookingAt: new Date(NOW.getTime() - 180 * 86_400_000) }
    expect(buildWinbackProposal(exactly180, 'Glow Studio', 'en', NOW)).not.toBeNull()
  })

  it('skips a chronic no-show (noShowRate >= 0.5)', () => {
    expect(buildWinbackProposal({ ...base, noShowRate: 0.5 }, 'Glow Studio', 'en', NOW)).toBeNull()
    expect(buildWinbackProposal({ ...base, noShowRate: 0.75 }, 'Glow Studio', 'en', NOW)).toBeNull()
  })

  it('keeps a customer just under the no-show ceiling', () => {
    expect(buildWinbackProposal({ ...base, noShowRate: 0.49 }, 'Glow Studio', 'en', NOW)).not.toBeNull()
  })

  it('treats a missing noShowRate as zero (not a skip)', () => {
    const { noShowRate, ...noRate } = base
    void noShowRate
    expect(buildWinbackProposal(noRate as CustomerSummary, 'Glow Studio', 'en', NOW)).not.toBeNull()
  })
})

describe('buildWinbackProposal — dedupKey', () => {
  it('keys on identity + last-visit epoch-day (once per lapse episode)', () => {
    const p = buildWinbackProposal(base, 'Glow Studio', 'en', NOW)!
    expect(p.dedupKey).toBe(`churn.winback:cust-1:${epochDay(base.lastBookingAt!)}`)
    expect(p.dedupKey).toBe('churn.winback:cust-1:20586')
  })

  it('a return visit (new lastBookingAt) yields a fresh key for the next lapse', () => {
    const first = buildWinbackProposal(base, 'Glow Studio', 'en', NOW)!
    const returned = {
      ...base,
      lastBookingAt: new Date('2026-06-10T10:00:00Z'),
    }
    const second = buildWinbackProposal(returned, 'Glow Studio', 'en', NOW)!
    expect(second.dedupKey).not.toBe(first.dedupKey)
  })
})

describe('buildWinbackProposal — normal candidate', () => {
  it('produces owner summary, customer situation + fallback (EN)', () => {
    const p = buildWinbackProposal(base, 'Glow Studio', 'en', NOW)!
    expect(p.ownerSummary).toContain('Dana')
    expect(p.ownerSummary).toContain('14') // cadence
    expect(p.ownerSummary).toContain('40') // days since
    expect(p.ownerSummary.toLowerCase()).toMatch(/yes|no/) // yes/no hint
    expect(p.fallback).toContain('Glow Studio')
    // Customer copy must never instruct a "reply YES".
    expect(p.situation.toLowerCase()).not.toContain('reply yes')
    expect(p.fallback.toLowerCase()).not.toContain('reply yes')
  })

  it('produces Hebrew copy when lang is he', () => {
    const p = buildWinbackProposal(base, 'סטודיו', 'he', NOW)!
    expect(p.ownerSummary).toContain('Dana')
    expect(p.fallback).toContain('סטודיו')
  })

  it('falls back to a neutral name when displayName is missing', () => {
    const p = buildWinbackProposal({ ...base, displayName: null }, 'Glow Studio', 'en', NOW)!
    expect(p.ownerSummary).toContain('this customer')
  })

  it('omits the cadence clause when cadenceDays is null', () => {
    const p = buildWinbackProposal({ ...base, cadenceDays: null }, 'Glow Studio', 'en', NOW)!
    expect(p.ownerSummary).toContain('40')
    expect(p.ownerSummary).not.toMatch(/every \d+ days/)
  })

  it('names the usual instructor in the situation when known (EN + HE)', () => {
    const en = buildWinbackProposal({ ...base, preferredProviderName: 'Amir' }, 'Glow Studio', 'en', NOW)!
    expect(en.situation).toContain('Amir')
    const he = buildWinbackProposal({ ...base, preferredProviderName: 'אמיר' }, 'סטודיו', 'he', NOW)!
    expect(he.situation).toContain('אמיר')
  })

  it('omits the instructor clause when no preferred instructor is known', () => {
    const p = buildWinbackProposal(base, 'Glow Studio', 'en', NOW)!
    expect(p.situation.toLowerCase()).not.toContain('they usually come to')
  })
})
