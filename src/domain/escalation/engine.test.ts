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

// ── T2c.1 — owner-ping throttle (dedup / substance / rate) + non-blocking + still-waiting ──
import { escalateCustomerQuestion, isSubstantiveQuestion } from './engine.js'
import { pendingOwnerQuestions } from '../../db/schema.js'
import { i18n } from '../i18n/t.js'

// Mock db that supports: manager lookup (.limit), the two pendingOwnerQuestions throttle reads
// (dedup .limit, rate .then), and the insert(...).values(...).returning(...) chain.
function makeQDb(opts: { manager?: boolean; dedup?: unknown[]; rate?: unknown[] } = {}) {
  const inserts: Array<{ table: unknown; values: Record<string, unknown> }> = []
  const q = new Map<unknown, unknown[][]>()
  const push = (tbl: unknown, rows: unknown[]) => { if (!q.has(tbl)) q.set(tbl, []); q.get(tbl)!.push(rows) }
  push(identities, opts.manager === false ? [] : [{ id: 'mgr-1', phoneNumber: MANAGER_PHONE }])
  push(pendingOwnerQuestions, opts.dedup ?? [])   // dedup read (per-customer pending)
  push(pendingOwnerQuestions, opts.rate ?? [])    // rate read (per-business pending)
  const db = {
    select: () => ({
      from: (tbl: unknown) => {
        const next = () => q.get(tbl)?.shift() ?? []
        const chain: Record<string, unknown> = {
          where: () => chain, orderBy: () => chain,
          limit: async () => next(),
          then: (r: (v: unknown) => unknown) => r(next()),
        }
        return chain
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        returning: async () => { inserts.push({ table, values }); return [{ id: 'q-new' }] },
      }),
    }),
  }
  return { db: db as unknown as Db, inserts }
}

const customer = { id: 'cust-1', phoneNumber: '+972546372400' }

describe('isSubstantiveQuestion — owner-ping substance gate (pure)', () => {
  it('rejects greetings/social and trivially short noise', () => {
    expect(isSubstantiveQuestion('hi', 8)).toBe(false)
    expect(isSubstantiveQuestion('שלום', 8)).toBe(false)
    expect(isSubstantiveQuestion('???', 8)).toBe(false)
    expect(isSubstantiveQuestion('   ', 8)).toBe(false)
  })
  it('accepts a real question', () => {
    expect(isSubstantiveQuestion('Do you have parking near the studio?', 8)).toBe(true)
  })
})

describe('escalateCustomerQuestion — throttle + non-blocking + still-waiting (T2c.1)', () => {
  it('happy path: a fresh substantive question records + pings the owner once', async () => {
    const { db, inserts } = makeQDb()
    const res = await escalateCustomerQuestion(db, business, customer, 'Do you offer reformer pilates for beginners?', 'en')
    expect(inserts.find((i) => i.table === pendingOwnerQuestions)).toBeTruthy()
    expect(dispatchSpy).toHaveBeenCalledTimes(1)
    expect(res.escalated).toBe(true)
    expect(res.customerReply).toBe(i18n.question_passed_to_studio.en(business.name))
  })

  it('DEDUP: a re-ask while a question is already pending does NOT re-ping — returns the "still waiting" reply', async () => {
    const { db, inserts } = makeQDb({ dedup: [{ id: 'p-open' }] })
    const res = await escalateCustomerQuestion(db, business, customer, 'and what about the reformer classes?', 'en')
    expect(inserts.find((i) => i.table === pendingOwnerQuestions)).toBeFalsy() // no new row
    expect(dispatchSpy).not.toHaveBeenCalled()                                  // no new ping
    expect(res.customerReply).toBe(i18n.question_still_pending.en(business.name))  // references the open thread
    expect(res.escalated).toBe(true)                                            // the question IS in the owner's hands
  })

  it('SUBSTANCE: a greeting never pings the owner', async () => {
    const { db, inserts } = makeQDb()
    const res = await escalateCustomerQuestion(db, business, customer, 'good morning', 'en')
    expect(inserts.length).toBe(0)
    expect(dispatchSpy).not.toHaveBeenCalled()
    expect(res.escalated).toBe(false)
  })

  it('RATE: when the business is at its pending cap, a new question is suppressed (no ping, honest no-promise)', async () => {
    const atCap = Array.from({ length: 5 }, (_, i) => ({ id: `p${i}` }))
    const { db, inserts } = makeQDb({ rate: atCap })
    const res = await escalateCustomerQuestion(db, business, customer, 'Is there a student discount available?', 'en')
    expect(inserts.find((i) => i.table === pendingOwnerQuestions)).toBeFalsy()
    expect(dispatchSpy).not.toHaveBeenCalled()
    expect(res.escalated).toBe(false)
  })

  it('NON-BLOCKING: the return carries no session-lock signal (DB state only)', async () => {
    const { db } = makeQDb()
    const res = await escalateCustomerQuestion(db, business, customer, 'Do you have parking on site?', 'en')
    expect(res).not.toHaveProperty('awaitingConfirmationFor')
    expect(res).not.toHaveProperty('sessionLock')
    expect(Object.keys(res).sort()).toEqual(['customerReply', 'escalated'])
  })
})
