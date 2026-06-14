# Conversational Instructor Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a business owner set up and manage their teaching team by chatting with the PA ("Add Dana as a yoga instructor, Mon/Wed 9–13"), so the already-built booking engine can resolve "book yoga with Dana", respect her hours, and prevent double-booking.

**Architecture:** A new `provider_change` instruction type flows through the existing §1.7 apply seam (`manageBusinessSettings` tool → `classifyManagerInstruction` → `applyInstruction`). Instructors are `identities` rows with a new `provider` role; their hours are `availability` rows scoped by `providerId`. The canonical availability compute seam is NOT touched — per-instructor hours are enforced only at resolution time. The manager-facing roster is injected into the orchestrator system prompt (like business knowledge); the customer-facing flow stays strictly reactive about instructors.

**Tech Stack:** TypeScript, Drizzle ORM (Postgres), Zod, Vitest, Google GenAI (Gemini) classifier. All work is Developer A domain — no `src/skills/` changes, no DB migration.

**Spec:** `docs/superpowers/specs/2026-06-14-conversational-instructor-management-design.md`

**Branch:** `dev/system/branch3-instructor-management` (already checked out).

---

## Conventions for every task

- Run `npx tsc --noEmit` before committing — must be clean.
- Run `npm test` (unit) for tasks that add unit tests.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- Do NOT modify `src/domain/availability/compute.ts`, `src/domain/provider/resolver.ts` (read-side is done — additive helpers go in `roster.ts`), or anything under `src/skills/`.

---

## Task 1: Add the `provider` identity role

**Files:**
- Modify: `src/db/schema.ts` (the `identities` table `role` enum, ~line 83)
- Modify: `src/db/schema.ts` types if `IdentityRole` is referenced (it is exported ~line 728 — no change needed, it derives from the column)

- [ ] **Step 1: Verify there is no DB CHECK constraint on `identities.role`**

The spec claims `role` is a Drizzle text-enum (TypeScript-only, no DB constraint), so adding a value needs no migration. Verify against prod via the running Cloud SQL proxy (port 5434, started earlier this session). Create a throwaway script:

```js
// verify_role_check.mjs (delete after)
import fs from 'node:fs';
const envl = fs.readFileSync('.env.local','utf8');
for (const l of envl.split('\n')) { const m=l.match(/^([A-Z_]+)=(.*)$/); if(m&&!process.env[m[1]]) process.env[m[1]]=m[2].replace(/^["']|["']$/g,''); }
const postgres = (await import('postgres')).default;
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const rows = await sql`
  select con.conname, pg_get_constraintdef(con.oid) as def
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  where rel.relname = 'identities' and con.contype = 'c'`;
console.log('CHECK constraints on identities:', rows.length ? rows : '(none)');
await sql.end();
```

Run: `node verify_role_check.mjs`
Expected: `(none)` — or, if any CHECK references `role`, STOP and add a migration to widen it. (If `(none)`, no migration is needed.)
Then: `rm verify_role_check.mjs`

- [ ] **Step 2: Add `'provider'` to the role enum**

In `src/db/schema.ts`, the `identities` table:

```ts
role: text('role', { enum: ['manager', 'delegated_user', 'customer'] }).notNull(),
```

becomes:

```ts
role: text('role', { enum: ['manager', 'delegated_user', 'customer', 'provider'] }).notNull(),
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: clean. (`IdentityRole` now includes `'provider'`; the `authorize()` switch in `check.ts` is exhaustive over roles — TypeScript will flag it as a missing case. That is fixed in Task 2; if `tsc` complains about a missing `'provider'` case in `authorize`, proceed to Task 2 before committing, then commit both together. If it does NOT complain, commit now.)

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts
git commit -m "feat(branch3): add 'provider' identity role for instructors

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Add the `staff.manage` authorization action

**Files:**
- Modify: `src/domain/authorization/check.ts`
- Test: `src/domain/authorization/check.test.ts` (create if absent; check first with `ls src/domain/authorization/`)

- [ ] **Step 1: Write the failing test**

Check whether a test file exists: `ls src/domain/authorization/`. If `check.test.ts` exists, append; otherwise create `src/domain/authorization/check.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { authorize, requiredActionForInstruction } from './check.js'

