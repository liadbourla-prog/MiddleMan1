// Regression coverage for PLAN Track 1 (timezone fixes, recurring sessions,
// persisted staff permissions). Exercises the DETERMINISTIC engine directly
// against a real DB — needs DATABASE_URL but NOT an LLM key, so it runs in CI
// wherever Postgres is available. Run: npm run test:integration

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
import { db } from '../../src/db/client.js'
import { eq, and } from 'drizzle-orm'
import { calendarBlocks, classSeriesExceptions, managerInstructions, identities } from '../../src/db/schema.js'
import {
  seedBusiness, seedProvider, seedClassSeries, teardown, integrationEnabled,
} from './setup.js'
import type { TestBusiness } from './setup.js'
import { resolveProvider } from '../../src/domain/provider/resolver.js'
import { localTimeToUtc } from '../../src/domain/availability/compute.js'
import { materializeSeries, cancelOccurrence } from '../../src/domain/scheduling/series.js'
import { applyInstruction } from '../../src/domain/manager/apply.js'
import { loadDelegatedPermissions } from '../../src/domain/authorization/permissions.js'

// ── C-D · Provider resolver respects BUSINESS-LOCAL day/time, not server-UTC ────

describe.skipIf(!integrationEnabled)('C-D — provider resolution is timezone-correct', () => {
  let biz: TestBusiness
  beforeEach(async () => { biz = await seedBusiness({ available247: false, timezone: 'Asia/Jerusalem' }) })
  afterEach(async () => { await teardown(biz.businessId) })

  it('uses the local weekday/hours window, not the UTC one', async () => {
    // Instructor works Sundays 08:00–12:00 (business-local).
    const { phone } = await seedProvider({
      businessId: biz.businessId,
      serviceTypeId: biz.serviceId,
      displayName: 'Dana',
      weeklyHours: [{ dayOfWeek: 0, openTime: '08:00', closeTime: '12:00' }],
    })

    // 2026-06-14 is a Sunday. A 02:00 local slot maps to Sat 23:00 UTC — under the
    // old UTC decomposition the resolver saw "Saturday, no rule" and wrongly marked
    // the instructor available. Correct answer: outside Sunday 08:00–12:00 ⇒ null.
    const earlyStart = localTimeToUtc('2026-06-14', '02:00', 'Asia/Jerusalem')
    const earlyEnd = new Date(earlyStart.getTime() + 30 * 60_000)
    const early = await resolveProvider(db, biz.businessId, biz.serviceId, earlyStart, earlyEnd, 'Dana', 'Asia/Jerusalem')
    expect(early).toBeNull()

    // A 09:00 local Sunday slot is inside the window ⇒ instructor resolved.
    const inStart = localTimeToUtc('2026-06-14', '09:00', 'Asia/Jerusalem')
    const inEnd = new Date(inStart.getTime() + 30 * 60_000)
    const within = await resolveProvider(db, biz.businessId, biz.serviceId, inStart, inEnd, 'Dana', 'Asia/Jerusalem')
    expect(within?.phoneNumber).toBe(phone)
  })
})

// ── C-B · Recurring weekly sessions materialize, except, and stay idempotent ────

describe.skipIf(!integrationEnabled)('C-B — recurring class materialization', () => {
  let biz: TestBusiness
  beforeEach(async () => { biz = await seedBusiness({ timezone: 'America/New_York' }) })
  afterEach(async () => { await teardown(biz.businessId) })

  it('materializes weekly instances, is idempotent, and honors exceptions', async () => {
    const seriesId = await seedClassSeries({
      businessId: biz.businessId,
      serviceTypeId: biz.groupServiceId,
      dayOfWeek: 1, // Monday
      startTime: '10:00',
      startDate: '2026-03-02',
      timezone: 'America/New_York',
      title: 'Yoga',
    })

    const from = new Date('2026-03-01T00:00:00Z')
    const first = await materializeSeries(db, seriesId, { from, horizonDays: 21 })
    expect(first.created).toBeGreaterThanOrEqual(3) // Mar 2, 9, 16 (+ maybe 23)

    // Idempotent: re-running creates nothing new.
    const second = await materializeSeries(db, seriesId, { from, horizonDays: 21 })
    expect(second.created).toBe(0)

    // Every instance is a class block at 10:00 local even across the Mar 8 DST shift.
    const instances = await db.select().from(calendarBlocks).where(eq(calendarBlocks.seriesId, seriesId))
    for (const inst of instances) {
      const localHour = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }).format(inst.startTs)
      expect(parseInt(localHour, 10) % 24).toBe(10)
      expect(inst.type).toBe('class')
    }

    // Cancel one occurrence → exception recorded + that instance removed; re-materialize does not recreate it.
    await cancelOccurrence(db, seriesId, '2026-03-09', 'instructor away')
    const exc = await db.select().from(classSeriesExceptions).where(eq(classSeriesExceptions.seriesId, seriesId))
    expect(exc.map((e) => e.occurrenceDate)).toContain('2026-03-09')
    const after = await materializeSeries(db, seriesId, { from, horizonDays: 21 })
    expect(after.created).toBe(0)
    const remaining = await db.select().from(calendarBlocks).where(eq(calendarBlocks.seriesId, seriesId))
    const remainingDates = remaining.map((r) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(r.startTs))
    expect(remainingDates).not.toContain('2026-03-09')
  })
})

