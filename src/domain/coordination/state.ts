import type { CoordinationStatus, ContactReplyClass, OwnerDecision, SideEffect, Slot } from './types.js'

const SLOT_MATCH_MS = 5 * 60 * 1000 // a start within 5 min of a candidate counts as that candidate

export function classifyContactReply(
  proposed: Slot,
  candidates: Slot[],
): ContactReplyClass {
  const idx = candidates.findIndex(
    (c) => Math.abs(c.start.getTime() - proposed.start.getTime()) <= SLOT_MATCH_MS,
  )
  if (idx >= 0) return { kind: 'accept', candidateIndex: idx }
  return { kind: 'counter', slot: proposed }
}

export type CoordinationEvent =
  | { type: 'contact_reply'; reply: ContactReplyClass; candidates: Slot[] }
  | { type: 'owner_decision'; decision: OwnerDecision; candidates: Slot[]; agreedSlot?: Slot }
  | { type: 'expire' }

export interface Transition {
  status: CoordinationStatus
  effect: SideEffect
  agreedSlot?: Slot       // persist to agreed_slot_* when present
  counterSlot?: Slot      // persist to counter_slot_* when present
}

export function nextCoordinationState(
  current: CoordinationStatus,
  event: CoordinationEvent,
): Transition {
  if (event.type === 'expire') {
    if (current === 'awaiting_counterparty' || current === 'countered') {
      return { status: 'expired', effect: { kind: 'notify_owner_expired' } }
    }
    return { status: current, effect: { kind: 'none' } }
  }

  if (event.type === 'contact_reply') {
    const r = event.reply
    if (r.kind === 'accept') {
      const slot = event.candidates[r.candidateIndex]!
      return { status: 'awaiting_owner_confirm', effect: { kind: 'ping_owner_confirm', slot }, agreedSlot: slot }
    }
    if (r.kind === 'counter') {
      return { status: 'countered', effect: { kind: 'relay_counter_to_owner', slot: r.slot }, counterSlot: r.slot }
    }
    if (r.kind === 'decline') {
      return { status: 'declined', effect: { kind: 'relay_decline_to_owner' } }
    }
    return { status: current, effect: { kind: 'none' } } // unclear
  }

  // owner_decision
  const d = event.decision
  if (d.kind === 'confirm' && event.agreedSlot && (current === 'awaiting_owner_confirm' || current === 'countered')) {
    return { status: 'confirmed', effect: { kind: 'book_and_notify', slot: event.agreedSlot }, agreedSlot: event.agreedSlot }
  }
  if (d.kind === 'counter_offer') {
    return { status: 'awaiting_counterparty', effect: { kind: 'message_contact_new_candidate', slot: d.slot } }
  }
  if (d.kind === 'abandon') {
    return { status: 'abandoned', effect: { kind: 'none' } }
  }
  return { status: current, effect: { kind: 'none' } }
}
