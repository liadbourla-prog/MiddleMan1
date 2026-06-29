# Implementation Plan — Unified Anti-Fabrication Gate

**Status:** ready to execute on owner go-ahead. Executable companion to `docs/superpowers/specs/2026-06-29-unified-anti-fabrication-gate-design.md` (approved 2026-06-29).
**Goal:** one per-turn truth ledger + one gate over checkable claims, run at all three output doors — closing the audit's 20 holes and unknown-future ones by construction, without making the PA cagey, over-pinging the owner, or degrading the chat voice.
**Owner decisions baked in:** proactive seam **enforces time+action, monitors the rest**; relay **throttle built now, numbers tuned later**; gate fallbacks are **voice-quality**; the owner-question relay is **non-blocking**.

**Tech/test:** TS (ESM, `.js` specifiers), Drizzle/Postgres, Vitest. single file `npx vitest run <path>`; full `npx vitest run`; types `npx tsc --noEmit`; CI lint is `eslint src/skills/**` only — `src/domain` is not CI-linted, so run `npx eslint <file>` informationally on touched files. Hand-author idempotent migrations (`IF NOT EXISTS`), NEVER `drizzle-kit generate` (stale journal — §0052 lesson).

---

## DO-NOT-REGRESS (every task keeps these green)
**G1** available-class booking never wrongly rejected · **G4** day/time resolution (label==date) · **G5** no-invention · **C-PIVOT** mid-flow pivot. Plus the three shipped symptom suites (S1/S2/S3) and the full suite (currently **1389**). Each commit states "G1/G4/G5/C-PIVOT green" with evidence.

## VOICE GATE (owner constraint #3a — mandatory on every reply-path change)
Any task touching a `*_FALLBACK`, a `situation:` string, a corrective regeneration, or an i18n template must keep the reply at `CHAT_LEVEL_LAWBOOK` standard (first-person, warm, one question, a next step, no IVR/menu, no grovel, no bilingual leak) **and** add/update a golden-transcript shape assertion. A fabrication fix that ships a robotic reply is a regression.

## NON-BLOCKING INVARIANT (owner constraint #3b)
No task may introduce a session state that stalls the customer while a question is pending with the owner. A `pending_owner_questions` row is DB state only — there is **no** `awaitingConfirmationFor:'owner_question'`. A test asserts the customer can book/ask normally with an open question outstanding.

---

## EXECUTION MODEL (subagent-driven, hot-file-serialized)

**Hot files (SINGLE-WRITER — never two agents at once):** `customer-booking.ts`, `orchestrator.ts`, `client.ts`. Shared detectors `slot-fabrication-guard.ts` / `reply-guard.ts` are pure (safe to read everywhere; serialize *writes*).

