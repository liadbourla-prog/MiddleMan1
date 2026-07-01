# Red-Team of the 2026-06-30 Branch-4 Findings (before planning)

**Method:** for each root hypothesis, (1) state it, (2) attack it with the simplest alternative explanation + fresh DB/code evidence, (3) verdict, (4) residual uncertainty. Then a regression-risk pass on the proposed fix directions. **One hypothesis flipped (P3); two survived with sharper mechanism; the unifying-root claim survived.**

Companion: findings = `2026-06-30-branch4-livetest-findings.md`; plan = `plans/2026-06-30-branch4-root-fix-plan.md`.

---

## P1 — "release booked the slot." **SURVIVES (confirmed, strengthened).**

**Claim:** windowed `parseConfirmation` returned `'yes'` on "כן תשחרר" (decline), the hold-confirm handler booked because it didn't know the prompt was an either/or, and the "already went through" causal story is ungated.

**Attack A — "maybe there was no pending offer; some other path auto-booked."**
Refuted by DB. `conversation_sessions.context` (session `ca8746d7`, ctx v8) carries `pendingSlot = {start 2026-07-05T15:00Z, serviceName פילאטיס, serviceTypeId 818d31bc}` — i.e. an **offer**, not a booking. `bookings` has exactly **one** row, `created_at 09:34:18.375`, the same second the decline message was processed. So at "כן תשחרר" there was a live pending offer and no prior hold → the pending-slot confirmation path is the only one that fits, and it created hold+confirm in that one turn. Confirms, not refutes.

**Attack B — "maybe 'כן תשחרר' really is a confirm in Hebrew."**
Refuted by semantics + the prompt. The PA's prompt was the either/or "release the spot … **OR** take it?" "כן תשחרר" = "yes, release" answers the *release* arm. The booking is the opposite of what was asked. Independent corroboration: 51s later the customer says "תבטל אני לא רוצה" (cancel, I don't want it) — he never wanted it.

**Attack C — "maybe the 'already went through' line was true (a real race)."**
Refuted. Single booking row, created *by this message*; no earlier hold/registration existed. "your registration already went through" describing a pre-existing registration is false; the line fabricates a coincidence to paper over a book-against-decline.

**Verdict: CONFIRMED.** Mechanism precise: `types.ts:59-86` (windowed-yes, no decline-verb precedence) → `customer-booking.ts:~2740/2894/3087` (no pending-prompt-type record) → `output-gate.ts:327` (action-backed so causal framing passes).
**Residual uncertainty:** none material. The one charitable reading of "כבר עבר" (="it just now went through", describing the new booking) doesn't rescue anything — the **booking against an explicit release** is the harm regardless of how the sentence is read.

---

## P2 — "no Pilates at 12" → "all Sunday Pilates full." **SURVIVES (confirmed; mechanism split clarified).**

**Claim:** a service+time-scoped grounding returns empty and the occupancy backstop is day-blind, so a service+time miss launders into whole-service-empty, ungated.

**Attack A — "maybe the calendar really was full / sparse and the PA was right-ish."**
Refuted by DB. `class_series` + `calendar_blocks` for Sunday 2026-07-05: Pilates at **09:00, 11:00, 14:00, 18:00 local** (blocks at 06:00Z/08:00Z/11:00Z/15:00Z), Yoga at 10/12/16. Identical to the PA's truthful **first** message. The day was not full; "all Pilates taken" is fabricated. (Also confirms there is genuinely **no Pilates at 12** — 12:00 local is Yoga — so the *correct* reply was "no Pilates at 12; Pilates is 9/11/14/18, Yoga is 12", never "all full".)

