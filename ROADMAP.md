# PA_4_Business — V2 Skills Roadmap (MVP)

**Status: Active**
**Last updated: 2026-05-09**
**Scope: V2 skills layer built on top of the live v1.0.0 system + Branch 3 multi-agent orchestrator upgrade**

---

## What This Is

This roadmap coordinates Developer A and Developer B through the V2 MVP. V2 adds the skills layer capabilities on top of the fully deployed V1 booking core. No changes to the booking engine, identity system, authorization model, or WhatsApp adapter are required or permitted.

Work is split into two parallel tracks after M10 infrastructure ships:
- **Track A (Developer A):** Infrastructure, schema, SkillContext extensions, core dispatch wiring
- **Track B (Developer B):** All skills — built against the contracts Track A delivers

Developer B cannot start any skill until its Track A prerequisites are complete. Track A and Track B items within the same tier can run in parallel once their stated dependencies are met.

---

## Architecture Decisions Locked

These are not open for re-discussion during V2 development. They are recorded here so both developers start from the same foundation.

| Decision | What it means |
|---|---|
| Branch 3 uses a native function-calling orchestrator | Branch 3 (PA Manager post-onboarding) uses `runManagerOrchestratorLoop()` — a Gemini native function-calling loop in `src/adapters/llm/orchestrator.ts`. This is **not** a separate LLM agent process; it runs in-process within the same Cloud Run request. |
| Skills run before the orchestrator | `dispatchSkill()` fires first for every Branch 3 message. If a skill claims it, the orchestrator is skipped. The skill boundary is unchanged. |
| Branch 4 / all other branches unchanged | Branches 1, 2, and 4 do not use the orchestrator. Branch 4 retains the deterministic booking state machine. |
| Booking engine is not a skill | Skills never trigger or modify bookings directly. If a skill needs booking initiation, Developer A provides a typed callback in SkillContext. |
| Knowledge Agent = data layer | Business knowledge (services, policies, FAQs, brand voice) is resolved from the DB at dispatch time and passed in SkillContext.businessKnowledge and into the orchestrator system prompt. No LLM in the read path. |
| Workflow coordination is deterministic | Multi-step operations are explicit TypeScript step machines. LLM calls happen within steps, never between them for routing. |
| Inbound messages are not serialized per identity | Cloud Run processes webhook requests concurrently. The `skill_workflows` table uses optimistic locking (version column) to prevent race conditions. |
| Workflow mutation is callback-only | Skills call `ctx.workflow.advance()` / `.complete()` / `.fail()`. They never import from `src/domain/` or write to the DB directly. |
| `applyInstruction` boundary is inviolable | The orchestrator's `manageBusinessSettings` tool is the only path to business configuration changes. It wraps `classifyManagerInstruction → applyInstruction`. The LLM cannot bypass it. |

---

## Decision Gates

These block specific milestones until resolved. Each is called out again at the relevant milestone.

| Gate | Blocks | Owner |
|---|---|---|
| **GATE-1:** Domain registrar + hosting provider selection | `website-builder` Step 6–7 (domain + deploy) | Product owner |
| **GATE-2:** First business provisioned and live | All skills — validates the real SkillContext shape against production data before any skill ships to production | Developer A |

---

## Track A — Developer A

### M10 · Skills Infrastructure
**Must ship before any skill in Track B starts.**

#### M10.1 — Schema Migration

New columns and tables. All additive — no destructive changes.

| Change | Table | Detail |
|---|---|---|
| Add `brand_voice TEXT` | `businesses` | Free-text brand tone descriptor |
| Add `intake_required BOOLEAN DEFAULT FALSE` | `service_types` | Triggers intake-form skill before booking confirms |
| Add `business_faqs` table | new | `id, business_id, question, answer, is_active, created_at, updated_at` |
| Add `skill_workflows` table | new | See schema in ARCHITECTURE.md Part 10. Includes `version INT` for optimistic locking and `UNIQUE(identity_id, skill_name, status)` |
| Add `workflow_step_logs` table | new | Per-step audit trail: step_name, status, input/output snapshots (≤10KB), latency_ms, retry_count, tokens_used |

