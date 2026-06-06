# PA_4_Business — Development Operating Model
**Status: Active**
**Last updated: 2026-04-30**

---

## What This Document Is

This document covers how we build — team/agent roles, development workflows, tooling rules, and testing invariants. It is separate from the system architecture. For what the system does at runtime, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Part 1 — Development Roles

Roles fall into two categories: **human developers** who own parts of the codebase long-term, and **Claude agents** that assist within development sessions.

---

### Human Developers

#### Developer A — System Architect
Owns the core engine, infrastructure, and the interface contract between core and skills.

**Primary ownership:**
- `src/domain/` — booking engine, session management, identity, authorization, flows
- `src/adapters/` — WhatsApp, Google Calendar, LLM
- `src/workers/` — all background jobs
- `src/db/` — schema, migrations, DB client
- `src/routes/` — HTTP routes
- `src/server.ts`, `src/redis.ts`
- `src/shared/skill-types.ts` — the skills contract (co-owned, Developer A has final say)
- All deployment, CI/CD, and environment configuration
- Everything outside `src/skills/`

**Review responsibility:** Must approve any PR touching files outside `src/skills/`. Has final say on `src/shared/` changes. Reviews skill PRs with the Skills Validator for contract compliance.

**Branch prefix:** `dev/system/*`

#### Developer B — Skills Engineer
Builds the feature capabilities that differentiate the PA beyond V1 booking.

**Primary ownership:**
- `src/skills/**` — all skill modules

**Constraints:**
- Cannot merge to `main` without Developer A's approval for any file outside `src/skills/`
- Changes to `src/shared/skill-types.ts` require co-review from Developer A
- Skills must implement the `Skill` interface and pass CI (TypeScript + ESLint boundary + Vitest)

**Branch prefix:** `dev/skills/*`

---

### Claude Agents

#### Implementation Planner
- Translates user requests into scoped development tasks
- Checks alignment with ARCHITECTURE.md before proposing work
- Identifies missing constraints or underspecified behavior
- Asks only necessary clarifying questions before defining a task

#### Backend Architect
Owns during a session:
- Domain model and database schema changes
- Booking engine and state machine
- Manager rule and policy systems
- Permission model
- Calendar Adapter
- Background job design

#### Messaging Systems Architect
Owns during a session:
- WhatsApp Adapter (inbound and outbound)
- Message normalization and deduplication
- Identity resolution
- Conversation routing and session management
- LLM Adapter (intent extraction, structured output)
- Customer and manager flow handlers

#### Verifier
Owns during a session:
- Invariant definitions (drawn from ARCHITECTURE.md and Part 6 below)
- Test coverage for booking logic, authorization, calendar integration, and core flows
- Edge case identification
- Regression prevention — every bug fix ships with a test

#### Skills Validator
Reviews every PR touching `src/skills/` for technical correctness and production readiness. Supplements CI (which catches type errors and import violations) with semantic review.

**Terminology note:** What the product calls "agents" (website builder, analytics, etc.) are implemented as skills in this codebase — either Simple Skills or Workflow Skills. There is no separate agent runtime. See ARCHITECTURE.md Part 15.

**Triggers on:** Any PR where changed files include `src/skills/**`

**Reviews:**

1. **Interface compliance** — Skill correctly implements `Skill`: `name` is a stable string constant (not dynamic), `canHandle` is synchronous and free of side effects, `handle` returns a valid `SkillOutcome` in all code paths including error paths.

2. **`canHandle` precision** — Trigger patterns are specific. Flags patterns that: match booking-intent words (`book`, `cancel`, `reschedule`, `appointment`, `available`, `time`, `slot`), overlap with any existing skill's triggers, or are broad enough to fire on unrelated input. Evaluates whether the pattern produces false positives on real booking messages. For Workflow Skills: also verifies that `canHandle` correctly resumes an active workflow via `ctx.workflowState`.

3. **`SkillResult` semantics** — `sessionComplete` is set with intent (not blindly `false`). `skillName` matches `this.name`. Multi-turn skills correctly re-claim follow-up messages via `canHandle`.

4. **Workflow Skill correctness** (Workflow Skills only) — Each step is deterministic code; LLM calls appear only within steps, not between them. Workflow state is read/written exclusively through the typed helper from `src/shared/`. On step failure the workflow stays at the current step and does not advance. Only one active workflow per identity per skill at a time is enforced.

