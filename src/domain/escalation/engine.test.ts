// P3: escalateUnfulfillableRequest — a customer asked for something the PA can't book
// on its own (private/group/out-of-hours). We assert the two decision points: the owner
// is notified (manager lookup + enqueue to their phone), and the escalation is recorded
// with type 'unfulfillable'. The spine internals (governance, dedup) have their own tests.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { dispatchSpy, enqueueSpy, replySpy } = vi.hoisted(() => ({
  dispatchSpy: vi.fn(async (_db: unknown, _initiator: unknown, _ctx: unknown, exec: { sendFreeForm?: () => Promise<void> }) => {
    if (exec.sendFreeForm) await exec.sendFreeForm()
  }),
  enqueueSpy: vi.fn(async (_businessId: string, _phone: string, _body: string) => {}),
  replySpy: vi.fn(async () => 'passed to the studio'),
}))

vi.mock('../initiations/dispatch.js', () => ({ dispatchInitiation: dispatchSpy }))
vi.mock('../../workers/message-retry.js', () => ({
  enqueueMessage: enqueueSpy,
  messageRetryQueue: { add: async () => {} },
  startMessageRetryWorker: () => {},
}))
vi.mock('../../adapters/llm/client.js', () => ({ generateProactiveCustomerMessage: replySpy }))

import { escalateUnfulfillableRequest } from './engine.js'
import type { Db } from '../../db/client.js'
import { identities, escalatedTasks } from '../../db/schema.js'
import type { Business } from '../../db/schema.js'

const MANAGER_PHONE = '+972540000000'

function makeDb(opts: { manager?: boolean } = { manager: true }) {
  const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = []
  const q = new Map<unknown, unknown[][]>()
  const push = (t: unknown, rows: unknown[]) => { if (!q.has(t)) q.set(t, []); q.get(t)!.push(rows) }
  push(identities, opts.manager === false ? [] : [{ id: 'mgr-1', phoneNumber: MANAGER_PHONE }])
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
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => { inserts.push({ table, values }); return undefined },
    }),
  }
  return { db: db as unknown as Db, inserts }
}

const business = { id: 'biz-1', name: 'Studio', defaultLanguage: 'he' } as unknown as Business

beforeEach(() => { dispatchSpy.mockClear(); enqueueSpy.mockClear(); replySpy.mockClear() })

describe('escalateUnfulfillableRequest', () => {
  it('notifies the owner and records the escalation as unfulfillable', async () => {
    const { db, inserts } = makeDb()
    const res = await escalateUnfulfillableRequest(db, business, '+972546372400', 'private workshop for 5 outside hours', 'he')

    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    expect(enqueueSpy).toHaveBeenCalledTimes(1)
    expect(enqueueSpy.mock.calls[0]![1]).toBe(MANAGER_PHONE)

    const esc = inserts.find((i) => i.table === escalatedTasks)
    expect(esc).toBeTruthy()
    expect(esc!.values.escalationType).toBe('unfulfillable')
    expect(esc!.values.customerPhone).toBe('+972546372400')

    expect(res.customerReply).toBe('passed to the studio')
  })

  it('does NOT throw when there is no manager (best-effort), still records', async () => {
    const { db, inserts } = makeDb({ manager: false })
    const res = await escalateUnfulfillableRequest(db, business, '+972546372400', 'private event', 'en')
    expect(enqueueSpy).not.toHaveBeenCalled()
    expect(inserts.find((i) => i.table === escalatedTasks)).toBeTruthy()
    expect(res.customerReply).toBe('passed to the studio')
  })
})

// F3a/S3 — the expiry sweep flips stale pending owner questions to 'expired' and reports the
// count. No customer message on expiry (the customer was only told "they'll get back to you").
describe('expireStaleOwnerQuestions', () => {
  it('flips pending rows to expired and returns the count', async () => {
    const captured: { set?: unknown } = {}
    const chain = {
      set: (v: unknown) => { captured.set = v; return chain },
      where: () => chain,
      returning: async () => [{ id: 'a' }, { id: 'b' }],
    }
    const db = { update: () => chain } as unknown as Db
    const { expireStaleOwnerQuestions } = await import('./engine.js')
    const n = await expireStaleOwnerQuestions(db, new Date())
    expect(n).toBe(2)
    expect(captured.set).toEqual({ status: 'expired' })
  })
  it('returns 0 when nothing is stale', async () => {
    const chain = { set: () => chain, where: () => chain, returning: async () => [] as Array<{ id: string }> }
    const db = { update: () => chain } as unknown as Db
    const { expireStaleOwnerQuestions } = await import('./engine.js')
    expect(await expireStaleOwnerQuestions(db, new Date())).toBe(0)
  })
})
