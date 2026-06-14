// Integration coverage for multi-instructor booking behaviour:
//  - C-D: per-instructor resolution + hours enforcement (resolver-level)
//  - reactive engine fallback: a NAMED instructor who isn't free → provider_unavailable
//  - C-F: a removed instructor is no longer resolvable
// Needs DATABASE_URL but NOT an LLM key. Run: npm run test:integration

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
import { identities } from '../../src/db/schema.js'
import { seedBusiness, seedCustomer, teardown, integrationEnabled } from './setup.js'
import type { TestBusiness } from './setup.js'
import { applyProviderChange } from '../../src/domain/manager/apply.js'
import { resolveProvider } from '../../src/domain/provider/resolver.js'
import { requestBooking } from '../../src/domain/booking/engine.js'
import { localTimeToUtc } from '../../src/domain/availability/compute.js'
import { createCalendarClient } from '../../src/adapters/calendar/client.js'
import type { ResolvedIdentity } from '../../src/domain/identity/types.js'

const TZ = 'Asia/Jerusalem'
// 2026-06-15 is a Monday, 2026-06-17 is a Wednesday.
const MONDAY = '2026-06-15'
const WEDNESDAY = '2026-06-17'

function slot(dateStr: string, time: string): { start: Date; end: Date } {
  const start = localTimeToUtc(dateStr, time, TZ)
  return { start, end: new Date(start.getTime() + 30 * 60_000) }
}

async function managerId(businessId: string): Promise<string> {
  const [mgr] = await db.select({ id: identities.id }).from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.role, 'manager'))).limit(1)
  if (!mgr) throw new Error('manager identity not found')
  return mgr.id
}

describe.skipIf(!integrationEnabled)('multi-instructor booking', () => {
  let biz: TestBusiness
  let actorId: string
  let customer: ResolvedIdentity

  beforeEach(async () => {
    // available247:false so out-of-hours slots fail the spatial check (used below).
    biz = await seedBusiness({ available247: false, timezone: TZ })
    actorId = await managerId(biz.businessId)

    // Dana teaches the service Mondays 09:00–13:00; Noa teaches Wednesdays 16:00–20:00.
    await applyProviderChange(db, biz.businessId, actorId, {
      action: 'add', instructorName: 'Dana', serviceNames: [biz.serviceName],
      weeklyHours: [{ dayOfWeek: 1, startTime: '09:00', endTime: '13:00' }],
    }, 'en')
    await applyProviderChange(db, biz.businessId, actorId, {
      action: 'add', instructorName: 'Noa', serviceNames: [biz.serviceName],
      weeklyHours: [{ dayOfWeek: 3, startTime: '16:00', endTime: '20:00' }],
    }, 'en')

    const customerId = await seedCustomer(biz.businessId, '+972500000099')
    customer = {
      id: customerId, businessId: biz.businessId, phoneNumber: '+972500000099',
      role: 'customer', displayName: null, messagingOptOut: false,
      preferredLanguage: null, conversationPausedUntil: null,
    }
  })

  afterEach(async () => { await teardown(biz.businessId) })

  const calendar = () => createCalendarClient({
    accessToken: '', refreshToken: '', calendarId: 'test', businessId: '', calendarMode: 'internal', lang: 'en',
  })

  it('C-D: the resolver picks the correct instructor by name + respects each one’s hours', async () => {
    const mon = slot(MONDAY, '10:00')
    const wed = slot(WEDNESDAY, '17:00')

    // Dana on Monday in-hours → resolves Dana.
    const dMon = await resolveProvider(db, biz.businessId, biz.serviceId, mon.start, mon.end, 'Dana', TZ)
    expect(dMon?.displayName).toBe('Dana')

    // Noa on Monday → null (Noa only teaches Wednesday).
    const nMon = await resolveProvider(db, biz.businessId, biz.serviceId, mon.start, mon.end, 'Noa', TZ)
    expect(nMon).toBeNull()

    // Noa on Wednesday in-hours → resolves Noa.
    const nWed = await resolveProvider(db, biz.businessId, biz.serviceId, wed.start, wed.end, 'Noa', TZ)
    expect(nWed?.displayName).toBe('Noa')
  })

  it('reactive fallback: booking with a named instructor who is not free → provider_unavailable', async () => {
    // Dana does not teach on Wednesday → the engine must NOT silently book provider-less.
    const wed = slot(WEDNESDAY, '10:00')
    const res = await requestBooking(db, calendar(), customer, {
      serviceTypeId: biz.serviceId, slotStart: wed.start, slotEnd: wed.end, providerHint: 'Dana',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason.startsWith('provider_unavailable|Dana')).toBe(true)
  })

  it('an unmatched instructor hint does NOT trigger the provider_unavailable fallback', async () => {
    // 'Ghost' teaches nothing here; choose an out-of-hours slot so the booking fails on
    // the spatial check, never our sentinel.
    const mon = slot(MONDAY, '03:00')
    const res = await requestBooking(db, calendar(), customer, {
      serviceTypeId: biz.serviceId, slotStart: mon.start, slotEnd: mon.end, providerHint: 'Ghost',
    })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason.startsWith('provider_unavailable')).toBe(false)
  })

  it('C-F: a removed instructor is no longer resolvable', async () => {
    await applyProviderChange(db, biz.businessId, actorId, { action: 'remove', instructorName: 'Dana' }, 'en')
    const mon = slot(MONDAY, '10:00')
    const dMon = await resolveProvider(db, biz.businessId, biz.serviceId, mon.start, mon.end, 'Dana', TZ)
    expect(dMon).toBeNull()
  })
})
