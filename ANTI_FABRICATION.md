# Anti-Fabrication Doctrine

**Status:** active · **Scope:** all LLM-phrased replies (Branches 3 & 4 today; principles apply everywhere) · **Owner:** Developer A

> The LLM is interpretive only. It extracts intent and phrases sanitized facts. It **never** decides state and must **never** assert a fact the deterministic core did not produce. A *fabrication* is any reply that asserts something — a time, a count, a completed action, an availability state — that the core did not back this turn. Fabrications are the single most dangerous failure mode of this product: they erode trust instantly ("the PA offered me 5pm / told me it's full / said I'm booked" when none was true). This document is the doctrine and the toolkit for killing them, so the same logic can be reapplied to every new fabrication class.

---

## 1. Why fabrications happen (the structural cause)

The system is two layers (see CLAUDE.md "Non-Negotiable Principles"):

- **Deterministic core** — identity → policy → scheduling → calendar validation → safe write. The single source of truth.
- **Interpretive LLM** — turns a *situation string* (sanitized facts the core computed) into human wording.

A fabrication is born when the LLM is given **latitude + raw material**:

- **Latitude:** the reply phrasing is free-form, and nothing checks what it said against what the core knows.
- **Raw material:** the situation (or transcript) contains primitives the model can *interpolate* from — business hours, a class cadence, a capacity number, a confirmation-shaped sentence.

Remove either and the fabrication can't survive. The doctrine therefore has **two complementary levers**, used together:

1. **Source-truth grounding** — don't hand the model raw material it can interpolate from; hand it the *answer*, already computed by the core. (Removes the raw material.)
2. **Output gating** — after the model writes, deterministically verify the claim against the core; regenerate, then fall back. (Removes the latitude.)

Neither alone is sufficient. Grounding reduces how often the gate fires; the gate catches what grounding misses and any new path nobody hardened. **Prompt-only "never invent" instructions are not a lever** — they are a hint the model ignores under pressure, and every historical recurrence of these bugs traces back to relying on one.

---

## 2. The asymmetry that caused the original bug

The core already validated times the **customer proposes** (booking path: `isSlotBookable`, `classInstanceMissing`). Nothing validated times the **PA proposes**. So:

| Path | Customer says | Core validates? | Result |
|---|---|---|---|
| Booking ("book yoga at 17:00") | a specific time | **yes** (input-gated) | correctly refused |
| Inquiry ("what's in the evening?") | nothing specific | **no** (output un-gated) | model invented 17:00/19:00 |

The fix is to make **output gating** universal and **intent-path-agnostic** — one chokepoint every reply passes through — so a future reply path is covered automatically instead of being hardened one at a time (the path-by-path trap that let this bug recur ~10 times).

---

## 3. Taxonomy of fabrications

| Class | Example (real, observed) | Primary lever | Status |
|---|---|---|---|
| **Time fabrication** | offers `17:00`/`19:00` that are blocked / never offered | output gate + grounding | **solved** (§4–5) |
| **Action-claim fabrication** | "I booked you ✅" when nothing was written; "I messaged him" / "calendar connected" / "cancelled" | output gate | **solved** (`reply-guard.ts`) |
| **Occupancy fabrication** | "all Wednesday spots are taken" when ~55 are free; "Monday is completely full" right after listing Mon 11/14/18; **cross-turn laundering** — a stale "Sunday full" recycled from the transcript on a challenge/continuation turn the core never re-grounded | **source-truth** (grounding) **+ output gate** | **solved** — source (§6) + Gate 3 occupancy guard, now a **fresh-spine backstop** + **date-aware** (§4.6) |
| **Service / price fabrication** | invents a service or quotes a price not on record | grounding (`buildBusinessFacts`) | solved (closed-world facts block) |
| **Staff naming** | *(reclassified — not a fabrication)* the PA naming a real, owner-configured instructor when asked | grounding (`buildBusinessFacts` instructor roster) | **roster-grounded** (§5) — real instructors allowed when asked; inventing others still closed-world-blocked |
| **Service-fidelity fabrication** (prior-assistant laundering) | locks the customer's remembered "usual" service (e.g. switches a pilates thread to *yoga*) on an underspecified booking the customer never affirmed | grounding (`customerReferencedService`) | **solved** (§4.2 rule extended to *service*) |

