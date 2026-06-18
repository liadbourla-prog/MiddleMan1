# Website Data Plug-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an authenticated JSON API at `/api/v1/*` that lets any website read the live schedule/instructors/prices/availability and create bookings, all through the existing canonical reads and the `requestBooking` seam (per `docs/superpowers/specs/2026-06-18-website-data-plugin-design.md`).

**Architecture:** A Fastify route group `src/routes/public-api/` (Developer A, core — not a skill). Thin transport, no new data path: reads call `resolveServicePrice` / `loadInstructorRoster` / `loadTeachingSchedule` / `getOpenSlots` / `loadSessionRoster`; the one write calls `requestBooking`. Two-key auth (`business_api_keys`): publishable → public reads; secret → roster names + booking writes. Rate-limit via the already-registered `@fastify/rate-limit` (per-route); idempotency via Redis. Responses are structured JSON only — never customer-facing prose.

**Tech Stack:** TypeScript, Fastify, Drizzle (postgres-js), Postgres 16, ioredis, Vitest. Node `crypto` for key hashing.

---

## Environment for integration steps

Export before any DB/Redis step (isolated infra — NEVER prod):

```bash
export DATABASE_URL="postgresql://$(whoami)@127.0.0.1:5440/pa4business_test"
export LLM_API_KEY="test-key-unit"
export REDIS_URL="redis://127.0.0.1:6379"
export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"; export LC_ALL="en_US.UTF-8"
```

Gates between tasks (must stay green): `npx tsc --noEmit`, `npm run lint`, `npm test`, plus the touched integration files.

## File Structure

- `src/db/schema.ts` — add `businessApiKeys` table + `BusinessApiKey` type.
- `src/db/migrations/0020_business_api_keys.sql` — **new**, idempotent.
- `src/routes/public-api/auth.ts` — **new** — key generation/hashing, `resolveApiKey`, bearer extraction, `requireAuth`, `apiError`.
- `src/routes/public-api/reads.ts` — **new** — services/instructors/schedule/availability/roster handlers.
- `src/routes/public-api/bookings.ts` — **new** — `POST /bookings` (find-or-create identity → `requestBooking`) + idempotency.
- `src/routes/public-api/index.ts` — **new** — `publicApiRoutes` Fastify plugin, registers all handlers under `/api/v1` with per-route rate limits.
- `src/server.ts` — register `publicApiRoutes`.
- `scripts/mint-api-key.ts` — **new** — mint + print a raw key once.
- Tests: `tests/routes/api-key.test.ts` (unit), `tests/integration/public-api/{auth,reads,roster,bookings}.test.ts`.

A note on auth shape: handlers call `await requireAuth(db, request, reply, 'public' | 'secret')`, which returns `{ businessId }` or sends the error envelope and returns `null`. Each handler does `const auth = await requireAuth(...); if (!auth) return`.

---

## Task 1: `business_api_keys` schema, migration, and key util

**Files:**
- Modify: `src/db/schema.ts`
- Create: `src/db/migrations/0020_business_api_keys.sql`, `src/routes/public-api/auth.ts`, `scripts/mint-api-key.ts`
- Test: `tests/routes/api-key.test.ts`

- [ ] **Step 1: Add the table to the Drizzle schema**

In `src/db/schema.ts`, after the `servicePriceTiers` table, add:

```typescript
// Per-business API keys for the public website data API (website-data-plugin spec).
// We store only the sha256 hash of the raw key; the raw key is shown once at mint.
export const businessApiKeys = pgTable(
  'business_api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    type: text('type', { enum: ['publishable', 'secret'] }).notNull(),
    keyHash: text('key_hash').notNull(),
    prefix: text('prefix').notNull(),
    label: text('label'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('business_api_keys_hash_idx').on(t.keyHash),
    index('business_api_keys_business_idx').on(t.businessId, t.isActive),
  ],
)
```

And in the type-exports block add:

```typescript
export type BusinessApiKey = typeof businessApiKeys.$inferSelect
```

- [ ] **Step 2: Write the idempotent migration**

Create `src/db/migrations/0020_business_api_keys.sql`:

```sql
-- Per-business API keys for the public website data API (website-data-plugin).
-- Only the sha256 hash is stored; the raw key is shown once at mint time.
-- Applied manually (this project's migrations are hand-applied). IF NOT EXISTS guards.

CREATE TABLE IF NOT EXISTS business_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  type text NOT NULL,
  key_hash text NOT NULL,
  prefix text NOT NULL,
  label text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS business_api_keys_hash_idx ON business_api_keys (key_hash);
CREATE INDEX IF NOT EXISTS business_api_keys_business_idx ON business_api_keys (business_id, is_active);
```

- [ ] **Step 3: Apply to the test DB and verify**

Run:
```bash
psql -h 127.0.0.1 -p 5440 -d pa4business_test -f src/db/migrations/0020_business_api_keys.sql
psql -h 127.0.0.1 -p 5440 -d pa4business_test -tAc "select count(*) from business_api_keys;"
```
Expected: `CREATE TABLE` / `CREATE INDEX` ×2, then `0`.

- [ ] **Step 4: Write the failing unit test for the key util**

Create `tests/routes/api-key.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { generateApiKey, hashApiKey } from '../../src/routes/public-api/auth.js'

describe('api key util', () => {
  it('generates a publishable key with pk_ prefix and matching hash', () => {
    const k = generateApiKey('publishable')
    expect(k.raw.startsWith('pk_live_')).toBe(true)
    expect(k.prefix).toBe(k.raw.slice(0, 12))
    expect(k.hash).toBe(hashApiKey(k.raw))
    expect(k.hash).toHaveLength(64) // sha256 hex
  })

  it('generates a secret key with sk_ prefix', () => {
    const k = generateApiKey('secret')
    expect(k.raw.startsWith('sk_live_')).toBe(true)
  })

  it('hashApiKey is deterministic and distinct per input', () => {
    expect(hashApiKey('abc')).toBe(hashApiKey('abc'))
    expect(hashApiKey('abc')).not.toBe(hashApiKey('abd'))
  })
})
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npm test -- tests/routes/api-key.test.ts`
Expected: FAIL — cannot find module `auth.js`.

