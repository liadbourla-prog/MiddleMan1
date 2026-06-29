/**
 * T1.10 — Durable initiation send (E2/P7).
 *
 * CONTRACT under test: the dedup key is only durably committed when the send was
 * successfully handed off to the durable queue. If the executor throws, dispatchInitiation
 * DELETES the just-inserted ledger row (compensation) and re-throws, so the dedup key is
 * NOT burned without delivery.
 *
 * RESIDUAL (documented): a hard process crash in the sub-millisecond window after the
 * ledger INSERT commits but before the executor enqueue call returns still burns the dedup
 * key. A full close requires a transactional outbox — out of scope for this fix.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Db } from '../../db/client.js'

// ── Minimal fake db ─────────────────────────────────────────────────────────
// The dispatcher calls (in order): canSendFreeForm, insert initiationLog (returning id),
// optionally select for consent/quiet/budget, then delete on compensation.
// We only need the insert + delete to be trackable for the compensation tests.

// Track db operations for assertion
const dbOps: string[] = []
let insertReturning: { id: string }[] = [{ id: 'log-row-1' }]
let selectReturningRows: unknown[] = []

function fakeDb(): Db {
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    leftJoin: () => selectChain,
    innerJoin: () => selectChain,
    orderBy: () => selectChain,
    limit: async () => selectReturningRows,
  }

  const insertChain = {
    values: () => insertChain,
    onConflictDoNothing: () => insertChain,
    returning: async () => { dbOps.push('insert'); return insertReturning },
  }

  const deleteChain = {
    where: async () => { dbOps.push('delete'); return [] },
  }

  return {
    select: () => selectChain,
    insert: () => insertChain,
    delete: () => deleteChain,
  } as unknown as Db
}

// ── Stub external I/O ────────────────────────────────────────────────────────
vi.mock('../../adapters/whatsapp/sender.js', () => ({
  canSendFreeForm: vi.fn(async () => true),
}))

vi.mock('../audit/logger.js', () => ({
  logAudit: vi.fn(async () => {}),
}))

import { dispatchInitiation } from './dispatch.js'
import { INITIATORS } from './registry.js'

// Pick a real initiator that is always-enabled and doesn't require consent/budget lookups.
// 'reminder.24h' is transactional + customer audience — the gate passes in-window without
// any extra DB loads beyond the canSendFreeForm (which we stub true).
const INITIATOR = INITIATORS['reminder.24h']!

const CTX = {
  businessId: 'biz-1',
  recipientId: 'id-cust-1',
  dedupKey: 'test-dedup-key',
  windowOpen: true,
  recipientOptedOut: false,
  nowInQuietHours: false,
}

describe('dispatchInitiation — ledger compensation on executor throw (E2/P7)', () => {
  beforeEach(() => {
    dbOps.length = 0
    insertReturning = [{ id: 'log-row-1' }]
    selectReturningRows = []
    vi.clearAllMocks()
  })

  it('does NOT delete the ledger row when the executor succeeds', async () => {
    const sendFreeForm = vi.fn(async () => { /* success */ })

    const result = await dispatchInitiation(fakeDb(), INITIATOR, CTX, { sendFreeForm })

    expect(result.kind).toBe('send_free_form')
    expect(dbOps).toContain('insert')
    expect(dbOps).not.toContain('delete')
    expect(sendFreeForm).toHaveBeenCalledOnce()
  })

  it('deletes the ledger row (compensation) when the executor throws', async () => {
    const sendFreeForm = vi.fn(async () => {
      throw new Error('enqueue failed — Redis down')
    })

    await expect(
      dispatchInitiation(fakeDb(), INITIATOR, CTX, { sendFreeForm }),
    ).rejects.toThrow('enqueue failed — Redis down')

    expect(dbOps).toContain('insert')
    expect(dbOps).toContain('delete')
    // delete must come AFTER insert
    expect(dbOps.indexOf('delete')).toBeGreaterThan(dbOps.indexOf('insert'))
  })

  it('re-throws the original executor error after compensation', async () => {
    const cause = new Error('BullMQ connection refused')
    const sendFreeForm = vi.fn(async () => { throw cause })

    await expect(
      dispatchInitiation(fakeDb(), INITIATOR, CTX, { sendFreeForm }),
    ).rejects.toBe(cause)
  })

  it('does NOT call the executor at all when the ledger row is a dedup_hit (0 rows back)', async () => {
    // Simulate the conflict — insert returns 0 rows (onConflictDoNothing hit).
    insertReturning = []
    const sendFreeForm = vi.fn(async () => {})

    const result = await dispatchInitiation(fakeDb(), INITIATOR, CTX, { sendFreeForm })

    expect(result).toEqual({ kind: 'skip', reason: 'dedup_hit' })
    expect(sendFreeForm).not.toHaveBeenCalled()
    // No compensation should run — there was no insert to roll back.
    expect(dbOps).not.toContain('delete')
  })

  it('uses sendTemplate executor and compensates on template executor throw', async () => {
    const sendFreeForm = vi.fn(async () => {})
    const sendTemplate = vi.fn(async (_name: string) => {
      throw new Error('template send failed')
    })

    // Use an out-of-window initiator so send_template is chosen.
    const ctx = { ...CTX, windowOpen: false }

    await expect(
      dispatchInitiation(fakeDb(), INITIATOR, ctx, { sendFreeForm, sendTemplate }),
    ).rejects.toThrow('template send failed')

    expect(dbOps).toContain('insert')
    expect(dbOps).toContain('delete')
    expect(sendFreeForm).not.toHaveBeenCalled()
    expect(sendTemplate).toHaveBeenCalledOnce()
  })
})

// NOTE: the actual enqueueMessage call-site wiring (that the waitlist/reshuffle executors
// call enqueueMessage rather than sendMessage fire-and-forget) is asserted at the worker
// level in waitlist-durable.test.ts and reshuffle-durable.test.ts. dispatch.ts has no
// knowledge of enqueueMessage — its contract is "executor throw → compensate + re-throw",
// fully covered by the tests above — so there is no separate dispatch-level wiring test here.
