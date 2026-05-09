# PA_4_Business — Project Briefing for Claude Code
**Read this first. Then read ARCHITECTURE.md and DEV_OPERATING_MODEL.md.**

---

## What This Is

A B2B WhatsApp-based Personal Assistant product for local businesses. Each business gets one dedicated PA — customers and the manager interact with it exclusively via WhatsApp. The core product is calendar management and booking. Advanced capabilities are built as **skills**: self-contained modules that extend the PA without touching the core engine.

The system is live at **v1.0.0** on GCP Cloud Run (europe-west3, project: `deepr-490316`).

---

## Non-Negotiable Principles

1. **The LLM is interpretive only.** It extracts intent and produces structured output. It never directly mutates state. Every proposed action passes through the deterministic core before taking effect.
2. **Deterministic core.** Every state change passes in order: identity check → policy check → scheduling logic → calendar validation → safe write. No step may be skipped.
3. **Source-of-truth hierarchy.** Google Calendar > internal system > WhatsApp. WhatsApp is an interface, never a source of truth.
4. **Skills are isolated.** Skills live in `src/skills/`, receive a typed context bundle from the core, return a typed result, and cannot import from the core engine. The boundary is enforced by ESLint and CI.
5. **Failure is explicit.** A failed operation is never treated as a success. Partial state changes are rolled back or flagged.

---

## Read These

| Document | What it covers |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Runtime behavior, domain model, state machines, component boundaries, authorization, onboarding, V1 scope, skills layer contract |
| [DEV_OPERATING_MODEL.md](DEV_OPERATING_MODEL.md) | Who owns what, dev roles (human and agent), branch/PR workflow, environment setup, testing invariants |
| [ROADMAP.md](ROADMAP.md) | V2 MVP skills roadmap — milestone breakdown, build order, decision gates, invariants for Developer A and Developer B |

---

## Codebase Map

```
src/
  domain/       ← Core engine: booking, sessions, identity, authorization, flows, workers
  adapters/     ← External systems: WhatsApp Cloud API, Google Calendar, LLM (Vertex AI)
  workers/      ← Background jobs: reminders, hold expiry, queued messages, waitlist
  db/           ← Drizzle schema, migrations, DB client (source of truth for schema)
  routes/       ← Fastify routes: webhook, OAuth callback, CSV import
  shared/       ← Typed contracts shared between core and skills (skill-types.ts)
  skills/       ← Feature modules — Developer B's domain
```

Key files:
- `src/db/schema.ts` — authoritative schema, always matches production
- `src/shared/skill-types.ts` — the skills contract; co-owned by both developers
- `src/skills/index.ts` — skill registry and `dispatchSkill()`
- `.github/CODEOWNERS` — enforces ownership at merge time

---

## Developer Ownership

| Developer | Owns | Branch prefix |
|---|---|---|
| Developer A | Everything except `src/skills/` | `dev/system/*` |
| Developer B | `src/skills/` only | `dev/skills/*` |

`src/shared/` requires both developers to approve changes. All merges to `main` go through PRs. CI (TypeScript + ESLint + tests) must pass before any merge.

---

## Skills Boundary

Skills in `src/skills/` implement the `Skill` interface from `src/shared/skill-types.ts`. They receive a `SkillContext` (business config, caller identity, message text, conversation history, resolved language) and return a `SkillOutcome`. They may not import from `src/domain/`, `src/adapters/`, `src/db/`, `src/workers/`, or `src/routes/`.

If a skill needs data not currently in `SkillContext`, the correct path is to extend `src/shared/skill-types.ts` — not to work around the boundary.

**If you are working inside `src/skills/`, also read [`src/skills/CLAUDE.md`](src/skills/CLAUDE.md).**

---

## The Four Chat Branches

Every inbound WhatsApp message routes into exactly one of four branches. **Any work on LLM behaviour, reply quality, or conversational experience must identify which branch it targets.** See ARCHITECTURE.md Part 16 for the full specification.

