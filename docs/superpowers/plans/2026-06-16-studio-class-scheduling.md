# Studio Class Scheduling (instructors ↔ booking) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a studio's week-to-week classes carry their instructor end-to-end — the owner schedules "yoga Monday 10:00 with Dana, 12 spots" in the Branch-3 conversation, and when a customer books that class the booking is attributed to Dana — plus a live-derived "who teaches what" FAQ.

**Architecture:** Three small additive wirings on already-built primitives — (1) `scheduleGroupSession` resolves an `instructor` name to an existing `provider` and passes its `providerId` to `createBlock`; (2) `applyRecurringClassChange` resolves its already-parsed `providerHint` and passes `providerId` to `createSeries`; (3) `requestBooking` sources a GROUP class booking's `providerId` from the matched `calendar_blocks` (type=`class`) row instead of `resolveProvider`. Plus a derived teaching-schedule read model injected into the manager orchestrator (and threaded reactively into the customer flow). No new tables, no migration.

**Tech Stack:** TypeScript, Drizzle ORM (Postgres), Zod, Vitest, Google GenAI (Gemini) orchestrator. All work is Developer A domain — no `src/skills/` changes.

**Spec:** `docs/superpowers/specs/2026-06-16-studio-class-schedule-onboarding-design.md`

**Branch:** `dev/system/studio-class-scheduling` (created from `main` in Task 0).

---

## Conventions for every task

- **Gates that run TODAY (no DB):** `npx tsc --noEmit` (clean), `npm run lint` (clean), `npm test` (unit suite green). Run these before every commit that changes `src/`.
- **DB-backed tests are written + committed now but EXECUTED LATER** against a safe Postgres. They live in `tests/integration/` and are guarded by `describe.skipIf(!integrationEnabled)` (see `tests/integration/setup.ts`). **Never run `npm run test:integration` against the prod DB.**
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Do NOT modify** `src/domain/availability/compute.ts`, `src/domain/provider/resolver.ts`, or anything under `src/skills/`.
- **No schema changes / no migration.** If a task seems to need a new column, stop — it is out of scope (this is why the per-instructor bio field is dropped).

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `src/domain/provider/lookup.ts` | **new** — single source of truth for `findProviderByName` (reused by apply + orchestrator-tools) | 1 |
| `src/domain/manager/apply.ts` | use shared `findProviderByName`; resolve `providerHint` in `applyRecurringClassChange` | 1, 3 |
| `src/domain/manager/orchestrator-tools.ts` | `scheduleGroupSession` gains an `instructor` arg → resolves provider → `createBlock` providerId | 2 |
| `src/adapters/llm/orchestrator.ts` | `scheduleGroupSession` tool schema + routing note (capture "…with Dana") | 2 |
| `src/domain/availability/blocks.ts` | **new helper** `findClassBlockProviderForSlot` (class-block lookup for a slot) | 4 |
| `src/domain/booking/engine.ts` | GROUP class bookings inherit the class block's `providerId` (D1) | 4 |
| `src/domain/provider/roster.ts` | derive "who teaches what" from upcoming class blocks; render block | 5 |
| `src/domain/i18n/t.ts` | clarify strings for missing instructor in scheduling | 2 |
| `tests/integration/studio-class-scheduling.test.ts` | **new** — schedule-with-Dana → book → Dana attributed; capacity; multi-instructor | 6 |
| `src/domain/provider/roster.test.ts` | unit test the pure teaching-schedule renderer | 5 |
| `src/domain/availability/blocks.test.ts` | unit test the class-block provider lookup (integration-guarded) | 4 |

---

## Task 0: Branch + keep stray files out of deploy

**Files:** none (git only)

- [ ] **Step 1: Create the branch from main**

```bash
git checkout main && git pull --ff-only 2>/dev/null; git checkout -b dev/system/studio-class-scheduling
```

- [ ] **Step 2: Exclude stray local files from the deploy `git add -A`**

`deploy.sh` does `git add -A`. Keep local-only `.claude/` scratch files out of commits (does not affect tracked files):

```bash
grep -qxF '.claude/' .git/info/exclude || printf '.claude/\n' >> .git/info/exclude
```

- [ ] **Step 3: Confirm clean starting state**

Run: `git status --short`
Expected: clean (no staged/unstaged changes).

---

## Task 1: Extract `findProviderByName` to a shared provider lookup

**Why:** `scheduleGroupSession` (Task 2) and `applyRecurringClassChange` (Task 3) both need to resolve an instructor name to an existing `provider`. Today the only copy is `private` inside `src/domain/manager/apply.ts` (lines 1287-1302). Extract it once so both call sites share identical semantics (active provider, by display name, `none`/`found`/`ambiguous`).

**Files:**
- Create: `src/domain/provider/lookup.ts`
- Modify: `src/domain/manager/apply.ts` (remove the private copy, import the shared one)

- [ ] **Step 1: Create the shared lookup module**

Create `src/domain/provider/lookup.ts`:

```ts
import { and, eq, ilike, isNull } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { identities } from '../../db/schema.js'

export type ProviderLookupResult =
  | { status: 'found'; id: string }
  | { status: 'none' }
  | { status: 'ambiguous' }

/**
 * Resolve an ACTIVE provider identity by display name within a business.
 * Case-insensitive exact match (ilike, no wildcards). Returns 'ambiguous' when
 * more than one active provider shares the name. Single source of truth reused by
 * the manager apply pipeline and the orchestrator tool layer.
 */
export async function findProviderByName(
  db: Db,
  businessId: string,
  name: string,
): Promise<ProviderLookupResult> {
  const rows = await db
    .select({ id: identities.id })
    .from(identities)
    .where(and(
      eq(identities.businessId, businessId),
      eq(identities.role, 'provider'),
      ilike(identities.displayName, name),
      isNull(identities.revokedAt),
    ))
  if (rows.length === 0) return { status: 'none' }
  if (rows.length > 1) return { status: 'ambiguous' }
  return { status: 'found', id: rows[0]!.id }
}
```

