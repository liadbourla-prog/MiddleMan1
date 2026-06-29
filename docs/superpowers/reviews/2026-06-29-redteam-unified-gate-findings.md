# Red-Team Findings — Unified Anti-Fabrication Gate (design + plan)

**Status:** review complete · **Type:** adversarial red-team (read-only on code; plan edited for the safe items) · **Date:** 2026-06-29 · **Reviewer:** Developer A (red-team pass)
**Targets:** `docs/superpowers/specs/2026-06-29-unified-anti-fabrication-gate-design.md`, `docs/superpowers/plans/2026-06-29-unified-anti-fabrication-gate-plan.md`
**Method:** primed on the full mission chain (handoff → CLAUDE/ARCHITECTURE → master plan → ANTI_FABRICATION → lawbook → 20-hole audit → three-symptom plan), then **spot-checked every load-bearing factual claim against live code** on `dev/system/three-symptom-remediation`. Findings carry `file:line` evidence. Design-level flaws (need owner sign-off) are separated from plan-level fixes (safe to edit).

> **Bottom line:** the core bet — *gate the enumerable, ground+throttle the rest, at one door* — is sound and the audit's factual spine checks out (H1, dropped `narrative`, the 4-class action auditor, the ungated proactive seam are all real). But the plan **over-claims coverage in three places**, **conflates two different "Gate 4" detectors** (the single biggest correctness gap), and the design's **one-ledger abstraction leaks** in exactly the two seams it's being extended to (Branch 3 + proactive), where the "truth list" the gate checks against either doesn't exist or isn't per-turn. None of this sinks the approach; all of it needs to be made explicit before execution or a phase will ship a regression or a false "closed."

---

## What I verified TRUE (the design's research-derived facts hold)

| Design/audit claim | Verdict | Evidence |
|---|---|---|
| Branch 3 has **no** time/occupancy gate; `auditReplyClaims` runs only `detectActionClaims` | **TRUE** | `orchestrator.ts:1019-1061` (audit body) + `:1014` (`unbackedClaims` → `detectActionClaims` only); no `findUnbackedTimes`/`assertsNoAvailability`/`listDayOptions` anywhere in `orchestrator.ts` |
| `service_types.narrative` exists but is dropped from Branch-4 grounding | **TRUE** | column `schema.ts:245`; consumed only in `skills/knowledge-resolver.ts` + `skills/context-builder.ts`; **not** in `buildBusinessFacts` (`customer-booking.ts:885-915`) |
| Action auditor backs only 4 classes; refund/broadcast/coordination unmapped; `manageBusinessSettings`→`cancelled` | **TRUE** | `ActionClaim` = 4 values `reply-guard.ts:61`; `actionsFromToolResult` switch `orchestrator.ts:970-998` (no refund/broadcast/coordination cases; settings→`['cancelled']` at `:994`) |
| `makeGenReply` is the Branch-4 chokepoint; 53 `genReply(` call sites; ledger can stay closed-over | **TRUE** (53 confirmed) | `customer-booking.ts:781`; `grep -c genReply(` = 53 |
| Gate 4 (`hasActionFabrication`) is **monitor-only** | **TRUE** | `voice-guard.ts:177` (detector), called in `observeVoiceTells:241` which **returns the draft byte-for-byte** (`:254`); regen behind `VOICE_REGEN_ENABLED` (OFF) |
| `generateProactiveCustomerMessage` runs **no** gate; ~30 call sites | **TRUE** | `client.ts:1274-1297` (situation→LLM→`fallback`, no checks); 29 non-test call sites |
| `pending_owner_questions` supports the throttle's dedup (per business+customer+status) | **TRUE** | index `pending_owner_questions_customer_idx` on `(businessId, customerId, status)` `schema.ts:1119` |
| `[[ASK_STUDIO]]` is wired only on the inquiry path, not explanation/default (T2b.2 premise) | **TRUE** | `ASK_STUDIO_INSTRUCTION` appended only at `customer-booking.ts:1481`; `isAskStudioSentinel` checked only at `:1499`; `case 'system_explanation'` at `:1506` has neither |

