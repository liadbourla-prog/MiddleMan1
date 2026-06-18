import type { BookingState } from '../../db/schema.js'

export type { BookingState }

export interface BookingSlotRequest {
  serviceTypeId: string
  slotStart: Date
  slotEnd: Date
  providerId?: string
  providerHint?: string | null
}

export type TransitionResult =
  | { ok: true; newState: BookingState }
  | { ok: false; reason: string }

// All valid transitions as a map: from state → set of reachable states
export const VALID_TRANSITIONS: Record<BookingState, ReadonlySet<BookingState>> = {
  inquiry: new Set(['requested']),
  requested: new Set(['held', 'confirmed', 'failed']),
  held: new Set(['confirmed', 'pending_payment', 'cancelled', 'expired', 'failed']),
  pending_payment: new Set(['confirmed', 'cancelled', 'failed']),
  confirmed: new Set(['cancelled', 'attended', 'no_show']),
  cancelled: new Set(),
  expired: new Set(),
  failed: new Set(),
  attended: new Set(),
  no_show: new Set(),
}

export const TERMINAL_STATES = new Set<BookingState>(['cancelled', 'expired', 'failed', 'attended', 'no_show'])