- [ ] **Step 2: Rewire `apply.ts` to use the shared function**

In `src/domain/manager/apply.ts`:

Add the import near the other domain imports (after line 16):

```ts
import { findProviderByName } from '../provider/lookup.js'
```

Delete the now-duplicate private `findProviderByName` definition (the block at lines 1285-1302, the JSDoc comment `/** Resolve an active provider identity by display name ... */` through its closing brace). Leave `findServiceByName` and `hoursFragment` in place. All existing call sites (`findProviderByName(db, businessId, ...)`) keep working because the signature is identical.

- [ ] **Step 3: Type-check + lint + unit tests (gate)**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npm run lint`
Expected: clean.

Run: `npm test`
Expected: green (no behavior change; pure refactor).

- [ ] **Step 4: Commit**

```bash
git add src/domain/provider/lookup.ts src/domain/manager/apply.ts
git commit -m "refactor(provider): extract findProviderByName to shared lookup

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `scheduleGroupSession` attaches an instructor (Gap 1)

**Goal:** "schedule yoga Monday 10:00 with Dana, 12 spots" places a class block whose `providerId` is Dana's. If "Dana" matches no existing instructor → clarify (do not auto-create).

**Files:**
- Modify: `src/domain/i18n/t.ts` (clarify strings)
- Modify: `src/domain/manager/orchestrator-tools.ts` (`ScheduleGroupSessionArgs` + `executeScheduleGroupSession`)
- Modify: `src/adapters/llm/orchestrator.ts` (tool schema property + routing note)

- [ ] **Step 1: Add the i18n clarify strings**

In `src/domain/i18n/t.ts`, alongside the existing `apply_provider_*` keys (search for `apply_provider_not_found`), add:

```ts
  schedule_instructor_not_found: {
    he: (name: string) => `אין לי מדריך/ה בשם ${name}. רוצה להוסיף אותו/ה קודם? ("תוסיף את ${name} כמדריך/ה")`,
    en: (name: string) => `I don't have an instructor named ${name}. Add them first? (e.g. "add ${name} as a yoga instructor")`,
  },
  schedule_instructor_ambiguous: {
    he: (name: string) => `יש יותר ממדריך/ה אחד/ת בשם ${name}. למי מהם התכוונת?`,
    en: (name: string) => `There's more than one instructor named ${name}. Which did you mean?`,
  },
```

- [ ] **Step 2: Type-check the i18n addition**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Add `instructor` to the tool args + resolve it in the executor**

In `src/domain/manager/orchestrator-tools.ts`:

Add the shared lookup import near the existing provider/availability imports (after line 20):

```ts
import { findProviderByName } from '../provider/lookup.js'
```

Add `instructor` to the args interface (currently lines 267-275):

```ts
interface ScheduleGroupSessionArgs {
  serviceName?: string
  title?: string
  instructor?: string
  date: DatePieces
  startTime: TimePieces
  endTime?: TimePieces
  durationMinutes?: number
  maxParticipants?: number
}
```

In `executeScheduleGroupSession`, resolve the instructor BEFORE the `createBlock` call. Insert this block immediately after the booking-conflict guard returns (right after the `if (bookingConflicts.length > 0) { ... }` block ends, before `const maxParticipants = ...` at line 339):

```ts
  // Resolve the named instructor to an EXISTING provider (explicit-add model:
  // never auto-create from a typo). Clarify when unknown/ambiguous.
  let providerId: string | null = null
  if (args.instructor && args.instructor.trim().length > 0) {
    const found = await findProviderByName(ctx.db, ctx.businessId, args.instructor.trim())
    if (found.status === 'none') {
      return { success: false, needsClarification: true, message: i18n.schedule_instructor_not_found[ctx.lang](args.instructor.trim()) }
    }
    if (found.status === 'ambiguous') {
      return { success: false, needsClarification: true, message: i18n.schedule_instructor_ambiguous[ctx.lang](args.instructor.trim()) }
    }
    providerId = found.id
  }
```

Pass `providerId` into the `createBlock` call (currently lines 342-350):

```ts
  const block = await createBlock(ctx.db, {
    businessId: ctx.businessId,
    type: 'class',
    start,
    end,
    title,
    serviceTypeId,
    maxParticipants,
    providerId,
  })
```

Add `i18n` to the existing i18n import at the top of the file if it is not already imported. Check the current import line: it is `import type { Lang } from '../i18n/t.js'` (line 16). Change it to also bring in the runtime `i18n` object:

```ts
import { i18n, type Lang } from '../i18n/t.js'
```

- [ ] **Step 4: Surface the instructor in the success payload (optional nicety)**

Still in `executeScheduleGroupSession`, extend the returned `scheduled` object (lines 357-361) so the model can confirm the instructor naturally:

```ts
  return {
    success: true,
    eventId: `${BLOCK_ID_PREFIX}${block.id}`,
    scheduled: { title, when, maxParticipants: maxParticipants ?? null, instructor: args.instructor?.trim() ?? null },
  }
```

- [ ] **Step 5: Add the `instructor` property + routing note to the tool declaration**

In `src/adapters/llm/orchestrator.ts`, the `scheduleGroupSession` tool (lines 148-162):

Add an `instructor` property inside `properties` (after `serviceName`, line 153):

```ts
        instructor: { type: Type.STRING, description: 'Name of the instructor teaching this class, if the manager named one (e.g. "with Dana" → "Dana"). Must be an instructor that already exists; optional.' },
```

Update the tool `description` (line 149) to mention the instructor so the model captures "…with Dana". Replace the existing description string with:

```ts
    description: 'Proactively place a SINGLE group session / class on the calendar for one specific date (e.g. "schedule a Vinyasa class this Tuesday 11:00–12:00 with Dana, 10 spots"). Use this when the manager wants to put a one-off class on the calendar BEFORE any customer books it. Capture the instructor when the manager names one ("with Dana" → instructor: "Dana"). Links to an existing service by name when given. For 1-on-1 personal events use createCalendarEvent; to change recurring weekly hours OR to set up a class that REPEATS every week ("yoga every Monday"), use manageBusinessSettings. Report the date/time as structured pieces — NEVER compute an absolute or ISO date yourself.',
