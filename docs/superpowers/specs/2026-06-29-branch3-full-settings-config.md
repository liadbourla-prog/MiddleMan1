# Plan — Full Settings Configurability via Branch 3 (Owner WhatsApp)

**Status:** Proposed
**Author:** Developer A (system)
**Date:** 2026-06-29
**Scope:** `src/adapters/llm/orchestrator.ts`, `src/domain/manager/orchestrator-tools.ts`, `src/domain/authorization/check.ts`, prompt/lawbook touch-ups, tests. **No DB migrations.**

---

## 1. Goal

Make every owner-tunable business setting changeable by chatting with the PA on WhatsApp (Branch 3), closing the gap surfaced in the configurability audit. Three tiers move into chat:

- **Tier 1 — Proactive feature master switches** (6 booleans, currently DB-only).
- **Tier 2 — Simple scalar/enum settings** (reminder timing, persona, voice, review URL, confirmation gate, 24/7, business name, default language).
- **Tier 3 — Structured behavioural config** (communication style, handoff behaviour, automated-message templates, escalation rules).

**Explicitly out of scope (stays non-chat, by design):** OAuth tokens / Google refresh tokens, payment-processor credentials, WhatsApp/WABA identifiers, and all platform env-var tunables (`HOLD_EXPIRY_MINUTES`, `SESSION_EXPIRY_MINUTES`, `COORDINATION_EXPIRY_HOURS`, etc.). These are security- or provisioning-sensitive and have no business reason to be conversational.

---

## 2. Key facts that make this cheap

- **All target columns already exist** in the `businesses` table (added in migrations 0028–0047). No schema change, no migration.
- **The dedicated-config-tool pattern is well established** — `configureDailyBriefing`, `configureNotifications`, `manageAllowedContacts`, `configurePaymentTiming`, `setInitiationAutonomy` are all copy-able templates.
- **Tier 3 editing logic already exists** in `src/skills/business-knowledge-setup/` (state machine + LLM classifier that produces `CommunicationStyle`, `HandoffBehavior`, `AutomatedMessagesConfig`). We reuse it rather than rebuild.

### The 5-part anatomy every new tool follows (template = `executeConfigureDailyBriefing`)
1. `interface XxxArgs` — the parsed intent the LLM supplies.
2. `export async function executeXxx(args, ctx)` in `orchestrator-tools.ts` — validate → `db.update(businesses).set(patch)` → `logAudit(...)` → return `{ success, fact, guidance }`. **Deterministic write; the LLM only supplies parsed intent.**
3. Import the executor in `orchestrator.ts`.
4. Add the tool declaration to the `MANAGER_TOOLS` array (name, description, JSON-schema params).
5. Add a `case 'xxx':` to the dispatch switch.

Every executor returns `fact` (raw config, never quoted to the owner) + `guidance` (how the LLM should phrase the confirmation), per the existing convention and `CHAT_LEVEL_LAWBOOK.md`.

---

## 3. Authorization

Current `Action` union (`src/domain/authorization/check.ts`) has `policy.change`, `service.modify`, `staff.manage`, etc., but **no generic settings action**.

**Decision:** add one new action `settings.configure` to the `Action` union and to `MANAGER_ACTIONS`. All new Tier 1/2/3 tools authorize against it (managers always; delegated users only if granted; customers/contacts never). Rationale: these are owner-preference toggles distinct from booking-policy money rules (`policy.change`) — a clean single gate keeps delegation legible without inventing 12 micro-actions.

Each executor calls the same `authorize(ctx, 'settings.configure')` guard used by sibling tools, returning the standard `not_authorized` outcome on failure.

---

## 4. Tier 1 — Proactive feature switches

**Columns (all `boolean`, default `false`):** `proactiveWinbackEnabled`, `subscriptionRenewalEnabled`, `postAppointmentThankyouEnabled`, `periodicTreatmentEnabled`, `birthdayGreetingsEnabled`, `rescheduleRetentionEnabled`.

