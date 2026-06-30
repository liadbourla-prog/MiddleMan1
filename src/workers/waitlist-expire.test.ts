/**
 * WL-AX (PART 2) — expire_offer as the single authoritative releaser (H1).
 *
 * Proves the new ordering of the `expire_offer` branch of processJob:
 *   release the held booking (CAS held→expired) → flip the waitlist row offered→expired →
 *   send the "window passed" message (durable) → cascade — exactly once each, and in THAT order.
 *   The held booking ends `expired`. The release happens BEFORE the cascade is enqueued, so there
 *   is never a transient cap+1.
 *
 * Harness mirrors waitlist-hold.test.ts: a sequential-row db mock consumed in call order, with
 * releaseWaitlistHold (the shared releaser) and the calendar client mocked. A shared callOrder
 * array records release / flip / message / cascade so the ordering is assertable.
 *
 * vi.mock is hoisted — factories must not reference top-level variables.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoisted so the (hoisted) vi.mock factories below can reference them safely.
const { callOrder, queueAddMock } = vi.hoisted(() => {
  const order: string[] = []
  return {
    callOrder: order,
    queueAddMock: vi.fn(async (_name: string, data: { type?: string }) => {
      if (data?.type === 'offer_slot') order.push('cascade')
      return { id: 'job-1' }
    }),
  }
})

vi.mock('./message-retry.js', () => ({
  enqueueMessage: vi.fn(async () => { callOrder.push('message') }),
}))

// The waitlist BullMQ queue: record cascade enqueues (type:'offer_slot').
vi.mock('bullmq', () => ({
  Worker: vi.fn(),
  Queue: vi.fn().mockImplementation(() => ({ add: queueAddMock })),
}))

vi.mock('../redis.js', () => ({ redisConnection: {} }))
vi.mock('./waitlist-revalidate.js', () => ({ revalidateWaitlistSlotOpen: vi.fn(async () => true) }))

// The shared single releaser — record its order + the booking it releases.
const releaseMock = vi.fn(async () => { callOrder.push('release'); return true })
vi.mock('../domain/waitlist/accept.js', () => ({
  releaseWaitlistHold: (...a: unknown[]) => releaseMock(...(a as [])),
}))

vi.mock('../domain/booking/engine.js', () => ({ requestBooking: vi.fn(async () => ({ ok: true, bookingId: 'bk-1', held: true })) }))
vi.mock('../adapters/calendar/client.js', () => ({ createCalendarClient: vi.fn(() => ({ deleteEvent: vi.fn(async () => ({ status: 'deleted' })) })) }))

let dbQueryIdx = 0
const dbRows: unknown[][] = []
const updateSets: Record<string, unknown>[] = []

vi.mock('../db/client.js', () => ({
  db: {
    select: () => makeSelectChain(),
    update: () => ({
      set: (vals: Record<string, unknown>) => {
        updateSets.push(vals)
        if ((vals as { status?: string }).status === 'expired') callOrder.push('flip')
        return {
          where: () => ({
            returning: async () => dbRows[dbQueryIdx++] ?? [],
            then: (resolve: (v: unknown) => unknown) => resolve(dbRows[dbQueryIdx++] ?? []),
          }),
        }
      },
    }),
  },
}))

function makeSelectChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {}
  for (const m of ['from', 'where', 'leftJoin', 'innerJoin', 'orderBy', 'select']) chain[m] = () => chain
  chain['then'] = (resolve: (v: unknown) => unknown) => resolve(dbRows[dbQueryIdx++] ?? [])
  chain['limit'] = async () => dbRows[dbQueryIdx++] ?? []
  return chain
}

vi.mock('../adapters/whatsapp/sender.js', () => ({
  canSendFreeForm: vi.fn(async () => true),
  sendMessage: vi.fn(async () => ({ ok: true })),
  sendTemplateMessage: vi.fn(async () => {}),
}))
vi.mock('../adapters/llm/client.js', () => ({
  generateProactiveCustomerMessage: vi.fn(async ({ fallback }: { fallback: string }) => fallback),
}))

const auditCalls: { action: string }[] = []
vi.mock('../domain/audit/logger.js', () => ({
  logAudit: vi.fn(async (_db: unknown, e: { action: string }) => { auditCalls.push({ action: e.action }) }),
}))

vi.mock('../domain/initiations/dispatch.js', () => ({ dispatchInitiation: vi.fn(async () => ({ kind: 'noop' })) }))
vi.mock('../domain/initiations/registry.js', () => ({ getInitiator: vi.fn(() => undefined) }))
vi.mock('../domain/initiations/blast-breaker.js', () => ({ resolveBlastBreaker: vi.fn(() => ({})), evaluateBlastBreaker: vi.fn(() => 'continue') }))
vi.mock('../domain/crm/segment-repository.js', () => ({ queryCustomerSegment: vi.fn(async () => []) }))
vi.mock('../domain/crm/cold-fill.js', () => ({ selectColdFillCandidates: vi.fn(() => []) }))
vi.mock('../domain/i18n/t.js', () => ({
  i18n: {
    waitlist_offer: { en: () => 'A spot opened.', he: () => 'נפתח מקום.' },
    waitlist_window_passed: { en: () => 'The window passed.', he: () => 'החלון עבר.' },
  },
}))
vi.mock('../domain/waitlist/priority.js', () => ({ rankWaitlistCandidates: vi.fn((e: unknown[]) => e), waitlistTier: vi.fn(() => 'priority') }))

import { processJob } from './waitlist.js'

const SLOT = new Date('2026-07-01T10:00:00Z')
const SLOT_END = new Date('2026-07-01T11:00:00Z')
const EXPIRE_JOB = {
  data: {
    type: 'expire_offer' as const,
    waitlistId: 'wl-A',
    businessId: 'biz-1',
    serviceTypeId: 'svc-1',
    slotStart: SLOT.toISOString(),
    slotEnd: SLOT_END.toISOString(),
  },
}

describe('expire_offer — single authoritative releaser (H1)', () => {
  beforeEach(() => {
    dbQueryIdx = 0
    dbRows.length = 0
    updateSets.length = 0
    callOrder.length = 0
    auditCalls.length = 0
    releaseMock.mockClear()
    releaseMock.mockImplementation(async () => { callOrder.push('release'); return true })
    queueAddMock.mockClear()
  })

  it('releases the hold, flips the row, sends window-passed, cascades — once each, IN ORDER', async () => {
    // Row script:
    // 1. offered entry lookup
    dbRows.push([{ id: 'wl-A', customerId: 'cust-A', businessId: 'biz-1', serviceTypeId: 'svc-1', slotStart: SLOT, status: 'offered' }])
    // 2. buildWaitlistCalendarClient: biz row
    dbRows.push([{ googleRefreshToken: null, googleCalendarId: null }])
    // 3. buildWaitlistCalendarClient: hold-manager
    dbRows.push([{ phoneNumber: '+972599999999' }])
    // (releaseWaitlistHold is mocked — consumes no rows)
    // 4. sendWindowPassedMessage: customer
    dbRows.push([{ phoneNumber: '+972500000001', preferredLanguage: 'en' }])
    // 5. sendWindowPassedMessage: biz
    dbRows.push([{ name: 'Test Salon', defaultLanguage: 'en' }])
    // 6. sendWindowPassedMessage: service
    dbRows.push([{ name: 'Haircut' }])

    await processJob(EXPIRE_JOB)

    // Release ran exactly once, with the offered entry's customer + the slot.
    expect(releaseMock).toHaveBeenCalledTimes(1)
    const releaseArgs = releaseMock.mock.calls[0] as unknown as unknown[]
    // (db, calendar, businessId, customerId, serviceTypeId, slotStart, triggeredBy)
    expect(releaseArgs[2]).toBe('biz-1')
    expect(releaseArgs[3]).toBe('cust-A')

    // Exactly one cascade enqueued.
    const cascadeCount = queueAddMock.mock.calls.filter((c) => (c[1] as { type?: string })?.type === 'offer_slot').length
    expect(cascadeCount).toBe(1)

    // Strict ordering: release BEFORE flip BEFORE message BEFORE cascade.
    expect(callOrder).toEqual(['release', 'flip', 'message', 'cascade'])

    // Row flip to expired + audit present.
    expect(updateSets.some((s) => (s as { status?: string }).status === 'expired')).toBe(true)
    expect(auditCalls.some((a) => a.action === 'waitlist.offer_expired')).toBe(true)
  })

  it('no-op when the entry is no longer offered (idempotent / already moved)', async () => {
    dbRows.push([]) // offered lookup → none
    await processJob(EXPIRE_JOB)
    expect(releaseMock).not.toHaveBeenCalled()
    expect(callOrder).toEqual([])
  })
})