```

Update the prose routing note for `scheduleGroupSession` (line 371) to mention the instructor. Replace that bullet with:

```ts
- scheduleGroupSession: use when the manager wants to put a SINGLE class/group session on the calendar for one specific date ahead of bookings (e.g. "add a yoga class this Tuesday 11am with Dana, 10 spots"). Capture the instructor when named ("with Dana"). For a class that repeats every week ("every Monday", "weekly"), use manageBusinessSettings instead.
```

- [ ] **Step 6: Type-check + lint + unit tests (gate)**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npm run lint`
Expected: clean.

Run: `npm test`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/domain/i18n/t.ts src/domain/manager/orchestrator-tools.ts src/adapters/llm/orchestrator.ts
git commit -m "feat(studio): scheduleGroupSession attaches an instructor to the class block

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `recurring_class_change` honors `providerHint` (Gap 2)

**Goal:** "yoga every Monday 10:00 with Dana" creates a `class_series` whose `providerId` is Dana's, so the materializer stamps each weekly `calendar_blocks` instance with Dana.

**Files:**
- Modify: `src/domain/manager/apply.ts` (`applyRecurringClassChange`, `create` branch, lines 712-738)

- [ ] **Step 1: Resolve `providerHint` → providerId and pass it to `createSeries`**

In `applyRecurringClassChange`, inside the `if (p.action === 'create')` branch, after the service is resolved (`const svc = await resolveService()` and its null-guard, around line 716-719) and before the `createSeries({...})` call, add:

```ts
    // Resolve a named instructor (explicit-add model). A hint that matches no
    // existing instructor → clarify, don't silently create a provider-less series.
    let seriesProviderId: string | null = null
    if (p.providerHint && p.providerHint.trim().length > 0) {
      const found = await findProviderByName(db, businessId, p.providerHint.trim())
      if (found.status === 'none') return { ok: false, reason: i18n.apply_provider_not_found[lang](p.providerHint.trim()) }
      if (found.status === 'ambiguous') return { ok: false, reason: i18n.apply_provider_ambiguous[lang](p.providerHint.trim()) }
      seriesProviderId = found.id
    }
```

Then pass it into the `createSeries({...})` call (lines 721-732) by adding the `providerId` field:

```ts
    const { created } = await createSeries(db, {
      businessId,
      serviceTypeId: svc.id,
      providerId: seriesProviderId,
      dayOfWeek: p.dayOfWeek,
      startTime: p.startTime,
      durationMinutes: p.durationMinutes ?? svc.durationMinutes,
      maxParticipants: p.maxParticipants ?? svc.maxParticipants ?? 1,
      title: svc.name,
      startDate,
      endDate: p.endDate ?? null,
      timezone: tz,
    })
```

> `findProviderByName` and `i18n` are already imported in `apply.ts` after Task 1. `apply_provider_not_found` / `apply_provider_ambiguous` already exist (instructor-management).

- [ ] **Step 2: Type-check + lint + unit tests (gate)**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npm run lint`
Expected: clean.

Run: `npm test`
Expected: green.

- [ ] **Step 3: Commit**

```bash
git add src/domain/manager/apply.ts
git commit -m "feat(studio): recurring class series inherits the named instructor (providerHint)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Booking inherits the class's instructor (Gap 3 / D1 — the crux)

**Goal:** When a customer books a GROUP class, the booking's `providerId` comes from the matched `calendar_blocks` (type=`class`) row for that slot — NOT from `resolveProvider`. This is what makes "book yoga Monday" attribute the Monday class's instructor (Dana) rather than an arbitrary assigned instructor, and why studio instructors need no `availability` rows.

**Files:**
- Modify: `src/domain/availability/blocks.ts` (new `findClassBlockProviderForSlot`)
- Create: `src/domain/availability/blocks.test.ts` (integration-guarded unit test)
- Modify: `src/domain/booking/engine.ts` (`requestBooking`, lines 105-128)

- [ ] **Step 1: Add the class-block provider lookup helper**

In `src/domain/availability/blocks.ts`, add at the end of the file (the `eq`, `and` imports already exist on line 12):

```ts
/**
 * Find the instructor (providerId) of the scheduled class for a slot.
 *
 * Group bookings link to a class slot by (serviceTypeId, slotStart). The class
 * block placed by scheduleGroupSession / the series materializer is the SoT for
 * who teaches that slot, so a booking into the class inherits its providerId.
 * Returns:
 *  - { found: true, providerId } when a matching class block exists (providerId
 *    may still be null if the manager scheduled it without an instructor)
 *  - { found: false } when there is no class block for the slot.
 */
export async function findClassBlockProviderForSlot(
  db: Db,
  businessId: string,
  serviceTypeId: string,
  slotStart: Date,
): Promise<{ found: true; providerId: string | null } | { found: false }> {
  const [row] = await db
    .select({ providerId: calendarBlocks.providerId })
    .from(calendarBlocks)
    .where(and(
      eq(calendarBlocks.businessId, businessId),
      eq(calendarBlocks.type, 'class'),
      eq(calendarBlocks.serviceTypeId, serviceTypeId),
      eq(calendarBlocks.startTs, slotStart),
    ))
    .limit(1)
  if (!row) return { found: false }
  return { found: true, providerId: row.providerId }
}
```

- [ ] **Step 2: Write the failing unit test for the helper (DB-backed, integration-guarded)**

Create `src/domain/availability/blocks.test.ts`. This test is DB-backed, so it is gated by `integrationEnabled` and only runs LATER against a safe Postgres — but it lives in the unit tree, so guard it explicitly so `npm test` skips it cleanly:

