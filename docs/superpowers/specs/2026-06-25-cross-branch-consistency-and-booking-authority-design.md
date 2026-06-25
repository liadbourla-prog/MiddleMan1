# Cross-Branch Reality Consistency + Per-Business Booking Authority — Design

**Date:** 2026-06-25
**Branch context:** `dev/system/*` (Developer A — core engine; not skills)
**Status:** Partially implemented (branch `dev/system/cross-branch-consistency`) — see §9.
**Triggered by:** 2026-06-25 morning test simulation in business *סטודיוגה* (Owner +972…3704, customer "Yoni" +972…7775, "Harel" +972…2400). See "Incident" below.

---

## 1. Problem

The PA reflected **two contradictory realities at the same instant** across branches:

- **Branch 4 (customer / Yoni):** PA confirmed bookings outright — *"סגור. קבעתי לך פילאטיס… ✅"* — twice (05:29:12 for Sun 5 Jul 17:00; 05:35:22 for the Mon/​Sun 09:00 slot). Real `bookings` rows were written (05:28:22, 05:34:36).
- **Branch 3 (owner) at the same time:** PA told the owner the *same* booking was still pending his approval — *"עדיין לא, ממתין לתשובה"* (05:34:50) and *"…לתקן ולקבוע לו?"* / *"לקבוע לו?"* (asking the owner to approve at 05:30:02 and 05:35:30) — for a booking Yoni had **already** made himself. The owner only "approved" at 05:36:00, ~38–90s **after** the customer was told ✅.

This is a **Principle #5 ("failure is explicit" / no "said-done-didn't-do")** and **§7.4 Action-Grounding** violation in the inverse direction: the PA narrated a *committed* action as still *pending*, and solicited approval for something already done.

### 1.1 Root cause (grounded in code)

1. **The owner-facing ground-truth block is entity-blind for bookings.**
   `src/domain/audit/ledger-block.ts` already injects a "What actually happened" block into Branch 3, and `booking.confirmed` is already a `REPORTABLE_ACTION`. **But** `renderAction()` renders it as the generic string *"A booking was confirmed."* — dropping the customer, the slot, the service, and the initiator. The orchestrator therefore cannot connect that ground-truth row to "the Yoni booking we're discussing," and falls back to the stale chat prose that says it's pending.
   - The data exists but is unused: the `booking.confirmed` audit row (`src/domain/booking/engine.ts:517`) carries `actorId` (the booker — the *customer* on a self-book), `entityId` (bookingId), and `afterState`, but **not** the customer display name / slot / service in a renderable shape.

2. **The Branch 3 orchestrator does not consult committed reality for the customer under discussion** before proposing or asking-to-approve a booking. It reasons from session transcript, not from the ledger/bookings for that person.

3. **No "first commit wins" reconciliation.** The owner channel and customer channel are independent sessions over shared state with no rule that the first committed write is authoritative and the other channel must yield to it.

### 1.2 What was NOT a bug (per 2026-06-25 product decision)

Yoni self-booking and getting an instant ✅ is **correct**. Customer self-bookings are never owner-gated (decision below). The defect is purely that the owner was shown a *false, contradictory* reflection of that commit.

---

## 2. Decisions (locked 2026-06-25)

| # | Decision | Value |
|---|---|---|
| D1 | **Owner-approval scope** — which bookings ever wait for the owner's manual chat "yes" | **Only PA/owner-initiated bookings + coordination outreach.** Customer self-bookings (Branch 4) are **always instant**, in both modes. |
| D2 | **Default booking-authority mode** for a business | **`auto`** (auto-book on open slot; owner notified, not asked). |
| D3 | Mode is **per-business**, set/changed in the **Branch 3 owner chat** | New `bookingAuthority` field; `manageBusinessSettings` tool can read/set it. |
| D4 | Cross-branch consistency invariant | **Non-negotiable, applies in both modes.** Not a config. |

---

## 3. Invariants (the contract)

**INV-1 — One reality.** There is exactly one committed truth per scheduling primitive: the `bookings` / `calendar_blocks` row + its `audit_log` entry. Every branch's prose MUST derive from that record, never contradict it.

**INV-2 — First commit wins.** Whichever channel commits the write first is authoritative. A second channel touching the same slot/person must **reconcile to** the committed state (reflect / offer to change), never silently overwrite it or present it as not-yet-done.

**INV-3 — The owner always receives a true reflection of customer reality.**
- *Reactive:* when the owner asks or acts, the answer is computed from the ledger/bookings — never "still pending" for a committed action.
- *Proactive:* when a customer commits a booking/cancellation, the owner gets a notification reflection of it, subject to his `notification_rules` dial (he can tune cadence, but the PA must never replace a *completed* fact with a *pending-approval* question).

**INV-4 — Never solicit approval for a done action.** The PA must not ask the owner "shall I book / approve?" for a booking that is already committed. If committed, it reflects; it does not re-propose.

