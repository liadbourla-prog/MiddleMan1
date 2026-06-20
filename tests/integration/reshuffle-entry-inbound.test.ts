import { vi } from 'vitest'
vi.mock('../../src/redis.js', () => ({ redisConnection: { quit: vi.fn(), on: vi.fn(), disconnect: vi.fn() } }))
const triggerReshuffleCampaign = vi.fn().mockResolvedValue(undefined)
vi.mock('../../src/workers/reshuffle-campaign.js', () => ({
  triggerReshuffleCampaign: (...a: unknown[]) => triggerReshuffleCampaign(...a),
}))

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../../src/db/client.js'
import { businesses, reshuffleCampaigns, reshuffleOffers } from '../../src/db/schema.js'
import { seedBusiness, seedCustomer, seedConfirmedBooking, teardown, integrationEnabled } from './setup.js'
import type { TestBusiness } from './setup.js'
import { openReshuffleCampaign } from '../../src/domain/reshuffle/entry.js'
import { handleReshuffleReply } from '../../src/domain/reshuffle/inbound.js'

const d = describe.skipIf(!integrationEnabled)

d('reshuffle entry + inbound wiring', () => {
  let biz: TestBusiness
  let custR: string
  let bookingR: string

  beforeEach(async () => {
    vi.clearAllMocks()
    biz = await seedBusiness({ calendarMode: 'internal' })
    custR = await seedCustomer(biz.businessId, '+972500000031')
    bookingR = await seedConfirmedBooking(biz.businessId, custR, biz.serviceId, 7)
  })
  afterEach(async () => { await teardown(biz.businessId) })

  it('openReshuffleCampaign creates a searching campaign and kicks the worker when enabled', async () => {
    await db.update(businesses).set({ reshuffleConfig: { enabled: true } }).where(eq(businesses.id, biz.businessId))
    const id = await openReshuffleCampaign(db, {
      businessId: biz.businessId, requesterId: custR, requesterBookingId: bookingR, serviceTypeId: biz.serviceId,
      targetSlotStart: new Date(Date.now() + 86_400_000), targetSlotEnd: new Date(Date.now() + 86_400_000 + 1_800_000),
    })
    expect(id).toBeTruthy()
    const [c] = await db.select().from(reshuffleCampaigns).where(eq(reshuffleCampaigns.id, id!)).limit(1)
    expect(c!.status).toBe('searching')
    expect(triggerReshuffleCampaign).toHaveBeenCalledWith(id)
  })

  it('openReshuffleCampaign is a no-op when the feature is off (default)', async () => {
    const id = await openReshuffleCampaign(db, {
      businessId: biz.businessId, requesterId: custR, requesterBookingId: bookingR, serviceTypeId: biz.serviceId,
      targetSlotStart: new Date(Date.now() + 86_400_000), targetSlotEnd: new Date(Date.now() + 86_400_000 + 1_800_000),
    })
    expect(id).toBeNull()
    expect(triggerReshuffleCampaign).not.toHaveBeenCalled()
  })

  // ── inbound ───────────────────────────────────────────────────────────────
  async function seedProbingOfferFor(customerId: string, bookingId: string): Promise<string> {
    const [camp] = await db.insert(reshuffleCampaigns).values({
      businessId: biz.businessId, requesterId: custR, requesterBookingId: bookingR, serviceTypeId: biz.serviceId,
      targetSlotStart: new Date(Date.now() + 2 * 86_400_000), targetSlotEnd: new Date(Date.now() + 2 * 86_400_000 + 1_800_000),
      status: 'searching', configSnapshot: { enabled: true },
    }).returning()
    await db.insert(reshuffleOffers).values({
      campaignId: camp!.id, customerId, bookingId,
      proposedSlotStart: new Date(Date.now() + 86_400_000), proposedSlotEnd: new Date(Date.now() + 86_400_000 + 1_800_000),
      status: 'probing', offerExpiresAt: new Date(Date.now() + 30 * 60_000),
    })
    return camp!.id
  }

  it('a "yes" reply accepts the offer and re-kicks the campaign', async () => {
    const custB = await seedCustomer(biz.businessId, '+972500000032')
    const bookingB = await seedConfirmedBooking(biz.businessId, custB, biz.serviceId, 8)
    await seedProbingOfferFor(custB, bookingB)

    // v1 deterministic classifier matches a bare confirmation; the LLM classifier (follow-on)
    // will handle natural phrasing like "yes please".
    const res = await handleReshuffleReply(db, custB, 'yes', 'en')
    expect(res.handled).toBe(true)
    const [offer] = await db.select().from(reshuffleOffers).where(eq(reshuffleOffers.customerId, custB)).limit(1)
    expect(offer!.status).toBe('accepted')
    expect(triggerReshuffleCampaign).toHaveBeenCalled()
  })

  it('a "no" reply declines the offer', async () => {
    const custB = await seedCustomer(biz.businessId, '+972500000033')
    const bookingB = await seedConfirmedBooking(biz.businessId, custB, biz.serviceId, 8)
    await seedProbingOfferFor(custB, bookingB)

    const res = await handleReshuffleReply(db, custB, 'no', 'en')
    expect(res.handled).toBe(true)
    const [offer] = await db.select().from(reshuffleOffers).where(eq(reshuffleOffers.customerId, custB)).limit(1)
    expect(offer!.status).toBe('declined')
  })

  it('an ambiguous reply is handled but never accepts (C3)', async () => {
    const custB = await seedCustomer(biz.businessId, '+972500000034')
    const bookingB = await seedConfirmedBooking(biz.businessId, custB, biz.serviceId, 8)
    await seedProbingOfferFor(custB, bookingB)

    const res = await handleReshuffleReply(db, custB, 'maybe, let me check', 'en')
    expect(res.handled).toBe(true)
    const [offer] = await db.select().from(reshuffleOffers).where(eq(reshuffleOffers.customerId, custB)).limit(1)
    expect(offer!.status).toBe('probing') // unchanged — not a false accept
  })

  it('returns handled:false when the customer has no live offer (normal flow runs)', async () => {
    const res = await handleReshuffleReply(db, custR, 'hello', 'en')
    expect(res.handled).toBe(false)
  })
})