These are read by workers (`winback.ts`, `subscription-renewal.ts`, `post-appointment.ts`, `periodic-treatment.ts`, `birthday.ts`) and `customer-booking.ts:2779`, but never written anywhere in app code.

### New tool: `configureProactiveFeatures`
```ts
interface ConfigureProactiveFeaturesArgs {
  feature: 'winback' | 'subscription_renewal' | 'post_appointment_thankyou'
         | 'periodic_treatment' | 'birthday_greetings' | 'reschedule_retention'
  enabled: boolean
}
```
- Maps `feature` → the matching boolean column, `db.update(...).set({ [col]: enabled })`.
- `logAudit` action `proactive_feature.updated`, metadata `{ feature, enabled }`.
- Description primes the LLM on intent like *"start sending birthday messages"*, *"stop the win-back follow-ups"*.

### Interplay with `setInitiationAutonomy` (important)
`setInitiationAutonomy` already exists and controls **auto-vs-ask mode** per outreach category (`winback`, `coldfill`, `review`, `no_show`, `reshuffle`) in the `initiation_autonomy` table — it does **not** flip these booleans. Keep them separate but make the relationship coherent:
- `configureProactiveFeatures` = the master ON/OFF (does the feature run at all).
- `setInitiationAutonomy` = *given it runs*, does the PA act automatically or propose first.
- Only `winback` overlaps both surfaces. The other five booleans are transactional/courtesy sends with no autonomy category — leave them switch-only.
- Update both tool descriptions so the orchestrator picks the right one ("enable birthdays" → feature switch; "stop asking me before win-backs" → autonomy).

---

## 5. Tier 2 — Simple scalar/enum settings

One small tool per coherent cluster (or fold into `manageBusinessSettings` where the NLP pipeline already fits — see note). All writes are single-column `businesses` patches with validation.

| Setting | Column | Type / validation | Downstream consumer |
|---|---|---|---|
| Reminder lead time | `reminderOffsetHours` | int ≥ 1, sane cap (e.g. ≤ 168) | `workers/reminder.ts` (+ per-service `serviceTypes.reminderOffsetHours` override) |
| Bot persona | `botPersona` | enum `female\|male\|neutral` | LLM prompt builders (`client.ts`, `orchestrator.ts`) |
| Brand voice | `brandVoice` | free text, length-capped | LLM prompt builders, skills |
| Google review URL | `googleReviewUrl` | URL validation | review-request outreach / `automatedMessagesConfig.review_request` |
| Confirmation gate | `confirmationGate` | enum `immediate\|post_payment` | booking engine |
| 24/7 availability | `available247` | boolean | availability resolution |
| Default language | `defaultLanguage` | enum `he\|en` | all reply paths |
| Business name | `name` | non-empty text | everywhere |

### Tooling decision
- **`reminderOffsetHours`** is naturally a **policy_change subtype** — extend `policyChangeSchema` in `apply.ts` with subtype `reminder_offset` (mirrors `booking_buffer`). Reuses the existing money/time-policy NLP path and audit.
- **`confirmationGate`, `available247`, `name`, `defaultLanguage`** — also fold into `manageBusinessSettings` (new `policy_change` subtypes / a `business_profile` instruction type), because they share the "owner states a value, we set a column" shape the apply pipeline already does.
- **`botPersona`, `brandVoice`, `googleReviewUrl`** — these read most naturally as identity/voice tone settings; group into one dedicated tool `configureBusinessVoice` (args: optional `persona`, `brandVoice`, `reviewUrl`) so an owner can say *"talk in a warmer, female voice and here's my Google review link"* in one turn.

**Recommendation:** prefer extending `manageBusinessSettings` for the value-set settings (reuses deterministic apply + audit), and add the single `configureBusinessVoice` tool for the tone cluster. This keeps new surface area to **one** new tool in Tier 2.

---

## 6. Tier 3 — Structured behavioural config

**Columns:** `communicationStyle` (jsonb → `CommunicationStyle`), `handoffBehavior` (jsonb → `HandoffBehavior`), `automatedMessagesConfig` (jsonb → `AutomatedMessagesConfig`), `escalationRules` (jsonb → `EscalationRule[]`). Exact shapes are in `src/shared/skill-types.ts:54-99` and `src/db/schema.ts:1358`.

