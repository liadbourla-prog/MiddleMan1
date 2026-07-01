# Branch-4 Root-Fix Plan — 2026-06-30 (targets v1.0.108 live-test findings)

**Status:** RED-TEAMED (plan-feasibility pass folded in 2026-06-30) — ready to build in separate phased sessions (the proven loop).
**Sources:** `reviews/2026-06-30-branch4-livetest-findings.md` + `reviews/2026-06-30-branch4-livetest-REDTEAM.md`.
**Baseline:** v1.0.108 = 1700 tests / 158 files green. **No code is written in the planning session.**

> ### Plan red-team — what changed (three fresh-eyes agents stress-tested each mechanism against the code)
> Three "infeasible-as-written" catches + one scope fix were folded into the tasks below. Read these before building:
> - **P1/T1.2 was infeasible** — the either/or confirm prompt is **LLM-authored** (situation `customer-booking.ts:2594-2599` just says "ask them to confirm"), so there is no template to tag with `pendingPromptType` at emit time. **Redesigned:** constrain the confirm prompt to a single yes/no shape + make **T1.1 the load-bearing deterministic catch**; an optional post-hoc shape-classifier is the fallback. **T1.1 must also cover `classifyConfirmWithQuestion`** (the `yes_with_question` path) or "כן תשחרר, מתי עוד יש?" still collapses to yes. **T1.3 → defense-in-depth** (needs booking `createdAt` in the ledger; real over-block risk; lower priority because T1.1+T1.2 prevent the book-against-decline upstream).
> - **P2 — confirmed good + one critical fix.** `focusDay` IS reliably populated (`bestEffortInquiryFocusDay:288-299`) and Gate-3a runs; T2.3 targets the right path. **Critical:** T2.3 must fix the **grounding builder** (`customer-booking.ts:1589-1612`) so the situation carries whole-service-that-day — gate-only is reactive and the model still confabulates from an empty situation. T2.1's spine signature change touches **all** `occupancySpine` callers (Branch 4 `output-gate.ts:290` **and** Branch 3 `orchestrator.ts:1484-1493`).
> - **P3/T3.1's deterministic signal doesn't exist** — intent extraction has no `inquiryTopic`; a price ask is just `intent='inquiry'` + free text. **Redesigned:** **T3.2 (repeated-unmet-need) becomes the PRIMARY topic-agnostic deterministic guarantee** (catches "asked 3×, never satisfied" without knowing the topic). The targeted single-ask escalation (T3.1) is **optional** and, if built, must explicitly budget a `CustomerIntentOutput.inquiryTopic` extraction change with its own LLM-eval gate. **PASS:** the escalation throttle won't drop a price escalation, and the honest "passed it to the studio" line is already a **code template** (`question_passed_to_studio` i18n) that bypasses Gate-4.

---

## 0. The one root this plan attacks

> **The deterministic core defers a judgment to a too-narrow lexical proxy or to the LLM, with no scope-matched verification behind it.**

- **P1** defers "did the customer confirm?" to a lexical windowed-yes whose negation list omits decline verbs, and to a handler blind to the pending prompt's shape.
- **P2** defers "is the day really empty?" to a grounding query narrowed by service+time and to an occupancy backstop whose escape heuristic is day-blind.
- **P3** defers "should I escalate?" to an LLM-emitted sentinel with no deterministic safety net.

The fixes **raise the deterministic floor** (scope-matched checks the core owns) rather than widen each lexical allowlist by one entry. Every task lands a **failing test that encodes the exact live transcript first** (TDD), so the §K symptoms can never silently return.

### Non-negotiables this plan must honor
- **DO-NOT-REGRESS:** S1 embedded-yes commit (`f871fcf`), S2 same-day-first (`16ed199`/`ce11cad`), G1/G5 "never fallback a legitimate offer," the seven chat gates, the unified-gate regen-cap / fail-to-safe-template invariants.
- **Locked decisions D1–D6 stand** (no am/pm 12h gate; no entity output gate; no time-enforcement on the proactive door). None are touched.
- **Voice Bible** governs every new template/string (first-person, warm, one question, always a next step, no bot-tells).
- **LLM interpretive-only:** every new check is deterministic core; the LLM never gains a new authority. Honest escalation/uncertainty replies stay **code templates** (so Gate-4 keeps owning their phrasing).
- **Verification asserts engine ground truth correct as of the event** (audit_log + transcript reconstruction), never a present-time SELECT; never trust a code-trace claim about a data state without confirming it in schema/data.

