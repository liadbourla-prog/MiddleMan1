# Meeting Coordination — Production Fixes, Settled Design (Round 1)

**Date:** 2026-06-22
**Status:** Design approved; ready for implementation plan.
**Owner:** Developer A (`src/domain`, `src/adapters`, `src/db`, `src/routes` — not `src/skills`).
**Reads with:**
- Problem statement & fix direction: [`2026-06-22-meeting-coordination-fixes.md`](2026-06-22-meeting-coordination-fixes.md)
- Original feature design: [`2026-06-21-meeting-coordination-design.md`](2026-06-21-meeting-coordination-design.md)

This document resolves the five open design decisions in §5 of the fixes spec and pins
the resulting design, including the Branch-4 (customer booking) safety invariants the
fixes must not violate.

---

## 1. Decisions settled

| # | Decision | Choice |
|---|---|---|
| 1 | Boundary representation | **New nullable `allowed_windows` jsonb column**, separate from `candidate_slots`. |
| 2 | `coordinateMeeting` args shape | **Additive optional `windows` arg**; keep the existing primary + `fallbacks` discrete path. |
| 3 | Active-coordination routing lookup | **Hoist `findActiveByContact` before the role branch**, gated to non-owner senders; reuse the existing fn + index. |
| 4 | Self-identification preference persistence | **Business-level setting column** (`businesses.outreachIdentityMode`); owner name persists to `identities.displayName`. |
| 5 | Forbid LLM freelancing via `messageCustomer` | **Prompt-only hardening**, relying on Fix A to remove the freelance pressure. No hard code block. |

---

## 2. Bug 1 — never invent a name; ask + persist self-identification

### 2.1 Storage

- **Outreach identity mode** — new nullable enum column on `businesses`:
  `outreachIdentityMode text enum('business','owner_name')`, `null` = not yet chosen.
  One owner per business, so a business-level policy is unambiguous and survives every
  session and every coordination. Matches the existing `businesses` enum-column pattern.
- **Owner name** — persists to the manager's `identities.displayName`, replacing the
  literal `"Owner"` placeholder. `displayName` that is `null` or exactly `"Owner"` is
  treated as "no real name on file."

### 2.2 Flow

The deterministic coordination outreach (`coordination_offer_to_contact`) carries the
self-identification — never the LLM free-composing it. The orchestrator's job is only to
*gather* the preference conversationally before the first outreach:

1. **Hard prompt rule:** never invent or guess a person's name (owner's or anyone's).
2. **Ask once, when unset:** before reaching out on the owner's behalf, if
   `outreachIdentityMode` is `null`, ask the single question:
   *"When I reach out to people for you, should I say I'm **from {business name}**, or
   **{owner name}'s assistant**?"* (one question per message, Voice Bible tone).
3. **Owner-name chosen but name unknown:** if the owner picks owner-name and
   `displayName` is `null`/`"Owner"`, ask for the name.
4. **Business-name chosen:** use the business name (always available).
5. **Persist**, then never re-ask: the chosen mode is written to `businesses`; the name (if
   given) to `identities.displayName`.

### 2.3 Wiring

- **`coordinateMeeting` args gain** `identifyAs?: 'business' | 'owner_name'` and
  `ownerName?: string`. When present, the handler persists them (mode → `businesses`,
  `ownerName` → manager `displayName`) before kicking off, then resolves the effective
  introducer string and passes it to the outreach.
- **Context injection:** the orchestrator system prompt gains an "Outreach identity" line
  (alongside the active-coordinations block) stating the current state — `from {business}`,
  `{owner}'s assistant`, or *"not set — ask before first outreach; owner's name on file:
  {name|placeholder}"* — so the model knows whether to ask and never re-asks once set.
- **i18n:** generalize `coordination_offer_to_contact` (and the re-send / new-candidate
  variants) to take an *introducer* string instead of the bare business name, so it renders
  either "from {business}" or "{owner name}'s assistant" in he/en. No emojis (lawbook).

---

## 3. Bug 2 — allow customer counterparties; enforce window boundaries; intercept routing

### 3.1 Fix A — coordinate with a customer (linchpin)

