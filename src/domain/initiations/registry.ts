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
  // Out-of-window sends use the approved `reshuffle_probe` template.
  'reshuffle.probe': {
    id: 'reshuffle.probe',
    layer: 'A',
    audience: 'customer',
    consentClass: 'promotional',
    category: 'reshuffle',
    priority: 80,
    autonomy: 'owner_configured',
    delivery: 'managed',
    windowPolicy: { templateName: 'reshuffle_probe' },
    defaultEnabled: true,
  },

  // Layer A — cold-fill invite: profile-matched lapsed customers invited to take a freed
  // slot (the growth rung of the fill cascade, §7.5). Promotional → gate enforces opt-out
  // + window. Out-of-window sends use the approved `coldfill_invite` template.
  'coldfill.invite': {
    id: 'coldfill.invite',
    layer: 'A',
    audience: 'customer',
    consentClass: 'promotional',
    category: 'coldfill',
    priority: 70,
    autonomy: 'owner_configured',
    delivery: 'fire_and_forget',
    windowPolicy: { templateName: 'coldfill_invite' },
    defaultEnabled: true,
  },

  // Layer C — post-appointment review request (Phase 4a). owner_configured: fires only when
  // the owner enabled automatedMessagesConfig.review_request; the worker is the consumer of
  // that flag. Promotional → the gate enforces opt-out + window. Out-of-window sends now use
  // the approved `review_request` template (see src/adapters/whatsapp/templates.ts).
  'review.request': {
    id: 'review.request',
    layer: 'C',
    audience: 'customer',
    consentClass: 'promotional',
    category: 'review',
    priority: 30,
    autonomy: 'owner_configured',
    delivery: 'fire_and_forget',
    windowPolicy: { templateName: 'review_request' },
    defaultEnabled: true,
  },

  // Layer C — gentle no-show follow-up (Phase 4a). Same gating as review.request: the owner's
  // automatedMessagesConfig.no_show flag is the per-business switch (checked in the worker).
  // Promotional → opt-out respected. Out-of-window sends use the `no_show_followup` template.
  'booking.no_show_followup': {
    id: 'booking.no_show_followup',
    layer: 'C',
    audience: 'customer',
    consentClass: 'promotional',
    category: 'no_show',
    priority: 50,
    autonomy: 'owner_configured',
    delivery: 'fire_and_forget',
    windowPolicy: { templateName: 'no_show_followup' },
    defaultEnabled: true,
  },

  // Layer C — win-back of a lapsed customer (Phase 4b). ai_proposed: the detector does
  // NOT message the customer — it PROPOSES to the owner via the owner-confirm gate
  // (approvals.ts), and the customer send fires only on owner approval. Promotional →
  // the gate enforces opt-out + window. Out-of-window sends use the approved
  // `winback_reengage` template (both the direct-send and owner-approval paths).
  'churn.winback': {
    id: 'churn.winback',
    layer: 'C',
    audience: 'customer',
    consentClass: 'promotional',
    category: 'winback',
    priority: 60,
    autonomy: 'ai_proposed',
    delivery: 'fire_and_forget',
    windowPolicy: { templateName: 'winback_reengage' },
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
    windowPolicy: { templateName: 'payment_dunning_1' },
    defaultEnabled: true,
  },
  'payment.dunning_2': {
    id: 'payment.dunning_2',
    layer: 'C',
    audience: 'customer',
    consentClass: 'transactional',
    autonomy: 'owner_configured',
    delivery: 'fire_and_forget',
    windowPolicy: { templateName: 'payment_dunning_2' },
    defaultEnabled: true,
  },
  'payment.dunning_final': {
    id: 'payment.dunning_final',
    layer: 'C',
    audience: 'customer',
    consentClass: 'transactional',
    autonomy: 'owner_configured',
    delivery: 'fire_and_forget',
    windowPolicy: { templateName: 'payment_dunning_final' },
    defaultEnabled: true,
  },

  // Layer B — owner "payment received" notification (Grow Phase 3, design §7). The spine's
  // "🔴 needs processor webhook" row, now filled: when a Grow webhook confirms a payment,
  // reconcilePayment fires this so the owner can SEE money landed — but only as VOLUNTARY OAU.
  // The notification-rules resolver defaults payment_received to handle_silently (North Star:
  // drive the owner's involuntary attention toward zero); the owner opts in via
  // configureNotifications, and the Phase-6 trust ratchet can later ratchet it back to silent.
  // Owner audience, transactional, window-ungated (operational message to the business).
  'payment.received': {
    id: 'payment.received',
    layer: 'B',
    audience: 'owner',
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
  // in the subscription-renewal worker — it is the consumer). Out-of-window sends use the
  // approved `subscription_renewal_7d` / `subscription_renewal_1d` templates. Two rungs: 7
  // days and 1 day before `renewsAt`.
  'subscription.renewal_7d': {
    id: 'subscription.renewal_7d',
    layer: 'C',
    audience: 'customer',
    consentClass: 'transactional',
    autonomy: 'owner_configured',
    delivery: 'fire_and_forget',
    windowPolicy: { templateName: 'subscription_renewal_7d' },
    defaultEnabled: true,
  },
  'subscription.renewal_1d': {
    id: 'subscription.renewal_1d',
    layer: 'C',
    audience: 'customer',
    consentClass: 'transactional',
    autonomy: 'owner_configured',
    delivery: 'fire_and_forget',
    windowPolicy: { templateName: 'subscription_renewal_1d' },
    defaultEnabled: true,
  },

  // Layer C — post-appointment thank-you (Tier 2; catalog #14). owner_configured opt-in: the
  // post-appointment worker fires it ~after an attended appointment only when the owner enabled
  // the dedicated `businesses.postAppointmentThankyouEnabled` flag (a boolean column, mirroring
  // subscriptionRenewalEnabled — not an automatedMessagesConfig key). Transactional (a courtesy
  // tied to a completed transaction → the gate bypasses opt-out/quiet hours but still enforces
  // in-window-only). Out-of-window sends use the approved `post_appointment_thankyou` template.
  'post.thank_you': {
    id: 'post.thank_you',
    layer: 'C',
    audience: 'customer',
    consentClass: 'transactional',
    autonomy: 'owner_configured',
    delivery: 'fire_and_forget',
    windowPolicy: { templateName: 'post_appointment_thankyou' },
    defaultEnabled: true,
  },

  // Layer C — configurable reminder offset (Tier 2; catalog #15). Fires from the SAME reminder
  // worker as reminder.24h, but only when the business/service reminder offset differs from the
  // 24h default — its neutral-worded `appointment_reminder_custom` template carries no "tomorrow"
  // so any offset reads correctly. Transactional (reminder family → bypasses opt-out/quiet hours).
  'reminder.custom': {
    id: 'reminder.custom',
    layer: 'C',
    audience: 'customer',
    consentClass: 'transactional',
    autonomy: 'owner_configured',
    delivery: 'fire_and_forget',
    windowPolicy: { templateName: 'appointment_reminder_custom' },
    defaultEnabled: true,
  },

  // Layer C — business-originated booking changes the customer did NOT initiate (Tier 2; catalog
  // #23–25). owner_commanded + transactional: the owner's action (cancel / book-for / move) is the
  // trigger, and these are essential operational notices → the gate bypasses opt-out/quiet hours
  // but still enforces in-window-only, with the approved Utility template as the out-of-window
  // fallback. Per-event dedupKey (the change is the event, not a recurring schedule).
  'booking.cancelled_by_business': {
    id: 'booking.cancelled_by_business',
    layer: 'C',
    audience: 'customer',
    consentClass: 'transactional',
    autonomy: 'owner_commanded',
    delivery: 'fire_and_forget',
    windowPolicy: { templateName: 'booking_cancelled_by_business' },
    defaultEnabled: true,
  },
  'booking.confirmation': {
    id: 'booking.confirmation',
    layer: 'C',
    audience: 'customer',
    consentClass: 'transactional',
    autonomy: 'owner_commanded',
    delivery: 'fire_and_forget',
    windowPolicy: { templateName: 'booking_confirmation' },
    defaultEnabled: true,
  },
  'booking.moved_by_business': {
    id: 'booking.moved_by_business',
    layer: 'C',
    audience: 'customer',
    consentClass: 'transactional',
    autonomy: 'owner_commanded',
    delivery: 'fire_and_forget',
    windowPolicy: { templateName: 'booking_moved_by_business' },
    defaultEnabled: true,
  },

  // Layer C — periodic-treatment nudge (Tier 2; catalog #16). owner_configured opt-in via
  // `businesses.periodicTreatmentEnabled`; a detector worker finds customers whose last visit
  // exceeds the service's recommended_interval_days. Promotional → the gate enforces opt-out +
  // quiet hours + attention budget. Out-of-window sends use the `periodic_treatment_due` template.
  'periodic.treatment_due': {
    id: 'periodic.treatment_due',
    layer: 'C',
    audience: 'customer',
    consentClass: 'promotional',
    category: 'periodic',
    priority: 40,
    autonomy: 'owner_configured',
    delivery: 'fire_and_forget',
    windowPolicy: { templateName: 'periodic_treatment_due' },
    defaultEnabled: true,
  },

  // Layer C — birthday greeting (Tier 2; catalog #17). owner_configured opt-in via
  // `businesses.birthdayGreetingsEnabled`; a detector worker finds customers whose birthday is
  // today. Promotional → opt-out + quiet hours + budget enforced. Out-of-window sends use the
  // `birthday_greeting` template.
  'birthday.greeting': {
    id: 'birthday.greeting',
    layer: 'C',
    audience: 'customer',
    consentClass: 'promotional',
    category: 'birthday',
    priority: 20,
    autonomy: 'owner_configured',
    delivery: 'fire_and_forget',
    windowPolicy: { templateName: 'birthday_greeting' },
    defaultEnabled: true,
  },

  // Layer A — owner-triggered broadcast announcements to a customer segment (Tier 2; catalog
  // #19–21). owner_commanded + promotional: the owner dictates one of three fixed-shape updates
  // (hours / address / promo), the broadcast runner fans it out through the gate per recipient
  // (opt-out + quiet hours + attention budget + blast-radius breaker). Out-of-window sends use the
  // matching `broadcast_*` template.
  'broadcast.hours_change': {
    id: 'broadcast.hours_change',
    layer: 'A',
    audience: 'customer',
    consentClass: 'promotional',
    category: 'broadcast',
    priority: 35,
    autonomy: 'owner_commanded',
    delivery: 'fire_and_forget',
    windowPolicy: { templateName: 'broadcast_hours_change' },
    defaultEnabled: true,
  },
  'broadcast.address_change': {
    id: 'broadcast.address_change',
    layer: 'A',
    audience: 'customer',
    consentClass: 'promotional',
    category: 'broadcast',
    priority: 35,
    autonomy: 'owner_commanded',
    delivery: 'fire_and_forget',
    windowPolicy: { templateName: 'broadcast_address_change' },
    defaultEnabled: true,
  },
  'broadcast.promo': {
    id: 'broadcast.promo',
    layer: 'A',
    audience: 'customer',
    consentClass: 'promotional',
    category: 'broadcast',
    priority: 35,
    autonomy: 'owner_commanded',
    delivery: 'fire_and_forget',
    windowPolicy: { templateName: 'broadcast_promo' },
    defaultEnabled: true,
  },
} satisfies Record<string, Initiator>

export type InitiatorId = keyof typeof INITIATORS

export function getInitiator(id: InitiatorId): Initiator {
  return INITIATORS[id]
}