5. **LLM call hygiene** — All LLM responses are schema-validated before use. Raw LLM text never flows into logic. Invalid output is handled with an explicit user-facing fallback, not silently swallowed.

6. **Error handling** — `handle()` does not throw unhandled exceptions. Every `catch` block either recovers with a reply or returns `{ handled: false }`.

7. **Import boundary** — No imports from `src/domain/`, `src/adapters/`, `src/db/`, `src/workers/`, or `src/routes/`, including transitive imports.

8. **Test coverage** — Test file exists and covers: `canHandle` returning `true` for intended triggers, `canHandle` returning `false` for booking phrases, `handle` returning a well-formed `SkillOutcome`.

9. **Production readiness** — No `console.log`, no un-localized hardcoded strings, no `// TODO` left in merged code, no stub implementations returning placeholder values.

**Output:** Structured review with PASS / FLAG / BLOCK per item. BLOCK = must fix before merge. FLAG = requires Developer A's explicit sign-off.

#### Product Reviewer
Evaluates proposed skills before development begins. Works from product goals defined by the product owner, the scope constraints in ARCHITECTURE.md, and the technical capabilities of the skills layer. Translates a feature idea into a precise, buildable skill specification that serves the product's strategic goals efficiently.

**Triggers on:** A new skill idea or feature request, before any code is written.

**Reviews:**

1. **Product fit** — Does the skill align with the product's positioning (WhatsApp-native PA for local businesses)? Checks against V1 scope boundaries in ARCHITECTURE.md Part 9. Recommends scope adjustments rather than rejecting — the question is "what is the right version of this" not "should this exist."

2. **Goal decomposition** — Given the desired feature goals and target user outcomes provided by the product owner, breaks the skill into: the core happy path, edge cases that must be handled at launch, cases that are explicitly deferred with rationale.

3. **Trigger design** — Proposes the `canHandle` logic: specific trigger patterns that match real user messages without false positives against booking flows. Identifies ambiguous phrases that need special handling.

4. **`SkillContext` sufficiency** — Identifies which fields of the current `SkillContext` the skill needs. Flags any required data point missing from the contract and proposes the minimal extension to `src/shared/skill-types.ts`, justified by the skill's needs.

5. **LLM interaction design** — If the skill requires LLM calls: proposes the structured output schema, what context to pass, expected number of turns, how to validate output and handle failure. Flags skills that can be implemented without LLM (simpler and more reliable).

6. **Conflict detection** — Checks whether trigger patterns or functionality overlap with core booking flows or existing skills. Proposes resolution.

7. **Scope and effort** — Rough estimate: single-file skill or multi-file feature? External APIs or credentials needed? New shared types required from Developer A first?

8. **Specification output** — Produces a concise skill spec: trigger patterns, expected inputs and outputs per scenario, `SkillContext` fields used, external dependencies, test cases to cover. Developer B uses this as the build contract. Developer A reviews the spec before code is written.

---

## Part 2 — Development Workflows

### Mission Intake
Before starting any task:
1. Restate the request in one sentence
2. Identify which ARCHITECTURE.md components are affected
3. Confirm alignment with stated principles and scope boundaries
4. Ask only blocking questions — do not ask for information that can be derived from the architecture doc or the code
5. Define the task with clear inputs, outputs, and acceptance criteria

### Implementation
1. Read ARCHITECTURE.md sections relevant to the change
2. Read existing code and tests in the affected area
3. Localize the change — identify the smallest correct modification
4. Implement, preserving component boundaries defined in Architecture Part 4
5. Write or update tests
6. Summarize what changed and why

### Debugging and Verification
1. Reproduce the failure with a test or log trace
2. Identify which layer and component the fault originates in
3. Inspect evidence before forming a hypothesis
4. Fix minimally — do not refactor surrounding code during a bug fix
5. Add a regression test
6. Summarize the root cause in one sentence

---

## Part 3 — Environment Variables

All secrets and config are injected as environment variables. In production, these are stored in GCP Secret Manager and mounted at runtime.

