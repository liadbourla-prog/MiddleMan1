/**
 * WL-AX — Accept / Decline domain (Path C, plan §3.3).
 *
 * Proves:
 *   - getLiveWaitlistOffer returns an `offered` row with future offerExpiresAt; null otherwise.
 *   - acceptWaitlistOffer (happy path): finds the held booking → confirmBooking → flips the
 *     waitlist row offered→accepted → audits waitlist.accepted → returns { accepted, bookingId }.
 *   - acceptWaitlistOffer (lost race): confirmBooking returns ok:false → { just_went }, row NOT
 *     flipped to accepted.
 *   - declineWaitlistOffer: releases the held booking (CAS held→expired) BEFORE flipping the row
 *     and BEFORE the cascade; triggerWaitlistForSlot invoked exactly once; audits present.
 *
 * Harness: a sequential-row db mock consumed in call order (mirrors waitlist-hold.test.ts), with
 * confirmBooking, triggerWaitlistForSlot, and logAudit mocked. update()…returning() and plain
 * update()…where() both record their `set(...)` payload so CAS flips are assertable. A shared
 * callOrder array records the relative order of release / row-flip / cascade.
 *
 * vi.mock is hoisted — factories must not reference top-level variables.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Sequential db mock ────────────────────────────────────────────────────────
let dbQueryIdx = 0
const dbRows: unknown[][] = []
const updateSets: Record<string, unknown>[] = []
const callOrder: string[] = []

vi.mock('../../db/client.js', () => ({
  db: {
    select: () => makeSelectChain(),
    update: () => ({
      set: (vals: Record<string, unknown>) => {
        updateSets.push(vals)
        // A held→expired / offered→expired / offered→accepted CAS records its order tag.
        if ((vals as { state?: string }).state === 'expired') callOrder.push('release')
        else if ((vals as { status?: string }).status === 'accepted') callOrder.push('flip-accepted')
        else if ((vals as { status?: string }).status === 'expired') callOrder.push('flip-expired')
        return {
          where: () => ({
            returning: async () => dbRows[dbQueryIdx++] ?? [],
            // Allow plain `await update().set().where()` (no .returning()) to resolve.
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

const confirmBookingMock: ReturnType<typeof vi.fn> = vi.fn(async () => ({ ok: true, bookingId: 'bk-held', message: 'confirmed' }))
vi.mock('../booking/engine.js', () => ({
  confirmBooking: (...a: unknown[]) => {
    callOrder.push('confirm')
    return confirmBookingMock(...(a as []))
  },
}))

const triggerMock: ReturnType<typeof vi.fn> = vi.fn(async () => {})
vi.mock('../../workers/waitlist.js', () => ({
  triggerWaitlistForSlot: (...a: unknown[]) => {
    callOrder.push('cascade')
    return triggerMock(...(a as []))
  },
}))

const auditCalls: { action: string }[] = []
vi.mock('../audit/logger.js', () => ({
  logAudit: vi.fn(async (_db: unknown, entry: { action: string }) => {
    auditCalls.push({ action: entry.action })
  }),
}))

vi.mock('../../adapters/calendar/client.js', () => ({
  createCalendarClient: vi.fn(() => ({ deleteEvent: vi.fn(async () => ({ status: 'ok' })) })),
}))

// ── Import after mocks ──────────────────────────────────────────────────────────
import { getLiveWaitlistOffer, acceptWaitlistOffer, declineWaitlistOffer } from './accept.js'
import { db } from '../../db/client.js'
import type { ResolvedIdentity } from '../identity/types.js'
import type { CalendarClient } from '../../adapters/calendar/client.js'

const SLOT = new Date('2026-07-01T10:00:00Z')
const SLOT_END = new Date('2026-07-01T11:00:00Z')

const ACTOR: ResolvedIdentity = {
  id: 'cust-A',
  businessId: 'biz-1',
  phoneNumber: '+972500000001',
  role: 'customer',
  displayName: 'Avi',
  messagingOptOut: false,
  preferredLanguage: 'en',
  conversationPausedUntil: null,
}

const OFFER = { id: 'wl-A', serviceTypeId: 'svc-1', slotStart: SLOT, slotEnd: SLOT_END }
const DECLINE_OFFER = { id: 'wl-A', businessId: 'biz-1', customerId: 'cust-A', serviceTypeId: 'svc-1', slotStart: SLOT, slotEnd: SLOT_END }

const fakeCalendar = {} as unknown as CalendarClient

beforeEach(() => {
  dbQueryIdx = 0
  dbRows.length = 0
  updateSets.length = 0
  callOrder.length = 0
  auditCalls.length = 0
  confirmBookingMock.mockReset()
  confirmBookingMock.mockResolvedValue({ ok: true, bookingId: 'bk-held', message: 'confirmed' })
  triggerMock.mockReset()
  triggerMock.mockResolvedValue(undefined)
})

describe('getLiveWaitlistOffer', () => {
  it('returns the offered row whose offerExpiresAt is in the future', async () => {
    dbRows.push([{ id: 'wl-A', serviceTypeId: 'svc-1', slotStart: SLOT, slotEnd: SLOT_END }])
    const live = await getLiveWaitlistOffer(db, 'biz-1', 'cust-A')
    expect(live).toEqual({ id: 'wl-A', serviceTypeId: 'svc-1', slotStart: SLOT, slotEnd: SLOT_END })
  })

  it('returns null when there is no live offer', async () => {
    dbRows.push([])
    const live = await getLiveWaitlistOffer(db, 'biz-1', 'cust-A')
    expect(live).toBeNull()
  })
})

describe('acceptWaitlistOffer', () => {
  it('happy path: confirms the held booking, flips row → accepted, audits, returns accepted', async () => {
    dbRows.push([{ id: 'bk-held' }]) // 1. find held booking
    dbRows.push([{ id: 'wl-A' }])    // 2. CAS flip offered→accepted (1 row)

    const out = await acceptWaitlistOffer(db, fakeCalendar, ACTOR, 'Avi', OFFER)

    expect(confirmBookingMock).toHaveBeenCalledTimes(1)
    const [, , actor, bookingId] = confirmBookingMock.mock.calls[0] as unknown as [unknown, unknown, { id: string }, string]
    expect(actor.id).toBe('cust-A')
    expect(bookingId).toBe('bk-held')
    expect(out).toEqual({ kind: 'accepted', bookingId: 'bk-held' })
    expect(updateSets.some((s) => (s as { status?: string }).status === 'accepted')).toBe(true)
    expect(auditCalls.some((a) => a.action === 'waitlist.accepted')).toBe(true)
  })

  it('no held booking found → just_went, no confirm, no accept flip', async () => {
    dbRows.push([]) // 1. find held booking → none

    const out = await acceptWaitlistOffer(db, fakeCalendar, ACTOR, 'Avi', OFFER)

    expect(confirmBookingMock).not.toHaveBeenCalled()
    expect(out).toEqual({ kind: 'just_went' })
    expect(updateSets.some((s) => (s as { status?: string }).status === 'accepted')).toBe(false)
  })

  it('two accepts, one seat: confirmBooking ok:false (CAS lost) → just_went, row NOT flipped', async () => {
    dbRows.push([{ id: 'bk-held' }]) // 1. find held booking
    confirmBookingMock.mockResolvedValue({ ok: false, reason: 'Hold has expired — please start a new booking' })

    const out = await acceptWaitlistOffer(db, fakeCalendar, ACTOR, 'Avi', OFFER)

    expect(out).toEqual({ kind: 'just_went' })
    expect(updateSets.some((s) => (s as { status?: string }).status === 'accepted')).toBe(false)
    expect(auditCalls.some((a) => a.action === 'waitlist.accepted')).toBe(false)
  })

  it('still returns accepted if the row flip races to 0 rows (seat already confirmed)', async () => {
    dbRows.push([{ id: 'bk-held' }]) // 1. find held booking
    dbRows.push([])                  // 2. CAS flip offered→accepted → 0 rows (concurrent expire moved it)

    const out = await acceptWaitlistOffer(db, fakeCalendar, ACTOR, 'Avi', OFFER)

    // The booking is validly confirmed — the seat is theirs regardless of the row flip.
    expect(out).toEqual({ kind: 'accepted', bookingId: 'bk-held' })
  })
})

describe('declineWaitlistOffer', () => {
  it('releases the held booking BEFORE flipping the row and BEFORE cascade; cascades exactly once', async () => {
    dbRows.push([{ id: 'bk-held', calendarEventId: null }]) // 1. find held booking
    dbRows.push([{ id: 'bk-held' }])                        // 2. CAS held→expired (1 row)
    dbRows.push([{ id: 'wl-A' }])                           // 3. CAS offered→expired (1 row)

    await declineWaitlistOffer(db, fakeCalendar, DECLINE_OFFER)

    // Release precedes flip precedes cascade.
    const releaseIdx = callOrder.indexOf('release')
    const flipIdx = callOrder.indexOf('flip-expired')
    const cascadeIdx = callOrder.indexOf('cascade')
    expect(releaseIdx).toBeGreaterThanOrEqual(0)
    expect(releaseIdx).toBeLessThan(flipIdx)
    expect(flipIdx).toBeLessThan(cascadeIdx)

    expect(triggerMock).toHaveBeenCalledTimes(1)
    expect(auditCalls.some((a) => a.action === 'booking.expired')).toBe(true)
    expect(auditCalls.some((a) => a.action === 'waitlist.declined')).toBe(true)
  })

  it('cascades even when no held booking is found (decline still releases the offer)', async () => {
    dbRows.push([])                  // 1. find held booking → none
    dbRows.push([{ id: 'wl-A' }])    // 2. CAS offered→expired

    await declineWaitlistOffer(db, fakeCalendar, DECLINE_OFFER)

    expect(triggerMock).toHaveBeenCalledTimes(1)
    expect(auditCalls.some((a) => a.action === 'waitlist.declined')).toBe(true)
  })
})
