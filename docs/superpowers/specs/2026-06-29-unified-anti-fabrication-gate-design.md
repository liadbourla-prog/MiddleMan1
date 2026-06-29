# Design: The Unified Anti-Fabrication Gate (one door, one truth-list)

**Status:** design for review — no code, no plan yet. Approve this before the implementation plan is written.
**Date:** 2026-06-29 · **Owner:** Developer A (all affected files are `* @liadbourla-prog`; nothing touches `src/skills/`).
**Inputs:** `docs/superpowers/reviews/2026-06-29-fabrication-surface-audit.md` (20 holes), the two focused research passes (knowledge-grounding + the three seams/ledger fragments), `ANTI_FABRICATION.md`, the three-symptom remediation plan.
**Owner constraints (binding on this design):** (1) the Branch-4 PA must **not** become cagey — no flood of "I don't know"; (2) the owner must **not** be over-pinged; (3) **honest ≠ robotic ≠ blocking** — when the PA can't truthfully assert something, its reply must still meet our chat-UI standard (warm, Opus-4.8-grade, forward-moving), and a question awaiting the owner must **never** stall the conversation: the PA keeps booking and chatting transactionally while the answer comes back asynchronously. All three are designed-in below, not bolted on.

---

## 1. Plain-language summary (read this first)

Every symptom — the fake booking, the false "Tuesday 14:00 is free," the fabricated "I asked the owner" — happens at the *same instant*: the AI has written words and we're about to send them, and some of those words claim something untrue.

Today we try to catch lies with **lie-detectors**: small checkers that each look for one specific kind of lie, and they only run in the customer chat. There are endless ways to phrase a claim and only a few detectors in one place — so lies leak through the manager chat, the automated messages, and any phrasing we didn't predict. We will never write detectors faster than new holes appear. **That is why we keep finding more.**

**The core fix flips it.** Just before any message goes out, we assemble a small list of *"things that are provably true right now"* — what we just did this turn, which times are really open, what the business really offers. Then the message is only allowed to **assert** things that list backs. One rule — *the AI may only state what we can prove this second* — applied at **every** exit, not just the customer chat.

