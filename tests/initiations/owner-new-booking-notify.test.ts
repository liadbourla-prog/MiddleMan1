// INV-3 proactive (2026-06-25 design §4.1.4): a CUSTOMER self-booking is reflected to the OWNER.
// We assert the two decision points of notifyOwnerNewBooking — the notification-rules gate and
// that the message targets the manager — by capturing the spine dispatch. The spine internals
// (governance, dedup, window) are exercised by their own tests.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { dispatchSpy, enqueueSpy } = vi.hoisted(() => ({
  dispatchSpy: vi.fn(async (_db: unknown, _initiator: unknown, _ctx: { recipientId?: string }, exec: { sendFreeForm?: () => Promise<void> }) => {
    // Run the executor so we can observe the message body via the enqueue mock.
    if (exec.sendFreeForm) await exec.sendFreeForm()
  }),
  enqueueSpy: vi.fn(async (_businessId: string, _phone: string, _body: string) => {}),
}))

vi.mock('../../src/domain/initiations/dispatch.js', () => ({ dispatchInitiation: dispatchSpy }))
vi.mock('../../src/workers/message-retry.js', () => ({
  enqueueMessage: enqueueSpy,
  messageRetryQueue: { add: async () => {} },
  startMessageRetryWorker: () => {},
}))

import { notifyOwnerNewBooking } from '../../src/domain/initiations/booking-notify.js'
import type { Db } from '../../src/db/client.js'
import { businesses, identities, serviceTypes } from '../../src/db/schema.js'

const MANAGER_PHONE = '+972540000000'
const SLOT = new Date('2026-07-05T14:00:00Z') // Sun 17:00 Asia/Jerusalem

// Table-keyed fake DB: each select() resolves the next queued row-set for that table.
function makeDb(rules: unknown = null) {
  const q = new Map<unknown, unknown[][]>()
  const push = (t: unknown, rows: unknown[]) => { if (!q.has(t)) q.set(t, []); q.get(t)!.push(rows) }
  push(businesses, [{ name: 'Studio', timezone: 'Asia/Jerusalem', defaultLanguage: 'en', notificationRules: rules, notificationPreferences: null }])
  push(identities, [{ id: 'mgr-1', phoneNumber: MANAGER_PHONE }])      // manager lookup
  push(identities, [{ displayName: 'Yoni', phone: '+972526977775' }])  // customer lookup
  push(serviceTypes, [{ name: 'Pilates' }])
  const db = {
    select: () => ({
      from: (t: unknown) => {
        const next = () => q.get(t)?.shift() ?? []
        const chain: Record<string, unknown> = {
          where: () => chain, limit: async () => next(),
          then: (r: (v: unknown) => unknown) => r(next()),
        }
        return chain
      },
    }),
  }
  return db as unknown as Db
}

beforeEach(() => { dispatchSpy.mockClear(); enqueueSpy.mockClear() })

describe('notifyOwnerNewBooking — owner reflection of a customer self-booking', () => {
  const booking = { bookingId: 'bk-1', customerId: 'c1', serviceTypeId: 'svc-1', slotStart: SLOT }

  it('default (no rules) → notifies the OWNER with the customer name + service', async () => {
    await notifyOwnerNewBooking(makeDb(null), 'biz-1', booking)
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    expect(dispatchSpy.mock.calls[0]![2].recipientId).toBe('mgr-1')
    expect(enqueueSpy).toHaveBeenCalledTimes(1)
    const [_bizId, phone, body] = enqueueSpy.mock.calls[0]!
    expect(phone).toBe(MANAGER_PHONE)
    expect(body).toContain('Yoni')
    expect(body).toContain('Pilates')
  })

  it('owner muted new_booking (rule handle_silently) → NO notification fires', async () => {
    const rules = [{ event: 'new_booking', action: 'handle_silently' }]
    await notifyOwnerNewBooking(makeDb(rules), 'biz-1', booking)
    expect(dispatchSpy).not.toHaveBeenCalled()
    expect(enqueueSpy).not.toHaveBeenCalled()
  })
})