**Parallelism graph:**
```
Phase 0  (serial spine, one agent)         → turn-ledger.ts(new), output-gate.ts(new), customer-booking.ts, *_FALLBACK strings
Phase 1  (Branch 3)                         → orchestrator.ts, reply-guard.ts        [HOT: orchestrator.ts — serialize T1.1→T1.2→T1.3]
Phase 2a proactive  (parallel w/ Phase 1)   → client.ts(generateProactiveCustomerMessage), worker call sites
Phase 2b grounding  (after Phase 0)         → customer-booking.ts, db select          [HOT: customer-booking.ts]
Phase 2c throttle   (parallel)              → escalation/engine.ts, customer-booking.ts(sentinel wiring) [coordinate 2b/2c on customer-booking.ts]
Phase 3  (last)                             → voice-guard.ts, cross-seam invariant test
```
**Safe-parallel:** Phase 0 alone first (it's the spine). Then `{Phase 1 ‖ Phase 2a}` (disjoint: `orchestrator.ts` vs `client.ts`). Phase 2b/2c serialize on `customer-booking.ts` after Phase 0. Phase 3 last.

**Per-task contract:** (1) write failing test, (2) red, (3) implement, (4) green + `tsc` + targeted lint, (5) DO-NOT-REGRESS checks, (6) VOICE GATE if applicable, (7) commit. Report red→green + regression + voice evidence.

**Merge gate:** `/code-review ultra` per phase sub-branch before merge — focus: the gate↔ledger contract, no regen oscillation, the no-bypass invariant, Branch-3 allowlist completeness.

---

## PHASE 0 — Foundation (the spine; no behavior change; full suite must stay green)

- [ ] **T0.1 — `TurnLedger` type + branch-agnostic builder.** New `src/domain/grounding/turn-ledger.ts`: `TurnLedger { allowedTimes:Set<string>; occupancySpine; backedActions:Set<ActionClaim>; businessFacts:string; calendarConnected:boolean }` + `buildTurnLedger(...)`. **Lift `buildAllowedTimes` assembly out of `customer-booking.ts`** into this builder (Branch-4 keeps calling it via the ledger). TEST-FIRST: the lifted allowlist is byte-identical to today's for a fixture turn (characterization). Commit: `feat(grounding): TurnLedger + branch-agnostic builder (lifts buildAllowedTimes)`.
- [ ] **T0.2 — Unified gate module wrapping the existing pure detectors.** New `src/domain/grounding/output-gate.ts`: `gateReply(reply, ledger, opts) → { reply, interventions }` running booking/time/occupancy/action detectors (imported from `slot-fabrication-guard.ts` + `reply-guard.ts`, unchanged) against the ledger, with regenerate-once + safe fallback. TEST-FIRST: reproduces Gate 1/2/3 verdicts exactly on the existing `slot-fabrication-guard`/`customer-booking` fixtures (golden parity). Commit: `feat(grounding): unified output gate over the pure detectors (parity with Gates 1-3)`.
- [ ] **T0.3 — Migrate Branch-4 `makeGenReply` onto the ledger+gate.** Replace the four closure args with the `TurnLedger`; `makeGenReply` calls `gateReply`. **Pure refactor — full suite identical.** The 53 call sites unchanged (ledger stays closed-over). TEST-FIRST: existing customer-booking + slot-fabrication + voice-golden suites stay green unchanged; add a "makeGenReply delegates to gateReply" invariant. Commit: `refactor(branch4): makeGenReply consumes TurnLedger + unified gate (no behavior change)`.
- [ ] **T0.4 — Voice-quality fallbacks (owner #3a).** Rewrite `FABRICATED_TIME_FALLBACK` / `OCCUPANCY_FALLBACK` / `BOOKING_NOT_CONFIRMED_FALLBACK` / `SAFE_AUDIT_FALLBACK` from terse-safe to on-brand (warm, a next step), He+En. Run the voice golden set + `detectBotTells` on each. TEST-FIRST: each fallback passes the voice detectors and carries a forward step; still asserts nothing false. **VOICE GATE.** Commit: `fix(voice): gate fallbacks meet the chat-UI bar — honest is never robotic (#3a)`.

**Phase 0 → 1 gate:** full suite green + `tsc`; the gate parity test proves no behavior change; the fallbacks pass the golden set.

---

## PHASE 1 — Close H1 (CRITICAL) + extend backed-actions (Branch 3)
*File: `orchestrator.ts` (HOT — serialize T1.1→T1.2→T1.3), `reply-guard.ts`.*

- [ ] **T1.1 — Branch-3 allowlist accumulator.** In the tool loop, capture times returned by `executeListCalendarEvents` (`freeSlots`/`buildScheduleView`) and `getSessionRoster` into a per-turn `allowedTimes` set (mirrors how `succeededActions` accumulates via `actionsFromToolResult`). Also admit owner-message-quoted times this turn (mirror Branch-4 `extractMentionedTimes`) so a legitimately-referenced time isn't a false positive (design §8.2). TEST-FIRST: a turn that ran `check_free_slots` populates the allowlist with those exact times. Commit: `feat(branch3): per-turn allowlist accumulator from availability tool results (H1 prep)`.
- [ ] **T1.2 — Port time + occupancy gate into `auditReplyClaims` (closes H1).** Add `findUnbackedTimes` + `assertsNoAvailability` (drop-in import — both pure) to `auditReplyClaims`, fed by T1.1's allowlist + a `listDayOptions` spine read; regenerate-once → voice-quality fallback. TEST-FIRST: a manager-facing "Tuesday 14:00 is free" with no backing time is caught; "you're fully booked Wednesday" with open spine is corrected; a backed time passes. **VOICE GATE.** Commit: `fix(branch3): availability gate — time + occupancy claims verified (H1, CRITICAL)`.
- [ ] **T1.3 — Extend backed-action classes; `partial`≠backed.** Map the missing tools in `actionsFromToolResult` (refund, broadcast, settings-edit, `coordinateMeeting`, `resolveMeetingCoordination`) to new `ActionClaim`s; add matching `detectActionClaims` patterns. **`{partial:true}` must NOT add the backing** (H4); a `confirm` coordination outcome maps to `booking_made` (H16). TEST-FIRST per class: a fabricated "refunded ₪300" after `ok:false`, "texted Harel" on `partial:true`, "set the price" after `clarificationNeeded`, "he confirmed Tuesday" with no counterparty read — each caught; each real success passes. Commit: `fix(branch3): backed-action coverage for refund/broadcast/settings/coordination; partial≠backed (H4/H5/H9/H10/H11/H16/H20)`.

**Phase 1 → 2 gate:** full suite green; the Branch-3 availability + action gates demonstrably catch the H1/H4/H5/H9-11/H16/H20 repros.

---

## PHASE 2 — Proactive seam + Tier-2 grounding + relay throttle
*2a `client.ts` (parallel w/ Phase 1) · 2b `customer-booking.ts` (after Phase 0) · 2c `escalation/engine.ts` (+ sentinel wiring, coordinate with 2b on customer-booking.ts).*

- [ ] **T2a.1 — Gate the proactive seam (enforce time+action, monitor rest).** Wrap `generateProactiveCustomerMessage`: callers pass available truth (situation already; add optional `allowedTimes`/`backedActions`); run the gate — **enforce** time + action (on fail, return the caller's `fallback` template), **monitor-log** the softer classes (owner decision). TEST-FIRST: a fabricated waitlist time / "I'm holding it" with no real hold swaps to the template; a "customers have been notified" with unverified sends is logged; the `dunning.ts` payUrl precedent still holds. Commit: `fix(proactive): gate the universal worker/initiation send — enforce time+action, monitor rest (H3/H8/H12/H18)`.
- [ ] **T2a.2 — Waitlist offer truth (H3 outbound).** The "spot opened — I'm holding it" send re-validates the slot fresh-spine before the message and **does not claim a hold unless one exists** (re-word to honest "want it? first to reply gets it" if no hold, OR place a real hold — owner decision at build). TEST-FIRST: a retaken slot does not produce "I'm holding it for you". Commit: `fix(waitlist): offer message re-validated + no fabricated hold (H3/H18)`.
- [ ] **T2b.1 — Inject `service_types.narrative` into grounding (shrinks the doesn't-know gap).** Add `narrative` to the active-services select (`customer-booking.ts:1050`) and surface it closed-world in `buildBusinessFacts`; unify with the Branch-3 `buildActiveServicesBlock` facts. TEST-FIRST: an owner-authored "apparatus pilates uses reformers" narrative is answerable without `[[ASK_STUDIO]]`; a service with no narrative still triggers the (throttled) relay, not invention. **VOICE GATE.** Commit: `fix(grounding): surface owner-authored service attributes — answer from real facts, not invention (H13/H15)`.
- [ ] **T2b.2 — Sentinel on the default/explanation paths (H15 mid-conversation).** Wire `ASK_STUDIO_INSTRUCTION` + `isAskStudioSentinel` into `case 'system_explanation'` and the `default` path (they pass FAQs today but no escape hatch). The default response to an unbackable Tier-2 claim is **steer to what we offer**, relay only on the deliberate sentinel. **VOICE GATE.** Commit: `fix(branch4): doesn't-know escape on explanation/unknown paths — steer first, relay rarely (H15)`.
- [ ] **T2c.1 — Owner-ping throttle + non-blocking guarantee.** In `escalateCustomerQuestion`, before insert/send: **dedup** (skip if this customer has a `pending` row — uses the existing `(businessId,customerId,status)` index), **substance** (skip social/greeting via `looksLikeGreetingOrSocial`, skip trivially short), **rate** (cap pending/recent per business). Mechanism now; numbers via env (tunable). Assert the relay sets **no session lock**. TEST-FIRST: a rephrased duplicate doesn't re-ping; a greeting never pings; the customer can book while a question is pending. Commit: `fix(relay): owner-ping throttle (dedup/substance/rate) + non-blocking (constraints #2/#3b)`.

**Phase 2 → 3 gate:** full suite green; the proactive gate, narrative grounding, and throttle repros pass; non-blocking invariant test green.

---

## PHASE 3 — Graduate Gate-4 + cross-seam invariants (last)

- [ ] **T3.1 — Gate-4 monitor → enforce (Branch 4).** Feed `hasActionFabrication` from `backedActions`: an action-claim with no backing regenerates once (voice-quality) instead of only logging. Keep the backed escalation hand-off exempt (it's code-produced and backed). TEST-FIRST: an unbacked "I added you to the waitlist" is corrected; a real one passes. **VOICE GATE.** Commit: `fix(voice): Gate 4 enforces unbacked action-claims in Branch 4 (H7)`.
- [ ] **T3.2 — Cross-seam non-bypass invariant.** Test that **no** reply reaches `sendMessage` from any of the three seams without traversing the gate (Branch 4 `makeGenReply`, Branch 3 `auditReplyClaims`, proactive `generateProactiveCustomerMessage`). Commit: `test(grounding): no seam reaches send without the gate (non-bypass invariant)`.
- [ ] **T3.3 — Cross-seam voice golden set.** Golden He+En shape assertions across all three seams **including the gate fallbacks** — the positive quality bar that proves honest replies read like our best chat. Commit: `test(voice): cross-seam golden shape suite incl. gate fallbacks (#3a)`.

---

## COVERAGE LEDGER (every audit hole → the task that closes it)
H1→T1.2 · H2→shipped(F3a)+T2c.1 · H3/H18→T2a.2 · H4/H5/H9/H10/H11/H16/H20→T1.3 · H6→shipped(F2b)→folds into T0.2 · H7→T3.1 · H8/H12→T2a.1 · H13/H15→T2b.1+T2b.2 · H14→shipped(F3b)+T2b.2 · H19→T1.2/Gate-3 focusDay (covered by ledger spine) · **future unknown holes → covered by construction** (an unbacked claim is not in the ledger).

## CROSS-CUTTING
- **New invariant tests (keep):** P-LEDGER "a claim absent from the TurnLedger is gated at every seam"; non-bypass (T3.2); non-blocking (Phase-2 gate).
- **Docs:** update `ANTI_FABRICATION.md` (the gate is now one ledger + one gate at three doors; Gates 1-3 are its detectors) and `CHAT_LEVEL_LAWBOOK.md` (the voice-quality fallback rule).
- **Out of scope:** payments logic; `src/skills/`; Google-mode reconcile (Phase-2 of the master plan).

## SEQUENCING SUMMARY
1. **Phase 0** serial (spine; full suite must stay green — the safety net).
2. **{Phase 1 ‖ Phase 2a}** parallel (disjoint `orchestrator.ts` vs `client.ts`).
3. **Phase 2b → 2c** serial on `customer-booking.ts` (after Phase 0).
4. **Phase 3** last (catches anything introduced).
5. `/code-review ultra` per phase sub-branch before merge; tune throttle numbers during Phase 2/3 testing.
