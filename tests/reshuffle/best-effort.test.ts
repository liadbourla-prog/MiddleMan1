import { describe, it, expect } from 'vitest'
import { solveReshuffle } from '../../src/domain/reshuffle/solver.js'
import type { BestEffortInput, ReshuffleBooking, Slot } from '../../src/domain/reshuffle/types.js'

const SIXTY = 60
const slot = (start: string, durationMin = SIXTY): Slot => ({ start, durationMin })

const TUE_10 = '2026-06-23T10:00:00.000Z' // requester's current slot
const TUE_17 = '2026-06-23T17:00:00.000Z' // target, occupied by B
const WED_09 = '2026-06-24T09:00:00.000Z' // C's slot
const TUE_16 = '2026-06-23T16:00:00.000Z' // a possible better-offer slot
const THU_11 = '2026-06-25T11:00:00.000Z' // an open slot

function booking(id: string, customerId: string, start: string, opts: Partial<ReshuffleBooking> = {}): ReshuffleBooking {
  return {
    id, customerId,
    slot: slot(start, opts.slot?.durationMin ?? SIXTY),
    serviceDurationMin: opts.serviceDurationMin ?? SIXTY,
    protected: opts.protected ?? false,
  }
}

const canFit = (durationMin: number, s: Slot) => durationMin <= s.durationMin

function baseInput(overrides: Partial<BestEffortInput> = {}): BestEffortInput {
  return {
    requesterBookingId: 'r',
    targetSlot: slot(TUE_17),
    bookings: [
      booking('r', 'cust-R', TUE_10),
      booking('b', 'cust-B', TUE_17),
      booking('c', 'cust-C', WED_09),
    ],
    willingness: {},
    requesterAlternatives: [],
    openSlots: [],
    maxChainLength: 3,
    canFit,
    ...overrides,
  }
}

describe('solveReshuffle (best-effort, decision X2)', () => {
  it('returns the exact solution when the target is reachable', () => {
    const sol = solveReshuffle(baseInput({ willingness: { b: [slot(TUE_10)] } }))
    expect(sol!.kind).toBe('exact')
    expect(sol!.moves).toHaveLength(2)
  })

  it('X2 — when the target is unreachable, offers an OPEN alternative the requester accepts (zero disturbance)', () => {
    const sol = solveReshuffle(baseInput({
      willingness: {}, // target cannot be freed
      requesterAlternatives: [slot(THU_11)],
      openSlots: [slot(THU_11)],
    }))
    expect(sol).not.toBeNull()
    expect(sol!.kind).toBe('better_offer')
    expect(sol!.moves).toHaveLength(1) // only the requester moves — nobody disturbed
    expect(sol!.moves[0]).toMatchObject({ bookingId: 'r', toSlot: { start: THU_11 } })
  })

  it('X2 — offers a better slot reachable via a cycle when no open alternative exists', () => {
    const sol = solveReshuffle(baseInput({
      willingness: { c: [slot(TUE_10)] }, // target (b) immovable; but TUE_16 alt freeable via C? set up below
      requesterAlternatives: [slot(TUE_16)],
      bookings: [
        booking('r', 'cust-R', TUE_10),
        booking('b', 'cust-B', TUE_17), // target occupant, unwilling
        booking('c', 'cust-C', TUE_16), // alt occupant, willing to take requester's slot
      ],
    }))
    expect(sol!.kind).toBe('better_offer')
    expect(sol!.moves).toHaveLength(2)
    expect(sol!.moves[0]).toMatchObject({ bookingId: 'r', toSlot: { start: TUE_16 } })
    expect(sol!.moves[1]).toMatchObject({ bookingId: 'c', toSlot: { start: TUE_10 } })
  })

  it('X2 — prefers the higher-ranked alternative when several are achievable', () => {
    const sol = solveReshuffle(baseInput({
      requesterAlternatives: [slot(TUE_16), slot(THU_11)], // TUE_16 ranked first
      openSlots: [slot(TUE_16), slot(THU_11)],
    }))
    expect(sol!.kind).toBe('better_offer')
    expect(sol!.moves[0]).toMatchObject({ toSlot: { start: TUE_16 } })
  })

  it('never gives up silently but returns null only when truly nothing is achievable', () => {
    const sol = solveReshuffle(baseInput({
      willingness: {},
      requesterAlternatives: [slot(THU_11)],
      openSlots: [], // alternative isn't actually open and can't be freed
    }))
    expect(sol).toBeNull()
  })
})
