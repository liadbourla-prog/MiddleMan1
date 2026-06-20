# Proactive Reshuffle Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the PA the ability to *solve* an over-subscribed reschedule instead of just refusing it. When a customer asks to move onto an already-taken slot (and the owner won't drop anyone), the PA proactively negotiates with other booked customers to find the **fastest, fewest-changes** rearrangement that keeps the calendar as full as it was, then presents that rearrangement to the owner for approval before anything changes. Every parameter that governs *how hard* and *how widely* the PA negotiates is owner-configurable, with safe defaults (batch outreach in groups of 7; owner approval required before any write).

**Motivating scenario (the acceptance test):** Single-owner physio studio, Su–Th 08:00–20:00, Fri 08:00–15:00, fully booked next week. Customer booked Tue 10:00 asks to move to Tue 17:00 (taken). Owner keeps both appointments. The PA contacts the Tue 17:00 customer to see if *they* will take Tue 10:00 (a direct 2-way swap — the ideal least-changes answer); if not, it widens the search to chains and, if needed, batched outreach to all booked customers (groups of 7 by default), assembles a complete pre-agreed solution, and asks the owner to approve. Nothing mutates before approval.

**Architecture:** Internal-as-hub (`CALENDAR_UX_DESIGN.md` §2): the internal record is the source of truth; the reshuffle solver operates entirely on internal bookings and the canonical availability spine, and Google is updated by write-through *after* an approved chain commits. The engine is **interpretive-LLM, deterministic-core** (CLAUDE.md principle 1–2): the LLM only phrases outbound messages and parses inbound replies into a typed `yes/no/counter-offer`; the solver, the chain validation, and every write are deterministic. The whole capability lives in the **core** (`src/domain/`), not in a skill — it needs the booking engine, availability spine, outbound messaging, and the manager-approval seam, all of which are off-limits to the isolated skills layer (CLAUDE.md "Skills Boundary"). It is therefore **Developer A** territory (`dev/system/*`).

**Tech Stack:** TypeScript, Drizzle ORM (postgres-js driver), Postgres 16, BullMQ workers (Redis), Vitest (unit + skip-guarded integration). Reuses existing seams: the booking engine's deferred-cancel reschedule (`requestBooking`/`confirmBooking`/`cancelBooking` with `rescheduledFrom`), the availability spine (`src/domain/availability/*`), proactive outbound (`generateProactiveCustomerMessage` + `sendMessage`/`sendTemplateMessage` + `canSendFreeForm`), and the deterministic manager apply pipeline (`src/domain/manager/apply.ts`).

**Depends on (both prerequisites landed + tested):**
- **Single-booking deferred-cancel reschedule** — `handleReschedulingIntent` no longer cancels before the replacement is secured; `releaseSupersededBooking` releases the old slot only on confirmation.
- **Multi-booking deferred-cancel reschedule (scenario G2)** — `handleCancellationConfirmation` defers the cancel in the reschedule branch; a `rescheduledFrom` guard in the intent dispatch routes the follow-up turn to the booking path instead of re-prompting selection.
- Covered by `tests/flows/customer-booking-reschedule.test.ts` (4 tests). The chain executor reuses this same deferred-cancel property so intermediate steps never strand a customer.

---

## Environment for integration steps

DB-backed steps run against the **isolated local** Postgres (never prod). Export before running them:

```bash
export DATABASE_URL="postgresql://$(whoami)@127.0.0.1:5440/pa4business_test"
export LLM_API_KEY="test-key-unit"          # dummy — no live LLM call in these tests
export REDIS_URL="redis://127.0.0.1:6379"
export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"; export LC_ALL="en_US.UTF-8"
```

Gates between tasks (all must stay green): `npx tsc --noEmit`, `npm run lint`, `npm test`, and the integration files touched. This repo applies migrations by hand (it does NOT use `drizzle-kit migrate` — see the `0018_delegated_permissions.sql` header); add idempotent SQL migrations and apply them manually.

---

## Core concepts

### The displacement graph

Model the week as a set of **occupied slots**, each owned by one booking. A reschedule request is a desire by customer `A` to move from slot `S_a` to slot `S_b`, where `S_b` is occupied by `B`.

> **Slots are not interchangeable (decision G-5).** A slot's identity is `(start, duration)`, where duration comes from the booking's service. An edge "customer X can take slot Y" exists only if X's service **fits** Y — its duration tiles into the gap Y would leave *and* the surrounding calendar (hours, buffers, adjacent bookings) still validates via `canFit`. A 60-min booking cannot simply drop into a 30-min slot. "Occupancy preserved" therefore means *service-aware* fullness, not equal slot counts: the solver only forms cycles among duration-compatible bookings, and any length mismatch that would open or strand time is rejected by `canFit`.

