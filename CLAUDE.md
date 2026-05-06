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

## Current State

- v1.0.0 is live. All V1 milestones complete.
- No businesses provisioned yet — first provisioning is the immediate next step.
- Meta test number (+15551946756) is still the MiddleMan central number (V0.5 designation).
- Skills layer foundation is in place; no production skills built yet.
- V2 skills roadmap is locked — see ARCHITECTURE.md Part 15. All product capabilities beyond V1 booking are implemented as **skills** (Simple Skills or Workflow Skills). There is no separate agent runtime or LLM-based orchestration layer.

---

## Deploy

Use `/update-agent` to deploy. See `.claude/commands/update-agent.md` for the full runbook. Never push directly to `main` without going through the deploy command — it handles versioning, Cloud Build, and migration verification.
