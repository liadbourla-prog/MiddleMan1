# Meeting Coordination — Production Fixes (Round 1)

**Date:** 2026-06-22
**Status:** Approved problem statement + fix direction; needs design → plan → implement.
**Context:** First real-world test of the meeting-coordination feature (shipped v1.0.74) surfaced two bugs. This doc captures the evidence, root causes, and required fixes. Read alongside the original design: `docs/superpowers/specs/2026-06-21-meeting-coordination-design.md`.

---

## 1. Evidence (prod transcript, business `d3c0c1e7-5c75-4b93-aca5-cc4b2bf941de` "סטודיוגה", 2026-06-22)

Owner = `+972543503704` (DB `display_name` = literal placeholder `"Owner"`). Eyal = `+972522858870` (an existing **customer**, `display_name` = null).

| Time (UTC) | Who | Message / tool |
|---|---|---|
| 06:52:36 | Owner | "I have a customer named Eyal. I want a 1-on-1 with him. Do you know Eyal?" |
| 06:53:34 | Owner | "0522858870. I want **tomorrow (Tue) 10–16, or Wednesday 11–15**. A 90-min meeting. Coordinate with him." |
| 06:53:44 | PA→owner (draft) | "…I'm helping **אסי** coordinate a meeting…" ← **invented name "אסי"** |
| 06:54:07 | PA tool | `coordinateMeeting(...)` → `{success:false, reason:"phone_not_a_contact"}` ← the B1 guard refused (Eyal is a customer) |
| 06:54:18 | PA→owner | "I see Eyal is already a customer, so I'll just send him the message directly" |
| 06:54:36 | PA tool | `messageCustomer(...)` → sends the outreach (with "אסי") to Eyal |
| 06:54:59 | Eyal | "I can only do **Wednesday at ten**" ← outside owner's Wed 11–15 window |
| 06:55:09 | PA→**Eyal** | "Sure! So a *yoga class* Wednesday 24 June 10:00. Book it?" ← Branch-4 customer flow hijacked him |
| 06:55:02 | system | `outreach.reply_notified` relays Eyal's text to owner |
| 06:55:56 | Owner | "Wednesday at ten is fine" |
| 06:56:02 | PA tool | `createCalendarEvent("פגישה עם אייל", Wed 10:00–11:30)` → booked (`block:8475e387…`) |

---

## 2. Bug 1 — PA invents a person's name ("אסי")

### Root cause
- The owner's `identities.display_name` is the literal placeholder `"Owner"` (set at provisioning, never a real name). The PA had no real name to put in an outreach that references the owner.
- The Branch-3 orchestrator prompt (`buildSystemPrompt`, `src/adapters/llm/orchestrator.ts`) forbids fabricating *actions / links / emails* but says nothing about **names**, so the LLM filled the gap with a plausible Hebrew name.
- Compounding: the outreach text was free-composed by the LLM via `messageCustomer` instead of the deterministic coordination outreach (`coordination_offer_to_contact`, which uses the *business* name and never a personal name).

### Required behaviour (owner's addition)
1. **Never invent a person's name** — hard rule in the prompt.
2. When the PA is about to approach a customer/contact on the owner's behalf and the **self-identification is ambiguous**, it should **ask the owner once**: *"When I reach out to people for you, should I say I'm **from {business name}**, or **{owner name}'s assistant**?"*
3. If the owner chooses the **owner-name** option and the PA **doesn't have the owner's name**, it must **ask for the name**, **persist it** (replace the `"Owner"` placeholder in `identities.display_name` for the manager), and use it thereafter.
4. If the owner chooses **business name**, use the business name (always available).
5. Persist the preference so the PA doesn't re-ask every time (mechanism TBD by implementer — a lightweight business setting, or session/owner-level memory; see §5 open decisions).

---

## 3. Bug 2 — out-of-boundary request accepted; coordination state machine bypassed

### Root causes
**A — the B1 guard pushes the LLM off the guarded path.** `coordinateMeeting` refuses when the counterparty's phone already belongs to a customer (`coordination-tools.ts`, the `phone_not_a_contact` return added 2026-06-21). The owner's legitimate, *common* need — coordinate with someone who is also a customer — hit that refusal, so the orchestrator abandoned the coordination state machine and improvised with `messageCustomer` + `createCalendarEvent`. Those tools enforce **none** of: candidate/window boundaries, the owner-confirm-on-final gate, or coordination state. Every guardrail was bypassed.

**B — boundaries were never encoded.** The owner gave **day+time ranges** ("Tue 10–16, Wed 11–15"). `coordinateMeeting` only models discrete candidate slots (`meeting_coordinations.candidate_slots`), and here the flow never even reached it. So Eyal's **Wed 10:00** (outside the Wed 11–15 window) was never checked against any boundary; the PA relayed it neutrally and booked it the moment the owner rubber-stamped — instead of being the guardian ("Eyal wants Wed 10:00, but you set Wed 11–15 — accept, or want me to push for 11:00?").

**C — counterparty-who-is-a-customer gets hijacked by Branch 4.** Because Eyal is a `customer`, his reply routed to `routeCustomerMessage` (Branch-4 booking), so he received a nonsensical "book your *yoga class*?" auto-reply. `routeContactMessage` (`webhook.ts`) only intercepts `role=contact`, not a customer who is mid-coordination.

