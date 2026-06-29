# Three-Symptom Remediation Plan (post-upgrade live test)

**Status:** awaiting owner approval. No code written yet.
**Source:** live-test transcripts (3 screenshots) + read-only root-cause investigation, 2026-06-29.
**Relationship to prior work:** extends `2026-06-28-pa-hardening-master-plan.md`. Symptoms 1 & 2 are **holes left by** Phase-0 work that shipped (the booking/class path was fixed; its twins — the waitlist-offer path, the inquiry path, and the affirmation parser — were not). Symptom 3 is **unscoped** by that plan.

**Unifying disease:** the conversational/LLM layer is permitted to **assert facts, availability, or completed actions the deterministic core never produced or can't back.** Each symptom is one instance. A broader audit of this disease is launched separately (`docs/superpowers/prompts/2026-06-29-fabrication-surface-audit-prompt.md`); this plan fixes the three confirmed instances and adds the missing gate class that makes the pattern non-recurring.

**Engineering rules (inherited):** TDD per task (red→green→commit); `customer-booking.ts` is a single-writer hot file — serialize tasks on it; every customer/owner-visible string passes the `CHAT_LEVEL_LAWBOOK.md` voice gate; the DO-NOT-REGRESS guards **G1** (available booking never wrongly rejected), **G4** (day/time resolution, label==date), **G5** (no-invention), **C-PIVOT** (mid-flow pivot) stay green on every commit.

---

## SYMPTOM 1 — books loop: confirms 3–4×, never commits, slot drifts to a later date

**Problem (observed):** A customer accepts a yoga slot ("today 16:00"), is asked to confirm 3–4 times with changing wording ("to book?" → "it's the only time, suits you?" → "to close this?"), the booking never commits, and the slot silently drifts to **Sunday July 5**. The customer ends up asking "am I registered?" — and may in fact be booked, stranded, or about to be double-/wrong-day-booked. (False state asserted in front of the customer + calendar-integrity risk.)

### Roots
| ID | Root | Evidence |
|---|---|---|
| **R1** (primary) | The "a spot opened" message is a **waitlist worker offer that wires up no session state**, and **nothing consumes the reply**. The customer's "yes" lands on a session with no pending hold → falls through to fresh intent extraction. | `workers/waitlist.ts:263-314` (only flips row to `offered`); dispatch falls to `customer-booking.ts:1105`; no consumer of `waitlist.status='offered'` |
| **R2** | `parseConfirmation` only accepts an affirmative as the **whole message or the first word**. Real replies "תשמור לי כן" / "…כן אני מעוניינת" → `'unclear'` → re-ask without committing. | `flows/types.ts:73-89` (anchored `YES_PATTERNS`; `words[0]` gate at :78); re-ask at `customer-booking.ts:2393` |
| **R3** | **Handler-bounce.** When a re-run `requestBooking` returns `!ok`, the session flips to `waiting_clarification`; the next "yes" routes to `handleClarification`, which re-extracts intent and re-asks (fresh wording) instead of committing. | `customer-booking.ts:2602` (sets clarification) → `:1101` (clarification handler); `engine.ts:199` (`no_class_at_time`) |
| **R3b** | The duplicate-customer guard result **"You're already booked into this class"** is laundered through the generic `!ok` re-offer path into a false "that's unavailable — here's another time/date." | `engine.ts:639`; no duplicate-case branch in `customer-booking.ts:2560-2634` |
| **R4** | **Date drift.** Top-of-turn `lastOfferedSlots → rejectedSlots` promotion suppresses today-16:00; `suggestNextClassesText` then walks forward to the next open class (July 5) and rewrites it as the pending slot. | `customer-booking.ts:912-916`, `:2589-2591`, forward-walk `:529-536` |
| (structural) | **Two confirm-ask shapes:** Path A asks "confirm?" with **no hold placed**; Path B places the hold and asks again. An appointment-twin resolution forces a **double-confirm**, and Path A leaves the slot **unprotected** between ask and "yes." | Path A `customer-booking.ts:2202-2216`; Path B `:2685-2691` |

