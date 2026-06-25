# Per-Service Owner Approval of Customer Bookings (Branch 4 → Branch 3)

**Date:** 2026-06-25
**Branch target:** Developer A (`dev/system/*`)
**Status:** Approved design → ready for implementation planning

## Problem

Owners have different postures toward customer bookings. Some are hands-off ("just fill
my calendar, no double bookings" — today's default). Some are hands-on and want to
**approve each customer self-booking before it lands on the calendar**.

Today the deterministic core has an owner-approval gate (`bookingAuthority='owner_approval'`),
but **by design decision D1 it gates only PA/owner-initiated bookings — customer self-bookings
(Branch 4) are never gated** (`src/domain/manager/orchestrator-tools.ts` `executeCreateCalendarEvent`,
comment at `src/db/schema.ts` `bookingAuthority`). There is no way for an owner to say "hold any
customer booking for my approval."

This feature adds that capability: an **opt-in, per-service** requirement that a Branch-4
customer self-booking is **held** until the owner confirms in Branch 3.

### Non-negotiable: never a default

This mechanism is **off for every business and every service unless the owner explicitly
turns it on for a specific service.** The opt-in flag defaults `false`; the engine gate fires
only when the flag is `true` AND the caller is a customer. Businesses that never ask see zero
behavior change.

## Decisions (locked)

1. **Approach A — reuse the `held` state.** A pending-approval booking lives in the existing
   `held` state (already reserves the slot and is counted by every conflict/availability check)
   plus an `approval_status` marker. No new booking state; no state-machine changes (the needed
   transitions `held → confirmed | pending_payment | cancelled | expired` already exist in
   `VALID_TRANSITIONS`, `src/domain/booking/types.ts`).
2. **Per-service opt-in.** `service_types.requires_owner_approval` (default `false`). Configured
   conversationally in Branch 3 via the existing `applyServiceChange` path.
3. **Hold the slot.** The requested slot is reserved (`held`) while awaiting approval, so no one
   else — another customer or the owner's own direct booking — can take it. No overbooking.
4. **Auto-expire + notify.** If the owner never answers, the held request expires after a
   configurable window (default **24h**), the slot is released, and the customer is told it
   wasn't confirmed in time and invited to rebook. The owner gets a brief "request expired" note.
5. **Window is owner-configurable.** Business-level `businesses.booking_approval_window_hours`
   (default 24), set in Branch 3 like the other policy knobs (`policy_change`).
6. **Approve-first, then pay.** For a service that is both approval-gated and payment-gated
   (`confirmationGate='post_payment'`), the owner approves first; only then does the customer
   receive the pay-link; the booking confirms on payment. No pre-payment, no refunds.
7. **Resolution is conversational (free-text) in v1.** The owner approves/declines with a chat
   message in Branch 3 ("yes, approve Dana's yoga" / "no, decline that"), resolved by a new
   deterministic orchestrator tool. **Interactive WhatsApp buttons are out of scope** — no
   interactive-message infrastructure exists today (no send, no inbound routing); buttons are a
   follow-up that depends on building that subsystem first.
8. **Separate from `bookingAuthority`.** PA/owner-initiated bookings keep their own independent
   opt-in knob, unchanged. The two concerns never merge.

## Architecture

### 1. Data model (migration)

- `service_types.requires_owner_approval` — `boolean NOT NULL DEFAULT false`.
- `bookings.approval_status` — nullable text enum `['pending','approved','declined']`. `null` =
  a normal booking (today's behavior). Non-null only ever set when the service had the flag on at
  request time.
- `businesses.booking_approval_window_hours` — `integer NOT NULL DEFAULT 24`.

All additive and backward-compatible (existing rows: flag `false`, status `null`, window 24).

### 2. The gate (deterministic core, `src/domain/booking/engine.ts`)

At the booking-confirm seam, when **`service.requiresOwnerApproval === true` AND the caller role
is `customer`**:

- Create the booking as `held`, `approval_status='pending'`,
  `holdExpiresAt = now + booking_approval_window_hours`.
- Fire a **mandatory** owner notification in Branch 3 (see §4) — this is NOT governed by
  `notificationRules`; opting into approval IS the consent to be asked.
- Return a customer-facing situation: "request received, pending the business's confirmation."

When the flag is `false` (the default) OR the booking is PA/owner-initiated, the path is
**exactly today's** (`confirmed` / `pending_payment`). This is the never-default guarantee, enforced
in the core.

### 3. Resolution (deterministic `resolveBookingApproval`)

A pure-ish domain function `resolveBookingApproval(db, bookingId, decision, actorId)`:

- **approve** →
  - payment-gated service: `held → pending_payment`, send pay-link (existing path).
  - else: `held → confirmed`, mirror to calendar + notify customer (existing confirm side-effects).
  - set `approval_status='approved'`.
- **decline** → `held → cancelled` (reason `declined_by_owner`), `approval_status='declined'`,
  notify customer + invite to pick another time.
- All writes pass through the booking state machine `transition()` (Principle: deterministic core).

### 4. Owner side (Branch 3)

- **Configuration** rides the existing `applyServiceChange` path: add `requiresApproval` (bool)
  to `serviceChangeSchema` (`src/domain/manager/apply.ts`) and the `service_change` classifier
  prompt (`src/adapters/llm/client.ts`). "require my approval for physio bookings" → on;
  "stop asking me to approve yoga" → off. (Consistent with the just-shipped mode/color work.)
- **Window configuration** rides the existing `policy_change` path: new subtype `approval_window`
  (`valueHours`) in `policyChangeSchema` + `applyPolicyChange` (`apply.ts`) + classifier prompt,
  writing `businesses.booking_approval_window_hours`. Mirrors `cancellation_cutoff` / `booking_buffer`.
- **Approval request notification:** a mandatory Branch-3 message naming the customer, service,
  and time, asking the owner to confirm or decline by replying.
- **Free-text resolution tool:** a new orchestrator tool `resolveBookingApproval`
  (`src/domain/manager/orchestrator-tools.ts`, registered in `src/adapters/llm/orchestrator.ts`).
  The LLM maps the owner's reply to the pending booking (by customer / service / time from session
  context + a lookup of this business's `approval_status='pending'` bookings) and calls the
  deterministic resolver. When several are pending and the reference is ambiguous, the tool returns
  a disambiguation prompt rather than guessing.

### 5. Timeout (`src/workers/hold-expiry.ts`)

The hold-expiry worker already expires `held` bookings past `holdExpiresAt`, deletes the calendar
event, and notifies the customer. Extend it minimally: for an expiring hold with
`approval_status='pending'`, use an approval-flavored customer message ("the business didn't confirm
in time") and send the owner a brief "request expired" note. Normal (short-TTL) customer holds are
unaffected — both are keyed off `holdExpiresAt`.

### 6. Customer side (Branch 4)

Transactional-layer situation strings only (LLM phrases them; no raw engine codes), per the
two-layer Branch-4 model: request-sent, approved/confirmed (reuses existing confirm message),
declined + rebook invite, expired + rebook invite.

## Boundaries

- New per-service flag + new booking marker + new business window column — additive migration.
- Gate in `engine.ts`; resolver in the booking/manager domain; both through the state machine.
- Config reuses `applyServiceChange` (service flag) and `applyPolicyChange` (window).
- Timeout reuses the hold-expiry worker (one branch).
- No new booking state, no state-machine edits.

## Testing

Unit (no DB — prod-only locally, same constraint as the prior mission; CI runs build + lint + unit):
- Engine gate: flag off → unchanged path; flag on + customer → `held`/`pending`; flag on +
  PA-initiated → NOT gated.
- Resolver transitions: approve → confirmed; approve (payment-gated) → pending_payment;
  decline → cancelled. Idempotency / already-resolved guard.
- Timeout branch: approval-pending hold expiry produces the approval-flavored notifications.
- Parse: `applyServiceChange` `requiresApproval`; `applyPolicyChange` `approval_window`.
- Disambiguation: `resolveBookingApproval` with multiple pending → asks which.

Verify with `npm run build` (clean) and `env -u DATABASE_URL npx vitest run` (unit). Do NOT run
`tests/integration/**` locally.

## Out of scope (follow-up specs)

- **Interactive WhatsApp buttons** for approve/decline (needs an interactive-message send +
  inbound-routing subsystem that does not exist yet).
- **Per-service approval window** (v1 window is business-level).
- Gating PA/owner-initiated bookings (already covered by the separate `bookingAuthority` knob).
- Auto-decline-with-alternatives on timeout (v1 just releases + invites rebooking).
