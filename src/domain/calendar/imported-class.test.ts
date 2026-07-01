/**
 * T1.3 pending-imported-class state — the occupy-and-ASK lifecycle for an UNCERTAIN
 * owner-added class:
 *   - findPendingImportedClassForSlot: is this slot occupied by a pending (not-yet-open)
 *     imported class? (type='block' + source='google_import' + serviceTypeId set)
 *   - relayPendingClassToOwner (customer path): honest "let me confirm with the studio"
 *     reply + a pending_owner_questions relay LINKED to the block (relatedBlockId).
 *   - confirmImportedClass (owner confirms): flips block→class (now bookable) AND
 *     re-notifies every waiting customer (the plan's repro f).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getTableName } from 'drizzle-orm'

const h = vi.hoisted(() => ({
  slotBlocks: [] as Array<Record<string, unknown>>, // findPendingImportedClassForSlot .limit(1)
  businessRow: null as Record<string, unknown> | null,
  serviceRow: null as Record<string, unknown> | null,
  managerRow: null as Record<string, unknown> | null,
  customerPending: [] as Array<Record<string, unknown>>, // dedup lookup (.limit)
  updateReturning: [] as Array<Record<string, unknown>>, // calendar_blocks UPDATE ... RETURNING
  pendingQuestions: [] as Array<Record<string, unknown>>, // pending_owner_questions .then
  inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
  updates: [] as Array<{ table: string; set: Record<string, unknown> }>,
  enqueued: [] as Array<{ to: string; body: string }>,
}))

vi.mock('../../db/client.js', () => {
  function tableName(t: unknown): string { try { return getTableName(t as never) } catch { return 'unknown' } }
  function makeSelectChain() {
    const state = { table: 'unknown' }
    const chain: Record<string, unknown> = {}
    chain['from'] = (t: unknown) => { state.table = tableName(t); return chain }
    for (const m of ['where', 'leftJoin', 'innerJoin', 'orderBy']) chain[m] = () => chain
    chain['limit'] = async () => {
      if (state.table === 'calendar_blocks') return h.slotBlocks
      if (state.table === 'businesses') return h.businessRow ? [h.businessRow] : []
      if (state.table === 'service_types') return h.serviceRow ? [h.serviceRow] : []
      if (state.table === 'identities') return h.managerRow ? [h.managerRow] : []
      if (state.table === 'pending_owner_questions') return h.customerPending
      return []
    }
    chain['then'] = (resolve: (v: unknown) => unknown) => {
      if (state.table === 'pending_owner_questions') return resolve(h.pendingQuestions)
      return resolve([])
    }
    return chain
  }
  return {
    db: {
      select: () => makeSelectChain(),
      insert: (t: unknown) => ({
        values: (vals: Record<string, unknown>) => {
          h.inserts.push({ table: tableName(t), values: vals })
          const row = { id: 'q-new', ...vals }
          const p = Promise.resolve([row])
          return { returning: async () => [row], then: p.then.bind(p) }
        },
      }),
      update: (t: unknown) => ({
        set: (set: Record<string, unknown>) => {
          h.updates.push({ table: tableName(t), set })
          const ret = async () => h.updateReturning
          const p = Promise.resolve(undefined)
          return { where: () => ({ returning: ret, then: p.then.bind(p) }) }
        },
      }),
      delete: () => ({ where: async () => undefined }),
    },
  }
})

vi.mock('../../workers/message-retry.js', () => ({
  enqueueMessage: vi.fn(async (_biz: string, to: string, body: string) => { h.enqueued.push({ to, body }) }),
}))
vi.mock('../audit/logger.js', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('../initiations/dispatch.js', () => ({ dispatchInitiation: vi.fn(async (_db: unknown, _i: unknown, _c: unknown, hooks: { sendFreeForm: () => Promise<void> }) => { await hooks.sendFreeForm() }) }))
vi.mock('../initiations/registry.js', () => ({ getInitiator: () => ({}) }))

import { findPendingImportedClassForSlot, relayPendingClassToOwner, confirmImportedClass } from './imported-class.js'
import { db } from '../../db/client.js'

const SLOT = new Date('2026-07-05T19:00:00Z')

beforeEach(() => {
  vi.clearAllMocks()
  h.slotBlocks = []
  h.businessRow = { id: 'biz-1', name: 'Studio Zen', timezone: 'UTC', defaultLanguage: 'en' }
  h.serviceRow = { name: 'Pilates' }
  h.managerRow = { id: 'mgr-1', phoneNumber: '+972500000001' }
  h.customerPending = []
  h.updateReturning = []
  h.pendingQuestions = []
  h.inserts = []
  h.updates = []
  h.enqueued = []
})

describe('findPendingImportedClassForSlot', () => {
  it('returns the pending block when a google_import type=block with serviceTypeId occupies the slot', async () => {
    h.slotBlocks = [{ id: 'blk-1', serviceTypeId: 'svc-pilates', startTs: SLOT, endTs: SLOT, maxParticipants: 8 }]
    const r = await findPendingImportedClassForSlot(db as never, 'biz-1', 'svc-pilates', SLOT)
    expect(r).toMatchObject({ id: 'blk-1', serviceTypeId: 'svc-pilates', maxParticipants: 8 })
  })
  it('returns null when nothing pending occupies the slot', async () => {
    h.slotBlocks = []
    expect(await findPendingImportedClassForSlot(db as never, 'biz-1', 'svc-pilates', SLOT)).toBeNull()
  })
})

describe('relayPendingClassToOwner (customer path — test b)', () => {
  it('records a pending_owner_question LINKED to the block and returns the honest studio-confirm reply', async () => {
    const business = { id: 'biz-1', name: 'Studio Zen', defaultLanguage: 'en' } as never
    const customer = { id: 'cust-1', phoneNumber: '+972500000009' }
    const block = { id: 'blk-1', serviceTypeId: 'svc-pilates', startTs: SLOT, endTs: SLOT, maxParticipants: 8 }
    const r = await relayPendingClassToOwner(db as never, business, customer, block, 'Pilates', 'en')
    const ins = h.inserts.find((i) => i.table === 'pending_owner_questions')
    expect(ins).toBeDefined()
    expect(ins!.values['relatedBlockId']).toBe('blk-1')
    expect(ins!.values['customerId']).toBe('cust-1')
    expect(r.escalated).toBe(true)
    expect(r.customerReply).toContain('Pilates')
    expect(r.customerReply?.toLowerCase()).toContain('confirm')
  })
})

describe('confirmImportedClass (owner confirms — test f)', () => {
  it('flips the pending block to a bookable class AND re-notifies every waiting customer', async () => {
    // The block flip succeeds (RETURNING one row) and one customer was waiting on it.
    h.updateReturning = [{ id: 'blk-1', serviceTypeId: 'svc-pilates', startTs: SLOT }]
    h.pendingQuestions = [
      { id: 'q1', customerPhone: '+972500000009', customerId: 'cust-1' },
    ]

    const res = await confirmImportedClass(db as never, 'biz-1', 'blk-1')

    expect(res.opened).toBe(true)
    expect(res.notifiedCustomers).toBe(1)
    // The block was flipped to type='class'.
    const flip = h.updates.find((u) => u.table === 'calendar_blocks')
    expect(flip?.set['type']).toBe('class')
    // The waiting customer got a re-engage message (not the owner).
    expect(h.enqueued.some((m) => m.to === '+972500000009')).toBe(true)
    // The pending question was resolved to 'answered'.
    expect(h.updates.some((u) => u.table === 'pending_owner_questions' && u.set['status'] === 'answered')).toBe(true)
  })

  it('is a no-op when the block is not a pending import (nothing flipped, nobody notified)', async () => {
    h.updateReturning = [] // UPDATE matched no pending block
    const res = await confirmImportedClass(db as never, 'biz-1', 'blk-x')
    expect(res.opened).toBe(false)
    expect(res.notifiedCustomers).toBe(0)
    expect(h.enqueued).toHaveLength(0)
  })
})
