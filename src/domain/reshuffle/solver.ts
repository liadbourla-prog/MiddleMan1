// Proactive Reshuffle Engine — the pure cycle solver (Task 2, the heart).
// Deterministic, no I/O, no LLM. See the plan doc and types.ts.
//
// Problem: the requester R wants `targetSlot` (S_b), currently held by occupant B.
// Moving R there displaces B and frees R's slot (S_a). To keep the week full we must
// route the displaced customer(s) so that someone ultimately lands on S_a — i.e. find
// a CYCLE seeded by the S_a vacancy. We want the SHORTEST such cycle (fewest people
// moved, decision G-1), never moving a protected customer (A4), and only between
// duration-compatible slots (G-5).

import type { BestEffortInput, Move, ReshuffleBooking, Slot, Solution, SolverInput } from './types.js'

const sameSlot = (a: Slot, b: Slot): boolean => a.start === b.start

/**
 * Find the shortest reshuffle cycle that gives the requester their target slot, or
 * `null` if none exists within the constraints (leaving the calendar untouched).
 */
export function findReshuffleCycle(input: SolverInput): Solution | null {
  const { requesterBookingId, targetSlot, bookings, willingness, maxChainLength, canFit } = input

  const requester = bookings.find((b) => b.id === requesterBookingId)
  if (!requester) return null
  const sA = requester.slot

  // The requester must actually fit the slot they asked for (G-5).
  if (!canFit(requester.serviceDurationMin, targetSlot)) return null

  const occupant = bookings.find((b) => sameSlot(b.slot, targetSlot))
  if (!occupant || occupant.id === requester.id) return null // not a contested occupied slot

  const isWilling = (bookingId: string, s: Slot): boolean =>
    (willingness[bookingId] ?? []).some((w) => sameSlot(w, s))

  // BFS over chains, extended one mover at a time → the first solution found is shortest.
  interface State {
    displaced: ReshuffleBooking // the booking that currently needs a new home
    chain: Move[] // moves committed so far, requester first
    used: Set<string> // bookings already placed in the chain
  }

  const start: State = {
    displaced: occupant,
    chain: [{ bookingId: requester.id, customerId: requester.customerId, fromSlot: sA, toSlot: targetSlot }],
    used: new Set([requester.id]),
  }

  const queue: State[] = [start]
  while (queue.length > 0) {
    const state = queue.shift()!
    const d = state.displaced

    // A displaced non-requester is being moved involuntarily — never a protected party (A4).
    if (d.protected) continue

    // People moved if we close here = requester + intermediates + d. Cap by maxChainLength.
    const peopleIfClose = state.chain.length + 1
    if (peopleIfClose > maxChainLength) continue

    // Close the cycle: d takes the freed S_a.
    if (isWilling(d.id, sA) && canFit(d.serviceDurationMin, sA)) {
      const moves: Move[] = [
        ...state.chain,
        { bookingId: d.id, customerId: d.customerId, fromSlot: d.slot, toSlot: sA },
      ]
      return { kind: 'exact', moves }
    }

    // Extend the chain: d moves onto another booking's slot, displacing its owner.
    for (const next of bookings) {
      if (state.used.has(next.id) || next.id === d.id) continue
      if (next.protected) continue // can't displace a protected party
      if (sameSlot(next.slot, sA)) continue // closing case, handled above
      if (isWilling(d.id, next.slot) && canFit(d.serviceDurationMin, next.slot)) {
        queue.push({
          displaced: next,
          chain: [...state.chain, { bookingId: d.id, customerId: d.customerId, fromSlot: d.slot, toSlot: next.slot }],
          used: new Set([...state.used, d.id]),
        })
      }
    }
  }

  return null
}

/**
 * Best-effort solve (decision X2 — always offer, never give up). Priority:
 *   1. Deliver the exact requested slot via the cheapest cycle.
 *   2. Otherwise deliver the highest-ranked alternative the requester accepts:
 *        a. an OPEN slot they fit (zero disturbance), or
 *        b. a slot freeable via a cycle.
 *   3. Only if nothing is achievable, return null (calendar left untouched).
 */
export function solveReshuffle(input: BestEffortInput): Solution | null {
  const exact = findReshuffleCycle(input)
  if (exact) return exact

  const requester = input.bookings.find((b) => b.id === input.requesterBookingId)
  if (!requester) return null

  const isOpen = (s: Slot): boolean => input.openSlots.some((o) => sameSlot(o, s))

  // Walk the requester's fallbacks in rank order; the first achievable one wins.
  for (const alt of input.requesterAlternatives) {
    // (a) zero-disturbance: the alternative is open and the requester fits it.
    if (isOpen(alt) && input.canFit(requester.serviceDurationMin, alt)) {
      const move: Move = { bookingId: requester.id, customerId: requester.customerId, fromSlot: requester.slot, toSlot: alt }
      return { kind: 'better_offer', moves: [move] }
    }
    // (b) the alternative is occupied — try to free it via a cycle.
    const viaCycle = findReshuffleCycle({ ...input, targetSlot: alt })
    if (viaCycle) return { kind: 'better_offer', moves: viaCycle.moves }
  }

  return null
}
