import { vi } from 'vitest'
vi.mock('../../src/redis.js', () => ({ redisConnection: { quit: vi.fn(), on: vi.fn(), disconnect: vi.fn() } }))
// The executor enqueues a Google mirror after commit — stub the durable mirror.
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
import { bookings, reshuffleCampaigns, reshuffleProposals } from '../../src/db/schema.js'
import { seedBusiness, seedCustomer, seedConfirmedBooking, teardown, integrationEnabled } from './setup.js'
import type { TestBusiness } from './setup.js'
import { applyReshuffleProposal } from '../../src/domain/reshuffle/executor.js'
import { enqueueBookingMirror } from '../../src/workers/calendar-mirror.js'
import type { Move, Slot } from '../../src/domain/reshuffle/types.js'

const d = describe.skipIf(!integrationEnabled)

async function slotOf(bookingId: string): Promise<Slot> {
  const [b] = await db.select().from(bookings).where(eq(bookings.id, bookingId)).limit(1)
  return { start: b!.slotStart.toISOString(), durationMin: 30 }
}

d('reshuffle executor — atomic apply of an approved proposal', () => {
  let biz: TestBusiness
  let custR: string
  let custB: string
  let bookingR: string
  let bookingB: string
  let sA: Slot
  let sB: Slot
  let campaignId: string

  beforeEach(async () => {
    vi.clearAllMocks()
    biz = await seedBusiness({ calendarMode: 'internal' })
    custR = await seedCustomer(biz.businessId, '+972500000001')
    custB = await seedCustomer(biz.businessId, '+972500000002')
    bookingR = await seedConfirmedBooking(biz.businessId, custR, biz.serviceId, 7)
    bookingB = await seedConfirmedBooking(biz.businessId, custB, biz.serviceId, 8)
    sA = await slotOf(bookingR)
    sB = await slotOf(bookingB)

    const [camp] = await db.insert(reshuffleCampaigns).values({
      businessId: biz.businessId,
      requesterId: custR,
      requesterBookingId: bookingR,
      serviceTypeId: biz.serviceId,
      targetSlotStart: new Date(sB.start),
      targetSlotEnd: new Date(new Date(sB.start).getTime() + 30 * 60_000),
      status: 'solution_pending_approval',
      configSnapshot: {},
    }).returning()
    campaignId = camp!.id
  })

  afterEach(async () => { await teardown(biz.businessId) })

  function swapMoves(): Move[] {
    return [
      { bookingId: bookingR, customerId: custR, fromSlot: sA, toSlot: sB },
      { bookingId: bookingB, customerId: custB, fromSlot: sB, toSlot: sA },
    ]
  }

  async function makeProposal(status: string): Promise<string> {
    const [p] = await db.insert(reshuffleProposals).values({
      campaignId, moves: swapMoves(), touchedCount: 2, kind: 'exact', status: status as 'pending',
    }).returning()
    return p!.id
  }

  it('applies an approved swap atomically and mirrors both bookings (E1, occupancy preserved)', async () => {
    const proposalId = await makeProposal('approved')
    const res = await applyReshuffleProposal(db, proposalId)
    expect(res).toEqual({ ok: true, movedCount: 2 })

    // Slots are swapped — both customers still booked, week still full.
    expect((await slotOf(bookingR)).start).toBe(sB.start)
    expect((await slotOf(bookingB)).start).toBe(sA.start)

    const [p] = await db.select().from(reshuffleProposals).where(eq(reshuffleProposals.id, proposalId)).limit(1)
    expect(p!.status).toBe('applied')
    const [c] = await db.select().from(reshuffleCampaigns).where(eq(reshuffleCampaigns.id, campaignId)).limit(1)
    expect(c!.status).toBe('applied')
    expect(enqueueBookingMirror).toHaveBeenCalledTimes(2)
  })

  it('refuses to apply a proposal that is not approved (invariant #1 — no write before approval)', async () => {
    const proposalId = await makeProposal('pending')
    const res = await applyReshuffleProposal(db, proposalId)
    expect(res.ok).toBe(false)
    // Nothing moved.
    expect((await slotOf(bookingR)).start).toBe(sA.start)
    expect((await slotOf(bookingB)).start).toBe(sB.start)
    expect(enqueueBookingMirror).not.toHaveBeenCalled()
  })

  it('aborts a stale plan untouched when a booking changed since approval (D5)', async () => {
    const proposalId = await makeProposal('approved')
    // Simulate an external change: B moved elsewhere after the owner approved.
    const elsewhere = new Date(new Date(sB.start).getTime() + 90 * 60_000)
    await db.update(bookings).set({ slotStart: elsewhere, slotEnd: new Date(elsewhere.getTime() + 30 * 60_000) }).where(eq(bookings.id, bookingB))

    const res = await applyReshuffleProposal(db, proposalId)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toContain('stale_plan')

    // The requester's booking was NOT touched — atomic abort, zero partial writes.
    expect((await slotOf(bookingR)).start).toBe(sA.start)
    const [c] = await db.select().from(reshuffleCampaigns).where(eq(reshuffleCampaigns.id, campaignId)).limit(1)
    expect(c!.status).toBe('failed')
  })
})
