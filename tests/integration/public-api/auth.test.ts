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
    const rateLimit = (await import('@fastify/rate-limit')).default
    await app.register(rateLimit, { global: false })
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
