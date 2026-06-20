import { describe, it, expect } from 'vitest'
import { selectBroadcastTargets, evaluateTermination } from '../../src/domain/reshuffle/worker-logic.js'
import type { OutreachCandidate } from '../../src/domain/reshuffle/worker-logic.js'
import { resolveReshuffleConfig } from '../../src/domain/reshuffle/config.js'

function candidate(id: string, over: Partial<OutreachCandidate> = {}): OutreachCandidate {
  return {
    bookingId: id, customerId: `cust-${id}`, optedOut: false, protected: false,
    serviceTypeId: 'svc-1', alreadyContacted: false, ...over,
  }
}

describe('selectBroadcastTargets', () => {
  const reqSvc = 'svc-1'

  it('batches in groups of batchSize (default 7)', () => {
    const cands = Array.from({ length: 20 }, (_, i) => candidate(`b${i}`))
    const picked = selectBroadcastTargets(cands, resolveReshuffleConfig(null), reqSvc, 0)
    expect(picked).toHaveLength(7)
  })

  it('honors an owner-raised batchSize', () => {
    const cands = Array.from({ length: 20 }, (_, i) => candidate(`b${i}`))
    const picked = selectBroadcastTargets(cands, resolveReshuffleConfig({ batchSize: 15 }), reqSvc, 0)
    expect(picked).toHaveLength(15)
  })

  it('batchSize 0 = no cap (whole eligible pool in one wave)', () => {
    const cands = Array.from({ length: 12 }, (_, i) => candidate(`b${i}`))
    const picked = selectBroadcastTargets(cands, resolveReshuffleConfig({ batchSize: 0 }), reqSvc, 0)
    expect(picked).toHaveLength(12)
  })

  it('C4 — never contacts opted-out customers', () => {
    const cands = [candidate('a'), candidate('b', { optedOut: true }), candidate('c')]
    const picked = selectBroadcastTargets(cands, resolveReshuffleConfig({ batchSize: 7 }), reqSvc, 0)
    expect(picked.map((c) => c.bookingId)).toEqual(['a', 'c'])
  })

  it('never contacts protected or already-contacted customers', () => {
    const cands = [candidate('a', { protected: true }), candidate('b', { alreadyContacted: true }), candidate('c')]
    const picked = selectBroadcastTargets(cands, resolveReshuffleConfig({ batchSize: 7 }), reqSvc, 0)
    expect(picked.map((c) => c.bookingId)).toEqual(['c'])
  })

  it('service_match scope only contacts same-service customers', () => {
    const cands = [candidate('a', { serviceTypeId: 'svc-1' }), candidate('b', { serviceTypeId: 'svc-2' })]
    const picked = selectBroadcastTargets(cands, resolveReshuffleConfig({ contactScope: 'service_match' }), reqSvc, 0)
    expect(picked.map((c) => c.bookingId)).toEqual(['a'])
  })

  it('conflicting_only scope never broadcasts', () => {
    const cands = [candidate('a'), candidate('b')]
    const picked = selectBroadcastTargets(cands, resolveReshuffleConfig({ contactScope: 'conflicting_only' }), reqSvc, 0)
    expect(picked).toHaveLength(0)
  })

  it('F3 — respects maxOutreachPerCampaign across waves', () => {
    const cands = Array.from({ length: 20 }, (_, i) => candidate(`b${i}`))
    // Already contacted 18 of a 21 cap → only 3 more allowed even though batchSize is 7.
    const picked = selectBroadcastTargets(cands, resolveReshuffleConfig({ batchSize: 7, maxOutreachPerCampaign: 21 }), reqSvc, 18)
    expect(picked).toHaveLength(3)
  })
})

describe('evaluateTermination (decision G-6)', () => {
  it('solved when a solution exists', () => {
    expect(evaluateTermination({ hasSolution: true, laddersRemaining: 1, openOffers: 2, eligibleRemaining: 5, contactedSoFar: 0, maxOutreach: 21 })).toBe('solved')
  })

  it('continues while offers are still open', () => {
    expect(evaluateTermination({ hasSolution: false, laddersRemaining: 0, openOffers: 1, eligibleRemaining: 0, contactedSoFar: 5, maxOutreach: 21 })).toBe('continue')
  })

  it('continues while ladder rungs remain untried', () => {
    expect(evaluateTermination({ hasSolution: false, laddersRemaining: 1, openOffers: 0, eligibleRemaining: 0, contactedSoFar: 5, maxOutreach: 21 })).toBe('continue')
  })

  it('exhausted only when no solution, no open offers, no rungs, and pool/cap reached', () => {
    expect(evaluateTermination({ hasSolution: false, laddersRemaining: 0, openOffers: 0, eligibleRemaining: 0, contactedSoFar: 5, maxOutreach: 21 })).toBe('exhausted')
  })

  it('exhausted when the outreach cap is hit even if eligible customers remain', () => {
    expect(evaluateTermination({ hasSolution: false, laddersRemaining: 0, openOffers: 0, eligibleRemaining: 10, contactedSoFar: 21, maxOutreach: 21 })).toBe('exhausted')
  })
})
