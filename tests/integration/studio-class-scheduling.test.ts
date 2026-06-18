// Integration coverage for studio week-to-week class scheduling (D1):
//  - schedule a one-off class WITH an instructor -> class block carries providerId
//  - a customer booking INTO that class inherits the instructor (no hint needed)
//  - correct per-slot attribution with two instructors
//  - per-class capacity enforced
//  - findClassBlockProviderForSlot helper
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
import { createBlock, findClassBlockProviderForSlot } from '../../src/domain/availability/blocks.js'
import { requestBooking } from '../../src/domain/booking/engine.js'
import { localTimeToUtc } from '../../src/domain/availability/compute.js'
import { createCalendarClient } from '../../src/adapters/calendar/client.js'
import { findProviderByName } from '../../src/domain/provider/lookup.js'
import type { ResolvedIdentity } from '../../src/domain/identity/types.js'

const TZ = 'Asia/Jerusalem'
// setup.ts seeds the group service as 'Yoga Class' for English (lang='en')
const GROUP_SERVICE_NAME = 'Yoga Class'

// 'YYYY-MM-DD' for the next given weekday (0=Sun..6=Sat) at least 7 days ahead.
function futureWeekday(weekday: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + 7)
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

const calendar = (businessId: string) =>
  createCalendarClient({
    accessToken: '',
    refreshToken: '',
    calendarId: 'test',
    businessId,
    calendarMode: 'internal',
    lang: 'en',
  })

async function managerId(businessId: string): Promise<string> {
  const [m] = await db
    .select({ id: identities.id })
    .from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.role, 'manager')))
    .limit(1)
  if (!m) throw new Error('manager not found')
  return m.id
}

async function provId(businessId: string, name: string): Promise<string> {
  const r = await findProviderByName(db, businessId, name)
  if (r.status !== 'found') throw new Error(`provider ${name}: ${r.status}`)
  return r.id
}

function cust(id: string, businessId: string, phone: string): ResolvedIdentity {
  return {
    id,
    businessId,
    phoneNumber: phone,
    role: 'customer',
    displayName: null,
    messagingOptOut: false,
    preferredLanguage: null,
    conversationPausedUntil: null,
  }
}

