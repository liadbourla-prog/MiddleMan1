# Meeting Coordination — Design

**Date:** 2026-06-21
**Branch:** 3 (PA Manager Channel)
**Owner:** Developer A (`src/domain`, `src/adapters`, `src/db`, `src/routes` — not `src/skills`)
**Status:** Approved design; ready for implementation plan.

---

## 1. Problem

When the owner asks the PA (Branch 3) to "set a meeting with someone," the PA today has two
disconnected capabilities and neither coordinates a meeting:

- `createCalendarEvent` ([orchestrator.ts:147](../../../src/adapters/llm/orchestrator.ts)) — drops an
  event straight on the calendar. It assumes the time is already agreed and contacts no one.
- `messageCustomer` ([orchestrator-tools.ts:1483](../../../src/domain/manager/orchestrator-tools.ts)) —
  sends **one** WhatsApp to a person, and the reply-notify worker
  ([outreach-reply-notify.ts](../../../src/workers/outreach-reply-notify.ts)) relays the **first** reply
  back to the owner, **once per outreach**.

So the desired flow — verify whether the owner already arranged it or the PA should reach out,
contact the person, negotiate timing back and forth until a match, with fallback ("Plan B") times
captured upfront — does not exist. The only true propose↔counter↔resolve machinery in the codebase
(`reshuffleOffers`, [schema.ts:588](../../../src/db/schema.ts)) is hard-scoped to reshuffling existing
customer **bookings** and cannot be used for a new external meeting.

A side effect of `messageCustomer` today: a meeting counterparty (accountant, supplier, landlord) is
registered as a `customer` ([orchestrator-tools.ts:1515](../../../src/domain/manager/orchestrator-tools.ts)),
polluting the CRM.

## 2. Goal

Give Branch 3 a dedicated **meeting-coordination** capability:

1. **Verify first.** When the owner says "set a meeting with X," the PA asks whether a time is already
   agreed (→ existing `createCalendarEvent`) or it should coordinate.
2. **Capture fallbacks upfront.** When coordinating, the PA asks for a primary time **and one or two
   fallbacks**.
3. **Negotiate autonomously, confirm once.** The PA messages the counterparty, interprets their
   replies, and drives the back-and-forth on its own — but **never writes the meeting to the calendar
   without one final owner "yes."** In-candidate picks are handled without mid-negotiation owner pings;
   counter-proposals outside the candidates bounce to the owner.
4. **Keep counterparties out of the CRM** via a dedicated `contact` identity type.

### Non-goals (v1)

- Auto-nudging a silent counterparty (expiry + owner notification only).
- Multi-party meetings (1 owner ↔ 1 counterparty only).
- Recurring meetings.
- Calendar tentative-holds during negotiation (availability is re-checked at accept/confirm instead).

## 3. Approach

**Dedicated coordination module + explicit state table** (chosen over generalizing the reshuffle
engine, which is booking-scoped, and over extending the audit-log relay, which cannot carry multi-turn
negotiation state). The module borrows the *lifecycle shape* of `reshuffleOffers` but lives in its own
bounded domain so it never tangles with customer booking or reshuffle logic.

## 4. Data model

### 4.1 New identity role: `contact`

Extend `identities.role` enum (`['manager','delegated_user','customer','provider']`) with `'contact'`.

- A `contact` has `displayName` + `phoneNumber`; created explicitly by `coordinateMeeting` (never by
  the auto-register-unknown step at [webhook.ts:187](../../../src/routes/webhook.ts), which still
  defaults to `customer`).
- Contacts are excluded from customer lookups, reminders, reshuffle, waitlist, and CRM views. These
  paths already filter on `role = 'customer'`; contacts simply never match. The implementation plan
  must audit each `role`-sensitive query and confirm no path treats "not manager" as "customer."

### 4.2 New table: `meeting_coordinations`