- [ ] **Step 6: Implement the auth util (key parts only for now)**

Create `src/routes/public-api/auth.ts`:

```typescript
import crypto from 'crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { businessApiKeys } from '../../db/schema.js'

export type KeyType = 'publishable' | 'secret'
export type ApiScope = 'public' | 'secret'

export function hashApiKey(raw: string): string {
  return crypto.createHash('sha256').update(raw).digest('hex')
}

export function generateApiKey(type: KeyType): { raw: string; hash: string; prefix: string } {
  const tag = type === 'secret' ? 'sk' : 'pk'
  const raw = `${tag}_live_${crypto.randomBytes(24).toString('base64url')}`
  return { raw, hash: hashApiKey(raw), prefix: raw.slice(0, 12) }
}

export function extractBearer(request: FastifyRequest): string | null {
  const h = request.headers['authorization']
  if (!h || Array.isArray(h)) return null
  const m = /^Bearer (.+)$/.exec(h)
  return m ? m[1]!.trim() : null
}

export interface ResolvedKey { businessId: string; type: KeyType }

export async function resolveApiKey(db: Db, rawKey: string): Promise<ResolvedKey | null> {
  const [row] = await db
    .select({ businessId: businessApiKeys.businessId, type: businessApiKeys.type })
    .from(businessApiKeys)
    .where(
      and(
        eq(businessApiKeys.keyHash, hashApiKey(rawKey)),
        eq(businessApiKeys.isActive, true),
        isNull(businessApiKeys.revokedAt),
      ),
    )
    .limit(1)
  return row ?? null
}

export function apiError(reply: FastifyReply, status: number, code: string, message: string): FastifyReply {
  return reply.status(status).send({ error: { code, message } })
}

/**
 * Authenticate + scope-check a request. Returns { businessId } or sends the error
 * envelope and returns null. `required: 'public'` accepts any valid key;
 * `required: 'secret'` requires a secret key (roster names + writes).
 */
export async function requireAuth(
  db: Db,
  request: FastifyRequest,
  reply: FastifyReply,
  required: ApiScope,
): Promise<{ businessId: string } | null> {
  const raw = extractBearer(request)
  if (!raw) { apiError(reply, 401, 'unauthorized', 'Missing Bearer API key'); return null }
  const key = await resolveApiKey(db, raw)
  if (!key) { apiError(reply, 401, 'unauthorized', 'Invalid or revoked API key'); return null }
  if (required === 'secret' && key.type !== 'secret') {
    apiError(reply, 403, 'forbidden_scope', 'This endpoint requires a secret key')
    return null
  }
  return { businessId: key.businessId }
}
```

- [ ] **Step 7: Run the unit test to verify it passes**

Run: `npm test -- tests/routes/api-key.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 8: Add the mint script**

Create `scripts/mint-api-key.ts`:

```typescript
import { db } from '../src/db/client.js'
import { businessApiKeys, businesses } from '../src/db/schema.js'
import { eq } from 'drizzle-orm'
import { generateApiKey, type KeyType } from '../src/routes/public-api/auth.js'

async function main() {
  const [businessId, type, label] = process.argv.slice(2)
  if (!businessId || (type !== 'publishable' && type !== 'secret')) {
    console.error('Usage: tsx scripts/mint-api-key.ts <businessId> <publishable|secret> [label]')
    process.exit(1)
  }
  const [biz] = await db.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, businessId)).limit(1)
  if (!biz) { console.error(`No business ${businessId}`); process.exit(1) }

  const key = generateApiKey(type as KeyType)
  await db.insert(businessApiKeys).values({
    businessId, type: type as KeyType, keyHash: key.hash, prefix: key.prefix, label: label ?? null,
  })
  console.log(`Minted ${type} key for ${businessId}:`)
  console.log(`  ${key.raw}`)
  console.log('Store it now — it will not be shown again.')
  process.exit(0)
}
main().catch((e) => { console.error(e); process.exit(1) })
```

- [ ] **Step 9: Verify tsc + commit**

```bash
npx tsc --noEmit
git add src/db/schema.ts src/db/migrations/0020_business_api_keys.sql src/routes/public-api/auth.ts scripts/mint-api-key.ts tests/routes/api-key.test.ts
git commit -m "feat(public-api): business_api_keys schema, key util, auth resolver, mint script"
```

---

## Task 2: Route plugin skeleton + auth wiring + mount

**Files:**
- Create: `src/routes/public-api/index.ts`
- Modify: `src/server.ts`
- Test: `tests/integration/public-api/auth.test.ts`

- [ ] **Step 1: Write the failing integration test (auth/scope on a stub route)**

Create `tests/integration/public-api/auth.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { db } from '../../../src/db/client.js'
import { businessApiKeys } from '../../../src/db/schema.js'
import { eq } from 'drizzle-orm'
import { seedBusiness, teardown, integrationEnabled } from '../setup.js'
import type { TestBusiness } from '../setup.js'
import { publicApiRoutes } from '../../../src/routes/public-api/index.js'
import { generateApiKey } from '../../../src/routes/public-api/auth.js'

async function mintKey(businessId: string, type: 'publishable' | 'secret'): Promise<string> {
  const k = generateApiKey(type)
  await db.insert(businessApiKeys).values({ businessId, type, keyHash: k.hash, prefix: k.prefix })
  return k.raw
}

