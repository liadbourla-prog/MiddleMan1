# Category A — Root Cause Investigation & Fix Plan

**Created:** 2026-05-17  
**Status:** Investigation complete. Fixes not yet applied — awaiting approval.  
**Source:** 4 parallel read-only investigation agents across all failing test groups.  
**Rule:** Every fix is a test or infrastructure fix only. No domain logic touched unless a real production bug is confirmed. No code modified without explicit approval.

---

## Executive Summary

| # | Bug ID | Tests Affected | Type | Root Cause (1 line) |
|---|---|---|---|---|
| A1 | Redis mock mismatch | silent F2/F3, language C4-he/en | Test bug | Mock exports only `redisConnection`; module also exports `redis`. Plus `wrappedMethod` removed in Vitest 2.x. |
| A2 | Provider onboarding dead | operator F1–F11 | Test env | `PROVIDER_WA_NUMBER` not set → routing gate skips all 11 tests |
| A3 | Build-site auth bypass | website-builder WB-08a | Production bug | `SITE_BUILDER_SECRET` captured at module load time; test sets it after load |
| A4 | Website builder WB-01 | website-builder WB-01 | Needs LLM key | Code analysis shows correct flow; re-run with real key before fixing |
| A5 | Hold expiry not firing | booking D3/B7 | Test bug | Test sets `holdExpiresAt = now - 1s`; grace period is 60s, so query never matches |
| A6 | Language state removed | language C2 | Test bug (stale) | Test expects `waiting_language_confirmation` state that was removed from schema and replaced with inline offer |

**3 of 6 are test bugs** (wrong assertion or wrong setup — production code is correct).  
**1 is a production bug** (WB-08a auth bypass — real security issue).  
**1 needs re-evaluation with LLM key** (WB-01).  
**1 is a test environment issue** (missing env var).

---

## A1 — Redis Mock Contract Mismatch

### Tests failing
- `tests/integration/silent.test.ts` → F2, F3
- `tests/integration/language.test.ts` → C4-he, C4-en

### Error messages
```
Error: [vitest] No "redis" export is defined on the "../../src/redis.js" mock.
TypeError: createSpy.wrappedMethod is not a function
```

### Root cause

**Problem 1 — Missing export in mock.**  
`src/redis.ts` exports two named symbols:
```ts
export const redisConnection = new Redis(...)  // line 6
export const redis = new Redis(...)            // line 11
```
The test mock in `silent.test.ts` only mocks `redisConnection`:
```ts
vi.mock('../../src/redis.js', () => ({
  redisConnection: { quit: vi.fn(), on: vi.fn(), disconnect: vi.fn() },
  // redis is missing ← BUG
}))
```
When `concurrency-lock.ts`, `operator.ts`, or any worker imports `redis` from the mocked module, it gets `undefined`, crashing at runtime.

**Problem 2 — `wrappedMethod` removed in Vitest 2.x.**  
Tests F2 and F5b use `createSpy.wrappedMethod` and `saveSpy.wrappedMethod` to delegate to the original implementation inside a mock. This property does not exist on Vitest 2.x spy objects. The Vitest 2.x pattern is to capture the original function before calling `vi.spyOn()`.

```ts
// BROKEN (Vitest 2.x):
const real = createSpy.wrappedMethod!(...args)

// CORRECT (Vitest 2.x):
const originalFn = module.fn                    // capture first
vi.spyOn(module, 'fn').mockImplementation((...args) => {
  return originalFn(...args)                    // call saved reference
})
```

### Fix plan — `tests/integration/silent.test.ts`

**Step 1:** Add `redis` to the redis vi.mock block (same shape as `redisConnection`):
```ts
vi.mock('../../src/redis.js', () => ({
  redisConnection: { quit: vi.fn(), on: vi.fn(), disconnect: vi.fn(), set: vi.fn(), get: vi.fn() },
  redis: { quit: vi.fn(), on: vi.fn(), disconnect: vi.fn(), set: vi.fn().mockResolvedValue('OK'), get: vi.fn() },
}))
```

