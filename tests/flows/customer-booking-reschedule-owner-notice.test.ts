import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'

// ── A reschedule must surface as exactly ONE owner notice ─────────────────────
// A customer RESCHEDULE is a single owner-facing 'moved' notice ("moved from X to Y") — not a
// "new booking" notice and not a cancel+move pair. Two defects this guards against:
//   1) Appointment confirm path called confirmBooking, which fired notifyOwnerNewBooking, on top
//      of the 'moved' notice from releaseSupersededBooking → owner double-notified.
//   2) Group-class direct-confirm path reached releaseSupersededBooking WITHOUT the new booking id
//      (it lives in result.bookingId, not ctx.pendingBookingId) → the 'moved' notice never fired,
//      yet requestBooking had already sent a "new booking" notice.
//
// We mock the engine + session + LLM + the owner-notify emitters so this is a pure control-flow
// assertion: the flow must (a) pass suppressOwnerNewBookingNotice on the reschedule path, and
// (b) fire exactly one notifyOwnerBookingChange({ kind: 'moved' }).

const cancelBooking = vi.fn(async () => ({ ok: true as const }))
const confirmBooking = vi.fn(async () => ({ ok: true as const, bookingId: 'booking-new', message: 'ok' }))
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

// The two owner-facing emitters. notifyOwnerNewBooking lives inside the (mocked) engine and so
// cannot fire here regardless — but we still mock it to prove it is never reached directly.
const notifyOwnerBookingChange = vi.fn(async () => {})
const notifyOwnerNewBooking = vi.fn(async () => {})

vi.mock('../../src/domain/initiations/booking-notify.js', () => ({
  notifyOwnerBookingChange: (...a: unknown[]) => notifyOwnerBookingChange(...(a as [])),
  notifyOwnerNewBooking: (...a: unknown[]) => notifyOwnerNewBooking(...(a as [])),
}))

import { handleBookingFlow } from '../../src/domain/flows/customer-booking.js'
import { bookings, serviceTypes } from '../../src/db/schema.js'
import type { ResolvedIdentity } from '../../src/domain/identity/types.js'
import type { ActiveSession } from '../../src/domain/session/types.js'

const EXISTING_BOOKING_ID = 'booking-old-1000'

// Table-aware Drizzle stub. Every select against `bookings` resolves to the single registered row
// (carrying a slotStart), so releaseSupersededBooking's two probes — old slot then new slot — both
// resolve non-null and the 'moved' guard is satisfied.
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
  notifyOwnerBookingChange.mockClear()
  notifyOwnerNewBooking.mockClear()
})

describe('appointment reschedule emits a single owner moved notice', () => {
  it('suppresses the new-booking notice and fires exactly one moved notice', async () => {
    // A confirmed reschedule replacement was held (pendingBookingId) and the origin tracked
    // (rescheduledFrom). The customer says "yes" → final confirm.
    const rows = new Map<unknown, unknown[]>([
      [bookings, [{ id: EXISTING_BOOKING_ID, slotStart: new Date('2026-06-23T07:00:00Z'), serviceTypeId: 'svc-1' }]],
      [serviceTypes, [{ id: 'svc-1', name: 'Physio session', durationMinutes: 60, maxParticipants: 1, category: null }]],
    ])

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
      fakeDb(rows) as never, {} as never, identity, session,
      'yes', 'Asia/Jerusalem', 'Physio Studio', [],
      undefined, undefined, 'he', undefined, false,
    )

    // (a) Flow asked the engine to suppress the new-booking owner notice on the reschedule path.
    expect(confirmBooking).toHaveBeenCalledTimes(1)
    const confirmArgs = confirmBooking.mock.calls[0] as unknown[]
    const confirmOpts = confirmArgs[5] as { suppressOwnerNewBookingNotice?: boolean } | undefined
    expect(confirmOpts?.suppressOwnerNewBookingNotice).toBe(true)

    // (b) Exactly one owner notice, and it is a 'moved'.
    expect(notifyOwnerBookingChange).toHaveBeenCalledTimes(1)
    const changeArg = notifyOwnerBookingChange.mock.calls[0]?.[2] as { kind?: string } | undefined
    expect(changeArg?.kind).toBe('moved')

    // (c) The new-booking emitter is never reached directly from the flow.
    expect(notifyOwnerNewBooking).not.toHaveBeenCalled()
  })
})

describe('group-class reschedule emits a single owner moved notice (Defect 2)', () => {
  it('passes the suppress flag and fires moved with the new (result.bookingId) booking', async () => {
    // Group-class direct-confirm: requestBooking returns directlyConfirmed with the new booking id.
    // ctx.pendingBookingId is unset on this path (the engine confirmed in one step), so the flow
    // must pass result.bookingId to releaseSupersededBooking for the 'moved' notice to fire.
    const GROUP_BOOKING_ID = 'group-booking-new'
    requestBooking.mockResolvedValueOnce({
      ok: true as const,
      bookingId: GROUP_BOOKING_ID,
      message: '4 spots remaining.',
      directlyConfirmed: true,
    } as never)

    const rows = new Map<unknown, unknown[]>([
      [bookings, [{ id: EXISTING_BOOKING_ID, slotStart: new Date('2026-06-23T07:00:00Z'), serviceTypeId: 'svc-1' }]],
      [serviceTypes, [{ id: 'svc-1', name: 'Yoga class', durationMinutes: 60, maxParticipants: 8, category: null }]],
    ])

    // Hold-confirmation state with NO pendingBookingId: group classes confirm directly (no held
    // booking), so the customer's "yes" falls through to requestBooking → directlyConfirmed. This
    // is exactly the group-class reschedule sub-path where Defect 2 lived.
    const session: ActiveSession = {
      id: 'sess-1', businessId: 'biz-1', identityId: 'cust-1',
      intent: 'unknown', state: 'waiting_confirmation',
      context: {
        awaitingConfirmationFor: 'hold',
        rescheduledFrom: EXISTING_BOOKING_ID,
        pendingSlot: {
          start: '2026-06-23T14:00:00.000Z',
          end: '2026-06-23T15:00:00.000Z',
          serviceTypeId: 'svc-1',
          serviceName: 'Yoga class',
        },
        detectedLanguage: 'he',
      },
      expiresAt: new Date(Date.now() + 3_600_000),
    }

    await handleBookingFlow(
      fakeDb(rows) as never, {} as never, identity, session,
      'yes', 'Asia/Jerusalem', 'Yoga Studio', [],
      undefined, undefined, 'he', undefined, false,
    )

    // (a) Flow asked the engine to suppress the new-booking owner notice on the reschedule path.
    expect(requestBooking).toHaveBeenCalledTimes(1)
    const reqArgs = requestBooking.mock.calls[0] as unknown[]
    const reqOpts = reqArgs[4] as { suppressOwnerNewBookingNotice?: boolean } | undefined
    expect(reqOpts?.suppressOwnerNewBookingNotice).toBe(true)

    // (b) Exactly one owner notice — a 'moved' — keyed on the NEW (group) booking id, proving the
    // result.bookingId override reached releaseSupersededBooking (Defect 2 fix).
    expect(notifyOwnerBookingChange).toHaveBeenCalledTimes(1)
    const changeArg = notifyOwnerBookingChange.mock.calls[0]?.[2] as { kind?: string; bookingId?: string } | undefined
    expect(changeArg?.kind).toBe('moved')
    expect(changeArg?.bookingId).toBe(GROUP_BOOKING_ID)

    // (c) The new-booking emitter is never reached directly from the flow.
    expect(notifyOwnerNewBooking).not.toHaveBeenCalled()
  })
})
