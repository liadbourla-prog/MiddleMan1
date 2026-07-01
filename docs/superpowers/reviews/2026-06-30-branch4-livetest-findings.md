# Branch-4 Live-Test Findings — 2026-06-30 (v1.0.108)

**Session type:** investigate → report → propose (NO code shipped this session).
**Scope:** Three Branch-4 (customer booking) conversations run today against deployed prod, business **סטודיוגה** (`d3c0c1e7-5c75-4b93-aca5-cc4b2bf941de`), customer **ג׳וני** (`56988ade…`, +972 52-293-9125).
**Companion plan:** `docs/superpowers/plans/2026-06-30-branch4-root-fix-plan.md` (proposed root-fix, to be red-teamed).

---

## 0. Evidence base & method

Three sources, cross-referenced:

| Source | What it gave | What it did NOT give |
|---|---|---|
| Owner screenshots (3) + rendered chat | the symptom + voice quality | engine ground truth |
| **Prod DB (read-only)** — `conversation_messages`, `bookings`, `audit_log`, `pending_owner_questions`, `conversation_sessions`, `identities` | authoritative engine state for every turn | which gate fired |
| **Cloud Logging** | **nothing usable** — prod emits ONLY Fastify request logs (48 `incoming request` / 48 `request completed` / 48 null in the test window; zero `[voice-gate]`, zero gate markers, zero orchestrator traces) | the deterministic gate/audit trail the docs assume exists |

**Cross-cutting finding X1 (observability, bucket c→escalate):** the "deterministic gate/audit trail" referenced throughout ANTI_FABRICATION.md and the priming **is not queryable in production.** Application-level structured logs are not shipped at prod log level. Root-causing had to be done entirely from code + DB. This is the §D Tier-0 observability gap, and it is now load-bearing: without gate-fire telemetry, every future regression of this class is invisible until a human reads a transcript. **This should be treated as a prerequisite, not a "deferred" nicety.**

**Baseline:** `npx vitest run` at HEAD (v1.0.108, `0e8aafb`) = **1700 passed / 158 files** (was 1596 at v1.0.105; the v1.0.105→108 other-area fixes added ~104 green tests). **None of the three symptoms below is caught by any existing test** — they are genuine coverage holes, not test-flagged regressions.

**Revision mapping (timestamps are device-local Asia/Jerusalem = UTC+3):**
- Pic 2 & 3 (12:07–12:34 local = 09:07–09:34Z) → rev **pa-backend-00148-sh5** (deployed 07:31Z).
- Pic 1 (18:26–18:29 local = 15:26–15:29Z) → rev **pa-backend-00151-lvp** (latest, 12:44Z).
Both revisions carry the full anti-fab gate stack. The symptoms are present on the *latest* code (Pic 1).

---

## 1. Symptom inventory (bucketed)

Bucket key: **(a)** works as intended · **(b)** genuine regression/bug vs mission/guarantees · **(c)** known/deliberate gap per §D.

| ID | Symptom | Bucket | Root family |
|---|---|---|---|
| **P1** | "כן תשחרר" (yes, release it) → **booking created** against the decline; then PA fabricates "just as you asked to release, it already went through" | **(b)** CRITICAL | Intent-resolution over-trigger + confirmation-scope blindness + causal-claim ungated |
| **P2** | "Pilates at 12" (no such slot; 12 is Yoga) → "**all** Sunday Pilates is taken" + invented "calendar shift" + cascading false scarcity | **(b)** — §K "Sunday full" **RECURRED** | Scope mismatch: grounding+gate run at service+time-filter scope; occupancy backstop is day-blind |
| **P3** | Price asked **3×** → "I don't have the price" + dead-end deflection (price was genuinely null at test time) | **(b)** | Escalation safety-net failed for a genuine knowledge gap: relay is LLM-sentinel-only ("steer first, relay rarely"), no deterministic trigger for a null structured-fact-asked-for, no repeated-unmet-need trigger. *(Red-team confirmed original framing; a transient "data-source mismatch" reframe was investigated and withdrawn — see REDTEAM.md §P3.)* |
| **X1** | No prod gate/audit telemetry | **(c)→escalate** | Tier-0 observability not built |
| **X2** | Voice: 3× identical dead-end deflection, stacked either/or question, no next step | **(b)** but currently **monitor-only** | Mechanical voice gate is OFF (§D); these tells are "expected" today but they directly caused P1/P3 harm |
| **X3** | Session fragmentation: a continuous booking→cancel→rebook flow split across 4 sessions in ~90s | **(a)/(b) borderline** | `booking`-state session completes on confirm; cross-session context carried OK here, but worth watching |

