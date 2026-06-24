# WhatsApp Template Catalog — 24-Hour Window Coverage

**Date:** 2026-06-24
**Status:** catalog approved (Hebrew); **Phase 1 (Tier 1) wired + provisioning routine built & tested**; **Phase 2 (Tier 2) wired** (triggers/workers/fields + WABA-id capture + backfill CLI)
**Owner:** Developer A (system)
**Source of truth (code):** [`src/adapters/whatsapp/templates.ts`](../../../src/adapters/whatsapp/templates.ts)

---

## 1. Problem

Outside WhatsApp's 24-hour customer-service window, only Meta-approved **template** messages may
be sent. Most of our proactive initiators ([`src/domain/initiations/registry.ts`](../../../src/domain/initiations/registry.ts))
were set to `windowPolicy: 'skip'` — meaning a customer who hadn't messaged in 24h got **nothing**.
For win-back, dunning, renewal, cold-fill, and business-originated changes, the cold customer *is*
the entire audience, so "skip" silently defeats the feature.

## 2. Meta's constraints (verified 2026-06)

- **Template limit:** 250 per WABA (unverified portfolio) / 6,000 (verified). 100 created/hour. We
  use ~25 — count is a non-issue.
- **Variables:** positional `{{1}}..{{n}}`. Body ≤ 15 vars, header ≤ 1. **Anything per-recipient
  (name, service, date, amount) MUST be a variable** — Meta rejects hard-coded per-customer data.
- **Categories:** Utility (transaction-triggered, cheapest, no per-user cap) maps to our
  `consentClass: 'transactional'`; Marketing (promotional, charged, per-user cap, opt-out) maps to
  `'promotional'`.
- **Per-language:** each language is its own translation under one template name. **Hebrew only** for
  soft launch.

## 3. WABA ownership — templates are per-business, not central

Each business has its **own WABA** (Embedded Signup as Tech Provider — [ONBOARDING_DESIGN.md](../../../ONBOARDING_DESIGN.md)
§5; per-business creds in [`schema.ts`](../../../src/db/schema.ts) `whatsapp_*`). Templates are owned
at the WABA level, so the approved objects must exist **inside every business's WABA**. The MiddleMan
number is only the onboarding channel.

**Resolution:** author the catalog **once** ([`templates.ts`](../../../src/adapters/whatsapp/templates.ts)),
then a **provisioning routine replicates it into each business's WABA** via the Graph API at
onboarding (build item — see §6). Consequences:
1. Cannot approve once centrally; each WABA approves its own copy.
2. A new business has no approved templates day-one → out-of-window sends stay `skip` until its WABA
   clears review. **Sequencing risk:** don't point `windowPolicy` at a template a live business's WABA
   hasn't provisioned. Safe today (no businesses provisioned).
3. The MiddleMan WABA needs its own small set for messages *it* sends (e.g. coexistence nudge).

## 4. On-demand generation — rejected as the primary path

Template *creation* is API-automatable, but **approval is an external gate** (often minutes for
Utility, but up to 24h, and can be rejected). A time-sensitive window-crossing send cannot wait. And
per-live-case generation is the wrong unit: per-case differences are exactly what variables absorb;
one template serves all customers forever. → Pre-approve the finite set; automate only the *upload*.
On-demand creation is a future self-extension fallback for genuinely novel message kinds (submit →
wait for approval → enable), never the real-time path.

## 5. The catalog (25 templates, Hebrew)

Full copy + variable order live in [`templates.ts`](../../../src/adapters/whatsapp/templates.ts). `U`=Utility, `M`=Marketing.