One row per coordination.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `businessId` | uuid fk | |
| `ownerId` | uuid fk → identities | requester (manager / delegated_user) |
| `contactId` | uuid fk → identities | counterparty (role `contact`) |
| `title` | text | e.g. "Meeting with the accountant" |
| `durationMinutes` | int | derives end-time from any proposed start |
| `candidateSlots` | jsonb | `[{ start: ISO, end: ISO }]` — primary + fallbacks, owner-local resolved to absolute UTC |
| `status` | text enum | see §5 |
| `agreedSlotStart` / `agreedSlotEnd` | timestamptz null | slot pending the owner's final yes, or booked |
| `counterSlotStart` / `counterSlotEnd` | timestamptz null | counterparty-proposed time outside candidates, surfaced to owner |
| `calendarEventId` | text null | set on final booking |
| `googleEtag` | text null | mirror linkage (consistency with bookings) |
| `expiresAt` | timestamptz | no-reply expiry (default now + 72h) |
| `createdAt` / `updatedAt` | timestamptz | |

`status` enum: `awaiting_counterparty` | `countered` | `awaiting_owner_confirm` | `confirmed` |
`declined` | `expired` | `abandoned`.

Index: `(businessId, contactId, status)` for "find the active coordination for this contact" (one
active coordination per contact at a time).

## 5. State machine

```
            owner kicks off (coordinateMeeting)
                        │
                        ▼
              awaiting_counterparty ── contact picks a candidate & owner free ──► awaiting_owner_confirm
                  │      │                                                                 │
   contact counters│      │contact declines                                   owner says yes│
   (outside cands) │      ▼                                                                 ▼
                  ▼   declined ◄── owner abandons ──┐                                    confirmed
              countered ──────────────────────────┤                         (event booked + contact told)
                  │  owner: "offer Friday instead"  │
                  └──► (new candidate) ─► awaiting_counterparty
                  │  owner: "take it"  ─────────────► confirmed (owner's "take it" is the final yes)
  no reply in window ─► expired (owner told)
```

**Invariant:** exactly **one** owner "yes" gates every calendar write.
- In-candidate picks funnel to a single `awaiting_owner_confirm` ping — no mid-negotiation pestering.
- Out-of-candidate counters bounce to the owner immediately; the owner's "take it" there *is* the
  final yes (no second confirm).
- The PA's message to the contact on an in-candidate pick is **soft** ("let me confirm and lock it
  in"), never "booked," until the owner confirms — honoring grounding (CHAT_LEVEL_LAWBOOK §7.4).

## 6. End-to-end flow

### 6.1 Kickoff (owner, Branch 3)

1. Owner: "Set a meeting with my accountant Harel."
2. **Verify gate** (prompt logic): PA asks "Have you already agreed a time with Harel, or should I
   reach out and coordinate?"
   - *Already agreed* → existing `createCalendarEvent`. Coordination not used.
   - *Coordinate* → PA asks for a primary time **plus one or two fallbacks**, and Harel's number if
     unknown. Then calls `coordinateMeeting`.
3. `coordinateMeeting` registers Harel as a `contact`, inserts the `meeting_coordinations` row
   (`awaiting_counterparty`), and sends Harel the candidate times.

### 6.2 Negotiation (contact inbound, intercepted)

Harel replies in free text → coordination handler interprets (§7):
- *Picks a candidate* → re-check owner's calendar free → `awaiting_owner_confirm`; soft reply to Harel;
  ping owner: "Harel's good for Thursday 15:00 — want me to book it?"
- *Proposes a new time* → `countered`; relay to owner: "Harel can't do those — he suggests Friday
  10:00. Take it, or offer something else?"
- *Declines* → `declined`; tell owner.

### 6.3 Final confirm (owner)

- Owner says yes (from `awaiting_owner_confirm`) or "take it" (from `countered`) → book the calendar
  event, tell Harel "You're set for Thursday 15:00," status `confirmed`.
- Owner offers a different time instead → new candidate → `awaiting_counterparty` (PA messages Harel).
- Owner abandons → `abandoned`; optional courtesy note to Harel only if the owner asks.

## 7. Components & interfaces

