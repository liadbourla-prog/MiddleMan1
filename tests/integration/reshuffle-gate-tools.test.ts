import { vi } from 'vitest'
vi.mock('../../src/redis.js', () => ({ redisConnection: { quit: vi.fn(), on: vi.fn(), disconnect: vi.fn() } }))
vi.mock('../../src/workers/calendar-mirror.js', () => ({
  enqueueBookingMirror: vi.fn().mockResolvedValue(undefined),
  enqueueBlockMirror: vi.fn().mockResolvedValue(undefined),
  enqueueBlockDeletion: vi.fn().mockResolvedValue(undefined),
  enqueueBookingDeletion: vi.fn().mockResolvedValue(undefined),
  startCalendarMirrorWorker: vi.fn(),
}))
vi.mock('../../src/workers/message-retry.js', () => ({
  enqueueMessage: vi.fn().mockResolvedValue(undefined), messageRetryQueue: { add: vi.fn() }, startMessageRetryWorker: vi.fn(),
}))

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../../src/db/client.js'
import { bookings, businesses, reshuffleCampaigns, reshuffleProposals } from '../../src/db/schema.js'
import { seedBusiness, seedCustomer, seedConfirmedBooking, teardown, integrationEnabled } from './setup.js'
import type { TestBusiness } from './setup.js'
import { executeApproveReshuffle, executeRejectReshuffle, executeConfigureReshuffle, type ToolContext } from '../../src/domain/manager/orchestrator-tools.js'
import type { Move } from '../../src/domain/reshuffle/types.js'

const d = describe.skipIf(!integrationEnabled)

async function slotStartOf(id: string): Promise<Date> {
  const [b] = await db.select().from(bookings).where(eq(bookings.id, id)).limit(1)
  return b!.slotStart
}

d('reshuffle owner gate tools (wiring)', () => {
  let biz: TestBusiness
  let custR: string, custB: string, bookingR: string, bookingB: string
  let sA: Date, sB: Date
  let ctx: ToolContext

  beforeEach(async () => {
    vi.clearAllMocks()
    biz = await seedBusiness({ calendarMode: 'internal' })
    custR = await seedCustomer(biz.businessId, '+972500000041')
    custB = await seedCustomer(biz.businessId, '+972500000042')
    bookingR = await seedConfirmedBooking(biz.businessId, custR, biz.serviceId, 7)
    bookingB = await seedConfirmedBooking(biz.businessId, custB, biz.serviceId, 8)
    sA = await slotStartOf(bookingR)
    sB = await slotStartOf(bookingB)
    ctx = { db, businessId: biz.businessId, identityId: custR, timezone: 'Asia/Jerusalem', lang: 'en', calendar: {} as never }
  })
  afterEach(async () => { await teardown(biz.businessId) })

  async function seedPendingProposal(): Promise<string> {
    const [camp] = await db.insert(reshuffleCampaigns).values({
      businessId: biz.businessId, requesterId: custR, requesterBookingId: bookingR, serviceTypeId: biz.serviceId,
      targetSlotStart: sB, targetSlotEnd: new Date(sB.getTime() + 30 * 60_000),
      status: 'solution_pending_approval', configSnapshot: { enabled: true },
    }).returning()
    const moves: Move[] = [
      { bookingId: bookingR, customerId: custR, fromSlot: { start: sA.toISOString(), durationMin: 30 }, toSlot: { start: sB.toISOString(), durationMin: 30 } },
      { bookingId: bookingB, customerId: custB, fromSlot: { start: sB.toISOString(), durationMin: 30 }, toSlot: { start: sA.toISOString(), durationMin: 30 } },
    ]
    const [p] = await db.insert(reshuffleProposals).values({
      campaignId: camp!.id, moves, touchedCount: 2, kind: 'exact', status: 'pending', presentedToOwnerAt: new Date(),
    }).returning()
    return p!.id
  }

  it('approveReshuffle applies the pending plan (swap goes live)', async () => {
    const proposalId = await seedPendingProposal()
    const res = await executeApproveReshuffle({}, ctx) as { success: boolean }
    expect(res.success).toBe(true)
    expect((await slotStartOf(bookingR)).getTime()).toBe(sB.getTime())
    expect((await slotStartOf(bookingB)).getTime()).toBe(sA.getTime())
    const [p] = await db.select().from(reshuffleProposals).where(eq(reshuffleProposals.id, proposalId)).limit(1)
    expect(p!.status).toBe('applied')
  })

  it('rejectReshuffle leaves the calendar untouched and abandons the campaign', async () => {
    const proposalId = await seedPendingProposal()
    const res = await executeRejectReshuffle({}, ctx) as { success: boolean }
    expect(res.success).toBe(true)
    expect((await slotStartOf(bookingR)).getTime()).toBe(sA.getTime())
    const [p] = await db.select().from(reshuffleProposals).where(eq(reshuffleProposals.id, proposalId)).limit(1)
    expect(p!.status).toBe('rejected')
  })

  it('approveReshuffle reports cleanly when there is no pending plan', async () => {
    const res = await executeApproveReshuffle({}, ctx) as { success: boolean; reason?: string }
    expect(res.success).toBe(false)
    expect(res.reason).toBe('no_pending_proposal')
  })

  it('configureReshuffle persists the owner knobs', async () => {
    const res = await executeConfigureReshuffle({ enabled: true, batchSize: 5, approvalMode: 'auto_apply' }, ctx) as { success: boolean }
    expect(res.success).toBe(true)
    const [b] = await db.select({ cfg: businesses.reshuffleConfig }).from(businesses).where(eq(businesses.id, biz.businessId)).limit(1)
    const cfg = b!.cfg as { enabled: boolean; batchSize: number; approvalMode: string }
    expect(cfg.enabled).toBe(true)
    expect(cfg.batchSize).toBe(5)
    expect(cfg.approvalMode).toBe('auto_apply')
  })
})
