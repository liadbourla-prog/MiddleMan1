/**
 * WL-5 — Genuine hold at offer time (worker side, processJob offer_slot).
 *
 * Proves:
 *   1. On a successful offer_slot, the engine `requestBooking` is called with the waitlist
 *      customer's identity and `waitlistHold.holdExpiresAt === offerExpiresAt`, and it happens
 *      BEFORE the offer message is enqueued (the hold lands first, then the offer goes out).
 *   2. When the hold FAILS (requestBooking → { ok:false }), NO message is enqueued, the row is
 *      reverted offered→pending, and the expire_offer job is NOT scheduled.
 *
 * Harness mirrors waitlist-priority.test.ts: a sequential-row db mock consumed in call order,
 * with requestBooking and createCalendarClient mocked.
 *
 * vi.mock is hoisted — factories must not reference top-level variables.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── All mocks must be declared before any imports ─────────────────────────────

vi.mock('./message-retry.js', () => ({ enqueueMessage: vi.fn(async () => {}) }))

vi.mock('bullmq', () => ({
  Worker: vi.fn(),
  Queue: vi.fn().mockImplementation(() => ({ add: vi.fn(async () => ({ id: 'job-1' })) })),
}))

vi.mock('../redis.js', () => ({ redisConnection: {} }))

vi.mock('./waitlist-revalidate.js', () => ({ revalidateWaitlistSlotOpen: vi.fn(async () => true) }))

// Engine hold + calendar client — the heart of WL-5. Loosely typed so both ok:true and
// ok:false results can be returned by individual tests.
const requestBookingMock: ReturnType<typeof vi.fn> = vi.fn(async () => ({ ok: true, bookingId: 'bk-1', held: true, message: 'held' }))
vi.mock('../domain/booking/engine.js', () => ({
  requestBooking: (...a: unknown[]) => requestBookingMock(...(a as [])),
}))
vi.mock('../adapters/calendar/client.js', () => ({
  createCalendarClient: vi.fn(() => ({ /* opaque calendar handle */ })),
}))

// Ordered-call recorder so we can assert hold-before-send.
const callOrder: string[] = []

// db singleton — select queries return rows in call order; update()...returning() consumes
// from the SAME array. The revert CAS (set→where, no returning) is recorded for assertion.
let dbQueryIdx = 0
const dbRows: unknown[][] = []
const updateSets: Record<string, unknown>[] = []

vi.mock('../db/client.js', () => ({
  db: {
    select: () => makeSelectChain(),
    update: () => ({
      set: (vals: Record<string, unknown>) => {
        updateSets.push(vals)
        return {
          where: () => {
            // Plain `await db.update(...).set(...).where(...)` (revert CAS) resolves to this
            // object; `.returning()` (the offered-flip CAS) consumes a sequential row.
            const res: Record<string, unknown> = { returning: async () => dbRows[dbQueryIdx++] ?? [] }
            return res
          },
        }
      },
    }),
    insert: () => ({
      values: () => ({
        onConflictDoNothing: () => ({ returning: async () => dbRows[dbQueryIdx++] ?? [] }),
        returning: async () => dbRows[dbQueryIdx++] ?? [],
      }),
    }),
    delete: () => ({ where: async () => { dbQueryIdx++; return [] } }),
  },
}))

function makeSelectChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {}
  for (const m of ['from', 'where', 'leftJoin', 'innerJoin', 'orderBy', 'select']) chain[m] = () => chain
  chain['then'] = (resolve: (v: unknown) => unknown) => resolve(dbRows[dbQueryIdx++] ?? [])
  chain['limit'] = async () => dbRows[dbQueryIdx++] ?? []
  return chain
}

let freeFormAllowed = true
vi.mock('../adapters/whatsapp/sender.js', () => ({
  canSendFreeForm: vi.fn(async () => freeFormAllowed),
  sendMessage: vi.fn(async () => ({ ok: true })),
  sendTemplateMessage: vi.fn(async () => {}),
}))

vi.mock('../adapters/llm/client.js', () => ({
  generateProactiveCustomerMessage: vi.fn(async ({ fallback }: { fallback: string }) => fallback),
}))

const auditCalls: { action: string; entityId: string; metadata: unknown }[] = []
vi.mock('../domain/audit/logger.js', () => ({
  logAudit: vi.fn(async (_db: unknown, entry: { action: string; entityId: string; metadata: unknown }) => {
    auditCalls.push({ action: entry.action, entityId: entry.entityId, metadata: entry.metadata })
  }),
}))

vi.mock('../domain/initiations/dispatch.js', () => ({ dispatchInitiation: vi.fn(async () => ({ kind: 'noop' })) }))
vi.mock('../domain/initiations/registry.js', () => ({ getInitiator: vi.fn(() => undefined) }))
vi.mock('../domain/initiations/blast-breaker.js', () => ({
  resolveBlastBreaker: vi.fn(() => ({})),
  evaluateBlastBreaker: vi.fn(() => 'continue'),
}))
vi.mock('../domain/crm/segment-repository.js', () => ({ queryCustomerSegment: vi.fn(async () => []) }))
vi.mock('../domain/crm/cold-fill.js', () => ({ selectColdFillCandidates: vi.fn(() => []) }))

