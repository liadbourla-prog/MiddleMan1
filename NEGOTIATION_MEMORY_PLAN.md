# Negotiation Memory — Rejected-Slot & Constraint Tracking (Branch 4 first)

**Status:** in progress
**Owner:** Developer A (core engine; touches `src/domain/flows`, `src/domain/availability`, `src/domain/manager`)
**Origin:** Long-chat reliability review. In a multi-turn slot negotiation the PA loses track of which
times the customer already ruled out (rejections live only in the scrolling 8-message transcript, and
there is no durable "already-proposed / already-rejected" record). Result: the PA can re-offer a time
the customer already refused, or ignore a stated "no mornings" preference, and appear to go in circles.

This is **not** a booking-correctness bug — the deterministic core still prevents invented/mis-booked
times. It is a conversational-coherence gap. Fix is durable, structured, deterministically-enforced
negotiation memory scoped to one session.

---

## Locked design decisions

1. **Storage:** a `negotiationConstraints` object in the session `context` jsonb (Branch 4:
   `BookingFlowContext`; Branch 3: `ManagerFlowContext`). Same durable place `slotDraft`/`pendingSlot`
   already live. Session expiry is the hard outer bound — nothing crosses sessions.
2. **Enforcement is deterministic.** The LLM never has to "remember" a rejection. Constraints are
   subtracted from the engine's candidate slots *before* the LLM sees them. (Principle #1: LLM
   interpretive only.) Any prompt note is cosmetic on top.
3. **Rejected slots are time-keyed, concrete-instance, service-agnostic.**
   - Rejecting "yoga Thursday 3pm" suppresses **3pm that Thursday for all services** (the customer is
     busy then). `serviceTypeId` is stored as metadata only — it does **not** participate in matching.
   - "Thursday 3pm" = that specific Thursday's 3pm (a concrete `{start,end}` instant), not every Thursday.
4. **Filter suppresses proactive *suggestions* only — never an explicit request.** If the customer
   explicitly asks about / requests a previously-rejected time, honor it AND remove it from the
   rejected list (a mind-change). The explicit-booking path never goes through the suggestion filter,
   so it is naturally exempt; the inquiry path ("is 3pm open?") is exempted by un-suppressing on
   explicit reference.
5. **Categorical constraints ("no mornings", "not Thursdays")** are a separate `avoid` field on the
   same object: LLM-*interprets* the preference into structured rules, the deterministic core
   *enforces* them in the same filter. Session-lifetime (no per-entry expiry).
6. **Lifecycle / pruning:** on load, drop rejected entries with `start <= now` (the engine won't offer
   past slots anyway — this is housekeeping), and cap to the last N (12) most recent. `avoid` lives
   for the session. Session expiry wipes everything.
7. **"This customer only ever does yoga"** is a *standing cross-session preference* → belongs in the
   customer-profile / memory layer, **NOT** here. Out of scope for this plan (separate ticket).

## Branch 3 scope & cost

Asymmetric with Branch 4 because Branch 3 is a conversational LLM orchestrator, not a state machine:
- **Storage** — free (shared jsonb).
- **Read-side filter** — cheap: subtract constraints from the calendar-read tool's output in
  `orchestrator-tools.ts`. Included once the module exists.
