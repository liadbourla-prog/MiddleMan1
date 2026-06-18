import { vi } from 'vitest'
vi.mock('../../src/redis.js', () => ({ redisConnection: { quit: vi.fn(), on: vi.fn(), disconnect: vi.fn() } }))
vi.mock('../../src/workers/message-retry.js', () => ({
  enqueueMessage: vi.fn().mockResolvedValue(undefined), messageRetryQueue: { add: vi.fn() }, startMessageRetryWorker: vi.fn(),
}))
vi.mock('../../src/workers/calendar-mirror.js', () => ({
  enqueueBlockMirror: vi.fn().mockResolvedValue(undefined), enqueueBlockDeletion: vi.fn().mockResolvedValue(undefined),
  enqueueBookingDeletion: vi.fn().mockResolvedValue(undefined), startCalendarMirrorWorker: vi.fn(),
}))

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../../src/db/client.js'
import { seedBusiness, seedCustomer, teardown, integrationEnabled } from './setup.js'
import type { TestBusiness } from './setup.js'
import { applyProviderChange } from '../../src/domain/manager/apply.js'
import { createBlock } from '../../src/domain/availability/blocks.js'
import { requestBooking } from '../../src/domain/booking/engine.js'
import { localTimeToUtc } from '../../src/domain/availability/compute.js'
import { createCalendarClient } from '../../src/adapters/calendar/client.js'
import { findProviderByName } from '../../src/domain/provider/lookup.js'
import { loadSessionRoster } from '../../src/domain/booking/roster.js'
import { and, eq } from 'drizzle-orm'
import { identities } from '../../src/db/schema.js'
import type { ResolvedIdentity } from '../../src/domain/identity/types.js'

const TZ = 'Asia/Jerusalem'
function futureWeekday(weekday: number): string {
  const d = new Date(); d.setUTCDate(d.getUTCDate() + 7)
  while (d.getUTCDay() !== weekday) d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}
const cal = (businessId: string) => createCalendarClient({ accessToken: '', refreshToken: '', calendarId: 'test', businessId, calendarMode: 'internal', lang: 'en' })
function cust(id: string, businessId: string, phone: string): ResolvedIdentity {
  return { id, businessId, phoneNumber: phone, role: 'customer', displayName: null, messagingOptOut: false, preferredLanguage: null, conversationPausedUntil: null }
}
async function managerId(businessId: string): Promise<string> {
  const [m] = await db.select({ id: identities.id }).from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.role, 'manager'))).limit(1)
  if (!m) throw new Error('no manager'); return m.id
}

describe.skipIf(!integrationEnabled)('loadSessionRoster', () => {
  let biz: TestBusiness
  beforeEach(async () => {
    biz = await seedBusiness({ available247: true, timezone: TZ, language: 'en' })
    const mgr = await managerId(biz.businessId)
    await applyProviderChange(db, biz.businessId, mgr, { action: 'add', instructorName: 'Dana', serviceNames: ['Yoga Class'] }, 'en')
  })
  afterEach(async () => { await teardown(biz.businessId) })

  it('returns the class instance meta + confirmed participants + spotsLeft', async () => {
    const r = await findProviderByName(db, biz.businessId, 'Dana')
    if (r.status !== 'found') throw new Error('Dana not found')
    const danaId = r.id
    const start = localTimeToUtc(futureWeekday(1), '10:00', TZ)
    const end = new Date(start.getTime() + 3_600_000)
    await createBlock(db, { businessId: biz.businessId, type: 'class', start, end, serviceTypeId: biz.groupServiceId, maxParticipants: 3, providerId: danaId })

    const c1 = await seedCustomer(biz.businessId, '+972500000201')
    const c2 = await seedCustomer(biz.businessId, '+972500000202')
    await requestBooking(db, cal(biz.businessId), cust(c1, biz.businessId, '+972500000201'), { serviceTypeId: biz.groupServiceId, slotStart: start, slotEnd: end })
    await requestBooking(db, cal(biz.businessId), cust(c2, biz.businessId, '+972500000202'), { serviceTypeId: biz.groupServiceId, slotStart: start, slotEnd: end })

    const roster = await loadSessionRoster(db, biz.businessId, { serviceTypeId: biz.groupServiceId, slotStart: start })
    expect(roster).not.toBeNull()
    expect(roster!.instance.capacity).toBe(3)
    expect(roster!.instance.instructorId).toBe(danaId)
    expect(roster!.participants.length).toBe(2)
    expect(roster!.spotsLeft).toBe(1)
    expect(roster!.participants.every((p) => p.state === 'confirmed')).toBe(true)
  })

  it('returns null when no booking and no class block exist for the slot', async () => {
    const start = localTimeToUtc(futureWeekday(2), '09:00', TZ)
    const roster = await loadSessionRoster(db, biz.businessId, { serviceTypeId: biz.groupServiceId, slotStart: start })
    expect(roster).toBeNull()
  })
})