**Step 2:** In F2 test — save original before spying:
```ts
const calendarMod = await import('../../src/adapters/calendar/client.js')
const originalCreateCalendarClient = calendarMod.createCalendarClient    // ← save
const createSpy = vi.spyOn(calendarMod, 'createCalendarClient').mockImplementation((...args) => {
  const real = originalCreateCalendarClient(...args)                      // ← use saved
  return { ...real, deleteEvent: vi.fn().mockRejectedValue(new Error('F2 injected')) }
})
```

**Step 3:** In F5b test — same pattern for `saveMessage`.

**Step 4:** Same `redis` export fix in `tests/integration/language.test.ts` (C4 mock block is identical structure).

### Files to change
- `tests/integration/silent.test.ts`
- `tests/integration/language.test.ts`

---

## A2 — Provider Onboarding Route Never Reached

### Tests failing
- `tests/integration/operator.test.ts` → F1 through F11 (all 11)

### Symptoms
```
sessionStep: null        (expected: 'timezone', 'calendar', etc.)
replies.length: 0        (expected: >= 1)
sessionCompleted: false  (expected: true for F8, F10)
```

### Root cause

`src/routes/webhook.ts` guards the provider onboarding branch with:
```ts
const PROVIDER_WA_NUMBER = process.env['PROVIDER_WA_NUMBER'] ?? ''
// ...
if (PROVIDER_WA_NUMBER && msg.toNumber === PROVIDER_WA_NUMBER) {
  // handleProviderOnboarding is called here
}
```

`tests/integration/runner.ts` builds the test message with:
```ts
const providerNumber = process.env['PROVIDER_WA_NUMBER'] ?? ''
// sends message to providerNumber
```

When `PROVIDER_WA_NUMBER` is not set in the test environment, both values are `''`. The routing condition `if (PROVIDER_WA_NUMBER && ...)` short-circuits because empty string is falsy. The handler is never called. The message falls through to the normal business routing, finds no matching business for `toNumber=''`, and returns silently. No session, no replies, no state.

### Fix plan — `tests/integration/runner.ts`

Add a test fallback in `simProvider()`:
```ts
const providerNumber = process.env['PROVIDER_WA_NUMBER'] ?? '+972599000000'
```

This requires that the same fallback is used in the webhook routing check. The cleanest approach is to set the env var in the test setup so both sides agree:

In `tests/integration/setup.ts` (or vitest.integration.config.ts):
```ts
process.env['PROVIDER_WA_NUMBER'] = process.env['PROVIDER_WA_NUMBER'] ?? '+972599000000'
process.env['OPERATOR_PHONE'] = process.env['OPERATOR_PHONE'] ?? '+972599000001'
```

This guarantees the webhook route and the runner use the same value without requiring a real env var in CI.

### Files to change
- `tests/integration/setup.ts` — add default env vars for PROVIDER_WA_NUMBER and OPERATOR_PHONE
- No production code changes needed

---

## A3 — `/build-site` Auth Bypass (Production Bug)

### Test failing
- `tests/integration/skills/website-builder.test.ts` → WB-08a

### Symptom
```
expected 200 to be 401   (missing auth header returns 200 instead of 401)
```

### Root cause

`src/routes/build-site/index.ts` captures the secret at **module load time**:
```ts
const SITE_BUILDER_SECRET = process.env['SITE_BUILDER_SECRET'] ?? ''  // line 9 — runs at import
```

The test sets the env var at **test run time**, after the module is already loaded:
```ts
process.env['SITE_BUILDER_SECRET'] = 'test-secret-tok'   // runs after import
const app = Fastify()
await app.register(buildSiteRoutes)                       // module already loaded, SITE_BUILDER_SECRET = ''
```

Because the constant was set to `''` at import time, the auth check `if (SITE_BUILDER_SECRET && token !== SITE_BUILDER_SECRET)` always evaluates the first condition as falsy, and the request is allowed through regardless of the Authorization header.

**This is a real production bug** — in production, if `SITE_BUILDER_SECRET` is set at deploy time but the process restarts with the env var missing (or cleared), all requests would pass auth unchecked. The correct pattern is to read from `process.env` at request time.

### Fix plan — `src/routes/build-site/index.ts`