### Required for all environments
```
DATABASE_URL                    postgres://...
REDIS_URL                       redis://...

# Business PA number (global fallback — overridden per-business in DB)
WHATSAPP_ACCESS_TOKEN           System user permanent token
WHATSAPP_PHONE_NUMBER_ID        Meta phone number ID
WHATSAPP_WEBHOOK_VERIFY_TOKEN   Any string; must match Meta webhook config
WHATSAPP_APP_SECRET             For HMAC signature verification

# Provider onboarding number (our central number — Step 0 only)
PROVIDER_WA_NUMBER              E.164 phone number (e.g. +15550001234)
PROVIDER_WA_PHONE_NUMBER_ID     Meta phone number ID for provider number
PROVIDER_WA_ACCESS_TOKEN        System user token for provider number

# Meta Embedded Signup (business WhatsApp onboarding via the /embedded-signup widget)
META_APP_ID                     Meta app ID (Facebook JS SDK + token exchange)
META_APP_SECRET                 Meta app secret (token exchange)
META_EMBEDDED_SIGNUP_CONFIG_ID  Facebook Login for Business config ID with the WhatsApp
                                Embedded Signup / coexistence feature enabled. PUBLIC_BASE_URL
                                must also be listed under the app's Allowed Domains.

# Google Calendar
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI             https://<domain>/oauth/google/callback

# Vertex AI (LLM)
GOOGLE_CLOUD_PROJECT
VERTEX_AI_LOCATION              us-central1

# Server
PUBLIC_BASE_URL                 https://<domain>  (used in OAuth links and import URLs)
PORT                            3000
NODE_ENV                        production | development
SESSION_EXPIRY_MINUTES          30
HOLD_EXPIRY_MINUTES             15
```

### Per-business WhatsApp credentials (stored in DB, not env)

`WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` in `.env` are the global fallback. Once a business is provisioned (via the provider onboarding flow or `npm run provision`), per-business values are stored in `businesses.whatsapp_access_token` and `businesses.whatsapp_phone_number_id`. The sender uses DB values when present, falling back to env vars.

---

## Part 4 — Provisioning a New Business

There are two paths to register a new business in the system.

### Path A — Self-serve via provider WhatsApp number (primary)

1. Ensure `PROVIDER_WA_NUMBER`, `PROVIDER_WA_PHONE_NUMBER_ID`, and `PROVIDER_WA_ACCESS_TOKEN` are set
2. Business owner texts the provider number from their personal WhatsApp
3. The 4-step onboarding conversation runs automatically
4. On completion, Business and Identity rows are created; owner is directed to their PA number
5. Owner texts the PA number to continue with Steps 1–6

### Path B — Direct CLI provisioning (operator fallback)

```bash
PROVISION_WA_NUMBER=+...          \  # PA number (E.164)
PROVISION_MANAGER_PHONE=+...      \  # Owner's personal number
PROVISION_BUSINESS_NAME="..."     \  # Internal name
PROVISION_CALENDAR_ID="..."       \  # Google Calendar ID
PROVISION_TIMEZONE="Asia/Jerusalem" \
PROVISION_WA_PHONE_NUMBER_ID=...  \  # Meta phone number ID for PA number
PROVISION_WA_ACCESS_TOKEN=...     \  # Meta system user token for PA number
npm run provision
```

Output confirms created rows and prints the webhook setup checklist.

### Webhook setup (both paths)