```ts
import { describe, it, expect } from 'vitest'

const integrationEnabled = !!process.env['DATABASE_URL']

describe.skipIf(!integrationEnabled)('findClassBlockProviderForSlot', () => {
  it('returns the providerId of the class block at the slot', async () => {
    const { db } = await import('../../db/client.js')
    const { seedBusiness, teardown } = await import('../../../tests/integration/setup.js')
    const { applyProviderChange } = await import('../manager/apply.js')
    const { createBlock, findClassBlockProviderForSlot } = await import('./blocks.js')
    const { identities, serviceTypes } = await import('../../db/schema.js')
    const { and, eq } = await import('drizzle-orm')

    const biz = await seedBusiness({ timezone: 'Asia/Jerusalem' })
    try {
      const [mgr] = await db.select({ id: identities.id }).from(identities)
        .where(and(eq(identities.businessId, biz.businessId), eq(identities.role, 'manager'))).limit(1)
      await applyProviderChange(db, biz.businessId, mgr!.id, {
        action: 'add', instructorName: 'Dana', serviceNames: [biz.groupServiceName ?? biz.serviceName],
      }, 'en')
      const [dana] = await db.select({ id: identities.id }).from(identities)
        .where(and(eq(identities.businessId, biz.businessId), eq(identities.role, 'provider'))).limit(1)

      const slotStart = new Date('2026-06-15T07:00:00.000Z')
      await createBlock(db, {
        businessId: biz.businessId, type: 'class', start: slotStart,
        end: new Date(slotStart.getTime() + 3_600_000), serviceTypeId: biz.groupServiceId,
        maxParticipants: 12, providerId: dana!.id,
      })

      const hit = await findClassBlockProviderForSlot(db, biz.businessId, biz.groupServiceId, slotStart)
      expect(hit.found).toBe(true)
      if (hit.found) expect(hit.providerId).toBe(dana!.id)

      const miss = await findClassBlockProviderForSlot(db, biz.businessId, biz.groupServiceId, new Date('2026-06-16T07:00:00.000Z'))
      expect(miss.found).toBe(false)
    } finally {
      await teardown(biz.businessId)
    }
  })
})
```

> If `seedBusiness` does not expose `groupServiceName`, use `biz.serviceName` and ensure the service used is the group one — read `tests/integration/setup.ts` (`TestBusiness` has `groupServiceId`; confirm the field for its name and adjust). The `serviceTypes` import is only needed if you assert names; drop it otherwise.

- [ ] **Step 3: Verify the test is skipped today (no DB)**

Run: `npm test -- src/domain/availability/blocks.test.ts`
Expected: the suite is SKIPPED (0 failures) because `DATABASE_URL` is unset. This confirms the guard works without a DB.

- [ ] **Step 4: Wire D1 into `requestBooking`**

In `src/domain/booking/engine.ts`, import the helper (the existing `blocks.ts` is not yet imported here; add near the other domain imports after line 18):

```ts
import { findClassBlockProviderForSlot } from '../availability/blocks.js'
```

Now restructure the provider-resolution region (current lines 105-128). The current code runs `resolveProvider` + reactive gating unconditionally, then computes `isGroupClass` at line 128. Move the `isGroupClass` computation up and branch: GROUP classes take their provider from the class block; private bookings keep the existing resolve + reactive-gating path. Replace lines 105-128 (from `// Resolve provider — may override request.providerId` through `const isGroupClass = (service.maxParticipants ?? 1) > 1`) with:

```ts
  const isGroupClass = (service.maxParticipants ?? 1) > 1

  let effectiveProviderId: string | null
  let providerDisplayName: string | null = null

  if (isGroupClass) {
    // D1: a booking into a class inherits THAT class's instructor. The scheduled
    // class block (calendar_blocks type='class' at this slot) is the SoT — this
    // bypasses resolveProvider (studio instructors carry no availability rows;
    // their schedule IS their classes). An explicit request.providerId still wins.
    const classBlock = await findClassBlockProviderForSlot(db, actor.businessId, request.serviceTypeId, request.slotStart)
    effectiveProviderId = request.providerId ?? (classBlock.found ? classBlock.providerId : null)
  } else {
    // Private (1-on-1) booking: resolve provider by assignment + availability.
    const resolvedProvider = request.providerId
      ? { identityId: request.providerId, displayName: null, phoneNumber: '' }
      : await resolveProvider(db, actor.businessId, request.serviceTypeId, request.slotStart, request.slotEnd, request.providerHint, businessTz)

    // Reactive instructor gating: if the customer NAMED an instructor (providerHint)
    // who actually teaches this service but isn't free for this slot, fail with a
    // structured reason instead of silently booking provider-less. If no assigned
    // instructor matches the hint, fall through to normal (provider-agnostic) booking.
    if (!resolvedProvider && request.providerHint && request.providerHint.trim().length > 0) {
      const named = await getInstructorHours(db, actor.businessId, request.serviceTypeId, request.providerHint)
      if (named) {
        const hours = named.weeklyHours.map((h) => `${h.dayOfWeek}:${h.startTime}-${h.endTime}`).join(';')
        return { ok: false, reason: `provider_unavailable|${named.name}|${hours}` }
      }
    }

    effectiveProviderId = resolvedProvider?.identityId ?? null
    providerDisplayName = resolvedProvider?.displayName ?? null
  }

  const effectiveRequest: typeof request = effectiveProviderId
    ? { ...request, providerId: effectiveProviderId }
    : { ...request }
```

> This deletes the old standalone `const effectiveProviderId`, `const effectiveRequest`, `const providerDisplayName`, and `const isGroupClass` lines (122-128) — they are now produced inside the branch above. The downstream `if (business) { ... }` spatial block (line 138) and the `if (isGroupClass) return requestGroupClassBooking(...)` dispatch (line 167) are unchanged and still in scope.