Acceptance: migration runs cleanly against production schema; `npm run build` passes.

#### M10.2 — `src/shared/skill-types.ts` Extensions

New types and fields added to the shared contract. Requires Developer B's review before merge.

**New supporting types:**
```ts
interface ServiceSummary { name: string; durationMinutes: number; price: number | null; currency: string }
interface PolicySummary { minBufferMinutes: number; maxDaysAhead: number; cancellationCutoffMinutes: number }
interface FAQ { question: string; answer: string }
interface WorkflowState { id: string; skillName: string; step: string; state: Record<string, unknown>; version: number }
interface WorkflowCallbacks {
  advance(step: string, state: Record<string, unknown>): Promise<void>
  complete(): Promise<void>
  fail(error: { code: string; message: string; recoverable: boolean }): Promise<void>
  create(skillName: string, firstStep: string): Promise<WorkflowState>
}
interface CompletedBookingSummary { bookingId: string; serviceName: string; slotStart: Date; customerName: string | null }
interface CustomerSummary { identityId: string; phoneNumber: string; displayName: string | null; totalBookings: number; lastBookingAt: Date | null }
type SegmentFilter = { serviceTypeId?: string; inactiveSinceDays?: number; hasBooking?: boolean }
type StepStatus = 'SUCCESS' | 'RETRYABLE' | 'FATAL' | 'PAUSED'
interface StepResult { status: StepStatus; retryCount?: number; errorContext?: { code: string; message: string; recoverable: boolean } }
```

**New fields on `SkillContext`:**
```ts
businessKnowledge: { services: ServiceSummary[]; policies: PolicySummary; faqs: FAQ[]; brandVoice: string | null }
workflowState: WorkflowState | null
workflow: WorkflowCallbacks  // callbacks injected by core at dispatch time
recentCompletedBooking: CompletedBookingSummary | null
customerSegmentQuery: (filter: SegmentFilter) => Promise<CustomerSummary[]>  // throws if caller.role !== 'manager'
```

Acceptance: `npm run build` passes; Developer B has reviewed and approved.

#### M10.3 — Workflow Helper (Core, `src/domain/skills/`)

Implements the `WorkflowCallbacks` functions backed by real DB logic. Not importable by skills — injected into SkillContext at dispatch time.

| Function | Behaviour |
|---|---|
| `createWorkflow(identityId, skillName, firstStep)` | Inserts `skill_workflows` row; errors if one already exists with `status = 'active'` for this identity + skill |
| `loadActiveWorkflow(identityId)` | Reads single active row or returns null |
| `advanceWorkflow(id, step, state, expectedVersion)` | `UPDATE … WHERE id = $1 AND version = $2`; throws `WorkflowConflictError` if 0 rows affected; on conflict caller reloads and retries |
| `completeWorkflow(id)` | Sets `status = 'completed'` |
| `failWorkflow(id, error)` | Sets `status = 'failed'`, stores error in `state.error`, sends WhatsApp notification to manager |
| `logStep(workflowId, stepName, result, meta)` | Inserts `workflow_step_logs` row; caps snapshot size at 10KB |

Acceptance: unit tests cover conflict path, failure notification, and log size cap.

#### M10.4 — `dispatchSkill()` Extension (`src/skills/index.ts` + dispatch pipeline)

Extends the dispatch call to resolve context and inject callbacks before skills run. No changes to the skill interface or SkillOutcome.

Steps the updated dispatch pipeline performs before evaluating `canHandle()`:
1. Load `businessKnowledge` from DB (services, policies, FAQs, brand voice)
2. Load `workflowState` from `skill_workflows` where `identity_id = ctx.caller.id AND status = 'active'`
3. Construct and inject `WorkflowCallbacks` bound to the loaded workflow (or no-op create path if null)
4. Resolve `recentCompletedBooking` (most recent confirmed booking past its slot_end for this identity)
5. Bind `customerSegmentQuery` with authorization guard (throws if role is not manager)

