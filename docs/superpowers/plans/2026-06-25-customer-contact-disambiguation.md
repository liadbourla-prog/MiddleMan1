# Customer Contact Resolution & Disambiguation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "the PA never acts on the wrong customer/contact, and verifies with the owner when a name is ambiguous" a structural guarantee for every owner-initiated Branch-3 action, backed by a structured `lastName` for disambiguation.

**Architecture:** One deterministic resolver (`src/domain/identity/customer-resolver.ts`) classifies a name/phone into `resolved | ambiguous | not_found | phone_unknown`, returning last name + full phone + last booking per candidate. Every owner→target tool (`messageCustomer`, `requestPayment`, `coordinateMeeting`) routes through it instead of resolving names inline. A new nullable `identities.lastName` column gives disambiguation real data, populated four ways: migration backfill, opportunistic save at disambiguation, an owner `setCustomerName` tool, and booking-flow capture.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Drizzle ORM (PostgreSQL), Fastify, Vitest, Gemini native function-calling orchestrator.

**Reference spec:** `docs/superpowers/specs/2026-06-25-customer-contact-disambiguation-design.md`

**Conventions to follow:**
- All intra-repo imports use `.js` specifiers even for `.ts` files.
- Tests use mocked DB chains (no live Postgres). See `tests/routes/coordination-interception.test.ts` for the `vi.mock` chain pattern and `src/domain/manager/orchestrator-tools.test.ts` for the no-write-trap `ToolContext` pattern.
- Run a single test file with: `npx vitest run <path>`. Run everything with: `npm test`. Typecheck with: `npm run build`. Lint (skills only, unaffected here) with: `npm run lint`.
- Commit after every green task.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/db/schema.ts` | Drizzle schema | add `lastName` to `identities` |
| `src/db/migrations/0043_identity_last_name.sql` | DB migration | generated `ALTER` + hand-written backfill `UPDATE` |
| `src/domain/identity/customer-resolver.ts` | **NEW** — deterministic name/phone → target resolver, `deriveLastName`, `latestBookingFor`, `setCustomerName` | create |
| `src/domain/identity/customer-resolver.test.ts` | **NEW** — resolver unit tests | create |
| `src/domain/manager/orchestrator-tools.ts` | `messageCustomer`, `requestPayment` route through resolver; `lookupCustomer` returns `lastName`; new `executeSetCustomerName` | modify |
| `src/domain/manager/coordination-tools.ts` | `coordinateMeeting` routes through resolver (drop `.limit(1)`) | modify |
| `src/adapters/llm/orchestrator.ts` | tool declarations (`lastName` args, new `setCustomerName`), dispatch case, imports | modify |
| `src/adapters/llm/client.ts` | add `customerNameHint` to `extractCustomerIntent` output | modify |
| `src/domain/flows/customer-booking.ts` | persist captured name when stored `displayName` is null | modify |
| `src/domain/manager/orchestrator-tools.test.ts` | tool-level tests for resolver wiring | modify |

---

## Task 1: Add `lastName` column + backfill migration

**Files:**
- Modify: `src/db/schema.ts` (identities table, ~line 145)
- Create: `src/db/migrations/0043_identity_last_name.sql` (generated, then edited)

- [ ] **Step 1: Add the column to the schema**

In `src/db/schema.ts`, inside the `identities` `pgTable` definition, add `lastName` immediately after the `displayName` line (currently `displayName: text('display_name'),`):

```ts
    displayName: text('display_name'),
    // Structured family name for disambiguation + verification when the owner targets a
    // customer/contact by name (e.g. two customers both named "Guy"). Nullable; displayName
    // remains the name as captured. Populated via migration backfill, booking capture, the
    // owner setCustomerName tool, and opportunistic save at disambiguation time.
    lastName: text('last_name'),
```

- [ ] **Step 2: Generate the migration**

Run: `npm run db:generate`
Expected: a new file `src/db/migrations/0043_identity_last_name.sql` containing roughly:
```sql
ALTER TABLE "identities" ADD COLUMN "last_name" text;
```
(The exact statement-breakpoint formatting is fine as generated.)

- [ ] **Step 3: Append the non-destructive backfill**

Edit the generated `src/db/migrations/0043_identity_last_name.sql`, appending the backfill below the `ALTER`. It sets `last_name` to the last whitespace-delimited token of `display_name`, only for customer/contact rows whose trimmed name actually contains whitespace (single-token names stay null). It never touches `display_name`:

```sql
--> statement-breakpoint
UPDATE "identities"
SET "last_name" = regexp_replace(trim("display_name"), '^.*\s', '')
WHERE "last_name" IS NULL
  AND "role" IN ('customer', 'contact')
  AND "display_name" IS NOT NULL
  AND trim("display_name") ~ '\s';
```

- [ ] **Step 4: Verify the project still typechecks**

Run: `npm run build`
Expected: PASS (no type errors). The new column is now part of the inferred `identities` type.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/migrations/0043_identity_last_name.sql src/db/migrations/meta
git commit -m "feat(identity): add nullable lastName column + non-destructive backfill"
```

---

## Task 2: Create the resolver core (`deriveLastName`)

Build the new module bottom-up, pure functions first. This task delivers `deriveLastName` only.

**Files:**
- Create: `src/domain/identity/customer-resolver.ts`
- Create: `src/domain/identity/customer-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/domain/identity/customer-resolver.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { deriveLastName } from './customer-resolver.js'

describe('deriveLastName', () => {
  it('returns the last token of a multi-word name', () => {
    expect(deriveLastName('Guy Cohen')).toBe('Cohen')
    expect(deriveLastName('  Guy   Cohen  ')).toBe('Cohen')
    expect(deriveLastName('Mary Jane Watson')).toBe('Watson')
  })
  it('returns null for single-token, empty, or nullish names', () => {
    expect(deriveLastName('Guy')).toBeNull()
    expect(deriveLastName('')).toBeNull()
    expect(deriveLastName('   ')).toBeNull()
    expect(deriveLastName(null)).toBeNull()
    expect(deriveLastName(undefined)).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/domain/identity/customer-resolver.test.ts`
Expected: FAIL — cannot find module `./customer-resolver.js` / `deriveLastName` is not defined.