These are multi-field structures; free-text one-shot editing is error-prone. **Two viable routes:**

### Route A (recommended) — reuse the `business-knowledge-setup` skill as the editor
The skill already has a conversational state machine + classifier that builds these exact structures and persists them via `saveCommunicationStyle` / `saveHandoffBehavior` / `saveAutomatedMessagesConfig` (`skill-types.ts:219-222`).
- Add a thin orchestrator tool `editBusinessKnowledge` whose job is to **hand the owner into the skill flow** for the relevant section (style / handoff / automated messages / escalation), then return.
- The skill already writes back to the `businesses` columns through its save callbacks, so persistence is solved.
- **Reachability — VERIFIED (2026-06-29).** The skill **is already reachable by owners in Branch 3 today**, with caveats:
  - The manager message path dispatches skills *before* the orchestrator (`src/routes/webhook.ts:1119-1176`). If a skill's `canHandle()` matches, it short-circuits and the orchestrator never runs.
  - `business-knowledge-setup.canHandle()` (`src/skills/business-knowledge-setup/index.ts:536-540`) returns true when the caller role is `manager` **and** the message matches a keyword regex (`communicat|style|tone|emoji|formal|casual|handoff|escalat|brand|voice|...`, EN+HE), **or** when a workflow is already active (`ctx.workflowState?.skillName === 'business-knowledge-setup'` → cross-session resume).
  - **Per-section entry works:** `detectStartStep()` (`index.ts:107-120`) maps keywords to a single step (`communication-style`, `handoff-rules`, `message-review`, …), so "change how the PA talks to rude customers" enters just that section.
  - **Persistence is solved:** the skill writes back to the exact `businesses` columns via injected callbacks `saveCommunicationStyle` / `saveHandoffBehavior` / `saveAutomatedMessagesConfig` (`src/domain/skills/context-builder.ts:151-174`), each gated on `identity.role === 'manager'`.
- **The real gap — the dual-router seam, not reachability.** Reachability today depends on a **keyword regex pre-pass**, not on the Gemini orchestrator. The orchestrator cannot itself invoke a skill (`orchestrator.ts` does not import `dispatchSkill`; no MANAGER_TOOLS entry creates a workflow). So if an owner phrases a Tier-3 request the regex doesn't catch, it falls through to the orchestrator — which has **no business-knowledge tool** and hits a dead end. Two front doors that don't know about each other.
- **Fix for Route A (small, call sites pinpointed):** add one orchestrator tool `initiateBusinessKnowledgeSetup(section)` that calls `createWorkflow()` (`src/domain/skills/workflow-helpers.ts:21-35`) to seed `workflowState` at the requested step. The *next* owner message then resumes via the existing skill dispatch (because `canHandle()` matches the active workflow). This makes the orchestrator the single intelligent front door without duplicating the editor. Call sites: tool declaration `orchestrator.ts:146+`, executor in `orchestrator-tools.ts`, dispatch `case` in `dispatchTool()`.

### Route B — native per-field tools
Add granular tools (`configureCommunicationStyle`, `configureHandoffBehavior`, `configureAutomatedMessage`, `configureEscalationRule`) that patch individual jsonb keys deterministically. More tools, but no skill coupling, and each edit is atomic + audited. Best for `escalationRules` and `automatedMessagesConfig` per-template toggles (e.g. *"turn off the 1-hour reminder text"* → set `automatedMessagesConfig.reminder_1h.enabled = false`), which are simple keyed writes.

**Recommendation:** **hybrid** — Route A for the genuinely multi-field flows (`communicationStyle`, `handoffBehavior`), Route B for the keyed toggles (`automatedMessagesConfig.<template>.enabled/body`, `escalationRules` add/remove). This matches edit ergonomics: guided flow for rich structures, one-shot deterministic write for simple keyed changes.

---

## 7. Cross-cutting requirements

