import { describe, it, expect } from 'vitest'
import { rankWaitlistCandidates, waitlistTier } from './priority.js'

interface Entry {
  id: string
  customerId: string
  createdAt: Date
}

function entry(id: string, createdAtIso: string): Entry {
  return { id, customerId: `cust-${id}`, createdAt: new Date(createdAtIso) }
}

// §3.2 — fairness tier on top of FIFO. Tier 1 = no active booking in [now, now+7d]
// (no commitment) → offered first. Tier 2 = has a commitment. FIFO within each tier.
describe('rankWaitlistCandidates (WL-2a §3.2)', () => {
  it('(a) no-commitment customer beats an earlier-joined committed one', () => {
    const a = entry('A', '2026-06-28T10:00:00Z') // earlier, but committed
    const b = entry('B', '2026-06-29T10:00:00Z') // later, but no commitment
    const committed = new Set(['A'])
    const ranked = rankWaitlistCandidates([a, b], (e) => committed.has(e.id))
    expect(ranked.map((e) => e.id)).toEqual(['B', 'A'])
  })

  it('(b) neither has a commitment → FIFO intact (oldest first)', () => {
    const a = entry('A', '2026-06-28T10:00:00Z')
    const b = entry('B', '2026-06-29T10:00:00Z')
    const ranked = rankWaitlistCandidates([a, b], () => false)
    expect(ranked.map((e) => e.id)).toEqual(['A', 'B'])
  })

  it('(c) both have a commitment → FIFO within tier 2', () => {
    const a = entry('A', '2026-06-28T10:00:00Z')
    const b = entry('B', '2026-06-29T10:00:00Z')
    const ranked = rankWaitlistCandidates([a, b], () => true)
    expect(ranked.map((e) => e.id)).toEqual(['A', 'B'])
  })

  it('(d) stable: three same-tier entries keep original createdAt order', () => {
    const a = entry('A', '2026-06-28T10:00:00Z')
    const b = entry('B', '2026-06-29T10:00:00Z')
    const c = entry('C', '2026-06-30T10:00:00Z')
    const ranked = rankWaitlistCandidates([a, b, c], () => false)
    expect(ranked.map((e) => e.id)).toEqual(['A', 'B', 'C'])
  })

  it('does not mutate the input array', () => {
    const a = entry('A', '2026-06-28T10:00:00Z') // committed
    const b = entry('B', '2026-06-29T10:00:00Z') // not committed
    const input = [a, b]
    const committed = new Set(['A'])
    rankWaitlistCandidates(input, (e) => committed.has(e.id))
    expect(input.map((e) => e.id)).toEqual(['A', 'B'])
  })
})

describe('waitlistTier (WL-2a §3.2)', () => {
  it('(e) no commitment → priority; has commitment → normal', () => {
    expect(waitlistTier(false)).toBe('priority')
    expect(waitlistTier(true)).toBe('normal')
  })
})