describe.skipIf(!integrationEnabled)('studio class scheduling', () => {
  let biz: TestBusiness
  let actorId: string

  beforeEach(async () => {
    biz = await seedBusiness({ available247: true, timezone: TZ, language: 'en' })
    actorId = await managerId(biz.businessId)
    // Studio model: instructors assigned to the group service with NO weekly hours
    await applyProviderChange(
      db,
      biz.businessId,
      actorId,
      { action: 'add', instructorName: 'Dana', serviceNames: [GROUP_SERVICE_NAME] },
      'en',
    )
    await applyProviderChange(
      db,
      biz.businessId,
      actorId,
      { action: 'add', instructorName: 'Noa', serviceNames: [GROUP_SERVICE_NAME] },
      'en',
    )
  })

  afterEach(async () => {
    await teardown(biz.businessId)
  })

  it('D1: a customer booking inherits the class block instructor (no hint)', async () => {
    const danaId = await provId(biz.businessId, 'Dana')
    const start = localTimeToUtc(futureWeekday(1), '10:00', TZ)
    const end = new Date(start.getTime() + 3_600_000)

    await createBlock(db, {
      businessId: biz.businessId,
      type: 'class',
      start,
      end,
      serviceTypeId: biz.groupServiceId,
      maxParticipants: 12,
      providerId: danaId,
    })

    const customerId = await seedCustomer(biz.businessId, '+972500000001')
    const res = await requestBooking(db, calendar(biz.businessId), cust(customerId, biz.businessId, '+972500000001'), {
      serviceTypeId: biz.groupServiceId,
      slotStart: start,
      slotEnd: end,
    })

    expect(res.ok).toBe(true)

    const [bk] = await db
      .select({ providerId: bookings.providerId })
      .from(bookings)
      .where(and(eq(bookings.businessId, biz.businessId), eq(bookings.customerId, customerId)))
      .limit(1)

    expect(bk?.providerId).toBe(danaId)
  })

  it('per-slot attribution: Dana Mon vs Noa Wed', async () => {
    const danaId = await provId(biz.businessId, 'Dana')
    const noaId = await provId(biz.businessId, 'Noa')

    const mon = localTimeToUtc(futureWeekday(1), '10:00', TZ)
    const wed = localTimeToUtc(futureWeekday(3), '18:00', TZ)

    await createBlock(db, {
      businessId: biz.businessId,
      type: 'class',
      start: mon,
      end: new Date(mon.getTime() + 3_600_000),
      serviceTypeId: biz.groupServiceId,
      maxParticipants: 12,
      providerId: danaId,
    })
    await createBlock(db, {
      businessId: biz.businessId,
      type: 'class',
      start: wed,
      end: new Date(wed.getTime() + 3_600_000),
      serviceTypeId: biz.groupServiceId,
      maxParticipants: 12,
      providerId: noaId,
    })

    const c1 = await seedCustomer(biz.businessId, '+972500000002')
    const c2 = await seedCustomer(biz.businessId, '+972500000003')

    await requestBooking(db, calendar(biz.businessId), cust(c1, biz.businessId, '+972500000002'), {
      serviceTypeId: biz.groupServiceId,
      slotStart: mon,
      slotEnd: new Date(mon.getTime() + 3_600_000),
    })
    await requestBooking(db, calendar(biz.businessId), cust(c2, biz.businessId, '+972500000003'), {
      serviceTypeId: biz.groupServiceId,
      slotStart: wed,
      slotEnd: new Date(wed.getTime() + 3_600_000),
    })

    const [b1] = await db
      .select({ providerId: bookings.providerId })
      .from(bookings)
      .where(and(eq(bookings.businessId, biz.businessId), eq(bookings.customerId, c1)))
      .limit(1)

    const [b2] = await db
      .select({ providerId: bookings.providerId })
      .from(bookings)
      .where(and(eq(bookings.businessId, biz.businessId), eq(bookings.customerId, c2)))
      .limit(1)

    expect(b1?.providerId).toBe(danaId)
    expect(b2?.providerId).toBe(noaId)
  })

  it('per-class capacity is enforced', async () => {
    const danaId = await provId(biz.businessId, 'Dana')
    const start = localTimeToUtc(futureWeekday(1), '10:00', TZ)
    const end = new Date(start.getTime() + 3_600_000)

    await createBlock(db, {
      businessId: biz.businessId,
      type: 'class',
      start,
      end,
      serviceTypeId: biz.groupServiceId,
      maxParticipants: 1,
      providerId: danaId,
    })

    const c1 = await seedCustomer(biz.businessId, '+972500000004')
    const c2 = await seedCustomer(biz.businessId, '+972500000005')

    const r1 = await requestBooking(db, calendar(biz.businessId), cust(c1, biz.businessId, '+972500000004'), {
      serviceTypeId: biz.groupServiceId,
      slotStart: start,
      slotEnd: end,
    })
    const r2 = await requestBooking(db, calendar(biz.businessId), cust(c2, biz.businessId, '+972500000005'), {
      serviceTypeId: biz.groupServiceId,
      slotStart: start,
      slotEnd: end,
    })

    // First booking succeeds; second is rejected because class is full.
    // No confirm step is needed — 'requested' state counts toward capacity.
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(false)
  })

  it('findClassBlockProviderForSlot returns the class block instructor', async () => {
    const danaId = await provId(biz.businessId, 'Dana')
    const start = localTimeToUtc(futureWeekday(1), '10:00', TZ)

    await createBlock(db, {
      businessId: biz.businessId,
      type: 'class',
      start,
      end: new Date(start.getTime() + 3_600_000),
      serviceTypeId: biz.groupServiceId,
      maxParticipants: 12,
      providerId: danaId,
    })

    const hit = await findClassBlockProviderForSlot(db, biz.businessId, biz.groupServiceId, start)
    expect(hit.found).toBe(true)
    if (hit.found) expect(hit.providerId).toBe(danaId)

    // A slot with no class block returns { found: false }
    const miss = await findClassBlockProviderForSlot(
      db,
      biz.businessId,
      biz.groupServiceId,
      new Date(start.getTime() + 86_400_000),
    )
    expect(miss.found).toBe(false)
  })
})