### Fix
1. **F1a — windowed `parseConfirmation` (cheap, highest impact).** Accept an affirmative token **anywhere** in a short reply (≤ ~6 tokens) when no negation token and no revision signal (clock time / different day / different service) is present. Golden tests: "תשמור לי כן", "כן אני מעוניינת" → `yes`; "כן אבל לא" → not-yes; "כן, אפשר ביום חמישי?" → revision/pivot, not auto-confirm. *(File: `types.ts` — isolated, do first.)*
2. **F1b — single confirm state with a real hold. [OWNER-APPROVED 2026-06-29]** Collapse Path A/Path B: **place the hold at the first confirm-ask** so there is always one `waiting_confirmation` state with `pendingBookingId` set and the slot genuinely reserved while waiting. The "yes" path then always commits via `confirmBooking` — no double-confirm, no unprotected window. The seat is briefly held during confirmation (auto-expires via the existing hold-expiry worker if the customer never confirms) — owner accepts this trade-off for a near-full class.
3. **F1c — wire the waitlist/reshuffle offer to a real pending state.** On offer, place the hold and set the customer session's pending-hold (or a typed `pendingDecision` per T3.2) bound to that exact slot; add an inbound consumer so a "yes" to a `waitlist='offered'` row binds and commits. *(Files: `workers/waitlist.ts`, `routes/webhook.ts`, `customer-booking.ts`.)*
4. **F1d — honest duplicate handling.** Special-case the engine's "already booked" result: reply "you're already booked for <service> on <date> at <time>" (reassurance), **never** the unavailable re-offer. If the customer is mid-confirm on a slot they already hold, treat "yes" as confirming the existing booking. *(Files: `engine.ts` result contract, `customer-booking.ts`.)*
5. **F1e — no silent date drift.** Do not promote a slot the customer is actively confirming into `rejectedSlots`; if the requested slot is genuinely gone, **name the change** and require a fresh affirmation ("today's 16:00 just filled — next yoga is Sun 5 Jul 16:00, want that instead?"). *(File: `customer-booking.ts:912-916` and the substitute path.)*

---

## SYMPTOM 2 — single-time miss reported as a whole-day-empty day

**Problem (observed):** Asked about a specific time with no class (e.g. Tuesday 15:00), the PA correctly says "no class at 15:00; there are 10:00/12:00/16:00" **only when a concrete time is given**. On a vaguer follow-up ("next Tuesday at a different hour?") it asserts "no yoga classes **at all** that day" (false — the day has classes) and jumps straight to other days instead of offering the same-day alternative hours first.

### Roots
| ID | Root | Evidence |
|---|---|---|
| **R5** | `assertsNoAvailability` detects only **capacity-full** phrasing, never **schedule-empty** ("אין שיעורי יוגה"). So Gate 3's mandatory fresh-spine re-read **never fires** for the wording the model actually emits. The T2.2 "BUG-C / time-scoped negative" work was never landed. | `flows/slot-fabrication-guard.ts:107-127` |
| **R6** (core) | The **inquiry path** has no time-miss-vs-day-empty distinction and no same-day-first re-offer. `buildDayOptionsText` is fed `timeOfDay` (a bucket), not the specific time; an empty focal day jumps straight to `suggestNextClassesText` across other days. The correct `classOfferSituation` (same-day-first) is used **only on the booking path**. | `customer-booking.ts:1275-1299`; `classOfferSituation` call-sites are booking-path only |
| **R7** (contributor) | The LLM routes a vague time-question to `inquiry` (weak path) vs a concrete time to `booking` (correct path) — which is exactly why message 1 was right and 3/5 wrong. | intent routing `customer-booking.ts:1198-1219` |
| **R8** (latent) | The day-scoped guard keys on the **weekday token** (`שלישי`), collapsing two different Tuesdays into one key. Date *resolution* itself is correct. | `slot-fabrication-guard.ts:142-150` |

