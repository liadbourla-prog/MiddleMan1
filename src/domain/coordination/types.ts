export type CoordinationStatus =
  | 'awaiting_counterparty'
  | 'countered'
  | 'awaiting_owner_confirm'
  | 'confirmed'
  | 'declined'
  | 'expired'
  | 'abandoned'

export interface Slot { start: Date; end: Date }

// What the contact's reply resolved to (produced by interpret.ts + classify).
export type ContactReplyClass =
  | { kind: 'accept'; candidateIndex: number }   // picked one of the discrete candidate slots
  | { kind: 'accept_slot'; slot: Slot }          // proposed a time INSIDE an allowed window
  | { kind: 'counter'; slot: Slot }              // proposed a time outside the discrete candidates
  | { kind: 'deviation'; slot: Slot; window: Slot } // proposed a time OUTSIDE the allowed windows
  | { kind: 'decline' }
  | { kind: 'unclear' }

// Owner decisions arriving via resolveMeetingCoordination.
export type OwnerDecision =
  | { kind: 'confirm' }                          // book the agreed/countered slot
  | { kind: 'counter_offer'; slot: Slot }        // offer the contact a new time
  | { kind: 'abandon' }

// The side effect the orchestration layer must perform after a transition.
export type SideEffect =
  | { kind: 'message_contact_candidates' }       // (re)send candidate times to the contact
  | { kind: 'message_contact_new_candidate'; slot: Slot }
  | { kind: 'ping_owner_confirm'; slot: Slot }   // "X is good for <slot> — book it?"
  | { kind: 'relay_counter_to_owner'; slot: Slot }
  | { kind: 'relay_out_of_window_to_owner'; slot: Slot; window: Slot } // out-of-window deviation: flag to owner
  | { kind: 'relay_decline_to_owner' }
  | { kind: 'book_and_notify'; slot: Slot }      // write calendar event + tell contact "you're set"
  | { kind: 'notify_owner_expired' }
  | { kind: 'none' }
