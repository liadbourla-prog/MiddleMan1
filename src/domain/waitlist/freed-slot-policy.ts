// Owner-approval gate for freed-slot offers (deterministic core).
//
// When a confirmed booking is cancelled and someone is on the waitlist for that slot,
// the PA used to fire the offer automatically (engine.ts → triggerWaitlistForSlot). The
// owner must stay in control: by default the PA asks before offering a freed slot to
// another customer, and the FIRST time it asks it also offers to make this automatic
// (the two-part prompt). This module is the pure decision; persistence + messaging wrap it.
//
// See CALENDAR_BULLETPROOFING_PLAN.md WS-C (implements #6/#8).

/** Standing per-business preference. `null` (DB default) = the owner has never been asked. */
export type FreedSlotOfferPolicy = 'ask' | 'auto' | 'never'

export type FreedSlotAction =
  // Fire the waitlist offer immediately (owner opted into automatic handling).
  | { kind: 'offer' }
  // Do nothing — the owner opted out of freed-slot offers entirely.
  | { kind: 'suppress' }
  // Hold the slot and ask the owner. `firstTime` ⇒ also offer to set a standing
  // preference (the two-part first-time prompt).
  | { kind: 'ask'; firstTime: boolean }

/**
 * Decide what to do with a slot that just freed up AND has at least one waiting customer.
 * The "is anyone waiting?" check is the caller's responsibility — this only maps the
 * standing policy to an action so it can be unit-tested in isolation.
 */
export function decideFreedSlotAction(policy: FreedSlotOfferPolicy | null): FreedSlotAction {
  switch (policy) {
    case 'auto':
      return { kind: 'offer' }
    case 'never':
      return { kind: 'suppress' }
    case 'ask':
      return { kind: 'ask', firstTime: false }
    case null:
    case undefined:
    default:
      // Never asked before — ask, and offer to make it a standing preference.
      return { kind: 'ask', firstTime: true }
  }
}