- Moving `A` into `S_b` **displaces** `B`. `S_a` becomes **vacant**.
- A *solution* is an assignment of every displaced customer to a slot such that (a) no slot is double-booked, (b) occupancy is preserved (the week stays as full as it started), (c) every moved customer has agreed to their new slot, and (d) the owner's constraints (working hours, service duration, provider availability, per-customer flexibility, **protected parties** — see below) hold.
- The cheapest solution is a **cycle** seeded by the vacancy `S_a`:
  - **2-cycle (direct swap):** `B` takes `S_a`. A↔B swap. 2 customers touched, occupancy unchanged. *This is the default first attempt and the answer to the motivating scenario.*
  - **k-cycle (chain):** `B`→`S_c` (held by `C`), `C`→`S_d` … → last customer takes `S_a`. `k` customers touched.
- **Minimal changes = the fewest people moved, period (decision G-1).** Cost is the plain *count* of movers in the cycle. Protected parties (below) are **hard-excluded** from the mover set — they are never down-weighted, simply ineligible. The solver searches cycles in increasing length and stops at the first complete, fully-agreed one; ties (same count) are broken by total proximity to everyone's stated preference. Length is capped by `maxChainLength` (config; default 3).

### Goal function — best-effort, never give up (decision X2)

The objective is **not** strictly "A gets exactly `S_b`". It is, in priority order:

1. **A gets exactly `S_b`** with the fewest, cheapest moves.
2. If (1) is impossible, **A gets a slot strictly better than their current one** (closer to their stated preference) while the week stays full — the engine *offers this to A* ("the closest I can do is Tuesday 16:00 — want it?") rather than reporting failure.
3. If (2) is impossible, A keeps their current slot, the week is untouched, and A is told it couldn't be arranged.

The engine never silently declines while an improvement exists. "Better than current" is ranked by proximity to A's expressed preference (same day > adjacent time > same week), and any partial offer to A still passes the full owner-approval gate.

### Protected parties — who the solver may never pick as a mover (decision A4)

