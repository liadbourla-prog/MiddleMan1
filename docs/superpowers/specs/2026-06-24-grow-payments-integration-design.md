# Grow Payments Integration — Design & Phased Plan

**Date:** 2026-06-24
**Branch (intended):** `dev/system/grow-payments` (Developer A — `src/adapters`, `src/domain`, `src/db`, `src/routes`, `src/workers`; **not** `src/skills`)
**Status:** Design — no code yet. Decisions in §4 are locked (owner-confirmed). §11 has Grow-support questions still open.
**Related:** `2026-06-22-proactive-initiations-engine-design.md` (the spine this plugs into), `CALENDAR_UX_DESIGN.md` (the integration/OAuth analog), `CHAT_LEVEL_LAWBOOK.md` (all customer/owner phrasing).

---

## 0. North star & scope

From the proactive-initiations North Star: *maximize bookings/week while driving the owner's
**involuntary** attention to the CRM toward zero — **payments**, cancellations, booking
movement, and calendar fill all handled by the PA under the owner's own rules.*

Payments are named explicitly. This integration delivers the **money plane** the system was
deliberately built around but left empty: an external processor (Grow) that turns an internal
`pending_payment` booking into a real pay-link + invoice, and — via webhook — confirms payment
**with the owner nowhere on the critical path.**

**Two hard requirements (owner-stated):**
1. **Full automation, independent of manual owner action.** The loop *create link → customer
   pays → booking confirmed → invoice sent → dunning cancelled* must run without an owner tap.
   The owner appears only as **voluntary OAU** (a notification he explicitly asked for).
2. **One-time onboarding.** Credentials captured/validated once, stored encrypted, webhook
   registered once. Never re-prompted.

**In scope (v1):** one-off + booking-driven pay-links, auto-invoice forwarding, webhook-driven
confirmation, dunning wired to real links, owner pay-received notification, self-serve
credential onboarding.
**Out of scope (v1):** subscription **auto-charge** (reminder-only model stays), card
tokenization / saved-card charging, refund automation (manual via owner command only),
Grow partner/aggregator provisioning (parallel BD track, §11).

---

## 1. What already exists — Grow fills one specific hole

The PA already has the entire payment **control plane**. Verified against the tree:

- **Booking state machine** (`src/db/schema.ts`, `src/domain/booking/engine.ts`):
  `pending_payment` state, `paymentStatus` (`not_required|pending|paid|failed`),
  `requiresPayment`, `paymentAmount`, `confirmationGate` (`immediate|post_payment`).
  `engine.ts` already transitions `requested → pending_payment` when the gate is
  `post_payment` (`engine.ts:278`), and already has the `pending_payment → confirmed/paid`
  edge (`engine.ts:800`).
- **The manual edge we are replacing:** that confirm edge is today triggered by
  `metadata: { triggeredBy: 'manager_paid_command' }` (`engine.ts:813`) — the owner manually
  telling the PA "client X paid." **Grow's success webhook replaces this command.** This is
  the single clearest proof requirement #1 is currently unmet.
- **Proactive dunning sequence** already built: `src/domain/crm/dunning.ts` +
  `src/workers/dunning.ts`, registered as `payment.dunning_{1,2,final}` initiators on the
  spine (2h/24h/72h on internal `pending_payment`). Today it sends a bare reminder; it needs
  a **real pay-link** in the message and **cancellation on payment**.
- **Proactive spine** (`src/domain/initiations/`): eligibility gate, two-tier consent
  (transactional/promotional), quiet hours, attention budget, audit, `initiation_log` dedup.
  Its design names payment as the gap: *"what's missing is an external processor + dunning
  sequence"* and *"payment received / large deal → 🔴 needs processor webhook."*
- **`payment_request` automated-message template slot** in `skill-types.ts:98`.
- **Subscriptions** table (`schema.ts:681`) — flagged *"NO external payment processor, so
  informational + reminder-driving only."*

