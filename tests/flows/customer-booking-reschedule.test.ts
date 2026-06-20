import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'

// ── Deferred-cancel reschedule regression ─────────────────────────────────────
// The reschedule flow used to cancel the customer's existing booking *first*, then
// try to book the new slot. In a fully-booked week, asking to move onto an
// already-taken slot left the customer with nothing: original released, replacement
// refused. The fix carries `rescheduledFrom` through the flow and releases the old
// slot only once the new booking is actually confirmed.
//
// We mock the engine + session + LLM seams so this is a pure control-flow assertion.

const cancelBooking = vi.fn(async () => ({ ok: true as const }))
const confirmBooking = vi.fn(async () => ({ ok: true as const }))
const requestBooking = vi.fn(async () => ({ ok: false as const, reason: 'Slot is not available' }))

vi.mock('../../src/domain/booking/engine.js', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>()
  return {
    ...actual,
    cancelBooking: (...a: unknown[]) => cancelBooking(...(a as [])),
    confirmBooking: (...a: unknown[]) => confirmBooking(...(a as [])),
    requestBooking: (...a: unknown[]) => requestBooking(...(a as [])),
  }
})

const updateSessionContext = vi.fn(async () => {})
const completeSession = vi.fn(async () => {})
const failSession = vi.fn(async () => {})

vi.mock('../../src/domain/session/manager.js', () => ({
  updateSessionContext: (...a: unknown[]) => updateSessionContext(...(a as [])),
  completeSession: (...a: unknown[]) => completeSession(...(a as [])),
  failSession: (...a: unknown[]) => failSession(...(a as [])),
}))

const extractCustomerIntent = vi.fn()
const generateCustomerReply = vi.fn(async () => 'a human reply')

vi.mock('../../src/adapters/llm/client.js', () => ({
  extractCustomerIntent: (...a: unknown[]) => extractCustomerIntent(...(a as [])),
  generateCustomerReply: (...a: unknown[]) => generateCustomerReply(...(a as [])),
}))

import { handleBookingFlow } from '../../src/domain/flows/customer-booking.js'
import { bookings, serviceTypes } from '../../src/db/schema.js'
import type { ResolvedIdentity } from '../../src/domain/identity/types.js'
import type { ActiveSession } from '../../src/domain/session/types.js'

const EXISTING_BOOKING_ID = 'booking-tue-1000'

// Table-aware Drizzle stub: resolves each query to the rows registered for the
// table named in `.from(...)`. Enough to drive the reschedule branch.
function fakeDb(rowsByTable: Map<unknown, unknown[]>): unknown {
  function makeChain() {
    let table: unknown
    const chain: Record<string, unknown> = {}
    for (const m of ['from', 'where', 'orderBy', 'limit', 'innerJoin', 'leftJoin']) {
      chain[m] = (arg: unknown) => {
        if (m === 'from') table = arg
        return chain
      }
    }
    ;(chain as { then: unknown }).then = (res: (v: unknown[]) => unknown) =>
      Promise.resolve(rowsByTable.get(table) ?? []).then(res)
    return chain
  }
  return {
    select: () => makeChain(),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  }
}

const identity: ResolvedIdentity = {
  id: 'cust-1',
  businessId: 'biz-1',
  phoneNumber: '+972500000000',
  role: 'customer',
  displayName: null,
  messagingOptOut: false,
  preferredLanguage: null,
  conversationPausedUntil: null,
}

beforeEach(() => {
  cancelBooking.mockClear()
  confirmBooking.mockClear()
  requestBooking.mockClear()
  updateSessionContext.mockClear()
  completeSession.mockClear()
  ;(extractCustomerIntent as Mock).mockReset()
  generateCustomerReply.mockClear()
})