Acceptance: integration test verifies that a skill receiving SkillContext can call `ctx.workflow.create()` without importing from `src/domain/`.

---

### Track A — Incremental Extensions (ship alongside or after M10)

These are smaller Developer A items that unblock specific Track B skills. They can land in the same PR as M10 or in targeted follow-up PRs.

| Item | Unblocks | Notes |
|---|---|---|
| Manager FAQ management instruction handling | `faq-responder` (so manager can populate FAQs) | Extend manager instruction classifier to recognise "add FAQ", "update FAQ", "remove FAQ"; applies to `business_faqs` table |
| Brand voice instruction handling | `faq-responder`, `website-builder` | Extend manager instruction classifier to recognise "my brand voice is…"; stores to `businesses.brand_voice` |
| `intake_required` flag toggle | `intake-form` | Extend manager instruction classifier to toggle `service_types.intake_required` per service |

---

## Track B — Developer B

### Tier 1 — First skill (validates the whole pipeline)

#### S1 · `faq-responder` — Simple Skill

**Depends on:** M10 complete, at least one FAQ row in `business_faqs` (manager must have set up FAQs via Track A FAQ instruction handling), GATE-2

**Owner:** Developer B

**What it does:** Handles customer questions about the business — services, pricing, policies, hours, location. Reads entirely from `ctx.businessKnowledge`. LLM reformulates the answer in the business's brand voice and resolved language. No external calls.

**Trigger patterns:** "how much", "price", "cost", "do you do", "where are you", "what are your hours", "what's your policy", and Hebrew equivalents. Must not trigger on booking intent words.

**SkillContext fields used:** `businessKnowledge.services`, `businessKnowledge.faqs`, `businessKnowledge.brandVoice`, `business.botPersona`, `language`

**Acceptance criteria:**
- `canHandle` returns false for all booking-intent phrases
- `canHandle` returns true for all trigger patterns above in both languages
- `handle` returns a well-formed reply using FAQ data when a match is found
- `handle` gracefully handles the case where no FAQ matches (polite "I don't have that info" reply)
- No `console.log`, no hardcoded strings, full test coverage

---

### Tier 2 — Simple Skills (can run in parallel after S1 validates the pipeline)

#### S2 · `business-analytics` — Simple Skill

**Depends on:** M10 complete, GATE-2

**Owner:** Developer B

**What it does:** Manager asks for booking insights ("how many bookings this week", "who are my regulars", "what's my busiest day", "which service earns most"). Data is sourced from `customerSegmentQuery` callback and booking summary fields in SkillContext. LLM formats the reply as a readable WhatsApp summary.

**Trigger patterns:** Manager-only. "how many bookings", "analytics", "stats", "busiest", "revenue", "top customers", and Hebrew equivalents. Gate on `ctx.caller.role === 'manager'`.

**SkillContext fields used:** `customerSegmentQuery`, `businessKnowledge.services`, `caller.role`, `language`

**Acceptance criteria:**
- Returns `{ handled: false }` immediately if caller is not manager
- Data query is issued through `customerSegmentQuery` — no direct external calls
- Reply is in `ctx.language`
- Full test coverage including manager-only guard

---

#### S3 · `review-collector` — Simple Skill

**Depends on:** M10 complete, `recentCompletedBooking` confirmed populated in SkillContext, GATE-2

**Owner:** Developer B

**What it does:** Two trigger paths: (a) System-triggered — after a booking's `slot_end` passes, the skill sends a WhatsApp review request to the customer with a Google Business review link. (b) Manager-triggered — manager says "send review request to [customer]". In both cases, manager confirms before any message is sent.

**Note:** Path (a) requires a background job trigger that Developer A adds to the reminder worker. Developer B implements the skill; Developer A wires the trigger. Coordinate before starting.