---

## Phase 0 (PREREQUISITE) — minimal grounding/gate telemetry (X1)

**Why first:** the red-team was blocked verifying P2 because the situation string and gate-fire decisions are not observable in prod (prod emits only Fastify request logs). Without this, every fix below ships blind and the next regression is invisible until a human reads a transcript.

**T0.1 — structured gate-decision log line.** At each of the three doors (Branch-4 `makeGenReply`, Branch-3 `gateAndAuditBranch3Reply`, proactive `gateProactiveBody`), emit one structured line per turn: `{ door, businessId, identityId, sessionId, intent, gatesFired:[…], regenCount, fellToTemplate:bool, focusDay, situationHadOpenTimes:bool }`. No message bodies (PII) — booleans + counts + ids only.
**T0.2 — make it queryable.** Ensure the logger level used reaches Cloud Logging (today app logs are filtered). One env-guarded logger; default ON in prod at info.
**Done when:** a Cloud Logging query for a known turn returns the gate-decision line; the P2 repro (Phase 2) can be confirmed from logs, not inference.
**Regression guard:** no body/PII in logs; no perf regression (one line/turn).

> **PHASE 0 REVIEW — gate before Phase 1:** confirm no PII, confirm queryable in prod, confirm the line distinguishes "grounding empty" from "gate skipped" (the exact P2 ambiguity).

---

## Phase 1 (CRITICAL) — P1 confirmation integrity

**Symptom:** "כן תשחרר" (yes, release) created booking `72357b9a` (2026-07-05 18:00) against an explicit decline; then "just as you asked to release, it already went through" fabricated a race.

### T1.1 — decline-verb precedence in `parseConfirmation`
**File:** `src/domain/flows/types.ts:59-86` (+ `NEG_TOKEN` 26-27, `AFFIRM_WORDS` 33-36).
**Root:** the windowed-yes path (line 72) returns `'yes'` on an embedded `כן` because `תשחרר`/release/decline verbs are neither in `NEG_TOKEN` nor a revision signal.
**Approach (conceptual):** add a **decline-class** detector and a **precedence rule**: when a decline token co-occurs with an affirm token in the same message, the decline wins → return `'no'` (or `'unclear'` if genuinely mixed). Closed lexical class like the existing negation list, capturing the *semantic-decline verb* `f871fcf` left out.
**Conservative lexicon (regression-verified):** ship the **שחרר family first** — שחרר/תשחרר/לשחרר/אשחרר/שחרור + unambiguous English (release, free it up, let it go, drop it, never mind, pass). This directly fixes the live "כן תשחרר" with **zero** flips to the existing 'yes' corpus (`types.test.ts:79-160` verified clean). **DEFER ambiguous tokens (עזוב, ותר, אין צורך)** to a follow-up behind their own tests — "עזוב, כן" can mean "never mind [that], yes."
**MUST ALSO cover the `yes_with_question` path (red-team catch):** the same decline-precedence must be applied in **`classifyConfirmWithQuestion`** (`types.ts:~200+`) — otherwise "כן תשחרר, מתי עוד יש?" is classified `yes_with_question`, and when the held day matches it collapses to `'yes'` and books. A decline token must veto the confirm even on a same-day question.
**Failing tests first (encode the transcript):** `parseConfirmation('כן תשחרר') !== 'yes'` (expect `'no'`) AND `classifyConfirmWithQuestion('כן תשחרר, מתי עוד יש?', heldWeekday)` returns `'revise'`/decline (not `'confirm'`).
**Regression guard (must stay green):** the S1 cases `f871fcf` added — `'תשמור לי כן' → 'yes'`, `'…כן אני מעוניינת' → 'yes'`, `'כן אבל יום שלישי' → 'unclear'` (revision). Add both polarities in the same test file so the precedence can't over-reach.
**Done when:** decline-with-embedded-yes resolves to no/unclear on BOTH `parseConfirmation` and the `yes_with_question` path; all embedded-yes confirms still resolve to yes.