describe('staff.manage action', () => {
  it('managers may staff.manage', () => {
    expect(authorize({ role: 'manager' }, 'staff.manage')).toEqual({ allowed: true })
  })

  it('customers may not staff.manage', () => {
    expect(authorize({ role: 'customer' }, 'staff.manage').allowed).toBe(false)
  })

  it('delegated_user may staff.manage only when granted', () => {
    expect(authorize({ role: 'delegated_user' }, 'staff.manage').allowed).toBe(false)
    expect(
      authorize({ role: 'delegated_user', delegatedPermissions: new Set(['staff.manage']) }, 'staff.manage'),
    ).toEqual({ allowed: true })
  })

  it('provider_change maps to staff.manage', () => {
    expect(requiredActionForInstruction('provider_change')).toBe('staff.manage')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/domain/authorization/check.test.ts`
Expected: FAIL — `'staff.manage'` is not assignable to `Action` / `requiredActionForInstruction('provider_change')` returns `null`.

- [ ] **Step 3: Implement**

In `src/domain/authorization/check.ts`:

Add `'staff.manage'` to the `Action` union:

```ts
export type Action =
  | 'booking.request'
  | 'booking.cancel_own'
  | 'booking.cancel_any'
  | 'booking.reschedule_own'
  | 'booking.reschedule_any'
  | 'booking.view_availability'
  | 'schedule.set_availability'
  | 'service.modify'
  | 'permission.manage'
  | 'policy.change'
  | 'staff.manage'
```

Add it to `MANAGER_ACTIONS`:

```ts
const MANAGER_ACTIONS = new Set<Action>([
  'booking.request',
  'booking.cancel_own',
  'booking.cancel_any',
  'booking.reschedule_own',
  'booking.reschedule_any',
  'booking.view_availability',
  'schedule.set_availability',
  'service.modify',
  'permission.manage',
  'policy.change',
  'staff.manage',
])
```

Add a case to `requiredActionForInstruction`:

```ts
    case 'permission_change':
      return 'permission.manage'
    case 'provider_change':
      return 'staff.manage'
    case 'booking_cancellation':
      return 'booking.cancel_any'
```

If Task 1's `tsc` flagged a missing `'provider'` case in `authorize()`, add it (providers have no special powers — treat like the customer baseline or deny). Add this case to the `switch (ctx.role)` in `authorize`:

```ts
    case 'provider':
      // Instructors do not operate the PA in V1; grant only the customer baseline.
      if (CUSTOMER_ACTIONS.has(action)) return { allowed: true }
      return { allowed: false, reason: `Action '${action}' is not available to providers` }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/domain/authorization/check.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Type-check and commit**

Run: `npx tsc --noEmit` → clean.

```bash
git add src/domain/authorization/check.ts src/domain/authorization/check.test.ts src/db/schema.ts
git commit -m "feat(branch3): add staff.manage action + provider role authorization

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: i18n strings for instructor operations

**Files:**
- Modify: `src/domain/i18n/t.ts` (alongside the other `apply_*` keys, ~line 461)

- [ ] **Step 1: Add the keys**

In `src/domain/i18n/t.ts`, after `apply_permission_not_found` (~line 438), add:

```ts
  apply_provider_added: {
    he: (name: string, services: string, hours: string) => `הוספתי את ${name} כמדריך/ה ל${services}${hours}.`,
    en: (name: string, services: string, hours: string) => `Added ${name} as an instructor for ${services}${hours}.`,
  },
  apply_provider_hours_set: {
    he: (name: string, hours: string) => `עדכנתי את השעות של ${name}${hours}.`,
    en: (name: string, hours: string) => `Updated ${name}'s hours${hours}.`,
  },
  apply_provider_assigned: {
    he: (name: string, service: string) => `${name} מלמד/ת עכשיו גם ${service}.`,
    en: (name: string, service: string) => `${name} now also teaches ${service}.`,
  },
  apply_provider_unassigned: {
    he: (name: string, service: string) => `${name} כבר לא מלמד/ת ${service}.`,
    en: (name: string, service: string) => `${name} no longer teaches ${service}.`,
  },
  apply_provider_removed: {
    he: (name: string) => `הסרתי את ${name} מרשימת המדריכים.`,
    en: (name: string) => `Removed ${name} from the instructor list.`,
  },
  apply_provider_not_found: {
    he: (name: string) => `לא נמצא מדריך/ה בשם ${name}.`,
    en: (name: string) => `No instructor named ${name} found.`,
  },
  apply_provider_ambiguous: {
    he: (name: string) => `יש יותר ממדריך/ה אחד/ת בשם ${name}. למי מהם התכוונת?`,
    en: (name: string) => `There's more than one instructor named ${name}. Which did you mean?`,
  },
  apply_provider_service_not_found: {
    he: (service: string) => `שירות "${service}" לא נמצא. רוצה שאוסיף אותו קודם?`,
    en: (service: string) => `Service "${service}" not found. Want me to add it first?`,
  },
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/domain/i18n/t.ts
git commit -m "feat(branch3): i18n strings for instructor management

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `applyProviderChange` — `add` action

**Files:**
- Modify: `src/domain/manager/apply.ts` (add schema near the other schemas ~line 96; add handler; add switch case ~line 147)
- Modify: imports at top of `apply.ts` to include `providerAssignments`
- Test: `src/domain/manager/apply.provider.test.ts` (create)

Notes on shape (used across Tasks 4 & 5):
```
action: 'add' | 'set_hours' | 'assign_service' | 'unassign_service' | 'remove'
instructorName: string
phone?: string | null
serviceNames?: string[]
weeklyHours?: { dayOfWeek: 0-6, startTime: 'HH:MM', endTime: 'HH:MM' }[]
```

- [ ] **Step 1: Write the failing test**

Create `src/domain/manager/apply.provider.test.ts`. This is an integration-style unit test against a real test DB (the suite already has DB-backed apply tests — check an existing one like `apply.*.test.ts` for the `makeTestDb`/seed helper and mirror its setup). If a shared helper exists (e.g. `tests/integration/setup.ts` `seedBusiness`), use it; otherwise follow the pattern in the nearest existing `apply` test. The assertions:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { identities, providerAssignments, availability, serviceTypes } from '../../db/schema.js'
// import the DB + seed helpers the existing apply tests use:
import { makeTestDb, seedBusinessWithService } from './test-helpers.js' // adjust to actual helper path
import { applyProviderChange } from './apply.js'

describe('applyProviderChange — add', () => {
  let db: Awaited<ReturnType<typeof makeTestDb>>
  let businessId: string
  let actorId: string
  let yogaId: string

  beforeEach(async () => {
    ;({ db, businessId, actorId, serviceId: yogaId } = await seedBusinessWithService({ serviceName: 'יוגה' }))
  })

  it('creates a provider identity, assignment, and weekly availability (name-only → synthetic phone)', async () => {
    const res = await applyProviderChange(db, businessId, actorId, {
      action: 'add',
      instructorName: 'Dana',
      serviceNames: ['יוגה'],
      weeklyHours: [
        { dayOfWeek: 1, startTime: '09:00', endTime: '13:00' },
        { dayOfWeek: 3, startTime: '09:00', endTime: '13:00' },
      ],
    }, 'en')

    expect(res.ok).toBe(true)

    const [prov] = await db.select().from(identities)
      .where(and(eq(identities.businessId, businessId), eq(identities.role, 'provider')))
    expect(prov.displayName).toBe('Dana')
    expect(prov.phoneNumber).toMatch(/^provider:/)      // synthetic placeholder
    expect(prov.messagingOptOut).toBe(true)

    const assigns = await db.select().from(providerAssignments)
      .where(and(eq(providerAssignments.businessId, businessId), eq(providerAssignments.identityId, prov.id)))
    expect(assigns).toHaveLength(1)
    expect(assigns[0].serviceTypeId).toBe(yogaId)

    const hours = await db.select().from(availability)
      .where(eq(availability.providerId, prov.id))
    expect(hours.map(h => h.dayOfWeek).sort()).toEqual([1, 3])
  })

  it('is idempotent — re-adding the same instructor does not duplicate', async () => {
    const params = { action: 'add' as const, instructorName: 'Dana', serviceNames: ['יוגה'], weeklyHours: [{ dayOfWeek: 1, startTime: '09:00', endTime: '13:00' }] }
    await applyProviderChange(db, businessId, actorId, params, 'en')
    await applyProviderChange(db, businessId, actorId, params, 'en')
    const provs = await db.select().from(identities).where(and(eq(identities.businessId, businessId), eq(identities.role, 'provider')))
    expect(provs).toHaveLength(1)
    const assigns = await db.select().from(providerAssignments).where(eq(providerAssignments.identityId, provs[0].id))
    expect(assigns).toHaveLength(1)
  })

  it('clarifies when the named service does not exist', async () => {
    const res = await applyProviderChange(db, businessId, actorId, {
      action: 'add', instructorName: 'Dana', serviceNames: ['spin'], weeklyHours: [],
    }, 'en')
    expect(res.ok).toBe(false)
  })
})
```

> If no reusable DB/seed helper exists, first read an existing DB-backed test in `src/domain/manager/` or `tests/integration/setup.ts` and reuse its exact harness. Do not invent a new harness.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/domain/manager/apply.provider.test.ts`
Expected: FAIL — `applyProviderChange` is not exported.

- [ ] **Step 3: Add the import and schema**

In `src/domain/manager/apply.ts`, add `providerAssignments` to the schema import:

```ts
import { availability, serviceTypes, identities, managerInstructions, bookings, businesses, processedMessages, classSeries, providerAssignments } from '../../db/schema.js'
```

Add the schema near the other `*Schema` consts (after `recurringClassChangeSchema`):

```ts
const weeklyHoursSchema = z.object({
  dayOfWeek: z.coerce.number().int().min(0).max(6),
  startTime: z.string().regex(TIME_REGEX, 'startTime must be HH:MM'),
  endTime: z.string().regex(TIME_REGEX, 'endTime must be HH:MM'),
})

const providerChangeSchema = z.object({
  action: z.enum(['add', 'set_hours', 'assign_service', 'unassign_service', 'remove']),
  instructorName: z.string().min(1),
  phone: z.string().nullable().optional(),
  serviceNames: z.array(z.string()).optional(),
  weeklyHours: z.array(weeklyHoursSchema).optional(),
})
```

- [ ] **Step 4: Implement `applyProviderChange` with the `add` branch**

Add this exported function in `apply.ts` (near the other `apply*` handlers). It must be `export async function` so the test and switch can call it:

```ts
// ── Provider (instructor) change ──────────────────────────────────────────────

/** Build a synthetic, unique, non-null placeholder phone for a name-only instructor. */
function syntheticProviderPhone(): string {
  return `provider:${crypto.randomUUID()}@local`
}

/** Resolve a service name (case-insensitive) to its id within the business. */
async function findServiceByName(db: Db, businessId: string, name: string): Promise<{ id: string; name: string } | null> {
  const [svc] = await db
    .select({ id: serviceTypes.id, name: serviceTypes.name })
    .from(serviceTypes)
    .where(and(eq(serviceTypes.businessId, businessId), ilike(serviceTypes.name, name), eq(serviceTypes.isActive, true)))
    .limit(1)
  return svc ?? null
}

/** Resolve an active provider identity by display name within the business.
 *  Returns 'ambiguous' when more than one matches. */
async function findProviderByName(
  db: Db, businessId: string, name: string,
): Promise<{ status: 'found'; id: string } | { status: 'none' } | { status: 'ambiguous' }> {
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

/** Human-readable hours fragment for confirmations, e.g. " (Mon/Wed 09:00–13:00)". */
function hoursFragment(weeklyHours: { dayOfWeek: number; startTime: string; endTime: string }[], lang: Lang): string {
  if (weeklyHours.length === 0) return ''
  const parts = weeklyHours.map((h) => `${dayName(h.dayOfWeek, lang)} ${h.startTime}–${h.endTime}`)
  return ` (${parts.join(', ')})`
}

export async function applyProviderChange(
  db: Db,
  businessId: string,
  actorId: string,
  params: Record<string, unknown>,
  lang: Lang = 'he',
): Promise<ApplyResult> {
  const parsed = providerChangeSchema.safeParse(params)
  if (!parsed.success) {
    return { ok: false, reason: `Invalid provider params: ${parsed.error.message}` }
  }
  const p = parsed.data

  if (p.action === 'add') {
    // Resolve services first — unknown service → clarify, do not auto-create.
    const serviceNames = p.serviceNames ?? []
    const services: { id: string; name: string }[] = []
    for (const name of serviceNames) {
      const svc = await findServiceByName(db, businessId, name)
      if (!svc) return { ok: false, reason: i18n.apply_provider_service_not_found[lang](name) }
      services.push(svc)
    }

    // Find-or-create the provider identity (by display name).
    const existing = await findProviderByName(db, businessId, p.instructorName)
    if (existing.status === 'ambiguous') return { ok: false, reason: i18n.apply_provider_ambiguous[lang](p.instructorName) }

    let providerId: string
    if (existing.status === 'found') {
      providerId = existing.id
    } else {
      const phone = p.phone && p.phone.trim().length > 0 ? p.phone.trim() : syntheticProviderPhone()
      const [created] = await db.insert(identities).values({
        businessId,
        phoneNumber: phone,
        role: 'provider',
        displayName: p.instructorName,
        messagingOptOut: !(p.phone && p.phone.trim().length > 0), // name-only → no notifications
        grantedBy: actorId,
        grantedAt: new Date(),
      }).onConflictDoNothing().returning({ id: identities.id })
      if (created) {
        providerId = created.id
      } else {
        // Conflict on (businessId, phoneNumber) — fetch the existing row.
        const [row] = await db.select({ id: identities.id }).from(identities)
          .where(and(eq(identities.businessId, businessId), eq(identities.phoneNumber, phone))).limit(1)
        providerId = row!.id
      }
    }

    // Assign services (idempotent on the unique (identityId, serviceTypeId) index).
    for (const svc of services) {
      await db.insert(providerAssignments).values({
        businessId, identityId: providerId, serviceTypeId: svc.id, isActive: true,
      }).onConflictDoUpdate({
        target: [providerAssignments.identityId, providerAssignments.serviceTypeId],
        set: { isActive: true },
      })
    }

    // Set weekly availability (replace any existing weekly rows for this provider).
    if (p.weeklyHours && p.weeklyHours.length > 0) {
      await db.delete(availability).where(and(
        eq(availability.providerId, providerId),
        isNull(availability.specificDate), // weekly rows only — leave date-specific blocks
      ))
      for (const h of p.weeklyHours) {
        await db.insert(availability).values({
          businessId, providerId, dayOfWeek: h.dayOfWeek, openTime: h.startTime, closeTime: h.endTime, isBlocked: false,
        })
      }
    }

    const servicesStr = services.map((s) => s.name).join(', ')
    return { ok: true, confirmationMessage: i18n.apply_provider_added[lang](p.instructorName, servicesStr, hoursFragment(p.weeklyHours ?? [], lang)) }
  }

  // Other actions implemented in Task 5.
  return { ok: false, reason: i18n.apply_unknown_type[lang](`provider_change:${p.action}`) }
}
```

> Note: `crypto.randomUUID()` is globally available in the project's Node runtime (Node ≥ 18). If `tsc` complains, import it: `import { randomUUID } from 'node:crypto'` and call `randomUUID()`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/domain/manager/apply.provider.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Type-check and commit**

Run: `npx tsc --noEmit` → clean.

```bash
git add src/domain/manager/apply.ts src/domain/manager/apply.provider.test.ts
git commit -m "feat(branch3): applyProviderChange add action (create instructor + assign + hours)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: `applyProviderChange` — `set_hours`, `assign_service`, `unassign_service`, `remove`

**Files:**
- Modify: `src/domain/manager/apply.ts` (extend `applyProviderChange`)
- Test: `src/domain/manager/apply.provider.test.ts` (extend)

- [ ] **Step 1: Write the failing tests**

Append to `src/domain/manager/apply.provider.test.ts`:

```ts
describe('applyProviderChange — edits', () => {
  let db: Awaited<ReturnType<typeof makeTestDb>>
  let businessId: string, actorId: string

  beforeEach(async () => {
    ;({ db, businessId, actorId } = await seedBusinessWithService({ serviceName: 'יוגה' }))
    await seedBusinessWithService({ db, businessId, serviceName: 'פילאטיס' } as any) // add a 2nd service to same business; adjust to helper
    await applyProviderChange(db, businessId, actorId, {
      action: 'add', instructorName: 'Dana', serviceNames: ['יוגה'],
      weeklyHours: [{ dayOfWeek: 1, startTime: '09:00', endTime: '13:00' }],
    }, 'en')
  })

  it('set_hours replaces weekly availability', async () => {
    await applyProviderChange(db, businessId, actorId, {
      action: 'set_hours', instructorName: 'Dana',
      weeklyHours: [{ dayOfWeek: 2, startTime: '10:00', endTime: '14:00' }],
    }, 'en')
    const [prov] = await db.select().from(identities).where(and(eq(identities.businessId, businessId), eq(identities.role, 'provider')))
    const hours = await db.select().from(availability).where(eq(availability.providerId, prov.id))
    expect(hours).toHaveLength(1)
    expect(hours[0].dayOfWeek).toBe(2)
    expect(hours[0].openTime).toBe('10:00:00') // postgres time returns HH:MM:SS — adjust if helper normalizes
  })

  it('assign_service then unassign_service toggles isActive', async () => {
    await applyProviderChange(db, businessId, actorId, { action: 'assign_service', instructorName: 'Dana', serviceNames: ['פילאטיס'] }, 'en')
    const [prov] = await db.select().from(identities).where(and(eq(identities.businessId, businessId), eq(identities.role, 'provider')))
    let active = await db.select().from(providerAssignments).where(and(eq(providerAssignments.identityId, prov.id), eq(providerAssignments.isActive, true)))
    expect(active).toHaveLength(2)

    await applyProviderChange(db, businessId, actorId, { action: 'unassign_service', instructorName: 'Dana', serviceNames: ['פילאטיס'] }, 'en')
    active = await db.select().from(providerAssignments).where(and(eq(providerAssignments.identityId, prov.id), eq(providerAssignments.isActive, true)))
    expect(active).toHaveLength(1)
  })

  it('remove deactivates all assignments', async () => {
    await applyProviderChange(db, businessId, actorId, { action: 'remove', instructorName: 'Dana' }, 'en')
    const [prov] = await db.select().from(identities).where(and(eq(identities.businessId, businessId), eq(identities.role, 'provider')))
    const active = await db.select().from(providerAssignments).where(and(eq(providerAssignments.identityId, prov.id), eq(providerAssignments.isActive, true)))
    expect(active).toHaveLength(0)
  })

  it('returns not_found for an unknown instructor', async () => {
    const res = await applyProviderChange(db, businessId, actorId, { action: 'set_hours', instructorName: 'Nobody', weeklyHours: [] }, 'en')
    expect(res.ok).toBe(false)
  })
})
```

> Adjust the second-service seeding line to match the actual helper signature discovered in Task 4. The time-format assertion (`'10:00:00'`) depends on the driver; if the helper returns `'10:00'`, use that.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/domain/manager/apply.provider.test.ts`
Expected: FAIL — the four edit actions currently return `apply_unknown_type`.

- [ ] **Step 3: Implement the remaining branches**

Replace the `// Other actions implemented in Task 5.` block at the end of `applyProviderChange` with:

```ts
  // All non-add actions operate on an existing provider.
  const found = await findProviderByName(db, businessId, p.instructorName)
  if (found.status === 'ambiguous') return { ok: false, reason: i18n.apply_provider_ambiguous[lang](p.instructorName) }
  if (found.status === 'none') return { ok: false, reason: i18n.apply_provider_not_found[lang](p.instructorName) }
  const providerId = found.id

  if (p.action === 'set_hours') {
    await db.delete(availability).where(and(eq(availability.providerId, providerId), isNull(availability.specificDate)))
    for (const h of p.weeklyHours ?? []) {
      await db.insert(availability).values({
        businessId, providerId, dayOfWeek: h.dayOfWeek, openTime: h.startTime, closeTime: h.endTime, isBlocked: false,
      })
    }
    return { ok: true, confirmationMessage: i18n.apply_provider_hours_set[lang](p.instructorName, hoursFragment(p.weeklyHours ?? [], lang)) }
  }

  if (p.action === 'assign_service' || p.action === 'unassign_service') {
    const names = p.serviceNames ?? []
    if (names.length === 0) return { ok: false, reason: i18n.apply_provider_service_not_found[lang]('') }
    const setActive = p.action === 'assign_service'
    const done: string[] = []
    for (const name of names) {
      const svc = await findServiceByName(db, businessId, name)
      if (!svc) return { ok: false, reason: i18n.apply_provider_service_not_found[lang](name) }
      await db.insert(providerAssignments).values({
        businessId, identityId: providerId, serviceTypeId: svc.id, isActive: setActive,
      }).onConflictDoUpdate({
        target: [providerAssignments.identityId, providerAssignments.serviceTypeId],
        set: { isActive: setActive },
      })
      done.push(svc.name)
    }
    const msg = setActive
      ? i18n.apply_provider_assigned[lang](p.instructorName, done.join(', '))
      : i18n.apply_provider_unassigned[lang](p.instructorName, done.join(', '))
    return { ok: true, confirmationMessage: msg }
  }

  // remove
  await db.update(providerAssignments).set({ isActive: false }).where(eq(providerAssignments.identityId, providerId))
  return { ok: true, confirmationMessage: i18n.apply_provider_removed[lang](p.instructorName) }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/domain/manager/apply.provider.test.ts`
Expected: PASS (all add + edit tests).

- [ ] **Step 5: Type-check and commit**

Run: `npx tsc --noEmit` → clean.

```bash
git add src/domain/manager/apply.ts src/domain/manager/apply.provider.test.ts
git commit -m "feat(branch3): applyProviderChange set_hours/assign/unassign/remove

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Wire `provider_change` into the apply dispatch + classifier

**Files:**
- Modify: `src/domain/manager/apply.ts` (`applyInstruction` switch, ~line 147)
- Modify: `src/adapters/llm/client.ts` (`managerInstructionSchema` enum ~line 94 + prompt ~line 218)

- [ ] **Step 1: Add the dispatch case**

In `applyInstruction`'s switch in `apply.ts`, after the `recurring_class_change` case:

```ts
    case 'recurring_class_change':
      result = await applyRecurringClassChange(db, businessId, actorId, structuredParams, lang)
      break
    case 'provider_change':
      result = await applyProviderChange(db, businessId, actorId, structuredParams, lang)
      break
```

- [ ] **Step 2: Add `provider_change` to the classifier enum**

In `src/adapters/llm/client.ts`, `managerInstructionSchema.instructionType` enum (~line 94):

```ts
  instructionType: z.enum([
    'availability_change',
    'policy_change',
    'service_change',
    'permission_change',
    'booking_cancellation',
    'recurring_class_change',
    'provider_change',
    'unknown',
  ]),
```

- [ ] **Step 3: Add the classifier prompt section**

In the `classifyManagerInstruction` system prompt (after the `recurring_class_change:` block, ~line 226), add:

```
provider_change:
  { "action": "add"|"set_hours"|"assign_service"|"unassign_service"|"remove", "instructorName": string, "phone": "+E164"|null, "serviceNames": string[]|null, "weeklyHours": [ { "dayOfWeek": 0-6, "startTime": "HH:MM", "endTime": "HH:MM" } ]|null }
  Use for managing teaching staff / instructors / trainers (מדריך/ה, מורה).
  - action "add": owner introduces a new instructor, optionally with the services they teach and their weekly hours (e.g. "Add Dana as a yoga instructor, Mon/Wed 9–13", "תוסיף את דנה כמדריכת יוגה בימי שני ורביעי 9 עד 13"). Fill instructorName; serviceNames from the services named; weeklyHours from the days/times. phone only if a number is given (instructors are name-only by default).
  - action "set_hours": owner changes an existing instructor's weekly hours (e.g. "change Dana's hours to Tue/Thu 10–14"). Fill instructorName + weeklyHours.
  - action "assign_service" / "unassign_service": owner adds/removes which services an existing instructor teaches (e.g. "Dana also teaches pilates", "Dana no longer does breathing"). Fill instructorName + serviceNames.
  - action "remove": owner removes an instructor from the team (e.g. "remove Dana", "דנה כבר לא אצלנו"). Fill instructorName.
  - dayOfWeek: 0=Sunday … 6=Saturday. Times are 24-hour "HH:MM".
```

- [ ] **Step 4: Update the `manageBusinessSettings` routing note in the orchestrator prompt**

In `src/adapters/llm/orchestrator.ts`, the `manageBusinessSettings` bullet in the tool-usage rules (~line 365), append a sentence:

```
Also use it to add or manage instructors / teaching staff and their weekly hours (e.g. "add Dana as a yoga instructor Mon/Wed 9–13", "change Dana's hours", "remove Dana").
```

And in the `manageBusinessSettings` tool *description* (~line 182-195), append the same intent so the tool is selected for instructor instructions.

- [ ] **Step 5: Type-check and commit**

Run: `npx tsc --noEmit` → clean.
Run: `npm test` → all existing unit tests still pass.

```bash
git add src/domain/manager/apply.ts src/adapters/llm/client.ts src/adapters/llm/orchestrator.ts
git commit -m "feat(branch3): route provider_change through classifier + apply seam

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Instructor roster — read model + orchestrator injection

**Files:**
- Create: `src/domain/provider/roster.ts`
- Test: `src/domain/provider/roster.test.ts` (create)
- Modify: `src/adapters/llm/orchestrator.ts` (`buildSystemPrompt`, `OrchestratorParams`, `runManagerOrchestratorLoop`)
- Modify: `src/routes/webhook.ts` (load roster, pass into `runManagerOrchestratorLoop`)

- [ ] **Step 1: Write the failing test for `loadInstructorRoster`**

Create `src/domain/provider/roster.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { loadInstructorRoster, getInstructorHours } from './roster.js'
import { applyProviderChange } from '../manager/apply.js'
import { seedBusinessWithService } from '../manager/test-helpers.js' // adjust to actual helper

describe('loadInstructorRoster', () => {
  let db: any, businessId: string, actorId: string
  beforeEach(async () => {
    ;({ db, businessId, actorId } = await seedBusinessWithService({ serviceName: 'יוגה' }))
    await applyProviderChange(db, businessId, actorId, {
      action: 'add', instructorName: 'Dana', serviceNames: ['יוגה'],
      weeklyHours: [{ dayOfWeek: 1, startTime: '09:00', endTime: '13:00' }],
    }, 'en')
  })

  it('returns the roster with services and weekly hours', async () => {
    const roster = await loadInstructorRoster(db, businessId)
    expect(roster).toHaveLength(1)
    expect(roster[0].name).toBe('Dana')
    expect(roster[0].services).toContain('יוגה')
    expect(roster[0].weeklyHours).toEqual([{ dayOfWeek: 1, startTime: '09:00', endTime: '13:00' }])
  })

  it('getInstructorHours resolves an instructor assigned to a service by name hint', async () => {
    const [{ id: svcId }] = await db.select({ id: (await import('../../db/schema.js')).serviceTypes.id })
      .from((await import('../../db/schema.js')).serviceTypes)
    const res = await getInstructorHours(db, businessId, svcId, 'Dana')
    expect(res?.name).toBe('Dana')
    expect(res?.weeklyHours.length).toBe(1)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/domain/provider/roster.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `roster.ts`**

Create `src/domain/provider/roster.ts`:

```ts
import { and, eq, isNull, ilike } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { identities, providerAssignments, serviceTypes, availability } from '../../db/schema.js'

export interface InstructorWeeklyHours { dayOfWeek: number; startTime: string; endTime: string }
export interface InstructorRosterEntry { id: string; name: string; services: string[]; weeklyHours: InstructorWeeklyHours[] }

function normTime(t: string | null): string { return (t ?? '').slice(0, 5) } // 'HH:MM:SS' → 'HH:MM'

async function weeklyHoursFor(db: Db, providerId: string): Promise<InstructorWeeklyHours[]> {
  const rows = await db.select({
    dayOfWeek: availability.dayOfWeek, openTime: availability.openTime, closeTime: availability.closeTime,
  }).from(availability).where(and(
    eq(availability.providerId, providerId), isNull(availability.specificDate), eq(availability.isBlocked, false),
  ))
  return rows
    .filter((r) => r.dayOfWeek !== null && r.openTime && r.closeTime)
    .map((r) => ({ dayOfWeek: r.dayOfWeek as number, startTime: normTime(r.openTime), endTime: normTime(r.closeTime) }))
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek)
}

/** Full instructor roster for a business (active providers + their active services + weekly hours). */
export async function loadInstructorRoster(db: Db, businessId: string): Promise<InstructorRosterEntry[]> {
  const provs = await db.select({ id: identities.id, name: identities.displayName }).from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.role, 'provider'), isNull(identities.revokedAt)))

  const out: InstructorRosterEntry[] = []
  for (const prov of provs) {
    const svc = await db.select({ name: serviceTypes.name }).from(providerAssignments)
      .innerJoin(serviceTypes, eq(providerAssignments.serviceTypeId, serviceTypes.id))
      .where(and(eq(providerAssignments.identityId, prov.id), eq(providerAssignments.isActive, true)))
    out.push({
      id: prov.id, name: prov.name ?? '',
      services: svc.map((s) => s.name),
      weeklyHours: await weeklyHoursFor(db, prov.id),
    })
  }
  return out
}