**Trigger patterns (manager path):** "send review request", "ask for review", "request feedback", Hebrew equivalents. Manager-only for manual trigger.

**SkillContext fields used:** `recentCompletedBooking`, `caller.role`, `business.name`, `language`

**Acceptance criteria:**
- Confirmation gate fires before any outbound message
- Review link is a real Google Business URL (manager provides it during onboarding or via instruction — stored in `businesses` table; Developer A adds `google_review_url TEXT` column)
- No message sent without explicit manager or system confirmation
- Full test coverage

---

### Tier 3 — Workflow Skills and manager broadcast (after Tier 2 validates the pattern)

#### S4 · `website-builder` — Workflow Skill

**Depends on:** M10 complete, S1 live (validates Workflow Skill infrastructure), GATE-1 resolved (domain registrar + hosting), GATE-2

**Owner:** Developer B (steps 1–5); Developer A reviews steps 6–7 for external API integration

**Steps:**

| Step | Name | What happens |
|---|---|---|
| 1 | `requirements-gather` | Load `businessKnowledge`. Ask manager: desired pages, style preference, domain preference. |
| 2 | `structure-confirm` | Present proposed site structure. Manager approves or edits. Not advancing until explicit approval. |
| 3 | `content-generate` | LLM call: generate full site content JSON (pages → sections → blocks) using businessKnowledge + approved structure + brandVoice. |
| 4 | `aeo-pass` | Run deterministic AEO validators (schema.org structure, title/meta length, heading hierarchy). Run LLM AEO audit for advisory score. Produce `aeoReport`. |
| 5 | `manager-review` | Send manager: content summary + AEO report highlights. Manager approves (`CONTINUE`) or requests edits (loops to step 3). |
| 6 | `domain-setup` | **GATE-1 required.** Query registrar API for domain availability. Present options. Manager selects. Register domain via API using idempotency key `{workflow_id}:domain-setup`. |
| 7 | `deploy` | Push generated site to hosting provider. Point DNS. Confirm deployment. Idempotency key `{workflow_id}:deploy`. |
| 8 | `complete` | Send manager: live URL, AEO summary, next steps. Mark workflow completed. |

**CANCEL handling:** `canHandle` must intercept "stop", "cancel", "never mind", Hebrew equivalents when `workflowState.skillName === 'website-builder'`. Save draft state before aborting so manager can resume.

**Step failure semantics:**
- Steps 1–5: `RETRYABLE` on LLM failure; `PAUSED` on manager input required; `FATAL` on data corruption
- Steps 6–7: `RETRYABLE` on API timeout (max 3×); `FATAL` on registrar/hosting rejection; idempotency key prevents double-charge on retry

**Acceptance criteria:**
- Workflow resumes correctly after session expiry between any two steps
- Optimistic lock conflict on `advance()` is handled (reload + retry once)
- CANCEL at any step saves draft and confirms abort to manager
- Steps 6–7 not startable until GATE-1 is resolved (guard in step logic)
- AEO advisory score shown to manager but never used as automatic gate
- Full test coverage including resume, cancel, and step failure paths

---

#### S5 · `aeo-optimizer` — Simple/Workflow Skill

**Depends on:** S4 complete (shares AEO step logic), GATE-2

**Owner:** Developer B

**What it does:** Standalone AEO pass against an existing website URL. Manager provides URL. Skill fetches page content, runs the same deterministic validators as website-builder step 4, produces a structured improvement report. If the site was deployed by `website-builder`, optionally applies changes (Workflow Skill path). For external sites, output is a report only.

**Trigger patterns:** "optimize my website", "improve my site for Google", "AEO check", "SEO review", Hebrew equivalents. Manager-only.

**Acceptance criteria:**
- Deterministic validators (schema.org, meta length, heading hierarchy) run without LLM
- LLM advisory score is surfaced as a rating with bullet-point suggestions, not a pass/fail gate
- Report is sent as a formatted WhatsApp message
- Full test coverage