| # | Name | Cat | Variables | Status |
|---|---|---|---|---|
| 1 | `appointment_reminder_24h` | U | service, business, date, time | live |
| 2 | `appointment_reminder_1h` | U | service, business, time | live |
| 3 | `waitlist_slot_offer` | U | business, service, date, hold_minutes | live |
| 4 | `payment_dunning_1` | U | service, business | Tier 1 |
| 5 | `payment_dunning_2` | U | service, business | Tier 1 |
| 6 | `payment_dunning_final` | U | service, business | Tier 1 |
| 7 | `subscription_renewal_7d` | U | plan, business, date | **wired** |
| 8 | `subscription_renewal_1d` | U | plan, business, date | **wired** |
| 9 | `no_show_followup` | U | business | **wired** |
| 10 | `review_request` | M | business | **wired** |
| 11 | `reshuffle_probe` | M | business, proposed_time | Tier 1 |
| 12 | `coldfill_invite` | M | business, service, date | Tier 1 |
| 13 | `winback_reengage` | M | business | Tier 1 |
| 14 | `post_appointment_thankyou` | U | service, business | Tier 2 (runner) |
| 15 | `appointment_reminder_custom` | U | service, business, date, time | Tier 2 (offset field) |
| 16 | `periodic_treatment_due` | M | service, business | Tier 2 (opt-in + interval) |
| 17 | `birthday_greeting` | M | name, business | Tier 2 (opt-in + detector) |
| 18 | `contact_meeting_outreach` | U | sender_name, proposed_times | Tier 2 (coordination fallback) |
| 19 | `broadcast_hours_change` | M | business, hours | Tier 2 (broadcast runner) |
| 20 | `broadcast_address_change` | M | business, address | Tier 2 |
| 21 | `broadcast_promo` | M | business, promo | Tier 2 |
| 22 | `reschedule_favor_request` | U | business, current_time, new_time | Tier 2 (messageCustomer fallback) |
| 23 | `booking_cancelled_by_business` | U | business, service, date | Tier 2 |
| 24 | `booking_confirmation` | U | business, service, date, time | Tier 2 |
| 25 | `booking_moved_by_business` | U | business, current_time, new_time | Tier 2 |