So the audit is trustworthy as a yardstick. The problems are in how the **plan maps fixes to holes** and how the **design models the truth-list at the new seams**.

---

## DESIGN-LEVEL FLAWS (need owner sign-off — surfaced, not silently changed)

### D1 — `TurnLedger.allowedTimes` is modeled as one per-turn set, but the Branch-4 allowlist is per-CALL. (HIGH — pressure-tests the core bet + risks a Phase-0 regression)
The design (§3.1) defines `allowedTimes: Set<HH:MM>` as a single per-turn field the core fills *before any reply is generated*. But today's allowlist is assembled **inside the gate, from the per-call `input`**:
```
buildAllowedTimes(input, timeGuard):  // customer-booking.ts:759-768
  boundaryTimes ∪ bookingTimes        // per-turn (fine to precompute)
  ∪ extractClockTimes(input.situation) // PER-CALL — the situation differs across the 53 call sites
  ∪ customer-raised times from input.transcript
```
The boundary/booking halves are per-turn; the **situation- and transcript-derived halves are per-call** (each of the 53 `genReply` sites passes a different `situation`, and the in-gate corrective regenerations at `:800/:812/:842/:863` re-inject yet another). If an executor takes the design's "single per-turn `allowedTimes`" literally and precomputes it once, every call site whose situation surfaces a legitimately-offered time that isn't in the precomputed set will **false-positive → fall back to `FABRICATED_TIME_FALLBACK`** — a G1/G5-adjacent regression, and exactly the "no behavior change" Phase-0 is supposed to guarantee.
**This is the load-bearing seam of the whole "one truth-list" thesis.** The honest model is: the ledger holds the *per-turn* facts (boundary/booking/backedActions/occupancy spine), and the gate **still merges the per-call `situation`/customer-raised times at gate time**. The plan's T0.1 ("Branch-4 keeps calling `buildAllowedTimes` via the ledger") is salvageable, but the **design's data model in §3.1 must say `allowedTimes` is per-turn-base ∪ per-call-situation**, or the abstraction misleads the executor. *Recommend: amend §3.1 to split `allowedTimes` into `ledger.baseAllowedTimes` (per-turn) and an explicit "merge situation+customer-raised at gate time" note.*

### D2 — The Branch-3 + proactive time-gate has a weaker truth source than §8.2 implies (and an English am/pm blind spot). (MEDIUM)
Design §8.2 says "structured times exist transiently in the executors." In fact the tool **results** already carry recoverable 24h times: `freeSlots[].start` and `buildScheduleView` events are `en-GB`/`he-IL`, `hour:'2-digit'` → `"Tue, 3 Jun, 14:00"` (`orchestrator-tools.ts:273-274, 175-176, 236`), so `extractClockTimes` *can* pull `14:00` from the result string — capture is feasible (good news; T1.1 is workable). **But two real gaps remain:** (a) per `CHAT_LEVEL_LAWBOOK §3.3`, English manager replies are *authored* in 12h am/pm (`"2:00 PM"`), and `findUnbackedTimes`/`extractClockTimes` are **24h-only** (`ANTI_FABRICATION §10`) — so an English Branch-3 reply's fabricated `"2 PM"` is never extracted, never checked → **the ported Gate 2 silently no-ops for English managers**; (b) the proactive seam has *no* time source at all (see D3). The live business is Hebrew/24h so (a) is *latent*, but it's a real hole the plan's "H1 closed" should acknowledge, not inherit silently.

