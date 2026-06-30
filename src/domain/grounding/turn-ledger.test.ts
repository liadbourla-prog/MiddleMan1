import { describe, it, expect } from 'vitest'
import { buildAllowedTimes, buildTurnLedger } from './turn-ledger.js'
import type { TranscriptTurn } from '../../adapters/llm/types.js'

// T0.1 characterization — the per-turn TurnLedger + the branch-agnostic time-allowlist
// builder lifted out of customer-booking.ts. The load-bearing property (RED-TEAM D1):
// `allowedTimes` is per-turn-BASE ∪ per-CALL. The ledger holds only the stable per-turn
// base (boundary ∪ booking); buildAllowedTimes STILL merges the per-call situation +
// customer-raised transcript times at check time. Precomputing one frozen per-turn set
// would false-positive legitimately-offered times → FABRICATED_TIME_FALLBACK (a G1/G5
// regression). These tests pin the per-call merge across DIFFERING situations.

function input(situation: string, transcript: TranscriptTurn[] = []) {
  return { situation, transcript } as Parameters<typeof buildAllowedTimes>[0]
}

const base = { boundaryTimes: ['09:00', '20:00'], bookingTimes: ['11:30'] }

describe('buildAllowedTimes — per-turn base ∪ per-call merge (D1)', () => {
  it('always includes the per-turn base (boundary + booking times)', () => {
    const allowed = buildAllowedTimes(input(''), base)
    expect(allowed.has('09:00')).toBe(true)
    expect(allowed.has('20:00')).toBe(true)
    expect(allowed.has('11:30')).toBe(true)
  })

  it('merges PER-CALL situation times — same base, two different situations admit different times', () => {
    const a = buildAllowedTimes(input('Open today: 14:00, 16:00'), base)
    const b = buildAllowedTimes(input('Open today: 17:00'), base)
    // call A admits 14:00/16:00 but NOT 17:00; call B is the inverse — proving the merge
    // is per-call, not a single frozen per-turn set.
    expect(a.has('14:00')).toBe(true)
    expect(a.has('16:00')).toBe(true)
    expect(a.has('17:00')).toBe(false)
    expect(b.has('17:00')).toBe(true)
    expect(b.has('14:00')).toBe(false)
  })

  it('admits customer-raised transcript times (customer turns only), not assistant turns', () => {
    const allowed = buildAllowedTimes(
      input('nothing open', [
        { role: 'customer', text: 'can I come at 17:00?' },
        { role: 'assistant', text: 'how about 18:30?' },
      ]),
      base,
    )
    expect(allowed.has('17:00')).toBe(true) // customer raised — may be echoed/refused
    expect(allowed.has('18:30')).toBe(false) // prior-assistant — never laundered
  })

  it('handles missing situation/transcript without throwing (best-effort)', () => {
    const allowed = buildAllowedTimes({} as Parameters<typeof buildAllowedTimes>[0], base)
    expect(allowed.has('09:00')).toBe(true)
  })
})

describe('buildTurnLedger — assembles the per-turn record', () => {
  const spine = async () => ({ openOverall: false, openInService: false, text: null })

  it('packages the per-turn pieces into one TurnLedger struct', () => {
    const ledger = buildTurnLedger({
      businessFacts: 'FACTS',
      actionLedger: 'LEDGER',
      baseAllowedTimes: base,
      occupancySpine: spine,
      businessId: 'biz-1',
    })
    expect(ledger.businessFacts).toBe('FACTS')
    expect(ledger.actionLedger).toBe('LEDGER')
    expect(ledger.baseAllowedTimes).toEqual(base)
    expect(ledger.occupancySpine).toBe(spine)
    expect(ledger.businessId).toBe('biz-1')
    // backedActions defaults to an empty set; Branch 4 Phase 0 has no backed-action ledger yet.
    expect(ledger.backedActions).toBeInstanceOf(Set)
    expect(ledger.backedActions.size).toBe(0)
    expect(ledger.calendarConnected).toBe(false)
  })

  it('carries explicit backedActions/calendarConnected when supplied', () => {
    const ledger = buildTurnLedger({
      businessFacts: '',
      actionLedger: '',
      baseAllowedTimes: base,
      occupancySpine: spine,
      backedActions: new Set(['booking_made'] as const),
      calendarConnected: true,
    })
    expect(ledger.backedActions.has('booking_made')).toBe(true)
    expect(ledger.calendarConnected).toBe(true)
  })
})