- **Remove the `phone_not_a_contact` refusal** in `coordination-tools.ts`. The counterparty
  may be any non-owner identity:
  - a brand-new external person → registered as `role='contact'` (unchanged);
  - an **existing customer → keeps `role='customer'`** and becomes the coordination's
    counterparty (`meeting_coordinations.contactId` = their identity id). No role mutation,
    no CRM pollution.
  - guard unchanged: never let the **owner** (manager/delegated) be the counterparty, and
    keep "one active coordination per counterparty" (`already_active`).

### 3.2 Fix A — routing-first interception (also fixes root cause C)

In `processInboundMessage` (`webhook.ts`), **before** the role branch (~line 209) and
**after** dedup → identity resolve → opt-out (order unchanged):

```
if (role !== 'manager' && role !== 'delegated_user') {
  const active = await findActiveByContact(db, business.id, identity.id)
  if (active) { await advanceFromContact(db, calendar, active, msg.body, ctx); return }
}
// else / no active coordination → existing role branch (Branch 3 / Branch 4)
```

- Reuse the existing `findActiveByContact` (already keyed by `(businessId, identityId)`,
  covered by `meeting_coordinations_contact_idx`). No new repository fn; the `contactId`
  column already means "the counterparty identity id." Build the `BusinessCtx` + calendar
  client the same way `routeContactMessage` does (factor a small shared helper to avoid
  duplication).
- Gated to non-owner senders so the manager/delegated hot path is untouched.
- `routeContactMessage` (for `role='contact'` with no hoisted match — e.g. a stray contact
  message) keeps its existing relay-to-owner fallback.

### 3.3 Fix B — boundaries as windows

- **New column** `meeting_coordinations.allowedWindows jsonb` (nullable) —
  `[{ start: ISO, end: ISO }]` absolute UTC, where each window is the **range of acceptable
  start..end** for that day (a proposal fits if `proposal.start >= w.start &&
  proposal.end <= w.end`). `candidate_slots` is retained for the discrete primary+fallbacks
  path and stays `[]`/minimal when windows are used.
- **`coordinateMeeting` gains** an optional `windows` arg:
  `[{ date: DATE_PIECES, startTime: TIME, endTime: TIME }]`. The LLM classifies the owner's
  ranges into pieces; the handler resolves each window's start and end through the existing
  `resolveSlotRange` deterministic resolver (LLM never computes absolute dates). The owner
  uses **either** discrete primary+fallbacks **or** windows; the prompt steers the choice
  (ranges → `windows`; specific times → primary/fallbacks).
- **`classifyContactReply` becomes boundary-aware** — signature takes
  `{ candidates, windows }`:
  - if `windows` non-empty → in-window (proposal fits a window) → **accept-equivalent**;
    out-of-window → **deviation**;
  - else → existing discrete candidate matching (5-min match → accept; else counter).
- **Out-of-window deviation framing.** Add a side effect
  `relay_out_of_window_to_owner { slot, window }` and i18n
  `coordination_deviation_to_owner(contact, proposedTime, windowDesc)`:
  *"Eyal wants Wed 10:00, but you set Wed 11–15 — accept the deviation, or should I ask for
  11:00?"* Like `countered`, the owner's explicit confirm there **is** the final yes that
  books it. In-window proposals still funnel to the single `awaiting_owner_confirm` ping.
  Never silently book an out-of-window time.