### §K four + S1/S2/S3 status check (explicit, as required)

| Canonical symptom | Status today | Evidence |
|---|---|---|
| §K restore-loop / S1 confirm-loop-never-books-date-drift | **partially RE-INVERTED** — see P1. The S1 fix (`f871fcf` windowed-yes "embedded yes commits") **overcorrected** and now commits a booking on an embedded yes inside a *decline* ("כן תשחרר"). The disease flipped polarity: from "never books" to "books against refusal." | booking `72357b9a` created at the instant of the decline message |
| §K "Sunday full" occupancy laundering / S2 single-time-miss→whole-day-empty | **RECURRED** — see P2. F2a/F2b do not cover a **service+specific-time** miss; the occupancy backstop is day-blind. | DB: real Pilates 9/11/14/18 free; PA claimed all full |
| §K private-group escalation | not exercised in these three chats | — |
| §K July-5 gap-as-class | not reproduced; dates were correct (Fri=3 Jul, Sun=5 Jul both right) | — |
| S3 fabricated "I asked the owner" | **inverted form present** — P1's "just as you asked to release, it already went through" is the same disease class (a fabricated causal/status narrative) in a spot Gate-4 doesn't cover (action IS backed, only the *framing* lies). P3 is the *non*-escalation form: it never claims to ask the owner, it just dead-ends. | conversation_messages |

**Conclusion:** two of the four canonical symptoms are **alive again** in mutated form, and both mutations trace to *the very fixes that were meant to kill them* over-firing or under-scoping. This is the central theme of this report: the gates are **enumerable-surface** defenses, and each symptom re-entered through an adjacent, un-enumerated surface.

---

## 2. Root findings (with citations)

### P1 — "release" booked the slot, then a fabricated race story. **CRITICAL (calendar mutation against explicit decline).**

**Ground truth (DB):**
- `conversation_messages`: 09:34:03 PA asks an **either/or** — "לשחרר את המקום ולחפש לך שיעור יוגה ביום אחר, **או** שאתה רוצה לקחת אותו?" ("release the spot and look for yoga another day, **OR** do you want to take it?"). 09:34:18 customer: **"כן תשחרר"** (yes, release). 09:34:29 PA: "קיבלתי. בדיוק כשביקשת לשחרר, הרישום שלך לשיעור כבר עבר" ("got it — just as you asked to release, your registration already went through").
- `bookings`: row `72357b9a-75ee-…`, slot `2026-07-05 18:00`, state confirmed, **created_at 09:34:18.375** — the same second as the decline message (received 09:34:12, processed 09:34:18). `audit_log`: `booking.confirmed` 09:34:20, `initiator=customer_self`. Cancelled 09:35:45 only after the customer said "תבטל אני לא רוצה."

**Root (structural), three compounding layers:**

1. **Intent-resolution over-trigger — windowed-yes has no decline-verb precedence.**
   `parseConfirmation` (`src/domain/flows/types.ts:59-86`). For "כן תשחרר": `NO_PATTERNS` (line 21-22, whole-message anchored) misses; `YES_PATTERNS` (line 18-19, anchored) misses; `NEG_TOKEN` (line 26-27 = `לא|אל|בטל|עצור|ביטול`) **does not include `תשחרר`** (release) → misses; then the windowed path (line 72, `words.some(w => AFFIRM_WORDS.has(w))`) sees `כן` and returns `'yes'` (line 85). The code comment (lines 66-71) states the design explicitly: *"An affirmative token ANYWHERE is a confirmation, gated by the same revision/negation signals."* **A release/decline verb is neither a negation token nor a revision signal**, so it is invisible to the guard. Introduced by `f871fcf` (windowed parseConfirmation) — the S1 fix, now over-firing.