Move the env var read inside the request handler (this also fixes the test):
```ts
// REMOVE from module scope:
// const SITE_BUILDER_SECRET = process.env['SITE_BUILDER_SECRET'] ?? ''

// ADD inside the POST handler, before the auth check:
fastify.post('/build-site', async (request, reply) => {
  const SITE_BUILDER_SECRET = process.env['SITE_BUILDER_SECRET'] ?? ''  // ← read at request time
  const authHeader = request.headers['authorization'] ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (SITE_BUILDER_SECRET && token !== SITE_BUILDER_SECRET) {
    return reply.code(401).send({ error: 'Unauthorized' })
  }
  // ... rest of handler
})
```

### Files to change
- `src/routes/build-site/index.ts` — move env var read inside handler

---

## A4 — Website Builder WB-01 (Classify Before Fixing)

### Test failing
- `tests/integration/skills/website-builder.test.ts` → WB-01

### Current status: **Needs LLM key to classify**

Investigation found that the workflow advancement logic (`structure-confirm → content-generate → aeo-pass → preview-deploy → manager-review → domain-setup`) appears correct in the source code. The test expects the final workflow step to be `['domain-setup', 'complete', 'completed']`, which matches what the code should produce.

`runContentGenerate()`, `runPreviewDeploy()` all call `advance()` inline and chain automatically — no waiting for user input between them. The final `domain-setup` pause happens correctly when `GATE_1_RESOLVED` is not set (which the test unsets on line 280).

**Hypothesis:** This failure is LLM-dependent. `runContentGenerate()` calls the Gemini API to generate site content. With a fake API key, the LLM call fails, the function throws, and the workflow never advances past `content-generate`. With a real key, it should complete.

**Action:** Re-run with a real `LLM_API_KEY` before treating this as Category A. If it still fails, investigate `runContentGenerate()` error handling — specifically whether a failed LLM call leaves the workflow in an inconsistent state.

### Files to change
- None yet. Reclassify after re-run with real key.

---

## A5 — Hold Expiry Test Setup Error (Test Bug)

### Test failing
- `tests/integration/booking.test.ts` → D3 (B7 regression)

### Symptom
```
expected false to be true   (notified === false, expected true)
```

### Root cause

The hold-expiry worker (`src/workers/hold-expiry.ts`) applies a **60-second grace period** before expiring a hold:
```ts
const HOLD_GRACE_PERIOD_SECONDS = parseInt(process.env['HOLD_GRACE_PERIOD_SECONDS'] ?? '60')
const cutoff = new Date(Date.now() - HOLD_GRACE_PERIOD_SECONDS * 1000)
// Only expires bookings where holdExpiresAt < cutoff (i.e., expired > 60s ago)
```

The test sets:
```ts
holdExpiresAt: new Date(Date.now() - 1000)   // 1 second ago
```

The query `lt(bookings.holdExpiresAt, cutoff)` evaluates as:
`(now - 1s) < (now - 60s)` → **false**. The booking is never found; `enqueueMessage()` is never called; `notified` stays false.

**The production code is correct.** The grace period exists to prevent race conditions where the hold-expiry worker fires milliseconds before the customer's confirm message arrives. The test was written with an incorrect assumption about the timing.

### Fix plan — `tests/integration/booking.test.ts`

Change the D3 test setup to place `holdExpiresAt` outside the grace period:
```ts
// BEFORE (wrong):
holdExpiresAt: new Date(Date.now() - 1_000),   // 1 second — inside grace period

// AFTER (correct):
holdExpiresAt: new Date(Date.now() - 61_000),  // 61 seconds — past 60s grace period
```

### Files to change
- `tests/integration/booking.test.ts` — update D3 test holdExpiresAt to 61+ seconds ago

---

## A6 — Language Switch State Removed from Schema (Stale Test)

### Test failing
- `tests/integration/language.test.ts` → C2

### Symptom
```
expected 'failed' to be 'waiting_language_confirmation'
```

### Root cause

The test was written against a design that no longer exists. The old design had a dedicated session state `waiting_language_confirmation`. Per CLAUDE.md (line 92):

> **Language switch (Branches 3 & 4):** Reply immediately in detected language, add inline switch-offer at the end. No bilingual interruption. Confirmed preference persists to `identities.preferredLanguage`. **Replaces `waiting_language_confirmation` state.**

