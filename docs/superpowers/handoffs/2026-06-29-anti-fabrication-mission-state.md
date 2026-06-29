# Mission State — Anti-Fabrication Upgrade (handoff, 2026-06-29)

Read this to get the full picture without reverse-engineering git. Companion to the red-team prompt
(`docs/superpowers/prompts/2026-06-29-redteam-unified-gate-prompt.md`).

---

## Where we are

A first wave of bugs (three live-test symptoms) was root-caused and fixed. Those fixes exposed a
**single systemic disease** — the LLM layer can assert facts/availability/actions the deterministic
core never produced. A fabrication-surface audit found **20 instances** of it. A design + plan now
exist to fix the *disease* (one truth-ledger + one gate at all three output doors), not symptom-by-
symptom. **The plan is awaiting a red-team pass before execution.**

## Branch & build state

- **Branch:** `dev/system/three-symptom-remediation` — **11 commits since `main`, NOT merged.**
- **Tests:** full suite **green (1389)**, `tsc` clean. CI lint is `eslint src/skills/**` ONLY; `src/domain`
  is not CI-linted (pre-existing `as any` there is not a regression).
- **Migration:** `0052_pending_owner_questions.sql` — hand-authored, idempotent (`IF NOT EXISTS`),
  applied by `scripts/apply-all-migrations.ts`. **Must be applied on deploy.** NEVER `drizzle-kit
  generate` (its `_journal.json` is stale at 0007 and re-diffs already-applied tables).
- **OPEN DECISION:** merge this 11-commit branch to `main` first, vs. build the unified-gate plan
  on top of it. The plan currently assumes it **builds on top**.

## The shipped fixes (the 11 commits) — `git log --oneline main..HEAD`

Symptom roots & rationale are in `docs/superpowers/plans/2026-06-29-three-symptom-remediation-plan.md`.

**S1 — confirm-loop / never books / date drift:**
- `f871fcf` F1a — windowed `parseConfirmation` (an embedded "yes" commits; no re-ask loop)
- `77b6323` F1d — honest "already booked" reassurance (no laundering a duplicate into a different date)
- `62b67fb` F1e — never reject the slot under active confirmation (no silent date drift)
- `071bf93` F1b — one yes = one confirm for appointments (kill the double-confirm)
- `209d6fb` F1c — bind a reply to the open waitlist offer so "yes" actually books it

**S2 — single-time miss reported as whole-day-empty:**
- `ce11cad` F2b — schedule-empty detector so Gate 3 re-grounds a false "no classes that day"
- `16ed199` F2a — same-day-first on a part-of-day miss

**S3 — fabricated escalation ("I asked the owner" — it didn't):**
- `1716955` schema — `pending_owner_questions` table + migration 0052
- `aa60895` F3a/F3b — real ask-the-owner escalation via `[[ASK_STUDIO]]` sentinel; de-fabricated the
  "I'll check with the business" prompts
- `034addf` F3a — Branch-3 `answerCustomerQuestion` tool + relay-back (closes the round-trip) + expiry worker
- `30325b7` Gate 4 — `hasActionFabrication` monitor (closes the disease class, monitor-only)

These are NOT throwaway: the unified-gate plan folds them in as its first detectors/consumers
(F2b → a Tier-1 occupancy detector; F3a relay → the throttled doesn't-know path; Gate-4 → graduates
from monitor to a real action-claim check).

## Binding owner constraints (do NOT violate or silently re-open)

1. **No cagey PA** — no flood of "I don't know." The gate fires only on narrow *checkable spans*
   (a clock time, a "done" verb, a fullness phrase, a named service), never on conversational glue.
2. **No owner over-pinging** — the ask-the-owner relay is throttled (dedup per customer / substance / rate).
3. **Honest ≠ robotic ≠ blocking** — a gated/can't-answer reply still meets `CHAT_LEVEL_LAWBOOK`
   (warm, one question, a next step), and a question awaiting the owner NEVER stalls the chat
   (DB state, not a session lock; the PA keeps transacting; the answer returns async).

## Owner decisions already locked

- **Proactive/worker seam:** enforce **time + action** claims (swap to the safe template on fail),
  **monitor-only** the softer claim classes, then calibrate and tighten.
- **Relay throttle:** build the mechanism now; set the exact numbers (dedup window / per-business
  rate / business-hours) during implementation/testing.
- (S1 build choices, already shipped) hold-at-confirm-ask for appointments (F1b); immediate
  escalation, not opt-in, for S3 with the `answerCustomerQuestion` tool + single-open-question
  free-text fallback.

## Document map

| Doc | What |
|---|---|
| `CLAUDE.md`, `ARCHITECTURE.md` | system briefing; Seven Chat Gates; routing/identity |
| `ANTI_FABRICATION.md` | the Gate 1/2/3 doctrine the unified gate generalizes — **required priming** |
| `CHAT_LEVEL_LAWBOOK.md` | the voice/UX bar every reply incl. gate fallbacks must meet |
| `docs/superpowers/plans/2026-06-28-pa-hardening-master-plan.md` | the seven gates + the upgrade workstreams |
| `docs/superpowers/plans/2026-06-29-three-symptom-remediation-plan.md` | S1/S2/S3 roots → shipped fixes |
| `docs/superpowers/reviews/2026-06-29-fabrication-surface-audit.md` | **the 20-hole audit — the coverage yardstick** |
| `docs/superpowers/specs/2026-06-29-unified-anti-fabrication-gate-design.md` | the approved design (one ledger + one gate, two tiers) |
| `docs/superpowers/plans/2026-06-29-unified-anti-fabrication-gate-plan.md` | the executable plan under red-team review |

## Test / verify discipline

- Full suite `npx vitest run` (baseline **1389** green) · single `npx vitest run <path>` · `npx tsc --noEmit`.
- DO-NOT-REGRESS guards that must stay green: **G1** (available booking not wrongly rejected),
  **G4** (day/time resolution, label==date), **G5** (no-invention), **C-PIVOT** (mid-flow pivot),
  plus the S1/S2/S3 suites.
- Execution model: subagent-driven (`superpowers:subagent-driven-development`), TDD per task,
  hot-file single-writer serialization (`customer-booking.ts`, `orchestrator.ts`, `client.ts`).

## Caveat on the design's factual claims

The design was informed by transient research agents. Its file:line claims (e.g. "Branch 3 has no
availability gate," "`service_types.narrative` is dropped at the active-services select") are
research-derived — **spot-check the load-bearing ones against live code** rather than trusting them.