### T1.2 — REDESIGNED: prevent the ambiguous confirm prompt at the source (red-team: pre-tagging is infeasible)
**Why redesigned:** the original "persist `pendingPromptType` when the prompt is emitted" is infeasible — the hold-confirm prompt is **LLM-authored** (the situation at `customer-booking.ts:2594-2599` says only "Restate … then ask them to confirm"); the system never decides to ask an either/or, so there is nothing to tag at emit time. The system only learns the shape *after* the LLM replies.
**Files:** the hold-confirm situation string (`customer-booking.ts:2594-2599`); optionally a post-emit classifier + `conversation_sessions.context`.
**Root:** an either/or confirm prompt makes a bare "yes" semantically void; the system can't disambiguate.
**Approach (primary — constrain the prompt shape):** tighten the situation instruction so the confirm is **always a single yes/no** ("Ask ONE clear yes/no confirmation of this exact slot. Do NOT stack a second question or offer an either/or."). This removes the ambiguity at the source AND satisfies the Voice-Bible one-question rule — the same stacked-question that caused P1. **T1.1 remains the deterministic catch** for when the customer declines with an embedded yes regardless of prompt shape.
**Approach (fallback — only if the LLM still stacks):** after the confirm reply is generated and before send, run a cheap **shape classifier** (regex for "… או …?" / "or …?" two-arm) on the *emitted* reply; if it's an either/or, persist `pendingPromptType:'either_or'` to context, and on the next turn a bare yes/no → re-ask naming the options. This is the reactive version of the original idea, hooked at the only point the shape is known.
**Failing test first:** the hold-confirm situation/prompt for a held slot contains a single yes/no ask (no "או"/"or" two-arm); and (fallback path) an either/or reply tags `pendingPromptType:'either_or'` so a subsequent bare "כן" re-asks instead of booking.
**Regression guard:** `yes_no` confirms still one-yes-one-confirm (`071bf93`); no extra ask on "shall I book? → yes"; no Voice regression (the constrained prompt must still be warm/first-person).
**Done when:** the confirm prompt is reliably a single yes/no, and even if an either/or slips through, a bare yes cannot silently book.

### T1.3 — DEFENSE-IN-DEPTH: causal/status-framing gate (the "already went through" lie)
**Priority note (red-team):** lower than T1.1/T1.2. Once T1.1 + the redesigned T1.2 stop the book-against-decline, the "already went through" reply is **never generated** (the system declines/re-asks instead of booking). Keep T1.3 as a backstop, but it is not load-bearing — and it carries real over-block risk, so build it last in this phase and only if cheap.
**File:** `src/domain/grounding/output-gate.ts` (new check beside Gate-3b/Gate-4, ~327-345).
**Root:** `unbackedActionClaims` only checks that an action *class* is backed; a *true* booking carrying a **false causal/temporal narrative** ("already went through", "just as you asked…") passes.
**Red-team constraints on feasibility:** the gate only receives `reply + language + ledger` — no session history, no audit timestamp. To distinguish the lie from an honest "already booked," **plumb the pending booking's `createdAt` into the ledger** so the gate can tell "this booking was created *this turn*" from "a prior confirmation." Without that signal a pure regex will over-block honest "your spot is already booked" replies referring to a real prior booking.
**Approach:** a **narrow** detector — flag only when the reply asserts a *prior/coincident* registration ("כבר עבר"/"already went through"/"just as you…") AND the ledger shows the booking was created this same turn. On hit → regenerate to state only what the system did; fail to SAFE template on persistence.
**Failing test first:** "בדיוק כשביקשת לשחרר, הרישום שלך כבר עבר" with a this-turn booking → flagged/regenerated; "המקום שלך כבר שמור" with a *prior-turn* booking → passes.
**Regression guard:** golden-shape confirmations ("קבעתי לך פילאטיס ל-18:00") pass; no over-block of honest prior-booking reassurances.
**Done when:** a this-turn fabricated race/prior-registration story is caught; honest confirmations and genuine prior-booking reassurances pass.

> **PHASE 1 REVIEW — 2 reviewers:** verify T1.1 precedence doesn't resurrect the S1 confirm-loop; verify T1.2 default `yes_no` doesn't add asks; verify T1.3 detector is narrow. Re-run the full suite + the new repro tests.

