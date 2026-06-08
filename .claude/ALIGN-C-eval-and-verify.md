# Session C — Eval Coverage for B1–B3 + Full Verification + Deploy

**Owner:** Developer A · **Risk:** Low · **Prereq:** Sessions A and B merged.
**Prereq reading:** `CLAUDE.md`, `CHAT_LEVEL_LAWBOOK.md`, `DEV_OPERATING_MODEL.md`
("Conversation-Quality Eval Harness"), `.claude/HANDOFF-quality-gate.md`.
**Per-phase git commits are MANDATORY.**

---

## Why
The existing harness (`tests/quality/scenarios.test.ts`) grades the voice *generators* in isolation
(customer, manager-fallback, onboarding, operator, proactive) but does **not** exercise:
- the Branch 3 **orchestrator loop** (`runManagerOrchestratorLoop`), or
- any **date-resolution** path (the Session A core).

So the two structural upgrades land without a regression net. This session adds one.

## Plan

### Step 1 — Date-resolution unit coverage (deterministic, no LLM, runs in `npm test`)
- Confirm Session A's `resolveSlotRange` tests exist and are thorough (past-year, impossible,
  ambiguous-week, DST gap, end-before-start, cross-TZ). If gaps remain, fill them here.
- Add executor tests asserting **no write** occurs on a `needsClarification` outcome.

### Step 2 — Branch 3 orchestrator quality scenarios (`tests/quality/`)
Follow the existing `scenarios.test.ts` structure (a `name` + a generator call + a rubric; det checks
in `assertions.ts`, LLM-judge in `grader.ts`). Add scenarios that go through the orchestrator path
(may require a thin test harness that stubs tool execution and feeds a fixed tool result, then grades
the model's *phrasing* — keep live LLM calls gated behind `LLM_API_KEY` like the rest of the suite):
- Manager schedules a class with a **clear** date → confirmation is human, no echoed ISO/raw fields.
- Manager gives an **ambiguous** date ("next week sometime") → reply asks which day, no menu, no raw
  reason code.
- Manager gives a **past/impossible** date → reply is matter-of-fact + forward-moving (§12), no leak.
- Manager messages in the **non-default language** → reply in that language + single inline switch
  offer (Session B).

### Step 3 — Light edge coverage for B1 & B2 (only if quick)
- Operator: a "which businesses are live?" status request grades as data-first + human (no CLI dump).
- Onboarding: a confused-user retry does not re-greet (Session B Part 2 parity).

### Step 4 — Full verification
- `npx tsc --noEmit` — clean.
- `npm test` — all green (186 + new unit tests).
- `npm run test:quality:smoke` — 12/12 + new scenarios pass at single sample (the canonical gate per
  `HANDOFF-quality-gate.md`).
- (Optional, with Pro quota) one `npm run test:quality` deep run to confirm it still completes.

### Step 5 — Deploy
- Use `/update-agent` (handles versioning, Cloud Build, migration verification). Do **not** push
  directly to `main`.
- If Session A added a migration (it should not — calendar-write logic is code-only, no schema
  change), verify it applies. Session B adds no schema change (`preferredLanguage` already exists on
  `identities`).

## Guardrails (from HANDOFF-quality-gate.md)
- Do **not** weaken deterministic assertions or the judge rubric to force a pass — the bar is the point.
- A genuine reply-quality failure is a prompt/voice fix in `voice.ts` or the relevant branch template,
  after re-reading `CHAT_LEVEL_LAWBOOK.md` — never a test relaxation.
- Do **not** touch `src/skills/`.

## Definition of done
- New scenarios committed and green at smoke.
- Branches 1–3 verified at the Branch 4 system level per `.claude/ALIGN-00-overview.md` "Definition of
  done".
- Deployed via `/update-agent`; new version live.

## Files
- `tests/quality/scenarios.test.ts` (+ maybe `assertions.ts` for any new det check)
- `src/domain/availability/resolve-slot.test.ts` (if filling gaps)
- `DEV_OPERATING_MODEL.md` (note new scenarios in the harness section, if the format calls for it)
