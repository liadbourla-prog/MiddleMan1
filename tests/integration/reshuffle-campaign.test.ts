import { vi } from 'vitest'
vi.mock('../../src/redis.js', () => ({ redisConnection: { quit: vi.fn(), on: vi.fn(), disconnect: vi.fn() } }))
vi.mock('../../src/workers/calendar-mirror.js', () => ({
  enqueueBookingMirror: vi.fn().mockResolvedValue(undefined),
  enqueueBlockMirror: vi.fn().mockResolvedValue(undefined),
  enqueueBlockDeletion: vi.fn().mockResolvedValue(undefined),
  enqueueBookingDeletion: vi.fn().mockResolvedValue(undefined),
  startCalendarMirrorWorker: vi.fn(),
}))

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../../src/db/client.js'
import { bookings, reshuffleCampaigns, reshuffleOffers, reshuffleProposals } from '../../src/db/schema.js'
import { seedBusiness, seedCustomer, seedConfirmedBooking, teardown, integrationEnabled } from './setup.js'
import type { TestBusiness } from './setup.js'
import { assembleProposal } from '../../src/domain/reshuffle/campaign.js'
import { approveProposal, rejectProposal } from '../../src/domain/reshuffle/gate.js'

const d = describe.skipIf(!integrationEnabled)

async function slotStartOf(bookingId: string): Promise<Date> {
  const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1)
  return b!.slotStart
}

d('reshuffle campaign → proposal → owner gate (deterministic spine)', () => {
  let biz: TestBusiness
  let custR: string
  let custB: string
  let bookingR: string
  let bookingB: string
  let sAStart: Date
  let sBStart: Date
  let campaignId: string

  beforeEach(async () => {
    vi.clearAllMocks()
    biz = await seedBusiness({ calendarMode: 'internal' })
    custR = await seedCustomer(biz.businessId, '+972500000011')
    custB = await seedCustomer(biz.businessId, '+972500000012')
    bookingR = await seedConfirmedBooking(biz.businessId, custR, biz.serviceId, 7) // S_a
    bookingB = await seedConfirmedBooking(biz.businessId, custB, biz.serviceId, 8) // S_b (target)
    sAStart = await slotStartOf(bookingR)
    sBStart = await slotStartOf(bookingB)

    const [camp] = await db.insert(reshuffleCampaigns).values({
      businessId: biz.businessId,
      requesterId: custR,
      requesterBookingId: bookingR,
      serviceTypeId: biz.serviceId,
      targetSlotStart: sBStart,
      targetSlotEnd: new Date(sBStart.getTime() + 30 * 60_000),
      status: 'searching',
      configSnapshot: { enabled: true },
    }).returning()
    campaignId = camp!.id
  })

  afterEach(async () => { await teardown(biz.businessId) })

  // Customer B accepts taking the requester's freed slot → closes the 2-cycle.
  async function bAcceptsSA(): Promise<void> {
    await db.insert(reshuffleOffers).values({
      campaignId, customerId: custB, bookingId: bookingB,
      proposedSlotStart: sAStart, proposedSlotEnd: new Date(sAStart.getTime() + 30 * 60_000),
      status: 'accepted',
    })
  }

  it('assembles a direct-swap proposal from an accepted offer, then applies it on approval (A1 end-to-end)', async () => {
    await bAcceptsSA()
    const now = new Date()

    const res = await assembleProposal(db, campaignId, now)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.kind).toBe('exact')
    expect(res.movedCount).toBe(2)

    // Campaign advanced; proposal persisted as pending (nothing moved yet — invariant #1).
    const [c1] = await db.select().from(reshuffleCampaigns).where(eq(reshuffleCampaigns.id, campaignId)).limit(1)
    expect(c1!.status).toBe('solution_pending_approval')
    expect((await slotStartOf(bookingR)).getTime()).toBe(sAStart.getTime())

    // Owner approves → atomic swap applies.
    const applied = await approveProposal(db, res.proposalId, new Date())
    expect(applied).toEqual({ ok: true, movedCount: 2 })
    expect((await slotStartOf(bookingR)).getTime()).toBe(sBStart.getTime())
    expect((await slotStartOf(bookingB)).getTime()).toBe(sAStart.getTime())

    const [p] = await db.select().from(reshuffleProposals).where(eq(reshuffleProposals.id, res.proposalId)).limit(1)
    expect(p!.status).toBe('applied')
  })

  it('does not assemble a proposal when no one has agreed (A3 — calendar untouched)', async () => {
    const res = await assembleProposal(db, campaignId, new Date())
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('no_solution')
    const [c] = await db.select().from(reshuffleCampaigns).where(eq(reshuffleCampaigns.id, campaignId)).limit(1)
    expect(c!.status).toBe('searching') // still searching; worker decides when to give up
    const proposals = await db.select().from(reshuffleProposals).where(eq(reshuffleProposals.campaignId, campaignId))
    expect(proposals).toHaveLength(0)
  })

  it('rejecting a proposal leaves the calendar untouched and abandons the campaign (D2)', async () => {
    await bAcceptsSA()
    const res = await assembleProposal(db, campaignId, new Date())
    expect(res.ok).toBe(true)
    if (!res.ok) return

    const rejected = await rejectProposal(db, res.proposalId, new Date())
    expect(rejected.ok).toBe(true)

    // Nothing moved.
    expect((await slotStartOf(bookingR)).getTime()).toBe(sAStart.getTime())
    expect((await slotStartOf(bookingB)).getTime()).toBe(sBStart.getTime())
    const [c] = await db.select().from(reshuffleCampaigns).where(eq(reshuffleCampaigns.id, campaignId)).limit(1)
    expect(c!.status).toBe('abandoned')
    const [p] = await db.select().from(reshuffleProposals).where(eq(reshuffleProposals.id, res.proposalId)).limit(1)
    expect(p!.status).toBe('rejected')
  })
})