**Conclusion:** this is an **adapter + domain service + secured webhook + one onboarding
step** — not a re-architecture. Everything downstream already exists.

---

## 2. Grow — capabilities & constraints (researched)

Grow (formerly **Meshulam**) — Israel's dominant SMB processor; Hebrew-first; Bit/PayBox/
Apple-Google Pay/bank-transfer/cards-3DS. `currency` default is already `ILS`.

**Light API — what we use (server-to-server):**
| Need | Grow operation | Notes |
|---|---|---|
| Pay-link | `createPaymentProcess` | `sum`, `description`, `pageField[fullName/phone/email]`, `successUrl`, `cancelUrl`, `notifyUrl`. Returns hosted payment URL + process id. |
| Invoice | auto VAT invoice on success | Webhook returns `invoiceNumber` + `invoiceUrl` (hosted PDF). No owner invoicing. |
| Confirmation | **Notify-URL webhook** | `transactionCode`, `paymentSum`, `cardSuffix`, `payerPhone`, `invoiceNumber`, `invoiceUrl`. |
| Close the loop | **`approveTransaction`** | **Mandatory.** Must ack each webhook back to Grow or the transaction stays unsettled. |
| Refund | `refundTransaction` | v1: owner-commanded only. |

**Hard constraints (shape the adapter):**
- **Per-merchant static credentials:** `userId` + `pageCode` + `apiKey`. **No OAuth, no public
  connect flow** — even Wix uses manual credential entry.
- **`userId`/`pageCode` are provisioned by Grow** "during the API initial setting," and
  **webhooks must be enabled by Grow support** per account → there is an **upstream owner
  hurdle** before our form can be filled (§4.3).
- **Server-side only** (client requests blocked — fits us).
- **`multipart/form-data`, not JSON** (adapter must encode this way).
- **No documented webhook signature** → we add our own verification (§8).
- Hosts: `sandbox.meshulam.co.il` / `api.meshulam.co.il`.

> Sources: grow.business; grow-il.readme.io (overview-6, overview-7, createPaymentProcess);
> Wix "Connecting Grow by Meshulam"; make.com/en/integrations/grow (vendor-maintained Grow
> connector — confirms the REST API exposes Create Payment Link / Approve / Refund / webhook).

---

## 3. The two payment cases → one pipeline

Two triggers, one deterministic pipeline. The difference is **only trigger + autonomy class**.

**Case A — timed / event-driven (Layer C, fire_and_forget, transactional):**
booking with `confirmationGate=post_payment` (or a `requires_payment` service) → pay-link;
dunning if unpaid; (later) subscription renewal, deposit/cancellation fee. Detectors already
exist. **The send time is owner-configurable** — see §3.1.

### 3.1 Owner-configurable pay-link timing (`payment.request` initiator)

The owner decides **when** the link goes out relative to the appointment: at booking time,
or a fixed offset before/after `slot_start` (e.g. 24h before, 1h before, 1h after). This is a
**scheduled Layer-C initiator anchored on `slot_start`** — structurally identical to the
existing `reminder.24h` / `reminder.1h` (which already fire at a fixed offset before the slot)
and driven by a worker tick, not by the booking moment.

- New initiator **`payment.request`** in `src/domain/initiations/registry.ts`
  (layer C, audience customer, consentClass **transactional** → always allowed,
  delivery fire_and_forget). `dedupKey` = `payment.request:{bookingId}` (one link per booking;
  dunning escalates separately).
- New worker `src/workers/payment-request.ts` ticks (hourly, like the reminder/dunning
  workers), scans `post_payment`/`requires_payment` bookings whose
  `slot_start − offset` has arrived and that have no `paid` `payment_requests` row yet, and
  calls `PaymentService.createCharge`.