Before a PA number can receive messages, its webhook must be configured in Meta Business Manager:
- **Callback URL:** `https://<domain>/webhook`
- **Verify token:** value of `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
- **Subscribed fields:** `messages`

This is done once per PA number in Meta Business Manager → WhatsApp → Configuration → Webhook.

---

## Part 5 — Tooling Rules

1. Always read ARCHITECTURE.md and relevant code before proposing changes.
2. All external systems must be accessed through their Adapter. Never call Google Calendar, WhatsApp API, or the LLM directly from business logic.
3. Normalize at the boundary. Data entering the system from external sources is normalized to internal types before it touches any business logic.
4. Never use `any` types in TypeScript. The LLM adapter must validate against a schema before returning structured output.
5. No silent catches. Every caught error is either handled and logged, or re-thrown.
6. Migrations are additive in V1. No destructive schema changes without explicit decision.

---

## Part 6 — Testing Invariants

These must never be broken. A failing test for any of these is a blocker.

### Booking invariants
- A booking cannot reach `confirmed` without having passed through `held`
- A booking cannot reach `held` without a valid, specific slot and a passed policy check
- Two bookings cannot both be `confirmed` or `held` for the same slot and provider
- A booking in a terminal state (`confirmed`, `cancelled`, `expired`, `failed`) cannot transition to any other state except `confirmed` → `cancelled`

### Authorization invariants
- No action executes without a resolved identity
- A `customer` cannot perform manager-only actions regardless of message content
- Delegated permissions are checked against the explicit grant, not inferred

### External system invariants
- A Calendar API error never results in a booking state advancing
- An LLM response that fails schema validation never reaches business logic
- A duplicate WhatsApp `message_id` is never processed twice

### Audit invariants
- Every booking state transition produces an audit log entry
- Every manager instruction application produces an audit log entry
- Audit entries are never deleted

### Onboarding invariants
- A message to the provider number never touches any Business row — it only reads/writes `provider_onboarding_sessions`
- A business's manager instruction handler is never reachable while `onboarding_completed_at` is null
- An import token can only be used once; a second upload attempt with the same token is rejected
- An import token cannot be used after `expires_at`
- Step 0 credential validation must call the Meta API before creating any DB rows — invalid credentials must not result in a Business record

### Skills invariants
- A skill's `canHandle` must never return `true` for messages that match core booking intent patterns (`book`, `cancel`, `reschedule`, `appointment`, `available`, `slot`)
- A `SkillResult` with `handled: true` must always include a non-empty `reply`
- `sessionComplete: true` must not be returned while a multi-turn flow is still in progress
- A skill that returns `{ handled: false }` must leave no side effects (no DB writes, no external calls, no state mutation)
- No skill may directly write to the database, send WhatsApp messages through adapters, or modify Calendar events

---

## Part 7 — Branch and PR Workflow

### Branch Conventions

| Developer | Prefix | Example |
|---|---|---|
| Developer A | `dev/system/*` | `dev/system/skills-dispatch-wiring` |
| Developer B | `dev/skills/*` | `dev/skills/website-builder` |

Both developers merge to `main` exclusively via pull requests. Direct pushes to `main` are blocked by branch protection.

### PR Review Requirements

| PR touches | Required approvals |
|---|---|
| Only `src/skills/` | Developer B can merge after CI passes + Skills Validator review |
| `src/shared/` | Both Developer A and Developer B must approve |
| Anything outside `src/skills/` | Developer A must approve |
| `src/db/schema.ts` or any migration file | Developer A must approve; treat as a breaking-change checklist |

### CI Gates

Every PR to `main` must pass all three:
1. `npm run build` — TypeScript compilation, zero errors
2. `npm run lint` — ESLint import boundary (enforced on `src/skills/**`)
3. `npm test` — Vitest unit tests

Failing CI blocks merge regardless of approvals.

### Conversation-Quality Eval Harness

The product's value is that every reply reads like a sharp, warm human — never a bot.
`tests/quality/` locks that bar in as an automated gate.

- **Run:** `npm run test:quality` (separate from `npm test`, which stays unit-only and CI-fast).
- **What it does:** drives the real reply generators (customer, manager, onboarding,
  operator, proactive) with bilingual golden scenarios, then gates each output two ways:
  1. **Deterministic assertions** (`assertions.ts`) — single language, at most one question,
     no stray markdown/HTML, no forbidden bot-tell phrases (`voice.ts` `BOT_TELLS`), no
     verbatim echo of internal templates/tool results, URLs on their own line. Cheap, every run.
  2. **LLM-as-judge** (`grader.ts`) — Pro scores human-vs-bot against the voice-bible rubric.
- **Live LLM calls.** Gated behind `LLM_API_KEY` (auto-loaded from `.env.local`); without it
  the suite skips, matching the integration-test convention. So it is **not** a blocking CI gate.
- **Tunables:** `QUALITY_SAMPLES` (samples per scenario, default 1), `QUALITY_PASS_RATE`
  (fraction that must pass, default 1), `QUALITY_MIN_SCORE` (judge score for a "good" sample,
  default 4). Raise `QUALITY_SAMPLES` to absorb nondeterminism when tightening the bar.
- **When to run:** after any change to an LLM prompt, persona, the voice core (`voice.ts`),
  `CHAT_LEVEL_LAWBOOK.md`, situation strings, or model routing.

### Proposing a New Skill (Developer B workflow)

1. Describe the skill idea and desired user outcome to Developer A
2. Product Reviewer agent produces a skill spec
3. Developer A reviews the spec and approves or requests changes
4. Developer B builds from the approved spec on a `dev/skills/*` branch
5. Skills Validator reviews the PR
6. Developer B merges after CI passes (no Developer A approval needed if PR only touches `src/skills/`)

---

*This document governs how we work. The system behavior is in ARCHITECTURE.md.*