- [ ] **Step 5: Type-check + lint + unit tests (gate)**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npm run lint`
Expected: clean.

Run: `npm test`
Expected: green (the new blocks.test.ts is skipped without a DB; existing engine-related unit tests still pass).

- [ ] **Step 6: Commit**

```bash
git add src/domain/availability/blocks.ts src/domain/availability/blocks.test.ts src/domain/booking/engine.ts
git commit -m "feat(studio): class bookings inherit the class block's instructor (D1)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Derived "who teaches what" FAQ (D3)

**Goal:** Replace the stale static instructor paragraph with a live derivation from upcoming class blocks: "Dana teaches Yoga Mon 10:00 & Wed 18:00 this week". Inject it into the manager orchestrator prompt; thread it into the customer flow reactively (Branch 4 does not volunteer it). No bio field (would need a schema column → out of scope).

**Files:**
- Modify: `src/domain/provider/roster.ts` (derive + render teaching schedule)
- Create/extend: `src/domain/provider/roster.test.ts` (unit-test the pure renderer)
- Modify: `src/adapters/llm/orchestrator.ts` (inject the derived block)
- Modify: `src/routes/webhook.ts` (load the derived schedule alongside the roster)

- [ ] **Step 1: Add the derivation + pure renderer to `roster.ts`**

In `src/domain/provider/roster.ts`, add imports for the class-block source and the local-time decomposition. Update the top imports:

```ts
import { and, eq, isNull, ilike, gte, lte } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { identities, providerAssignments, serviceTypes, availability, calendarBlocks } from '../../db/schema.js'
import { localParts } from '../availability/compute.js'
```

Add these exports at the end of the file:

```ts
export interface TeachingSlot { providerId: string; instructor: string; service: string; dayOfWeek: number; startTime: string }

/**
 * Derive "who teaches what" from the upcoming scheduled class blocks
 * (calendar_blocks type='class' with a providerId) over the next `horizonDays`.
 * This is the live source for the instructor FAQ — it reflects the actual
 * week-to-week schedule, not a typed-once paragraph. Title-only classes and
 * instructor-less classes are skipped (no providerId or no linked service).
 */
export async function loadTeachingSchedule(
  db: Db,
  businessId: string,
  timezone: string,
  horizonDays = 7,
  now: Date = new Date(),
): Promise<TeachingSlot[]> {
  const to = new Date(now.getTime() + horizonDays * 86_400_000)
  const rows = await db
    .select({
      providerId: calendarBlocks.providerId,
      instructor: identities.displayName,
      service: serviceTypes.name,
      startTs: calendarBlocks.startTs,
    })
    .from(calendarBlocks)
    .innerJoin(identities, eq(calendarBlocks.providerId, identities.id))
    .innerJoin(serviceTypes, eq(calendarBlocks.serviceTypeId, serviceTypes.id))
    .where(and(
      eq(calendarBlocks.businessId, businessId),
      eq(calendarBlocks.type, 'class'),
      gte(calendarBlocks.startTs, now),
      lte(calendarBlocks.startTs, to),
    ))

  // Dedup to one row per (provider, service, weekday, start-time) so a manager
  // sees "Dana — Yoga Mon 10:00" once even across multiple weeks in the horizon.
  const seen = new Set<string>()
  const out: TeachingSlot[] = []
  for (const r of rows) {
    if (!r.providerId || !r.instructor || !r.service) continue
    const lp = localParts(r.startTs, timezone)
    const startTime = `${String(Math.floor(lp.minutes / 60)).padStart(2, '0')}:${String(lp.minutes % 60).padStart(2, '0')}`
    const key = `${r.providerId}|${r.service}|${lp.dayOfWeek}|${startTime}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ providerId: r.providerId, instructor: r.instructor, service: r.service, dayOfWeek: lp.dayOfWeek, startTime })
  }
  return out
}

/**
 * Render the derived teaching schedule for a system prompt, grouped by
 * instructor. Pure (no DB/clock). Empty input → ''.
 */
export function buildTeachingScheduleBlock(slots: TeachingSlot[], lang: 'he' | 'en'): string {
  if (slots.length === 0) return ''
  const days = lang === 'he'
    ? ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש']
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const byInstructor = new Map<string, TeachingSlot[]>()
  for (const s of slots) {
    const arr = byInstructor.get(s.instructor) ?? []
    arr.push(s)
    byInstructor.set(s.instructor, arr)
  }
  const lines = ['Upcoming classes by instructor (live; answer on demand, do not volunteer to customers):']
  for (const [instructor, list] of byInstructor) {
    list.sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime))
    const parts = list.map((s) => `${s.service} ${days[s.dayOfWeek]} ${s.startTime}`)
    lines.push(`- ${instructor}: ${parts.join(', ')}`)
  }
  return lines.join('\n')
}
```

- [ ] **Step 2: Write the failing unit test for the pure renderer**

Append to `src/domain/provider/roster.test.ts` (create the file if it does not exist, mirroring the existing test style in `src/domain/`). Only the PURE renderer is unit-tested today; the DB derivation is covered by Task 6 integration:

```ts
import { describe, it, expect } from 'vitest'
import { buildTeachingScheduleBlock, type TeachingSlot } from './roster.js'