---

## Phase 2 — P2 scope-matched occupancy grounding (§K "Sunday full")

**Symptom:** "Pilates at 12" (no such slot) → "all Sunday Pilates taken" + invented "calendar shift" + cascading scarcity, while Pilates 9/11/14/18 were free.

### T2.1 — occupancy backstop queries the WHOLE DAY, scope-independent
**Files:** `customer-booking.ts:1166-1176` (`dayHasOpenOptions`), the `ledger.occupancySpine` callback + type (`turn-ledger.ts:~30-33`), `output-gate.ts:286-307` (Gate-3a). **Signature change touches ALL callers (red-team):** update the Branch-4 site (`output-gate.ts:290`) AND the Branch-3 site (`orchestrator.ts:1484-1493`) — do not leave a caller on the old `{open}` shape.
**Root:** the spine mirrors the turn's service+time filter, so a service that has no slot at the asked time reads "empty" even when the day has that service at other times (and other services besides).
**Approach:** when verifying an occupancy claim, the spine must read the **whole requested day** and expose two signals — `openOverall` (any service open that day) and `openInService` (the named service open that day, unfiltered by time) — replacing the single `open`. Gate-3a fires when the reply asserts no-availability but **either** signal is open and the reply doesn't surface a *same-day* alternative.
**Failing test first:** focusDay = Sunday, serviceTypeId = Pilates; reply "all Pilates taken Sunday"; spine whole-day shows Pilates 9/11/14/18 → gate regenerates with the real times.
**Regression guard:** class-mode still answers from CLASSES not gaps (no "fully booked while classes exist"); appointment focus still uses gaps.

### T2.2 — `replySurfacesAnyTime` becomes day-aware
**File:** `output-gate.ts:216` (+ call sites 289/301).
**Root:** `replySurfacesAnyTime = extractClockTimes(text).length>0` — a time on the *wrong day* defeats the backstop.
**Approach:** the escape heuristic must check whether the reply surfaces a time **on the focus day** (day-scoped extraction keyed to `focusDay.dateStr`), not any time anywhere. A reply that says "Sunday full, but 14:00 *today*" no longer counts as surfacing Sunday availability.
**Failing test first:** reply asserts Sunday-full and offers only *Tuesday* times → `replySurfacesAnyTime(focusDay=Sunday)` is false → Gate-3a runs.
**Regression guard (G1/G5):** a correct same-day negative ("no 12, but 14:00 that same Sunday") still counts as surfacing → no needless fallback.

### T2.3 — PRIMARY/PREVENTIVE: fix the grounding BUILDER, not only the gate (red-team critical catch)
**Scope decision (explicit, per red-team):** T2.3 changes the **grounding builder itself** so the situation string carries whole-service-that-day on a specific-time miss. T2.1/T2.2 (the gate) are the **backstop**; T2.3 is the **preventive** fix. Gate-only would be reactive — the model would still generate from an empty/narrow situation and confabulate before the gate ever re-grounds. Build T2.3 as the primary; keep T2.1/T2.2 so a future narrow-situation can't lie.
**Files:** `customer-booking.ts:1589-1593` (the `buildDayOptionsText(..., inquiryService?.id, ..., timeOfDay, ...)` call) **+ the fallback paths `1594-1612`** (`suggestNextClassesText`/`buildInquiryAvailabilityText` — today they offer next-day/other-day, NOT the same-day whole-service set); `day-options.ts:99-120`.
**Root:** a service+time(-bucket) query narrows the situation to empty *before* the gate sees it (`situationHasOpen=false`), and the fallbacks pivot to other days, so the model free-associates "all full" + other-day offers from a sparse situation.
**Approach:** on a service+specific-time miss, **do not narrow the day to empty** — the situation must carry the **whole-service-that-day** options ("no Pilates at 12, but Pilates is at 9/11/14/18; Yoga is at 12") and a cross-service alternative when the asked service is absent at that time. Re-anchor follow-up turns to the originally-enumerated real times (`lastInquiryFocus`/ledger already tracks the day) so a later "last spot at 09:00" is validated, not invented.
**Verify the intent shape first (red-team caveat):** confirm whether "Pilates at 12" sets `slotRequest.time=12:00` only, or also `timeOfDay='afternoon'` — the narrowing path differs (`timeOfDay` triggers bucket-filtering at `1590`; `time`-only does not). Use the Phase-0 telemetry / a repro to confirm before coding.
**Failing test first:** intent {service: Pilates, time: 12:00, day: Sunday} → situation contains "Pilates 9/11/14/18" (+ "Yoga 12") and never an empty/whole-service-full assertion; the reply never says "all Pilates full" nor pivots to other days when same-day options exist.
**Regression guard:** the same-day-first F2a bucket path (`16ed199`) still works for time-of-day buckets; the class-mode "answer from classes not gaps" behavior is preserved; no double-offer.

