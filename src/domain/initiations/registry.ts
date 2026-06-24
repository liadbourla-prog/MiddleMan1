// The Initiator registry — every proactive outbound is a declaration here, not a
// bespoke worker. Phase 1 declares the three initiators being migrated onto the spine
// (reminder, escalation, reshuffle probe). Adding a future initiator = adding an entry.

import type { Initiator } from './types.js'

export const INITIATORS = {
  // Layer C — time-before reminders (customer, transactional → bypass opt-out/quiet).
  'reminder.24h': {
    id: 'reminder.24h',
    layer: 'C',
    audience: 'customer',
    consentClass: 'transactional',
    autonomy: 'owner_configured',
    delivery: 'fire_and_forget',
    windowPolicy: { templateName: 'appointment_reminder_24h' },
    defaultEnabled: true,
  },
  'reminder.1h': {
    id: 'reminder.1h',
    layer: 'C',
    audience: 'customer',
    consentClass: 'transactional',
    autonomy: 'owner_configured',
    delivery: 'fire_and_forget',
    windowPolicy: { templateName: 'appointment_reminder_1h' },
    defaultEnabled: true,
  },

  // Layer B — escalation notifications to the business (operational; window-ungated).
  'escalation.owner_rule': {
    id: 'escalation.owner_rule',
    layer: 'B',
    audience: 'owner',
    consentClass: 'transactional',
    autonomy: 'owner_configured',
    delivery: 'fire_and_forget',
    windowPolicy: 'skip',
    defaultEnabled: true,
  },
  'escalation.platform': {
    id: 'escalation.platform',
    layer: 'B',
    audience: 'operator',
    consentClass: 'transactional',
    autonomy: 'owner_configured',
    delivery: 'fire_and_forget',
    windowPolicy: 'skip',
    defaultEnabled: true,
  },

  // Layer A — reshuffle outreach probe (customer, promotional, managed conversation).
  // No approved template yet → out-of-window sends are skipped (preserves current behavior).
  'reshuffle.probe': {
    id: 'reshuffle.probe',
    layer: 'A',
    audience: 'customer',
    consentClass: 'promotional',
    category: 'reshuffle',
    priority: 80,
    autonomy: 'owner_configured',
    delivery: 'managed',
    windowPolicy: 'skip',
    defaultEnabled: true,
  },

  // Layer A — cold-fill invite: profile-matched lapsed customers invited to take a freed
  // slot (the growth rung of the fill cascade, §7.5). Promotional → gate enforces opt-out
  // + window. No approved template yet → out-of-window sends are skipped (in-window only).
  'coldfill.invite': {
    id: 'coldfill.invite',
    layer: 'A',
    audience: 'customer',
    consentClass: 'promotional',
    category: 'coldfill',
    priority: 70,
    autonomy: 'owner_configured',
    delivery: 'fire_and_forget',
    windowPolicy: 'skip',
    defaultEnabled: true,
  },

  // Layer C — post-appointment review request (Phase 4a). owner_configured: fires only when
  // the owner enabled automatedMessagesConfig.review_request; the worker is the consumer of
  // that flag. Promotional → the gate enforces opt-out + window. windowPolicy:'skip' → no
  // approved template, so out-of-window sends are skipped (in-window only).
  'review.request': {
    id: 'review.request',
    layer: 'C',
    audience: 'customer',
    consentClass: 'promotional',
    category: 'review',
    priority: 30,
    autonomy: 'owner_configured',
    delivery: 'fire_and_forget',
    windowPolicy: 'skip',
    defaultEnabled: true,
  },

  // Layer C — gentle no-show follow-up (Phase 4a). Same gating as review.request: the owner's
  // automatedMessagesConfig.no_show flag is the per-business switch (checked in the worker).
  // Promotional + windowPolicy:'skip' → opt-out respected, in-window only.
  'booking.no_show_followup': {
    id: 'booking.no_show_followup',
    layer: 'C',
    audience: 'customer',
    consentClass: 'promotional',
    category: 'no_show',
    priority: 50,
    autonomy: 'owner_configured',
    delivery: 'fire_and_forget',
    windowPolicy: 'skip',
    defaultEnabled: true,
  },

  // Layer C — win-back of a lapsed customer (Phase 4b). ai_proposed: the detector does
  // NOT message the customer — it PROPOSES to the owner via the owner-confirm gate
  // (approvals.ts), and the customer send fires only on owner approval. Promotional →
  // the gate enforces opt-out + window. No approved template yet → out-of-window skipped.
  'churn.winback': {
    id: 'churn.winback',
    layer: 'C',
    audience: 'customer',
    consentClass: 'promotional',
    category: 'winback',
    priority: 60,
    autonomy: 'ai_proposed',
    delivery: 'fire_and_forget',
    windowPolicy: 'skip',
    defaultEnabled: true,
  },

  // Layer C — the FIRST pay-link send for a post_payment booking (Grow Phase 2, design §3.1).
  // Transactional ("payment due" is an always-sent operational message → the gate bypasses
  // opt-out + quiet hours), fire_and_forget, customer audience. The owner's EXISTING
  // automatedMessagesConfig.payment_request.enabled flag is the per-business switch (the
  // payment-request worker is its consumer). One link per booking via dedupKey
  // payment.request:{bookingId}; the payment.dunning_* rungs escalate separately if unpaid.
  // windowPolicy:'skip' → no approved Meta template yet, so out-of-window sends are skipped.
  'payment.request': {
    id: 'payment.request',
    layer: 'C',
    audience: 'customer',
    consentClass: 'transactional',
    autonomy: 'owner_configured',
    delivery: 'fire_and_forget',
    windowPolicy: 'skip',
    defaultEnabled: true,
  },

  // Layer C — payment dunning over internal `pending_payment` booking state (Phase 4b). No
  // external payment processor: a booking sits in `pending_payment` until paid, and these
  // three rungs nudge the customer to complete payment as that state ages. Transactional
  // (design §7 — "payment due" is an always-sent operational message, so the gate bypasses
  // opt-out + quiet hours). The per-business switch is the owner's EXISTING
  // automatedMessagesConfig.payment_request.enabled flag (checked in the dunning worker — it
  // is the consumer). windowPolicy:'skip' → no approved Meta template yet, so out-of-window
  // sends are skipped (in-window only) until one exists. Three separate entries (one per rung,
  // mirroring reminder.24h/reminder.1h) escalate in tone as the booking's age grows.
  'payment.dunning_1': {
    id: 'payment.dunning_1',
    layer: 'C',
    audience: 'customer',
    consentClass: 'transactional',
    autonomy: 'owner_configured',
    delivery: 'fire_and_forget',
    windowPolicy: 'skip',
    defaultEnabled: true,
  },
  'payment.dunning_2': {
    id: 'payment.dunning_2',
    layer: 'C',
    audience: 'customer',
    consentClass: 'transactional',
    autonomy: 'owner_configured',
    delivery: 'fire_and_forget',
    windowPolicy: 'skip',
    defaultEnabled: true,
  },
  'payment.dunning_final': {
    id: 'payment.dunning_final',
    layer: 'C',
    audience: 'customer',
    consentClass: 'transactional',
    autonomy: 'owner_configured',
    delivery: 'fire_and_forget',
    windowPolicy: 'skip',
    defaultEnabled: true,
  },

  // Layer C — time-before subscription-renewal reminders over the internal `subscriptions`
  // table (Phase 4c). No external processor: a subscription's `renewsAt` is just the scan
  // anchor, and these two rungs remind the customer ahead of that date (no auto-charge).
  // Transactional (design §7 — sits in the time-before reminder family alongside
  // reminder.24h/reminder.1h, so the gate bypasses opt-out + quiet hours). The per-business
  // switch is the owner's `businesses.subscriptionRenewalEnabled` flag (default OFF, checked
  // in the subscription-renewal worker — it is the consumer). windowPolicy:'skip' → no
  // approved Meta template yet, so out-of-window sends are skipped (in-window only) until one
  // exists. Two rungs: 7 days and 1 day before `renewsAt`.
  'subscription.renewal_7d': {
    id: 'subscription.renewal_7d',
    layer: 'C',
    audience: 'customer',
    consentClass: 'transactional',
    autonomy: 'owner_configured',
    delivery: 'fire_and_forget',
    windowPolicy: 'skip',
    defaultEnabled: true,
  },
  'subscription.renewal_1d': {
    id: 'subscription.renewal_1d',
    layer: 'C',
    audience: 'customer',
    consentClass: 'transactional',
    autonomy: 'owner_configured',
    delivery: 'fire_and_forget',
    windowPolicy: 'skip',
    defaultEnabled: true,
  },
} satisfies Record<string, Initiator>

export type InitiatorId = keyof typeof INITIATORS

export function getInitiator(id: InitiatorId): Initiator {
  return INITIATORS[id]
}