2. **Confirmation-scope blindness — an either/or prompt is treated as yes/no.**
   `handleHoldConfirmation` (`src/domain/flows/customer-booking.ts:2726-3119`) consumes `parseConfirmation` (≈line 2740) and on `'yes'` proceeds straight to `requestBooking` (≈line 2894) → `confirmBooking` (≈line 3087). There is **no record of the pending prompt's question-type**. When the PA asked an either/or ("release OR take it?"), a bare "yes" is semantically void — it cannot mean "confirm the booking." Nothing checks this. Tightened by `071bf93` ("one yes = one confirm"), which removed the second ask that previously would have caught it.

3. **Causal-claim ungated — Gate-4 only checks action-backing, not narrative truth.**
   The reassurance "just as you asked to release, it already went through" is a **fabricated race condition** — there was no prior in-flight registration; *this* message created the booking. `unbackedActionClaims` (`src/domain/grounding/output-gate.ts:327`, helper ~176-180) excludes `booking_made` and only checks whether an action *class* is backed. The booking *is* backed, so the gate passes. The **causal framing** (why/when it happened) is unverifiable and ungated. Same disease class as S3, in a surface Gate-4 doesn't cover.

> **Single-sentence root:** a lexical windowed-yes parser with a fixed negation allowlist commits a booking on an embedded "yes" inside a decline, because (a) it has no decline-verb precedence, (b) the handler never knows the pending question was an either/or, and (c) the only post-hoc gate checks that the action happened, not that the story about it is true.

### P2 — "no Pilates at 12" laundered into "all Sunday Pilates full." **§K recurrence.**