describe('reschedule never strands the existing booking', () => {
  it('does NOT cancel the current booking when a reschedule is merely requested', async () => {
    // Customer has one confirmed booking and asks to move it.
    const rows = new Map<unknown, unknown[]>([
      [bookings, [{ id: EXISTING_BOOKING_ID, slotStart: new Date('2026-06-23T07:00:00Z'), serviceTypeId: 'svc-1' }]],
      [serviceTypes, [{ id: 'svc-1', name: 'Physio session', durationMinutes: 60, maxParticipants: 1, category: null }]],
    ])
    ;(extractCustomerIntent as Mock).mockResolvedValue({
      ok: true,
      data: {
        intent: 'rescheduling',
        slotRequest: null,
        serviceTypeHint: null,
        providerHint: null,
        participantsHint: null,
        summary: null,
        rawEntities: {},
        detectedLanguage: 'he',
      },
    })

    const session: ActiveSession = {
      id: 'sess-1', businessId: 'biz-1', identityId: 'cust-1',
      intent: 'unknown', state: 'active', context: {},
      expiresAt: new Date(Date.now() + 3_600_000),
    }

    await handleBookingFlow(
      fakeDb(rows) as never, {} as never, identity, session,
      'move me to Tuesday 17:00', 'Asia/Jerusalem', 'Physio Studio', [],
      undefined, undefined, 'he', undefined, false,
    )

    // The invariant: the original booking survives the request. It is released only
    // after the replacement is confirmed (see the second test).
    expect(cancelBooking).not.toHaveBeenCalled()
  })

  it('releases the superseded booking only after the new slot is confirmed', async () => {
    // Second turn: the new slot was held (pendingBookingId) and the reschedule
    // origin is tracked (rescheduledFrom). Customer says "yes".
    const session: ActiveSession = {
      id: 'sess-1', businessId: 'biz-1', identityId: 'cust-1',
      intent: 'unknown', state: 'waiting_confirmation',
      context: {
        awaitingConfirmationFor: 'hold',
        pendingBookingId: 'booking-tue-1700-new',
        rescheduledFrom: EXISTING_BOOKING_ID,
        pendingSlot: {
          start: '2026-06-23T14:00:00.000Z',
          end: '2026-06-23T15:00:00.000Z',
          serviceTypeId: 'svc-1',
          serviceName: 'Physio session',
        },
        detectedLanguage: 'he',
      },
      expiresAt: new Date(Date.now() + 3_600_000),
    }

    await handleBookingFlow(
      fakeDb(new Map()) as never, {} as never, identity, session,
      'yes', 'Asia/Jerusalem', 'Physio Studio', [],
      undefined, undefined, 'he', undefined, false,
    )

    expect(confirmBooking).toHaveBeenCalled()
    expect(cancelBooking).toHaveBeenCalledTimes(1)
    // The booking that was released is exactly the one being replaced.
    const args = cancelBooking.mock.calls[0] as unknown[]
    expect(args).toContain(EXISTING_BOOKING_ID)
  })
})

// ── G2: the multi-booking reschedule path is the sibling of the single-booking bug.
// A customer with 2+ bookings who picks one to move must NOT have it cancelled before
// the replacement is secured.
describe('multi-booking reschedule defers the cancel too (G2)', () => {
  it('confirming WHICH booking to move does not cancel it', async () => {
    // State: customer picked a booking to move (cancellation_selection → confirmation),
    // flagged as a reschedule. They now confirm the selection.
    const session: ActiveSession = {
      id: 'sess-1', businessId: 'biz-1', identityId: 'cust-1',
      intent: 'unknown', state: 'waiting_confirmation',
      context: {
        awaitingConfirmationFor: 'cancellation',
        isReschedulingFlow: true,
        targetBookingId: EXISTING_BOOKING_ID,
        detectedLanguage: 'he',
      },
      expiresAt: new Date(Date.now() + 3_600_000),
    }

    const result = await handleBookingFlow(
      fakeDb(new Map()) as never, {} as never, identity, session,
      'yes', 'Asia/Jerusalem', 'Physio Studio', [],
      undefined, undefined, 'he', undefined, false,
    )

    // Deferred: the picked booking survives; we move on to ask for the new time.
    expect(cancelBooking).not.toHaveBeenCalled()
    expect(result.sessionComplete).toBe(false)
    // Session is carried forward with the booking tracked as the reschedule origin.
    const lastCtx = updateSessionContext.mock.calls.at(-1)?.[2] as { rescheduledFrom?: string } | undefined
    expect(lastCtx?.rescheduledFrom).toBe(EXISTING_BOOKING_ID)
  })

  it('a follow-up reschedule turn does not bounce back into booking selection', async () => {
    // Reschedule already in progress (origin designated, not yet released), customer
    // still has two active bookings. Their next message names a new time.
    const rows = new Map<unknown, unknown[]>([
      [bookings, [
        { id: EXISTING_BOOKING_ID, slotStart: new Date('2026-06-23T07:00:00Z'), serviceTypeId: 'svc-1' },
        { id: 'booking-other', slotStart: new Date('2026-06-25T07:00:00Z'), serviceTypeId: 'svc-1' },
      ]],
      [serviceTypes, [{ id: 'svc-1', name: 'Physio session', durationMinutes: 60, maxParticipants: 1, category: null }]],
    ])
    ;(extractCustomerIntent as Mock).mockResolvedValue({
      ok: true,
      data: {
        intent: 'rescheduling', slotRequest: null, serviceTypeHint: null, providerHint: null,
        participantsHint: null, summary: null, rawEntities: {}, detectedLanguage: 'he',
      },
    })

    const session: ActiveSession = {
      id: 'sess-1', businessId: 'biz-1', identityId: 'cust-1',
      intent: 'unknown', state: 'active',
      context: { rescheduledFrom: EXISTING_BOOKING_ID, detectedLanguage: 'he' },
      expiresAt: new Date(Date.now() + 3_600_000),
    }

    await handleBookingFlow(
      fakeDb(rows) as never, {} as never, identity, session,
      'move it to Tuesday 17:00', 'Asia/Jerusalem', 'Physio Studio', [],
      undefined, undefined, 'he', undefined, false,
    )

    // Routed to the booking path, not the reschedule selection re-prompt.
    expect(cancelBooking).not.toHaveBeenCalled()
    const reEnteredSelection = updateSessionContext.mock.calls.some(
      (c) => (c[2] as { awaitingConfirmationFor?: string } | undefined)?.awaitingConfirmationFor === 'cancellation_selection',
    )
    expect(reEnteredSelection).toBe(false)
  })
})
