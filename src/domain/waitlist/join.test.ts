import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Db } from '../../db/client.js'

// ── Collaborator mocks ─────────────────────────────────────────────────────────
// The fresh-spine capacity re-check is a separate availability read; stub it so each
// test states whether the slot is full (false = no space → waitlist) or open (true =
// has space → route to booking). The real helper is exercised by its own suite.
vi.mock('../../workers/waitlist-revalidate.js', () => ({
  revalidateWaitlistSlotOpen: vi.fn(async () => false),
}))

// Audit is a fire-and-forget side-effect; assert the call shape via the mock.
vi.mock('../audit/logger.js', () => ({
  logAudit: vi.fn(async () => {}),
}))

import { joinWaitlist } from './join.js'
import { revalidateWaitlistSlotOpen } from '../../workers/waitlist-revalidate.js'
import { logAudit } from '../audit/logger.js'

// TEST FIDELITY (honest note): this repo has NO real-Postgres / pglite / pg-mem
// harness for domain code. Mirroring the durable + digest-queue tests, this is a
// STATEFUL FAKE-DB: in-memory `identities` + `waitlist` row arrays, with the exact
// query shapes joinWaitlist issues hand-modelled (select identity, onConflict insert
// with returning, select pending rows for position). The unique-index conflict is
// modelled on (businessId, slotStart, customerId) so the idempotency path is exercised.

interface IdentityRow {
  id: string
  displayName: string | null
}
interface WaitlistRow {
  id: string
  businessId: string
  serviceTypeId: string
  slotStart: Date
  slotEnd: Date
  customerId: string
  status: 'pending' | 'offered' | 'accepted' | 'expired'
  createdAt: Date
}

interface Store {
  identities: IdentityRow[]
  waitlist: WaitlistRow[]
  // Test-side cursor: lets the fake answer the by-id identity lookup and the per-slot
  // position query without parsing drizzle filter ASTs. Production passes these through
  // real where() clauses; here they are stated by the test.
  _identityLookupId: string
  _slot: { businessId: string; serviceTypeId: string; slotStart: Date }
}

// The fake interprets which table a chain targets by the table object identity passed
// to `.from()` / `.insert()`. We import the real table refs so we can compare.
import { identities, waitlist } from '../../db/schema.js'

type Table = typeof identities | typeof waitlist