The same two levers address all of them; which lever leads depends on whether the core's *data* was wrong (→ grounding) or only the *phrasing* was wrong (→ gate). See the decision framework in §7.

---

## 4. The output gate (the anti-fabrication mechanism)

### 4.1 Where it lives — one ledger, one gate, three doors

As of the **Unified Anti-Fabrication Gate** (2026-06-30) the mechanism is a single object run at every output door, not a per-branch checker:

- **One per-turn truth ledger** — `TurnLedger` (`src/domain/grounding/turn-ledger.ts`): the deterministic core fills it *before* any reply is gated with everything provably true this turn — `baseAllowedTimes` (the time allowlist base, see §4.2), `occupancySpine` (a fresh-spine reader), `backedActions` (the actions that actually succeeded this turn), `businessFacts`, `calendarConnected`. It is the single source of backing.
- **One gate** — `gateReply(reply, ctx)` (`src/domain/grounding/output-gate.ts`): branch-agnostic; regeneration is injected via `ctx.regen`. It runs the enumerable claim-class detectors against the ledger.
- **Three doors** — every seam that reaches `sendMessage` is gated, but not identically: **Branch 4** `makeGenReply` (`customer-booking.ts`) and **Branch 3** `gateAndAuditBranch3Reply` (`orchestrator.ts`) both run the full `gateReply` (booking/time/occupancy/action + Gate 4 + regen cap + voice monitor); the **proactive** door (`generateProactiveCustomerMessage` → `gateProactiveBody`, `client.ts`) runs a **structurally-analogous but weaker subset** — `detectActionClaims` (enforced where `backedActions` is supplied) + an opt-in time check — with **no** booking/occupancy gate, **no** Gate-4 `hasActionFabrication`, **no** `observeVoiceTells` monitor, and **no** regen. (Locked design D3: workers supply no per-turn ledger, so the proactive door's job is the action check + the structural chokepoint; waitlist time-truthfulness is enforced by fresh-spine re-validation before send, not by the gate.) A cross-seam non-bypass invariant test (`grounding/cross-seam-non-bypass.test.ts`) proves no reply reaches send without traversing its door's gate.

The gates `gateReply` enforces (each: **detect → regenerate once with a corrective → deterministic fallback**; the `opts.bookingConfirmed` early-return exempts a real persisted booking):

- **Gate 1 — phantom booking-claim** (`assertsBookingConfirmed`, `reply-guard.ts`): claims a booking is done when none was written.
- **Gate 2 — fabricated time** (`findUnbackedTimes`, `slot-fabrication-guard.ts`): states a clock time the core never offered (allowlist = ledger base ∪ per-call situation/customer-raised, §4.2).
- **Gate 3 — fabricated unavailability / occupancy** (`assertsNoAvailability` + fresh-spine, §6): claims a day/class is full while the spine has open capacity.
- **Gate 3b — fabricated action-claim** (`detectActionClaims`, `reply-guard.ts`; Branch-4 enforced via `opts.enforceActionClaims`): claims a completed cancel / waitlist-add / message / refund / broadcast / settings-change not in `backedActions`. `booking_made` is excluded (Gate 1 owns it). Branch 3 runs the equivalent in its `auditReplyClaims`.
- **Gate 4 — self-authored action fabrication** (`hasActionFabrication`, `voice-guard.ts`; **enforced** since 2026-06-30): the reply self-authors "I'll check / ask / get back to you / one of our guides will" — phrasings only the LLM produces (honest escalations are code templates that bypass the gate), so unbacked by construction.

```
draft = generateCustomerReply(situation)
if bookingConfirmed: return observe(draft)             // real slot, trusted
if assertsBookingConfirmed(draft): draft = regen(forbid-claim) or BOOKING_NOT_CONFIRMED_FALLBACK
if findUnbackedTimes(draft, allowed): draft = regen(TIME_GUARD_INSTRUCTION) or FABRICATED_TIME_FALLBACK
if assertsNoAvailability(draft) && spine.open: draft = regen(OCCUPANCY_GUARD) or OCCUPANCY_FALLBACK
if enforceActionClaims && unbackedActionClaims(draft): draft = regen(ACTION_CLAIM_GUARD) or SAFE_AUDIT_FALLBACK
if hasActionFabrication(draft): draft = regen(ACTION_FABRICATION_GUARD) or SAFE_AUDIT_FALLBACK
re-check all detectors (NO further regen) → terminal fallback on any persistent trip   // no oscillation
return observe(draft)
```

**Unified regen cap + deadline (D6).** All gates and all seams share ONE per-turn `RegenBudget` (`{ remaining, deadlineMs }`, `output-gate.ts`) so a multi-gate turn cannot stack unbounded LLM round-trips or blow the 60s identity-lock TTL. When the budget is exhausted/expired a tripped gate skips regeneration and goes straight to its safe fallback. After the gate sequence a **post-regen re-check** re-validates every detector once (no further regen) so a later-gate regeneration cannot silently re-introduce an earlier-gate lie. A budget is created per turn by each seam (Branch 4 in `makeGenReply`, Branch 3 in the orchestrator loop — shared with its `auditReplyClaims`); when no budget is threaded each gate regenerates once exactly as before (no behavior change — the cap only bites the worst case). A gate that *throws* fails to a safe template, never the ungated draft (F-rev4).

### 4.2 The allowlist — assembled with **zero per-path wiring**

The key insight that makes the gate path-agnostic: **the situation string is system-authored and already block-aware**, so every time the core legitimately surfaced *this turn* is in it. The allowlist (`buildAllowedTimes`) is the union of four deterministic sources:

| Source | Why it is trusted |
|---|---|
| **Times in the situation string** | The core wrote it from the block-aware spine (`getOpenSlots` / `listDayOptions`). Every suggestion site interpolates its offered text into the situation, so they're all covered without touching call sites. |
| **Customer-raised times** (from `transcript`, customer turns only) | A reply may legitimately *echo/refuse* a time the customer asked about ("at 17:00 we don't have a class"). Without this, the working-chat refusal would false-positive. |
| **Business-hour boundaries** (`loadBoundaryTimes`) | Open/close times are legitimate to state ("we're open 09:00–20:00") but are **not** interior bookable slots. |
| **Customer's own booking times** (`loadCustomerBookingTimes`) | Cancellation / list / reschedule replies restate the customer's real existing slots. |

A fabrication is precisely a clock time **in the reply** absent from all four. `prior-assistant` turns are deliberately **excluded** — including them would launder a fabrication across turns. (Trade-off: a legitimate re-offer of previously-listed real times must be re-surfaced into the *current* situation by the core, not recalled by the model — see §6 Symptom B.)

### 4.3 Detection — `slot-fabrication-guard.ts`

- `extractClockTimes(text)` — every `HH:MM` (24h) token, canonicalized, deduped. Regex `(?<![\d:])(\d{1,2}):(\d{2})(?![\d:])` won't half-match `17:00:00` or long digit runs. Prices / dates / durations have **no colon** → never matched. This works because the core renders *every* slot via `formatSlotTime` (en-GB, 2-digit, 24h), so the model mirrors `HH:MM` when it fabricates.
- `extractMentionedTimes(text)` — `HH:MM` **plus** bare in-context hours (after `ב/ל/בשעה` or `at/by/around`) → `HH:00`. Used for the customer-raised allowlist; erring toward *more* mentions only widens what the reply may echo, which is safe.
- `findUnbackedTimes(reply, allowed)` — the verdict: clock times in the reply not in the allowlist.

### 4.4 Action — regenerate, then fall back

- Regenerate once appending **`TIME_GUARD_INSTRUCTION`**: *"The ONLY bookable times are those explicitly listed as open times / classes above. Business hours are NOT bookable slots… if nothing fits, say so — do NOT state any other clock time."*
- If it still fabricates → **`FABRICATED_TIME_FALLBACK`** (a time-free "let's find you a real time — which day should I check?"). **The gate never sends an unverified time.** A false positive degrades to "asks a question," never to "offers a wrong slot."

### 4.5 Why this finally holds

- **Deterministic** — `HH:MM ∈ allowlist?` is a set membership test, not fuzzy multilingual parsing.
- **Path-agnostic** — runs in the one chokepoint; new reply paths are covered for free.
- **Self-healing** — regenerate-then-fallback means an imperfect allowlist degrades to a safe question instead of a wrong assertion.

---

## 5. Grounding (the other lever)

Reduce how often the gate must fire by never handing the model interpolatable raw material:

- **Inquiry situation hardening** (`customer-booking.ts`, `inquiry` case): business hours are explicitly framed as *open hours, not a list of bookable slots*; "if nothing is listed, there is nothing — never infer a time." This removed the exact fuel (raw `09:00–20:00`) the model interpolated `17:00/19:00` from.
- **Closed-world business facts** (`buildBusinessFacts`): the exhaustive service list + price rules injected into **every** reply — kills service/price fabrication. **Instructors are roster-grounded** (§5 below): Branch 4 now loads the real instructor roster (`loadInstructorRoster`) and `buildBusinessFacts` lists the actual instructors ("this is the COMPLETE list — never name or invent anyone else; only name one if the customer asks"). This replaced an over-broad blanket "never name any instructor" prompt rule that the model ignored anyway — the closed-world list keeps it *truthful* (a real instructor named on request is correct) while still blocking invention. When no roster exists, the no-name/no-invent rule stands.
- **Deterministic part-of-day** (`startInBucket`): morning `[open,12:00)`, afternoon `[12:00,18:00)`, evening `[18:00,close]`. "Evening?" resolves from real class starts, not an LLM-imagined window.

---

## 6. Worked example — the occupancy fabrication (source-truth, not the gate)

**Observed:** after the time-gate shipped, a customer asked about a 15:00 class (none exists). The PA replied *"all Wednesday spots are taken; next openings Sunday July 5 at 13:00/15:00/17:00."* Wednesday actually had **7 classes with ~55 free seats**.

**Why the time-gate did NOT (and should not) catch it:** the offered July-5 times were *real* `getOpenSlots` results, so they were in the situation → allowed. And "fully booked" is an **occupancy** claim, not a clock time. Critically, **the core itself believed Wednesday was empty** — the inquiry path measured availability with `getOpenSlots` (open *appointment gaps*), which returns nothing on a class day fully tiled by classes+blocks. The data fed to the model was wrong, so no output gate could help. **This is a source-truth bug.**

**Root cause:** for a class business, availability is the **scheduled classes with spots left**, not appointment gaps. Two paths used the wrong model:

- **Symptom A** (false "fully booked"): inquiry with no resolved day → `buildInquiryAvailabilityText` (appointment `getOpenSlots`) → empty → model glossed "nothing open" as "fully booked."
- **Symptom B** (guard false-positive): "book yoga Wednesday" (no time) → the situation injected *no* times → the model recalled the real classes from the transcript → the time-gate (correctly distrusting prior-assistant turns) stripped them → unhelpful `FABRICATED_TIME_FALLBACK`.

**Fix (source-truth):**

- `suggestNextClassesText` — the class analogue of `suggestOpenSlotsText`: enumerates the next real **class instances with spots left** over 14 days (bucket- and constraint-filtered). A fully-tiled week still has open *classes* even with zero open *gaps*.
- Inquiry fallback is now **model-aware**: class focus (or a class business with no appointment focus) → `suggestNextClassesText`; appointment focus → `getOpenSlots`. (Symptom A)
- No-time booking now injects **that day's real options** (`buildDayOptionsText`) into the situation, so the model offers true times *and* they enter the gate's allowlist. (Symptom B)

**Lesson:** when the *core's data* is wrong, fix the core — an output guard cannot validate against a source that is itself lying.

### The occupancy *output* guard — Gate 3 (built; hardened 2026-06-28)

Keyed off a **deterministic signal**, never phrase-parsing alone. Implemented in `makeGenReply` as a third gate. As of 2026-06-28 it runs **two signals, strongest first**, both inside `if (assertsNoAvailability(reply))`:

**(a) Fresh-spine backstop (the load-bearing anti-laundering mechanism).** The handler passes a per-turn `focusDay` (`{dateStr, serviceTypeId?}`) on every branch anchored to a specific day (time-missing booking, class-gate, unavailable-slot reoffer, inquiry day-branch, and the unknown/default branch). When the reply asserts blanket fullness and a `focusDay` is in play, the gate **re-reads that day from the spine** via `dayHasOpenOptions` (a closure over `listDayOptions`; `open` counts only genuinely-open capacity — classes with `spotsLeft > 0` or any private gap — *not* `buildDayOptionsText.offered`, which includes full classes). If the day really has open options, the claim is a laundered lie regardless of what the situation text held → regenerate with the real options injected, then `OCCUPANCY_FALLBACK`. This is what kills the cross-turn laundering §6 (and the live "Sunday is full" on a challenge turn) that the situation-only signal was blind to. Signal (a) short-circuits (b).

**(b) Situation signal, now date-aware (back-compat).** When there is no `focusDay` (or the spine read was clean), the gate falls back to the system-authored situation: **open offered times** = clock times in the situation, MINUS business-hour boundaries, MINUS the customer's own bookings, MINUS any time marked `(full)` / `(מלא)` (`extractFullTimes`). This is now computed **day-scoped** (`extractDayScopedTimes` → `Map<dayKey, Set<HH:MM>>`) and compared with `daysShareOpenTime`, so a cross-day `HH:MM` coincidence (a false "Wed 16:00 full" bundled with a real "Mon 16:00") no longer spares the lie. If a day still has open times the reply hides → regenerate with `OCCUPANCY_GUARD_INSTRUCTION`, then `OCCUPANCY_FALLBACK`.

The deterministic signal gates the phrase check, so a truly full day (no open signal on either path) is never touched — truth from lie is decided by the spine, not the regex. Fixes the live "Monday is completely full" right after listing Mon 11/14/18, **and** the recycled "Sunday is full" on a challenge/continuation turn the core hadn't re-grounded.

---

## 7. Decision framework — which lever for a new fabrication?

```
A reply asserted something untrue. Ask:

1. Did the deterministic core compute the correct fact this turn?
   ├─ NO  → SOURCE-TRUTH bug. Fix the core / the situation it produces.
   │        (e.g. wrong availability model → suggestNextClassesText.)
   │        An output guard here is useless — it validates against a lying source.
   └─ YES → the core was right, the phrasing lied. Output-GATE it:
            a. Is the claim machine-checkable against a deterministic set/signal?
               (a clock time ∈ allowlist; a "done" claim vs. a write that happened;
                an availability claim vs. an "offered ≥1 option" flag)
               ├─ YES → add a gate in makeGenReply: detect → regenerate → safe fallback.
               └─ NO  → make it checkable first (compute the signal), THEN gate.
            b. Build the allowlist from DETERMINISTIC sources only
               (situation ∪ customer-raised ∪ business config ∪ real records).
               Never include prior-assistant output (laundering).
            c. Fallback must assert nothing — ask instead.
```

**Rules of thumb**

- **Grounding first, gate second.** If the situation can carry the answer, put it there; the gate is the backstop, not the primary fix.
- **One chokepoint, not per-path.** Add gates where every reply funnels (`makeGenReply` for Branch 4; the claim auditor in `orchestrator.ts` for Branch 3).
- **Deterministic checks only.** Membership/flags, not multilingual NLP of the reply.
- **Fail safe.** Regenerate once, then a question. Never emit an unverified assertion.
- **Never trust prior-assistant turns** as ground truth — re-surface real facts into the current situation instead.

---

## 8. Cross-branch note

As of the unified gate, **Branch 3** (manager orchestrator) reuses the **same `gateReply`** over a branch-built `TurnLedger`, so a new claim-class gate it adds is covered there by construction. (The **proactive** door runs only the weaker `gateProactiveBody` action+time subset — see §4.1 — so a new gate added to `gateReply` does **not** automatically reach proactive; that door is intentionally lighter per D3.) Branch 3 seeds the ledger's `allowedTimes` from its availability **tool results** (`extractAllowedTimesFromToolResult`) and `backedActions` from `actionsFromToolResult` (the L2 accumulation), derives an occupancy focus-day from the calendar tool it resolved this turn (D4), and runs `gateReply` then its own `auditReplyClaims` for the non-booking action classes — sharing the one per-turn regen budget. When adding a fabrication guard, prefer extending `gateReply`/the ledger so all three seams inherit it; only the Branch-3 `auditReplyClaims` action coverage and the 12h/am-pm gap (below) still need per-seam attention.

---

## 9. File & symbol map

| Concern | File · symbol |
|---|---|
| Time detection (pure) | `src/domain/flows/slot-fabrication-guard.ts` · `extractClockTimes`, `extractMentionedTimes`, `findUnbackedTimes`, `canonicalTime` |
| Output gate (chokepoint) | `src/domain/flows/customer-booking.ts` · `makeGenReply`, `buildAllowedTimes`, `loadBoundaryTimes`, `loadCustomerBookingTimes` |
| Corrective + fallbacks | `customer-booking.ts` · `TIME_GUARD_INSTRUCTION`, `FABRICATED_TIME_FALLBACK`, `BOOKING_NOT_CONFIRMED_FALLBACK`, `OCCUPANCY_GUARD_INSTRUCTION`, `OCCUPANCY_FALLBACK` |
| Occupancy guard (Gate 3) | `slot-fabrication-guard.ts` · `extractFullTimes`, `assertsNoAvailability`, `extractDayScopedTimes`, `daysShareOpenTime`; `customer-booking.ts` · `makeGenReply` (Gate 3), `dayHasOpenOptions` (fresh-spine reader), `GenReply.opts.focusDay` |
| Confirmation parse / state | `flows/types.ts` · `parseConfirmation` (`'yes_with_question'`); `customer-booking.ts` · `rebuildOnSlotPivot` (side-question keeps the hold) |
| Customer-turn serialization | `flows/concurrency-lock.ts` · `withIdentityLock` (per-identity, 60s TTL, fail-open) |
| Booking-claim / action guards | `src/domain/flows/reply-guard.ts` · `assertsBookingConfirmed`, `detectActionClaims` |
| Branch-3 claim auditor | `src/adapters/llm/orchestrator.ts` (generalized guard) |
| Grounding — closed-world facts | `customer-booking.ts` · `buildBusinessFacts`; inquiry-situation hardening (`inquiry` case) |
| Truthful class availability | `customer-booking.ts` · `suggestNextClassesText`; `src/domain/availability/day-options.ts` · `listDayOptions` |
| Part-of-day buckets | `customer-booking.ts` · `startInBucket` |
| Tests | `slot-fabrication-guard.test.ts`, `time-of-day-bucket.test.ts`, `next-classes.test.ts` |

---

## 10. Known limitations (be honest about scope)

- **`HH:MM` / 24-hour only.** The time-gate targets the format the core renders. Bare am/pm English phrasing ("5 PM") is **not** matched. The live business is Hebrew/24h; extend `extractClockTimes` with an am/pm normalizer if an English/12h business is onboarded.
- **Occupancy claims are output-gated** (Gate 3, §4.6): a fresh-spine backstop (`dayHasOpenOptions` + per-turn `focusDay`) plus a date-aware situation signal. The backstop only fires when the reply asserts blanket fullness AND a focus day is known; a turn with no resolvable focus day still relies on the situation signal alone.
- **Cross-day time coincidence — mitigated for the common case.** The occupancy gate is now day-scoped (`extractDayScopedTimes`/`daysShareOpenTime`), keyed off Hebrew/English day tokens. Day-scoping is heuristic (it sections free text by day labels); the fresh-spine backstop (a) is the real guarantee, day-scoping (b) is hardening. Gate 2 (`findUnbackedTimes`) is still bare-`HH:MM`.
- **The gate is for *phrasing* lies.** It cannot fix a lie the core also believes — that is always a source-truth fix.

---

## 11. Change log

- **2026-06-30 — Unified Anti-Fabrication Gate (one ledger, one gate, three doors).** Collapsed the scattered per-branch checkers into a single per-turn `TurnLedger` + one `gateReply` run at the two full doors (Branch 4, Branch 3); the proactive door runs a weaker `gateProactiveBody` action+time subset (D3). Closes the fabrication-surface audit's holes by construction: **Branch 3 availability gate** (time + occupancy, previously absent — H1, CRITICAL) now reuses `gateReply` seeded from the tool-result allowlist; **backed-action coverage** extended to refund/broadcast/settings/coordination with `partial`≠backed; **`narrative` grounding** surfaces owner-authored service attributes (answer-from-facts, not invention); **owner-ping throttle** (dedup/substance/rate, non-blocking, "still-waiting" re-ask). Phase 3 graduated the last monitors to **enforce**: **Gate 4** (`hasActionFabrication`) now regenerates→`SAFE_AUDIT_FALLBACK` instead of logging; **Gate 3b** wires `detectActionClaims` into Branch 4 over a real `backedActions` ledger (new `waitlist_added` class) so "I cancelled your class"/"added you to the waitlist" off a failed/absent action is caught. **Unified regen cap + per-turn deadline** (D6) across all gates/seams kills round-trip stacking under the 60s identity lock; a **post-regen re-check** kills oscillation; a thrown gate fails to a safe template, never the ungated draft (F-rev4). Cross-seam **non-bypass** + **voice-golden** invariants lock it in. Files: `grounding/turn-ledger.ts`, `grounding/output-gate.ts`. (Owner deploys once; applies migration `0052_pending_owner_questions`.)
- **2026-06-29 — Gate 4: action/escalation fabrication + the ask-the-owner round-trip (S3).** Generalised the doctrine from *availability/booking* lies to **action** lies: a reply must never claim an action the deterministic core didn't perform. The reported case — the PA telling a customer "I asked the owner / a guide will get back to you" with no message ever sent — is closed three ways: (1) **capability** — a real customer→owner question relay (`escalateCustomerQuestion` → `pending_owner_questions` → Branch-3 `answerCustomerQuestion` tool → relay back → expiry worker); (2) **de-fabrication** — the model can no longer self-author "I'll check with the business"; on a genuine knowledge gap it emits a `[[ASK_STUDIO]]` sentinel and CODE performs the real escalation + honest reply (the global `client.ts` prompt + two flow instructions were stripped of the promise); (3) **Gate 4 detector** — `hasActionFabrication` (voice-guard, He+En) flags any LLM reply that still claims a check/ask/"get back to you", since the honest escalation replies come from code templates and bypass the gate. *(Shipped monitor-only; graduated to **enforce** in the 2026-06-30 unified gate — regenerate→`SAFE_AUDIT_FALLBACK`.)* The honest "passed it on" wording is only ever produced *after* a successful dispatch.
- **v1.0.96** — Time-fabrication gate (Gate 2) + allowlist + inquiry grounding + part-of-day buckets. Fixes the PA offering internally-blocked times on open-ended inquiries.
- **(this change)** — `suggestNextClassesText` + class-aware inquiry fallback (Symptom A) + no-time booking injects day options (Symptom B). Fixes the false "fully booked" occupancy claim and the gate's false-positive fallback on under-specified class bookings.
- **(this change)** — **Occupancy output guard (Gate 3).** Built the §4.6 "future work" guard: `makeGenReply` now regenerates (then safe-falls-back) when a reply asserts a day/class is full while the situation lists ≥1 *open* time it hides. Deterministic signal (`extractFullTimes` excludes `(full)` markers) gates a conservative he/en fullness-phrase check (`assertsNoAvailability`); a specific-time negative that surfaces the open times is spared. Fixes the recurring "Monday is completely full" said right after listing Mon 11/14/18.
- **(this change)** — **Service-fidelity guard.** Extended §4.2's "never trust prior-assistant turns" rule from *time* to *service*: `inferFocusService` reads assistant turns, so on an underspecified booking it laundered the customer's remembered favourite (a memory-driven "yoga as usual?" the customer never affirmed) into a locked booking — observed live switching a pilates thread to yoga. `customerReferencedService` now refuses to lock the preferred favourite unless the customer raised it this conversation. Also reworded the `FABRICATED_TIME_FALLBACK` ("real time" → "a time that works").

- **2026-06-28 — Occupancy fresh-spine backstop + date-aware gate + state-integrity family (ROOTs 1–6).** A live-test sweep showed occupancy fabrications surviving the prior Gate 3 *and* a non-fabrication bug class. Two doctrine-level roots, fixed separately:
  - **Grounding (the fabrications).** The handler only re-grounded availability on the inquiry-day and time-missing-booking branches; **challenge / continuation / unknown** turns recycled a stale "this day is full" from the transcript, and Gate 3's situation-only signal was blind (DB-proven: Sunday pilates 14:00/18:00 open while the PA said "אין מקום"). Fix: (1) a **fresh-spine occupancy backstop** in `makeGenReply` (`dayHasOpenOptions` re-reads the focused day; never lets a "full" claim pass without a current spine read); (2) **date-aware** Gate 3 via `extractDayScopedTimes`/`daysShareOpenTime` (kills the cross-day `16:00` coincidence that spared a false "Wed 16:00 full"); (3) **unknown/default-branch grounding** so a challenge re-injects the day's real options. The `open` signal counts only genuine remaining capacity (`spotsLeft > 0` / open gaps), not `buildDayOptionsText.offered` (which includes full classes) — otherwise the backstop would misfire on a genuinely-full day and degrade a *correct* "fully booked" reply.
  - **State integrity (the non-fabrication bug — same doctrine, different mechanism: re-ground state every turn; never trust the transcript over the core).** A customer's clean "כן בבקשה" produced a fresh greeting and no booking because the prior bundled "כן בבקשה, מי המורה" (yes + side-question) had been routed through `rebuildOnSlotPivot`'s redirect, which **cleared the pending hold**; the next yes hit empty state. Fixes: `parseConfirmation` now returns `'yes_with_question'` (a leading affirmative + a pure side-question, no clock time → still a confirmation); a pure inquiry/list **never clears a pending hold** (it falls through to the slot-restating re-ask); and the customer path gained a **per-identity Redis lock** (`withIdentityLock`, 60s TTL, fail-open after ~8s) that serializes concurrent turns the burst-coalescer's debounce misses (observed: two messages ~12s apart producing an interleaved reply).
  - **Nudge truthfulness.** The "let someone call you" nudge fired on fabricated dead-ends; it now only nudges when the spine genuinely has no upcoming openings, otherwise it surfaces the real next classes.
  - **Instructor grounding (reclassified — not a fabrication).** Real owner-configured instructors are now loaded into Branch 4 and listed closed-world in `buildBusinessFacts` (see §5), replacing the ignored blanket ban.
