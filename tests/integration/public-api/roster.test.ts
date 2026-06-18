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