### Required fixes
**Fix A — coordinate-with-a-customer (linchpin). Replace the blunt refusal.**
- `coordinateMeeting` must accept an existing customer (or any non-owner identity) as the counterparty. Do **not** corrupt the CRM: a brand-new external person is still registered as `role=contact`; an existing customer keeps `role=customer` but can be the counterparty of a coordination.
- **Routing-first interception:** in `processInboundMessage` (`webhook.ts`, the role branch ~line 207), BEFORE branching by role, look up an **active coordination where this sender is the counterparty** (by identity id). If found, route to `advanceFromContact` regardless of role. This makes the coordination own that person's inbound while active — which also fixes root cause C (no more yoga-booking hijack).
- After the coordination terminates, the person reverts to normal role-based routing.

**Fix B — boundaries as windows.**
- Let the owner express per-day **time windows** (ranges), and store them on the coordination as the negotiation boundary (extend or replace the `candidate_slots` model; the PA may still surface specific offered times within the windows).
- The handler checks every counterparty proposal against the windows:
  - **in-window** → proceed to the existing owner-confirm gate;
  - **out-of-window** → surface to the owner **explicitly framed as a deviation** ("Eyal wants Wed 10:00, but you set Wed 11–15 — accept the deviation, or should I ask for 11:00?"). Never silently book an out-of-window time.

**Fix C** — falls out of Fix A's routing-first interception.

---

## 4. Acceptance criteria

1. **No invented names.** Given an owner with no real name on file, the PA never emits a fabricated personal name; it asks the identification-preference question, and if "owner name" is chosen, asks for and persists the real name.
2. **Customer-as-counterparty works end-to-end.** Owner: "coordinate a meeting with {existing customer} …" → coordination is created (not refused), the customer's replies advance the coordination (not the booking flow), and the customer never receives a customer-booking auto-reply while the coordination is active.
3. **Boundary enforcement.** Given windows "Tue 10–16 / Wed 11–15", a counterparty proposing Wed 10:00 is surfaced to the owner as an explicit out-of-window deviation; it is bookable only after an explicit owner confirm. An in-window proposal still requires the single owner confirm.
4. **Single booking path.** A meeting coordinated via this flow is booked through the coordination handler (with `paType='meeting'` + meeting render kind), not via ad-hoc `createCalendarEvent`/`messageCustomer`. Grounding holds (no "booked"/"sent" claims without success).
5. All existing tests still pass; new tests cover the customer-counterparty routing, window classification (in/out), and the name-preference branch.

---

## 5. Open design decisions for the implementer

- **Boundary representation:** extend `meeting_coordinations` with `allowed_windows` (jsonb `[{ weekday|date, start, end }]`) vs. reinterpreting `candidate_slots`. Pick one; migrate (hand-applied `IF NOT EXISTS`, idempotent apply+verify script, per the deploy runbook).
- **`coordinateMeeting` args:** accept day+time ranges (windows) in addition to / instead of discrete primary+fallbacks. Keep the deterministic date-pieces contract (`resolveSlotRange`); never let the LLM compute absolute dates.
- **Active-coordination lookup for routing:** add a repository fn `findActiveCoordinationForCounterparty(db, businessId, identityId)` and a per-`(businessId, contactId)` active-status guarantee. Mind performance (one indexed read on the inbound hot path).
- **Self-identification preference persistence:** business-level setting vs. owner-identity field vs. session memory. Must survive across sessions to avoid re-asking.
- **Should the LLM still be able to "coordinate" via `messageCustomer`?** Consider tightening the prompt so meeting coordination always routes through `coordinateMeeting`, and `messageCustomer` is for one-off pings only — so the model can't freelance around the guardrails again.

---

## 6. Code anchors

- Orchestrator prompt + tools: `src/adapters/llm/orchestrator.ts` (`buildSystemPrompt` ~457; tool-usage rules; `coordinateMeeting`/`resolveMeetingCoordination` declarations).
- Tool handlers + the B1 refusal to replace: `src/domain/manager/coordination-tools.ts`.
- Inbound routing: `src/routes/webhook.ts` (role branch ~207; `routeContactMessage`).
- Coordination core: `src/domain/coordination/` (`handler.ts`, `state.ts`, `types.ts`, `repository.ts`, `interpret.ts`).
- Identity: `src/domain/identity/resolver.ts` (`registerContact`/`registerCustomer`).
- Schema + migration pattern: `src/db/schema.ts` (`meetingCoordinations`), `src/db/migrations/0024_meeting_coordination.sql`, `scripts/apply-coordination-migration.ts`.
- i18n fallbacks: `src/domain/i18n/t.ts` (`coordination_*`).
- One-off message tool (freelance path to tighten): `executeMessageCustomer` in `src/domain/manager/orchestrator-tools.ts`.

## 7. Out of scope / don't break
- CRM isolation (contacts must not pollute customer lists), grounding (CHAT_LEVEL_LAWBOOK §7.4), owner-only authorization (`meeting.coordinate`), and the existing 504-test suite.
- The already-booked Wed-10:00 event from the incident is test data; cleanup is the owner's call, not part of this work.