> **PHASE 2 REVIEW — 2 reviewers + repro from Phase-0 logs:** confirm (from the new telemetry, not inference) whether the live failure was grounding-empty or gate-blind — fix whichever the log proves, keep both guards. Verify no "fully booked while classes exist" regression.

---

## Phase 3 — P3 deterministic escalation safety net

**Symptom:** price asked 3× (genuinely null at test time) → 3 dead-end deflections, owner never pinged; the relay plumbing worked for another phone the same day.

### T3.2 — PRIMARY: repeated-unmet-need trigger (topic-agnostic deterministic guarantee)
**Why primary (red-team):** this needs **no** intent-extraction change — it catches "asked, not satisfied, asked again" without knowing the topic is price. It is the deterministic floor that makes P3 hold even for gaps we don't enumerate.
**Files:** `conversation_sessions.context` (a new jsonb counter — no migration), the inquiry/unknown paths (`customer-booking.ts:~1533-1658 / ~1690-1779`).
**Root:** re-asking the same unanswered info-need 3× produced 3 identical deflections; `sessionUnknownCount` resets on every non-`unknown` intent (`customer-booking.ts:1441`) and a price question is `inquiry`, so it never counts.
**Approach:** track per-session **repeated unmet info-need** in context (`lastInquiryKey` + `inquiryRepeatCount`). When an `inquiry`/`unknown` turn does not resolve the ask (no FAQ/fact answered it) and the next turn repeats a *similar* ask, increment; on the **2nd recurrence** → route to the honest escalation **code template** (`question_passed_to_studio`) + create the `pending_owner_questions` row via `escalateCustomerQuestion`.
**Failing test first:** same unmet side-question asked twice → escalation (one `pending_owner_questions` row) on the 2nd, not a 3rd identical deflection.
**Regression guard (red-team — dedup is fragile):** a *different* question each turn must NOT count (only an unmet *repeat*); a *related follow-up* ("what's the price?" → "any discount?") must not be treated as the same ask and over-escalate. Honors the "relay rarely" anti-fab intent — bounded exception, not a reversal. Throttle (`engine.ts:182-210`) still dedups/rate-limits (PASS verified: substance/dedup/rate are permissive for this case).

### T3.1 — OPTIONAL: single-ask escalation on a null structured-fact (needs an intent-extraction change — budget it explicitly)
**Status (red-team):** the deterministic signal "the customer asked for price" **does not exist** — `CustomerIntentOutput` has no `inquiryTopic`. So T3.1 is **optional/secondary**, and if built it must explicitly budget the extraction change below. T3.2 already covers the live symptom (asked 3×); T3.1 only improves the *first*-ask case.
**Files:** `adapters/llm/types.ts` + `adapters/llm/client.ts` (intent-extraction prompt) to add `inquiryTopic?: 'price'|'hours'|'address'|null`; `customer-booking.ts` inquiry path; `pricing/resolver.ts` (`resolveServicePrice`); `buildBusinessFacts:957-961`.
**Approach:** (1) extend intent extraction to emit `inquiryTopic` — **its own LLM-eval gate** (does the model reliably tag price/hours/address? no false topic on a booking?); (2) in the inquiry path, if `inquiryTopic==='price'` and `resolveServicePrice → 'none'`, escalate deterministically via the same code-template path as T3.2 (no sentinel dependency).
**Failing test first:** price=null + `inquiryTopic='price'` → one `pending_owner_questions` row + honest template on the FIRST ask.
**Regression guard:** does NOT fire when the fact is present (price resolved → answer it); respects `requires_payment=false`; no new false escalations from a mis-tagged `inquiryTopic` (covered by the extraction eval gate).
**Decision gate:** build T3.1 only if the `inquiryTopic` eval is clean; otherwise ship T3.2 + T3.3 and defer T3.1. **T3.2 is the guarantee; T3.1 is the polish.**

