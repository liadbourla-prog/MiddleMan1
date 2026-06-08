# Branch Alignment — Overview & Session Index

**Goal:** Bring Branches 1 (Operator), 2 (MiddleMan Onboarding), and 3 (PA Manager) up to the
**Branch 4 (PA Customer) system level**, which was just raised by the Voice Bible expansion of
`CHAT_LEVEL_LAWBOOK.md` (§9–14) and the deterministic-calendar work in Branch 4.

> Read `CLAUDE.md`, `CHAT_LEVEL_LAWBOOK.md`, and `ARCHITECTURE.md` Part 16 before executing any session.

---

## What "the Branch 4 system level" means (the bar)

| # | Capability | Reference implementation |
|---|---|---|
| A | Shared human voice core injected into every system prompt | `src/adapters/llm/voice.ts` → `buildVoiceCore(channel)` |
| B | Conversational generation on Gemini 2.5 Pro + Flash fallback, bounded thinking budget | `src/adapters/llm/client.ts` `generateConversational`; `orchestrator.ts` `generateOrchestratorTurn` |
| C | No-leak layer: deterministic core decides, LLM only phrases sanitized situations / structured facts; never echoes raw codes | `customer-booking.ts` `sanitiseReason`/`REASON_MAP`; orchestrator-tools `guidance` pattern |
| D | **Deterministic calendar core** — LLM classifies date/time pieces, code computes the absolute instant; guards past-year / impossible / ambiguous-week / DST gap | `src/domain/availability/resolve-slot.ts` + `customer-booking.ts` `handleBookingIntent` |
| E | Real availability from the canonical spine, never invented; failures paired with real alternatives | `availability/service.ts` `getOpenSlots`/`isSlotBookable` |
| F | Greet-once-per-session **hard** guarantee | `customer-booking.ts` `greeted`/`mayGreet` + `webhook.ts` `isFirstMessage` |
| G | Language-switch protocol (detect → reply in detected lang → inline offer → persist preference). Lawbook §3.4 = **Branches 3 & 4** | `customer-booking.ts:256–284`, `:520–527` |
| H | Anti-menu / no-IVR plain-words confirmations; no split-gender; party-size validation | voice core + `handleBookingIntent` |
| I | Targeted eval coverage in `tests/quality/` | `tests/quality/scenarios.test.ts` |

## Current state (already aligned — do NOT redo)

- **A, B, C, I (voice level)** are already shared across all branches. The voice-tier lawbook
  expansion shipped with `buildVoiceCore` + Pro routing wired into customer, manager, operator,
  onboarding, and proactive prompts, and the eval harness already grades all five.

## The gaps this work closes

1. **Branch 3 — D (deterministic calendar core): MISSING.** `createCalendarEvent`,
   `scheduleGroupSession`, and `listCalendarEvents(list_range)` accept LLM-computed ISO datetimes
   (`new Date(args.startDatetime)`). Branch 3 writes to the calendar, so a mis-resolved date is a
   real data-integrity bug and violates Principle #1. → **Session A**.
2. **Branch 3 — G (language switch): MISSING.** Manager `lang` is hard-pinned to
   `business.defaultLanguage`. → **Session B**.
3. **Branches 1 & 2 — F (greet-once): soft only.** Lean on voice-core instruction, no hard flag.
   Low risk; parity polish. → **Session B (optional)**.
4. **Eval coverage** does not exercise the Branch 3 orchestrator loop or any date-resolution path.
   → **Session C**.

## Ownership

All changes are **Developer A** territory (`src/domain/`, `src/adapters/llm/`, `src/routes/`,
`tests/`). Nothing touches `src/skills/`. No cross-owner CODEOWNERS approval needed.

## Sessions (execute in order)

| Session | File | Scope | Risk |
|---|---|---|---|
| **A** | `ALIGN-A-branch3-deterministic-calendar.md` | Branch 3 deterministic calendar core (the heavy lift) | High — data integrity |
| **B** | `ALIGN-B-branch3-language-switch.md` | Branch 3 language-switch protocol + B1/B2 greet-once parity | Medium |
| **C** | `ALIGN-C-eval-and-verify.md` | Eval coverage for B1–B3 + full verification + deploy | Low |

Session A must stand alone. B and C may be combined if moving fast, but A should not be bundled.

## Definition of done (whole effort)

- `npx tsc --noEmit` clean; `npm test` green; `npm run test:quality:smoke` 12/12 (plus new scenarios).
- Branch 3 never resolves a calendar date inside the LLM — every manager calendar write goes through
  `resolveRequestedDate`/`resolveSlotStart` with full guard parity (past-year, impossible, ambiguous,
  DST), forcing a clarification turn on failure.
- Branch 3 detects message language, replies in it, offers an inline switch, and persists preference.
- Deploy via `/update-agent` (handles versioning, Cloud Build, migration verification).
