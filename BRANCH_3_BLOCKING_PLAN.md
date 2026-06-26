# Branch 3 — "Block everything except classes this week" Plan

> **Source:** live test in business **סטודיוגה** (`d3c0c1e7-5c75-4b93-aca5-cc4b2bf941de`) on 2026-06-25/26.
> Owner Liad (+972543503704), customer "Harel" (+972546372400).
> **Scope:** Developer A domain — `src/adapters/llm/orchestrator.ts`, `src/domain/manager/*`, `src/domain/availability/*`, `src/db/*`. Branch prefix `dev/system/*`. No `src/skills/` changes.
> **Status:** open. This is **Issue 3** carried over from the 2026-06-26 Branch-4 bugfix session (Issues 1 & 2 shipped in v1.0.91).

## 0. Read first (cold session — do this before touching code)

- `CLAUDE.md`, `ARCHITECTURE.md` (Part 16 — the four branches; authorization; onboarding)
- `MULTI_AGENT_DESIGN.md` — the Branch-3 orchestrator design, tool model, deterministic apply pipeline
- `CHAT_LEVEL_LAWBOOK.md` — formatting + honesty standards for every LLM prompt
- `BRANCH_3_4_BUGFIX_PLAN.md` — "Bug B" is the same failure family (PA claims an action it didn't perform)
- `CALENDAR_UX_DESIGN.md` — internal-as-hub source-of-truth, blocks vs hours
- Code: `src/adapters/llm/orchestrator.ts` (system prompt + tool defs + the `MAX_ITERATIONS` loop), `src/domain/manager/orchestrator-tools.ts` + `apply.ts` (the `manageBusinessSettings` deterministic apply path), `src/domain/availability/blocks.ts` (`createBlock`, `listBlocksInRange`) and `service.ts`/`day-options.ts` (the availability spine Branch 4 reads)

> This root cause was confirmed from the live Cloud Run tool-call trace (§2). Re-derive nothing — verify against that trace.

---

## 1. Symptom

A customer was offered (and could book) a **17:00 private session on a weekday** even though the owner had instructed the PA, that same evening, that for the coming week customers may only book the **existing scheduled classes** and **every other hour is blocked**. Branch 4 (the deterministic customer engine) behaved **correctly** — it only reads real DB state, and 17:00 was genuinely open. The failure is entirely upstream in **Branch 3** (the owner↔PA orchestrator).

This is **not a Branch-4 bug.** Do not change Branch 4 behavior to "guess" owner intent — fix the source of truth.

---

## 1.5 Relationship to the already-shipped fixes (v1.0.91) — read before scoping

The same live session surfaced **three** problems. **Two are already fixed and shipped — do NOT re-open or re-diagnose them here:**

| Issue | What it was | Status |
|---|---|---|
| 1 | Confirmation loop — `parseConfirmation` re-asked "yes, book me please" / the "כו" typo | **Fixed in v1.0.91** ([flows/types.ts](src/domain/flows/types.ts)) |
| 2 | False "fully booked" — group-class `placeHold` collided with the class's own mirrored Google event | **Fixed in v1.0.91** ([calendar/client.ts](src/adapters/calendar/client.ts), [booking/engine.ts](src/domain/booking/engine.ts)) |
| **3** | **Owner's "block non-class hours this week" never materialized** | **This plan** |

Three consequences for THIS work:
- **Scope:** Issue 3 is Branch-3 only (the constraint never became state). The 11:00 failure and the confirmation re-asks in the §2 transcript are Issues 1 & 2 — already closed; ignore them.
- **Verification baseline is v1.0.91.** The §7 check "Branch 4 refuses an off-schedule weekday time **but still allows the real class times**" only passes because Issue 2 was fixed — before it, *every* class booking failed, so the "allows" half would falsely pass. Test on v1.0.91+.
- **Interaction constraint (must not regress Issue 2):** the bulk-block operation (Option A) blocks gap hours as type `block` and must **never overlap a `class` instance**. Blocking a class slot would re-break the class bookings Issue 2 just fixed. The gap-computation helper's invariant in §7 ("never overlaps a `class` block") is load-bearing for this reason.

## 2. Evidence (confirmed against production DB)

**Owner instruction (Branch 3, owner session `3f98af82`, 2026-06-25):**

| Time | Owner says |
|---|---|
| 19:50 | "Only for the coming week (starting 28.6) block everything not currently in the calendar. Keep the 8-person classes; block the rest." |
| 19:50 | "Sun–Thu." |
| 19:51 | "Keep the existing group classes as usual." / "Just don't let customers book at times that aren't the existing classes this week." |
| 19:52 | PA: *"I'm starting to block all the free hours Sun–Thu around the existing classes… it'll take me a few moments, I'll update you when I'm done."* |
| 00:08 (06-26) | (re-flag) PA offered to book Harel Sunday 17:00; owner: *"No. That contradicts the class schedule."* |

**Actual orchestrator tool-call trace (Cloud Run logs, `sessionId 3f98af82`, owner `manageBusinessSettings` = the deterministic block-apply tool):**

| Time (IL) | Tool call | Result |
|---|---|---|
| 19:50:27 | `manageBusinessSettings`: "block all calendar time next week where classes don't appear" | **success:false** → `clarificationNeeded`: "whole week or specific days?" |
| 19:51:02 | `manageBusinessSettings`: "block all free time Sun–Thu, keep only existing classes" | **success:false** → `clarificationNeeded`: *"I can block all the free time, but I can't keep only the classes…"* |
| 19:51:28 | `listCalendarEvents` (28.6–3.7) | success — the model fetches the class schedule to compute gaps itself |
| 19:52:13 | `manageBusinessSettings`: "block Sunday 28 June 00:00–09:00" | **success:true** — one gap blocked |

**What this proves:**
- `manageBusinessSettings` **cannot express "block everything except the existing classes"** and honestly returned `clarificationNeeded` twice. The capability gap is real and the deterministic tool surfaced it correctly — it did NOT fabricate anything.
- The model then pivoted to **manual gap-by-gap blocking** (computing gaps from `listCalendarEvents`), created **one** gap (`06-28 00:00–09:00`), and **stopped** — replying *"I'm going through all the days, it'll take a few moments, I'll update you when done."* It never continued; subsequent owner messages moved to other topics.
- Result in `calendar_blocks`: **exactly one** `block` row. **No 17:00 block on any day.** Hours are 09:00–20:00 Sun–Thu, breathing (`סדנת נשימות`) is `appointment`-mode, nothing covers 17:00 ⇒ Branch 4 correctly treats 17:00 as bookable.

So the owner's constraint **was acknowledged in prose but never materialized into the state Branch 4 reads** — because (a) no atomic operation could express it, and (b) the model over-promised the manual continuation instead of finishing or asking.

**Loop structure that matters:** `MAX_ITERATIONS = 5` per turn ([orchestrator.ts:66](src/adapters/llm/orchestrator.ts#L66)), and each owner message is a fresh run at `iteration 0`. Even the manual path cannot place ~20 gap-blocks within a turn, so an **atomic bulk operation is structurally required**, not just convenient.

---

## 3. Root causes (two, independent — both confirmed by the §2 trace)

### 3a. Capability gap — no atomic "block around classes" operation (the real, structural cause)
`manageBusinessSettings` blocks a **single explicit range** per successful call ([apply.ts:584](src/domain/manager/apply.ts#L584) → `createBlock` in [src/domain/availability/blocks.ts](src/domain/availability/blocks.ts)). There is **no operation that expresses "block all open in-hours time *except* the existing class instances for a date range."** The tool correctly recognized this and returned `clarificationNeeded` twice (19:50:27, 19:51:02). Combined with `MAX_ITERATIONS = 5` per turn, the manual gap-by-gap fallback (~20 blocks across 5 days) **cannot complete within a turn**. This is the load-bearing gap — close it and the honesty problem mostly disappears because the action becomes a single truthful tool call.

### 3b. Honesty gap — over-promised continuation after a *partial success* (a real but secondary gap)
Note this is **not** the model claiming success off a failure — the orchestrator already forbids that ([orchestrator.ts:708](src/adapters/llm/orchestrator.ts#L708): *"there is no background job; if you did not get success, it is not happening"*). Here the FIRST block **succeeded**, and the model then narrated that it would *continue* the rest "across a few moments / when I'm done." The orchestrator is **stateless per turn** and never continued. The existing rule is scoped to failed/clarification results and does **not** cover *"I'll keep working on this multi-step task after this turn."* That uncovered case is the honesty gap to close. Same family as "Bug B" in `BRANCH_3_4_BUGFIX_PLAN.md`.

---

## 4. Open design decision — **resolve with the owner before implementing**

Use `AskUserQuestion` at the start of the implementation session. How should "this week, customers may only book the existing classes" be enforced?

### Option A — Materialize real blocks (recommended default)
Add a deterministic, idempotent **bulk-block** operation: "block all open in-hours time around existing class instances for `[fromDate, toDate]`, optionally restricted to certain weekdays." The owner's instruction becomes real `calendar_blocks` rows; **Branch 4 needs no change** (it already honors `block`/`personal` types).

- **Pros:** faithful to the current internal-as-hub architecture; visible to the owner in Google (the blocks mirror out); reversible (delete the blocks); no Branch-4 changes.
- **Cons:** blocks are per-instance state — if classes change later, the gap blocks must be reconciled; "block the whole week then re-add classes" interleaving needs care so a class slot is never accidentally blocked.

**Sketch:**
1. New helper in `src/domain/availability/` — e.g. `blockOpenTimeAroundClasses(db, business, { from, to, weekdays })` that, per day in range: reads business hours + existing `class` blocks for that day, computes the complementary in-hours intervals, and `createBlock`s each gap (idempotent — skip intervals already fully blocked). Returns a summary `{ daysProcessed, blocksCreated, classesPreserved }`.
2. New orchestrator tool (e.g. `blockOpenTimeAroundClasses`) in [orchestrator.ts](src/adapters/llm/orchestrator.ts) + handler in [orchestrator-tools.ts](src/domain/manager/orchestrator-tools.ts), with a deterministic apply path (mirror the existing `createCalendarEvent`/`manageBusinessSettings` discipline). Enqueue mirror for each new block (consistency with other block paths).
3. Tool `guidance` so the PA reports the **real** summary ("blocked 23 open slots Sun–Thu around 35 classes") — never a deferred promise.

### Option B — A "classes-only" policy primitive
Add a business/window-level flag (e.g. `bookings_class_only_until DATE` or a richer policy row) that, when active, makes Branch 4 **suppress appointment-mode services and any non-class time** for that window — no per-hour blocks.

- **Pros:** one concept instead of dozens of rows; self-cleaning (expires); no risk of blocking a class slot.
- **Cons:** new schema + migration; new Branch-4 read path (must gate `classInstanceMissing`/`isSlotBookable`/service listing on the flag); not visible as blocks in Google; more surface area.

> Recommendation: **Option A** unless the owner wants a recurring/standing "classes-only" mode, in which case **Option B** earns its complexity.

---

## 5. Honesty fix (do this regardless of A vs B) — **extend** the existing rule

The no-background-job rule already exists ([orchestrator.ts:708](src/adapters/llm/orchestrator.ts#L708)) but is scoped to *failed/clarification* results. Extend it to cover **partial success + promised continuation**:
1. **System-prompt rule:** the orchestrator acts only within the current turn and cannot continue a task afterward. After completing PART of a multi-step request, never say you will "go through the rest / keep working on it / finish it in a few moments / update you when done." Instead: do as much as the turn allows, then report **exactly what was done and what remains**, and ask the owner to continue — or, once §4 lands, do it all in one bulk call. Forbidden phrasings explicitly include "I'm going through all the …", "I'll update you when I'm done", "it'll take a few moments".
2. **Claim-auditor extension (optional, fast-follow):** have `detectActionClaims` flag "I'll finish later / in the background / going through all of them" assertions the same way it flags fabricated action history, requiring a rephrase that states the true done/remaining split.

---

## 6. Data reconciliation (pre-existing artifact)

There is **one orphaned block** from the failed 19:52 attempt: `block 06-28 00:00–09:00` (created `19:52:13`). It is the lone survivor of the incomplete bulk-block. Before/while implementing Option A, decide whether to (a) leave it and let the new bulk operation make the week consistent, or (b) delete it and re-run the operation cleanly. Do **not** delete owner-intended state blindly — confirm with the owner that the week-blocking intent still stands for the (now partly elapsed) week before acting.

> The Issue-2 artifact (Harel's `failed` Pilates 07-01 11:00 booking) was already cleaned up in the 2026-06-26 session — no action needed there.

---

## 7. Verification

- **Unit:** the gap-computation helper — given hours 09:00–20:00 and classes at 09/10/11/12/14/16/18, returns the exact complementary intervals; idempotent on re-run; never overlaps a `class` block.
- **Flow/integration:** simulate the owner instruction end-to-end → assert the gap hours become real `block` rows (Option A) or the policy flag is set (Option B) → then assert **Branch 4 refuses an off-schedule weekday time** (e.g. 17:00 breathing) for that week and still allows the real class times.
- **Honesty:** an orchestrator test asserting that a "block the week around classes" request emits the bulk-block **tool call** and a reply reporting a concrete count — not a "I'll get back to you" prose promise.
- Migrations (Option B) idempotent + registered in `scripts/apply-all-migrations.ts`. CI (TS + ESLint + tests) green. Deploy via `/update-agent`.

---

## 8. Forensics access

Cloud SQL proxy runs on `127.0.0.1:5434`; `psql "$DATABASE_URL"` (from `.env.local`) works. Useful tables: `calendar_blocks`, `availability`, `service_types`, `conversation_messages`/`conversation_sessions`, `audit_log`, `bookings`.

---

## 9. Sequencing

1. **Honesty fix (§5)** — smallest, independent, immediate; lands the "no fabricated promises" rule regardless of the design choice.
2. **Resolve A vs B (§4)** with the owner.
3. **Implement the chosen path** with the tests in §7.
4. **Reconcile the orphan block (§6)** as part of the same PR.