// ── C-F · Owner-declared staff edit permission persists and is enforced ─────────

describe.skipIf(!integrationEnabled)('C-F — delegated staff permissions', () => {
  let biz: TestBusiness
  beforeEach(async () => { biz = await seedBusiness({ timezone: 'Asia/Jerusalem' }) })
  afterEach(async () => { await teardown(biz.businessId) })

  it('grant persists the calendar-edit set; the apply gate allows schedule edits but blocks pricing', async () => {
    // Manager grants a staff member calendar-edit access (Branch 3 permission_change).
    const grantInstr = await seedInstruction(biz.businessId, biz.managerPhone)
    const staffPhone = '+972500000999'
    const grant = await applyInstruction(
      db, grantInstr, biz.businessId, await managerId(biz),
      'permission_change', { action: 'grant', phoneNumber: staffPhone, displayName: 'Dana' }, 'en',
    )
    expect(grant.ok).toBe(true)

    // The grant is persisted as discrete actions (survives restart — it's in the DB).
    const [staff] = await db
      .select({ id: identities.id })
      .from(identities)
      .where(and(eq(identities.businessId, biz.businessId), eq(identities.phoneNumber, staffPhone)))
      .limit(1)
    expect(staff).toBeTruthy()
    const perms = await loadDelegatedPermissions(db, staff!.id)
    expect(perms.has('schedule.set_availability')).toBe(true)
    expect(perms.has('service.modify')).toBe(false)

    const auth = { role: 'delegated_user' as const, permissions: perms }

    // Allowed: a schedule change (availability_change).
    const okInstr = await seedInstruction(biz.businessId, staffPhone)
    const okRes = await applyInstruction(
      db, okInstr, biz.businessId, staff!.id,
      'availability_change', { action: 'set_hours', dayOfWeek: 1, openTime: '09:00', closeTime: '17:00' }, 'en', auth,
    )
    expect(okRes.ok).toBe(true)

    // Blocked: changing a service/price — staff was not granted service.modify.
    const blkInstr = await seedInstruction(biz.businessId, staffPhone)
    const blocked = await applyInstruction(
      db, blkInstr, biz.businessId, staff!.id,
      'service_change', { action: 'create', name: 'Premium Cut', durationMinutes: 60, paymentAmount: 200 }, 'en', auth,
    )
    expect(blocked.ok).toBe(false)
    // and the instruction is marked failed, not applied
    const row = await db.select().from(managerInstructions).where(eq(managerInstructions.id, blkInstr)).limit(1)
    expect(row[0]?.applyStatus).toBe('failed')
  })
})

// ── helpers ─────────────────────────────────────────────────────────────────

async function managerId(biz: TestBusiness): Promise<string> {
  const [m] = await db
    .select({ id: identities.id })
    .from(identities)
    .where(and(eq(identities.businessId, biz.businessId), eq(identities.role, 'manager')))
    .limit(1)
  if (!m) throw new Error('manager not found')
  return m.id
}

async function seedInstruction(businessId: string, _phone: string): Promise<string> {
  const mgrId = await managerId({ businessId } as TestBusiness)
  const [row] = await db
    .insert(managerInstructions)
    .values({ businessId, identityId: mgrId, rawMessage: 'test', receivedAt: new Date(), applyStatus: 'pending' })
    .returning({ id: managerInstructions.id })
  return row!.id
}