describe('buildTeachingScheduleBlock', () => {
  it('groups slots by instructor and renders weekday + time', () => {
    const slots: TeachingSlot[] = [
      { providerId: 'p1', instructor: 'Dana', service: 'Yoga', dayOfWeek: 1, startTime: '10:00' },
      { providerId: 'p1', instructor: 'Dana', service: 'Yoga', dayOfWeek: 3, startTime: '18:00' },
      { providerId: 'p2', instructor: 'Noa', service: 'Pilates', dayOfWeek: 2, startTime: '09:00' },
    ]
    const block = buildTeachingScheduleBlock(slots, 'en')
    expect(block).toContain('Dana: Yoga Mon 10:00, Yoga Wed 18:00')
    expect(block).toContain('Noa: Pilates Tue 09:00')
  })

  it('returns empty string for no slots', () => {
    expect(buildTeachingScheduleBlock([], 'en')).toBe('')
  })
})
```

- [ ] **Step 3: Run the renderer test (gate)**

Run: `npm test -- src/domain/provider/roster.test.ts`
Expected: PASS (the two new cases; any pre-existing DB-backed cases in that file are guarded/skipped).

- [ ] **Step 4: Inject the derived schedule into the manager orchestrator**

In `src/adapters/llm/orchestrator.ts`:

Extend the roster import (line 13) to also bring in the new helpers + type:

```ts
import { buildInstructorRosterBlock, buildTeachingScheduleBlock, type InstructorRosterEntry, type TeachingSlot } from '../../domain/provider/roster.js'
```

Add `teachingSchedule` to the `buildSystemPrompt` params type (it currently destructures `instructorRoster` around lines 320-324). Add the field to the param type object and to the destructure:

```ts
  instructorRoster: InstructorRosterEntry[]
  teachingSchedule: TeachingSlot[]
```
```ts
  const { businessName, timezone, lang, businessKnowledge, instructorRoster, teachingSchedule, managerMemorySummaries, conversationHistory } = params
```

After `const rosterBlock = buildInstructorRosterBlock(instructorRoster, lang)` (line 339) add:

```ts
  const teachingScheduleBlock = buildTeachingScheduleBlock(teachingSchedule, lang)
```

In the returned template, after the roster block line (line 376) add the teaching-schedule block:

```ts
${teachingScheduleBlock ? `\n## Upcoming classes\n${teachingScheduleBlock}` : ''}
```

Add `teachingSchedule` to `OrchestratorParams` (the field next to `instructorRoster` at line 447):

```ts
  instructorRoster: InstructorRosterEntry[]
  teachingSchedule: TeachingSlot[]
```

Destructure it in `runManagerOrchestratorLoop` (the destructure at line 464 that includes `instructorRoster`) and pass it into the `buildSystemPrompt({...})` call (around line 477, next to `instructorRoster`):

```ts
    businessName, timezone, lang, calendar, transcript, businessKnowledge, instructorRoster, teachingSchedule,
```
```ts
    instructorRoster,
    teachingSchedule,
```

- [ ] **Step 5: Load the derived schedule in the webhook**

In `src/routes/webhook.ts`, extend the roster import (line 49):

```ts
import { loadInstructorRoster, loadTeachingSchedule } from '../domain/provider/roster.js'
```

At the orchestrator load site (lines 794-796), add the derivation to the `Promise.all`:

```ts
  const [mgBusinessKnowledgeForOrchestrator, mgInstructorRoster, mgTeachingSchedule] = await Promise.all([
    loadBusinessKnowledge(db, business.id, business.currency),
    loadInstructorRoster(db, business.id),
    loadTeachingSchedule(db, business.id, business.timezone),
  ])
```

> Confirm `business.timezone` is selected on the `business` object in this scope. If the local `business` row does not include `timezone`, use the timezone variable already in scope for this handler (search upward for `timezone`/`business.timezone`); the orchestrator is already passed a `timezone`.

In the `runManagerOrchestratorLoop({ ... })` call (around line 827, next to `instructorRoster: mgInstructorRoster`), add:

```ts
      teachingSchedule: mgTeachingSchedule,
```

- [ ] **Step 6: Type-check + lint + unit tests (gate)**

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npm run lint`
Expected: clean.

Run: `npm test`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add src/domain/provider/roster.ts src/domain/provider/roster.test.ts src/adapters/llm/orchestrator.ts src/routes/webhook.ts
git commit -m "feat(studio): derive live 'who teaches what' from upcoming class blocks (D3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Integration tests — schedule-with-Dana → book → Dana attributed

**Files:**
- Create: `tests/integration/studio-class-scheduling.test.ts`

These are committed now and EXECUTED LATER against a safe Postgres. They mirror the harness of `tests/integration/instructor-booking.test.ts` (read it first for `seedBusiness`/`seedCustomer`/`teardown`/`createCalendarClient` usage and the `TestBusiness` shape — note `groupServiceId` for the group/class service).

- [ ] **Step 1: Write the integration test**

Create `tests/integration/studio-class-scheduling.test.ts`:

```ts
// Integration coverage for studio week-to-week class scheduling:
//  - schedule a one-off class WITH an instructor → the class block carries providerId
//  - a customer booking INTO that class inherits the instructor (D1)
//  - per-class capacity is still enforced
//  - the correct instructor is attributed per slot when two instructors teach the same service
// Needs DATABASE_URL but NOT an LLM key. Run LATER: npm run test:integration
import { vi } from 'vitest'

vi.mock('../../src/redis.js', () => ({
  redisConnection: { quit: vi.fn(), on: vi.fn(), disconnect: vi.fn() },
}))
vi.mock('../../src/workers/message-retry.js', () => ({
  enqueueMessage: vi.fn().mockResolvedValue(undefined),
  messageRetryQueue: { add: vi.fn() },
  startMessageRetryWorker: vi.fn(),
}))
vi.mock('../../src/workers/calendar-mirror.js', () => ({
  enqueueBlockMirror: vi.fn().mockResolvedValue(undefined),
  enqueueBlockDeletion: vi.fn().mockResolvedValue(undefined),
  enqueueBookingDeletion: vi.fn().mockResolvedValue(undefined),
  startCalendarMirrorWorker: vi.fn(),
}))

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '../../src/db/client.js'
import { identities, bookings } from '../../src/db/schema.js'
import { seedBusiness, seedCustomer, teardown, integrationEnabled } from './setup.js'
import type { TestBusiness } from './setup.js'
import { applyProviderChange } from '../../src/domain/manager/apply.js'
import { createBlock } from '../../src/domain/availability/blocks.js'
import { requestBooking } from '../../src/domain/booking/engine.js'
import { localTimeToUtc } from '../../src/domain/availability/compute.js'
import { createCalendarClient } from '../../src/adapters/calendar/client.js'
import { findProviderByName } from '../../src/domain/provider/lookup.js'
import type { ResolvedIdentity } from '../../src/domain/identity/types.js'

const TZ = 'Asia/Jerusalem'
const MONDAY = '2026-06-15'    // a Monday
const WEDNESDAY = '2026-06-17' // a Wednesday

const calendar = () => createCalendarClient({
  accessToken: '', refreshToken: '', calendarId: 'test', businessId: '', calendarMode: 'internal', lang: 'en',
})

async function managerId(businessId: string): Promise<string> {
  const [mgr] = await db.select({ id: identities.id }).from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.role, 'manager'))).limit(1)
  if (!mgr) throw new Error('manager identity not found')
  return mgr.id
}
async function providerId(businessId: string, name: string): Promise<string> {
  const r = await findProviderByName(db, businessId, name)
  if (r.status !== 'found') throw new Error(`provider ${name} not resolvable: ${r.status}`)
  return r.id
}
function customerOf(id: string, businessId: string, phone: string): ResolvedIdentity {
  return { id, businessId, phoneNumber: phone, role: 'customer', displayName: null, messagingOptOut: false, preferredLanguage: null, conversationPausedUntil: null }
}

describe.skipIf(!integrationEnabled)('studio class scheduling', () => {
  let biz: TestBusiness
  let actorId: string

  beforeEach(async () => {
    biz = await seedBusiness({ available247: true, timezone: TZ })
    actorId = await managerId(biz.businessId)
    // Explicit-add instructors (studio model: NO weekly hours).
    await applyProviderChange(db, biz.businessId, actorId, { action: 'add', instructorName: 'Dana', serviceNames: [biz.groupServiceName ?? biz.serviceName] }, 'en')
    await applyProviderChange(db, biz.businessId, actorId, { action: 'add', instructorName: 'Noa', serviceNames: [biz.groupServiceName ?? biz.serviceName] }, 'en')
  })
  afterEach(async () => { await teardown(biz.businessId) })

  it('a class scheduled with Dana → a customer booking inherits Dana (D1)', async () => {
    const danaId = await providerId(biz.businessId, 'Dana')
    const start = localTimeToUtc(MONDAY, '10:00', TZ)
    const end = new Date(start.getTime() + 3_600_000)
    await createBlock(db, { businessId: biz.businessId, type: 'class', start, end, serviceTypeId: biz.groupServiceId, maxParticipants: 12, providerId: danaId })

    const custId = await seedCustomer(biz.businessId, '+972500000001')
    const res = await requestBooking(db, calendar(), customerOf(custId, biz.businessId, '+972500000001'), {
      serviceTypeId: biz.groupServiceId, slotStart: start, slotEnd: end,
    })
    expect(res.ok).toBe(true)
    const [bk] = await db.select({ providerId: bookings.providerId }).from(bookings)
      .where(and(eq(bookings.businessId, biz.businessId), eq(bookings.customerId, custId))).limit(1)
    expect(bk?.providerId).toBe(danaId)
  })

  it('the right instructor is attributed per slot (Dana Mon vs Noa Wed)', async () => {
    const danaId = await providerId(biz.businessId, 'Dana')
    const noaId = await providerId(biz.businessId, 'Noa')
    const mon = localTimeToUtc(MONDAY, '10:00', TZ)
    const wed = localTimeToUtc(WEDNESDAY, '18:00', TZ)
    await createBlock(db, { businessId: biz.businessId, type: 'class', start: mon, end: new Date(mon.getTime() + 3_600_000), serviceTypeId: biz.groupServiceId, maxParticipants: 12, providerId: danaId })
    await createBlock(db, { businessId: biz.businessId, type: 'class', start: wed, end: new Date(wed.getTime() + 3_600_000), serviceTypeId: biz.groupServiceId, maxParticipants: 12, providerId: noaId })

    const c1 = await seedCustomer(biz.businessId, '+972500000002')
    const c2 = await seedCustomer(biz.businessId, '+972500000003')
    await requestBooking(db, calendar(), customerOf(c1, biz.businessId, '+972500000002'), { serviceTypeId: biz.groupServiceId, slotStart: mon, slotEnd: new Date(mon.getTime() + 3_600_000) })
    await requestBooking(db, calendar(), customerOf(c2, biz.businessId, '+972500000003'), { serviceTypeId: biz.groupServiceId, slotStart: wed, slotEnd: new Date(wed.getTime() + 3_600_000) })

    const [b1] = await db.select({ providerId: bookings.providerId }).from(bookings).where(and(eq(bookings.businessId, biz.businessId), eq(bookings.customerId, c1))).limit(1)
    const [b2] = await db.select({ providerId: bookings.providerId }).from(bookings).where(and(eq(bookings.businessId, biz.businessId), eq(bookings.customerId, c2))).limit(1)
    expect(b1?.providerId).toBe(danaId)
    expect(b2?.providerId).toBe(noaId)
  })

  it('per-class capacity is enforced', async () => {
    const danaId = await providerId(biz.businessId, 'Dana')
    const start = localTimeToUtc(MONDAY, '10:00', TZ)
    const end = new Date(start.getTime() + 3_600_000)
    await createBlock(db, { businessId: biz.businessId, type: 'class', start, end, serviceTypeId: biz.groupServiceId, maxParticipants: 1, providerId: danaId })

    const c1 = await seedCustomer(biz.businessId, '+972500000004')
    const c2 = await seedCustomer(biz.businessId, '+972500000005')
    const r1 = await requestBooking(db, calendar(), customerOf(c1, biz.businessId, '+972500000004'), { serviceTypeId: biz.groupServiceId, slotStart: start, slotEnd: end })
    const r2 = await requestBooking(db, calendar(), customerOf(c2, biz.businessId, '+972500000005'), { serviceTypeId: biz.groupServiceId, slotStart: start, slotEnd: end })
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(false) // class full (1/1)
  })
})
```