### T3.3 — facts framing nudges escalation, not deflection
**File:** `buildBusinessFacts:957-961`.
**Root:** "no price on record — do NOT quote a price" reads to the model as "answer by steering."
**Approach:** when a structured fact is null, the facts line should both forbid invention **and** name the honest route: e.g. "price: not set — do not quote; if asked, this is a studio question to relay, not to steer past." Belt-and-suspenders with T3.1's deterministic trigger (T3.1 is the guarantee; T3.3 improves the common path).
**Failing test first:** facts block for a null-price service contains the relay-not-steer signal.
**Regression guard:** present-price services unchanged.

> **PHASE 3 REVIEW — 2 reviewers:** confirm T3.1/T3.2 don't re-open the fabrication the "relay rarely" policy closed; confirm honest lines are templates (Gate-4 owns phrasing); confirm throttle still bounds owner pings.

---

## Phase 4 (SECONDARY) — Voice reclassification (X2)

Promote two mechanical voice tells from cosmetic-monitor to **functional**, because they were the proximate triggers of P1/P3 harm:
- **either/or as a hold-confirm prompt** (caused P1's ambiguous "yes") — covered structurally by T1.2; additionally flag it in `observeVoiceTells` as a functional issue.
- **dead-end on an unanswerable** (caused P3's 3× deflection) — covered by T3.1/T3.2; additionally flag "no next step on an unmet ask."

Keep the mechanical voice gate **monitor-only** for the rest (per §D); only these two graduate, and only because they have a structural fix backing them. **No new regen authority** for the monitor.

---

## Cross-cutting: test & verification discipline

- **TDD per task:** the failing repro test is written and seen RED before the fix; each repro encodes a real transcript line (P1 "כן תשחרר", P2 "Pilates at 12", P3 "כמה זה עולה?").
- **Suite:** `npx vitest run` must end ≥1700 green (the new repros add to it; nothing in the existing 1700 may go red). Types: `npx tsc --noEmit`.
- **Migrations** (T1.2 `pendingPromptType`, T3.2 counter if persisted): hand-authored, idempotent (`IF NOT EXISTS`); never `drizzle-kit generate`. Read-only on prod always.
- **Engine-truth verification:** any claim about what the engine did is checked against `bookings`/`audit_log`/`conversation_sessions` **as of the event timestamp**, not a present SELECT.

## Regression-guard summary (carried from REDTEAM.md)

| Fix | Must keep green |
|---|---|
| T1.1 decline precedence | S1 embedded-yes commits (`f871fcf`) |
| T1.2 either/or scope | one-yes-one-confirm (`071bf93`) |
| T1.3 causal gate | golden-shape confirmations pass |
| T2.1/T2.2 day-aware occupancy | G1/G5 never-fallback-a-legit-offer; class-mode answers from classes |
| T2.3 grounding scope | F2a bucket same-day-first (`16ed199`) |
| T3.x escalation net | "relay rarely" anti-fab intent; throttle bounds; honest lines are templates |

## Regression-safety verdict (final gate before build — 2026-06-30)

**Conclusion: the plan is regression-safe by construction.** A guardrail-mapping pass (every touched surface → the existing test that pins it) found **no case where a fix's intent conflicts with an existing guarantee.** Every risk is an *implementation-discipline* risk with a named guardrail test and a concrete mitigation. The decline-lexicon risk was checked directly against the full confirmation test corpus (`types.test.ts:79-160`): **none** of the existing 'yes' cases contains a release/decline token, so a conservative lexicon flips nothing.

| Fix | Guardrail test | Effective risk | Discipline to stay green |
|---|---|---|---|
| T1.1 parse/classify decline-precedence | `types.test.ts:79-160` (lenient + windowed + bundled-question) | LOW (corpus verified clean) | Conservative lexicon (שחרר family first; defer ambiguous עזוב/ותר behind own tests); cover BOTH `parseConfirmation` AND `classifyConfirmWithQuestion`; assert both polarities in one suite |
| T1.2 confirm-prompt shape | `customer-booking.test.ts` confirm-prompt assertions | MED | Constrain to single yes/no; new shape test (no "או"/"or" two-arm); keep warmth (no Voice regress) |
| T1.3 causal gate | `output-gate.test.ts:48-72` (Gate-1 bookingConfirmed early-return) | LOW | Plumb booking `createdAt`; flag only this-turn race claims; prior-booking reassurance passes |
| T2.1 spine signature | `orchestrator.ts:1484` + `customer-booking.ts:894/1166` + `output-gate.ts:290` | MED (tsc-guarded) | Update the type + BOTH providers + the consumer; keep Branch-3 occupancy tests green |
| T2.2 day-aware replySurfacesAnyTime | `output-gate.test.ts:125-137` (escape heuristic) | MED | Scope extraction to `focusDay.dateStr`; a correct same-day negative still passes |
| T2.3 grounding builder | `render-day-options.test.ts:93-129` (F2a) + `regression-guards.test.ts` (class-mode refusal) + `day-options.test.ts` (class-leak) | MED→HIGH | Carry whole-service-that-day; **route every offered time through the class-block check (`findClassBlockProviderForSlot`) — never surface a between-class gap as bookable**; F2a bucket path stays green |
| T3.2 repeated-unmet-need | `escalation/engine.test.ts:165-210` (dedup/substance/rate) | MED→HIGH | Reset the counter on EVERY non-inquiry intent (mirror `sessionUnknownCount` reset at `customer-booking.ts:1441`); similarity check so a *related follow-up* ≠ a repeat; never bypass the existing throttle |
| T3.3 facts framing | `customer-booking.test.ts:418-425` (narrative surfacing) | LOW | Null-price line says "relay if asked," not "don't mention" |
| T0.1 telemetry | `cross-seam-non-bypass.test.ts` | LOW | Pure additive log; no body/PII; don't alter the gate path |

**The three cross-cutting disciplines (bake into the build prompts):**
1. **T1.1 must touch BOTH confirmation functions** — else "כן תשחרר, מתי עוד יש?" still books via the `yes_with_question` same-day path.
2. **T2.1 + T2.3 must land coherently** — widen the spine signature (all 3 sites) AND the grounding builder; if only the gate changes, regen re-confabulates from the still-narrow situation. And T2.3 must not leak between-class gap times.
3. **T3.2 counter must reset on non-inquiry intents + use a similarity check** — else unrelated/related asks over-relay and re-open the "relay rarely" fabrication intent.

## Build order & sequencing

1. **Phase 0** (telemetry) — unblocks verification of everything after.
2. **Phase 1** (P1) — CRITICAL; a booking against a decline is the worst live failure.
3. **Phase 2** (P2) — §K recurrence; verify mechanism from Phase-0 logs first.
4. **Phase 3** (P3) — escalation net.
5. **Phase 4** (voice) — graduates two tells with structural backing.

Each phase is a separate build session with its own review gate; no phase merges to `main` with a red suite or an unreviewed gate change. Deploy via `/update-agent` only after Phase reviews pass.

## Open items the build must resolve (not blockers)
1. Confirm from Phase-0 telemetry / a repro whether P2's live failure was grounding-empty vs gate-blind, **and** whether "Pilates at 12" set `timeOfDay` (bucket-filtering) or `time`-only (REDTEAM §P2 + T2.3 caveat). The T2.3 grounding-builder fix is preventive regardless; this only tunes where exactly to widen the scope.
2. ~~`pendingPromptType` storage~~ — **resolved by red-team:** pre-tagging is infeasible (LLM-authored prompt); T1.2 redesigned to constrain the prompt shape + optional post-emit classifier. The repeated-unmet-need counter (T3.2) lives in `context` jsonb (no migration).
3. Confirm the decline-class lexicon coverage with a few more Hebrew phrasings (ותר/עזוב/אין צורך) before locking T1.1, and apply it to BOTH `parseConfirmation` and `classifyConfirmWithQuestion`.
4. **T3.1 decision gate:** build the `inquiryTopic` intent-extraction change only if its eval is clean; otherwise ship T3.2 (the guarantee) + T3.3 and defer T3.1.
