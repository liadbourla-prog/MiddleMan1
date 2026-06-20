import { vi } from 'vitest'
vi.mock('../../src/redis.js', () => ({ redisConnection: { quit: vi.fn(), on: vi.fn(), disconnect: vi.fn() } }))
vi.mock('../../src/workers/calendar-mirror.js', () => ({
  enqueueBookingMirror: vi.fn().mockResolvedValue(undefined),
  enqueueBlockMirror: vi.fn().mockResolvedValue(undefined),
  enqueueBlockDeletion: vi.fn().mockResolvedValue(undefined),
  enqueueBookingDeletion: vi.fn().mockResolvedValue(undefined),
  startCalendarMirrorWorker: vi.fn(),
}))
const sendMessage = vi.fn().mockResolvedValue({ ok: true })
const canSendFreeForm = vi.fn().mockResolvedValue(true)
vi.mock('../../src/adapters/whatsapp/sender.js', () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...a),
  canSendFreeForm: (...a: unknown[]) => canSendFreeForm(...a),
  sendTemplateMessage: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('../../src/adapters/llm/client.js', () => ({
  generateProactiveCustomerMessage: vi.fn(async (i: { fallback: string }) => i.fallback),
}))

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq, and } from 'drizzle-orm'
import { db } from '../../src/db/client.js'
import { bookings, reshuffleCampaigns, reshuffleOffers, reshuffleProposals } from '../../src/db/schema.js'
import { seedBusiness, seedCustomer, seedConfirmedBooking, teardown, integrationEnabled } from './setup.js'
import type { TestBusiness } from './setup.js'
import { processCampaignTick } from '../../src/workers/reshuffle-campaign.js'

const d = describe.skipIf(!integrationEnabled)

async function slotStartOf(id: string): Promise<Date> {
  const [b] = await db.select().from(bookings).where(eq(bookings.id, id)).limit(1)
  return b!.slotStart
}

d('reshuffle worker tick (wiring)', () => {
  let biz: TestBusiness
  let custR: string, custB: string, bookingR: string, bookingB: string
  let sA: Date, sB: Date

  beforeEach(async () => {
    vi.clearAllMocks()
    canSendFreeForm.mockResolvedValue(true)
    biz = await seedBusiness({ calendarMode: 'internal' })
    custR = await seedCustomer(biz.businessId, '+972500000021')
    custB = await seedCustomer(biz.businessId, '+972500000022')
    bookingR = await seedConfirmedBooking(biz.businessId, custR, biz.serviceId, 7)
    bookingB = await seedConfirmedBooking(biz.businessId, custB, biz.serviceId, 8)
    sA = await slotStartOf(bookingR)
    sB = await slotStartOf(bookingB)
  })

  afterEach(async () => { await teardown(biz.businessId) })

  async function seedCampaign(approvalMode: 'require_approval' | 'auto_apply'): Promise<string> {
    const [c] = await db.insert(reshuffleCampaigns).values({
      businessId: biz.businessId, requesterId: custR, requesterBookingId: bookingR, serviceTypeId: biz.serviceId,
      targetSlotStart: sB, targetSlotEnd: new Date(sB.getTime() + 30 * 60_000),
      status: 'searching', configSnapshot: { enabled: true, approvalMode },
    }).returning()
    return c!.id
  }

  async function seedAcceptedOffer(campaignId: string): Promise<void> {
    await db.insert(reshuffleOffers).values({
      campaignId, customerId: custB, bookingId: bookingB,
      proposedSlotStart: sA, proposedSlotEnd: new Date(sA.getTime() + 30 * 60_000), status: 'accepted',
    })
  }

  it('auto_apply: a tick with an accepted offer applies the swap immediately', async () => {
    const campaignId = await seedCampaign('auto_apply')
    await seedAcceptedOffer(campaignId)

    await processCampaignTick(campaignId)

    expect((await slotStartOf(bookingR)).getTime()).toBe(sB.getTime())
    expect((await slotStartOf(bookingB)).getTime()).toBe(sA.getTime())
    const [c] = await db.select().from(reshuffleCampaigns).where(eq(reshuffleCampaigns.id, campaignId)).limit(1)
    expect(c!.status).toBe('applied')
  })

  it('require_approval: a tick with an accepted offer notifies the owner, applies nothing', async () => {
    const campaignId = await seedCampaign('require_approval')
    await seedAcceptedOffer(campaignId)

    await processCampaignTick(campaignId)

    // Nothing moved; a proposal awaits approval; the manager was messaged.
    expect((await slotStartOf(bookingR)).getTime()).toBe(sA.getTime())
    const [p] = await db.select().from(reshuffleProposals).where(eq(reshuffleProposals.campaignId, campaignId)).limit(1)
    expect(p!.status).toBe('pending')
    expect(sendMessage).toHaveBeenCalledTimes(1) // owner notification
  })

  it('no agreement yet: a tick probes the target occupant (direct rung) and records the offer', async () => {
    const campaignId = await seedCampaign('require_approval')

    await processCampaignTick(campaignId)

    // A probe went to the occupant of the target slot, and an offer row was created.
    expect(sendMessage).toHaveBeenCalledTimes(1)
    const offers = await db.select().from(reshuffleOffers).where(and(eq(reshuffleOffers.campaignId, campaignId), eq(reshuffleOffers.bookingId, bookingB)))
    expect(offers).toHaveLength(1)
    expect(offers[0]!.status).toBe('probing')
  })
})
