import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Db } from '../../db/client.js'

// Record every enqueueMessage call (the WhatsApp send the emitter ultimately fires).
const enqueued: Array<{ toNumber: string; body: string }> = []
vi.mock('../../workers/message-retry.js', () => ({
  enqueueMessage: vi.fn(async (toNumber: string, body: string) => {
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

import { notifyOwnerUnlistedContact } from './booking-notify.js'

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