### D3 — Proactive "enforce time + action" has no truth source at ~all 29 worker sites; the gate there is inert-or-overfires. (HIGH — conflation in the core bet)
The design (§3.3 Seam C) and plan (T2a.1) say "enforce time + action" on `generateProactiveCustomerMessage`. But the signature carries only `{businessName, language, situation, fallback, timeoutMs}` (`client.ts:1274-1280`) — **no `allowedTimes`, no `backedActions`** — and the 29 callers pass a free-text `situation` + a `fallback` template, not a structured truth set. So "enforce time" at this seam is one of:
- **inert** — `allowedTimes` empty/absent ⇒ nothing to check ⇒ false sense of coverage, or
- **over-fires** — any clock time in the proactive message is "unbacked" ⇒ swap to template on *every* time-bearing worker send ⇒ degrades voice (violates constraint #3) and defeats the warm waitlist offer the lawbook wants (`§10 "Good news / waitlist"`).
The **real** protection for the waitlist holes (H3/H18) is **fresh-spine re-validation before send** (plan T2a.2), which is independent of the gate. The design conflates "route the proactive seam through a gate" (correct, valuable for the *action/monitor* classes and as a structural chokepoint) with "the gate can verify time there" (it can't, without each worker building an allowlist). *Recommend: the design state plainly that proactive **time** enforcement applies only where a caller supplies a structured `allowedTimes` (today: none → the waitlist offer relies on T2a.2's re-validate, not the gate), and that the seam's day-one value is the **action** check + the chokepoint, not time.*

### D4 — Branch-3 occupancy gate needs a `(day, service)` focus the free-form orchestrator doesn't deterministically have. (MEDIUM-HIGH)
Gate 3 in Branch 4 works because the *handler* threads a deterministic `focusDay {dateStr, serviceTypeId?}` from the resolved intent (`customer-booking.ts:839, 1496, 2231, 2356`). Branch 3 is a Gemini tool loop with no resolved-intent focus day — when the manager asks "is Wednesday full?", the gate has no deterministic `(date, serviceTypeId)` to feed `listDayOptions`. Plan T1.2 says the occupancy detector is "fed by … a `listDayOptions` spine read" but **never says how the focus day/service is derived** in a free-form loop. Options exist (reuse `getSessionRoster`/`listCalendarEvents` args captured this turn; parse the manager's date pieces via the same `toDateParts` the tools use), but the mechanism is unspecified and is the hard part of porting Gate 3. Without it, the Branch-3 occupancy leg is either un-fireable or guesses the day.

### D5 — The Tier-1 table promises entity (service/price/instructor) gating that §8.5 defers and the plan never builds. (MEDIUM — internal over-promise)
Design §4's Tier-1 row lists "entity (service/price/instructor)" as gated "at all 3 seams," but §8.5 explicitly defers entity gating to a fast-follow, and the plan contains **no entity-gate task**. Named-entity invention (a service/price not in the closed-world list) is today blocked by *grounding* only (`buildBusinessFacts`), with no output gate. That's defensible — but it means the design's "future unknown holes covered by construction" claim does **not** extend to invented entities (a new fake service name is conversational glue to the time/occupancy/action detectors and sails through). Either build the entity gate or drop it from the Tier-1 "gated everywhere" table so the coverage story is honest.

### D6 — No cross-gate / cross-seam regeneration cap or per-turn deadline — a constraint the master plan explicitly imposed and this design dropped. (HIGH)
The hardening master plan's §v2 WS-VOICE correction is unambiguous: *"cap total regenerations across ALL gates and unify the per-turn deadline with WS5 so the 60s identity-lock TTL can't expire mid-turn (voice regen is a 4th on top of three fabrication regens)."* The unified design **adds** a seam and **graduates Gate 4 to enforce**, i.e. up to **four** sequential regenerate-once LLM round-trips in one Branch-4 turn (booking → time → occupancy → action), each a full `generateCustomerReply`, all inside `withIdentityLock` (60s TTL, `ANTI_FABRICATION §9`). The design has **no regen budget, no convergence/oscillation guard** (a time-regen can introduce an occupancy lie and vice-versa; gates run once each, in sequence, with no re-check). The plan's merge gate name-drops "no regen oscillation" but nothing in the tasks designs for it. This is a latency + lock-expiry + correctness risk that was already paid for once in the master plan and must be re-inherited.

---

## PLAN-LEVEL FIXES (safe — applied to the plan in this pass; see the diff)

### P1 — T3.1 conflates two different "Gate 4" detectors; the real H7 fix is missing. (HIGH — the single biggest correctness gap)
`T3.1` says *"Feed `hasActionFabrication` from `backedActions` … an unbacked 'I added you to the waitlist' is corrected."* This is internally impossible as written:
- `hasActionFabrication` detects **check/ask/get-back-to-you phrasing** (`voice-guard.ts:170-176`) — it has **no `backedActions` correspondence** (those phrasings are only ever produced by *code templates that bypass the gate*, which is exactly why it's a phrasing-only monitor — see the NOTE at `voice-guard.ts:201-205`). "Feeding it from `backedActions`" is a category error.
- `"I added you to the waitlist"` / `"I cancelled your class"` are **`detectActionClaims` classes**, and (a) `detectActionClaims` has **no waitlist class** (`reply-guard.ts:61, 102-110` — only booking/message/calendar/cancelled), and (b) `detectActionClaims` is **not wired into Branch-4 `makeGenReply` at all** (grep: zero usages in `customer-booking.ts`), and (c) Branch 4 has **no `backedActions` set** — only the single `opts.bookingConfirmed` boolean.

So **H7 (the audit's "Branch 4 has no action-claim gate beyond booking-made") is NOT closed by T3.1 as written.** The coverage ledger's `H7→T3.1` is overclaimed.
**Fix (applied):** split T3.1 into **(a)** graduate `hasActionFabrication` (check/ask phrasing) from monitor→enforce — *no backing needed, the phrasing is code-template-only*; and **(b) NEW task**: wire `detectActionClaims` into `makeGenReply` + add a **new `waitlist_added` `ActionClaim`** + build a **Branch-4 `backedActions` set** threaded from the cancel/waitlist/message call sites. (b) is the actual H7 fix and is non-trivial — it must not be smuggled into a one-line "graduate the monitor."

### P2 — T0.2 "runs booking/time/occupancy/action detectors" contradicts "reproduces Gate 1/2/3 exactly / no behavior change." (MEDIUM)
Branch 4 today enforces only Gate 1/2/3 (booking/time/occupancy). The action detector is **monitor-only** (`observeVoiceTells`). If Phase-0's `gateReply` *enforces* an action detector, that's a **behavior change** in the supposed no-behavior-change spine. **Fix (applied):** T0.2 enforces only booking/time/occupancy at parity in Phase 0; the action class stays monitor-only until T3.1(a)/(b).

### P3 — Coverage-ledger honesty: three over-claims + one mis-branch. (MEDIUM)
- `H8/H12 → T2a.1` reads as "closed," but T2a.1 **monitors** the softer classes (owner decision) — H8 (`pa_paused_customer` promise) and H12 ("customers have been notified") are *observed, not closed*. Mark them **monitored**.
- `H19 → T1.2` points at the **wrong branch**: H19 is a **Branch-4** unscoped-inquiry hole (no `focusDay` ⇒ Gate-3 signal-a never runs, `customer-booking.ts:1320-1336`); T1.2 is the **Branch-3** port. The fix is "thread a `focusDay` onto unscoped Branch-4 inquiries" — a `customer-booking.ts` change with no task today.
- `H7 → T3.1` — see P1.
- `H14 → T2b.2` is thin: T2b.2 wires `[[ASK_STUDIO]]` into explanation/default; H14 is the **bundled post-confirm side-question** path (`customer-booking.ts:2493`), a different seam (the master plan's T3.6 territory). Flag as partial.

### P4 — T1.1 must specify the capture point + acknowledge the am/pm latent gap. (MEDIUM)
T1.1 says capture "those exact times" from `freeSlots`/`buildScheduleView`. Spell it out: capture via `extractClockTimes` over the result strings (they're 24h `en-GB`/`he-IL`, so this works), and **note the latent gap**: English manager *replies* in 12h am/pm are not extracted by the 24h gate (D2) — so H1's time leg is "closed for Hebrew/24h; am/pm is a known follow-up," not "closed."

### P5 — T2c.1 dedup must specify the customer reply on a *suppressed re-ask* (constraint #3b / soft-spot #5). (MEDIUM)
Dedup "skip if this customer has a `pending` row" stops the re-ping — good — but the plan doesn't say what the customer *hears* when they re-ask the same pending question. If the model again emits `[[ASK_STUDIO]]` and the relay is suppressed, the honest reply must be **"still waiting to hear back from the studio on that"**, not a fresh **"I don't have that info"** (which reads as the PA forgetting it already escalated — a trust regression, and a soft re-open of the S3 symptom in spirit). **Fix (applied):** T2c.1 acceptance now requires the suppressed-re-ask reply to reference the open thread, and a test for it.

### P6 — Carry forward the unified regen-cap + per-turn deadline (ties to D6). (MEDIUM)
Add a cross-cutting task: a single per-turn regeneration budget + deadline shared across all enforced gates and all three seams (inherit the master-plan §v2 WS-VOICE rule), so Gate-4 enforce + the three fact gates can't stack four LLM round-trips past the 60s identity-lock TTL, and a later-gate regen can't silently re-introduce an earlier-gate lie without a re-check.

### P7 — The open merge decision: recommend **merge-first**, and don't forget migration 0052 on deploy. (process)
The 11 commits are a coherent, green (1389), self-contained symptom fix that the unified plan *consumes* as its first detectors. Building 4 more phases on top **without merging** creates a long-lived branch diverging from `main` across all three hot files (`customer-booking.ts`, `orchestrator.ts`, `client.ts`) — a big-bang merge and an un-chunkable ultra-review. **Recommend merging the 11 commits to `main` first** (smaller reviewable units; `main` gets the de-risking symptom fixes ahead of first provisioning; the unified Phase 0 then starts clean), honoring the hand-authored idempotent migration `0052_pending_owner_questions.sql` on deploy (never `drizzle-kit generate`). Owner's call — flagged, not executed.

---

## Holes the audit itself may have under-weighted

- **Regeneration stacking / oscillation** (now D6/P6) — the audit catalogs *static* holes (claim×seam) but not the *dynamic* cost of running four enforce-gates in sequence under a lock. This is the most likely way the upgrade *introduces* a regression (timeout/ghost) while closing fabrications.
- **Branch-4 `backedActions` doesn't exist** (now P1) — the audit's H7 names the gap but the plan under-scopes the *capability* it requires (a structured per-turn action ledger in Branch 4, not just a detector). H4/H5/H9-11 in Branch 3 ride on `actionsFromToolResult` which *does* accumulate (`orchestrator.ts:1259`); Branch 4 has no analog.
- **Entity invention** (now D5) — "covered by construction" is the design's strongest claim and it does **not** hold for invented service/price/instructor names without the deferred entity gate.

---

## Verdict & recommended order

The approach is right and worth executing. Before any phase runs:
1. **Owner decisions needed** on D1 (amend the ledger data-model), D3 (proactive time = monitor/where-supplied, not "enforce"), D4 (Branch-3 focus-day mechanism), D5 (build entity gate or drop the claim), D6 (regen budget).
2. **Plan edits applied** for P1–P7 (this pass) — most importantly the **T3.1 split** and the **coverage-ledger honesty pass**.
3. Then execute Phase 0 first (serial spine), with the characterization test covering **all four `makeGenReply` exit paths** (confirm early-return `:796`, the three gate exits, the occupancy-spine early-return `:849`, and the `isSafeFallback` flags), not just one fixture call — that's the only real proof of "no behavior change."