> **Executor must reconcile harness specifics by reading `tests/integration/setup.ts`:** the exact `TestBusiness` field for the group service NAME (the plan uses `biz.groupServiceName ?? biz.serviceName`; if no such field, pass the literal group service name the seed uses), the `seedCustomer` return type/signature, and whether group bookings auto-confirm or need a confirm step for the capacity test (mirror exactly how `instructor-booking.test.ts` occupies a slot — if `requested`/`held` already counts toward capacity, no confirm needed; the capacity query counts `requested`/`confirmed`/`pending_payment`).

- [ ] **Step 2: Verify the file is skipped under the unit runner (no DB)**

Run: `npm test`
Expected: green. The integration file is excluded from the unit run (`vitest.config.ts` excludes `tests/integration/**`), so it does not execute here.

- [ ] **Step 3: Type-check (gate)**

Run: `npx tsc --noEmit`
Expected: clean (the test file compiles against the real signatures).

- [ ] **Step 4: Commit**

```bash
git add tests/integration/studio-class-scheduling.test.ts
git commit -m "test(studio): integration — schedule with Dana, book, inherit instructor, capacity

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7 (OPTIONAL, droppable): onboarding nudge for volunteered instructors

**Drop this task if keeping onboarding lean.** Per the spec §5: after the owner volunteers instructors during setup, the PA nudges ONCE — "I noted your instructors — want them bookable? Just say 'add Dana as a yoga instructor'." It never auto-creates.

**Files:**
- Modify: the onboarding flow that captures the instructor/staff FAQ answer (search: `grep -rn "instructor\|מדריך" src/domain/flows/manager-onboarding.ts src/domain/onboarding* 2>/dev/null` to locate where volunteered staff text is stored).

- [ ] **Step 1: Locate the capture point + decide feasibility**

Run: `grep -rn "instructor\|staff\|מדריך\|מורה" src/domain/flows/ src/routes/webhook.ts | grep -i onboard`
If there is no clean single capture point, **drop this task** and note it in the final report. Otherwise, append a one-time nudge string to the onboarding confirmation when the captured FAQ text mentions instructor-like terms, gated so it fires once. Do NOT create any provider rows.

- [ ] **Step 2: Type-check + lint + unit tests + commit (only if implemented)**

Run: `npx tsc --noEmit` / `npm run lint` / `npm test` → all clean/green.

```bash
git commit -am "feat(onboarding): one-time nudge to make volunteered instructors bookable

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (gates that run TODAY)

- [ ] `npx tsc --noEmit` — clean.
- [ ] `npm run lint` — clean.
- [ ] `npm test` — unit suite green; the DB-backed `blocks.test.ts` and all `tests/integration/**` are skipped/excluded without `DATABASE_URL`.
- [ ] `git diff main...HEAD --stat` — confirm NO changes under `src/skills/`, `src/domain/availability/compute.ts`, or `src/domain/provider/resolver.ts`.
- [ ] Confirm NO migration files added: `git diff --name-only main...HEAD | grep -c 'db/migrations'` → `0`.

## Deferred verification (LATER, against a SAFE Postgres only — never prod)

- [ ] `npm run test:integration` — `studio-class-scheduling.test.ts` + `blocks.test.ts` green; existing integration suite stays green.

## Deploy (after gates pass + branch merged to main per workflow)

- [ ] `./deploy.sh --watch` (tags next version, pushes main, Cloud Build → Cloud Run). No DB migration needed.
- [ ] After deploy: confirm health returns `{"status":"ok"}` and a new Cloud Run revision is live.
- [ ] Do NOT touch `PROVIDER_WA_NUMBER` or `OPERATOR_PHONE` env vars. The `.claude/` exclude from Task 0 keeps stray files out of `deploy.sh`'s `git add -A`.

---

## Self-review notes (author)

- **Spec §3 gap 1 (scheduleGroupSession instructor):** Task 2 — arg + resolve-existing-provider + clarify + `createBlock` providerId + tool schema/routing.
- **Spec §3 gap 2 (recurring providerHint):** Task 3 — resolve `providerHint` → `createSeries` providerId.
- **Spec §3 gap 3 / §6.1 (D1 book-into-class inherits instructor):** Task 4 — `findClassBlockProviderForSlot` + engine branch (group class sources providerId from the block, bypassing resolveProvider; private path unchanged incl. reactive gating).
- **Spec §4 (D3 FAQ derived + dynamic):** Task 5 — `loadTeachingSchedule` from upcoming class blocks + pure renderer + manager orchestrator injection + webhook load. Customer side stays reactive (the block is labelled "do not volunteer"; no customer-initiated push added). Bio field DROPPED (needs a schema column — out of scope per "no schema changes").
- **Spec §5 (onboarding nudge):** Task 7 — optional/droppable, no auto-create.
- **Spec "no new tables / no migration":** honored — only reads/writes to existing `calendar_blocks`, `class_series`, `bookings`, `identities`, `provider_assignments`.
- **Reuse:** `findProviderByName` extracted once (Task 1) and reused in Tasks 2 + 3; `createBlock`/`createSeries` already accept `providerId`; `getInstructorHours`/`resolveProvider`/`compute.ts` untouched.
- **Type consistency:** `findProviderByName(db, businessId, name) → {status:'found'|'none'|'ambiguous'}` identical in lookup.ts, apply.ts, orchestrator-tools.ts, and the integration helper. `findClassBlockProviderForSlot(db, businessId, serviceTypeId, slotStart) → {found:true,providerId}|{found:false}` identical in blocks.ts + engine.ts + blocks.test.ts. `TeachingSlot`/`buildTeachingScheduleBlock`/`loadTeachingSchedule` signatures identical across roster.ts, roster.test.ts, orchestrator.ts, webhook.ts.
- **Open dependency the executor must resolve:** the exact `TestBusiness` group-service field name and group-booking confirm/capacity mechanics — read `tests/integration/setup.ts` and `tests/integration/instructor-booking.test.ts` and mirror them (flagged in Task 6 Step 1).
```