- [ ] **Step 3: Create the module with `deriveLastName`**

Create `src/domain/identity/customer-resolver.ts`:

```ts
import { and, eq, ilike, desc } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { identities, bookings, serviceTypes } from '../../db/schema.js'
import { isValidE164 } from './resolver.js'

export type TargetRole = 'customer' | 'contact'

export interface CandidateView {
  id: string
  displayName: string | null
  lastName: string | null
  phoneNumber: string
  lastBooking: { date: string; service: string | null } | null
}

export interface ResolveInput {
  role: TargetRole
  name?: string
  lastName?: string
  phoneNumber?: string
  timezone: string
  lang: 'he' | 'en'
}

export type CustomerResolution =
  | { status: 'resolved'; target: CandidateView }
  | { status: 'ambiguous'; query: string; candidates: CandidateView[] }
  | { status: 'not_found'; query: string }
  | { status: 'phone_unknown'; phoneNumber: string }

/** Last whitespace-delimited token of a name, or null for single-token/empty/nullish. */
export function deriveLastName(name: string | null | undefined): string | null {
  if (!name) return null
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return parts.length >= 2 ? parts[parts.length - 1]! : null
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/domain/identity/customer-resolver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/identity/customer-resolver.ts src/domain/identity/customer-resolver.test.ts
git commit -m "feat(identity): customer-resolver scaffold + deriveLastName"
```

---

## Task 3: `latestBookingFor` helper

**Files:**
- Modify: `src/domain/identity/customer-resolver.ts`
- Modify: `src/domain/identity/customer-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/domain/identity/customer-resolver.test.ts`. The `fakeDb` helper resolves queued result-sets in call order — reuse it across later tasks:

```ts
import { latestBookingFor } from './customer-resolver.js'
import type { Db } from '../../db/client.js'

// Each terminal `.limit()` resolves the next queued result-set, in call order.
function fakeDb(results: unknown[][]): Db {
  let i = 0
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'from', 'where', 'leftJoin', 'innerJoin', 'orderBy']) {
    chain[m] = () => chain
  }
  chain['limit'] = () => Promise.resolve(results[i++] ?? [])
  return { select: () => chain } as unknown as Db
}

describe('latestBookingFor', () => {
  it('formats the most recent booking date + service', async () => {
    const db = fakeDb([[{ slotStart: new Date('2026-03-03T12:00:00Z'), service: 'Haircut' }]])
    const r = await latestBookingFor(db, 'biz1', 'id1', 'Asia/Jerusalem', 'en')
    expect(r).toEqual({ date: expect.stringContaining('2026'), service: 'Haircut' })
  })
  it('returns null when the target has no bookings', async () => {
    const db = fakeDb([[]])
    const r = await latestBookingFor(db, 'biz1', 'id1', 'Asia/Jerusalem', 'en')
    expect(r).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/domain/identity/customer-resolver.test.ts`
Expected: FAIL — `latestBookingFor` is not exported.

- [ ] **Step 3: Implement `latestBookingFor`**

Append to `src/domain/identity/customer-resolver.ts`:

```ts
/** Most recent booking (date + service name) for an identity, or null if none. */
export async function latestBookingFor(
  db: Db,
  businessId: string,
  identityId: string,
  timezone: string,
  lang: 'he' | 'en',
): Promise<{ date: string; service: string | null } | null> {
  const [b] = await db
    .select({ slotStart: bookings.slotStart, service: serviceTypes.name })
    .from(bookings)
    .leftJoin(serviceTypes, eq(bookings.serviceTypeId, serviceTypes.id))
    .where(and(eq(bookings.businessId, businessId), eq(bookings.customerId, identityId)))
    .orderBy(desc(bookings.slotStart))
    .limit(1)
  if (!b) return null
  return {
    date: b.slotStart.toLocaleDateString(lang === 'he' ? 'he-IL' : 'en-GB', { timeZone: timezone }),
    service: b.service ?? null,
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/domain/identity/customer-resolver.test.ts`
Expected: PASS (all three describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/domain/identity/customer-resolver.ts src/domain/identity/customer-resolver.test.ts
git commit -m "feat(identity): latestBookingFor helper for candidate verification"
```

---

## Task 4: `resolveTargetForOwnerAction` — the deterministic gate

**Files:**
- Modify: `src/domain/identity/customer-resolver.ts`
- Modify: `src/domain/identity/customer-resolver.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/domain/identity/customer-resolver.test.ts`. Query order for the name path: first the identity-match query, then one `latestBookingFor` query per candidate — queue results accordingly:

```ts
import { resolveTargetForOwnerAction } from './customer-resolver.js'

const TZ = 'Asia/Jerusalem'
const row = (id: string, displayName: string, lastName: string | null, phone: string) =>
  ({ id, displayName, lastName, phoneNumber: phone })

describe('resolveTargetForOwnerAction', () => {
  it('phone given + found → resolved (no ambiguity ever for a phone)', async () => {
    const db = fakeDb([
      [row('c1', 'Guy', null, '+972500000001')],   // identity lookup by phone
      [],                                            // latestBookingFor → no bookings
    ])
    const r = await resolveTargetForOwnerAction(db, 'biz1', {
      role: 'customer', phoneNumber: '+972500000001', timezone: TZ, lang: 'en',
    })
    expect(r.status).toBe('resolved')
  })

  it('phone given + not on file → phone_unknown', async () => {
    const db = fakeDb([[]])
    const r = await resolveTargetForOwnerAction(db, 'biz1', {
      role: 'customer', phoneNumber: '+972500000009', timezone: TZ, lang: 'en',
    })
    expect(r).toEqual({ status: 'phone_unknown', phoneNumber: '+972500000009' })
  })

  it('name with one match → resolved', async () => {
    const db = fakeDb([
      [row('c1', 'Guy Cohen', 'Cohen', '+972500000001')],
      [{ slotStart: new Date('2026-03-03T12:00:00Z'), service: 'Haircut' }],
    ])
    const r = await resolveTargetForOwnerAction(db, 'biz1', {
      role: 'customer', name: 'Guy', timezone: TZ, lang: 'en',
    })
    expect(r.status).toBe('resolved')
    if (r.status === 'resolved') {
      expect(r.target.lastName).toBe('Cohen')
      expect(r.target.lastBooking?.service).toBe('Haircut')
    }
  })

  it('name with two matches → ambiguous with full candidate views', async () => {
    const db = fakeDb([
      [row('c1', 'Guy Cohen', 'Cohen', '+972500000001'), row('c2', 'Guy Levi', 'Levi', '+972500000002')],
      [{ slotStart: new Date('2026-03-03T12:00:00Z'), service: 'Haircut' }], // booking for c1
      [],                                                                     // booking for c2
    ])
    const r = await resolveTargetForOwnerAction(db, 'biz1', {
      role: 'customer', name: 'Guy', timezone: TZ, lang: 'en',
    })
    expect(r.status).toBe('ambiguous')
    if (r.status === 'ambiguous') {
      expect(r.candidates).toHaveLength(2)
      expect(r.candidates[0]).toMatchObject({ lastName: 'Cohen', phoneNumber: '+972500000001' })
      expect(r.candidates[1]).toMatchObject({ lastName: 'Levi', lastBooking: null })
    }
  })

  it('name with zero matches → not_found', async () => {
    const db = fakeDb([[]])
    const r = await resolveTargetForOwnerAction(db, 'biz1', {
      role: 'customer', name: 'Nobody', timezone: TZ, lang: 'en',
    })
    expect(r).toEqual({ status: 'not_found', query: 'Nobody' })
  })

  it('contact role never queries bookings (lastBooking always null)', async () => {
    const db = fakeDb([
      [row('k1', 'Guy Supplier', 'Supplier', '+972500000003')],
    ])
    const r = await resolveTargetForOwnerAction(db, 'biz1', {
      role: 'contact', name: 'Guy', timezone: TZ, lang: 'en',
    })
    expect(r.status).toBe('resolved')
    if (r.status === 'resolved') expect(r.target.lastBooking).toBeNull()
  })

  it('lastName narrows two matches down to one (re-entry after owner clarifies)', async () => {
    const db = fakeDb([
      [row('c1', 'Guy Cohen', 'Cohen', '+972500000001')], // DB already filtered by lastName
      [],
    ])
    const r = await resolveTargetForOwnerAction(db, 'biz1', {
      role: 'customer', name: 'Guy', lastName: 'Cohen', timezone: TZ, lang: 'en',
    })
    expect(r.status).toBe('resolved')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/domain/identity/customer-resolver.test.ts`
Expected: FAIL — `resolveTargetForOwnerAction` is not exported.

- [ ] **Step 3: Implement the resolver**

Append to `src/domain/identity/customer-resolver.ts`:

```ts
/**
 * The single deterministic gate every owner-initiated action that targets a customer/contact
 * MUST pass through before acting. Classifies a name/phone into resolved | ambiguous |
 * not_found | phone_unknown. Performs NO writes, NO sends, NO authorization (callers are
 * already gated). On a name collision it returns every candidate with the data the owner needs
 * to verify: last name, full phone number, and (for customers) their most recent booking.
 */
export async function resolveTargetForOwnerAction(
  db: Db,
  businessId: string,
  input: ResolveInput,
): Promise<CustomerResolution> {
  const phone = input.phoneNumber?.replace(/[\s-]/g, '')

  // Phone path — unambiguous by construction (phone is unique per business).
  if (phone && isValidE164(phone)) {
    const [hit] = await db
      .select({ id: identities.id, displayName: identities.displayName, lastName: identities.lastName, phoneNumber: identities.phoneNumber })
      .from(identities)
      .where(and(eq(identities.businessId, businessId), eq(identities.phoneNumber, phone)))
      .limit(1)
    if (!hit) return { status: 'phone_unknown', phoneNumber: phone }
    return { status: 'resolved', target: await toCandidate(db, businessId, hit, input) }
  }

  // Name path.
  if (input.name && input.name.trim()) {
    const name = input.name.trim()
    const conds = [
      eq(identities.businessId, businessId),
      eq(identities.role, input.role),
      ilike(identities.displayName, `%${name}%`),
    ]
    if (input.lastName && input.lastName.trim()) {
      conds.push(ilike(identities.lastName, `%${input.lastName.trim()}%`))
    }
    const rows = await db
      .select({ id: identities.id, displayName: identities.displayName, lastName: identities.lastName, phoneNumber: identities.phoneNumber })
      .from(identities)
      .where(and(...conds))
      .limit(5)

    if (rows.length === 0) return { status: 'not_found', query: name }
    if (rows.length === 1) {
      return { status: 'resolved', target: await toCandidate(db, businessId, rows[0]!, input) }
    }
    const candidates: CandidateView[] = []
    for (const row of rows) candidates.push(await toCandidate(db, businessId, row, input))
    return { status: 'ambiguous', query: name, candidates }
  }

  // Neither phone nor name — caller must ask who to target.
  return { status: 'not_found', query: input.name ?? '' }
}

async function toCandidate(
  db: Db,
  businessId: string,
  row: { id: string; displayName: string | null; lastName: string | null; phoneNumber: string },
  input: ResolveInput,
): Promise<CandidateView> {
  const lastBooking = input.role === 'customer'
    ? await latestBookingFor(db, businessId, row.id, input.timezone, input.lang)
    : null
  return { id: row.id, displayName: row.displayName, lastName: row.lastName, phoneNumber: row.phoneNumber, lastBooking }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/domain/identity/customer-resolver.test.ts`
Expected: PASS (all resolver cases).

- [ ] **Step 5: Commit**

```bash
git add src/domain/identity/customer-resolver.ts src/domain/identity/customer-resolver.test.ts
git commit -m "feat(identity): resolveTargetForOwnerAction deterministic disambiguation gate"
```

---

## Task 5: `setCustomerName` shared write helper

**Files:**
- Modify: `src/domain/identity/customer-resolver.ts`
- Modify: `src/domain/identity/customer-resolver.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/domain/identity/customer-resolver.test.ts`. The fake captures the `.set()` patch:

```ts
import { setCustomerName } from './customer-resolver.js'

function updateCapturingDb(): { db: Db; captured: { patch?: Record<string, unknown> } } {
  const captured: { patch?: Record<string, unknown> } = {}
  const chain: Record<string, unknown> = {}
  chain['set'] = (patch: Record<string, unknown>) => { captured.patch = patch; return chain }
  chain['where'] = () => Promise.resolve(undefined)
  const db = { update: () => chain } as unknown as Db
  return { db, captured }
}

describe('setCustomerName', () => {
  it('writes only the provided fields', async () => {
    const { db, captured } = updateCapturingDb()
    await setCustomerName(db, 'biz1', 'id1', { lastName: 'Cohen' })
    expect(captured.patch).toEqual({ lastName: 'Cohen' })
  })
  it('writes both displayName and lastName when given', async () => {
    const { db, captured } = updateCapturingDb()
    await setCustomerName(db, 'biz1', 'id1', { displayName: 'Guy Cohen', lastName: 'Cohen' })
    expect(captured.patch).toEqual({ displayName: 'Guy Cohen', lastName: 'Cohen' })
  })
  it('no-ops (no update) when given nothing', async () => {
    const { db, captured } = updateCapturingDb()
    await setCustomerName(db, 'biz1', 'id1', {})
    expect(captured.patch).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/domain/identity/customer-resolver.test.ts`
Expected: FAIL — `setCustomerName` is not exported.

- [ ] **Step 3: Implement `setCustomerName`**

Append to `src/domain/identity/customer-resolver.ts`:

```ts
/** Shared deterministic write for a target's name fields. Skips the DB entirely when no field
 *  is supplied. Used by booking capture, the owner setCustomerName tool, and opportunistic
 *  save at disambiguation. */
export async function setCustomerName(
  db: Db,
  businessId: string,
  identityId: string,
  fields: { displayName?: string | null; lastName?: string | null },
): Promise<void> {
  const patch: Record<string, unknown> = {}
  if (fields.displayName !== undefined) patch['displayName'] = fields.displayName
  if (fields.lastName !== undefined) patch['lastName'] = fields.lastName
  if (Object.keys(patch).length === 0) return
  await db.update(identities).set(patch).where(and(eq(identities.businessId, businessId), eq(identities.id, identityId)))
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/domain/identity/customer-resolver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/identity/customer-resolver.ts src/domain/identity/customer-resolver.test.ts
git commit -m "feat(identity): setCustomerName shared write helper"
```

---

## Task 6: Route `messageCustomer` through the resolver + `lastName` arg + opportunistic save

**Files:**
- Modify: `src/domain/manager/orchestrator-tools.ts` (`MessageCustomerArgs` ~line 1880s; `executeMessageCustomer` name branch ~lines 1940-1952)
- Modify: `src/adapters/llm/orchestrator.ts` (messageCustomer declaration, ~lines 368-389)
- Modify: `src/domain/manager/orchestrator-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/domain/manager/orchestrator-tools.test.ts`. A fake DB returns two same-name customers so the name path must surface candidates rather than send:

```ts
import { executeMessageCustomer } from './orchestrator-tools.js'

function twoGuysCtx(): ToolContext {
  let call = 0
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'from', 'leftJoin', 'orderBy']) chain[m] = () => chain
  chain['where'] = () => chain
  chain['limit'] = () => {
    call += 1
    // 1st query: business row (messageCustomer loads it first). 2nd: identity name match (two rows).
    if (call === 1) return Promise.resolve([{ name: 'Studio', defaultLanguage: 'he', whatsappPhoneNumberId: 'wa', whatsappAccessToken: 'tok' }])
    if (call === 2) return Promise.resolve([
      { id: 'c1', displayName: 'Guy Cohen', lastName: 'Cohen', phoneNumber: '+972500000001' },
      { id: 'c2', displayName: 'Guy Levi', lastName: 'Levi', phoneNumber: '+972500000002' },
    ])
    return Promise.resolve([]) // latestBookingFor for each candidate
  }
  return {
    db: { select: () => chain } as unknown as ToolContext['db'],
    calendar: {} as ToolContext['calendar'],
    businessId: 'biz1', identityId: 'mgr1', timezone: 'Asia/Jerusalem', lang: 'he', role: 'manager',
  }
}

describe('messageCustomer — disambiguation', () => {
  it('two same-name customers → ambiguous, no send, candidates returned', async () => {
    const res = await executeMessageCustomer({ name: 'Guy', message: 'Hi' }, twoGuysCtx()) as {
      ok: boolean; reason?: string; candidates?: unknown[]
    }
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('ambiguous_customer')
    expect(res.candidates).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/domain/manager/orchestrator-tools.test.ts`
Expected: FAIL — current code returns the count-only guidance with no `candidates` field.

- [ ] **Step 3: Add the `lastName` arg to the interface and import the resolver**

In `src/domain/manager/orchestrator-tools.ts`, add to the top-of-file imports (near the existing identity import):

```ts
import { resolveTargetForOwnerAction, setCustomerName, type CandidateView } from '../identity/customer-resolver.js'
```

Find `interface MessageCustomerArgs` and add a `lastName` field:

```ts
  name?: string
  lastName?: string
```

- [ ] **Step 4: Replace the inline name branch with the resolver**

In `executeMessageCustomer`, replace the existing `else if (args.name) { ... }` block (the one doing the inline `ilike` lookup and returning `ambiguous_customer` with a count) with:

```ts
  } else if (args.name) {
    const resolution = await resolveTargetForOwnerAction(ctx.db, ctx.businessId, {
      role: 'customer', name: args.name, ...(args.lastName ? { lastName: args.lastName } : {}),
      timezone: ctx.timezone, lang: ctx.lang,
    })
    if (resolution.status === 'not_found') {
      return { ok: false, reason: 'customer_not_found', guidance: `No customer named "${args.name}" is on file. Ask the owner for the phone number so you can reach them.` }
    }
    if (resolution.status === 'ambiguous') {
      return {
        ok: false,
        reason: 'ambiguous_customer',
        candidates: resolution.candidates,
        guidance: disambiguationGuidance(args.name, resolution.candidates, 'messageCustomer'),
      }
    }
    // resolved
    const t = resolution.target
    // Opportunistic save: the owner just disambiguated by last name we didn't have on file.
    if (args.lastName && !t.lastName) {
      await setCustomerName(ctx.db, ctx.businessId, t.id, { lastName: args.lastName.trim() }).catch(() => {})
    }
    target = { id: t.id, phoneNumber: t.phoneNumber, optOut: false }
  } else {
```

Note: `target` keeps its existing shape `{ id, phoneNumber, optOut }`. The opt-out gate later in the function (`if (target.optOut)`) is preserved — the resolver does not read opt-out, so we re-read it via the existing downstream logic. To keep that gate accurate, fetch opt-out alongside: replace `optOut: false` above with a lookup. Simplest correct form — after setting `target`, refresh opt-out:

```ts
    const [optRow] = await ctx.db
      .select({ optOut: identities.messagingOptOut })
      .from(identities).where(eq(identities.id, t.id)).limit(1)
    target = { id: t.id, phoneNumber: t.phoneNumber, optOut: optRow?.optOut ?? false }
```

(Place this in the `// resolved` branch in place of the `target = { ... optOut: false }` line.)

- [ ] **Step 5: Add the shared `disambiguationGuidance` helper**

Near the top of `src/domain/manager/orchestrator-tools.ts` (after imports, before the first executor), add a reusable helper so every tool phrases collisions identically:

```ts
// Builds the guidance string the orchestrator LLM relays when a name is ambiguous. Lists each
// candidate's last name (when known), full phone, and last booking so the owner can verify which
// person is meant, and tells the model to re-call the SAME tool with the chosen lastName or phone.
function disambiguationGuidance(query: string, candidates: CandidateView[], tool: string): string {
  const lines = candidates.map((c) => {
    const name = c.displayName ?? query
    const last = c.lastName ? ` (last name ${c.lastName})` : ' (no last name on file)'
    const booking = c.lastBooking ? `, last booking ${c.lastBooking.date}${c.lastBooking.service ? ` for ${c.lastBooking.service}` : ''}` : ', no bookings on file'
    return `• ${name}${last} — ${c.phoneNumber}${booking}`
  })
  return `Several people match "${query}". Ask the owner which one, showing these details so they can confirm:\n${lines.join('\n')}\nThen call ${tool} again with the chosen person's lastName (or their phoneNumber).`
}
```

- [ ] **Step 6: Update the `messageCustomer` tool declaration**

In `src/adapters/llm/orchestrator.ts`, in the `messageCustomer` declaration `properties`, add a `lastName` property after `name`:

```ts
        name: { type: Type.STRING, description: 'Customer name to match an existing customer, when no phone number is given.' },
        lastName: { type: Type.STRING, description: "The customer's last name, supplied by the owner to disambiguate when several customers share a first name." },
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run src/domain/manager/orchestrator-tools.test.ts`
Expected: PASS (the new disambiguation test, and the existing requestPayment matrix tests still green).

- [ ] **Step 8: Typecheck**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/domain/manager/orchestrator-tools.ts src/adapters/llm/orchestrator.ts src/domain/manager/orchestrator-tools.test.ts
git commit -m "feat(manager): messageCustomer disambiguation via shared resolver + lastName arg"
```

---

## Task 7: Route `requestPayment` through the resolver

**Files:**
- Modify: `src/domain/manager/orchestrator-tools.ts` (`executeRequestPayment` name branch, ~lines 1778-1789)
- Modify: `src/domain/manager/orchestrator-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/domain/manager/orchestrator-tools.test.ts`:

```ts
describe('requestPayment — disambiguation', () => {
  it('two same-name customers → refuses to charge, returns candidates', async () => {
    let call = 0
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'from', 'leftJoin', 'orderBy']) chain[m] = () => chain
    chain['where'] = () => chain
    chain['limit'] = () => {
      call += 1
      if (call === 1) return Promise.resolve([
        { id: 'c1', displayName: 'Dana Cohen', lastName: 'Cohen', phoneNumber: '+972500000001' },
        { id: 'c2', displayName: 'Dana Levi', lastName: 'Levi', phoneNumber: '+972500000002' },
      ])
      return Promise.resolve([]) // booking lookups
    }
    const ctx: ToolContext = {
      db: { select: () => chain } as unknown as ToolContext['db'],
      calendar: {} as ToolContext['calendar'],
      businessId: 'biz1', identityId: 'mgr1', timezone: 'Asia/Jerusalem', lang: 'he', role: 'manager',
    }
    const res = await executeRequestPayment({ customer: 'Dana', amount: 300, description: 'Session' }, ctx) as {
      ok: boolean; reason?: string; candidates?: unknown[]
    }
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('ambiguous_customer')
    expect(res.candidates).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/domain/manager/orchestrator-tools.test.ts`
Expected: FAIL — current code returns the count-only `ambiguous_customer` with no `candidates`.

- [ ] **Step 3: Replace the inline name branch**

In `executeRequestPayment`, replace the existing `else if (args.customer) { ... }` block (inline `ilike` + count-only ambiguity) with:

```ts
  } else if (args.customer) {
    const resolution = await resolveTargetForOwnerAction(ctx.db, ctx.businessId, {
      role: 'customer', name: args.customer, timezone: ctx.timezone, lang: ctx.lang,
    })
    if (resolution.status === 'not_found') return { ok: false, reason: 'customer_not_found', guidance: `No customer named "${args.customer}" is on file. Ask the owner for the phone number so you can reach them.` }
    if (resolution.status === 'ambiguous') {
      return { ok: false, reason: 'ambiguous_customer', candidates: resolution.candidates, guidance: disambiguationGuidance(args.customer, resolution.candidates, 'requestPayment') }
    }
    if (resolution.status === 'phone_unknown') return { ok: false, reason: 'no_recipient', guidance: 'Ask the owner who to charge — a name on file or a phone number.' }
    target = { id: resolution.target.id, phoneNumber: resolution.target.phoneNumber, name: resolution.target.displayName }
  } else {
```

(`target` keeps its existing `{ id, phoneNumber, name }` shape used by `createCharge`.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/domain/manager/orchestrator-tools.test.ts`
Expected: PASS (new test green; existing requestPayment auth-matrix tests still green — they short-circuit before the DB).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run build
git add src/domain/manager/orchestrator-tools.ts src/domain/manager/orchestrator-tools.test.ts
git commit -m "feat(payments): requestPayment refuses to charge on a name collision"
```

---

## Task 8: Route `coordinateMeeting` through the resolver (drop `.limit(1)`)

**Files:**
- Modify: `src/domain/manager/coordination-tools.ts` (contact-by-name branch, ~lines 149-153; imports ~line 3)
- Modify: `src/domain/manager/coordination-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/domain/manager/coordination-tools.test.ts` (match the file's existing import/ctx style; if it lacks a `ToolContext` factory, add the minimal one shown):

```ts
import { describe, it, expect } from 'vitest'
import { executeCoordinateMeeting } from './coordination-tools.js'
import type { ToolContext } from './orchestrator-tools.js'

describe('coordinateMeeting — contact disambiguation', () => {
  it('two same-name contacts → ambiguous, no silent first-pick', async () => {
    let call = 0
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'from', 'leftJoin', 'orderBy']) chain[m] = () => chain
    chain['where'] = () => chain
    chain['limit'] = () => {
      call += 1
      if (call === 1) return Promise.resolve([
        { id: 'k1', displayName: 'Guy Supplier', lastName: 'Supplier', phoneNumber: '+972500000003' },
        { id: 'k2', displayName: 'Guy Landlord', lastName: 'Landlord', phoneNumber: '+972500000004' },
      ])
      return Promise.resolve([])
    }
    // `.update()` stub: executeCoordinateMeeting calls persistOutreachIdentity before the contact
    // lookup; with identifyAs omitted it should early-return, but stub update() so the fake never throws.
    const updateChain: Record<string, unknown> = { set: () => updateChain, where: () => Promise.resolve(undefined) }
    const ctx: ToolContext = {
      db: { select: () => chain, update: () => updateChain } as unknown as ToolContext['db'],
      calendar: {} as ToolContext['calendar'],
      businessId: 'biz1', identityId: 'mgr1', timezone: 'Asia/Jerusalem', lang: 'he', role: 'manager',
    }
    const res = await executeCoordinateMeeting(
      { contactName: 'Guy', title: 'Sync', date: { relativeDay: 'tomorrow' }, startTime: { hour: 10, minute: 0 }, durationMinutes: 60 } as never,
      ctx,
    ) as { success: boolean; reason?: string; candidates?: unknown[] }
    expect(res.success).toBe(false)
    expect(res.reason).toBe('ambiguous_contact')
    expect(res.candidates).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/domain/manager/coordination-tools.test.ts`
Expected: FAIL — current code uses `.limit(1)` and silently picks the first contact (no `ambiguous_contact`).

- [ ] **Step 3: Import the resolver and guidance helper**

In `src/domain/manager/coordination-tools.ts`, update imports. The disambiguation guidance helper lives in `orchestrator-tools.ts` — export it there and import it here. First, in `orchestrator-tools.ts`, change `function disambiguationGuidance` to `export function disambiguationGuidance`. Then in `coordination-tools.ts` add:

```ts
import { resolveTargetForOwnerAction } from '../identity/customer-resolver.js'
import { disambiguationGuidance } from './orchestrator-tools.js'
```

- [ ] **Step 4: Replace the `.limit(1)` contact branch**

Replace the existing `} else if (args.contactName) { ... }` block (lines ~149-153) with:

```ts
  } else if (args.contactName) {
    const resolution = await resolveTargetForOwnerAction(ctx.db, ctx.businessId, {
      role: 'contact', name: args.contactName, timezone: ctx.timezone, lang: ctx.lang,
    })
    if (resolution.status === 'ambiguous') {
      return { success: false, reason: 'ambiguous_contact', candidates: resolution.candidates, guidance: disambiguationGuidance(args.contactName, resolution.candidates, 'coordinateMeeting') }
    }
    if (resolution.status !== 'resolved') {
      return { success: false, reason: 'need_phone', guidance: `I don't have a number for ${args.contactName}. Ask the owner for their phone number.` }
    }
    contactId = resolution.target.id; contactPhone = resolution.target.phoneNumber
  } else {
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/domain/manager/coordination-tools.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

```bash
npm run build
git add src/domain/manager/coordination-tools.ts src/domain/manager/orchestrator-tools.ts src/domain/manager/coordination-tools.test.ts
git commit -m "fix(coordination): coordinateMeeting disambiguates contacts instead of silent first-pick"
```

---

## Task 9: `lookupCustomer` returns `lastName` + owner `setCustomerName` tool

**Files:**
- Modify: `src/domain/manager/orchestrator-tools.ts` (`executeLookupCustomer` select ~line 1038; add `executeSetCustomerName`)
- Modify: `src/adapters/llm/orchestrator.ts` (new declaration + dispatch case + import)
- Modify: `src/domain/manager/orchestrator-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/domain/manager/orchestrator-tools.test.ts`:

```ts
import { executeSetCustomerName } from './orchestrator-tools.js'

describe('setCustomerName', () => {
  it('rejects a non-manager/non-granted caller', async () => {
    const res = await executeSetCustomerName(
      { identityId: 'c1', displayName: 'Guy Cohen', lastName: 'Cohen' },
      payCtx('customer'),
    ) as { ok: boolean; reason?: string }
    expect(res.ok).toBe(false)
    expect(res.reason).toBe('not_authorized')
  })

  it('writes the name for the owner and derives lastName when only displayName is given', async () => {
    const captured: { patch?: Record<string, unknown> } = {}
    const chain: Record<string, unknown> = {}
    chain['set'] = (p: Record<string, unknown>) => { captured.patch = p; return chain }
    chain['where'] = () => Promise.resolve(undefined)
    const ctx: ToolContext = {
      db: { update: () => chain } as unknown as ToolContext['db'],
      calendar: {} as ToolContext['calendar'],
      businessId: 'biz1', identityId: 'mgr1', timezone: 'Asia/Jerusalem', lang: 'he', role: 'manager',
    }
    const res = await executeSetCustomerName({ identityId: 'c1', displayName: 'Guy Cohen' }, ctx) as { ok: boolean }
    expect(res.ok).toBe(true)
    expect(captured.patch).toEqual({ displayName: 'Guy Cohen', lastName: 'Cohen' })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/domain/manager/orchestrator-tools.test.ts`
Expected: FAIL — `executeSetCustomerName` is not exported.

- [ ] **Step 3: Add `lastName` to `lookupCustomer`'s result**

In `executeLookupCustomer`, in the `find_by_name`/`find_by_phone` select, add `lastName`:

```ts
      .select({
        id: identities.id,
        displayName: identities.displayName,
        lastName: identities.lastName,
        phoneNumber: identities.phoneNumber,
        preferredLanguage: identities.preferredLanguage,
      })
```

(`lastName` now flows through the `withProfiles` spread automatically.)

- [ ] **Step 4: Implement `executeSetCustomerName`**

Add to `src/domain/manager/orchestrator-tools.ts` (near the other customer tools). It reuses `setCustomerName` and `deriveLastName`; add `deriveLastName` to the existing customer-resolver import:

```ts
// Owner sets/corrects a customer's name (e.g. after disambiguating two same-name customers, or
// fixing a typo). Authorization-gated like other customer-management actions. Derives the last
// name from displayName when the owner gives only a full name and no explicit lastName.
interface SetCustomerNameArgs {
  identityId?: string
  displayName?: string
  lastName?: string
}

export async function executeSetCustomerName(args: SetCustomerNameArgs, ctx: ToolContext): Promise<object> {
  const auth = authorize(
    { role: ctx.role ?? 'manager', ...(ctx.delegatedPermissions ? { delegatedPermissions: ctx.delegatedPermissions } : {}) },
    'customer.note',
  )
  if (!auth.allowed) {
    return { ok: false, reason: 'not_authorized', guidance: 'This person is not allowed to edit customer details. Tell them only the owner (or granted staff) can do that.' }
  }
  if (!args.identityId) {
    return { ok: false, reason: 'no_target', guidance: 'Look up the customer first (lookupCustomer) to get their id, then set the name.' }
  }
  const displayName = args.displayName?.trim()
  const lastName = args.lastName?.trim() || deriveLastName(displayName ?? null) || undefined
  if (!displayName && !lastName) {
    return { ok: false, reason: 'nothing_to_set', guidance: 'Ask the owner what name to save (a first/display name and optionally a last name).' }
  }
  await setCustomerName(ctx.db, ctx.businessId, args.identityId, {
    ...(displayName !== undefined ? { displayName } : {}),
    ...(lastName !== undefined ? { lastName } : {}),
  })
  return { ok: true, guidance: 'Tell the owner the name is saved, in your own words.' }
}
```

Note on the auth action: this uses the same action string the existing `saveContactNote` executor uses. Open `executeSaveContactNote` in this file and copy the exact `authorize(..., '<action>')` string it passes (shown above as `'customer.note'` — replace with the real one if it differs). This keeps the new tool behind the identical gate as note-taking.

- [ ] **Step 5: Update import in orchestrator-tools.ts**

Change the customer-resolver import added in Task 6 to also bring in `deriveLastName`:

```ts
import { resolveTargetForOwnerAction, setCustomerName, deriveLastName, type CandidateView } from '../identity/customer-resolver.js'
```

- [ ] **Step 6: Declare + dispatch the tool in orchestrator.ts**

In `src/adapters/llm/orchestrator.ts`: add `executeSetCustomerName` to the import from `orchestrator-tools.js`. Add a declaration object after the `saveContactNote` declaration:

```ts
  {
    name: 'setCustomerName',
    description: "Save or correct a customer's name (first/display name and/or last name). Use after the owner tells you a customer's name — e.g. when they clarify WHICH of two same-name customers they meant, or fix a misspelling. Look the customer up first (lookupCustomer) to get their identityId. Pass the full name in displayName; pass lastName when the owner states it explicitly.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        identityId: { type: Type.STRING, description: "The customer's identityId, from lookupCustomer." },
        displayName: { type: Type.STRING, description: "The customer's name as it should be displayed (e.g. \"Guy Cohen\")." },
        lastName: { type: Type.STRING, description: "The customer's last name, when stated explicitly. If omitted, it is derived from displayName." },
      },
      required: ['identityId'],
    },
  },
```

Add the dispatch case alongside `saveContactNote` (~line 743):

```ts
    case 'setCustomerName':
      return executeSetCustomerName(args as unknown as Parameters<typeof executeSetCustomerName>[0], ctx)
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run src/domain/manager/orchestrator-tools.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck + commit**

```bash
npm run build
git add src/domain/manager/orchestrator-tools.ts src/adapters/llm/orchestrator.ts src/domain/manager/orchestrator-tools.test.ts
git commit -m "feat(manager): owner setCustomerName tool + lookupCustomer returns lastName"
```

---

## Task 10: Booking-flow name capture (Branch 4)

When a brand-new customer (stored `displayName` is null) gives their name while booking, persist it. The LLM already extracts intent via `extractCustomerIntent`; add a `customerNameHint` field and persist it deterministically.

**Files:**
- Modify: `src/adapters/llm/client.ts` (`extractCustomerIntent` prompt ~line 153-159; the `CustomerIntentOutput` type and `customerIntentSchema` zod — both named, in this file or an adjacent `*.ts`; grep for them)
- Modify: `src/domain/flows/customer-booking.ts` (where the intent result is available and `customerMemory.displayName` is known)
- Modify: `src/domain/flows/customer-booking.test.ts` (or create if absent)

- [ ] **Step 1: Add `customerNameHint` to the extraction contract**

In `src/adapters/llm/client.ts`, in the `extractCustomerIntent` system prompt JSON structure, add a field after `"providerHint"`:

```
  "providerHint": "staff name from message" | null,
  "customerNameHint": "the customer's own name if they state it (e.g. 'I'm Guy Cohen', 'שמי גיא כהן')" | null,
```

And add a rule under the Rules list:

```
- customerNameHint: the customer's OWN name when they introduce themselves ("I'm Guy Cohen", "this is Dana", "שמי גיא"). null if they don't state their own name. Never put a staff or third-party name here.
```

Then add `customerNameHint` to the `CustomerIntentOutput` type and the `customerIntentSchema` zod object (grep `customerIntentSchema` and `CustomerIntentOutput` in `src/adapters/llm/`). Mirror the nullable-string shape of `providerHint`:

```ts
// in the type:
  customerNameHint: string | null
// in the zod schema (matching how providerHint is declared, e.g. z.string().nullable()):
  customerNameHint: z.string().nullable(),
```

- [ ] **Step 2: Write the failing test for persistence wiring**

Add to `src/domain/flows/customer-booking.test.ts` a focused test of the persistence helper you will call. To keep it unit-testable, add a small exported function `persistCapturedName` to `customer-booking.ts` and test it directly:

```ts
import { describe, it, expect, vi } from 'vitest'
import { persistCapturedName } from './customer-booking.js'

vi.mock('../identity/customer-resolver.js', () => ({
  setCustomerName: vi.fn().mockResolvedValue(undefined),
  deriveLastName: (n: string | null) => (n && n.trim().split(/\s+/).length >= 2 ? n.trim().split(/\s+/).pop()! : null),
}))
import { setCustomerName } from '../identity/customer-resolver.js'

describe('persistCapturedName', () => {
  const db = {} as never
  it('saves name + derived lastName when stored displayName is null', async () => {
    await persistCapturedName(db, 'biz1', 'c1', null, 'Guy Cohen')
    expect(setCustomerName).toHaveBeenCalledWith(db, 'biz1', 'c1', { displayName: 'Guy Cohen', lastName: 'Cohen' })
  })
  it('does NOT overwrite an existing stored name', async () => {
    vi.mocked(setCustomerName).mockClear()
    await persistCapturedName(db, 'biz1', 'c1', 'Existing', 'Guy Cohen')
    expect(setCustomerName).not.toHaveBeenCalled()
  })
  it('no-ops when no name was captured', async () => {
    vi.mocked(setCustomerName).mockClear()
    await persistCapturedName(db, 'biz1', 'c1', null, null)
    expect(setCustomerName).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/domain/flows/customer-booking.test.ts`
Expected: FAIL — `persistCapturedName` is not exported.

- [ ] **Step 4: Implement `persistCapturedName`**

In `src/domain/flows/customer-booking.ts`, add the import and the helper:

```ts
import { setCustomerName, deriveLastName } from '../identity/customer-resolver.js'

/** Persist a customer's self-stated name the first time we learn it. Only writes when we have no
 *  name on file yet (never clobbers an existing displayName). Best-effort: never throws into the
 *  booking flow. */
export async function persistCapturedName(
  db: Db,
  businessId: string,
  identityId: string,
  storedDisplayName: string | null,
  capturedName: string | null | undefined,
): Promise<void> {
  const name = capturedName?.trim()
  if (!name || storedDisplayName) return
  await setCustomerName(db, businessId, identityId, { displayName: name, lastName: deriveLastName(name) }).catch(() => {})
}
```

(Use the existing `Db` import in the file; if not already imported, add `import type { Db } from '../../db/client.js'`.)

- [ ] **Step 5: Call it from the booking flow**

In `customer-booking.ts`, locate where the `extractCustomerIntent` result and the customer's identity are both in scope (the customer's `id` and the hydrated `customerMemory.displayName`). After intent extraction, add a best-effort call. The customer's identity id is available on the booking context (`ctx`); use the same field the flow already uses to read `customerMemory`. Insert:

```ts
    // Capture the customer's name the first time they state it (non-blocking, never clobbers).
    await persistCapturedName(
      ctx.db,
      ctx.businessId,
      ctx.identityId,
      hydrated.customerMemory?.displayName ?? null,
      intent?.customerNameHint ?? null,
    )
```

Adjust the variable names (`ctx.db`, `ctx.businessId`, `ctx.identityId`, `hydrated`, `intent`) to the actual identifiers in the surrounding scope — grep nearby for how `customerMemory` and the intent result are referenced and match them exactly.

- [ ] **Step 6: Run the test + full suite**

Run: `npx vitest run src/domain/flows/customer-booking.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + commit**

```bash
npm run build
git add src/adapters/llm/client.ts src/domain/flows/customer-booking.ts src/domain/flows/customer-booking.test.ts
git commit -m "feat(booking): capture a new customer's name (incl. last name) on first mention"
```

---

## Task 11: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole project**

Run: `npm run build`
Expected: PASS, no errors.

- [ ] **Step 2: Run the entire unit suite**

Run: `npm test`
Expected: PASS. Pay attention to any pre-existing `messageCustomer` / `requestPayment` / coordination tests — if one asserted the OLD count-only `ambiguous_customer` guidance string, update that assertion to expect the new `candidates`-bearing result (the behavior change is intended).

- [ ] **Step 3: Lint (skills boundary — should be unaffected)**

Run: `npm run lint`
Expected: PASS (this change touches `src/domain`, `src/adapters`, `src/db`, not `src/skills`).

- [ ] **Step 4: Sanity-grep for leftover silent first-pick**

Run: `grep -n "ilike(identities.displayName" src/domain/manager/coordination-tools.ts src/domain/manager/orchestrator-tools.ts`
Expected: no remaining inline name lookups in the `messageCustomer` / `requestPayment` / `coordinateMeeting` resolution branches (the `lookupCustomer` and `recent_messages` read-only lookups may legitimately remain).

- [ ] **Step 5: Final commit (if any assertions were updated in Step 2)**

```bash
git add -A
git commit -m "test: align existing tool tests with resolver-based disambiguation"
```

---

## Notes for the executor

- **Deploy is out of scope for this plan.** The migration is additive + idempotent; deployment happens later via `/update-agent`.
- **`displayName` is never rewritten** — every name write either fills a null or sets a structured `lastName`. If you find yourself overwriting a non-null `displayName`, stop; that violates the spec.
- **The resolver is the only place name→target resolution may live** for owner-initiated actions. If a later step tempts you to add an inline `ilike` name lookup in a tool, route it through `resolveTargetForOwnerAction` instead.
- **Auth strings:** Task 9 assumes `setCustomerName` shares the auth action of `saveContactNote`. Verify the exact action string in `executeSaveContactNote` and reuse it verbatim — do not invent a new authorization action.