**Ground truth (DB):** 09:07 PA truthfully lists Sunday 5 Jul: Pilates **9/11/14/18**, Yoga 10/12/16. 09:08 customer "פילאטיס ב 12" (Pilates at 12 — a Yoga-only time). 09:08 PA: "אוי, נראה שכל המקומות לפילאטיס ביום ראשון נתפסו. יש מקום פנוי **היום** (שלישי) ב-14:00 או 18:00, או **מחר**…" (all Sunday Pilates taken; here's *today*/*tomorrow*). Then on challenge: "הייתה תזוזה ביומן… נשאר מקום אחרון… 09:00" → later collapses to "only 18:00 left." Pure fabricated scarcity; the engine never lost the 9/11/14/18.

**Root (structural):** the grounding input and the occupancy gate both operate at the **service+time-filtered** scope, while the claim is at the **whole-service-on-the-day** scope — and the gate's escape heuristic is **day-blind**:

- **Grounding narrowed to empty.** The situation/availability text for this turn is built with the named service AND the requested time (`buildDayOptionsText(..., inquiryService?.id, ..., intent.slotRequest?.timeOfDay, ...)`, `src/domain/flows/customer-booking.ts:1589-1593`; `listDayOptions` service filter `src/domain/availability/day-options.ts:99-120`). "Pilates @ 12" yields an empty set, so the situation string carries **no open Sunday times** → in `output-gate.ts:277-285`, `situationHasOpen = false`.
- **Gate-3a (fresh-spine backstop) short-circuits on a day-blind heuristic.** `output-gate.ts:286-307`: it only runs when `opts.focusDay && !replySurfacesAnyTime(reply)`. `replySurfacesAnyTime` = `extractClockTimes(text).length > 0` (`output-gate.ts:216`) — it asks "is there *any* HH:MM anywhere," **with no notion of which day**. The PA's reply surfaced "14:00 / 18:00" (for *today*), so `replySurfacesAnyTime(reply) = true` → the backstop is skipped. The comment at lines 287-288 ("a time-scoped negative that lists same-day alternatives is correct") encodes an assumption that any surfaced time is a *same-day* alternative — false here.
- **Gate-3b (situation signal) can't fire** because `situationHasOpen = false` (the situation was filtered to empty), so `output-gate.ts:310` never triggers.
- **F2a (`16ed199`) doesn't apply:** its same-day-first re-render keys on `timeOfDay` (morning/afternoon/evening buckets), not a specific clock time; "12" is a clock time, not a bucket.
- **F2b (`ce11cad`) doesn't help:** `assertsNoAvailability` *does* match "נתפסו כל המקומות" (slot-fabrication-guard), but the only path that would re-ground is gated behind the two blind/empty conditions above.

> **Single-sentence root:** when a customer names a service at a specific time that doesn't exist, the turn's grounding is filtered to empty and the occupancy backstop is skipped by a day-blind "any time present?" heuristic, so a "no Pilates at 12" miss launders into "all Pilates full" with no gate ever comparing the claim against the day's real whole-service availability — after which the model free-associates further scarcity across turns with nothing re-anchoring it to the originally-listed real times.

### P3 — price asked 3×, dead-end deflection. *(Red-team-verified; see REDTEAM.md §P3 for the worked correction.)*

> **Temporal note (decisive):** the price was **genuinely null at test time.** The 80 ₪ now in `service_types.payment_amount` was set by the owner via **Branch 3 at 17:06Z (~1.5h after** the 15:27Z price questions) — proven by the manager transcript (PA: "אין לי את המידע על המחירים" at 17:05:41, "עדכנתי. 80 ש״ח" at 17:06:21) + `audit_log` `service_change` ×2 at 17:06:16Z. The price path itself is correctly wired (`buildBusinessFacts` ← `businessKnowledge.price` ← `resolveServicePrice` ← `service_types.payment_amount`), so at 15:27Z it correctly reported "no price on record" and the model correctly did **not** fabricate a price. The fault is purely that it **deflected instead of escalating.** The owner's "must ask Branch 3 when it doesn't know the price" is exactly right.


**Ground truth (DB):** 15:27 "רגע כמה זה עולה?" → "אין לי את פרטי המחיר כרגע…" (deflect+pivot). 15:28 "איפה אני יכול לראות את המחיר?" → "אין לי את המחירון מולי…" (deflect). 15:29 "אתה יודע איפה אני יכול לברר לגבי תשלום?" → ignores, re-asks the confirm. **Zero `pending_owner_questions` rows for ג׳וני.** Owner (+972543503704) was active today (12:04 address update, 17:05 service change) — never pinged. **Control:** the *same* relay fired end-to-end earlier today for a *different* phone (+972546372400) — two `pending_owner_questions` rows (07:56, 07:58), owner answered. **Plumbing works; the decision didn't.**

**Root (structural):** the relay fires **only when the LLM emits the `[[ASK_STUDIO]]` sentinel** — the decision to escalate is fully delegated to the model's self-assessment — and the facts framing actively discourages the sentinel for price, with no system-level safety net:
- **Facts framed as a steering constraint, not a gap.** `buildBusinessFacts` (`src/domain/flows/customer-booking.ts:957-961`) emits, when price is unset: `'no price on record — do NOT quote a price'`. The model reads this as "I know the answer (there's no price) → steer," not "I cannot answer this → emit `[[ASK_STUDIO]]`." So it deflects instead of relaying.
- **Relay decision is LLM-only.** Inquiry/unknown paths inject `ASK_STUDIO_INSTRUCTION` and `relayUnansweredToOwner` is invoked only on the sentinel (`customer-booking.ts` ~1634-1656, ~1745-1759). The substance/dedup/rate throttle in `escalation/engine.ts:182-198` would have *passed* this question — it was simply never reached, because no sentinel was emitted.
- **No repeated-unmet-need escalation.** The session tracks consecutive `unknown` intents (`sessionUnknownCount`, `customer-booking.ts:~1441/1702`) but a price question classifies as `inquiry`, so re-asking it three times increments no counter and triggers no escalation. The deflection is identical each turn.
- **`fd1b2eb` ("steer first, relay rarely", H15)** set the policy bias toward deflection and assumed the model would self-detect gaps — exactly the assumption that fails for structured-data gaps like an unset price.

> **Single-sentence root:** escalation is an LLM-discretion event gated on a self-emitted sentinel, and for a missing structured fact (price) the facts string tells the model to steer rather than admit it can't answer, so a clear, repeated, escalation-worthy question dead-ends with no deterministic safety net (neither a structured-gap detector nor a repeated-unmet-need trigger).

---

## 3. The unifying root (why these are one disease, not three)

All three trace to the **same architectural seam**: the system defends a set of **enumerated** failure surfaces (a negation token list; a whole-day occupancy phrasing; an LLM-emitted escalation sentinel), and each symptom re-entered through the **adjacent un-enumerated surface**:

- P1: negation list didn't enumerate *decline verbs*; the confirm handler didn't enumerate *question-type*; Gate-4 didn't enumerate *causal claims*.
- P2: the occupancy gate enumerated *whole-day* emptiness and *any-time-present*, not *whole-service-on-a-day* emptiness or *day-matched* times.
- P3: escalation enumerated *model-self-reported* gaps, not *structured-data* gaps or *repeated-unmet-need*.

This is precisely the **two-tier limitation** ANTI_FABRICATION.md §10 warns about (gate the enumerable; ground+throttle the rest) — but the boundary of "the enumerable" was drawn too tight, and the **grounding/scope mismatch** (P2) plus the **intent-resolution lexicalism** (P1) plus the **LLM-discretion escalation** (P3) are three faces of *the deterministic core deferring a judgment to a narrow lexical proxy or to the LLM, with no scope-matched verification behind it.*

This maps to the original bughunt vocabulary: **P1 = intent/confirmation integrity (P-family confirm-scope)**, **P2 = occupancy/availability grounding (P2/P-occupancy)**, **P3 = knowledge-gap routing (P-escalation)**. The fix must raise the *floor* (deterministic, scope-matched checks) rather than widen each lexical allowlist by one entry.

---

## 4. What is NOT a regression (kept distinct)

- **Mechanical voice tells (X2)** — numbered menus, stacked either/or, dead-ends — are **monitor-only by design** (§D: `observeVoiceTells` logs `[voice-gate]`, regen behind an OFF flag). So their *presence* is an expected gap, **not** a new regression. BUT: in P1 the stacked either/or *question* and in P3 the dead-end deflection were the proximate triggers of real harm. The voice gate being monitor-only is a (c) gap; the *harm it permitted* is the (b) regression. Recommend re-classifying "dead-end on an unanswerable" and "either/or as a hold-confirm prompt" from cosmetic to functional.
- **am/pm 12h gating (D2), entity/service output gating (D5), proactive-door time gating (D3)** — not implicated here; do not touch.
- **WS5 / hung-LLM, Tier-0 kill-switch/cost** — not the cause of any of P1–P3 (all three got prompt replies). X1 (telemetry) is the one Tier-0 item that *is* now blocking.

---

## 5. Open verification items for the red-team

1. Confirm `intent.slotRequest` carried a specific time (12:00) vs a `timeOfDay` bucket for the "Pilates ב 12" turn (determines whether F2a was even eligible). Hypothesis: specific time → F2a ineligible.
2. Confirm whether `opts.focusDay` was populated on the P2 turn (if not, Gate-3a was doubly dead).
3. Confirm P1's either/or prompt did not set any `pendingPromptType` (none exists today — that's the point).
4. Confirm the price question classified as `inquiry` (not `unknown`) — both paths inject the sentinel, so classification doesn't change the root, but it pins which prompt string was live.
