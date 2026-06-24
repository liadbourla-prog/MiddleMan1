// Proactive Initiations — shared types.
//
// An Initiator is a declaration (config object), not a worker. Every proactive
// outbound passes its declaration + gathered facts through the pure Eligibility Gate
// (gate.ts), which returns a GateDecision the dispatcher (dispatch.ts) executes.
// Design: docs/superpowers/specs/2026-06-22-proactive-initiations-engine-design.md

import type { BlastBreakerConfig } from './blast-breaker.js'

export type Layer = 'A' | 'B' | 'C'
export type Audience = 'customer' | 'owner' | 'operator' | 'contact'
export type Autonomy = 'owner_commanded' | 'owner_configured' | 'ai_proposed'
export type Delivery = 'fire_and_forget' | 'managed'

// Transactional sends are essential + time-anchored (reminders, operational alerts):
// they bypass opt-out and quiet-hours. Promotional sends respect both.
export type ConsentClass = 'transactional' | 'promotional'

// Out-of-24h-window behavior for customer/contact audiences:
//  - { templateName } → send the named Meta-approved template
//  - 'skip'           → do not send out of window (explicit + logged)
export type WindowPolicy = { templateName: string } | 'skip'

export interface Initiator {
  id: string // 'reminder.24h', 'escalation.owner_rule', 'reshuffle.probe'
  layer: Layer
  audience: Audience
  consentClass: ConsentClass
  autonomy: Autonomy
  delivery: Delivery
  windowPolicy: WindowPolicy // applies to customer/contact audiences only
  defaultEnabled: boolean
  // Populated by later phases (attention budget, value gate, owner-confirm):
  priority?: number
  // Promotional consent + attention-budget category (Phase 5.1/5.3). Set on promotional
  // initiators; the per-category opt-out and the budget group on this. Transactional initiators
  // leave it unset.
  category?: string
  // Blast-radius breaker config for mass campaigns (Phase 5.4; design §4.6). Optional partial —
  // the campaign loop merges it over DEFAULT_BLAST_BREAKER via resolveBlastBreaker. Unset = defaults.
  blastBreaker?: Partial<BlastBreakerConfig>
}

// Facts the dispatcher gathers and feeds to the pure gate. The gate does no I/O and
// no timezone math: the dispatcher pre-computes nowInQuietHours so the gate stays a
// trivially-testable truth table.
export interface GateInput {
  audience: Audience
  consentClass: ConsentClass
  windowPolicy: WindowPolicy
  enabled: boolean
  windowOpen: boolean // canSendFreeForm(recipient) — meaningful for customer/contact
  recipientOptedOut: boolean // identities.messagingOptOut
  nowInQuietHours: boolean // dispatcher computes from business timezone + quiet hours
}

export type SkipReason =
  | 'disabled'
  | 'opted_out'
  | 'quiet_hours'
  | 'outside_window_no_template'
  | 'dedup_hit' // never returned by the pure gate; produced by dispatch when the ledger insert collides
  | 'budget_exhausted' // never returned by the pure gate; produced by dispatch when the per-customer promotional budget is spent

export type GateDecision =
  | { kind: 'send_free_form' }
  | { kind: 'send_template'; templateName: string }
  | { kind: 'skip'; reason: SkipReason }