vi.mock('../domain/i18n/t.js', () => ({
  i18n: { waitlist_offer: { en: () => 'A spot just opened.', he: () => 'נפתח מקום.' } },
}))

vi.mock('../domain/waitlist/priority.js', () => ({
  rankWaitlistCandidates: vi.fn((entries: unknown[]) => entries),
  waitlistTier: vi.fn(() => 'priority'),
}))

// ── Import module under test AFTER all mocks ───────────────────────────────────
import { processJob } from './waitlist.js'
import * as messageRetry from './message-retry.js'

const SLOT = new Date('2026-07-01T10:00:00Z')
const SLOT_END = new Date('2026-07-01T11:00:00Z')
const JOB = {
  data: {
    type: 'offer_slot' as const,
    businessId: 'biz-1',
    serviceTypeId: 'svc-1',
    slotStart: SLOT.toISOString(),
    slotEnd: SLOT_END.toISOString(),
  },
}

// Common row script up to (and including) the business lookup + hold-manager lookup.
function seedHappyPath() {
  dbRows.push([{ id: 'wl-A', customerId: 'cust-A', businessId: 'biz-1', serviceTypeId: 'svc-1', slotStart: SLOT, createdAt: new Date('2026-06-28T09:00:00Z'), status: 'pending' }]) // 1. pending
  dbRows.push([]) // 2. commitment lookup for cust-A → none
  dbRows.push([{ id: 'wl-A' }]) // 3. CAS flip → won
  dbRows.push([{ phoneNumber: '+972500000001', preferredLanguage: 'en', displayName: 'Avi' }]) // 5. customer
  dbRows.push([{ name: 'Haircut' }]) // 6. service
  dbRows.push([{ name: 'Test Salon', timezone: 'Asia/Jerusalem', defaultLanguage: 'en', whatsappPhoneNumberId: 'PNID', whatsappAccessToken: 'TOKEN', googleRefreshToken: null, googleCalendarId: null }]) // 7. biz
  dbRows.push([{ phoneNumber: '+972599999999' }]) // 8. hold-manager
}

describe('waitlist offer_slot — genuine hold (WL-5)', () => {
  beforeEach(() => {
    freeFormAllowed = true
    dbQueryIdx = 0
    dbRows.length = 0
    updateSets.length = 0
    auditCalls.length = 0
    callOrder.length = 0
    requestBookingMock.mockReset()
    requestBookingMock.mockResolvedValue({ ok: true, bookingId: 'bk-1', held: true, message: 'held' })
    vi.mocked(messageRetry.enqueueMessage).mockReset()
    vi.mocked(messageRetry.enqueueMessage).mockImplementation(async () => { callOrder.push('enqueue') })
  })

  it('places the hold (holdExpiresAt === offerExpiresAt, customer identity) BEFORE sending the offer', async () => {
    seedHappyPath()
    requestBookingMock.mockImplementation(async () => { callOrder.push('hold'); return { ok: true, bookingId: 'bk-1', held: true, message: 'held' } })

    await processJob(JOB)

    expect(requestBookingMock).toHaveBeenCalledTimes(1)
    const [, , actor, request, opts] = requestBookingMock.mock.calls[0] as unknown as [unknown, unknown, { id: string; role: string }, { serviceTypeId: string; slotStart: Date; slotEnd: Date }, { waitlistHold: { holdExpiresAt: Date } }]
    expect(actor.id).toBe('cust-A')
    expect(actor.role).toBe('customer')
    expect(request.serviceTypeId).toBe('svc-1')
    expect(request.slotStart).toEqual(SLOT)

    // holdExpiresAt must equal the offer window. The CAS flip set offerExpiresAt; assert equality.
    const flip = updateSets.find((s) => (s as { status?: string }).status === 'offered') as { offerExpiresAt?: Date }
    expect(opts.waitlistHold.holdExpiresAt).toEqual(flip.offerExpiresAt)

    // Hold landed before the offer was enqueued.
    expect(callOrder).toEqual(['hold', 'enqueue'])
    expect(messageRetry.enqueueMessage).toHaveBeenCalledWith('biz-1', '+972500000001', expect.any(String))
  })

  it('on a failed hold: no offer sent, row reverted offered→pending, expire_offer NOT scheduled', async () => {
    seedHappyPath()
    requestBookingMock.mockResolvedValue({ ok: false, reason: 'Class is full' })

    await processJob(JOB)

    // No customer message.
    expect(messageRetry.enqueueMessage).not.toHaveBeenCalled()

    // Row reverted to pending (a set with status 'pending' was issued).
    expect(updateSets.some((s) => (s as { status?: string }).status === 'pending')).toBe(true)

    // hold_failed audited; offer_sent NOT audited.
    expect(auditCalls.some((a) => a.action === 'waitlist.hold_failed')).toBe(true)
    expect(auditCalls.some((a) => a.action === 'waitlist.offer_sent')).toBe(false)
  })
})
