import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../../src/db/client.js'
import { servicePriceTiers, serviceTypes } from '../../src/db/schema.js'
import { eq } from 'drizzle-orm'
import { seedBusiness, teardown, integrationEnabled } from './setup.js'
import type { TestBusiness } from './setup.js'
import { resolveServicePrice } from '../../src/domain/pricing/resolver.js'

describe.skipIf(!integrationEnabled)('resolveServicePrice — §4 chain', () => {
  let biz: TestBusiness
  beforeEach(async () => { biz = await seedBusiness({ language: 'en' }) })
  afterEach(async () => { await teardown(biz.businessId) })

  it('falls back to the service base price when no tier/override applies', async () => {
    await db.update(serviceTypes).set({ paymentAmount: '120.00', requiresPayment: true })
      .where(eq(serviceTypes.id, biz.serviceId))
    const r = await resolveServicePrice(db, biz.businessId, { serviceTypeId: biz.serviceId, currency: 'ILS' })
    expect(r).toEqual({ amount: 120, currency: 'ILS', tier: null, source: 'service' })
  })

  it('prefers an instance override over the service base', async () => {
    await db.update(serviceTypes).set({ paymentAmount: '120.00', requiresPayment: true })
      .where(eq(serviceTypes.id, biz.serviceId))
    const r = await resolveServicePrice(db, biz.businessId, { serviceTypeId: biz.serviceId, currency: 'ILS', instanceOverride: 80 })
    expect(r).toEqual({ amount: 80, currency: 'ILS', tier: null, source: 'instance' })
  })

  it('prefers an eligible tier over instance and service', async () => {
    await db.update(serviceTypes).set({ paymentAmount: '120.00', requiresPayment: true })
      .where(eq(serviceTypes.id, biz.serviceId))
    await db.insert(servicePriceTiers).values({
      businessId: biz.businessId, serviceTypeId: biz.serviceId, tier: 'member', amount: '90.00', currency: 'ILS',
    })
    const r = await resolveServicePrice(db, biz.businessId, {
      serviceTypeId: biz.serviceId, currency: 'ILS', instanceOverride: 80, tierEligibility: 'member',
    })
    expect(r).toEqual({ amount: 90, currency: 'ILS', tier: 'member', source: 'tier' })
  })

  it('returns none when there is no price anywhere', async () => {
    await db.update(serviceTypes).set({ paymentAmount: null, requiresPayment: false })
      .where(eq(serviceTypes.id, biz.serviceId))
    const r = await resolveServicePrice(db, biz.businessId, { serviceTypeId: biz.serviceId, currency: 'ILS' })
    expect(r).toEqual({ amount: null, currency: 'ILS', tier: null, source: 'none' })
  })

  it('ignores a tier the caller is not eligible for (eligibility inert by default)', async () => {
    await db.update(serviceTypes).set({ paymentAmount: '120.00', requiresPayment: true })
      .where(eq(serviceTypes.id, biz.serviceId))
    await db.insert(servicePriceTiers).values({
      businessId: biz.businessId, serviceTypeId: biz.serviceId, tier: 'member', amount: '90.00', currency: 'ILS',
    })
    const r = await resolveServicePrice(db, biz.businessId, { serviceTypeId: biz.serviceId, currency: 'ILS' })
    expect(r.source).toBe('service')
    expect(r.amount).toBe(120)
  })
})
