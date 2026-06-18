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