Three things make this safe and finite (and they're already how our best gates work):

- **It only touches *claims*, never the warmth.** The gate fires only on a *specific kind of span* — a clock time, a "done" verb, a fullness phrase, a named service/price. Greetings, empathy, "what can I help with," steering to real services — none of that is a checkable claim, so the gate never sees it. **This is why the PA does not go cagey.** (Proven: today's time-gate ignores any reply with no `HH:MM` in it.)
- **When a claim *can't* be backed, the default is "steer to what we know," not "I don't know."** Saying "I don't know" is the rare exception, and asking the owner is rarer still — behind a real throttle.
- **It catches lies we haven't seen yet.** A brand-new false claim still isn't on the "true list," so it's stopped automatically. Deny-lists need you to predict the lie; this allow-list doesn't.

The only architectural word that matters: messages leave through **three doors** today and only one has a guard. We make them share **one door** with the guard on it. The guard logic already exists and is already reusable — we're moving it, not inventing it.

**Honest scope:** times, occupancy, and actions can be *proven* mechanically — those get the gate everywhere. Business *facts* ("apparatus pilates uses reformers") usually can't be proven by code, so those are handled differently: **ground them** (surface the attribute text the owner already wrote — which we currently throw away) and, only for a true gap, use the **throttled** ask-the-owner relay. Same disease, two honest tiers.

---

## 2. The disease and the reframe

**Disease (from the audit §0):** the LLM layer may assert a fact / availability state / completed-or-promised action the deterministic core never produced and cannot verify.

**Root cause of *persistence* (the new insight):** our gates are **deny-list shaped** — detect a known lie phrasing, check one bespoke backing. A deny-list needs a new rule per phrasing × per claim-class × per seam. The audit's §3 matrix is a grid of (claim-class × seam) cells that is almost entirely empty; each empty cell is a future "symptom."

**The cure is allow-list shaped:** *a reply may only assert what a per-turn ground-truth record backs.* New claim types and new seams are covered by default. This is already latent in the code — Gate 2's time allowlist, the L2 auditor's "backed actions" set, and the fresh-spine read are each a *fragment* of one truth-list, computed in three disconnected places and applied in only one branch.

> **The whole design is: assemble those fragments into one per-turn record, and run one gate against it at all three exits. The detection logic is not rewritten — it is unified and extended to the empty cells.**

---

## 3. Architecture

### 3.1 The Turn Truth Ledger
A single per-turn object the deterministic core fills *before* any reply is generated. Every field already exists somewhere today (research §2):

```
TurnLedger {
  allowedTimes:    Set<HH:MM>        // canonical times the core can back this turn
  occupancySpine:  (day,svc) -> { open: boolean, openText }   // fresh DB read of the focused day
  backedActions:   Set<ActionClaim>  // actions that actually succeeded THIS turn
  businessFacts:   ClosedWorldFacts  // services/prices/instructors/horizon (+ NEW: attributes)
  calendarConnected: boolean
}
```

| Field | Source today | Change |
|---|---|---|
| `allowedTimes` | `buildAllowedTimes` (Branch 4); **absent in Branch 3** | lift to a branch-agnostic builder; in Branch 3, accumulate times returned by `listCalendarEvents`/`getSessionRoster` tool results (mirrors how `succeededActions` accumulates) |
| `occupancySpine` | `dayHasOpenOptions` → `listDayOptions` (already shared, `domain/availability/`) | reuse as-is in all seams |
| `backedActions` | `succeededActions` via `actionsFromToolResult` (Branch 3, **4 classes only**); `bookingConfirmed` flag (Branch 4) | extend `actionsFromToolResult` to the missing classes (refund, broadcast, settings-edit, both coordination tools); **`partial:true` must NOT back** |
| `businessFacts` | `buildBusinessFacts` (Branch 4) / `buildActiveServicesBlock` (Branch 3, weaker) | unify; **inject `service_types.narrative`** (currently selected-out and dropped — the Tier-2 grounding fix) |

The ledger is the *single source of backing*. It replaces the scattered closure args (`makeGenReply`'s `{businessFacts, actionLedger, timeGuard, dayHasOpenOptions}` and the orchestrator's `{succeededActions, calendarAlreadyConnected}`) with one struct.

### 3.2 The one gate (claim-class detectors over the ledger)
The gate is **per enumerable claim class**: detect the narrow span, check it against the ledger field, on mismatch regenerate-once with a corrective, then fall back to a **safe, assertion-free** reply. This is exactly today's Gate 1/2/3 shape — generalized:

| Claim class | Detector (already pure, shareable) | Backing check | On fail |
|---|---|---|---|
| **booking-claim** | `assertsBookingConfirmed` | `backedActions ∋ booking_made` | regen → `BOOKING_NOT_CONFIRMED_FALLBACK` |
| **time** | `findUnbackedTimes` | `∈ allowedTimes` | regen → `FABRICATED_TIME_FALLBACK` |
| **occupancy** | `assertsNoAvailability` (windowed) | `occupancySpine.open` | regen → `OCCUPANCY_FALLBACK` |
| **action-taken** | `detectActionClaims` (extended) | `∈ backedActions` | regen → `SAFE_AUDIT_FALLBACK` |

**Calibration property (load-bearing — preserves both owner constraints):** each detector fires **only on its narrow span**, never on the whole reply. A reply with no `HH:MM`, no completion verb, no fullness phrase, no claimed action is **never touched** — all conversational glue passes free. This is why the PA does not go cagey, and it is already how every shipped gate behaves (research §4). The fallback on an unbackable claim **asks or steers, it does not say "I don't know."**

### 3.4 Honest replies stay on-brand and non-blocking (owner constraint #3)
The gate removes the *false claim*, not the *personality*. Two rules:

- **Voice-quality fallbacks.** The regenerate-once corrective re-grounds to what the ledger *can* back (the real open times / what we *do* offer) and is held to the full `CHAT_LEVEL_LAWBOOK` voice bar — warm, first-person, one question, always a next step. The terminal safe-fallback strings (`*_FALLBACK`) are **rewritten from terse-safe to on-brand** ("Let me get you to a time that actually works — here's what's open…", not "That time is unavailable."). The voice gate (Gate 7) and the golden set run on these fallback paths too, so a gated reply is provably indistinguishable from a normal one. *Today's `FABRICATED_TIME_FALLBACK`/`OCCUPANCY_FALLBACK` are deliberately terse; this design upgrades them — a fabrication fix must not degrade the chat.*
- **Non-blocking relay.** A pending owner-question is **DB state (`pending_owner_questions`), never a session lock.** The flow does **not** enter an "awaiting owner" mode — there is no `awaitingConfirmationFor:'owner_question'` that stalls the customer. The customer keeps booking, asking, and changing things normally; the gate keeps running transactionally; the owner's answer arrives later as the async relay (Branch-3 `answerCustomerQuestion` → proactive send). At most, a reply may acknowledge the open thread inline and keep moving ("I've checked with the studio on the apparatus question — meanwhile, want me to grab the 16:00?"). One question waiting on the owner must never make the PA go quiet or refuse to transact.

### 3.3 The one door
Route the three seams through the same gate. The detectors are already pure (`slot-fabrication-guard.ts` + `reply-guard.ts`, zero imports, branch-agnostic) and the orchestrator already imports across the `domain/flows` boundary — so this is wiring, not new logic.

- **Seam A — Branch 4 `makeGenReply`:** already the chokepoint with Gates 1/2/3. Change: read from the unified ledger instead of its closure args. 53 call sites unchanged (ledger stays closed-over).
- **Seam B — Branch 3 `auditReplyClaims`:** today only the action auditor; **no time/occupancy gate (H1, CRITICAL).** Change: add the time + occupancy detectors (drop-in import) fed by the Branch-3 allowlist accumulator + `listDayOptions` spine; extend `backedActions`.
- **Seam C — `generateProactiveCustomerMessage`:** today **no gate at all** (~30 worker/initiation/escalation call sites). Change: wrap it so the gate runs; callers pass their truth-context (most already pass a `situation`; some pass a verified datum — the `dunning.ts` payUrl re-inject is the precedent). Where a worker genuinely has no ledger, it runs the *availability/action* checks that apply and the template fallback otherwise.

---

## 4. The two tiers (and why class C is NOT gated)

| Tier | Classes | Mechanism | Why |
|---|---|---|---|
| **Tier 1 — gate** | A action-taken · B time · B occupancy · entity (service/price/instructor) | the unified ledger gate at all 3 seams | these have an **enumerable referent** — a finite set the span can be checked against |
| **Tier 2 — ground + throttled relay (NOT a blanket gate)** | C business-fact attributes · D third-party · E future-commitment | (a) **extend grounding** (inject `narrative`); (b) **doesn't-know → throttled relay**; (c) de-fabricate inducer prompts (done) | a free-text attribute ("uses reformers") has **no canonical form to regex** — a gate keyed on "any factual-looking sentence" would sweep glue and make the PA cagey (research §4). The doctrine's rule: *make it checkable first (ground it), then the residual gap is small and legitimate.* |

**Tier-2 detail — this is where the owner constraints are enforced:**

1. **Inject `service_types.narrative` into grounding.** The owner-authored attribute text already exists in the DB and is currently dropped at the active-services select. Surfacing it closed-world shrinks the genuine knowledge-gap to "the owner never wrote it" — which is the *only* legitimate doesn't-know case. This alone removes most of H13/H15 **without any new "I don't know."**
2. **Doesn't-know → steer first, relay rarely.** The `[[ASK_STUDIO]]` sentinel stays the model's signal, but the *default* response to an unbackable Tier-2 claim is regenerate-to-steer ("here's what we do offer"), not escalation. Escalation is the exception the model deliberately signals **and** that survives the throttle below.
3. **Owner-ping throttle (NEW — closes the "no dedup/rate-limit" gap, research §5).** Before `escalateCustomerQuestion` inserts/sends, a deterministic pre-check (all data already in scope, mostly via the existing `pending_owner_questions` indexes):
   - **Dedup per customer:** skip if this customer already has a `pending` question (don't re-ping on a rephrase).
   - **Substance:** skip greetings/social (`looksLikeGreetingOrSocial` already exists) and trivially-short messages.
   - **Rate per business:** cap pending/recent questions per business per window.
   - **Hours (optional):** defer the owner ping to business hours if configured.
   When the throttle suppresses a ping, the customer still gets an honest steer — never a fabricated "I asked them."

**Net effect on the constraints:** "I don't know" can only surface when a *specific* unbackable claim was about to be made (not on glue), and even then steering is preferred. The owner is pinged only for a substantive, de-duplicated, rate-limited, genuine gap.

---

## 5. Hole coverage

| Mechanism | Holes closed |
|---|---|
| **One door** (gate runs in Branch 3 + proactive) | unlocks the entire Branch-3 and worker **columns** |
| **Tier-1 gate: time + occupancy ported to Branch 3** | **H1 (CRITICAL)**, H6 (already shipped, folds in) |
| **Tier-1 gate: action class extended + `partial`≠backed** | H4, H5, H7, H9, H10, H11, H12, H16, H20 |
| **Tier-1 gate: occupancy in proactive seam + fresh-spine re-validate** | H3, H18 |
| **occupancy on unscoped inquiry (focusDay threading)** | H19 |
| **Tier-2: inject narrative + de-fabricate prompts (done)** | H13, H15, P1/P2/P3 (shipped) |
| **Tier-2: throttled relay + round-trip (mostly shipped)** | H2 (shipped), H14 |
| **proactive claim review** | H8, H12 |
| **Future unknown holes** | covered by construction — an unbacked claim isn't in the ledger |

The three shipped symptom fixes (F2b occupancy detector, F3a relay, Gate-4 monitor) are **not discarded** — they become the **first detectors/consumers** of the unified ledger: F2b's schedule-empty regex is a Tier-1 occupancy detector; the F3a relay is the Tier-2 doesn't-know path (now throttled); Gate-4's `hasActionFabrication` graduates from monitor-only to a real action-claim check fed by `backedActions`.

---

## 6. Blast radius & ownership

- **Hot files (single-writer, serialize):** `customer-booking.ts`, `orchestrator.ts`, `client.ts`. Plus shared: `slot-fabrication-guard.ts`, `reply-guard.ts`, a **new** `domain/<gate>/turn-ledger.ts` + gate module, `availability/day-options.ts`, `escalation/engine.ts`, `db/schema.ts` (no new table needed for the throttle — reuses `pending_owner_questions`; `narrative` already exists).
- **Detectors are drop-in** (pure, zero imports). The refactor is the **ledger assembly + wiring**, not detection.
- **Ownership:** all Developer A. **No `src/skills/` involvement, no Developer-B approval, no `shared/skill-types.ts` change.** ESLint boundary (`no-restricted-imports`) only restricts `src/skills/**` → a shared module under `domain/` is importable by Branch 4, Branch 3, and workers with no violation.

---

## 7. Implementation tactic (per owner's second note)

**Subagent-driven, TDD, hot-file-serialized — same model as the hardening master plan.**

- **Phase 0 — Foundation (single-writer, no behavior change):** build the branch-agnostic `turn-ledger` + the unified gate module that wraps the *existing* pure detectors; add characterization tests proving the gate reproduces Gates 1/2/3 exactly. Migrate Branch-4 `makeGenReply` to consume the ledger (pure refactor; full suite must stay green — this is the safety net). *One agent, serial; it's the spine everything else builds on.*
- **Phase 1 — Close H1 (CRITICAL) + extend backed-actions:** port time + occupancy into Branch-3 `auditReplyClaims` (allowlist accumulator in the tool loop + `listDayOptions` spine); extend `actionsFromToolResult` to the missing classes with `partial`≠backed. *Can split into two agents — the Branch-3 time/occupancy port and the backed-action extension touch overlapping regions of `orchestrator.ts`, so serialize those two; independent of Phase-2 files.*
- **Phase 2 — Proactive seam + Tier-2 grounding + relay throttle:** wrap `generateProactiveCustomerMessage` (disjoint file — **parallelizable** with Phase 1); inject `narrative` into grounding; add the owner-ping throttle. *Three agents, mostly disjoint files (`client.ts` proactive seam, `customer-booking.ts` grounding [serialize after Phase 0], `escalation/engine.ts` throttle).*
- **Phase 3 — Graduate Gate-4 + golden/regression:** wire `hasActionFabrication` to `backedActions` (monitor → enforce); add the cross-seam non-bypass invariant test (no seam reaches send without the gate); voice golden set across all three seams.

**Per-task contract:** red→green→commit; full suite green per commit; the named **G1/G4/G5/C-PIVOT** guards stay green; every reply-path change carries a voice check. **Parallelism rule:** agents may run concurrently only on disjoint files; the three hot files are single-writer (serialize WS on each). **Merge-gate:** a `/code-review ultra` pass per phase sub-branch before merge (per the master-plan protocol), focused on the gate↔ledger contract and the no-oscillation property.

**Sequencing summary:** Phase 0 (serial spine) → {Phase 1 ‖ Phase 2-proactive} → Phase 2-grounding/throttle (serial on `customer-booking.ts` after Phase 0) → Phase 3 (last, catches anything the above introduced).

---

## 8. Risks & open decisions (for owner)

1. **Regenerate-vs-monitor in the proactive seam.** Workers can't easily "ask a clarifying question." For a worker reply that fails the gate, the safe fallback is the **template** (already passed as `fallback`). **DECIDED (owner, 2026-06-29): enforce for time + action claims (swap to the safe template on fail), monitor-only for the softer claim types, then calibrate and tighten.**
2. **Branch-3 allowlist completeness.** The orchestrator's availability tools return display strings; the structured times exist transiently in the executors. We must capture them into the ledger as tools run. Risk: a time the owner legitimately references that no tool surfaced → false positive. *Mitigation: the allowlist also admits owner-message-quoted times within the turn, mirroring Branch 4's `extractMentionedTimes`.*
3. **`narrative` data quality.** Injecting owner free-text into closed-world grounding assumes it's accurate; it's owner-authored, so it's authoritative by definition — but it widens what the model will state. *Acceptable: it's the owner's own words; the alternative is the relay.*
4. **Throttle thresholds.** Exact dedup window / per-business rate / hours behavior need owner-chosen numbers. **DECIDED (owner, 2026-06-29): build the throttle mechanism now; set the exact numbers during implementation/testing** (the proposed starting point — one pending question per customer at a time, N≈5 per business per rolling hour, defer-to-hours OFF — is a tunable default, not a commitment).
5. **Scope of "entity" gating in Tier 1.** Gating *named-entity* claims (a service/price not in the closed-world list) is feasible but lower-precedent than times/actions. *Recommendation: start with time/occupancy/action (highest-value, proven), add entity-claim gating as a fast-follow once the ledger exists.*

---

## 9. What I need from the owner to turn this into a plan

- Approve the **two-tier shape** (gate the enumerable, ground+throttle the rest) and the **one-door** unification.
- Decide #1 (proactive enforce-vs-monitor) and #4 (throttle defaults) — or accept the recommendations.
- Confirm phasing/subagent tactic in §7, or adjust the parallelism appetite.

On approval, I write the phased implementation plan (task-level, TDD, with the regression/voice gates and the ultra-review checkpoints) — the executable companion to this design.
