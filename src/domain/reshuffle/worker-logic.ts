// Proactive Reshuffle Engine — worker decision logic (pure).
//
// The BullMQ worker wraps these with the actual I/O (sending WhatsApp, persisting offers,
// scheduling TTL ticks). Keeping the decisions pure makes the consent/limit/termination
// rules (C4, F3, G-6, contactScope) directly unit-testable.

import type { ReshuffleConfig } from './config.js'

export interface OutreachCandidate {
  bookingId: string
  customerId: string
  optedOut: boolean
  /** Near-term / VIP / recently-rescheduled (decision A4) — never contacted to be moved. */
  protected: boolean
  serviceTypeId: string
  alreadyContacted: boolean
}

function scopeAllows(candidate: OutreachCandidate, config: ReshuffleConfig, requestServiceTypeId: string): boolean {
  switch (config.contactScope) {
    case 'all_booked':
      return true
    case 'service_match':
      return candidate.serviceTypeId === requestServiceTypeId
    case 'conflicting_only':
      // Only the direct occupant is contacted (handled by the direct rung) — never broadcast.
      return false
  }
}

/**
 * Pick the next wave of broadcast targets, honoring consent (C4), the per-wave batch size,
 * contact scope, the protected set (A4), and the campaign-wide outreach cap (F3).
 */
export function selectBroadcastTargets(
  candidates: OutreachCandidate[],
  config: ReshuffleConfig,
  requestServiceTypeId: string,
  contactedSoFar: number,
): OutreachCandidate[] {
  const eligible = candidates.filter(
    (c) =>
      !c.alreadyContacted &&
      !c.protected &&
      !(config.respectMessagingOptOut && c.optedOut) &&
      scopeAllows(c, config, requestServiceTypeId),
  )

  // batchSize 0 = no per-wave cap.
  const waveCap = config.batchSize === 0 ? eligible.length : config.batchSize
  // maxOutreachPerCampaign 0 = no campaign cap.
  const budget = config.maxOutreachPerCampaign === 0 ? eligible.length : Math.max(0, config.maxOutreachPerCampaign - contactedSoFar)

  return eligible.slice(0, Math.min(waveCap, budget))
}

export interface TerminationInput {
  hasSolution: boolean
  /** Ladder rungs not yet attempted. */
  laddersRemaining: number
  /** Offers still awaiting a reply (probing). */
  openOffers: number
  /** Eligible customers not yet contacted. */
  eligibleRemaining: number
  contactedSoFar: number
  maxOutreach: number
}

export type Termination = 'solved' | 'exhausted' | 'continue'

/**
 * Decide whether a campaign is done (decision G-6). It never declares "exhausted" while a
 * rung is untried or an offer is still open, and never hangs (every path is eventually
 * driven to solved or exhausted by replies + TTL ticks).
 */
export function evaluateTermination(input: TerminationInput): Termination {
  if (input.hasSolution) return 'solved'

  const capReached = input.maxOutreach > 0 && input.contactedSoFar >= input.maxOutreach
  const noMoreToDo = input.laddersRemaining === 0 && input.openOffers === 0 && (input.eligibleRemaining === 0 || capReached)

  return noMoreToDo ? 'exhausted' : 'continue'
}