/** For the customer-side reactive fallback: an instructor assigned to a service, matched by name hint. */
export async function getInstructorHours(
  db: Db, businessId: string, serviceTypeId: string, nameHint: string,
): Promise<{ name: string; weeklyHours: InstructorWeeklyHours[] } | null> {
  const [row] = await db.select({ id: identities.id, name: identities.displayName }).from(providerAssignments)
    .innerJoin(identities, eq(providerAssignments.identityId, identities.id))
    .where(and(
      eq(providerAssignments.businessId, businessId),
      eq(providerAssignments.serviceTypeId, serviceTypeId),
      eq(providerAssignments.isActive, true),
      isNull(identities.revokedAt),
      ilike(identities.displayName, `%${nameHint}%`),
    )).limit(1)
  if (!row) return null
  return { name: row.name ?? nameHint, weeklyHours: await weeklyHoursFor(db, row.id) }
}

/** Render the roster for the manager orchestrator system prompt. Empty roster → ''. */
export function buildInstructorRosterBlock(roster: InstructorRosterEntry[], lang: 'he' | 'en'): string {
  if (roster.length === 0) return ''
  const days = lang === 'he'
    ? ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש']
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const lines = ['Instructors (for your reference — do not volunteer to customers):']
  for (const e of roster) {
    const svc = e.services.join(', ') || '—'
    const hrs = e.weeklyHours.length
      ? e.weeklyHours.map((h) => `${days[h.dayOfWeek]} ${h.startTime}–${h.endTime}`).join(', ')
      : 'no hours set'
    lines.push(`- ${e.name}: ${svc} (${hrs})`)
  }
  return lines.join('\n')
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/domain/provider/roster.test.ts`
Expected: PASS.

- [ ] **Step 5: Inject the roster into the orchestrator prompt**

In `src/adapters/llm/orchestrator.ts`:

Import the roster helpers at the top:

```ts
import { buildInstructorRosterBlock, type InstructorRosterEntry } from '../../domain/provider/roster.js'
```

Add `instructorRoster` to the `buildSystemPrompt` params type and destructure it:

```ts
function buildSystemPrompt(params: {
  businessName: string
  timezone: string
  lang: Lang
  businessKnowledge: BusinessKnowledge | null
  instructorRoster: InstructorRosterEntry[]
  managerMemorySummaries: string[]
  conversationHistory: TranscriptTurn[]
}): string {
  const { businessName, timezone, lang, businessKnowledge, instructorRoster, managerMemorySummaries, conversationHistory } = params
```

After `const knowledgeBlock = buildBusinessKnowledgeBlock(businessKnowledge)`, add:

```ts
  const rosterBlock = buildInstructorRosterBlock(instructorRoster, lang)
```

In the returned template, insert the roster block right after where `knowledgeBlock` is interpolated (find the line that injects business knowledge and add `rosterBlock` on its own block, e.g.):

```ts
${knowledgeBlock}
${rosterBlock}
```

Add `instructorRoster` to `OrchestratorParams` (~line 431):

```ts
  businessKnowledge: BusinessKnowledge | null
  instructorRoster: InstructorRosterEntry[]
```

Destructure and pass it in `runManagerOrchestratorLoop` (~line 459 and the `buildSystemPrompt({...})` call ~line 467):

```ts
    businessName, timezone, lang, calendar, transcript, businessKnowledge, instructorRoster,
```
```ts
  const systemPrompt = buildSystemPrompt({
    businessName,
    timezone,
    lang,
    businessKnowledge,
    instructorRoster,
    managerMemorySummaries,
    conversationHistory: transcript,
  })
```

- [ ] **Step 6: Load + pass the roster from the webhook**

In `src/routes/webhook.ts`, find where `loadBusinessKnowledge` is called for the orchestrator (~line 720) and load the roster alongside it:

```ts
import { loadInstructorRoster } from '../domain/provider/roster.js'
```
```ts
  const [mgBusinessKnowledgeForOrchestrator, mgInstructorRoster] = await Promise.all([
    loadBusinessKnowledge(db, business.id, business.currency),
    loadInstructorRoster(db, business.id),
  ])
```

Then in the `runManagerOrchestratorLoop({ ... })` call (~line 750), add:

```ts
      businessKnowledge: mgBusinessKnowledgeForOrchestrator,
      instructorRoster: mgInstructorRoster,
```

- [ ] **Step 7: Type-check, test, commit**

Run: `npx tsc --noEmit` → clean.
Run: `npm test` → green.

```bash
git add src/domain/provider/roster.ts src/domain/provider/roster.test.ts src/adapters/llm/orchestrator.ts src/routes/webhook.ts
git commit -m "feat(branch3): instructor roster read model + orchestrator prompt injection

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Customer-facing reactive fallback + stance alignment

**Files:**
- Modify: `src/domain/booking/engine.ts` (provider-unavailable guard, ~line 105-110)
- Modify: `src/domain/flows/customer-booking.ts` (parse sentinel into a reactive situation ~line 983-1004; replace the `:524` stance line)
- Test: `src/domain/booking/engine.provider.test.ts` (create) — or extend an existing engine test

- [ ] **Step 1: Write the failing engine test**

Create `src/domain/booking/engine.provider.test.ts` (mirror the harness of the nearest existing engine test for DB + `requestBooking` setup):

```ts
import { describe, it, expect, beforeEach } from 'vitest'
// reuse the existing engine-test harness for db/business/service/calendar:
import { setupBookingEnv } from './test-helpers.js' // adjust to actual helper
import { requestBooking } from './engine.js'
import { applyProviderChange } from '../manager/apply.js'

describe('named-instructor unavailable → reactive failure (not silent provider-less booking)', () => {
  let env: Awaited<ReturnType<typeof setupBookingEnv>>
  beforeEach(async () => {
    env = await setupBookingEnv({ serviceName: 'יוגה', businessHours: 'wide' })
    // Dana teaches yoga only Mon 09:00–13:00
    await applyProviderChange(env.db, env.businessId, env.actorId, {
      action: 'add', instructorName: 'Dana', serviceNames: ['יוגה'],
      weeklyHours: [{ dayOfWeek: 1, startTime: '09:00', endTime: '13:00' }],
    }, 'en')
  })

  it('fails with a provider_unavailable reason when the named instructor is not free', async () => {
    // Pick a slot on a day Dana does NOT teach (e.g. a Wednesday) within studio hours:
    const res = await requestBooking(env.db, env.calendar, env.customer, {
      serviceTypeId: env.serviceId,
      slotStart: env.wednesdayAt('10:00'),
      slotEnd: env.wednesdayAt('11:00'),
      providerHint: 'Dana',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toMatch(/^provider_unavailable\|/)
  })

  it('ignores the hint and books normally when no instructor by that name teaches the service', async () => {
    const res = await requestBooking(env.db, env.calendar, env.customer, {
      serviceTypeId: env.serviceId,
      slotStart: env.wednesdayAt('10:00'),
      slotEnd: env.wednesdayAt('11:00'),
      providerHint: 'Nobody',
    })
    expect(res.ok).toBe(true) // provider-less booking, current behavior preserved
  })
})
```

> Adjust helper/fixture names to the actual engine test harness. The key behaviors asserted: (a) a hinted-but-unavailable assigned instructor → `provider_unavailable|...` reason; (b) a hint that matches no assigned instructor → normal provider-less booking still succeeds.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/domain/booking/engine.provider.test.ts`
Expected: FAIL — currently the first case books provider-less and returns `ok: true`.

- [ ] **Step 3: Add the engine guard**

In `src/domain/booking/engine.ts`, import the helper:

```ts
import { getInstructorHours } from '../provider/roster.js'
```

Right after the provider resolution block (after `const providerDisplayName = resolvedProvider?.displayName ?? null`, ~line 112), add:

```ts
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
```

> `actor.businessId` is already used a few lines above in the `resolveProvider` call, so it is in scope.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/domain/booking/engine.provider.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Parse the sentinel into a reactive situation (customer-booking)**

In `src/domain/flows/customer-booking.ts`, at the booking-failure path (~line 983-1004 where `unavailSituation` is built from `sanitiseReason(result.reason)`), add a branch BEFORE the generic phrasing. First add a small helper near the top-level helpers of the file:

```ts
const HE_DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']
const EN_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Parse engine 'provider_unavailable|Name|1:09:00-13:00;3:09:00-13:00' into a readable hours phrase. */
function parseProviderUnavailable(reason: string, lang: 'he' | 'en'): { name: string; hoursPhrase: string } | null {
  if (!reason.startsWith('provider_unavailable|')) return null
  const [, name, hoursRaw] = reason.split('|')
  const days = lang === 'he' ? HE_DAYS : EN_DAYS
  const parts = (hoursRaw ?? '').split(';').filter(Boolean).map((seg) => {
    const [dow, range] = seg.split(':')
    const d = days[Number(dow)] ?? ''
    return `${d} ${range ?? ''}`.trim()
  })
  return { name: name ?? '', hoursPhrase: parts.join(', ') }
}
```

Then where the unavailable situation is built (~line 994), branch:

```ts
    const providerUnavail = parseProviderUnavailable(result.reason, detectedLanguage)
    const unavailSituation = providerUnavail
      ? `${firstMsgPrefix}The customer asked to book with ${providerUnavail.name}, but ${providerUnavail.name} does not teach at the time they chose. ${providerUnavail.name}'s teaching times are: ${providerUnavail.hoursPhrase}. Reactively offer one of those times OR another instructor — do not invent times, and do not volunteer other staff names unprompted. Keep it warm and brief.`
      : [
          `The requested slot is unavailable because ${sanitiseReason(result.reason)}.`,
          /* ...keep the existing trailing lines of the array exactly as they are... */
        ].join(' ')
```

> Read the existing `unavailSituation` assignment first and preserve its current non-provider content verbatim inside the `: [ ... ]` else-branch. Only the provider branch is new. `detectedLanguage` is already in scope in this function; if the local variable is named differently (e.g. `lang`), use that.

- [ ] **Step 6: Replace the `:524` stance line**

In the inquiry `situation` string (~line 524), replace:

```
We do not track individual staff members' personal schedules; if asked about a specific instructor's hours, answer with the studio's hours/openings and say bookings go through here.
```

with:

```
If the customer asks to book with a specific instructor by name, that is supported — bookings go through here. Do NOT proactively bring up, list, or advertise individual instructors or who teaches what; only engage with instructor specifics if the customer raises them first.
```

- [ ] **Step 7: Type-check, test, commit**

Run: `npx tsc --noEmit` → clean.
Run: `npm test` → green.

```bash
git add src/domain/booking/engine.ts src/domain/booking/engine.provider.test.ts src/domain/flows/customer-booking.ts
git commit -m "feat(branch4): reactive named-instructor fallback + align customer stance

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Integration tests — C-D / C-F end-to-end

**Files:**
- Modify/Create: `tests/integration/branch34-bulletproof.test.ts` (the catalog file referenced in the handoff) — add an instructor-management describe block. If the file does not exist, create `tests/integration/instructor-management.test.ts` using the existing integration harness (`tests/integration/setup.ts` `seedBusiness` / `sim()` — read it first).

- [ ] **Step 1: Write the integration test**

Add (reusing the integration harness — read `tests/integration/setup.ts` for the exact seed/sim API and match it):

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { applyProviderChange } from '../../src/domain/manager/apply.js'
import { requestBooking } from '../../src/domain/booking/engine.js'
// import the integration seed/env helpers actually exported by tests/integration/setup.ts

describe('C-D/C-F: multi-instructor management end-to-end', () => {
  // beforeEach: seed a business with services יוגה + פילאטיס, a manager, a customer, wide studio hours.

  it('C-D: add two instructors; "book yoga with Dana" resolves Dana; her hours are enforced', async () => {
    await applyProviderChange(db, businessId, managerId, { action: 'add', instructorName: 'Dana', serviceNames: ['יוגה'], weeklyHours: [{ dayOfWeek: 1, startTime: '09:00', endTime: '13:00' }] }, 'he')
    await applyProviderChange(db, businessId, managerId, { action: 'add', instructorName: 'Noa', serviceNames: ['יוגה'], weeklyHours: [{ dayOfWeek: 3, startTime: '16:00', endTime: '20:00' }] }, 'he')

    // Monday 10:00 with Dana → resolves to Dana
    const ok = await requestBooking(db, calendar, customer, { serviceTypeId: yogaId, slotStart: mondayAt('10:00'), slotEnd: mondayAt('11:00'), providerHint: 'Dana' })
    expect(ok.ok).toBe(true)
    // assert the persisted booking has Dana's providerId
    // (query bookings where providerId = Dana's identity id)

    // Wednesday 10:00 with Dana → fails (Dana only teaches Monday)
    const bad = await requestBooking(db, calendar, customer, { serviceTypeId: yogaId, slotStart: wednesdayAt('10:00'), slotEnd: wednesdayAt('11:00'), providerHint: 'Dana' })
    expect(bad.ok).toBe(false)
  })

  it('C-D: one instructor cannot be double-booked across two services at the same slot', async () => {
    await applyProviderChange(db, businessId, managerId, { action: 'add', instructorName: 'Dana', serviceNames: ['יוגה', 'פילאטיס'], weeklyHours: [{ dayOfWeek: 1, startTime: '09:00', endTime: '13:00' }] }, 'he')
    const a = await requestBooking(db, calendar, customer, { serviceTypeId: yogaId, slotStart: mondayAt('10:00'), slotEnd: mondayAt('11:00'), providerHint: 'Dana' })
    expect(a.ok).toBe(true)
    // (confirm the hold/booking so it occupies the slot, per the harness's confirm step)
    const b = await requestBooking(db, calendar, customer2, { serviceTypeId: pilatesId, slotStart: mondayAt('10:00'), slotEnd: mondayAt('11:00'), providerHint: 'Dana' })
    expect(b.ok).toBe(false) // Dana already booked at that slot
  })

  it('C-F: remove makes the instructor un-resolvable', async () => {
    await applyProviderChange(db, businessId, managerId, { action: 'add', instructorName: 'Dana', serviceNames: ['יוגה'], weeklyHours: [{ dayOfWeek: 1, startTime: '09:00', endTime: '13:00' }] }, 'he')
    await applyProviderChange(db, businessId, managerId, { action: 'remove', instructorName: 'Dana' }, 'he')
    const res = await requestBooking(db, calendar, customer, { serviceTypeId: yogaId, slotStart: mondayAt('10:00'), slotEnd: mondayAt('11:00'), providerHint: 'Dana' })
    // Dana no longer teaches yoga → hint ignored → provider-less booking succeeds
    expect(res.ok).toBe(true)
  })
})
```

> The double-booking case depends on the engine's transactional conflict check including the provider's existing booking (`isProviderAvailable` checks `bookings.providerId`). Confirm/hold the first booking per the harness so it actually occupies the slot before the second attempt.

- [ ] **Step 2: Run the integration suite**

Run: `npm run test:integration` (needs `DATABASE_URL` + `REDIS_URL` — use the migrated prod-shaped test DB or local docker per `DEV_OPERATING_MODEL.md`).
Expected: the new C-D/C-F tests PASS; existing integration tests stay green.

- [ ] **Step 3: Commit**

```bash
git add tests/integration/
git commit -m "test(branch3): C-D/C-F integration — multi-instructor resolution, double-booking, remove

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: Quality scenarios (LLM-judge, gated by API key)

**Files:**
- Modify: `tests/quality/scenarios.test.ts` (or `tests/quality/scenarios.ts` — read the file to match how scenarios are registered)

- [ ] **Step 1: Add catalog-aligned quality scenarios**

Add three scenarios (match the existing scenario object shape exactly — read one first):

1. **Add-instructor confirmation (manager / Branch 3):** input "תוסיף את דנה כמדריכת יוגה, שני ורביעי 9 עד 1" → expect a warm, first-person confirmation that does NOT echo raw tool fields; single language; lawbook-compliant.
2. **Reactive instructor fallback (customer / Branch 4):** context = Dana teaches Mon only; customer asks to book yoga with Dana on a Wednesday → reply offers Dana's actual days or another instructor, warm, no invented times, does not dump the full roster.
3. **No unsolicited instructor info (customer / Branch 4):** customer asks a generic "what times are open Tuesday?" → reply must NOT volunteer instructor names/schedules (assert absence).

- [ ] **Step 2: Run the smoke gate**

Run: `npm run test:quality:smoke`
Expected: new scenarios pass det checks + score ≥ 4, zero hard bot-tells. (Full 3-sample `npm run test:quality` is an opt-in deep check — run only with adequate Pro quota.)

- [ ] **Step 3: Commit**

```bash
git add tests/quality/
git commit -m "test(quality): instructor confirmation + reactive fallback + no-unsolicited-info scenarios

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `npx tsc --noEmit` — clean.
- [ ] `npm test` — all unit tests green (new: authorization, applyProviderChange add+edits, roster, engine provider guard).
- [ ] `npm run test:integration` — C-D/C-F green; existing green.
- [ ] `npm run test:quality:smoke` — new scenarios green, zero bot-tells.
- [ ] Re-read `git diff main...HEAD --stat` — confirm NO changes under `src/skills/`, `src/domain/availability/compute.ts`, or `src/domain/provider/resolver.ts`.
- [ ] Confirm no migration files were added (no `src/db/migrations/0019*`).

Then this branch is ready for the deploy runbook (`/update-agent`) and the Part B manual re-test of instructor flows on סטודיוגה.

---

## Self-review notes (author)

- **Spec §2 (data model):** Task 1 (role) + Task 4 (synthetic phone, name-only, assignments, availability) cover it. No migration confirmed via Task 1 Step 1.
- **Spec §3 (write path):** Tasks 4–6 (schema, all five actions, dispatch, classifier).
- **Spec §3.3 (authorization):** Task 2 (`staff.manage`).
- **Spec §4 (read-back / context injection):** Task 7 (`roster.ts` + orchestrator + webhook).
- **Spec §5 (reactive customer stance):** Task 8 (engine guard + sentinel phrasing + `:524` replacement).
- **Spec §6 (testing):** Tasks 2,4,5,7,8 (unit), 9 (integration C-D/C-F), 10 (quality).
- **Spec §7 (known limitation — provider with real phone routes as customer):** intentionally NOT solved; no task. Acceptable per spec.
- **Type consistency:** `applyProviderChange(db, businessId, actorId, params, lang)` signature is identical across Tasks 4/5/6/7/9. `getInstructorHours(db, businessId, serviceTypeId, nameHint)` identical in Tasks 7 and 8. `provider_unavailable|name|hours` sentinel format produced in Task 8 Step 3 and parsed in Task 8 Step 5 — formats match (`dow:HH:MM-HH:MM` joined by `;`).
- **Open dependency the executor must resolve:** the exact DB/seed test-harness helper names (`seedBusinessWithService`, `setupBookingEnv`, integration `setup.ts` API) are placeholders — the executor MUST read the nearest existing test in each directory and reuse the real harness rather than inventing one.