function fakeDb(store: Store): Db {
  function resolveRows(table: Table | null): Promise<unknown[]> {
    if (table === identities) {
      const row = store.identities.find((i) => i.id === store._identityLookupId)
      return Promise.resolve(row ? [{ id: row.id, displayName: row.displayName }] : [])
    }
    if (table === waitlist) {
      // Position / existing-row query: all pending rows for the slot, createdAt asc.
      const rows = store.waitlist
        .filter(
          (w) =>
            w.businessId === store._slot.businessId &&
            w.serviceTypeId === store._slot.serviceTypeId &&
            w.slotStart.getTime() === store._slot.slotStart.getTime() &&
            w.status === 'pending',
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      return Promise.resolve(rows.map((w) => ({ id: w.id, createdAt: w.createdAt })))
    }
    return Promise.resolve([])
  }

  const api = {
    select: () => {
      let table: Table | null = null
      const builder = {
        from(t: Table) {
          table = t
          return builder
        },
        where() {
          return builder
        },
        orderBy() {
          return resolveRows(table)
        },
        limit() {
          return resolveRows(table)
        },
      }
      return builder
    },
    insert: (table: Table) => {
      let vals: Record<string, unknown> = {}
      let conflict = false
      const builder = {
        values(v: Record<string, unknown>) {
          vals = v
          return builder
        },
        onConflictDoNothing() {
          conflict = true
          return builder
        },
        returning(): Promise<{ id: string }[]> {
          if (table !== waitlist) return Promise.resolve([])
          const dupe = store.waitlist.find(
            (w) =>
              w.businessId === vals.businessId &&
              w.slotStart.getTime() === (vals.slotStart as Date).getTime() &&
              w.customerId === vals.customerId,
          )
          if (dupe && conflict) return Promise.resolve([]) // conflict → no rows
          const row: WaitlistRow = {
            id: randomUUID(),
            businessId: vals.businessId as string,
            serviceTypeId: vals.serviceTypeId as string,
            slotStart: vals.slotStart as Date,
            slotEnd: vals.slotEnd as Date,
            customerId: vals.customerId as string,
            status: (vals.status as WaitlistRow['status']) ?? 'pending',
            createdAt: (vals.createdAt as Date | undefined) ?? new Date(),
          }
          store.waitlist.push(row)
          return Promise.resolve([{ id: row.id }])
        },
      }
      return builder
    },
  }
  return api as unknown as Db
}

const BIZ = 'biz-1'
const SVC = 'svc-1'
const SLOT_START = new Date('2026-07-01T10:00:00Z')
const SLOT_END = new Date('2026-07-01T11:00:00Z')

function makeStore(over: Partial<Pick<Store, 'identities' | 'waitlist'>> = {}): Store {
  return {
    identities: over.identities ?? [],
    waitlist: over.waitlist ?? [],
    _slot: { businessId: BIZ, serviceTypeId: SVC, slotStart: SLOT_START },
    _identityLookupId: '',
  }
}

function params(customerId: string) {
  return { businessId: BIZ, customerId, serviceTypeId: SVC, slotStart: SLOT_START, slotEnd: SLOT_END }
}

describe('joinWaitlist (WL-2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(revalidateWaitlistSlotOpen).mockResolvedValue(false) // default: slot full
  })

  it('(a) full slot + named customer → inserts pending, returns joined position 1, writes audit', async () => {
    const store = makeStore({ identities: [{ id: 'cust-1', displayName: 'Dana' }] })
    store._identityLookupId = 'cust-1'
    const db = fakeDb(store)

    const res = await joinWaitlist(db, params('cust-1'))

    expect(res.kind).toBe('joined')
    if (res.kind !== 'joined') throw new Error('unreachable')
    expect(res.position).toBe(1)
    expect(typeof res.waitlistId).toBe('string')
    expect(store.waitlist).toHaveLength(1)
    expect(store.waitlist[0]!.status).toBe('pending')
    expect(logAudit).toHaveBeenCalledOnce()
    expect(logAudit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        businessId: BIZ,
        actorId: 'cust-1',
        action: 'waitlist.joined',
        entityType: 'waitlist',
        entityId: res.waitlistId,
      }),
    )
  })

  it('(b) slot has open space → returns slot_has_space, inserts nothing, no audit', async () => {
    vi.mocked(revalidateWaitlistSlotOpen).mockResolvedValue(true) // open
    const store = makeStore({ identities: [{ id: 'cust-1', displayName: 'Dana' }] })
    store._identityLookupId = 'cust-1'
    const db = fakeDb(store)

    const res = await joinWaitlist(db, params('cust-1'))

    expect(res.kind).toBe('slot_has_space')
    expect(store.waitlist).toHaveLength(0)
    expect(logAudit).not.toHaveBeenCalled()
  })

  it('(c) duplicate join → already_on_list, no second row, no second audit', async () => {
    const store = makeStore({ identities: [{ id: 'cust-1', displayName: 'Dana' }] })
    store._identityLookupId = 'cust-1'
    const db = fakeDb(store)

    const first = await joinWaitlist(db, params('cust-1'))
    expect(first.kind).toBe('joined')

    const second = await joinWaitlist(db, params('cust-1'))
    expect(second.kind).toBe('already_on_list')
    if (second.kind !== 'already_on_list') throw new Error('unreachable')
    expect(second.position).toBe(1)
    expect(second.waitlistId).toBe((first as { waitlistId: string }).waitlistId)

    expect(store.waitlist).toHaveLength(1)
    // audit only on the fresh join
    expect(logAudit).toHaveBeenCalledOnce()
  })

  it('(d) customer displayName is null → needs_name, inserts nothing, no capacity check', async () => {
    const store = makeStore({ identities: [{ id: 'cust-1', displayName: null }] })
    store._identityLookupId = 'cust-1'
    const db = fakeDb(store)

    const res = await joinWaitlist(db, params('cust-1'))

    expect(res.kind).toBe('needs_name')
    expect(store.waitlist).toHaveLength(0)
    expect(logAudit).not.toHaveBeenCalled()
    expect(revalidateWaitlistSlotOpen).not.toHaveBeenCalled()
  })

  it('(e) position reflects FIFO place: second joiner for the same slot gets position 2', async () => {
    const store = makeStore({
      identities: [
        { id: 'cust-1', displayName: 'Alice' },
        { id: 'cust-2', displayName: 'Bob' },
      ],
      waitlist: [
        {
          id: 'wl-existing',
          businessId: BIZ,
          serviceTypeId: SVC,
          slotStart: SLOT_START,
          slotEnd: SLOT_END,
          customerId: 'cust-1',
          status: 'pending',
          createdAt: new Date('2026-06-30T09:00:00Z'),
        },
      ],
    })
    store._identityLookupId = 'cust-2'
    const db = fakeDb(store)

    const res = await joinWaitlist(db, params('cust-2'))

    expect(res.kind).toBe('joined')
    if (res.kind !== 'joined') throw new Error('unreachable')
    expect(res.position).toBe(2)
    expect(store.waitlist).toHaveLength(2)
  })
})