---

#### S6 · `campaign-sender` — Simple Skill

**Depends on:** M10 complete (`customerSegmentQuery` live), GATE-2

**Owner:** Developer B

**What it does:** Manager broadcasts a WhatsApp message to a customer segment. Manager describes the campaign in natural language. LLM drafts the message using brandVoice. Manager sees the draft and confirms before any send. Sends go through the existing outbound message queue (not directly via adapter).

**Note:** Outbound sends to a segment must be queued through the existing `queued-messages` worker, not fired directly inside `handle()`. Developer A must expose a `ctx.queueOutboundMessages(recipients, text)` callback — coordinate before starting. Add this to SkillContext extensions.

**Trigger patterns:** "send a message to all customers", "broadcast", "promo", "announcement", Hebrew equivalents. Manager-only.

**Acceptance criteria:**
- Confirmation gate with draft preview fires before any message is queued
- `customerSegmentQuery` is the only customer data access path
- Sends go through the outbound queue — no direct WhatsApp adapter calls
- Rate-limit awareness: large segments queue with delay, not burst
- Full test coverage including confirmation gate and manager-only guard

---

### Tier 4 — Post-MVP skills (defined, not scheduled)

These are designed and documented but do not block MVP. They start after Tier 3 is live and validated.

| Skill | Type | Key dependency |
|---|---|---|
| `intake-form` | Simple | `service_types.intake_required` flag live; booking engine hook from Developer A |
| `social-content-generator` | Workflow | No external posting API in MVP — output is text copy only |
| `upsell-assistant` | Simple | Booking confirmation event hook from Developer A |

---

## Build Order Summary

```
M10.1 (schema) ─────────────────────────────────────────┐
M10.2 (shared types) ───────────────────────────────────┤
M10.3 (workflow helpers) ───────────────────────────────┤──► M10.4 (dispatch wiring) ──► GATE-2 ──► S1 (faq-responder)
Track A incremental extensions ─────────────────────────┘                                            │
                                                                                                     ▼
                                                                              S2 (analytics) ──┬──► S4 (website-builder) [GATE-1]
                                                                              S3 (reviews) ────┤    S5 (aeo-optimizer)
                                                                              S6 (campaign) ───┘
```

---

## Milestone Definitions

| Milestone | Complete when |
|---|---|
| **M10** | Schema migrated, `src/shared/skill-types.ts` extended and approved by both developers, workflow helpers tested, dispatch pipeline wiring complete, integration test passes |
| **S1** | `faq-responder` live in production, manager has populated at least one FAQ, customer can ask a price question and receive a correct answer |
| **S2–S3** | Each skill live in production with at least one confirmed use by a real business manager |
| **S4** | A full website built and deployed end-to-end via WhatsApp conversation with a real business — requires GATE-1 resolved |
| **S5** | AEO report generated against a real URL |
| **S6** | A real broadcast campaign sent to a real customer segment |
| **V2 MVP** | M10 + S1 + S2 + S3 + S4 + S5 + S6 all live |

---

## Invariants (extends ARCHITECTURE.md Part 6)

These are added by V2 and must never be broken:

- A `skill_workflows` row with `status = 'active'` must not be advanced, completed, or failed without matching the current `version` — stale-read protection
- `workflow.fail()` must always send a manager notification — failure is never silent
- A Workflow Skill's `canHandle()` must handle cancel intent before any step logic when `workflowState` is non-null
- `StepResult.FATAL` must always call `ctx.workflow.fail()` — a fatal step must never silently stall
- `customerSegmentQuery` must throw `AuthorizationError` if `caller.role !== 'manager'` — enforced in the injected callback, not in the skill
- No skill may call `ctx.workflow.create()` if `ctx.workflowState` is already non-null for the same skill — must resume, not overwrite

---

*Changes to this roadmap require explicit agreement from both developers. Decision gate resolutions (GATE-1, GATE-2) must be recorded here with a date when resolved.*
