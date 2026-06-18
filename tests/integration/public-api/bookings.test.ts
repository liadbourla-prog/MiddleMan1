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
