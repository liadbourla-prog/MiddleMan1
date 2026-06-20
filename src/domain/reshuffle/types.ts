// Proactive Reshuffle Engine — core types.
// See docs/superpowers/plans/2026-06-18-proactive-reshuffle-engine.md
//
// This module is the deterministic, side-effect-free heart of the engine. The solver
// here contains NO LLM calls, NO I/O — it operates on a snapshot and returns a plan
// (CLAUDE.md principle 1–2).

/** A slot is identified by its start; duration makes slots non-interchangeable (decision G-5). */
export interface Slot {
  /** ISO 8601 instant. */
  start: string
  durationMin: number
}

export interface ReshuffleBooking {
  id: string
  customerId: string
  slot: Slot
  /** Duration the customer's service needs — used for fit checks (decision G-5). */
  serviceDurationMin: number
  /** Near-term / VIP / recently-rescheduled → never moved involuntarily (decision A4). */
  protected: boolean
}

export interface Move {
  bookingId: string
  customerId: string
  fromSlot: Slot
  toSlot: Slot
}

export interface Solution {
  /**
   * `exact`        = the requester gets the slot they asked for.
   * `better_offer` = the exact slot is unreachable, so the requester is given the
   *                  closest achievable alternative they accept, week still full (decision X2).
   */
  kind: 'exact' | 'better_offer'
  /** Ordered moves: requester first, the slot-filler last. A single move = zero disturbance. */
  moves: Move[]
}

export interface SolverInput {
  requesterBookingId: string
  /** The slot the requester wants (currently occupied by someone else). */
  targetSlot: Slot
  /** Every occupied booking in scope (includes the requester and the target's occupant). */
  bookings: ReshuffleBooking[]
  /**
   * Discovered edges: bookingId → the slots that booking's owner has AGREED to move to.
   * In production these come from outreach; the pure solver takes them as input.
   */
  willingness: Record<string, Slot[]>
  /** Max number of people moved, including the requester (decision: shortest cycle, A4). */
  maxChainLength: number
  /** Whether a service of `durationMin` can occupy `slot` (hours/buffers/duration — decision G-5). */
  canFit: (durationMin: number, slot: Slot) => boolean
}

/**
 * Best-effort input (decision X2): adds the requester's ranked fallback options and the
 * genuinely-open slots, so the solver can produce a `better_offer` when the exact slot
 * is unreachable instead of giving up.
 */
export interface BestEffortInput extends SolverInput {
  /** Additional slots the requester accepts, most-preferred first. The target is tried before any of these. */
  requesterAlternatives: Slot[]
  /** Genuinely-open slots (no booking). A requester-accepted open slot is a zero-disturbance answer. */
  openSlots: Slot[]
}