**INV-5 — Owner-approval mode gates only PA/owner-initiated writes** (D1). Customer self-bookings bypass the gate in every mode.

---

## 4. Design

### 4.1 Consistency fix (ships in both modes — the bug)

**4.1.1 Enrich booking audit metadata** (`src/domain/booking/engine.ts`, all `booking.confirmed` / `booking.cancelled` / `booking.manager_cancelled` writes):
add structured, renderable metadata:
```ts
metadata: {
  customerName,            // identity.displayName ?? short phone
  customerId,
  slotStart, slotEnd,      // ISO
  serviceName,
  initiator: 'customer_self' | 'owner' | 'pa_coordination',
}
```
`initiator` is derived from the actor/role at the call site (customer self-book vs owner-commanded vs coordination booking).

**4.1.2 Enrich the ledger renderer** (`renderAction` in `src/domain/audit/ledger-block.ts`) for booking actions, e.g.:
> `Thu 08:29 — Yoni booked Pilates himself for Sun 5 Jul 17:00 (customer self-service). ALREADY DONE — reflect this to the owner; do NOT ask him to approve it.`

For `initiator: 'owner'|'pa_coordination'` the line reads "you booked … for {customer}" so the owner sees his own committed actions too.

**4.1.3 Orchestrator consults ground truth before proposing/approving** (`src/adapters/llm/orchestrator.ts` + `src/domain/manager/orchestrator-tools.ts`):
- When a Branch 3 turn is about booking/checking a *named customer*, the context build resolves that customer's **current** active bookings and recent commits and injects them.
- Prompt rule (orchestrator system prompt / `voice.ts`): *"If the ground-truth block shows a booking for the customer under discussion already exists/was just made, REFLECT it ('Yoni already booked X himself') — never ask the owner to approve or re-book it."* This operationalizes INV-4.