| # | Name | Number | Sender | Entry point |
|---|---|---|---|---|
| 1 | **Operator Channel** | `PROVIDER_WA_NUMBER` | `OPERATOR_PHONE` | `flows/operator.ts` |
| 2 | **MiddleMan Onboarding** | `PROVIDER_WA_NUMBER` | anyone else | `flows/provider-onboarding.ts` |
| 3 | **PA Manager Channel** | any PA number | `role = manager` | `flows/manager-onboarding.ts` / manager handler |
| 4 | **PA Customer Channel** | any PA number | `role = customer` | `flows/customer-booking.ts` |

Key design decisions locked in:
- **Branch 1:** True multi-turn session memory. LLM reasons over full transcript across turns. Cross-session operator memory via `operator_session_notes` table (last 3 summaries injected). Manager phone number surfaced in business summary data.
- **Branch 2:** Explanation mode when user shows confusion — LLM explains technical concepts in plain language, then re-asks when understanding shows. Never parses a question as an answer. Calendar preview sent after OAuth connection. Richer import summary with duplicate count.
- **Branch 3:** Gemini native function-calling orchestrator (`src/adapters/llm/orchestrator.ts`). Manager can use tools conversationally: calendar read/write/delete, web search, customer lookup, contact notes, business configuration. Deterministic apply pipeline enforced inside `manageBusinessSettings` tool. Full session memory (4h expiry) + last 3 cross-session summaries. See `MULTI_AGENT_DESIGN.md` and `CHAT_LEVEL_LAWBOOK.md`.
- **Branch 4:** Two-layer model. Transactional = LLM phrases only (sanitised situation string → wording, no raw engine codes). Conversational = LLM reasons freely with full context. First message: greeting inline for targeted intents, welcome + clarification for generic/ambiguous.
- **Language switch (Branches 3 & 4):** Reply immediately in detected language, add inline switch-offer at the end. No bilingual interruption. Confirmed preference persists to `identities.preferredLanguage`. Replaces `waiting_language_confirmation` state.
- **WhatsApp formatting:** All formatting standards are defined in `CHAT_LEVEL_LAWBOOK.md`. Consult it when writing or modifying any LLM prompt.

---

## Current State

- v1.0.14 is live. All V1 milestones complete.
- No businesses provisioned yet — first provisioning is the immediate next step.
- Meta test number (+15551946756) is still the MiddleMan central number (V0.5 designation).
- **Branch 3 multi-agent upgrade complete.** The old `classifyManagerInstruction → generateManagerReply` pipeline has been replaced with a Gemini native function-calling orchestrator (`src/adapters/llm/orchestrator.ts`). 7 tools implemented: calendar read/write/delete, web search (Tavily), customer lookup, contact notes, business settings.
- **Branch 1 upgrade complete.** Operator cross-session memory via `operator_session_notes` table and `generate-operator-summary` worker. `managerPhoneNumber` surfaced in operator admin data.
- **Branch 2 upgrade complete.** Calendar preview after OAuth, richer import summary with duplicate count.
- **`CHAT_LEVEL_LAWBOOK.md` created** — authoritative WhatsApp formatting standards for all branches.
- Two production skills built: `website-builder` (Workflow Skill), `business-knowledge-setup` (Workflow Skill).
- V2 skills roadmap is active — see ROADMAP.md and ARCHITECTURE.md Part 15.
- **6 known gaps before first provisioning** — see MULTI_AGENT_DESIGN.md implementation notes.
- All formatting rules are defined in `CHAT_LEVEL_LAWBOOK.md`. Consult it when writing or modifying any LLM prompt.

---

## Deploy

Use `/update-agent` to deploy. See `.claude/commands/update-agent.md` for the full runbook. Never push directly to `main` without going through the deploy command — it handles versioning, Cloud Build, and migration verification.