- **Owner config:** a per-business send policy — `at_booking` (default, today's behavior) or
  an offset in minutes relative to `slot_start` (negative = before, positive = after). Edited
  conversationally through the Branch-3 orchestrator ("send pay-links 24h before the
  appointment"), persisted on `businesses` (§6). Mirrors how reminder/automated-message
  timing is owner-controlled today.
- **Composition with dunning:** `payment.request` sends the *first* link at the owner's
  chosen time; the existing `payment.dunning_*` rungs escalate only if still unpaid. The
  cancel-on-pay logic (§7) clears both.

**Case B — owner-called (Layer A: Branch 3 → Branch 4, owner_commanded):**
owner tells the PA in management chat "send Dana a link for the ₪300 session" → new
orchestrator tool `requestPayment` → same pay-link + invoice → delivered into the customer's
Branch-4 conversation.

```
Case A (timed) ──┐
Case B (owner B3)─┼─► PaymentService.createCharge(bookingId | adhoc)
dunning/subs ─────┘        ├─ Grow adapter: createPaymentProcess (multipart, notifyUrl=our webhook)
                           ├─ persist payment_request row (link, processId, expiry, dedupKey)
                           ▼
                     send link into Branch 4  (eligibility gate: transactional)
                           │
   Grow webhook (paid) ────┤  verify → approveTransaction → reconcilePayment:
                           │   • booking pending_payment → confirmed/paid (replaces manual cmd)
                           │   • attach invoiceUrl, forward invoice PDF to customer
                           │   • cancel pending payment.dunning_* initiators
                           ▼
                     owner notified per his notification rules (voluntary OAU; ratchets to silent)
```

Honors **CLAUDE.md Principle 1**: in Case B the LLM only extracts intent
(`{customer, amount, description}`); the deterministic `PaymentService` validates and calls
Grow. **The LLM never touches money.**

---

## 4. Onboarding — credential capture (DECIDED)

**Account model: self-serve now, partnership later.** Each business uses its **own** Grow
account; we read its credentials. Partnership (master-merchant) is a parallel BD track (§11)
that, if it lands, swaps **only** the capture step — nothing downstream changes, because all
of §5–§7 keys off our stored `business_payment_credentials`, not how they arrived.

### 4.1 Capture mechanism — one-time signed web form (NOT WhatsApp)

Mirrors the existing CSV-import pattern (`import_tokens` + upload page). **Secrets must never
enter a WhatsApp message** — a chat-pasted `apiKey` would be copied into
`conversation_messages`, audit/logs, and the owner's Meta Business Suite inbox (outside our
control) and could never be reliably scrubbed.

Flow:
1. New `payment` onboarding step (the enum value **already exists** in `businesses.onboarding_step`),
   **or** on-demand post-onboarding via a Branch-3 "connect payments" intent.
2. PA sends a **one-time signed link** (new `payment_connect_tokens`: UUID secret, 30-min
   expiry, single-use — exact `import_tokens` shape).
3. Owner pastes `userId`, `pageCode`, `apiKey` into a small web form (TLS → backend), with
   **inline guidance** (where in the Grow dashboard to find them; what to ask Grow to enable).
4. Backend **validates live** against Grow (a zero-effect probe, e.g. `getApiInfo` / a
   sandbox call) before accepting.
5. Store in **Secret Manager** (apiKey) + encrypted columns (userId/pageCode); generate a
   per-business **webhook path token** + secret; set Grow `notifyUrl` to
   `/payment-webhook/grow/{token}`.
6. Write a **`payment.connected` audit row** (L1 grounding — the PA can never misstate whether
   payments are live; mirrors `oauth.ts:337` `calendar.connected`).
7. PA confirms in chat: *"Payments are connected — I can now send pay-links and invoices
   automatically."*

### 4.2 The web page is NOT a familiar "sign-in"

It collects **machine API credentials**, not the owner's Grow dashboard login. We never take
his Grow password and there is no OAuth. Onboarding copy must make this explicit and guide him
to the API section.

### 4.3 Upstream hurdle — handle, don't assume away

Grow must **provision API credentials and enable webhooks** for the account first; they may
not pre-exist. Therefore:
- **Guided capture, not a bare form** — PA detects "I don't have these / where are they?" and
  walks the owner through it (links to the exact Grow page; a "contact Grow to enable API +
  webhooks" nudge with copy he can forward).
- **Graceful pending state** — if he can't finish now, payments stay `not_connected`, the PA
  reminds him later, and **all non-payment functionality keeps working**. No dead end.
- This hurdle is exactly what the **partnership** (§11) removes (we'd provision sub-accounts +
  webhooks programmatically; the owner never sees an apiKey).

---

## 5. Architecture — components (match existing patterns)

All Developer A. No `src/skills` boundary crossing.

1. **`src/adapters/grow/client.ts`** — the only code that talks to Grow. Typed results
   (`Created{paymentUrl, processId} | Error{reason}`), `multipart/form-data` encoding,
   sandbox/prod host switch, transient-retry (reuse the `exchangeCodeForTokens` retry idiom
   in `oauth.ts`). Mirrors `adapters/calendar/client.ts`. **No business logic; never throws
   into the engine.** Methods: `createPaymentProcess`, `approveTransaction`, `getPaymentInfo`,
   `refundTransaction`.
2. **`src/domain/payments/service.ts`** — deterministic core: `createCharge()`,
   `reconcilePayment()`, amount/policy validation, idempotency. The only thing the
   orchestrator tool and workers call. Calls the adapter; writes the `payment_requests` ledger.
3. **`src/domain/payments/credentials.ts`** — load/decrypt per-business creds, status checks
   (`isPaymentsConnected(businessId)`), live validation on connect.
4. **`src/routes/payment-webhook.ts`** — Grow's `notifyUrl` target
   (`/payment-webhook/grow/{token}`). Verify (§8) → `approveTransaction` → `reconcilePayment`
   → flip booking → attach/forward invoice → cancel dunning → owner-notify per rules. Mirrors
   `calendar-webhook.ts`. Idempotent on `transactionCode`.
5. **`src/routes/payment-connect/`** — the signed web form (GET form + POST handler), sibling
   to the CSV `import.ts` page.
6. **Branch-3 tool `requestPayment`** in `src/domain/manager/orchestrator-tools.ts` — Case B.
7. **Wire existing workers:** `dunning.ts` emits a real Grow link; add a `payment.received`
   owner initiator (the spine's `🔴 needs processor webhook` row).

---

## 6. Data model (new)

```sql
-- Encrypted per-business processor credentials (apiKey stored via Secret Manager ref).
CREATE TABLE business_payment_credentials (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id),
  provider      text NOT NULL DEFAULT 'grow',
  user_id       text NOT NULL,                 -- Grow userId (encrypted/at-rest)
  page_code     text NOT NULL,                 -- Grow pageCode
  api_key_ref   text NOT NULL,                 -- Secret Manager resource name (never the raw key)
  environment   text NOT NULL DEFAULT 'production' CHECK (environment IN ('sandbox','production')),
  webhook_token text NOT NULL,                 -- unguessable path segment for notifyUrl
  webhook_secret text NOT NULL,                -- our own verification secret
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','connected','invalid','revoked')),
  connected_at  timestamptz,
  last_validated_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, provider)
);

-- One-time signed link for the credential-capture web form (clone of import_tokens).
CREATE TABLE payment_connect_tokens (
  token         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id),
  manager_phone text NOT NULL,
  expires_at    timestamptz NOT NULL,          -- 30 min
  used_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Ledger of every charge we created (idempotency, reconciliation, audit).
CREATE TABLE payment_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id),
  booking_id      uuid REFERENCES bookings(id),       -- null for ad-hoc (Case B w/o booking)
  customer_id     uuid REFERENCES identities(id),
  amount          numeric(10,2) NOT NULL,
  currency        text NOT NULL DEFAULT 'ILS',
  description     text NOT NULL,
  source          text NOT NULL CHECK (source IN ('booking','owner_command','dunning','subscription')),
  grow_process_id text,
  payment_url     text,
  status          text NOT NULL DEFAULT 'created' CHECK (status IN ('created','paid','failed','expired','refunded')),
  transaction_code text,                              -- from webhook; idempotency key
  invoice_number  text,
  invoice_url     text,
  dedup_key       text NOT NULL,                      -- cross-initiator dedup (incl. time bucket)
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payment_requests_txn_idx ON payment_requests(transaction_code) WHERE transaction_code IS NOT NULL;
CREATE INDEX payment_requests_booking_idx ON payment_requests(booking_id);
```

```sql
-- Owner-configurable pay-link send timing (§3.1). NULL/'at_booking' = send at booking time
-- (today's behavior); otherwise send_offset_minutes is the offset vs slot_start
-- (negative = before, positive = after) consumed by the payment-request worker.
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS payment_link_send_policy text NOT NULL DEFAULT 'at_booking'
  CHECK (payment_link_send_policy IN ('at_booking','offset'));
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS payment_link_offset_minutes integer;  -- e.g. -1440 = 24h before
```

Migrations hand-authored `IF NOT EXISTS`, applied by `npm run db:apply`
(`scripts/apply-all-migrations.ts`) per `src/db/migrations/README.md`.

---

## 7. Automation loop & state transitions

- **Create:** the `payment.request` initiator fires at the owner-configured time (§3.1) —
  `PaymentService.createCharge` → `grow.createPaymentProcess` → store `payment_requests`
  (`created`) → send link into Branch 4 through the eligibility gate as a **transactional**
  initiator (always allowed, never opt-out-blocked). Default policy `at_booking` reproduces
  today's send-on-booking behavior.
- **Pay (webhook):** verify → `grow.approveTransaction(transactionCode)` → `reconcilePayment`:
  - `payment_requests.status → paid`, attach `invoice_number`/`invoice_url`.
  - If `booking_id`: drive the **existing** `pending_payment → confirmed/paid` edge
    (`engine.ts:800`) with `metadata.triggeredBy = 'grow_webhook'` (replacing
    `manager_paid_command`); confirm calendar hold; schedule reminders; record completed.
  - **Cancel pending `payment.dunning_*`** for that booking (dedup ledger / initiation_log).
  - **Forward the invoice PDF** (`invoice_url`) to the customer.
  - **Notify owner** only per his notification rules (voluntary OAU; ratchet-eligible).
- **Unpaid:** existing dunning worker now includes the **live pay-link** in each rung; give up
  after the final window (existing 96h logic).
- **Failure is explicit (Principle 6):** webhook verify fail / reconcile fail → log + audit +
  alert; **never** mark a booking paid on an unverified signal.

---

## 8. Security

- **Webhook auth (no Grow signature exists):** defense in depth — (a) unguessable
  `webhook_token` in the URL path, (b) **re-verify every webhook server-side** via
  `grow.getPaymentInfo(processId/transactionCode)` before trusting it, (c) idempotency on
  `transactionCode` (unique index). Only after re-verification do we `approveTransaction` +
  reconcile.
- **Secrets:** `apiKey` lives in **Secret Manager** (store only the resource ref in the DB);
  never logged, never in any chat transcript, never in audit `metadata`. Redaction guard in
  the logger for `apiKey`/`api_key`.
- **`approveTransaction` is mandatory** — unacked transactions stay unsettled at Grow.
- **Authorization:** `requestPayment` (Case B) gated like other money/customer actions —
  managers always; delegated users only if granted; customers/contacts never.

---

## 9. Phased build order

1. **Adapter + credentials + onboarding (no sends yet).** `adapters/grow/client.ts`,
   `payments/credentials.ts`, `business_payment_credentials` + `payment_connect_tokens`
   tables, the signed web form, the `payment` onboarding step + on-demand connect, live
   validation, `payment.connected` audit. **Exit:** an owner can connect Grow end-to-end;
   `isPaymentsConnected` true; nothing sends yet.
2. **Charge + webhook + scheduled send (the core loop).** `payments/service.ts`,
   `payment_requests` table, `payment-webhook.ts` (verify → approveTransaction → reconcile),
   the `payment.request` initiator + `workers/payment-request.ts` (§3.1) with default
   `at_booking` policy, invoice forwarding. **Exit:** a `post_payment` booking gets a real
   link at the right time; paying it auto-confirms the booking + forwards the invoice, no
   owner action.
3. **Owner-configurable timing + dunning + owner notification.** Branch-3 editing of
   `payment_link_send_policy`/`offset` (§3.1); `dunning.ts` emits the live link; cancel-on-pay;
   add `payment.received` owner initiator under notification rules. **Exit:** owner can say
   "send pay-links 24h before the session"; unpaid bookings get escalating links; owner sees
   payments per his rules only.
4. **Case B owner-called.** `requestPayment` orchestrator tool (Branch 3 → Branch 4),
   authorization-gated. **Exit:** owner can say "charge Dana ₪300" and it flows to the customer.
5. **Refund (owner-commanded) + polish.** `refundTransaction` via a guarded Branch-3 tool;
   STATUS surfaces payment-connection health.
6. **(Deferred)** subscription auto-charge, tokenization, partner provisioning (§11).

---

## 10. Verification (when code runs)

- **Adapter:** multipart encoding, sandbox/prod switch, transient-retry, typed errors; mock
  Grow host.
- **Onboarding:** token single-use + expiry; live-validation reject path; secret never in DB
  rows/logs (assert apiKey absent from `payment_requests`, `audit_log`, `conversation_messages`).
- **Webhook truth table:** valid paid → booking confirmed + invoice sent + dunning cancelled;
  duplicate `transactionCode` → no-op; unverifiable signal → rejected, booking untouched;
  reconcile failure → explicit failure + alert.
- **Replaces manual edge:** `pending_payment → confirmed` now fires from
  `triggeredBy: 'grow_webhook'`; the manual `manager_paid_command` path still works as fallback.
- **Case B:** `requestPayment` authorization matrix (manager ✓, delegated conditional,
  customer ✗); LLM never receives raw creds.
- **Scheduled timing (§3.1):** worker fires `payment.request` exactly once at
  `slot_start − offset` (and `at_booking` default reproduces send-on-booking); no double-send
  when dunning also runs (dedupKey).
- **No-owner-on-critical-path:** an integration test booking → link (at the owner's chosen
  time) → simulated webhook → confirmed+invoiced **with zero owner messages** (requirement #1).
- **Existing tests unchanged:** dunning tier math, booking engine, initiations gate.

---

## 11. Open questions (Grow support) + partnership track

**Blocking-ish:**
1. **Partner/aggregator (master-merchant) program?** Decides whether onboarding can become a
   one-tap provision (no owner-visible apiKey, programmatic webhook enablement). Even if it
   exists, v1 ships self-serve; partnership is a pure upgrade swapping only §4.1.

**Non-blocking (build defensively regardless):**
2. **Webhook signature** — confirmed absent in docs; we re-verify server-side. Confirm there's
   no HMAC we're missing.
3. **Invoice control** — is VAT-invoice auto-generated on every charge, or a per-request flag?
   (Affects owners who invoice elsewhere, e.g. green-invoice — let them opt out.)
4. **`approveTransaction` semantics** — exact required fields + timing window.
5. **Recurring/tokenization depth** — to scope subscription auto-charge later (deferred v1).

**Parallel BD track:** open a partnership conversation with Grow (master-merchant +
revenue-share + programmatic sub-account/webhook provisioning). If it lands, it removes the
§4.3 upstream hurdle entirely. Draft outreach when prioritized.