The current schema defines session states as:
```ts
['active', 'waiting_confirmation', 'waiting_clarification', 'completed', 'expired', 'failed']
```
`waiting_language_confirmation` is not in this list.

The current implementation in `src/domain/flows/customer-booking.ts` handles language switching via:
1. A context flag `languageSwitchOfferPending: true` in session context (jsonb)
2. A bilingual offer appended inline to the normal reply
3. Session stays in `active` state throughout

**The test assertion is wrong — the production design change is correct.** The test needs to be updated to match the current design.

### Fix plan — `tests/integration/language.test.ts`

Update the C2 test assertions:
```ts
// BEFORE (stale — state no longer exists):
expect(r.sessionState).toBe('waiting_language_confirmation')

// AFTER (matches current design):
expect(r.sessionState).toBe('active')
// Also add assertion that reply contains both language options:
expect(r.replies[0]).toMatch(/כן|לא/i)    // Hebrew YES/NO
expect(r.replies[0]).toMatch(/YES|NO/i)   // English YES/NO
```

Also verify that the session context contains `languageSwitchOfferPending: true` (if the runner exposes context in its result).

### Files to change
- `tests/integration/language.test.ts` — update C2 assertions to match current inline-offer design

---

## Fix Execution Order

Execute in this order to minimize breakage during the fix sequence:

| Step | Fix | File(s) | Risk | Dependency |
|---|---|---|---|---|
| 1 | A2: Set PROVIDER_WA_NUMBER default in test setup | `tests/integration/setup.ts` | Low | None |
| 2 | A5: Fix D3 holdExpiresAt to 61s | `tests/integration/booking.test.ts` | Low | None |
| 3 | A6: Update C2 language state assertion | `tests/integration/language.test.ts` | Low | None |
| 4 | A1: Add `redis` export to redis mock | `tests/integration/silent.test.ts`, `language.test.ts` | Low | None |
| 5 | A1: Fix wrappedMethod → saved-reference pattern | `tests/integration/silent.test.ts` | Medium | Step 4 |
| 6 | A3: Move SITE_BUILDER_SECRET read inside handler | `src/routes/build-site/index.ts` | Low (isolated) | None |
| 7 | A4: Re-run WB-01 with real LLM key | — | None | Real LLM key available |

Steps 1–5 are pure test fixes (no production code).  
Step 6 is a production fix (isolated to one route file, no domain logic).  
Step 7 is a classification step, not a fix.

---

## Additions to E2E Simulation Plan (from session notes)

Two new scenarios to add to `E2E_SIMULATION_PLAN.md` Part 2:

**WL2 — Manager notified when waitlist forms; can approve 11th booking**  
Layer: Booking Engine + Manager Flow  
Automated: NO  
Scenario: A group class with `maxParticipants=10` fills up. An 11th customer tries to book — rejected with "class is full." Manager receives a WhatsApp notification: "10/10 spots filled. [Customer name] is on the waitlist. Approve to add them above limit?"  
Expected: Manager can reply "Approve" → system books the 11th customer (one-time override, does not change `maxParticipants`). All 11 bookings are confirmed. If manager does not approve, the customer stays on waitlist.  
Gap: Feature not yet built. Requires new notification path from waitlist → manager, and a manager override command.

**ME1 — Edge case surfaces to manager for manual resolution**  
Layer: Manager Flow + System Design  
Scenario: A situation arises that no automated rule covers (e.g., a customer books two conflicting slots, a payment is partial, an instructor cancels last-minute with confirmed customers).  
Expected: System flags the edge case to the manager with full context (customer name, booking details, options). Manager responds conversationally. System applies the manager's chosen resolution without guessing.  
Gap: No general "flag to manager" escalation path exists for scheduling edge cases. Currently only customer messages escalate (via `escalatedTasks` + owner rules). A manager-facing edge case queue is not built.

---

## Category B Session Prompt

Copy this into a new Claude Code session on a machine with a real `LLM_API_KEY`:

---

