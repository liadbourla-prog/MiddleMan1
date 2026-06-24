import { describe, it, expect } from 'vitest'
import { selectColdFillCandidates } from './cold-fill.js'
import type { CustomerSummary } from '../../shared/skill-types.js'

// Helper: a candidate with the fields ranking cares about (recency + no-show rate).
const c = (
  id: string,
  lastBookingAt: string | null,
  noShowRate = 0,
  preferredProviderId: string | null = null,
): CustomerSummary => ({
  identityId: id,
  phoneNumber: `+1${id}`,
  displayName: id,
  totalBookings: 1,
  lastBookingAt: lastBookingAt ? new Date(lastBookingAt) : null,
  noShowRate,
  preferredProviderId,
})

describe('selectColdFillCandidates', () => {
  it('empty input → empty output', () => {
    expect(selectColdFillCandidates([], { batchSize: 3 })).toEqual([])
  })

  it('ranks most-recently-active first (lastBookingAt desc)', () => {
    const picks = selectColdFillCandidates(
      [
        c('old', '2026-01-01T10:00:00Z'),
        c('newest', '2026-03-01T10:00:00Z'),
        c('mid', '2026-02-01T10:00:00Z'),
      ],
      { batchSize: 3 },
    )
    expect(picks.map((p) => p.identityId)).toEqual(['newest', 'mid', 'old'])
  })

  it('tie-breaks equal recency by lower no-show rate', () => {
    const picks = selectColdFillCandidates(
      [
        c('flakier', '2026-02-01T10:00:00Z', 0.4),
        c('reliable', '2026-02-01T10:00:00Z', 0.1),
      ],
      { batchSize: 2 },
    )
    expect(picks.map((p) => p.identityId)).toEqual(['reliable', 'flakier'])
  })

  it('excludes candidates with noShowRate >= 0.5 (unreliable)', () => {
    const picks = selectColdFillCandidates(
      [
        c('ok', '2026-03-01T10:00:00Z', 0.49),
        c('exactly_half', '2026-04-01T10:00:00Z', 0.5),
        c('flake', '2026-05-01T10:00:00Z', 0.9),
      ],
      { batchSize: 3 },
    )
    // Only 'ok' survives the exclusion despite the others being more recent.
    expect(picks.map((p) => p.identityId)).toEqual(['ok'])
  })

  it('treats a missing noShowRate as 0 (kept, ranked as most reliable)', () => {
    const picks = selectColdFillCandidates(
      [c('no_rate', '2026-02-01T10:00:00Z')], // noShowRate omitted → defaults 0
      { batchSize: 3 },
    )
    expect(picks.map((p) => p.identityId)).toEqual(['no_rate'])
  })

  it('caps the result at batchSize, taking the best picks', () => {
    const picks = selectColdFillCandidates(
      [
        c('a', '2026-01-01T10:00:00Z'),
        c('b', '2026-02-01T10:00:00Z'),
        c('c', '2026-03-01T10:00:00Z'),
        c('d', '2026-04-01T10:00:00Z'),
      ],
      { batchSize: 2 },
    )
    expect(picks.map((p) => p.identityId)).toEqual(['d', 'c']) // 2 warmest
  })

  it('null lastBookingAt sorts last', () => {
    const picks = selectColdFillCandidates(
      [c('never', null), c('recent', '2026-02-01T10:00:00Z')],
      { batchSize: 3 },
    )
    expect(picks.map((p) => p.identityId)).toEqual(['recent', 'never'])
  })

  it('batchSize 0 → empty output', () => {
    expect(
      selectColdFillCandidates([c('a', '2026-01-01T10:00:00Z')], { batchSize: 0 }),
    ).toEqual([])
  })

  it('instructor-fit ranks the slot instructor’s customers above warmer non-matches', () => {
    const picks = selectColdFillCandidates(
      [
        c('newer_other', '2026-03-01T10:00:00Z', 0, 'amir'),
        c('older_dana', '2026-01-01T10:00:00Z', 0, 'dana'),
      ],
      { batchSize: 2, slotProviderId: 'dana' },
    )
    // Dana's customer wins despite being less recent.
    expect(picks.map((p) => p.identityId)).toEqual(['older_dana', 'newer_other'])
  })

  it('within the same instructor-fit tier, recency still decides', () => {
    const picks = selectColdFillCandidates(
      [
        c('dana_old', '2026-01-01T10:00:00Z', 0, 'dana'),
        c('dana_new', '2026-03-01T10:00:00Z', 0, 'dana'),
      ],
      { batchSize: 2, slotProviderId: 'dana' },
    )
    expect(picks.map((p) => p.identityId)).toEqual(['dana_new', 'dana_old'])
  })

  it('no slotProviderId → instructor is ignored, pure recency ordering', () => {
    const picks = selectColdFillCandidates(
      [c('older_dana', '2026-01-01T10:00:00Z', 0, 'dana'), c('newer_other', '2026-03-01T10:00:00Z', 0, 'amir')],
      { batchSize: 2 },
    )
    expect(picks.map((p) => p.identityId)).toEqual(['newer_other', 'older_dana'])
  })
})