A booking is **protected** (excluded from the displaced/mover set) if any of:
- **Near-term:** its start is within `protectWindowHours` of now (config; **default 3**, owner-tunable).
- **VIP:** the customer carries a `vip` flag.
- **Recently rescheduled:** the booking was already moved within `recentRescheduleLookbackHours` (don't yank the same person twice).

Protected bookings can still *initiate* a request (a VIP may ask to move themselves) and can still *receive* a better offer if they opt in — they are only shielded from being moved *to accommodate someone else*. The solver treats a protected node as a dead end for chains.

### Edges are discovered by outreach, not assumed

We do not know in advance which alternative slots a customer will accept. Each *edge* ("customer X is willing to take slot Y") is discovered by **asking X**. So the engine interleaves solving and outreach:

0. **Requester-first flexibility probe (mandatory, before any other outreach — decision X2).** Before disturbing *anyone else*, the PA asks the **requester** for their own additional acceptable options ("besides Tuesday 17:00, are there other times that would work for you?"). Any open slot among the requester's stated options is the cheapest possible solution — **zero disturbance** — and is taken immediately. The calendar-shuffling rungs below run *only* if the requester's own flexibility can't be satisfied against existing openings. This is the least-disruption-first rule: never message a third party while a no-disturbance answer might exist.
0.5. **Reciprocal-request check (decision G-2).** On opening a campaign, look for an existing live campaign/offer where the occupant of `S_b` (or anyone) has independently asked to move *into* `S_a` (or into the requester's slot). A reciprocal match is a clean **mutual 2-way swap** — both parties already want it — and is proposed to the owner immediately, ahead of any new outreach. This is checked before rung 1 so the obvious match is never missed.
1. **Targeted probe** (cheapest disturbance): ask `B` directly "would you take `S_a`?" → tries to close a 2-cycle.
2. **Chain probe:** if `B` offers a counter (a different slot they'd accept), follow that edge and probe its occupant — building a chain on demand.
3. **Batched broadcast** (widening): if targeted probing stalls, message booked customers in **groups of `batchSize` (default 7)** asking who would accept `S_a` (or who is flexible at all), collect willing candidates, and feed those edges back into the cycle search.

Outreach holds the candidate slots (status `probing`/`offered`, like the waitlist worker's `offered` state with `offerExpiresAt`) so concurrent bookings can't invalidate an in-flight solution.

### No transient vacancies — the concurrency surface is small (decision G-3)

A crucial consequence of deferred-cancel + atomic apply: **no booking is ever released mid-campaign.** Every participant keeps their slot until the whole cycle commits in one transaction. Therefore an occupied slot can never become a stealable vacancy during a campaign — there is nothing to race for among *occupied* slots.

The **only** thing another booking can take out from under us is a **genuinely-open slot** the engine is counting on — i.e. an opening surfaced by the requester-first probe (step 0) or a `better_offer`. So:
- Such planned-on open slots must be **held** (a `probing`/`offered` hold with TTL) the moment the engine decides to use them, exactly like the waitlist offer hold.
- This reframes the concurrency scenarios: **B2** (two campaigns) only truly contend when they both plan to use the *same open slot* — resolve by a hold/lock on that slot, FIFO. **B3** is "a planned-on open slot got booked first" (not "a vacated slot was stolen" — that can't happen) → re-validate and re-solve. **C6** (double-yes) likewise only arises for an open slot offered in a broadcast → first accepted hold wins, the rest get a graceful close.
- Final safety net regardless: **re-validate the entire plan at apply time** inside the executor's transaction; if any assumption no longer holds, abort untouched.

### Termination — when a campaign concludes (decision G-6)

A campaign ends in exactly one of these states, checked after every inbound reply and on every TTL tick:
- **Solved** → a complete, fully-agreed cycle (or mutual swap, or requester-first open slot, or `better_offer`) exists → move to `solution_pending_approval` (or apply, under `auto_apply`).
- **Exhausted** → declared insoluble only when **all** hold: every rung in `escalationLadder` has been attempted, every outstanding offer has resolved or expired (no `probing`/`offered` left), and either the eligible pool is empty or `maxOutreachPerCampaign` is reached. → `failed`, calendar untouched, requester told, anyone messaged gets a soft retract.
- **Abandoned** → requester bailed (F4), or the requester's original booking changed externally, or a global campaign TTL elapsed. → release holds, soft-retract, untouched.

The campaign never hangs (every path has a TTL) and never quits early (it cannot declare "insoluble" while any rung is untried or any offer is still open).

### Owner approval gate

When the solver has a **complete, validated, fully-pre-agreed** cycle, it persists a `reshuffle_proposal` (the ordered list of moves) and notifies the owner via the manager channel (Branch 3). The owner can **approve, reject, or tweak** it conversationally; approval triggers the deterministic **chain executor**. Default = approval required. Owner may set `approvalMode: 'auto_apply'` to skip the gate (the engine then applies the first validated solution automatically and informs the owner after).

**Owner tweaks (decision D3).** The owner can modify a proposal in plain language ("do the swap, but put them at 17:30 not 17:00" / "move someone else instead of David"). The engine:
1. Re-runs the solver/validator against the amended plan (state `amended`).
2. **Explains the consequences before applying** — e.g. "17:30 isn't within the other customer's stated availability, so I'd need to re-ask them" / "that frees a slot nobody has accepted yet — the week would no longer be full" / "that move now disturbs a protected (near-term) booking." The PA never silently applies a tweak whose downstream effects the owner hasn't seen.
3. If the tweak invalidates a prior agreement, the affected customer is **re-contacted for fresh consent** before the amended plan can be approved; the owner is told this is pending. Only a re-validated, re-agreed amended plan can be approved and executed.

---

## Owner-configurable knobs (`businesses.reshuffleConfig` jsonb)

All elastic per the product owner's requirement. Defaults chosen to be conservative and least-surprising.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `false` | Master switch. Off → PA falls back to today's behavior (politely decline + offer real openings). |
| `approvalMode` | `'require_approval' \| 'auto_apply'` | `'require_approval'` | Whether the owner must approve a solution before it commits. **Default: PA waits for approval.** |
| `batchSize` | integer | `7` | Customers contacted per broadcast wave. Owner may raise (e.g. 20) or lower. `0`/`null` → no cap (contact the whole eligible pool in one wave). |
| `escalationLadder` | `('direct' \| 'chain' \| 'broadcast')[]` | `['direct','chain','broadcast']` | Ordered strategies the engine is allowed to use, cheapest first. Owner can shorten (e.g. `['direct']` = only ever attempt the simple swap). |
| `maxChainLength` | integer | `3` | Longest cycle the solver will assemble (caps "number of people disturbed"). |
| `offerTtlMinutes` | integer | `30` | How long a probe/offer holds a candidate slot before lapsing. |
| `maxOutreachPerCampaign` | integer | `21` | Hard ceiling on total customers messaged for one request (defense against spamming the whole book). |
| `quietHours` | `{start:'HH:MM',end:'HH:MM'}` \| null | `{start:'21:00',end:'08:00'}` | No proactive outreach inside this window (queued until it lifts). |
| `contactScope` | `'conflicting_only' \| 'service_match' \| 'all_booked'` | `'service_match'` | Who is eligible for broadcast: only the conflicting customer; only customers booked for the same service; or anyone booked that week. |
| `respectMessagingOptOut` | boolean | `true` | Skip identities with `messagingOptOut`. (Always true in practice; exposed for auditability.) |
| `protectWindowHours` | integer | `3` | Never move a booking whose start is within this many hours of now (decision A4). Owner-tunable. |
| `protectVip` | boolean | `true` | Never move a booking owned by a `vip`-flagged customer to accommodate someone else. |
| `protectRecentlyRescheduled` | boolean | `true` | Don't move a customer who was already moved recently… |
| `recentRescheduleLookbackHours` | integer | `168` | …within this lookback (default 7 days). |
| `offerBetterSlotToRequester` | boolean | `true` | Best-effort goal (decision X2): if the exact slot is unreachable, offer the requester the closest better-than-current slot instead of failing. |
| `allowOwnerTweak` | boolean | `true` | Owner may amend a proposal at the gate; the PA explains consequences and re-validates (decision D3). |

Validated and written through the **manager apply pipeline** (`apply.ts`), surfaced as a `manageBusinessSettings` field so the owner sets it conversationally: *"only ever try a straight swap, never message more than 5 people, and don't ask me — just do it."* → `{escalationLadder:['direct','chain'], maxOutreachPerCampaign:5, batchSize:5, approvalMode:'auto_apply'}`.

---

## Domain model (new tables)

### `reshuffle_campaigns`
One per reschedule request the engine takes on.

- `id`, `businessId`, `requesterId` (customer A), `requesterBookingId` (S_a), `targetSlotStart`/`targetSlotEnd` (S_b), `serviceTypeId`
- `status`: `searching | solution_pending_approval | applying | applied | failed | abandoned`
- `strategy`: current rung of the ladder (`direct|chain|broadcast`)
- `outreachCount` (against `maxOutreachPerCampaign`)
- `createdAt`, `resolvedAt`, `configSnapshot` (jsonb — the `reshuffleConfig` in force when the campaign started, so mid-flight config edits don't corrupt an in-progress solve)

### `reshuffle_offers`
One per "we asked customer X whether they'll take slot Y" — mirrors the waitlist offer lifecycle.

- `id`, `campaignId`, `customerId`, `bookingId` (their current booking), `proposedSlotStart`/`proposedSlotEnd`
- `status`: `probing | accepted | declined | countered | expired`
- `counterSlotStart`/`counterSlotEnd` (nullable — a parsed counter-offer edge)
- `offeredAt`, `offerExpiresAt`

### `reshuffle_proposals`
The assembled solution presented to the owner (the approval gate's persisted state).

- `id`, `campaignId`, `moves` (jsonb: ordered `[{bookingId, fromSlot, toSlot, customerId}]`), `touchedCount`
- `kind`: `exact` (A gets `S_b`) | `better_offer` (A gets an improved slot, decision X2)
- `status`: `pending | amended | rejected | approved | expired | applied` (`amended` = owner tweaked it; re-validation pending)
- `presentedToOwnerAt`, `decidedAt`, `amendedFromId` (nullable — links a tweaked proposal to its predecessor)

> All three reuse the proven waitlist shape (FIFO selection, `offered`/`offerExpiresAt` holds, cascade on expiry). A new idempotent migration `00XX_reshuffle_engine.sql` creates them.

---

## File Structure

- `src/db/schema.ts` — add `reshuffleConfig` jsonb to `businesses`; add `reshuffleCampaigns`, `reshuffleOffers`, `reshuffleProposals` tables + types.
- `src/db/migrations/00XX_reshuffle_engine.sql` — **new**, hand-written idempotent migration.
- `src/shared/skill-types.ts` — *no change* (engine is core-only; skills do not see it).
- `src/domain/reshuffle/types.ts` — **new**, `ReshuffleConfig`, `Move`, `Cycle`, `CampaignState`, defaults + Zod validator for the config.
- `src/domain/reshuffle/solver.ts` — **new**, pure cycle search over the displacement graph. Deterministic, no I/O. Input: vacancy slot, displaced customer, known edges, constraints. Output: shortest valid `Cycle | null`. **Heavily unit-tested.**
- `src/domain/reshuffle/constraints.ts` — **new**, "can customer X's service fit in slot Y?" using the availability spine (hours, duration, provider, existing non-campaign bookings). Pure given a snapshot.
- `src/domain/reshuffle/campaign.ts` — **new**, orchestrates a campaign: pick strategy rung, request outreach, ingest replies, re-run solver, assemble proposal, hand to approval gate. The deterministic brain.
- `src/domain/reshuffle/executor.ts` — **new**, applies an approved cycle **atomically** (single transaction, `FOR UPDATE` on every moved booking). **Cyclic-apply mechanism (decision G-4):** because moves form a cycle, a naïve in-place reassignment can transiently collide with the no-double-book check. Apply in two phases *inside one transaction*: (1) **park** all cycle bookings to a non-colliding sentinel (null/`reshuffling` slot state) so the target slots are momentarily free; (2) **re-place** each into its agreed slot. If the schema enforces booking-vs-booking uniqueness at the DB level, that constraint must be **`DEFERRABLE INITIALLY DEFERRED`** (checked at commit, not per-statement) — the migration adds/alters it accordingly. Re-validate the full plan at the top of the transaction; on any failure roll back → campaign `failed`, zero partial writes. Mirror to Google via the existing write-through *after* commit.
- `src/domain/reshuffle/outreach.ts` — **new**, message composition + reply parsing seam. Phrasing via `generateProactiveCustomerMessage`; reply → typed `{verdict:'yes'|'no'|'counter', counterSlot?}` via a constrained LLM parse (sanitised, never raw codes — CLAUDE.md principle 1).
- `src/workers/reshuffle-campaign.ts` — **new**, BullMQ worker driving outreach waves, TTL expiry, and ladder escalation (sibling of `waitlist.ts`); respects `quietHours`, `batchSize`, `maxOutreachPerCampaign`.
- `src/domain/flows/customer-booking.ts` — when a reschedule target is unavailable *and* `reshuffleConfig.enabled`, instead of the "here are other openings" dead-end, offer to "try to arrange a swap" and open a campaign. (Hook at the `requestBooking` `!result.ok` branch — the same place that today suggests open slots.)
- `src/adapters/llm/orchestrator.ts` + `src/domain/manager/orchestrator-tools.ts` — add an `approveReshuffle` / `rejectReshuffle` tool surface so the owner decides conversationally; add `reshuffleConfig` to the settings the orchestrator can read/update.
- `src/domain/manager/apply.ts` — deterministic write path for `reshuffleConfig` changes (validate + persist), consistent with other settings.
- Tests: `tests/reshuffle/solver.test.ts` (unit, the core), `tests/reshuffle/constraints.test.ts` (unit), `tests/reshuffle/outreach-parse.test.ts` (unit), `tests/integration/reshuffle-direct-swap.test.ts`, `tests/integration/reshuffle-chain.test.ts`, `tests/integration/reshuffle-executor-atomicity.test.ts`, `tests/integration/reshuffle-approval-gate.test.ts`.

---

## Invariants (must hold; assert in tests)

1. **No write before approval** (when `approvalMode='require_approval'`): until a `reshuffle_proposal` is `approved`, zero booking rows change. The campaign only writes campaign/offer/proposal rows.
2. **Occupancy preserved:** an applied cycle leaves the week with the same number of confirmed bookings it started with (no customer dropped, no slot left newly empty by the rearrangement). The requester ends in `S_b`; everyone else ends in a slot they agreed to.
3. **Atomic apply:** the executor commits all moves or none. A mid-chain failure rolls back fully and marks the campaign `failed` (CLAUDE.md principle 5).
4. **Every move is pre-agreed:** no booking is moved to a slot its owner did not accept (status `accepted`, not expired) within the campaign.
5. **Consent + limits respected:** never message `messagingOptOut` identities; never exceed `maxOutreachPerCampaign`; never message inside `quietHours`; honor the 24h WhatsApp free-form window (template fallback like the waitlist worker).
6. **Cheapest-first:** the solver returns the shortest valid cycle; the campaign tries ladder rungs in order and stops at the first complete solution.
7. **Deterministic core:** the LLM only phrases outbound and classifies inbound; the solver, constraints, executor, and all writes contain no LLM calls.
8. **Config snapshot isolation:** a campaign uses `configSnapshot` taken at start; editing `reshuffleConfig` mid-campaign does not retroactively change an in-flight solve.
9. **Requester-first (decision X2):** no third party is contacted until the requester's own additional options have been gathered and checked against existing openings. A zero-disturbance answer always pre-empts a campaign.
10. **Never give up while an improvement exists (decision X2):** if the exact slot is unreachable, the engine offers the requester the closest better-than-current slot (when `offerBetterSlotToRequester`); it only reports "couldn't arrange it" when no improvement is reachable, leaving the calendar untouched.
11. **Protected parties never moved involuntarily (decision A4):** the solver never selects a near-term (`<protectWindowHours`), VIP, or recently-rescheduled booking as a mover.
12. **Tweaks are re-validated (decision D3):** an owner amendment is re-run through the solver/validator and its consequences explained before apply; any agreement it invalidates is re-confirmed with the affected customer first.
13. **No transient vacancies (decision G-3):** no booking is released before the atomic apply; the only contendable resource is a genuinely-open slot, which is held with a TTL the moment the engine plans to use it. The plan is re-validated inside the apply transaction.
14. **Cost is a plain count (decision G-1):** among duration-compatible, non-protected movers, the solver minimizes the *number* of people moved; ties break by total preference proximity.
15. **Service-aware fullness (decision G-5):** edges and cycles only form between duration-compatible bookings; a cycle that would open or strand time is rejected.
16. **Termination (decision G-6):** every campaign reaches exactly one of solved / exhausted / abandoned; it never hangs and never declares insoluble while a rung is untried or an offer is open.

---

## Acceptance scenarios (the bulletproofing suite)

The north star for every scenario: **if a clean solution isn't reached, the calendar ends exactly as it started and every disturbed customer gets closure.** Legend: 🔴 do-no-harm safety · 🟡 correctness · ⭐ capstone. Status: ✅ already covered by shipping tests · ⏳ engine-dependent (build TDD target).

### A — Solver geometry
- **A1** Direct 2-cycle (the motivating scenario) → 2 people touched. 🟡 ⏳
- **A2** Forced 3-cycle (no 2-cycle) → shortest valid chain, nobody dropped. 🟡 ⏳
- **A3** Insoluble full week → zero moves, requester keeps slot, soft-retract to anyone messaged. 🔴 ⏳
- **A4** Two solutions exist → pick the cheapest (fewest *weighted* people). 🟡 ⏳
- **A5** Partial space — a free adjacent slot the requester accepts → offer it, **never** start a disturb-others campaign. 🔴 ⏳ *(now also enforced upstream by the requester-first probe, step 0)*

### B — Concurrency *(see "No transient vacancies": only genuinely-open slots can be contended)*
- **B1** Mutual swap (A wants B's slot, B wants A's) → reciprocal-request check (step 0.5) proposes one swap satisfying both. 🟡 ⏳
- **B2** Two campaigns plan to use the *same open slot* → hold/lock on that slot, FIFO; the other re-solves/fails. 🔴 ⏳
- **B3** A planned-on *open* slot gets booked first → re-validate and re-solve; never apply a stale plan. 🔴 ⏳

### C — Human messiness
- **C1** Silence past TTL → escalate then fail cleanly. 🟡 ⏳
- **C2** Counter-offer → followed as a chain edge. 🟡 ⏳
- **C3** Ambiguous reply ("maybe") → never counted as acceptance. 🔴 ⏳
- **C4** Opted-out pivot → skipped entirely, never messaged. 🔴 ⏳
- **C5** Yes-then-changed-mind before approval → caught at re-validation. 🔴 ⏳
- **C6** Double-yes on one slot → first wins, other gets graceful close. 🔴 ⏳

### D — Owner gate
- **D1** Owner ignores → proposal/offers TTL, campaign abandoned, nobody moved. 🔴 ⏳
- **D2** Owner rejects → zero changes, soft-retract to messaged customers. 🔴 ⏳
- **D3** Owner tweaks → re-validated, consequences explained, re-consent if needed. 🟡 ⏳
- **D4** auto_apply → applies first valid solution, notifies after. 🟡 ⏳
- **D5** Stale approval (mover cancelled meanwhile) → apply blocked, owner re-notified. 🔴 ⏳

### E — Apply / atomicity
- **E1** Mid-chain DB failure → full rollback, zero partial writes, campaign `failed`. 🔴 ⏳
- **E2** Google mirror fails post-commit → internal stays SoT, reconcile/retry, no visible double-book. 🟡 ⏳
- **E3** DST inside the week/chain → times stay correct. 🟡 ⏳

### F — Time pressure & abuse
- **F1** Same-day, slot in 2h → minimum-viable-lead-time guard; quiet hours. 🟡 ⏳
- **F2** Imminent/started session → never offered, never disturbed (protect window). 🔴 ⏳
- **F3** Serial gamer → per-requester/per-week campaign rate limit. 🟡 ⏳
- **F4** Requester bails mid-campaign → abort, release holds, soft-retract. 🔴 ⏳

### G — Model edges
- **G1** Group-class target (capacity > 1) → fullness = capacity reached. 🟡 ⏳
- **G2** Multi-booking requester reschedule → operates on the right booking, deferred cancel. 🔴 **✅ landed**
- **G3** Service/duration mismatch → fullness is service-aware, not slot-count. 🟡 ⏳

### X — Capstones (more extreme than the tested scenario)
- **X1** Chain-of-last-resort under pressure: full week + no 2-cycle (forced 3-cycle) + same-day + an opted-out node in the obvious chain + owner on auto_apply + a competing booking lands on the vacated slot mid-apply. Correct: a fully-validated alternate chain commits atomically, **or** the whole thing aborts untouched — no partial state, no opted-out customer messaged, no double-book. ⭐🔴 ⏳
- **X2** Best-effort, not exact: no solution gives A exactly the requested slot, but a rotation gives A a *better* slot while keeping the week full → engine offers it ("closest I can do is Tuesday 16:00 — want it?"), never silently fails. ⭐🟡 ⏳

> Every ⏳ scenario above maps to a unit (solver/constraints/parse) or integration test created during the corresponding build task below. A scenario is "done" only when its test is green and invariants 1–12 hold.

---

## Task 1: Config + schema

- [ ] Add `reshuffleConfig` jsonb (nullable) to `businesses`; define `ReshuffleConfig` type + Zod validator + `DEFAULT_RESHUFFLE_CONFIG` in `src/domain/reshuffle/types.ts`. A `null` column resolves to defaults via a single `resolveReshuffleConfig(business)` reader (one-reader-per-fact discipline).
- [ ] Add `reshuffle_campaigns`, `reshuffle_offers`, `reshuffle_proposals` tables + types to `schema.ts`.
- [ ] **Protected-party data (decision A4):** add a `vip` boolean to `identities` (default false); determine "recently rescheduled" from the existing reschedule audit trail / `bookings` history (a moved booking carries `rescheduledFrom` lineage) rather than a new column where possible. Expose a single `isProtectedFromMove(booking, config, now)` reader.
- [ ] Write idempotent migration `00XX_reshuffle_engine.sql` (tables + `identities.vip` + make any booking-vs-booking uniqueness constraint `DEFERRABLE INITIALLY DEFERRED` for cyclic apply — decision G-4); apply to local test DB.
- [ ] Wire `reshuffleConfig` validate+write into `apply.ts` and expose via `manageBusinessSettings` (incl. the protect/VIP knobs so the owner sets them conversationally, e.g. "don't touch anyone within 4 hours of their slot").
- Gates green.

## Task 2: Solver (pure) — the heart

- [ ] Implement `solver.ts`: shortest-cycle search seeded by the vacancy slot, bounded by `maxChainLength`, over a supplied edge set + constraint predicate. **Cost = plain count of movers (decision G-1)**; ties break by total preference proximity. **Edges only between duration-compatible bookings (decision G-5).**
- [ ] **Protected-party exclusion (decision A4):** the displaced/mover candidate set excludes near-term (`<protectWindowHours`), VIP, and recently-rescheduled bookings. A protected node is a chain dead end.
- [ ] **Best-effort goal (decision X2):** when no exact-`S_b` solution exists, the solver also searches for the closest *better-than-current* slot for the requester (`kind:'better_offer'`), ranked by proximity to the requester's stated preference.
- [ ] `constraints.ts`: `canFit(customerService, slot, snapshot)` against the availability spine.
- [ ] `tests/reshuffle/solver.test.ts` — encodes **A1, A2, A3, A4** + protected-party exclusion (**F2**) + best-effort (**X2**): 2-cycle found/preferred; 3-cycle when no 2-cycle; `null` (untouched) when nothing within bound; cheapest weighted solution preferred; never returns a cycle that double-books, violates `canFit`, or moves a protected node; returns a `better_offer` when exact is impossible but an improvement exists.
- Gates green. **This task is the highest-value unit-test target — do TDD here.**

## Task 3: Outreach seam (incl. requester-first probe)

- [ ] `outreach.ts`: compose probe/broadcast messages (phrasing via `generateProactiveCustomerMessage`, fallback template); parse replies to `{verdict:'yes'|'no'|'counter', counterSlot?}` (constrained, sanitised). **"maybe"/unclear is never `yes`.**
- [ ] **Requester-first flexibility probe (decision X2, step 0):** before any third-party outreach, ask the requester for additional acceptable times and try them against existing openings (zero-disturbance path).
- [ ] `tests/reshuffle/outreach-parse.test.ts` — encodes **C2, C3**: yes/no/counter parsing incl. Hebrew; ambiguous → no acceptance, no write.
- Gates green.

## Task 4: Campaign orchestrator + worker

- [ ] `campaign.ts` + `src/workers/reshuffle-campaign.ts`: requester-first probe → **reciprocal-request check (decision G-2)** → ladder escalation (`direct→chain→broadcast`), `batchSize` waves, TTL expiry + cascade, `quietHours`/opt-out/`maxOutreachPerCampaign` enforcement, re-run solver as edges arrive, assemble `reshuffle_proposal` on success. Implement the **termination predicate (decision G-6):** solved / exhausted / abandoned.
- [ ] **Concurrency + consent guards:** hold-with-TTL on any planned-on open slot, lock + FIFO on a contended open slot (**B2**), re-validate when a planned-on open slot is taken (**B3**), first-accepted-hold wins (**C6**), opted-out skip (**C4**), serial-requester rate limit (**F3**), requester-bail abort + soft-retract (**F4**), silence→fail (**C1**). *(No locks needed on occupied slots — nothing is released pre-apply, decision G-3.)*
- [ ] `tests/integration/reshuffle-mutual-swap.test.ts` (**B1**): reciprocal request → single 2-way swap proposal.
- [ ] `tests/integration/reshuffle-direct-swap.test.ts` (**A1**); `reshuffle-chain.test.ts` (**A2**); `reshuffle-requester-first.test.ts` (**A5/X2 step 0**); `reshuffle-no-solution.test.ts` (**A3** — untouched + soft-retract); `reshuffle-concurrency.test.ts` (**B2/B3**); `reshuffle-consent.test.ts` (**C4/C6**).
- Gates green.

## Task 5: Approval gate + atomic executor

- [ ] `executor.ts`: apply an approved cycle in one transaction (`FOR UPDATE` on all moved bookings), Google write-through after commit; full rollback on failure.
- [ ] Owner approval surface: `approveReshuffle`/`rejectReshuffle`/**`amendReshuffle`** tools. Amend re-validates + **explains consequences** before apply, re-consents affected customers if an agreement is invalidated (decision D3). Re-validate at apply time to catch stale approvals (**D5**). `auto_apply` path skips the gate and notifies after (**D4**).
- [ ] `tests/integration/reshuffle-approval-gate.test.ts` (**D1/D2**: no change until approved; reject → no change, soft-retract); `reshuffle-owner-tweak.test.ts` (**D3**: amend re-validated + consequence-explained + re-consent); `reshuffle-stale-approval.test.ts` (**D5**); `reshuffle-executor-atomicity.test.ts` (**E1**); `reshuffle-mirror-failure.test.ts` (**E2**).
- Gates green.

## Task 6: Customer-flow entry + owner UX polish

- [ ] Hook the unavailable-target branch in `customer-booking.ts`: first run the requester-first probe; only then offer "shall I try to arrange a swap?" when `enabled`. Opening a campaign keeps the requester's original booking intact (deferred-cancel already guarantees this) until a solution applies.
- [ ] Owner-facing summaries: how many contacted, the proposed moves (+ whether `exact` or `better_offer`), approve/reject/tweak; post-apply confirmation to all moved customers.
- [ ] Same-day lead-time guard (**F1**); DST correctness across chains (**E3**); group-class fullness (**G1**) and service-aware fullness (**G3**).
- [ ] Update `ARCHITECTURE.md` (Branch 3/4 interplay) and `ROADMAP.md`.
- Gates green.

---

## Out of scope (explicitly)

- Multi-provider / multi-resource studios: v1 assumes the single-owner model in the scenario. The solver generalizes, but constraint modeling for multiple providers is a follow-on.
- Monetary incentives for switching (e.g. discount to whoever moves). Hook left in `reshuffleConfig` for later (`incentive` key reserved).
- Cross-week solutions (moving someone into a different week). v1 keeps the search within the requested week to bound disruption.
- Degenerate reschedule-to-same-slot: handled upstream by the booking engine (own-booking conflict) — the engine should short-circuit "move to identical slot" as a no-op before opening a campaign.