### Fix
1. **F2a — route the inquiry path through the booking path's same-day-first logic.** Pass the specific requested time into `buildDayOptionsText` so the inquiry path can emit a **time-scoped negative** ("no class at 15:00; today's classes are 10/12/16") and offer **same-day alternatives first**; only when the same day is genuinely empty fall back to `suggestNextClassesText`. (Closes R6 and neutralises R7 — the inquiry path becomes correct regardless of routing.) *(File: `customer-booking.ts`.)*
2. **F2b — schedule-empty detector.** Broaden `assertsNoAvailability` to schedule-empty phrasing ("אין שיעור(ים)", "no classes", "none scheduled"), **windowed/context-aware** (per the T2.2 v3 lesson — don't launder a *correct* empty-day statement; the gate still only regenerates when the fresh spine shows the referenced day is genuinely open). *(File: `slot-fabrication-guard.ts`.)*
3. **F2c — date-keyed day-scoping (R8).** Key `extractDayScopedTimes`/`daysShareOpenTime` on the resolved date (or carry the resolved focus date), so two Tuesdays don't collide. *(File: `slot-fabrication-guard.ts`.)*

---

## SYMPTOM 3 — fabricated escalation ("I asked the owner" — but it didn't)

**Problem (observed):** Customer asks a knowledge question the PA can't answer (mat vs apparatus Pilates). The PA says it will check / claims it checked and has no info / offers "a guide will get back to you" — but **no owner message is ever sent**, and there is no mechanism to relay an answer back. A false claim of an action taken.

### Roots
| ID | Root | Evidence |
|---|---|---|
| **R9** (primary) | **No customer→owner question-relay capability exists.** The only owner-notify paths are `maybeEscalateSpecial` (gated on `specialArrangementRequest`) and `checkOwnerEscalationRules` (requires a *configured* rule). A knowledge question matches neither, so no message is dispatched. | `customer-booking.ts:1675`; `escalation/engine.ts:40` |
| **R10** | **Prompts induce the fabrication.** The global system prompt instructs the model to "say… you'll check with the business" on every Branch-4 reply, plus per-situation echoes — with no backing dispatch. | `client.ts:382` (global); `customer-booking.ts:874`, `:1320`, `:1419`, `:2493` |
| **R11** | **No round-trip state.** No `pendingOwnerQuestion`/awaiting-answer concept; `escalatedTasks` is write-only, read **only by the operator dashboard**, with no field for an owner's answer and no path back to the customer. | `schema.ts:1072-1093`; reads only in `flows/operator.ts` |

### Fix — build the FULL round-trip (owner-confirmed 2026-06-29: outbound ask **and** answer relay-back are both in scope; an outbound-only ask is itself a fabrication)

1. **F3a — real ask-the-owner question-relay (new capability, COMPLETE LOOP).** Five parts, all required:
   - **(i) Outbound ask.** When the PA can't ground an answer and the customer opts in, **enqueue an actual WhatsApp message to the manager** with the customer's question + context (customer display name/phone, the verbatim question, the service/topic if known). Reuse `dispatchInitiation` + the `escalation/engine.ts` machinery and the durable send queue (T1.10 pattern — the dedup key never burns without delivery).
   - **(ii) Durable state.** New DB table **`pending_owner_questions`**: `id, businessId, customerId, customerPhone, questionText, status ('pending'|'answered'|'expired'|'closed'), askedManagerId, answerText (nullable), createdAt, answeredAt`. A DB row (not session context) because it must survive across sessions and link a *later* owner reply. At most one open `pending` per (business, customer) at a time — a second question supersedes or appends.
   - **(iii) Honest customer reply.** Tell the customer the **truth**: "I've passed your question to <studio> — they'll get back to you shortly." Never "I checked and have no info" (that's the current fabrication). Gate this wording behind the actual successful dispatch (Gate 4).
   - **(iv) Owner-reply binding (the hard part).** The manager answers in **Branch 3** (the native function-calling orchestrator). Surface open `pending_owner_questions` into the orchestrator's context, and add an orchestrator **tool `answerCustomerQuestion(questionId, answerText)`** so the manager can answer conversationally ("tell her it's apparatus-based") and the model binds it to the open question deterministically. Disambiguation: when exactly one open question exists, the orchestrator may bind a free-text manager answer to it (with a one-line confirmation); when several are open, the tool requires the model to pick by customer/topic. The outbound ask (i) should quote the question so the owner's reply is unambiguous.
   - **(v) Relay-back + resolve.** On `answerCustomerQuestion`, send the customer a **proactive outbound** carrying the owner's answer (in the customer's language; the manager's wording is relayed/lightly phrased, never invented), mark the row `answered`, and confirm to the manager that the customer was told. The customer may be in a different/no session by then — it's a proactive initiation like the waitlist offer.
   - **(vi) Expiry.** A worker (mirror `coordination-expiry`) expires `pending` rows older than `OWNER_QUESTION_EXPIRY_HOURS` (default 72) → `expired`, so nothing dangles forever; optionally nudge the owner once before expiry. The customer was only ever told "they'll get back to you," so an expiry needs no customer message unless we choose a soft "still waiting on the studio" — decide at build time.
   *(Files: `escalation/engine.ts`, new `db/schema.ts` table + migration, `customer-booking.ts` (escalate decision + honest reply), `adapters/llm/orchestrator.ts` (+ new tool), `routes/webhook.ts` (manager-reply routing already exists — bind there), new `workers/owner-question-expiry.ts`, `i18n/t.ts` for the relay/ask templates.)*
2. **F3b — stop inducing the fabrication.** Replace the `client.ts:382` global instruction and its echoes: when there is no grounded answer **and** no escalation has fired, the model must say honestly it doesn't have that info and **offer** to have the studio follow up — which **triggers F3a(i)** — never assert a check/escalation that didn't happen. *(Files: `client.ts`, `customer-booking.ts` situation strings.)*

---

## CROSS-CUTTING — close the disease, not just the instances

**New Gate 4 — action/escalation fabrication.** Mirror the `bookingConfirmed`-exempt pattern: a reply may claim an action (asked owner / escalated / notified / added to waitlist / passed it on) **only** when the corresponding deterministic dispatch succeeded this turn (an `escalationPerformed`/`actionPerformed` flag passed into `makeGenReply`). Otherwise the action-claim is gated/regenerated. This makes S3's class of fabrication structurally impossible going forward, and is the deterministic backstop the broader audit will extend. *(Files: `reply-guard.ts` or `voice-guard.ts` + `makeGenReply`; `ANTI_FABRICATION.md` doctrine update.)*

---

## EXECUTION ORDER (serialized on the `customer-booking.ts` hot file)

1. **F1a** — `parseConfirmation` (`types.ts`, isolated). *Cheap, unblocks the most visible symptom.*
2. **F2b + F2c** — `slot-fabrication-guard.ts` (schedule-empty detector + date-keyed scoping).
3. **F2a** — inquiry-path same-day-first (`customer-booking.ts`).
4. **F1d + F1b** — engine duplicate-result contract + single-hold confirm state (`engine.ts`, `customer-booking.ts`).
5. **F1c** — waitlist-offer pending state + inbound consumer (`waitlist.ts`, `webhook.ts`, `customer-booking.ts`).
6. **F1e** — no silent date drift (`customer-booking.ts`).
7. **F3a + F3b** — ask-the-owner relay + de-fabricate prompts (`escalation/engine.ts`, schema, `webhook.ts`, `orchestrator.ts`, `client.ts`, `customer-booking.ts`).
8. **Gate 4** — action-fabrication gate (last, so it catches anything the above introduce).

## HARD REGRESSION VERIFICATION (owner-mandated 2026-06-29 — a blocking gate, not best-effort)

**Principle:** no step proceeds, and nothing merges, until regressions are *proven absent* by command output — not asserted. Evidence before claims.

**B0 — Baseline (before touching any code).** Capture and record, on the starting commit: `npm test` (full pass/fail + counts), `npx tsc --noEmit`, `npx eslint src`. If anything is already red, log it as a **known-preexisting** failure so our work is never blamed for it and a *new* red is unambiguous. Identify and name the concrete files that encode **G1 / G4 / G5 / C-PIVOT** so the per-task attestation references real files, not self-report.

**Per-task gate (every task, in order).** A task may commit only when ALL hold:
1. Its own new test went **red → green** (TDD; paste both outputs in the commit/PR notes).
2. **Full `npm test` is green** (or differs from B0 only by intended additions — diff the counts; any newly-red prior test blocks the commit).
3. `npx tsc --noEmit` clean; `npx eslint` clean on touched files.
4. The **G1/G4/G5/C-PIVOT** files are green (named, run explicitly).
5. **Voice gate** applied to any changed customer/owner-visible string.

**Transcript-replay regressions (permanent, CI-pinned).** Encode all three live-test transcripts as integration tests asserting the *corrected* behavior — these are the proof the reported symptoms are dead and stay dead:
- **S1** — an affirmation (bare, embedded, or sentence-form: "כן", "תשמור לי כן", "…כן אני מעוניינת") commits **exactly one** booking, with **no re-ask** and **no silent date drift**; an "already booked" reply reassures, never re-offers a different date.
- **S2** — a single-time miss yields a **time-scoped negative + same-day alternatives first**, never a false whole-day-empty; a genuinely empty day still substitutes another day correctly (no false negative either direction).
- **S3** — a knowledge-gap escalation (a) **sends a real owner message** (assert the dispatch/enqueue fired), (b) **never asserts an un-performed check**, and (c) **relays the owner's answer back** to the customer and resolves the `pending_owner_questions` row (full round-trip asserted end-to-end).

**New invariants (CI tests, guard against re-introduction).**
- **P8′** — an affirmation binds to the live pending hold and commits.
- **P4′** — every (un)availability claim is spine-backed AND time/day-scoped.
- **P9** — every action/escalation claim has a successful deterministic dispatch this turn (Gate 4 non-bypass).

**Phase exit gate (before merge/deploy).** Full `npm test` + `tsc` + lint green; S1/S2/S3 + P8′/P4′/P9 green; G1/G4/G5/C-PIVOT green; a manual smoke of the three transcript scenarios reproduced-then-fixed; PR description carries the B0-vs-final test-count diff and the named-guard evidence. Optional but recommended: a `/code-review ultra` pass per the master plan's protocol before merge.

## OUT OF SCOPE (this plan)
- Catalog cleanup of the duplicate `yoga` (class twin + appointment twin) — owner-driven via the PA; this plan only adds code resilience (single-hold confirm, class-twin preference already in `resolveService`).
- The broader fabrication-surface audit — separate session (see the audit prompt); its findings will extend Gate 4 and may add Gate 5+.
- Payments.
