# Research-Session Prompt — Fabrication-Surface Audit (Branch 3 & 4)

> **How to use:** paste the block below into a fresh Claude Code session in this repo. It is self-contained. It directs the session to fan out read-only research subagents, then synthesise a single ranked audit document. It changes no code.

---

## PASTE FROM HERE

You are running a **read-only anti-fabrication audit** of a live WhatsApp PA product (TypeScript, Drizzle/Postgres, Gemini via Vertex). DO NOT edit any code. Your output is one synthesised audit document plus a ranked hole list. Spawn parallel research subagents (Explore / general-purpose) for breadth; you do the synthesis.

### Prime yourself first
Read, in order: `CLAUDE.md`; `ARCHITECTURE.md` (esp. Part 16 "The Four Chat Branches" and the Seven Chat Gates model); `ANTI_FABRICATION.md` (the Gate 1/2/3 doctrine and §7 decision framework); `CHAT_LEVEL_LAWBOOK.md`; `docs/superpowers/plans/2026-06-28-pa-hardening-master-plan.md`; and `docs/superpowers/plans/2026-06-29-three-symptom-remediation-plan.md` (the three confirmed symptoms that motivated this audit).

### The generalized logic bug you are hunting
**The PA's conversational/LLM layer is permitted, in some paths, to ASSERT a fact, an availability state, or a completed action that the deterministic core never produced and cannot verify.** Wherever a reply can state something as *true* or *done* without a deterministic source backing it — or wherever a prompt *instructs* the model to promise/claim such a thing — that is a fabrication hole, even if no current test trips it.

Three already-confirmed instances (use them as the pattern, not the boundary):
- **Action fabrication (S3):** the model says "I asked the owner / a guide will get back to you" but no owner message is dispatched and no relay-back state exists. The global system prompt at `src/adapters/llm/client.ts:382` ("you'll check with the business") *induces* this with no backing action.
- **Availability fabrication (S2):** the inquiry path asserts "no classes that whole day" for a single-time miss, with no fresh-spine re-check (`assertsNoAvailability` in `slot-fabrication-guard.ts` only detects *capacity-full* phrasing, not *schedule-empty*).
- **State fabrication (S1):** the confirm flow re-asserts/re-asks a booking step that isn't actually pending, and a duplicate-guard ("you're already booked") is laundered into a false "unavailable, here's another date."

### The existing gate coverage (the asymmetry to exploit)
`ANTI_FABRICATION.md` defines only three output gates, all in Branch 4's `makeGenReply`:
- **Gate 1** — phantom booking-claim (`assertsBookingConfirmed`, `reply-guard.ts`).
- **Gate 2** — fabricated clock time (`findUnbackedTimes`, `slot-fabrication-guard.ts`).
- **Gate 3** — occupancy/fullness (`assertsNoAvailability` + fresh-spine).

**No gate covers:** actions-taken (escalated/notified/waitlisted/relayed), schedule-empty availability, business-fact/knowledge claims, third-party claims (instructors, owner-said-X), or future commitments ("I'll get back to you"). Branch 3 (manager orchestrator) and all proactive/worker templates have **no fabrication gate at all** (the voice gate is monitor-only). That asymmetry is the audit's target.

### Assertion-class taxonomy — sweep every reply path for each class
For every site that produces customer- or owner-facing text (every `genReply` / `makeGenReply` situation string, the orchestrator reply path, every `i18n` template, every proactive/worker `generateProactiveCustomerMessage`, and every *prompt instruction* that tells the model what to say), determine **which of these the model can assert there, and whether a deterministic backing/gate exists for it:**

- **A. Action-taken** — "I booked / cancelled / rescheduled / held / added you to the waitlist / asked the owner / notified / escalated / passed it on." → must be backed by a committed write or a confirmed dispatch **this turn**.
- **B. Availability / calendar** — "X is free / taken / full / the only time / no class that day / next available is Y." → must be spine-backed **and** time/day-scoped.
- **C. Business fact / knowledge** — service details (e.g. mat vs apparatus), price, policy, hours, what's included. → must be backed by stored business knowledge/FAQ; if absent, a *real* escalation, never a fabricated promise.
- **D. Third-party** — instructor names/availability, "a guide will reply," "the owner said." → must be backed by records.
- **E. Future commitment** — "I'll check and get back to you," "someone will be in touch," "we'll message you." → must be backed by an actually-queued action **and** a relay-back state.
- **F. State / continuity** — implicitly re-asserting a pending step (confirm/clarify) that isn't actually pending in session state.

### What to produce
Write `docs/superpowers/reviews/2026-06-29-fabrication-surface-audit.md` containing:
1. **Hole register** — a table, one row per confirmed hole: `id | branch | file:line | assertion class (A–F) | example false claim | deterministic backing present? (Y/N/partial) | severity (CRITICAL/HIGH/MED/LOW) | recommended lever`. The lever is one of `ANTI_FABRICATION.md §7`: **source-truth (grounding)**, **output gate**, or **new capability**.
2. **Prompt-induced-fabrication list** — every prompt/situation string that *instructs* the model to assert an action/fact with no backing (start from `client.ts:382`, `customer-booking.ts:874/1320/1419/2493`; find the rest, including Branch 3 `orchestrator.ts` and worker templates).
3. **Gate-coverage matrix** — assertion classes A–F × branches (3, 4, proactive/worker), marking each cell gated / ungated, citing the gate symbol or "none."
4. **Top findings narrative** — the 5–10 highest-severity holes, each with the mechanism and why it can produce a false claim, ranked.

### Rules
- Read-only. Cite exact `file:line` for every claim; quote the conditional/prompt text. Distinguish **confirmed hole** from **theoretical risk**. Do not propose detailed fixes (name the lever only). Cover **both** Branch 4 (`customer-booking.ts`, `slot-fabrication-guard.ts`, `reply-guard.ts`, `voice-guard.ts`) **and** Branch 3 (`adapters/llm/orchestrator.ts`, `client.ts`) **and** the worker/proactive send paths (`workers/*`, `escalation/engine.ts`, `initiations/*`, `i18n/t.ts`).

## PASTE TO HERE