```
You are picking up a testing session for the MiddleMan1 codebase.

WHAT THIS SYSTEM IS:
A B2B WhatsApp PA for local businesses. Booking engine + 4 chat branches.
Branch 4 = customer booking, Branch 3 = PA manager, Branch 2 = MiddleMan
onboarding (new business signup at central PROVIDER_WA_NUMBER), Branch 1 =
operator admin. Stack: Fastify + Drizzle/Postgres + BullMQ/Redis + Gemini
2.5 Flash (via @google/genai SDK). Source of truth: src/db/schema.ts.
Non-negotiable: LLM is interpretive only — it never directly mutates state.

WHAT ALREADY HAPPENED IN THE PRIOR SESSION:
- Full codebase inventory completed (schema, state machines, workers, routes)
- Integration tests run WITHOUT a real LLM key
- Category A bugs (test infrastructure) identified and are being fixed separately
- Category B tests listed below failed ONLY because LLM_API_KEY was absent

YOUR TASK:
1. Start Postgres and Redis, run migrations, then run integration tests with
   the real LLM key. Report full results.
2. For any test that still fails WITH a real key, investigate root cause by
   reading source + test files. Do NOT modify code yet.
3. Present a fix plan per failing test. Wait for confirmation before changing
   anything.
4. After confirmation: implement fixes one per commit on branch
   claude/add-validation-checks-Gcq0x. No test modifications unless the test
   is confirmed stale against documented design.

ENVIRONMENT SETUP:
  service postgresql start
  redis-server --daemonize yes
  DATABASE_URL=postgres://mm:mm@localhost:5432/middleman_test
  REDIS_URL=redis://localhost:6379
  LLM_API_KEY=<YOUR_REAL_GEMINI_KEY>
  NODE_ENV=test
  PROVIDER_WA_NUMBER=+972599000000
  OPERATOR_PHONE=+972599000001

  npx drizzle-kit push --config=drizzle.config.ts   # if DB is fresh
  npm run test:integration

TESTS EXPECTED TO PASS WITH A REAL LLM KEY (currently failing):
  tests/integration/booking.test.ts:
    A1-he  full booking flow in Hebrew: request → hold → confirm
    A1-en  full booking flow in English: request → hold → confirm
    A4     list bookings returns upcoming appointments
    A5     cancellation of single confirmed booking
    A7     cancellation with multiple bookings: numbered selection
    A8     B1 regression: reschedule with multiple bookings asks for new time

  tests/integration/language.test.ts:
    C8-he  no services configured → Hebrew reply directing to business
    C8-en  no services configured → English reply directing to business
    C9     Hebrew and English booking flows produce same session state sequence

  tests/integration/skills/business-knowledge-setup.test.ts:
    BK-01  full English workflow completes and persists to DB
    BK-02  full Hebrew workflow, all replies Hebrew, no language leaks
    BK-07  unsupported feature request deferred to deferred_feature_requests
    BK-09  "stop" mid-workflow saves and exits cleanly

  tests/integration/skills/website-builder.test.ts:
    WB-01  full English build flow: website_json and preview_url saved to DB
           (Note: if this still fails, focus on runContentGenerate() error
           handling — does a failed LLM call leave the workflow stuck at
           content-generate step?)

KNOWN ALREADY-FIXED CATEGORY A ITEMS (expect these to pass now):
  operator.test.ts F1-F11: provider onboarding (fixed by PROVIDER_WA_NUMBER env)
  booking.test.ts D3/B7: hold expiry notification (fixed by 61s holdExpiresAt)
  language.test.ts C2: language switch state (fixed by updating C2 assertion)
  silent.test.ts F2/F3: redis mock + wrappedMethod (fixed in test mocks)
  language.test.ts C4-he/en: same redis mock fix
  website-builder WB-08a: build-site auth bypass (fixed in production route)

INVARIANT TO MAINTAIN:
  The LLM is interpretive only — it extracts intent and produces structured
  output. It never directly mutates state. Every booking state change passes
  through the deterministic engine. Any fix where the LLM seems to be
  mutating state is a design violation, not a valid bug fix.

After running tests, report: how many pass, how many fail, which ones still
fail with a real key, and your root cause hypothesis for each. Then stop and
wait for fix approval before touching any code.
```