- **Write-side capture** — expensive & lower-reliability: there is no deterministic "rejection"
  transition; capturing would mean an LLM-driven `noteRejectedSlot` tool (reintroduces the
  LLM-trust we're designing out) or brittle free-text parsing. Branch 3's window is already 20 msgs
  and its traffic is mostly direct commands, so value is low. **Deferred.**
- The genuine Branch-3 negotiation case is **meeting coordination** (`src/domain/coordination/`,
  already a state machine with durable state) — the right home for capture if ever needed.
  Tracked as a separate follow-up.

---

## Data model (`src/domain/flows/types.ts`)

```ts
export interface RejectedSlot { start: string; end: string; serviceTypeId?: string } // ISO instants
export interface AvoidConstraint {
  beforeHour?: number       // suppress wall-clock start < beforeHour (e.g. 12 ⇒ "no mornings")
  afterHour?: number        // suppress wall-clock start >= afterHour
  weekdays?: number[]       // suppress these weekdays (0=Sun..6=Sat), business-local
}
export interface NegotiationConstraints {
  rejectedSlots?: RejectedSlot[]
  avoid?: AvoidConstraint
}
// added to BookingFlowContext (and ManagerFlowContext): negotiationConstraints?: NegotiationConstraints
```

## New pure module (`src/domain/flows/negotiation-constraints.ts`) — fully unit-tested

- `pruneConstraints(c, now): NegotiationConstraints` — drop rejected `start <= now`, cap last 12.
- `isSlotSuppressed(start: Date, c, tz): boolean` — true if `start` instant equals a rejected start,
  OR violates `avoid` (wall-clock hour / weekday in business tz).
- `filterOpenSlots(slots: Slot[], c, tz): Slot[]` — drop suppressed slots.
- `addRejectedSlots(c, slots: RejectedSlot[]): NegotiationConstraints` — dedupe by start instant, cap.
- `removeRejectedSlot(c, startISO): NegotiationConstraints` — un-suppress on explicit reference.

Pure, no DB, no clock except injected `now` — clean TDD target (mirrors existing
`block-around-classes.ts` test style).

---

## Phased build

### Phase 1 — deterministic core + safe capture (low risk, high value)  ✅ DONE (built, typecheck + lint + 933 tests green)
1. Types + pure module (+ tests).
2. `handleBookingFlow`: load `ctx.negotiationConstraints`, `pruneConstraints` on entry.
3. **Filter** wired into the three suggestion builders — `suggestOpenSlotsText`,
   `buildInquiryAvailabilityText`, `buildDayOptionsText` — by passing constraints and filtering the
   `getOpenSlots` / `listDayOptions` candidates.
4. **Capture (pivot path):** in `rebuildOnSlotPivot`, when the abandoned `pendingSlot` is dropped for
   a revised request, add it to `rejectedSlots`. This is the unambiguous within-session rejection
   ("PA proposed X → customer counters → don't re-offer X").
5. **Un-suppress on explicit reference:** when the current message names a specific time that matches a
   rejected entry, `removeRejectedSlot` before resolving/answering.
6. Tests: pure module + flow-level (pivot captures; re-suggest excludes; explicit re-ask un-suppresses).

### Phase 2 — categorical avoid + offered-list capture  ✅ DONE (built, typecheck + lint + 939 tests green)
7. `avoid` extraction: `extractCustomerIntent` schema + prompt gained `avoidConstraints
   { beforeHour, afterHour, weekdays }`; folded into `ctx.negotiationConstraints.avoid` via `mergeAvoid`
   right after extraction. Enforcement reuses the Phase-1 filter. (`CustomerIntentOutput.avoidConstraints`.)
8. Offered-list capture: each suggestion builder now returns `{ text, offered }`; the offered slots are
   persisted as `lastOfferedSlots` on every list-offer path (inquiry, bad-time, class-gate, taken-slot).
   At the START of the next turn they are promoted to `rejectedSlots` and cleared — and the existing
   explicit-pursuit un-suppress pulls back the one the customer actually picks (self-correcting, so no
   over-suppression of a chosen slot). Over-suppression of the *pool* is guarded by over-fetching
   (maxSlots 40/30) before filtering, so a broad avoid rule can't falsely empty a page.
9. Flow-level wiring covered by `tests/flows/negotiation-memory-flow.test.ts` (promotion + avoid merge).

### Phase 3 — Branch 3 read-side filter  ✅ DONE (built, typecheck + lint + 939 tests green)
9. `negotiationConstraints` threaded webhook → `OrchestratorParams` → `ToolContext`; the
   `check_free_slots` tool over-fetches then `filterOpenSlots` before returning. **Capture stays
   deferred** (managers have no deterministic rejection transition), so this is currently inert —
   wired and live the moment a capture path lands. The genuine Branch-3 capture home remains the
   meeting-coordination state machine (`src/domain/coordination/`) — tracked as a separate follow-up.

---

## Status: COMPLETE for the agreed scope
Phases 1–3 built. Branch 4 has full capture + filter (single-slot, categorical avoid, batch). Branch 3
has the read-side filter wired (capture intentionally deferred). Deploy via `/update-agent`.

---

## Invariants / guardrails
- Never block or filter the **explicit request / confirmation** path — suggestions only.
- Never let suppression produce a false "nothing available": if filtering empties the candidate set,
  fall back to unfiltered results rather than claim no availability (Phase 2 offered-list guard).
- All matching is instant/wall-clock arithmetic in the **business timezone** — reuse `localParts`.
- No cross-session leakage: constraints live only in session context; expiry wipes them.
- TS + ESLint + tests green before each phase merges.