### Locked decisions
- Copy reuses the proven in-codebase Hebrew; "תזכורת ידידותית" → **"מזכירים!"** (#5, #7). Plain
  "תזכורת" openers (#1/#2/#8) kept as-is.
- **#15** reminder offset: per-business default **24h**, optional per-service override; neutral
  wording (no "tomorrow") so any offset works.
- **#16 periodic** + **#17 birthday**: **opt-in** (owner toggles; PA may suggest).
- **Broadcast** (#19–21): fixed-shape templates, not one free-text variable (Meta won't approve that).
- **Dunning out-of-window** (#4–6): **link-less by design.** The Grow pay-link rides the free-form
  path; when a cold customer replies (opening the window) the link follows. Meta Utility templates
  shouldn't carry raw payment URLs.
- **Referral thank-you: deferred** — needs referral attribution that doesn't exist yet.

## 6. Build sequence

- **Foundation (✅ done):** [`templates.ts`](../../../src/adapters/whatsapp/templates.ts) catalog +
  `bodyComponents` helper.
- **Tier 1 — un-muzzle existing workers (✅ ALL DONE)** (registry `windowPolicy` flip +
  `sendTemplate` executor, pattern from [`reminder.ts`](../../../src/workers/reminder.ts)):
  - ✅ `subscription.renewal_7d/1d` ([subscription-renewal.ts](../../../src/workers/subscription-renewal.ts))
  - ✅ `review.request`, `booking.no_show_followup` ([post-appointment.ts](../../../src/workers/post-appointment.ts))
  - ✅ `payment.dunning_1/2/final` ([dunning.ts](../../../src/workers/dunning.ts)) — link-less template
  - ✅ `reshuffle.probe` ([reshuffle-campaign.ts](../../../src/workers/reshuffle-campaign.ts))
  - ✅ `coldfill.invite` ([waitlist.ts](../../../src/workers/waitlist.ts))
  - ✅ `churn.winback` ([winback.ts](../../../src/workers/winback.ts)) direct send + the owner-approval
    path ([approvals.ts](../../../src/domain/initiations/approvals.ts), now sends the template out of window)
  - Note: `payment.request` (initial pay-link send) intentionally stays `skip` — its whole purpose is
    delivering a URL, which a Meta Utility template can't carry; the link rides the free-form path.
- **Provisioning (✅ DONE — the per-WABA mechanism):**
  - `businesses.whatsapp_business_account_id` column + `wa_template_provisioning` ledger
    ([schema.ts](../../../src/db/schema.ts), migration
    [0040_wa_template_provisioning.sql](../../../src/db/migrations/0040_wa_template_provisioning.sql)).
  - [`template-provisioning.ts`](../../../src/adapters/whatsapp/template-provisioning.ts):
    `provisionTemplatesForBusiness` (idempotent Graph API create per template, ledger upsert,
    "already exists" treated as success) + `provisionAllBusinesses` backfill. Pure core unit-tested.
  - Triggered best-effort at onboarding completion ([manager-onboarding.ts](../../../src/domain/flows/manager-onboarding.ts)).
  - **WABA-id capture (✅ DONE):** the Embedded Signup / OAuth callback now stores the resolved
    `waba_id` onto `businesses.whatsapp_business_account_id` ([oauth.ts](../../../src/routes/oauth.ts)
    → [provider-onboarding.ts](../../../src/domain/flows/provider-onboarding.ts) `provisionBusiness`),
    so the onboarding-completion trigger ([manager-onboarding.ts](../../../src/domain/flows/manager-onboarding.ts))
    actually fires instead of no-opping with `skippedReason: 'no_waba'`.
  - **Backfill CLI (✅ DONE):** `npm run backfill:templates`
    ([scripts/backfill-templates.ts](../../../scripts/backfill-templates.ts)) wraps
    `provisionAllBusinesses` for re-provisioning after WABA capture or catalog changes.
- **Tier 2 — new builds (✅ DONE):**
  - **#14** post-appointment thank-you: `post.thank_you` initiator + `businesses.post_appointment_thankyou_enabled`
    opt-in; fires ~1–4h after an attended appointment from [post-appointment.ts](../../../src/workers/post-appointment.ts)
    (`thankYouDueWindow`).
  - **#15** configurable reminder offset: `businesses.reminder_offset_hours` (default 24) +
    `service_types.reminder_offset_hours` override, used in [reminder.ts](../../../src/workers/reminder.ts);
    non-default offset → neutral `appointment_reminder_custom` via the `reminder.custom` initiator.
  - **#16** periodic-treatment nudge: `businesses.periodic_treatment_enabled` +
    `service_types.recommended_interval_days`; detector [periodic-treatment.ts](../../../src/workers/periodic-treatment.ts).
  - **#17** birthday greeting: `businesses.birthday_greetings_enabled`; detector
    [birthday.ts](../../../src/workers/birthday.ts) over `identities.birthday`.
  - **#18** coordination contact template fallback: cold-contact first outreach in
    [handler.ts](../../../src/domain/coordination/handler.ts) now falls back to
    `contact_meeting_outreach` when out of window (was failing today).
  - **#19–21** broadcast: `broadcastAnnouncement` Branch-3 tool + [broadcast.ts](../../../src/domain/initiations/broadcast.ts)
    runner (segment fan-out + blast-breaker), `broadcast.{hours_change,address_change,promo}` initiators.
  - **#22–25** business-originated booking notifications: [booking-notify.ts](../../../src/domain/initiations/booking-notify.ts)
    helper + `booking.{cancelled_by_business,confirmation,moved_by_business}` initiators, wired into the
    business-cancel sites ([engine.ts](../../../src/domain/booking/engine.ts) manager cancel,
    [inbound-sync.ts](../../../src/domain/calendar/inbound-sync.ts) owner-Google cancel,
    [session-cancellation.ts](../../../src/domain/scheduling/session-cancellation.ts) class cancel);
    `reschedule_favor_request` wired into the `messageCustomer` out-of-window favour path. (Note: the
    codebase has no auto move/confirm-a-customer-booking flow — time-moves are blocked while seats are
    booked and owner event-creation makes blocks, not customer bookings — so the `confirmation`/`moved`
    initiators + helper branches are ready for a future such flow; the move story today is the favour request.)
  - **Migration:** [0041_template_phase2_fields.sql](../../../src/db/migrations/0041_template_phase2_fields.sql)
    adds the four `businesses` columns + two `service_types` columns (idempotent).