**Attack B — "maybe the situation string DID contain the Sunday times and Gate-3b simply mis-compared."**
This is the important one — it decides grounding-root vs gate-only-root. Tested two ways:
- If the situation had carried `Sun:{9,11,14,18}`, then `situationHasOpen=true` and, since the reply's only times were for a *different* day (today 14:00/18:00), `daysShareOpenTime(Sun-set, reply-{Tue})` would be **false** → `output-gate.ts:310` **would have fired** and regenerated. It did **not** fire. ⇒ the situation most likely did **not** carry the Sunday Pilates times.
- The grounding call (`customer-booking.ts:1590`) is `buildDayOptionsText(…, inquiryService?.id /*Pilates*/, …, intent.slotRequest?.timeOfDay, …)` — filtered by **service** and **time-bucket**. A noon ("12") request maps to a bucket with no Pilates ⇒ empty `availabilityText` ⇒ the code's own fallback "answer from a different model / other days" path (1596+), which matches the observed "here's *today*/*tomorrow*" reply.
⇒ Both signatures point the same way: **the day's real whole-service availability was filtered out of the grounding before the gate ever saw it.** The day-blind `replySurfacesAnyTime` (`output-gate.ts:216`, literally `extractClockTimes(text).length>0`) is the **second** hole that lets Gate-3a's fresh-spine backstop skip when the reply offers any wrong-day time.

**Verdict: CONFIRMED**, with the mechanism sharpened: it is a **two-hole** failure — (1) grounding narrowed by service+time-bucket to empty (the primary, `customer-booking.ts:1590` + the fallback), (2) the occupancy backstop's escape heuristic is day-blind (`output-gate.ts:216/289`). F2a/F2b don't cover it (F2a keys on buckets not the whole-service set; F2b's detector is gated behind the two holes).
**Residual uncertainty (honest):** I could not read the exact situation string for that turn (X1 — no prod app logs), so the empty-vs-mis-compared split is *inferred* from the two consistency tests above, not directly observed. Either way the fix is the same (scope-matched whole-day grounding + day-aware gate), so this does not change the plan. **Flagged for the build session to confirm by reproducing the grounding call.**

---

## P3 — "price asked 3×, never escalated." **SURVIVES (original framing restored after a two-step correction).**

**Original claim:** the price was genuinely unknown and should have escalated to the owner; the escalation decision (LLM-sentinel-only, "relay rarely") failed.

This section is a worked example of the red-team correcting *itself*. It went wrong, then right:

**Step 1 — first attack (WRONG): "is the price actually unknown?"**
A *current* DB read showed `service_types.payment_amount = 80.00` for Pilates/Yoga, so I reframed P3 to a "data-source mismatch" (price configured but unplumbed). **Both halves of that were wrong:**

**Step 2 — the owner challenged the timestamp, and deeper verification reversed the reframe:**
- **(2a) The 80 ₪ was set AFTER the test, not before.** Branch-3 transcript (manager session `0d0f3b87`): 17:05:30Z owner asks "מה המחיר לפילאטיס?"; 17:05:41Z PA replies **"אין לי את המידע על המחירים"** (I don't have price info) and offers to set it; 17:06:07Z owner "80 שקל, אותו דבר ליוגה"; 17:06:21Z PA "עדכנתי. 80 ש״ח". Corroborated by `audit_log` `manager_instruction.applied / service_change` ×2 at **17:06:16Z**. The Branch-4 price questions were at **15:27Z — ~1.5h earlier.** So at test time `payment_amount` was **null**. (I had treated a current read as the historical state — the exact "trust DB ground truth" trap, missing that *ground truth is time-indexed*.)
- **(2b) There is NO data-source mismatch.** The trace-agent's claim that `buildBusinessFacts` reads "a different empty field" is **false**. `businessKnowledge.services[].price` is sourced via `resolveServicePrice` (`knowledge-resolver.ts:59`), whose step 3 (`pricing/resolver.ts:62-69`) reads `serviceTypes.paymentAmount`. So the canonical price **is** correctly plumbed to the facts block. (After 17:06, a customer asking would now correctly get "80 ₪".)

**Net (both errors cancel): P3 reverts fully to the original framing.** At 15:27Z the price was genuinely null → `buildBusinessFacts` correctly emitted `'no price on record — do NOT quote a price'` → the model correctly **did not fabricate a price** (anti-fab working) → **but it dead-ended 3× instead of escalating to the owner.** Zero `pending_owner_questions` rows for ג׳וני, while the same relay fired fine for +972546372400 at 07:56/07:58. **The escalation safety-net failed for a genuine knowledge gap** — exactly the owner's complaint ("when it doesn't know the price it must ask Branch 3").

**Root (confirmed):** escalation is an LLM-discretion event gated on a self-emitted `[[ASK_STUDIO]]` sentinel, biased toward deflection by `fd1b2eb` ("steer first, relay rarely"), with **no deterministic safety net** — no detector that a *structured fact is null and was asked for*, and no *repeated-unmet-need* trigger when the same unanswered question recurs (≥2×). The substance/dedup/rate throttle (`escalation/engine.ts:182-198`) would have passed this question; it was simply never reached because no sentinel was emitted.
**P3a is withdrawn (phantom).** There is no data plumbing to fix.

**Verdict: CONFIRMED (original framing).** No split, no P3a; the fix is the escalation safety net only.
**Lesson logged (sharpened):** two compounding agent/red-team errors here — (i) a code-trace agent asserted a data-source state ("reads an empty field") that the code refuted, and (ii) I asserted a *historical* data state from a *current* DB read. Rule for the plan's verification steps: **assert against engine ground truth that is correct *as of the event timestamp* — reconstruct historical state from `audit_log` + transcripts, never from a present-time `SELECT`.**

---

## Unifying-root claim — **SURVIVES, refined.**

Original: "each symptom re-entered through an adjacent un-enumerated surface; the deterministic core deferred a judgment to a narrow lexical proxy or the LLM with no scope-matched verification."

Holds for all three: P1 (lexical negation list misses decline verbs; no prompt-type record), P2 (gate/grounding scope narrower than the claim; day-blind heuristic), and P3 (escalation deferred to an LLM-emitted sentinel with no deterministic safety net). The statement stands as originally written — *the deterministic core defers a judgment to a too-narrow lexical proxy or to the LLM, with no scope-matched verification behind it.* (The earlier "case (ii) — fails to surface a fact it owns" broadening was attached to P3a, which is withdrawn; the price path is correctly wired, so there is no surface-the-fact failure. The single-statement root is the one to anchor the plan.)

---

## Regression-risk pass on the proposed fixes (so the plan doesn't re-open §K)

| Fix | Re-opens what? | Guardrail the plan must include |
|---|---|---|
| **P1 decline-verb precedence in `parseConfirmation`** | Risk of resurrecting the S1 confirm-loop (`f871fcf`) if plain embedded-yes ("תשמור לי כן") regresses to `unclear`. | Precedence triggers **only** on an actual decline/release verb co-occurring with the affirm; keep existing embedded-yes tests green. Add both the "כן תשחרר→no/unclear" test AND the "תשמור לי כן→yes" test in the same file. |
| **P1 `pendingPromptType` (either_or)** | Could make genuine yes/no confirms harder if mis-set. | Default `yes_no`; set `either_or`/`open` only where the template emits that shape. A bare yes on `either_or` → re-ask naming the option, never a silent book. |
| **P1 causal-claim gate** | Over-blocking honest confirmations ("booked you for 18:00"). | Gate only **unverifiable temporal/causal** framing ("already went through", "just as you…"), not plain factual confirmations. Narrow detector + golden-shape tests. |
| **P2 whole-day spine + day-aware `replySurfacesAnyTime`** | G1/G5: must not fallback a **legitimate** same-day alternative. | Day-aware check must still PASS a correct same-day negative ("no 12, but 14:00 that day"). Re-use the existing G1/G5 "don't fallback a legit offer" tests; add the wrong-day-time case. |
| **P2 scope-matched grounding** | Could re-introduce the "fully booked while classes exist" bug if it switches availability model. | Keep class-mode → classes (not gaps); only widen the *day/service scope*, not the model. |
| **P3 escalation net** | Re-opening the fabrication the "relay rarely" policy closed (over-relaying / fabricated "I'll check"). | Deterministic escalation only on a **truly null** structured fact the customer explicitly asked for, or a **repeated** (≥2×) unmet need; the honest "let me check with the studio" stays a CODE TEMPLATE (never LLM-authored) so Gate-4 still owns the phrasing. |

---

## Net effect on the plan

1. **P1** — unchanged, high priority (CRITICAL). Confirmed.
2. **P2** — unchanged direction; mechanism is **two holes** (grounding-narrow + day-blind gate) — fix both; add a build-session repro of the situation string to confirm the empty-grounding inference.
3. **P3** — **original framing restored**: the single fix is the deterministic escalation safety net (null structured-fact-asked-for + repeated-unmet-need), honest "let me check" as a code template. P3a (plumb price) is **withdrawn** — the price path is correctly wired; nothing to fix there.
4. **X1 (telemetry)** — promoted to a **prerequisite**: the red-team itself was blocked by the absence of the situation string / gate-fire logs; the build can't verify P2 without minimal grounding/gate tracing.
5. **Process guardrail** — verification must assert against engine ground truth that is **correct as of the event timestamp** (reconstruct from `audit_log` + transcripts), and must **not trust a code-trace agent's claim about a data state** without confirming it in the data/schema. Both classes of error occurred in this very review and were caught only by re-checking.