### 7.1 Inbound routing (`src/routes/webhook.ts`)

Add a branch before the customer fallthrough at [webhook.ts:207](../../../src/routes/webhook.ts):

```
if (role === 'manager' || role === 'delegated_user') routeManagerMessage(...)
else if (role === 'contact')                         routeContactMessage(...)   // NEW
else                                                  routeCustomerMessage(...)
```

`routeContactMessage` loads the active coordination for this contact:
- **Found** → hand reply text to the coordination handler (§7.3).
- **None** → graceful relay to the owner ("Harel messaged: '…'") via the existing outreach-reply notify
  path. A stray contact message is never dropped and never mis-routed into the booking flow.

### 7.2 Orchestrator tools (Branch 3)

- **`coordinateMeeting`** — params: `contactName`, `phoneNumber?`, `title`, primary `date` +
  `startTime`, `fallbacks[]` (each date + time pieces), `durationMinutes` or `endTime`. Reuses
  `DATE_PIECES_SCHEMA`; the LLM never computes absolute dates — a deterministic resolver does. Handler
  registers the contact, resolves candidate slots to absolute UTC, inserts the row, sends the first
  outreach. Returns the real outcome (e.g. contact unreachable) — never a faked "sent." First line of
  the handler: `authorize(ctx, 'meeting.coordinate')` (see §9).
- **`resolveMeetingCoordination`** — params: `coordinationId`, `action: 'confirm' | 'counter_offer' |
  'abandon'`, `counterTime?` (date pieces). Driven when the owner replies to a PA ping. Active
  coordinations are injected into the Branch 3 context (like the grounding block) so the orchestrator
  knows which one the owner means.

Prompt additions: the verify gate (§6.1) and the fallback-capture instruction live in the Branch 3
system prompt, citing CHAT_LEVEL_LAWBOOK (one question per message, Voice Bible tone).

### 7.3 Coordination handler (`src/domain/coordination/`)

A bounded module:
- `interpretContactReply(replyText, lang)` → small dedicated LLM call → `{ accept: candidateIndex }` |
  `{ counter: datePieces }` | `{ decline }` | `{ unclear }`. Date pieces resolve deterministically.
- `classifyContactReply(resolvedSlot, candidateSlots)` → **pure** → `in_candidate(index)` |
  `out_of_candidate` — deterministic accept/counter decision, not the LLM's.
- `nextCoordinationState(status, event)` → **pure** → `{ next status, side-effect intent }`.
- `advanceCoordination(...)` — the impure orchestration: loads the row, calls the pure helpers, applies
  the transition, performs the side effect (message contact / ping owner / book), writes audit rows.

### 7.4 Calendar (`src/adapters/calendar`, `src/domain/calendar/event-content.ts`)

- Extend the `event-content.ts` renderer with a `meeting` kind: title `{title} — {contactName}`,
  description `With: {contactName}` / `Phone: {phone}` (Hebrew + English, no emojis — consistent with
  the booking cards shipped in v1.0.73).
- On final confirm, book via the calendar client; stamp `extendedProperties.private` `paType='meeting'`.
- Re-check `checkAvailability` before proposing or accepting any slot, so a meeting never silently
  double-books.

## 8. Error handling, grounding & lawbook

- **Grounding (CHAT_LEVEL_LAWBOOK §7.4):** every transition writes an `audit_log` row
  (`coordination.started`, `.contact_replied`, `.owner_confirmed`, `.booked`, `.contact_notified`,
  `.expired`, `.abandoned`). The PA claims "booked" / "told Harel" only when the tool returned ok —
  same contract as `messageCustomer`.
- **Authorization (CHAT_LEVEL_LAWBOOK §6.1):** the owner's initial "yes, coordinate using these times"
  authorizes the whole outreach loop, so the PA messaging the contact mid-negotiation is pre-authorized.
  The calendar write still requires the final owner yes.
- **Expiry:** no contact reply within the window (config, default 72h) → `expired`, owner told. No
  auto-nudge in v1.
