import type { BookingState, TransitionResult } from './types.js'
import { VALID_TRANSITIONS, TERMINAL_STATES } from './types.js'

export function canTransition(from: BookingState, to: BookingState): boolean {
  return VALID_TRANSITIONS[from].has(to)
}

export function transition(from: BookingState, to: BookingState): TransitionResult {
  if (from === to) return { ok: true, newState: to } // idempotent

  if (TERMINAL_STATES.has(from)) {
    // Special case: confirmed → cancelled is allowed
    if (from === 'confirmed' && to === 'cancelled') {
      return { ok: true, newState: 'cancelled' }
    }
    return { ok: false, reason: `Booking is in terminal state '${from}' and cannot transition` }
  }

  if (!canTransition(from, to)) {
    return {
      ok: false,
      reason: `Transition '${from}' → '${to}' is not permitted`,
    }
  }

  return { ok: true, newState: to }
}