- **Audit:** every executor writes `logAudit` with a stable action string (`proactive_feature.updated`, `business_voice.updated`, `automated_message.updated`, `escalation_rule.updated`, …). Mirrors existing convention.
- **Language / phrasing:** all confirmations go through the LLM via `fact` + `guidance`; never echo raw config. Re-read `CHAT_LEVEL_LAWBOOK.md` before writing any tool description or guidance string.
- **Validation up front:** invalid enum/time/URL → `{ success:false, reason, guidance }` that tells the LLM what to re-ask. No partial writes.
- **Read-back:** for list/structured settings (allowed contacts pattern), support an `op:'list'`/read path so the owner can ask "what are my current settings?" — extend the existing settings-summary the orchestrator already surfaces.
- **Tests:** unit test each executor (happy path, validation failure, authorization denial) following existing `orchestrator-tools` test style; one integration test per tier asserting the column/jsonb mutation + audit row.

---

## 8. Phasing & sequencing

**Phase 1 — Tier 1 (highest leverage, smallest surface).**
Ship `configureProactiveFeatures` + autonomy-description reconciliation + `settings.configure` action. This alone un-darks the entire proactive-engagement suite. ~1 tool, 6 lines of mapping, tests.

**Phase 2 — Tier 2.**
Extend `manageBusinessSettings` with the value-set subtypes (`reminder_offset`, `confirmation_gate`, `availability_247`, `business_name`, `default_language`) + add `configureBusinessVoice`. Validation-heavy but mechanical.

**Phase 3 — Tier 3.**
Reachability is already verified (§6), so this is no longer a research risk. Order: (a) keyed-write tools (Route B: automated-message toggles, escalation rules) — low risk, no skill coupling; (b) add `initiateBusinessKnowledgeSetup(section)` to close the dual-router seam so the orchestrator can hand owners into the existing `business-knowledge-setup` flow for the rich structures (communication style, handoff). The editor and persistence already exist — this phase is wiring, not new flow-building.

Each phase is independently shippable and deployable via `/update-agent`. Branch: `dev/system/ws*-branch3-settings`.

---

## 9. Risks & open questions

1. ~~**Skill reachability for owners (Tier 3, Route A):**~~ **RESOLVED (2026-06-29, see §6).** The skill is already reachable by managers in Branch 3 via a keyword pre-pass and supports per-section entry + DB persistence. Residual issue is the **dual-router seam** (keyword pre-pass vs. orchestrator can't invoke skills), fixed by a one-tool `initiateBusinessKnowledgeSetup(section)` that seeds a workflow for the existing dispatch to resume. Route A is the recommended path; Route B remains the fallback/companion for keyed toggles.
2. **Autonomy/boolean confusion:** the LLM must reliably distinguish "enable win-backs" (boolean) from "handle win-backs automatically" (autonomy). Mitigate with sharp, contrasting tool descriptions + a couple of eval cases.
3. **Delegated-permission semantics:** confirm `settings.configure` is the right granularity vs. reusing `policy.change`. Decide before Phase 1 (it gates the audit/authorization story for all three tiers).
4. **`reminderOffsetHours` already changes per-service:** ensure the business-level tool and the per-service override don't silently disagree; the read-back should show both.
5. **Tool-count budget:** Gemini function-calling degrades with very large tool lists. We're adding ~3–6 tools to an already-large `MANAGER_TOOLS`. Prefer folding into `manageBusinessSettings` subtypes where the shape allows, to limit net new top-level tools.

---

## 10. Net new surface (summary)

| Tier | New top-level tools | Reused machinery |
|---|---|---|
| 1 | `configureProactiveFeatures` | audit, authorize |
| 2 | `configureBusinessVoice` (+ `manageBusinessSettings` subtypes) | `apply.ts` policy pipeline |
| 3 | `initiateBusinessKnowledgeSetup(section)` (Route A) + keyed-write tools (Route B) | `business-knowledge-setup` skill, `createWorkflow()`, jsonb patch |
| — | `settings.configure` authorization action | `check.ts` |

**Migrations: none. New columns: none. Net new top-level tools: ~3–4.**