- **Edge cases:**
  - Contact opted out / unreachable (WhatsApp 24h re-engagement window) → honest "couldn't reach Harel"
    to the owner; coordination stays `awaiting_counterparty` so a later contact message still advances it.
  - Owner's calendar became busy before final confirm → flag it to the owner instead of booking.
  - Concurrent coordinations with the same contact → one active at a time (the `(businessId, contactId,
    status)` guard); a new `coordinateMeeting` while one is active asks the owner to resolve the first.
  - `unclear` contact reply → PA asks the contact a single clarifying question; does not guess.

## 9. Authorization & abuse prevention

**Coordination is owner-only. A customer can never make the PA negotiate on their behalf.** This is
enforced in three independent layers (defense in depth — no single point of failure):

1. **Structural (routing).** The `coordinateMeeting` and `resolveMeetingCoordination` tools exist only
   in the Branch 3 orchestrator, which runs **only** for `manager` / `delegated_user`
   ([webhook.ts:207](../../../src/routes/webhook.ts) → `routeManagerMessage`). Customers (Branch 4) and
   contacts use entirely different inbound handlers with **no orchestrator tools** — they cannot emit a
   `coordinateMeeting` call at all. Identity (and therefore role) is resolved from the sender's phone
   number, not from anything in the message, so a customer cannot assert another role by asking.

2. **Deterministic (handler gate).** Per the core principle (every state change passes the
   authorization check), both tool handlers call `authorize(ctx, 'meeting.coordinate')` before doing
   anything — even though step 1 already makes them unreachable from Branch 4. Add a new Action
   `'meeting.coordinate'` to the `Action` union ([authorization/check.ts:3](../../../src/domain/authorization/check.ts)):
   - **Manager** — always allowed (in the manager capability set).
   - **delegated_user** — allowed **only if** the owner granted `meeting.coordinate` (stored in
     `delegated_permissions`, same mechanism as other delegated actions). Not granted by default.
   - **customer / provider / contact** — denied. A handler reached with such an actor returns a refusal
     and writes no state.

3. **Contact side is inert.** `routeContactMessage` can **only advance an existing coordination that
   the owner already started** for that exact contact (matched by `contactId`). It exposes no tools and
   cannot create a coordination, message anyone other than as a scripted step of the active
   coordination, or trigger any owner-level action. A contact with no active coordination is merely
   relayed to the owner (§7.1). So a counterparty cannot escalate, and a customer who is never made a
   `contact` by the owner has no contact-side surface at all.

**Net guarantee:** a coordination can be created or advanced toward a booking only by the owner (or a
delegated user the owner explicitly trusted with `meeting.coordinate`). The counterparty and any
customer are strictly responders, never initiators.

## 10. Testing

- `classifyContactReply` (in/out/decline boundary) — pure unit tests.
- `nextCoordinationState` — pure unit tests across every status × event edge.
- `meeting` renderer cases added to `event-content.test.ts`.
- Handler integration test: kickoff → contact counter → owner counter-offer → contact accept → owner
  confirm → booked, asserting state transitions, audit rows, and outbound messages at each step.
- Routing test: a `contact` inbound with an active coordination advances it; with none, relays to owner;
  never enters the customer booking flow.
- **Authorization tests:** `authorize(ctx, 'meeting.coordinate')` allows `manager`, denies `customer`
  and `provider`, and allows `delegated_user` only when the grant is present. Handler-level test that a
  non-owner actor reaching either tool returns a refusal and writes no `meeting_coordinations` row.

## 11. Migration & rollout

- Migration: `ALTER TYPE` / enum addition for `contact`; `CREATE TABLE meeting_coordinations`. Idempotent
  (`IF NOT EXISTS`), verified post-deploy per the deploy runbook's migration-verification step.
- No behavior change for existing roles; the feature is inert until the owner uses it.
- CLAUDE.md "four chat branches" note: contacts are a sub-case of Branch 3 outbound coordination, not a
  fifth branch — document under Branch 3.
