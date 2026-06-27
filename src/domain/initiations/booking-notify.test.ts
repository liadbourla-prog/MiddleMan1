import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Db } from '../../db/client.js'

// Record every enqueueMessage call (the WhatsApp send the emitter ultimately fires).
const enqueued: Array<{ toNumber: string; body: string }> = []
vi.mock('../../workers/message-retry.js', () => ({
  enqueueMessage: vi.fn(async (_businessId: string, toNumber: string, body: string) => {
    enqueued.push({ toNumber, body })
  }),
}))

// dispatchInitiation pulls in the full initiation spine (gate, ledger insert, audit log) that
// the fakeDb harness below does not back. For this emitter the spine adds nothing observable —
// it just invokes sendFreeForm for this owner/window-skip initiator — so stub it to call through.
vi.mock('./dispatch.js', () => ({
  dispatchInitiation: vi.fn(async (_db, _initiator, _ctx, exec: { sendFreeForm: () => Promise<void> }) => {
    await exec.sendFreeForm()
    return { kind: 'send_free_form' }
  }),
}))

// Capture digest routing so we can assert it fires for a 'digest' rule and not otherwise.
const digested: Array<{ businessId: string; event: string; summary: string }> = []
vi.mock('./digest-queue.js', () => ({
  enqueueDigest: vi.fn(async (_db, businessId: string, event: string, payload: { summary: string }) => {
    digested.push({ businessId, event, summary: payload.summary })
  }),
}))

import { notifyOwnerUnlistedContact, notifyOwnerBookingChange } from './booking-notify.js'

// Each terminal `.limit()` resolves the next queued result-set, in call order
// (same shape as src/domain/identity/customer-resolver.test.ts).
function fakeDb(results: unknown[][]): Db {
  let i = 0
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'from', 'where', 'leftJoin', 'innerJoin', 'orderBy']) {
    chain[m] = () => chain
  }
  chain['limit'] = () => Promise.resolve(results[i++] ?? [])
  return { select: () => chain } as unknown as Db
}

describe('notifyOwnerUnlistedContact', () => {
  beforeEach(() => {
    enqueued.length = 0
  })

  it('messages the manager once with the unlisted number tail', async () => {
    // Query 1: business (defaultLanguage). Query 2: manager identity.
    const db = fakeDb([
      [{ defaultLanguage: 'en' }],
      [{ id: 'mgr1', phoneNumber: '+972500000001' }],
    ])

    await notifyOwnerUnlistedContact(db, 'biz1', {
      fromNumber: '+972509998877',
      messageText: 'hi can I book?',
    })

    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]!.toNumber).toBe('+972500000001')
    expect(enqueued[0]!.body).toContain('8877')
  })

  it('does nothing when the business is missing', async () => {
    const db = fakeDb([[]])
    await notifyOwnerUnlistedContact(db, 'missing', { fromNumber: '+972509998877', messageText: 'hi' })
    expect(enqueued).toHaveLength(0)
  })

  it('does nothing when no manager exists', async () => {
    const db = fakeDb([[{ defaultLanguage: 'he' }], []])
    await notifyOwnerUnlistedContact(db, 'biz1', { fromNumber: '+972509998877', messageText: 'hi' })
    expect(enqueued).toHaveLength(0)
  })
})

describe('notifyOwnerBookingChange', () => {
  beforeEach(() => {
    enqueued.length = 0
    digested.length = 0
  })

  it('notifies the manager once for a customer-originated cancellation (default rule)', async () => {
    // Select order for a non-manager change: biz, manager, customer, service.
    const db = fakeDb([
      [{ timezone: 'Asia/Jerusalem', defaultLanguage: 'en', notificationRules: null, notificationPreferences: null }],
      [{ id: 'mgr1', phoneNumber: '+972500000001' }],
      [{ displayName: 'Dana', phone: '+972509998877' }],
      [{ name: 'Haircut' }],
    ])

    await notifyOwnerBookingChange(db, 'biz1', {
      kind: 'cancelled',
      origin: 'customer',
      actorIsManager: false,
      bookingId: 'bk1',
      customerId: 'cust1',
      serviceTypeId: 'svc1',
      slotStart: new Date('2026-07-01T10:00:00Z'),
    })

    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]!.toNumber).toBe('+972500000001')
    expect(enqueued[0]!.body).toContain('Dana')
    expect(enqueued[0]!.body).toContain('Haircut')
    expect(digested).toHaveLength(0)
  })

  it('suppresses the notification when the manager is the actor (no selects run)', async () => {
    const db = fakeDb([]) // emitter returns before any select
    await notifyOwnerBookingChange(db, 'biz1', {
      kind: 'cancelled',
      origin: 'pa',
      actorIsManager: true,
      bookingId: 'bk1',
      customerId: 'cust1',
      serviceTypeId: 'svc1',
      slotStart: new Date('2026-07-01T10:00:00Z'),
    })
    expect(enqueued).toHaveLength(0)
    expect(digested).toHaveLength(0)
  })

  it('routes to the digest queue when the cancellation rule is set to digest', async () => {
    // The emitter resolves the action AND builds the full body (running the business, manager,
    // customer and service selects) before diverting to enqueueDigest — so all four rows are still
    // queued here; the divert only changes the delivery (buffer vs live send), not the work before it.
    const db = fakeDb([
      [{
        timezone: 'Asia/Jerusalem',
        defaultLanguage: 'en',
        notificationRules: [{ event: 'cancellation', action: 'digest' }],
        notificationPreferences: null,
      }],
      [{ id: 'mgr1', phoneNumber: '+972500000001' }],
      [{ displayName: 'Dana', phone: '+972509998877' }],
      [{ name: 'Haircut' }],
    ])

    await notifyOwnerBookingChange(db, 'biz1', {
      kind: 'cancelled',
      origin: 'customer',
      actorIsManager: false,
      bookingId: 'bk1',
      customerId: 'cust1',
      serviceTypeId: 'svc1',
      slotStart: new Date('2026-07-01T10:00:00Z'),
    })

    expect(enqueued).toHaveLength(0)
    expect(digested).toHaveLength(1)
    expect(digested[0]!.event).toBe('cancellation')
    expect(digested[0]!.summary).toContain('Dana')
  })
})