describe.skipIf(!integrationEnabled)('public-api auth', () => {
  let app: FastifyInstance
  let biz: TestBusiness
  beforeEach(async () => {
    biz = await seedBusiness({ language: 'en' })
    app = Fastify()
    await app.register(publicApiRoutes)
    await app.ready()
  })
  afterEach(async () => {
    await app.close()
    await db.delete(businessApiKeys).where(eq(businessApiKeys.businessId, biz.businessId))
    await teardown(biz.businessId)
  })

  it('rejects a request with no key (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/services' })
    expect(res.statusCode).toBe(401)
    expect(res.json().error.code).toBe('unauthorized')
  })

  it('accepts a publishable key on a public read', async () => {
    const key = await mintKey(biz.businessId, 'publishable')
    const res = await app.inject({ method: 'GET', url: '/api/v1/services', headers: { authorization: `Bearer ${key}` } })
    expect(res.statusCode).toBe(200)
  })

  it('forbids a publishable key on a secret endpoint (403)', async () => {
    const key = await mintKey(biz.businessId, 'publishable')
    const res = await app.inject({
      method: 'POST', url: '/api/v1/bookings',
      headers: { authorization: `Bearer ${key}` },
      payload: { serviceTypeId: biz.serviceId, slotStart: new Date().toISOString(), slotEnd: new Date().toISOString(), name: 'X', phone: '+972500000900' },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('forbidden_scope')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/public-api/auth.test.ts`
Expected: FAIL — cannot find module `index.js`.

- [ ] **Step 3: Implement the plugin skeleton with the two endpoints referenced by the test**

Create `src/routes/public-api/index.ts`:

```typescript
import type { FastifyInstance } from 'fastify'
import { db } from '../../db/client.js'
import { requireAuth, apiError } from './auth.js'

// Reads + bookings handlers are added in later tasks; this skeleton wires auth so
// the route group is registered and scope is enforced from the start.
export async function publicApiRoutes(app: FastifyInstance): Promise<void> {
  // Public read (stub until Task 3 fills it in)
  app.get('/api/v1/services', async (request, reply) => {
    const auth = await requireAuth(db, request, reply, 'public')
    if (!auth) return
    return reply.send({ services: [] })
  })

  // Secret-scope write (stub until Task 5 fills it in)
  app.post('/api/v1/bookings', async (request, reply) => {
    const auth = await requireAuth(db, request, reply, 'secret')
    if (!auth) return
    return apiError(reply, 501, 'not_implemented', 'Booking handler not yet implemented')
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/public-api/auth.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Mount the plugin in the server**

In `src/server.ts`, next to the other `await app.register(...)` calls (around line 68), add the import at the top with the other route imports:

```typescript
import { publicApiRoutes } from './routes/public-api/index.js'
```

and the registration alongside the others:

```typescript
await app.register(publicApiRoutes)
```

- [ ] **Step 6: Verify tsc + commit**

```bash
npx tsc --noEmit
git add src/routes/public-api/index.ts src/server.ts tests/integration/public-api/auth.test.ts
git commit -m "feat(public-api): route plugin skeleton + auth/scope wiring + server mount"
```

---

## Task 3: Public read endpoints (services, instructors, schedule, availability)

**Files:**
- Create: `src/routes/public-api/reads.ts`
- Modify: `src/routes/public-api/index.ts`
- Test: `tests/integration/public-api/reads.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/public-api/reads.test.ts`:

```typescript
import { vi } from 'vitest'
vi.mock('../../../src/redis.js', () => ({ redisConnection: { quit: vi.fn(), on: vi.fn(), disconnect: vi.fn() }, redis: { get: vi.fn(), set: vi.fn() } }))
vi.mock('../../../src/workers/message-retry.js', () => ({ enqueueMessage: vi.fn().mockResolvedValue(undefined), messageRetryQueue: { add: vi.fn() }, startMessageRetryWorker: vi.fn() }))
vi.mock('../../../src/workers/calendar-mirror.js', () => ({ enqueueBlockMirror: vi.fn().mockResolvedValue(undefined), enqueueBlockDeletion: vi.fn().mockResolvedValue(undefined), enqueueBookingDeletion: vi.fn().mockResolvedValue(undefined), startCalendarMirrorWorker: vi.fn() }))

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { db } from '../../../src/db/client.js'
import { businessApiKeys, serviceTypes } from '../../../src/db/schema.js'
import { eq, and } from 'drizzle-orm'
import { seedBusiness, teardown, integrationEnabled } from '../setup.js'
import type { TestBusiness } from '../setup.js'
import { publicApiRoutes } from '../../../src/routes/public-api/index.js'
import { generateApiKey } from '../../../src/routes/public-api/auth.js'
import { applyProviderChange } from '../../../src/domain/manager/apply.js'
import { createBlock } from '../../../src/domain/availability/blocks.js'
import { localTimeToUtc } from '../../../src/domain/availability/compute.js'
import { identities } from '../../../src/db/schema.js'

const TZ = 'Asia/Jerusalem'
function futureWeekday(weekday: number): string {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + 7)
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}
async function pubKey(businessId: string): Promise<string> {
  const k = generateApiKey('publishable')
  await db.insert(businessApiKeys).values({ businessId, type: 'publishable', keyHash: k.hash, prefix: k.prefix })
  return k.raw
}

describe.skipIf(!integrationEnabled)('public-api reads', () => {
  let app: FastifyInstance
  let biz: TestBusiness
  let key: string
  beforeEach(async () => {
    biz = await seedBusiness({ available247: true, timezone: TZ, language: 'en' })
    await db.update(serviceTypes).set({ paymentAmount: '120.00', requiresPayment: true }).where(eq(serviceTypes.id, biz.serviceId))
    const [mgr] = await db.select({ id: identities.id }).from(identities).where(and(eq(identities.businessId, biz.businessId), eq(identities.role, 'manager'))).limit(1)
    await applyProviderChange(db, biz.businessId, mgr!.id, { action: 'add', instructorName: 'Dana', serviceNames: ['Yoga Class'] }, 'en')
    app = Fastify(); await app.register(publicApiRoutes); await app.ready()
    key = await pubKey(biz.businessId)
  })
  afterEach(async () => {
    await app.close()
    await db.delete(businessApiKeys).where(eq(businessApiKeys.businessId, biz.businessId))
    await teardown(biz.businessId)
  })

  const auth = () => ({ authorization: `Bearer ${key}` })

  it('GET /services returns the service with its resolved price', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/services', headers: auth() })
    expect(res.statusCode).toBe(200)
    const svc = res.json().services.find((s: { id: string }) => s.id === biz.serviceId)
    expect(svc.price).toBe(120)
  })

  it('GET /instructors lists Dana', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/instructors', headers: auth() })
    expect(res.statusCode).toBe(200)
    expect(res.json().instructors.some((i: { name: string }) => i.name === 'Dana')).toBe(true)
  })

  it('GET /schedule returns a class instance with spotsLeft count and no names', async () => {
    const start = localTimeToUtc(futureWeekday(1), '10:00', TZ)
    const end = new Date(start.getTime() + 3_600_000)
    await createBlock(db, { businessId: biz.businessId, type: 'class', start, end, serviceTypeId: biz.groupServiceId, maxParticipants: 8 })
    const from = new Date(Date.now()).toISOString()
    const to = new Date(Date.now() + 14 * 86_400_000).toISOString()
    const res = await app.inject({ method: 'GET', url: `/api/v1/schedule?from=${from}&to=${to}`, headers: auth() })
    expect(res.statusCode).toBe(200)
    const cls = res.json().classes
    expect(cls.length).toBeGreaterThanOrEqual(1)
    expect(cls[0]).toHaveProperty('spotsLeft')
    expect(cls[0]).not.toHaveProperty('participants')
  })

  it('GET /availability returns open slots for a service', async () => {
    const from = new Date(Date.now() + 86_400_000).toISOString()
    const to = new Date(Date.now() + 3 * 86_400_000).toISOString()
    const res = await app.inject({ method: 'GET', url: `/api/v1/availability?serviceTypeId=${biz.serviceId}&from=${from}&to=${to}`, headers: auth() })
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(res.json().slots)).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/public-api/reads.test.ts`
Expected: FAIL — `/api/v1/instructors` etc. 404, or module missing.

- [ ] **Step 3: Implement the read handlers**

Create `src/routes/public-api/reads.ts`:

```typescript
import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { businesses, serviceTypes } from '../../db/schema.js'
import type { Business } from '../../db/schema.js'
import { requireAuth, apiError } from './auth.js'
import { resolveServicePrice } from '../../domain/pricing/resolver.js'
import { loadInstructorRoster } from '../../domain/provider/roster.js'
import { getOpenSlots } from '../../domain/availability/service.js'
import { listBlocksInRange } from '../../domain/availability/blocks.js'
import { loadSessionRoster } from '../../domain/booking/roster.js'

async function loadBusiness(businessId: string): Promise<Business | null> {
  const [b] = await db.select().from(businesses).where(eq(businesses.id, businessId)).limit(1)
  return b ?? null
}

export function registerReadRoutes(app: FastifyInstance): void {
  // Services + resolved price (default tier — no membership eligibility)
  app.get('/api/v1/services', async (request, reply) => {
    const auth = await requireAuth(db, request, reply, 'public')
    if (!auth) return
    const biz = await loadBusiness(auth.businessId)
    if (!biz) return apiError(reply, 404, 'not_found', 'Business not found')
    const rows = await db.select().from(serviceTypes)
      .where(and(eq(serviceTypes.businessId, auth.businessId), eq(serviceTypes.isActive, true)))
    const services = await Promise.all(rows.map(async (s) => ({
      id: s.id,
      name: s.name,
      durationMinutes: s.durationMinutes,
      maxParticipants: s.maxParticipants,
      type: s.maxParticipants > 1 ? 'class' : 'session',
      price: (await resolveServicePrice(db, auth.businessId, { serviceTypeId: s.id, currency: biz.currency })).amount,
      currency: biz.currency,
    })))
    return reply.send({ services })
  })

  // Instructors (who teaches what + weekly hours)
  app.get('/api/v1/instructors', async (request, reply) => {
    const auth = await requireAuth(db, request, reply, 'public')
    if (!auth) return
    const roster = await loadInstructorRoster(db, auth.businessId)
    return reply.send({ instructors: roster.map((r) => ({ name: r.name, services: r.services, weeklyHours: r.weeklyHours })) })
  })

  // Upcoming class instances with spotsLeft COUNT (no participant names)
  app.get<{ Querystring: { from?: string; to?: string } }>('/api/v1/schedule', async (request, reply) => {
    const auth = await requireAuth(db, request, reply, 'public')
    if (!auth) return
    const biz = await loadBusiness(auth.businessId)
    if (!biz) return apiError(reply, 404, 'not_found', 'Business not found')
    const from = request.query.from ? new Date(request.query.from) : new Date()
    const to = request.query.to ? new Date(request.query.to) : new Date(Date.now() + 14 * 86_400_000)
    if (isNaN(from.getTime()) || isNaN(to.getTime())) return apiError(reply, 422, 'validation_error', 'Invalid from/to')

    const blocks = (await listBlocksInRange(db, auth.businessId, from, to)).filter((b) => b.type === 'class' && b.serviceTypeId)
    const classes = []
    for (const b of blocks) {
      const roster = await loadSessionRoster(db, auth.businessId, { serviceTypeId: b.serviceTypeId!, slotStart: b.startTs })
      const price = await resolveServicePrice(db, auth.businessId, { serviceTypeId: b.serviceTypeId!, currency: biz.currency })
      classes.push({
        serviceTypeId: b.serviceTypeId,
        serviceName: roster?.instance.serviceName ?? b.title ?? null,
        instructorName: roster?.instance.instructorName ?? null,
        start: b.startTs.toISOString(),
        end: b.endTs.toISOString(),
        capacity: roster?.instance.capacity ?? b.maxParticipants ?? null,
        spotsLeft: roster?.spotsLeft ?? b.maxParticipants ?? null,
        price: price.amount,
        currency: biz.currency,
      })
    }
    return reply.send({ timezone: biz.timezone, classes })
  })

  // Open bookable slots for one service
  app.get<{ Querystring: { serviceTypeId?: string; from?: string; to?: string } }>('/api/v1/availability', async (request, reply) => {
    const auth = await requireAuth(db, request, reply, 'public')
    if (!auth) return
    const biz = await loadBusiness(auth.businessId)
    if (!biz) return apiError(reply, 404, 'not_found', 'Business not found')
    const { serviceTypeId } = request.query
    if (!serviceTypeId) return apiError(reply, 422, 'validation_error', 'serviceTypeId is required')
    const [svc] = await db.select().from(serviceTypes)
      .where(and(eq(serviceTypes.id, serviceTypeId), eq(serviceTypes.businessId, auth.businessId))).limit(1)
    if (!svc) return apiError(reply, 404, 'not_found', 'Service not found')
    const from = request.query.from ? new Date(request.query.from) : new Date()
    const to = request.query.to ? new Date(request.query.to) : new Date(Date.now() + 7 * 86_400_000)
    if (isNaN(from.getTime()) || isNaN(to.getTime())) return apiError(reply, 422, 'validation_error', 'Invalid from/to')
    const slots = await getOpenSlots(db, biz, { start: from, end: to }, svc.durationMinutes)
    return reply.send({ timezone: biz.timezone, slots: slots.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })) })
  })
}
```

- [ ] **Step 4: Wire the read routes into the plugin**

In `src/routes/public-api/index.ts`, replace the `/api/v1/services` stub with a call to `registerReadRoutes`. The file becomes:

```typescript
import type { FastifyInstance } from 'fastify'
import { db } from '../../db/client.js'
import { requireAuth, apiError } from './auth.js'
import { registerReadRoutes } from './reads.js'

export async function publicApiRoutes(app: FastifyInstance): Promise<void> {
  registerReadRoutes(app)

  // Secret-scope write (stub until Task 5 fills it in)
  app.post('/api/v1/bookings', async (request, reply) => {
    const auth = await requireAuth(db, request, reply, 'secret')
    if (!auth) return
    return apiError(reply, 501, 'not_implemented', 'Booking handler not yet implemented')
  })
}
```

- [ ] **Step 5: Run the reads test + the auth test to verify both pass**

Run:
```bash
npx vitest run --config vitest.integration.config.ts tests/integration/public-api/reads.test.ts tests/integration/public-api/auth.test.ts
```
Expected: PASS (7 tests total).

- [ ] **Step 6: Verify tsc + commit**

```bash
npx tsc --noEmit
git add src/routes/public-api/reads.ts src/routes/public-api/index.ts tests/integration/public-api/reads.test.ts
git commit -m "feat(public-api): public read endpoints (services, instructors, schedule, availability)"
```

---

## Task 4: Roster endpoint (secret scope)

**Files:**
- Modify: `src/routes/public-api/reads.ts`, `src/routes/public-api/index.ts` (no change needed if route added in reads), `tests/integration/public-api/roster.test.ts`
- Test: `tests/integration/public-api/roster.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/public-api/roster.test.ts`:

```typescript
import { vi } from 'vitest'
vi.mock('../../../src/redis.js', () => ({ redisConnection: { quit: vi.fn(), on: vi.fn(), disconnect: vi.fn() }, redis: { get: vi.fn(), set: vi.fn() } }))
vi.mock('../../../src/workers/message-retry.js', () => ({ enqueueMessage: vi.fn().mockResolvedValue(undefined), messageRetryQueue: { add: vi.fn() }, startMessageRetryWorker: vi.fn() }))
vi.mock('../../../src/workers/calendar-mirror.js', () => ({ enqueueBlockMirror: vi.fn().mockResolvedValue(undefined), enqueueBlockDeletion: vi.fn().mockResolvedValue(undefined), enqueueBookingDeletion: vi.fn().mockResolvedValue(undefined), startCalendarMirrorWorker: vi.fn() }))

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { db } from '../../../src/db/client.js'
import { businessApiKeys } from '../../../src/db/schema.js'
import { eq } from 'drizzle-orm'
import { seedBusiness, seedCustomer, teardown, integrationEnabled } from '../setup.js'
import type { TestBusiness } from '../setup.js'
import { publicApiRoutes } from '../../../src/routes/public-api/index.js'
import { generateApiKey } from '../../../src/routes/public-api/auth.js'
import { createBlock } from '../../../src/domain/availability/blocks.js'
import { requestBooking } from '../../../src/domain/booking/engine.js'
import { createCalendarClient } from '../../../src/adapters/calendar/client.js'
import { localTimeToUtc } from '../../../src/domain/availability/compute.js'
import type { ResolvedIdentity } from '../../../src/domain/identity/types.js'

const TZ = 'Asia/Jerusalem'
function futureWeekday(weekday: number): string {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + 7)
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}
async function mintKey(businessId: string, type: 'publishable' | 'secret'): Promise<string> {
  const k = generateApiKey(type)
  await db.insert(businessApiKeys).values({ businessId, type, keyHash: k.hash, prefix: k.prefix })
  return k.raw
}
const cal = (businessId: string) => createCalendarClient({ accessToken: '', refreshToken: '', calendarId: 'test', businessId, calendarMode: 'internal', lang: 'en' })
function cust(id: string, businessId: string, phone: string): ResolvedIdentity {
  return { id, businessId, phoneNumber: phone, role: 'customer', displayName: null, messagingOptOut: false, preferredLanguage: null, conversationPausedUntil: null }
}

describe.skipIf(!integrationEnabled)('public-api roster', () => {
  let app: FastifyInstance
  let biz: TestBusiness
  let start: Date
  beforeEach(async () => {
    biz = await seedBusiness({ available247: true, timezone: TZ, language: 'en' })
    start = localTimeToUtc(futureWeekday(1), '10:00', TZ)
    const end = new Date(start.getTime() + 3_600_000)
    await createBlock(db, { businessId: biz.businessId, type: 'class', start, end, serviceTypeId: biz.groupServiceId, maxParticipants: 8 })
    const c1 = await seedCustomer(biz.businessId, '+972500000401')
    await requestBooking(db, cal(biz.businessId), cust(c1, biz.businessId, '+972500000401'), { serviceTypeId: biz.groupServiceId, slotStart: start, slotEnd: end })
    app = Fastify(); await app.register(publicApiRoutes); await app.ready()
  })
  afterEach(async () => {
    await app.close()
    await db.delete(businessApiKeys).where(eq(businessApiKeys.businessId, biz.businessId))
    await teardown(biz.businessId)
  })

  it('returns the participant roster with a secret key', async () => {
    const key = await mintKey(biz.businessId, 'secret')
    const url = `/api/v1/sessions/${biz.groupServiceId}/${encodeURIComponent(start.toISOString())}/roster`
    const res = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } })
    expect(res.statusCode).toBe(200)
    expect(res.json().participants.length).toBe(1)
  })

  it('forbids the roster with a publishable key (403)', async () => {
    const key = await mintKey(biz.businessId, 'publishable')
    const url = `/api/v1/sessions/${biz.groupServiceId}/${encodeURIComponent(start.toISOString())}/roster`
    const res = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key}` } })
    expect(res.statusCode).toBe(403)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/public-api/roster.test.ts`
Expected: FAIL — roster route 404.

- [ ] **Step 3: Add the roster handler to `reads.ts`**

In `src/routes/public-api/reads.ts`, inside `registerReadRoutes`, add (after the availability route):

```typescript
  // Participant roster for a session — PII, secret key only
  app.get<{ Params: { serviceTypeId: string; slotStartISO: string } }>(
    '/api/v1/sessions/:serviceTypeId/:slotStartISO/roster',
    async (request, reply) => {
      const auth = await requireAuth(db, request, reply, 'secret')
      if (!auth) return
      const slotStart = new Date(decodeURIComponent(request.params.slotStartISO))
      if (isNaN(slotStart.getTime())) return apiError(reply, 422, 'validation_error', 'Invalid slotStart')
      const roster = await loadSessionRoster(db, auth.businessId, { serviceTypeId: request.params.serviceTypeId, slotStart })
      if (!roster) return apiError(reply, 404, 'not_found', 'No session at that slot')
      return reply.send({
        instance: {
          serviceTypeId: roster.instance.serviceTypeId,
          serviceName: roster.instance.serviceName,
          instructorName: roster.instance.instructorName,
          start: roster.instance.start.toISOString(),
          capacity: roster.instance.capacity,
        },
        spotsLeft: roster.spotsLeft,
        participants: roster.participants.map((p) => ({
          name: p.displayName,
          state: p.state,
          paymentStatus: p.paymentStatus,
          attendance: p.attendance,
        })),
      })
    },
  )
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/public-api/roster.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Verify tsc + commit**

```bash
npx tsc --noEmit
git add src/routes/public-api/reads.ts tests/integration/public-api/roster.test.ts
git commit -m "feat(public-api): secret-scope session roster endpoint"
```

---

## Task 5: Booking endpoint (`POST /bookings`) + idempotency

**Files:**
- Create: `src/routes/public-api/bookings.ts`
- Modify: `src/routes/public-api/index.ts`
- Test: `tests/integration/public-api/bookings.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `tests/integration/public-api/bookings.test.ts`:

```typescript
import { vi } from 'vitest'
vi.mock('../../../src/redis.js', () => {
  const store = new Map<string, string>()
  return { redisConnection: { quit: vi.fn(), on: vi.fn(), disconnect: vi.fn() },
    redis: {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK' }),
    } }
})
vi.mock('../../../src/workers/message-retry.js', () => ({ enqueueMessage: vi.fn().mockResolvedValue(undefined), messageRetryQueue: { add: vi.fn() }, startMessageRetryWorker: vi.fn() }))
vi.mock('../../../src/workers/calendar-mirror.js', () => ({ enqueueBlockMirror: vi.fn().mockResolvedValue(undefined), enqueueBlockDeletion: vi.fn().mockResolvedValue(undefined), enqueueBookingDeletion: vi.fn().mockResolvedValue(undefined), startCalendarMirrorWorker: vi.fn() }))

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { db } from '../../../src/db/client.js'
import { businessApiKeys, bookings, identities } from '../../../src/db/schema.js'
import { eq, and } from 'drizzle-orm'
import { seedBusiness, teardown, integrationEnabled } from '../setup.js'
import type { TestBusiness } from '../setup.js'
import { publicApiRoutes } from '../../../src/routes/public-api/index.js'
import { generateApiKey } from '../../../src/routes/public-api/auth.js'
import { createBlock } from '../../../src/domain/availability/blocks.js'
import { localTimeToUtc } from '../../../src/domain/availability/compute.js'

const TZ = 'Asia/Jerusalem'
function futureWeekday(weekday: number): string {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + 7)
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}
async function secretKey(businessId: string): Promise<string> {
  const k = generateApiKey('secret')
  await db.insert(businessApiKeys).values({ businessId, type: 'secret', keyHash: k.hash, prefix: k.prefix })
  return k.raw
}

describe.skipIf(!integrationEnabled)('public-api bookings', () => {
  let app: FastifyInstance
  let biz: TestBusiness
  let key: string
  let start: Date
  let end: Date
  beforeEach(async () => {
    biz = await seedBusiness({ available247: true, timezone: TZ, language: 'en' })
    start = localTimeToUtc(futureWeekday(1), '10:00', TZ)
    end = new Date(start.getTime() + 3_600_000)
    await createBlock(db, { businessId: biz.businessId, type: 'class', start, end, serviceTypeId: biz.groupServiceId, maxParticipants: 2 })
    app = Fastify(); await app.register(publicApiRoutes); await app.ready()
    key = await secretKey(biz.businessId)
  })
  afterEach(async () => {
    await app.close()
    await db.delete(businessApiKeys).where(eq(businessApiKeys.businessId, biz.businessId))
    await teardown(biz.businessId)
  })

  function body(phone: string) {
    return { serviceTypeId: biz.groupServiceId, slotStart: start.toISOString(), slotEnd: end.toISOString(), name: 'Web Customer', phone }
  }

  it('creates a booking attributed to a phone-keyed identity', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/bookings',
      headers: { authorization: `Bearer ${key}`, 'idempotency-key': 'k1' }, payload: body('+972500000501') })
    expect(res.statusCode).toBe(201)
    const bookingId = res.json().booking.id
    const [row] = await db.select({ id: bookings.id, customerId: bookings.customerId }).from(bookings).where(eq(bookings.id, bookingId))
    expect(row).toBeTruthy()
    const [ident] = await db.select({ id: identities.id }).from(identities)
      .where(and(eq(identities.businessId, biz.businessId), eq(identities.phoneNumber, '+972500000501'))).limit(1)
    expect(row!.customerId).toBe(ident!.id)
  })

  it('is idempotent: the same Idempotency-Key returns the same booking', async () => {
    const headers = { authorization: `Bearer ${key}`, 'idempotency-key': 'dup' }
    const r1 = await app.inject({ method: 'POST', url: '/api/v1/bookings', headers, payload: body('+972500000502') })
    const r2 = await app.inject({ method: 'POST', url: '/api/v1/bookings', headers, payload: body('+972500000502') })
    expect(r1.json().booking.id).toBe(r2.json().booking.id)
    const rows = await db.select({ id: bookings.id }).from(bookings)
      .where(and(eq(bookings.businessId, biz.businessId), eq(bookings.serviceTypeId, biz.groupServiceId)))
    expect(rows.length).toBe(1)
  })

  it('rejects an invalid phone (422)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/bookings',
      headers: { authorization: `Bearer ${key}`, 'idempotency-key': 'k3' }, payload: body('not-a-phone') })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('validation_error')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/public-api/bookings.test.ts`
Expected: FAIL — POST returns 501 (stub) / module missing.

- [ ] **Step 3: Implement the booking handler**

Create `src/routes/public-api/bookings.ts`:

```typescript
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { businesses, bookings, serviceTypes } from '../../db/schema.js'
import { redis } from '../../redis.js'
import { requireAuth, apiError } from './auth.js'
import { isValidE164, registerCustomer, resolveIdentity } from '../../domain/identity/resolver.js'
import { requestBooking } from '../../domain/booking/engine.js'
import { createCalendarClient } from '../../adapters/calendar/client.js'

const bookingBody = z.object({
  serviceTypeId: z.string().uuid(),
  slotStart: z.string(),
  slotEnd: z.string(),
  name: z.string().min(1),
  phone: z.string(),
  providerHint: z.string().nullable().optional(),
})

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60

export function registerBookingRoutes(app: FastifyInstance): void {
  app.post('/api/v1/bookings', async (request, reply) => {
    const auth = await requireAuth(db, request, reply, 'secret')
    if (!auth) return

    const parsed = bookingBody.safeParse(request.body)
    if (!parsed.success) return apiError(reply, 422, 'validation_error', parsed.error.issues[0]?.message ?? 'Invalid body')
    const { serviceTypeId, name, providerHint } = parsed.data
    const slotStart = new Date(parsed.data.slotStart)
    const slotEnd = new Date(parsed.data.slotEnd)
    if (isNaN(slotStart.getTime()) || isNaN(slotEnd.getTime())) return apiError(reply, 422, 'validation_error', 'Invalid slotStart/slotEnd')
    if (!isValidE164(parsed.data.phone)) return apiError(reply, 422, 'validation_error', 'phone must be E.164, e.g. +972501234567')
    const phone = parsed.data.phone

    // Idempotency: replay the stored booking id for a repeated key
    const idemKey = request.headers['idempotency-key']
    const idemRedisKey = typeof idemKey === 'string' ? `idem:booking:${auth.businessId}:${idemKey}` : null
    if (idemRedisKey) {
      const prior = await redis.get(idemRedisKey)
      if (prior) {
        const [row] = await db.select().from(bookings).where(eq(bookings.id, prior)).limit(1)
        if (row) return reply.status(201).send({ booking: await shape(row.id) })
      }
    }

    const [biz] = await db.select().from(businesses).where(eq(businesses.id, auth.businessId)).limit(1)
    if (!biz) return apiError(reply, 404, 'not_found', 'Business not found')

    const customerId = await registerCustomer(db, auth.businessId, phone, name)
    const resolved = await resolveIdentity(db, auth.businessId, phone)
    if (!resolved.found) return apiError(reply, 500, 'internal', 'Failed to resolve customer identity')

    const calendar = createCalendarClient({
      accessToken: '',
      refreshToken: biz.googleRefreshToken ?? process.env['GOOGLE_REFRESH_TOKEN'] ?? '',
      calendarId: biz.googleCalendarId,
      businessId: biz.id,
      calendarMode: biz.calendarMode,
      lang: biz.defaultLanguage,
    })

    const result = await requestBooking(db, calendar, resolved.identity, {
      serviceTypeId,
      slotStart,
      slotEnd,
      ...(providerHint ? { providerHint } : {}),
    })

    if (!result.ok) {
      const full = /full/i.test(result.reason)
      return apiError(reply, 409, full ? 'class_full' : 'slot_unavailable', result.reason)
    }

    if (idemRedisKey) await redis.set(idemRedisKey, result.bookingId, 'EX', IDEMPOTENCY_TTL_SECONDS)
    return reply.status(201).send({ booking: await shape(result.bookingId) })
  })
}

async function shape(bookingId: string): Promise<object> {
  const [row] = await db
    .select({
      id: bookings.id, state: bookings.state, slotStart: bookings.slotStart, slotEnd: bookings.slotEnd,
      serviceName: serviceTypes.name,
    })
    .from(bookings)
    .innerJoin(serviceTypes, eq(bookings.serviceTypeId, serviceTypes.id))
    .where(eq(bookings.id, bookingId))
    .limit(1)
  return {
    id: row!.id, state: row!.state,
    slotStart: row!.slotStart.toISOString(), slotEnd: row!.slotEnd.toISOString(),
    serviceName: row!.serviceName,
  }
}
```

- [ ] **Step 4: Wire the booking route into the plugin (replace the stub)**

In `src/routes/public-api/index.ts`, the file becomes:

```typescript
import type { FastifyInstance } from 'fastify'
import { registerReadRoutes } from './reads.js'
import { registerBookingRoutes } from './bookings.js'

export async function publicApiRoutes(app: FastifyInstance): Promise<void> {
  registerReadRoutes(app)
  registerBookingRoutes(app)
}
```

- [ ] **Step 5: Run the booking + auth tests to verify they pass**

Run:
```bash
npx vitest run --config vitest.integration.config.ts tests/integration/public-api/bookings.test.ts tests/integration/public-api/auth.test.ts
```
Expected: PASS (auth still 3; bookings 3). Note: the auth test's 403 case still works because the secret-scope check runs before body parsing.

- [ ] **Step 6: Verify tsc + commit**

```bash
npx tsc --noEmit
git add src/routes/public-api/bookings.ts src/routes/public-api/index.ts tests/integration/public-api/bookings.test.ts
git commit -m "feat(public-api): POST /bookings via requestBooking + Redis idempotency"
```

---

## Task 6: Per-route rate limiting + full sweep

**Files:**
- Modify: `src/routes/public-api/index.ts`
- Test: `tests/integration/public-api/auth.test.ts` (add a rate-limit case)

- [ ] **Step 1: Add a failing rate-limit test**

Append to `tests/integration/public-api/auth.test.ts` inside the describe block:

```typescript
  it('rate-limits repeated requests on the same key (429)', async () => {
    const key = await mintKey(biz.businessId, 'publishable')
    const headers = { authorization: `Bearer ${key}` }
    let got429 = false
    for (let i = 0; i < 130; i++) {
      const res = await app.inject({ method: 'GET', url: '/api/v1/services', headers })
      if (res.statusCode === 429) { got429 = true; break }
    }
    expect(got429).toBe(true)
  })
```

This requires the test app to register the rate-limit plugin. At the top of the `beforeEach`, change the app setup to register `@fastify/rate-limit` before the routes:

```typescript
    app = Fastify()
    const rateLimit = (await import('@fastify/rate-limit')).default
    await app.register(rateLimit, { global: false })
    await app.register(publicApiRoutes)
    await app.ready()
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/public-api/auth.test.ts`
Expected: FAIL — never receives 429 (no per-route limit yet).

- [ ] **Step 3: Add per-route rate-limit config**

In `src/routes/public-api/index.ts`, give the read and booking routes a per-route limit keyed on the API key. Update the plugin to pass route options. Because the handlers are registered inside `registerReadRoutes` / `registerBookingRoutes`, add a shared `keyGenerator` and apply limits by wrapping registration in a child context. Replace `index.ts` with:

```typescript
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { registerReadRoutes } from './reads.js'
import { registerBookingRoutes } from './bookings.js'
import { extractBearer } from './auth.js'

function keyGenerator(request: FastifyRequest): string {
  return extractBearer(request) ?? request.ip ?? 'anon'
}

export async function publicApiRoutes(app: FastifyInstance): Promise<void> {
  // Apply a per-key rate limit to every route in this plugin instance. Requires
  // @fastify/rate-limit to be registered on the app (it is, in src/server.ts).
  app.addHook('onRequest', async (request, reply) => {
    if (typeof (request.server as { rateLimit?: unknown }).rateLimit === 'function') {
      // no-op guard; actual limiting configured via route config below
    }
  })

  await app.register(async (scoped) => {
    scoped.addHook('onRoute', (routeOptions) => {
      routeOptions.config = {
        ...(routeOptions.config ?? {}),
        rateLimit: { max: 120, timeWindow: '1 minute', keyGenerator },
      }
    })
    registerReadRoutes(scoped)
  })

  await app.register(async (scoped) => {
    scoped.addHook('onRoute', (routeOptions) => {
      routeOptions.config = {
        ...(routeOptions.config ?? {}),
        rateLimit: { max: 20, timeWindow: '1 minute', keyGenerator },
      }
    })
    registerBookingRoutes(scoped)
  })
}
```

Note: `@fastify/rate-limit` reads `routeOptions.config.rateLimit`. The reads limit is 120/min; bookings 20/min — both per key.

- [ ] **Step 4: Run the auth test (incl. rate-limit) to verify it passes**

Run: `npx vitest run --config vitest.integration.config.ts tests/integration/public-api/auth.test.ts`
Expected: PASS (4 tests). If the 429 never triggers, confirm `@fastify/rate-limit` is registered with `{ global: false }` in the test and that `config.rateLimit` is being read (bump the loop to 250 iterations only if needed).

- [ ] **Step 5: Full public-api sweep**

Run:
```bash
npx vitest run --config vitest.integration.config.ts tests/integration/public-api/
```
Expected: all pass (auth 4, reads 4, roster 2, bookings 3).

- [ ] **Step 6: All gates**

Run:
```bash
npx tsc --noEmit && npm run lint && npm test 2>&1 | grep -E "Tests "
```
Expected: tsc clean; lint clean; all unit tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/routes/public-api/index.ts tests/integration/public-api/auth.test.ts
git commit -m "feat(public-api): per-key rate limiting on reads + bookings"
```

---

## Task 7: Update CRM_STANDARD.md + spec status

**Files:**
- Modify: `CRM_STANDARD.md`

- [ ] **Step 1: Note the website projection is now implemented**

In `CRM_STANDARD.md` §6.3, append a line: the website projection is implemented as the `/api/v1/*` JSON API (`src/routes/public-api/`), sharing the canonical reads and the `requestBooking` seam — keys via `business_api_keys` (migration `0020`). Keeps the doc tracking the code (§8.2 rule 6).

- [ ] **Step 2: Commit**

```bash
git add CRM_STANDARD.md
git commit -m "docs(crm): website projection implemented via /api/v1 public API"
```

---

## Self-Review notes (already applied)

- **Spec coverage:** §2 placement → Task 2 (+ server mount); §3 keys → Task 1; §4 endpoints → Tasks 3 (public reads), 4 (roster); §5 booking flow → Task 5; §6 hardening → Task 5 (idempotency) + Task 6 (rate limit); §7 errors → `apiError` envelope used throughout; §8 testing → each task's integration tests.
- **Public/PII split:** `/schedule` exposes `spotsLeft`/`capacity` counts only (Task 3); names require secret `/roster` (Task 4) — asserted by the reads test (`not.toHaveProperty('participants')`).
- **No new data path:** reads call canonical fns; `POST /bookings` calls `requestBooking` (Task 5) — same rows as WhatsApp.
- **Type consistency:** `requireAuth`/`apiError`/`extractBearer`/`generateApiKey`/`hashApiKey`/`resolveApiKey` defined in Task 1 and reused verbatim in Tasks 2–6; `registerReadRoutes`/`registerBookingRoutes` names consistent between `reads.ts`/`bookings.ts` and `index.ts`.
- **No prod writes:** every DB/Redis step targets the isolated infra; migration `0020` applied manually there, deploy-runbook-ready.
- **Risk flagged for execution:** Task 6's per-route rate-limit wiring via `onRoute` is the least-certain part of the plan (Fastify plugin-encapsulation specifics). If `config.rateLimit` isn't honored through the nested `register`, fall back to setting `config` directly on each `app.get/post` route definition in `reads.ts`/`bookings.ts`. The test asserts the behavior either way.