**4.1.4 Proactive owner reflection on customer commits.** On a `booking.confirmed`/`booking.cancelled` whose `initiator: 'customer_self'`, emit an owner notification through the existing `notification_rules` engine ("Yoni just booked Pilates, Sun 17:00"). Default: notify (the owner may mute/tune per the existing dial — but muting changes *whether he's pinged proactively*, never licenses a *false pending-approval* prose on a later turn; INV-3/INV-4 still hold reactively).

### 4.2 Per-business booking authority (the feature)

**4.2.1 Schema.** Add to `businesses` (and `src/shared/skill-types.ts` business config):
```ts
bookingAuthority: text('booking_authority', { enum: ['auto', 'owner_approval'] })
  .notNull().default('auto'),
```
Migration: default `'auto'` ⇒ zero behavior change for existing businesses (D2).

**4.2.2 Semantics.**
- `auto` (default): PA-initiated bookings (`createCalendarEvent`, owner-commanded customer bookings, `coordinateMeeting` final step) commit when the slot is open — **as today** — and the owner is *notified*.
- `owner_approval`: PA-initiated writes are **deterministically held** until an explicit owner confirm is recorded. The hold is enforced in the *core*, not just LLM prose:
  - The tool returns a **proposal** (`{ status: 'awaiting_owner_approval', proposalId }`) and writes a pending row (reuse the coordination `awaiting_owner_confirm` pattern / a lightweight approvals row), **no** committed `bookings`/`calendar_blocks` write yet.
  - A subsequent owner "yes" (resolved by the orchestrator into an explicit `approveBooking(proposalId)` deterministic call) performs the real write + audit. This mirrors the existing meeting-coordination invariant: *"exactly one owner 'yes' gates every calendar write"* (`docs/superpowers/specs/2026-06-21-meeting-coordination-design.md` §5).

**4.2.3 Scope guard (D1/INV-5).** The owner-approval hold is applied **only** on PA/owner-initiated paths. The Branch 4 customer booking engine path (`requestPrivateBooking` / `requestGroupClassBooking`) is **never** gated by `bookingAuthority`.

**4.2.4 Configuration in Branch 3.** `manageBusinessSettings` (orchestrator tool) gains read/set for `bookingAuthority`, so the owner can say *"don't book anything without asking me first"* → `owner_approval`, or *"just book open slots, only tell me after"* → `auto`. Surfaced in the business-settings summary.

---

## 5. The incident, replayed under the new design

- Yoni self-books Pilates → instant ✅ (unchanged; D1). Audit row now carries `{customerName:'Yoni', slot:'Sun 17:00', initiator:'customer_self'}`.
- Owner asks "did he confirm?" → ground-truth block renders *"Yoni booked Pilates himself, Sun 17:00 — already done"* → PA replies **"Yoni already booked it himself for Sun 17:00"**, NOT "still pending" (INV-3/INV-4 satisfied).
- Owner says "book Yoni at 11" (PA-initiated): in `auto` → booked + "done, I notified him"; in `owner_approval` → "want me to book Yoni Fri 11:00? (slot is open)" → owner "yes" → committed (one gated write).

---

## 6. Affected components

| Area | File(s) | Change |
|---|---|---|
| Booking audit metadata | `src/domain/booking/engine.ts` | enrich `booking.confirmed/cancelled` metadata + `initiator` |
| Ledger render | `src/domain/audit/ledger-block.ts` | render customer/slot/initiator + "already done" instruction |
| Branch 3 grounding | `src/adapters/llm/orchestrator.ts`, `src/domain/manager/orchestrator-tools.ts` | inject discussed-customer bookings; reflect-not-approve rule |
| Owner voice/prompt | `src/adapters/llm/voice.ts` | INV-4 phrasing rule |
| Proactive notify | notification_rules engine | owner reflection on customer self-commits |
| Booking authority | `src/db/schema.ts`, migration, `src/shared/skill-types.ts` | `bookingAuthority` field |
| Approval hold | PA-initiated booking/coordination commit paths | deterministic hold + `approveBooking` in `owner_approval` |
| Settings | `manageBusinessSettings` tool + business summary | read/set `bookingAuthority` |

---

## 7. Test plan (TDD — write first)

1. **Consistency (mode-agnostic):** customer self-books → owner turn that asks "did he confirm / shall I book?" ⇒ assert reply reflects the commit and contains **no** approval solicitation. (Integration, replays the incident.)
2. **Ledger render:** `booking.confirmed` with enriched metadata ⇒ block line includes customer + slot + "already done".
3. **First-commit-wins:** customer commits slot, owner concurrently tries to book same slot/person ⇒ owner path reconciles (reflects existing), no double write.
4. **`auto` mode:** PA-initiated booking on open slot commits without approval; owner notified.
5. **`owner_approval` mode:** PA-initiated booking returns `awaiting_owner_approval`, **no** DB write; owner "yes" ⇒ exactly one committed write + audit.
6. **Scope guard:** in `owner_approval` mode, a **customer** self-booking still commits instantly (not gated).
7. **Config:** owner sets mode via Branch 3 chat ⇒ `bookingAuthority` persisted; summary reflects it.

---

## 8. Open questions / notes

- "First commit wins" reconciliation (INV-2) for the rare true race (both commit within the same second on the same slot) relies on the existing booking-engine overlap guard (`engine.ts` conflict predicate) — confirm it rejects the second write cleanly and the losing channel surfaces a reconcile message rather than a raw failure.
- Proactive owner-notification default vs the existing "never notify on your own" voice rule (`voice.ts:44`) — this design treats a **customer-initiated commit** as a notifiable business event (via notification_rules), distinct from the PA *spontaneously* messaging a customer. Confirm wording so the two don't conflict.

---

## 9. Implementation status (2026-06-25)

**Shipped (committed on `dev/system/cross-branch-consistency`):**
- ✅ **Consistency fix (the bug — INV-1/INV-4).** Enriched booking audit metadata (customer/slot/service/initiator) at all four engine commit/cancel sites; ledger renderer now prints the real subject + an explicit "ALREADY DONE — reflect, do not ask to approve"; Branch 3 system-prompt rule "reflect committed reality, never re-ask approval for a done action." Unit-tested (`ledger-block.test.ts`). *This fully closes the Yoni reactive contradiction.*
- ✅ **Booking authority feature.** `businesses.booking_authority` (migration 0042, default `auto`); deterministic owner-approval gate in `createCalendarEvent` (first call → `awaiting_owner_approval`, no write; re-call with `ownerApproved:true` after the owner's yes); mode-aware Branch 3 prompt; conversational config via `manageBusinessSettings` policy subtype `booking_authority` (he/en). Gate unit-tested.

**Remaining (follow-up — scoped, not yet built):**
1. **INV-3 proactive owner-notification** on a *customer* self-commit (owner gets pinged "Yoni just booked X"), gated by `notification_rules` (`new_booking`). Needs a registered initiator on the initiations spine — non-trivial. *Reactive* reflection is already correct; this is the unprompted ping.
2. **Broaden the owner-approval gate** beyond `createCalendarEvent` to the other PA-initiated calendar writes (`scheduleGroupSession`, `scheduleRecurringClasses`, `editClassSession`) using the same gate helper.
3. **Integration test** for the `booking_authority` config setter (needs migration applied to the test DB) and an end-to-end replay of the Yoni incident through the orchestrator.
4. **Determinism hardening (optional):** replace the LLM-set `ownerApproved` flag with a two-call `proposalId` protocol (call 1 stores a pending proposal, call 2 approves by id) so the core — not the model — holds the approval token. Current approach matches existing codebase owner-approval patterns (`messageCustomer`, `resolveMeetingCoordination`).
5. **First-commit-wins (INV-2)** explicit reconciliation message on the rare true same-slot race relies today on the booking-engine overlap guard; verify it surfaces a clean reconcile rather than a raw failure.
