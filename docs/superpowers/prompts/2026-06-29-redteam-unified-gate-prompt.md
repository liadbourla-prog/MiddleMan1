# Red-Team Prompt — Unified Anti-Fabrication Gate (fire up a new session)

> **How to use:** paste the block between the markers into a fresh session in this repo. It is
> self-contained. The session primes, red-teams the design+plan adversarially, writes a findings
> doc, then revises the plan. Companion state file:
> `docs/superpowers/handoffs/2026-06-29-anti-fabrication-mission-state.md`.

---

## PASTE FROM HERE

I've been building a massive upgrade to this WhatsApp PA system. The goal is a system
**indistinguishable from an Opus 4.8 model running the business** for our customers — high
reasoning, great chat UX, zero calendar mistakes, no false claims to customers or owners. We've
fixed a first wave of bugs and are now attacking the systemic root behind them. Your job: **prime
fully on the flow that brought us here, then act as a rigorous, objective red team** on the current
design + plan — find every mistake, hidden assumption, and gap, as a whole. Be adversarial, not
affirming. Do not rubber-stamp.

### Prime (read in this order)
- `docs/superpowers/handoffs/2026-06-29-anti-fabrication-mission-state.md` — **start here:** full
  state, the shipped fixes, the branch, the binding constraints, the open merge question.
- `CLAUDE.md`; `ARCHITECTURE.md` (esp. the Seven Chat Gates model + routing/identity flow).
- `docs/superpowers/plans/2026-06-28-pa-hardening-master-plan.md` — the seven gates + the workstreams of the upgrade already done.
- `ANTI_FABRICATION.md` — the Gate 1/2/3 doctrine this whole effort generalizes. **Required.**
- `CHAT_LEVEL_LAWBOOK.md` — the voice/UX bar every reply (incl. gate fallbacks) must meet.
- `docs/superpowers/reviews/2026-06-29-fabrication-surface-audit.md` — **the 20-hole audit. This is your coverage yardstick — judge the plan against it.**
- `docs/superpowers/plans/2026-06-29-three-symptom-remediation-plan.md` — the three symptoms, roots, and shipped fixes.

### What you're reviewing
- Design → `docs/superpowers/specs/2026-06-29-unified-anti-fabrication-gate-design.md`
- Plan → `docs/superpowers/plans/2026-06-29-unified-anti-fabrication-gate-plan.md`

### State you must respect (full detail in the mission-state file)
- Fixes are on branch **`dev/system/three-symptom-remediation`** — **11 commits, full suite green
  (1389), NOT merged.** The unified-gate plan **builds on top of this branch.** You'll own
  deciding/handling the merge (merge-first vs build-on-top is **open**).
- Migrations are hand-authored idempotent (`IF NOT EXISTS`); **never `drizzle-kit generate`** (stale journal).

### Binding constraints (do NOT violate or silently re-open — the owner set these)
1. **No cagey PA** — no flood of "I don't know." The gate fires only on narrow *checkable spans*, never on conversational glue.
2. **No owner over-pinging** — the ask-the-owner relay is throttled (dedup / substance / rate).
3. **Honest ≠ robotic ≠ blocking** — a gated/can't-answer reply still meets `CHAT_LEVEL_LAWBOOK`, and a question awaiting the owner never stalls the chat (DB state, not a session lock; the PA keeps transacting).
- Locked decisions: proactive seam **enforces time+action, monitors the rest**; relay **throttle built now, numbers tuned later**.

### Red-team the DESIGN, not just the plan's task list
Pressure-test the core bet (the two-tier allow-list: gate the enumerable; ground+throttle the rest)
and these known soft spots specifically — for each, decide if it's a real flaw and how the
design/plan handles it:
- **Branch-3 availability allowlist completeness** — a legit time the owner references that no tool surfaced → false positive (design §8.2). Is the mitigation real or hand-waved?
- **The `[[ASK_STUDIO]]` doesn't-know trigger is a soft model signal** — false negatives = silent fabrication. Is there a deterministic backstop, and is one even possible?
- **Phase-0's "byte-identical / no behavior change"** claim for the `makeGenReply` refactor — achievable? How is it actually proven?
- **Worker/proactive fallbacks** (template on fail) — do they degrade voice vs constraint #3?
- **Non-blocking relay** vs a customer re-asking the same pending question — any bad loop?
- **Coverage:** does the plan's coverage ledger genuinely close all 20 audit holes, or are any hand-waved? Are there holes the audit itself missed (new claim classes, seams, or worker paths)?
- **Sequencing / blast radius:** is the hot-file serialization correct? Any task that silently regresses G1/G4/G5/C-PIVOT?
- **Spot-check load-bearing facts** the design asserts against live code (e.g. "Branch 3 has no availability gate," "`service_types.narrative` is dropped at the active-services select") — the design is research-derived; verify before trusting.

### Test / verify (for any execution you do)
`npx vitest run` (full suite; baseline **1389** green) · single `npx vitest run <path>` · `npx tsc
--noEmit`. CI lint is **only** `eslint src/skills/**` — `src/domain` isn't CI-linted, so pre-existing
`as any` there is not your regression. DO-NOT-REGRESS guards that must stay green: **G1, G4, G5,
C-PIVOT**, plus the S1/S2/S3 suites.

### Deliverable & flow
1. Write a **red-team findings doc** in `docs/superpowers/reviews/` — ranked mistakes/gaps with
   file:line evidence, **separating plan-level fixes from design-level flaws**.
2. **If you find a design-level flaw, surface it to me before re-architecting** — don't silently
   change the approved architecture.
3. Edit the plan to fix what's safe to fix.
4. Then we decide execution: it's 4 phases — prefer red-team + revise in THIS session, and a
   **fresh session per execution phase** for context hygiene. Execution is subagent-driven
   (`superpowers:subagent-driven-development`), TDD, hot-file-serialized per the plan's execution model.

## PASTE TO HERE
