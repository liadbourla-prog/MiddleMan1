import { describe, it, expect } from 'vitest'
import { findReshuffleCycle } from '../../src/domain/reshuffle/solver.js'
import type { ReshuffleBooking, Slot, SolverInput } from '../../src/domain/reshuffle/types.js'

// Physio studio fixture — every service is 60 min unless a test overrides it.
const SIXTY = 60
const slot = (start: string, durationMin = SIXTY): Slot => ({ start, durationMin })

// Slots used across tests
const TUE_10 = '2026-06-23T10:00:00.000Z' // requester's current slot (S_a)
const TUE_17 = '2026-06-23T17:00:00.000Z' // target (S_b), occupied by B
const WED_09 = '2026-06-24T09:00:00.000Z' // C's slot

function booking(id: string, customerId: string, start: string, opts: Partial<ReshuffleBooking> = {}): ReshuffleBooking {
  return {
    id, customerId,
    slot: slot(start, opts.slot?.durationMin ?? SIXTY),
    serviceDurationMin: opts.serviceDurationMin ?? SIXTY,
    protected: opts.protected ?? false,
  }
}

// A service can take a slot iff its duration fits the slot's window.
const canFit = (durationMin: number, s: Slot) => durationMin <= s.durationMin

function baseInput(overrides: Partial<SolverInput> = {}): SolverInput {
  return {
    requesterBookingId: 'r',
    targetSlot: slot(TUE_17),
    bookings: [
      booking('r', 'cust-R', TUE_10),
      booking('b', 'cust-B', TUE_17),
      booking('c', 'cust-C', WED_09),
    ],
    willingness: {},
    maxChainLength: 3,
    canFit,
    ...overrides,
  }
}

describe('findReshuffleCycle', () => {
  it('A1 — finds the direct 2-cycle (swap) when the occupant will take the freed slot', () => {
    const sol = findReshuffleCycle(baseInput({ willingness: { b: [slot(TUE_10)] } }))
    expect(sol).not.toBeNull()
    expect(sol!.kind).toBe('exact')
    expect(sol!.moves).toHaveLength(2)
    expect(sol!.moves[0]).toMatchObject({ bookingId: 'r', toSlot: { start: TUE_17 } })
    expect(sol!.moves[1]).toMatchObject({ bookingId: 'b', toSlot: { start: TUE_10 } })
  })

  it('A2 — finds a 3-cycle chain when no 2-cycle exists', () => {
    const sol = findReshuffleCycle(baseInput({
      willingness: { b: [slot(WED_09)], c: [slot(TUE_10)] }, // B won't take 10:00 but will take Wed; C takes 10:00
    }))
    expect(sol).not.toBeNull()
    expect(sol!.moves).toHaveLength(3)
    expect(sol!.moves.map((m) => m.bookingId)).toEqual(['r', 'b', 'c'])
    expect(sol!.moves[2]).toMatchObject({ bookingId: 'c', toSlot: { start: TUE_10 } })
  })

  it('A3 — returns null (calendar untouched) when no cycle exists', () => {
    expect(findReshuffleCycle(baseInput({ willingness: {} }))).toBeNull()
  })

  it('A4 — prefers the cheapest (fewest people) solution when both exist', () => {
    const sol = findReshuffleCycle(baseInput({
      willingness: { b: [slot(TUE_10), slot(WED_09)], c: [slot(TUE_10)] }, // a 2-cycle AND a 3-cycle are possible
    }))
    expect(sol!.moves).toHaveLength(2) // the 2-cycle wins
  })

  it('F2 — never displaces a protected occupant of the target slot', () => {
    const sol = findReshuffleCycle(baseInput({
      bookings: [
        booking('r', 'cust-R', TUE_10),
        booking('b', 'cust-B', TUE_17, { protected: true }),
        booking('c', 'cust-C', WED_09),
      ],
      willingness: { b: [slot(TUE_10)] }, // B would take it, but B is protected → not allowed
    }))
    expect(sol).toBeNull()
  })

  it('F2 — never routes a chain through a protected intermediate', () => {
    const sol = findReshuffleCycle(baseInput({
      bookings: [
        booking('r', 'cust-R', TUE_10),
        booking('b', 'cust-B', TUE_17),
        booking('c', 'cust-C', WED_09, { protected: true }),
      ],
      willingness: { b: [slot(WED_09)], c: [slot(TUE_10)] }, // only path is through protected C
    }))
    expect(sol).toBeNull()
  })

  it('G5 — rejects a move where the service does not fit the slot duration', () => {
    const sol = findReshuffleCycle(baseInput({
      targetSlot: slot(TUE_17, 30), // target is only a 30-min window
      bookings: [
        booking('r', 'cust-R', TUE_10, { serviceDurationMin: 60 }), // requester needs 60 min
        booking('b', 'cust-B', TUE_17, { slot: slot(TUE_17, 30) }),
        booking('c', 'cust-C', WED_09),
      ],
      willingness: { b: [slot(TUE_10)] },
    }))
    expect(sol).toBeNull() // requester can't fit a 30-min slot
  })

  it('respects maxChainLength — a 3-cycle is not assembled when the cap is 2', () => {
    const sol = findReshuffleCycle(baseInput({
      maxChainLength: 2,
      willingness: { b: [slot(WED_09)], c: [slot(TUE_10)] }, // only a 3-cycle exists
    }))
    expect(sol).toBeNull()
  })
})