- **Availability guard:** the discrete path keeps its per-candidate `checkAvailability`
  pre-filter (`no_free_candidates`). The windows path skips the pre-filter (offers the
  owner-given ranges) and relies on the existing `book_and_notify` availability re-check as
  the backstop (consistent with the design's "re-check at accept/confirm, no holds").
- **Offer/relay wording:** add a `describeWindows` helper for the contact-facing offer
  ("we're free Tue 10–16 or Wed 11–15 — what works?") parallel to `describeCandidates`.

### 3.4 Fix C — falls out of 3.2

A customer-counterparty's reply is intercepted by the hoisted lookup and driven by
`advanceFromContact`, so it never reaches `routeCustomerMessage` / the booking flow. No more
"book your yoga class?" hijack.

### 3.5 Single booking path & freelance hardening (decision 5)

- Fix A removes the refusal that pushed the model into `messageCustomer` +
  `createCalendarEvent`. No hard code block is added (it would break the legitimate
  already-agreed-time path that *correctly* uses `createCalendarEvent`).
- **Prompt hardening** (defense in depth): meeting coordination ALWAYS routes through
  `coordinateMeeting`; `messageCustomer` is for one-off pings only, never for negotiating a
  meeting; never use `createCalendarEvent` to book a meeting you coordinated — confirm the
  coordination instead. Grounding (CHAT_LEVEL_LAWBOOK §7.4) unchanged: no "booked"/"sent"
  claims without a successful tool result.

---

## 4. Branch-4 (customer booking) safety invariants — must hold

These are non-negotiable; the fixes must not disturb normal customer sessions.

1. **Zero change for normal customers.** The hoisted lookup runs after dedup → identity →
   opt-out (unchanged), is gated to non-owner senders, and uses the existing index. For a
   customer with no active coordination it returns null and falls through to
   `routeCustomerMessage` exactly as today — a single indexed read returning zero rows.
2. **No role/CRM mutation.** An existing customer-counterparty stays `role='customer'`. Only
   the routing of their inbound changes while a coordination is active.
3. **Booking session untouched by coordination.** `advanceFromContact` never
   creates/loads/completes `conversation_sessions`, never writes the booking transcript, and
   never mutates booking context. Booking state is preserved during a coordination.
4. **Automatic clean revert.** Once status leaves ACTIVE
   (`confirmed`/`declined`/`expired`/`abandoned`), the lookup returns null and the customer
   routes through Branch 4 normally. An interrupted booking thread is restored by the
   existing session carryover/hydration (draft + recent turns) on their next message.
5. **No duplicate fire.** Because coordinated inbound is intercepted before
   `routeCustomerMessage`, the `findPendingOutreachForCustomer` notify path and the
   booking-flow auto-reply do not run for an active counterparty.

**Accepted edge case (documented, not blocked):** if the owner starts a coordination with a
customer who is actively mid-booking, the coordination temporarily owns that person's inbound;
the booking thread resumes via normal carryover once the coordination ends. Rare; no hard
data loss.

---

## 5. Data model & migration

New (idempotent, hand-applied `IF NOT EXISTS` per the deploy runbook; extend
`scripts/apply-coordination-migration.ts` to apply + verify):

- `businesses.outreach_identity_mode text` — `CHECK (... IN ('business','owner_name'))`,
  nullable.
- `meeting_coordinations.allowed_windows jsonb` — nullable.

Drizzle `schema.ts` updated to match. No `ALTER TYPE` needed (`identities.role` is a
Drizzle-level enum on a plain text column; `'contact'` already shipped in 0024).

---

## 6. Acceptance criteria (from fixes spec §4, sharpened)

1. **No invented names.** With no real owner name on file, the PA never emits a fabricated
   personal name; it asks the identification-preference question, and on "owner name" asks
   for and persists the real name (replacing `"Owner"`).
2. **Customer-as-counterparty end-to-end.** "Coordinate a meeting with {existing customer}"
   → coordination created (not refused); the customer's replies advance the coordination
   (not the booking flow); the customer receives no booking auto-reply while it is active;
   their `role` stays `customer`.
3. **Boundary enforcement.** Windows "Tue 10–16 / Wed 11–15": a Wed 10:00 proposal is
   surfaced as an explicit out-of-window deviation, bookable only after an explicit owner
   confirm; an in-window proposal still takes the single owner confirm.
4. **Single booking path.** A coordinated meeting books through the coordination handler
   (`paType='meeting'` + meeting render kind), not ad-hoc `createCalendarEvent`. Grounding
   holds.
5. **Branch-4 untouched.** A normal customer with no coordination is routed and sessioned
   exactly as before (explicit test). All existing tests pass; new tests cover
   customer-counterparty routing, window in/out classification + deviation, the name-/
   identification-preference branch, and Branch-4 non-interference.

---

## 7. Out of scope / don't break

CRM isolation, grounding (lawbook §7.4), owner-only authorization (`meeting.coordinate`),
the existing test suite, and — per §4 — all normal Branch-4 customer session behavior. The
already-booked Wed-10:00 incident event is test data; cleanup is the owner's call.
