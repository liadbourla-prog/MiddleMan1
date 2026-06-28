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
| **Occupancy fabrication** | "all Wednesday spots are taken" when ~55 are free | **source-truth** (grounding) | **solved at source** (§6); guard is future work |
| **Service / staff / price fabrication** | invents a service or instructor or quotes a price not on record | grounding (`buildBusinessFacts`) | solved (closed-world facts block) |
| **Service-fidelity fabrication** (prior-assistant laundering) | locks the customer's remembered "usual" service (e.g. switches a pilates thread to *yoga*) on an underspecified booking the customer never affirmed | grounding (`customerReferencedService`) | **solved** (§4.2 rule extended to *service*) |

The same two levers address all of them; which lever leads depends on whether the core's *data* was wrong (→ grounding) or only the *phrasing* was wrong (→ gate). See the decision framework in §7.

---

## 4. The output gate (the anti-fabrication mechanism)

### 4.1 Where it lives — the single chokepoint

Every Branch-4 customer reply is produced through **`makeGenReply`** (`src/domain/flows/customer-booking.ts`). It is the one seam every path funnels through, so guards added here are universal. It runs two gates unless the caller asserted a real persisted booking (`opts.bookingConfirmed` → exempt, because the booked slot is real):

- **Gate 1 — phantom booking-claim** (`assertsBookingConfirmed`, `reply-guard.ts`): the reply claims a booking is done when none was written.
- **Gate 2 — fabricated time** (`findUnbackedTimes`, `slot-fabrication-guard.ts`): the reply states a clock time the core never offered.

Each gate: **detect → regenerate once with a corrective → deterministic fallback** if it still fails. The fallback is time-free / claim-free — when in doubt we ask, never assert.

```
draft = generateCustomerReply(situation)
if bookingConfirmed: return draft                      // real slot, trusted
if assertsBookingConfirmed(draft): draft = regen(forbid-claim) or BOOKING_NOT_CONFIRMED_FALLBACK
if findUnbackedTimes(draft, allowed): draft = regen(TIME_GUARD_INSTRUCTION) or FABRICATED_TIME_FALLBACK
return draft
```

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
- **Closed-world business facts** (`buildBusinessFacts`): the exhaustive service list + "do not invent staff / quote unknown prices" injected into **every** reply — kills service/staff/price fabrication.
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

### Could an occupancy *output* guard exist? (future work)

Yes, but only if it keys off a **deterministic signal**, never phrase-parsing. The safe design: the handler passes `makeGenReply` a boolean "the spine offered ≥1 real bookable option this turn"; if the reply asserts blanket unavailability ("fully booked / no spots") while that signal is true → regenerate. A naive regex that flags "full" claims is unsafe because a genuinely full class is legitimately reported as full (`buildDayOptionsText` prints `(full)`), so the guard cannot tell truth from lie without the spine's signal. Not yet built; documented here so the next implementer starts from the signal, not the phrase.

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

Branch 3 (manager orchestrator) already generalizes the same idea: `detectActionClaims` (`reply-guard.ts`) + the L2 claim auditor in `src/adapters/llm/orchestrator.ts` cross-check "said-done" claims (message sent, calendar connected, cancelled, booked) against what tools actually succeeded this turn, and regenerate on an unbacked claim. When adding a fabrication guard, check whether the analogous Branch-3 auditor needs the same coverage.

---

## 9. File & symbol map

| Concern | File · symbol |
|---|---|
| Time detection (pure) | `src/domain/flows/slot-fabrication-guard.ts` · `extractClockTimes`, `extractMentionedTimes`, `findUnbackedTimes`, `canonicalTime` |
| Output gate (chokepoint) | `src/domain/flows/customer-booking.ts` · `makeGenReply`, `buildAllowedTimes`, `loadBoundaryTimes`, `loadCustomerBookingTimes` |
| Corrective + fallbacks | `customer-booking.ts` · `TIME_GUARD_INSTRUCTION`, `FABRICATED_TIME_FALLBACK`, `BOOKING_NOT_CONFIRMED_FALLBACK` |
| Booking-claim / action guards | `src/domain/flows/reply-guard.ts` · `assertsBookingConfirmed`, `detectActionClaims` |
| Branch-3 claim auditor | `src/adapters/llm/orchestrator.ts` (generalized guard) |
| Grounding — closed-world facts | `customer-booking.ts` · `buildBusinessFacts`; inquiry-situation hardening (`inquiry` case) |
| Truthful class availability | `customer-booking.ts` · `suggestNextClassesText`; `src/domain/availability/day-options.ts` · `listDayOptions` |
| Part-of-day buckets | `customer-booking.ts` · `startInBucket` |
| Tests | `slot-fabrication-guard.test.ts`, `time-of-day-bucket.test.ts`, `next-classes.test.ts` |

---

## 10. Known limitations (be honest about scope)

- **`HH:MM` / 24-hour only.** The time-gate targets the format the core renders. Bare am/pm English phrasing ("5 PM") is **not** matched. The live business is Hebrew/24h; extend `extractClockTimes` with an am/pm normalizer if an English/12h business is onboarded.
- **Occupancy claims are not yet output-gated.** Fixed at the source (§6); the deterministic-signal guard is designed but unbuilt.
- **Cross-day time coincidence.** The gate matches `HH:MM`, not date+time. A fabricated "10:00" on the wrong day, when "10:00" is offered on another day, would pass. Acceptable today (the harmful cases offer times offered *nowhere*); revisit if it surfaces.
- **The gate is for *phrasing* lies.** It cannot fix a lie the core also believes — that is always a source-truth fix.

---

## 11. Change log

- **v1.0.96** — Time-fabrication gate (Gate 2) + allowlist + inquiry grounding + part-of-day buckets. Fixes the PA offering internally-blocked times on open-ended inquiries.
- **(this change)** — `suggestNextClassesText` + class-aware inquiry fallback (Symptom A) + no-time booking injects day options (Symptom B). Fixes the false "fully booked" occupancy claim and the gate's false-positive fallback on under-specified class bookings.
- **(this change)** — **Service-fidelity guard.** Extended §4.2's "never trust prior-assistant turns" rule from *time* to *service*: `inferFocusService` reads assistant turns, so on an underspecified booking it laundered the customer's remembered favourite (a memory-driven "yoga as usual?" the customer never affirmed) into a locked booking — observed live switching a pilates thread to yoga. `customerReferencedService` now refuses to lock the preferred favourite unless the customer raised it this conversation. Also reworded the `FABRICATED_TIME_FALLBACK` ("real time" → "a time that works").
