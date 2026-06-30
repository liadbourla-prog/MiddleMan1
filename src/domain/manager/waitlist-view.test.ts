import { describe, it, expect } from 'vitest'
import { getTableName } from 'drizzle-orm'
import { executeViewWaitlist, type ViewWaitlistArgs } from './waitlist-view.js'
import type { ToolContext } from './orchestrator-tools.js'
import type { BookingState } from '../../db/schema.js'

// Fidelity note: this repo has no real-Postgres / pglite harness for domain code
// (see orchestrator-tools.test.ts getSessionRoster). So this is a STATEFUL FAKE-DB
// routed BY TABLE. WL-9 is READ-ONLY, so the fake db throws on any insert/update/
// delete — the "no writes" invariant is structural, not asserted after the fact.

// ── Fixtures ──────────────────────────────────────────────────────────────────

interface WaitRow {
  id: string
  customerId: string
  status: 'pending' | 'offered' | 'accepted' | 'expired'
  createdAt: Date
}
interface IdentityRow {
  id: string
  displayName: string | null
  phoneNumber: string
}
interface BookingRow {
  customerId: string
  state: BookingState
  slotStart: Date
}

const NOW = new Date('2026-07-01T09:00:00Z')

// A fake db routed by table name. Mutating calls throw (read-only proof).
function viewCtx(opts: {
  serviceId?: string
  serviceName?: string
  activeServiceIds?: string[]
  waitlist: WaitRow[]
  identities: IdentityRow[]
  bookings: BookingRow[]
}): { ctx: ToolContext; reads: string[] } {
  const serviceId = opts.serviceId ?? 'svc-yoga'
  const serviceName = opts.serviceName ?? 'Yoga'
  const reads: string[] = []

  const throwOnWrite = (op: string) => () => { throw new Error(`READ-ONLY tool must not ${op}`) }

  interface Builder {
    _table: string | null
    from: (table: unknown) => Builder
    innerJoin: (table: unknown) => Builder
    where: () => Builder
    orderBy: () => Builder
    limit: () => Promise<unknown[]>
    then: (resolve: (rows: unknown[]) => void) => void
  }

  const db = {
    insert: throwOnWrite('insert'),
    update: throwOnWrite('update'),
    delete: throwOnWrite('delete'),
    select: (_cols?: unknown) => {
      const builder: Builder = {
        _table: null,
        from: (table: unknown) => { builder._table = getTableName(table as Parameters<typeof getTableName>[0]); return builder },
        innerJoin: () => builder,
        where: () => builder,
        orderBy: () => builder,
        limit: async () => {
          // service resolution + single-active fallback
          if (builder._table === 'service_types') {
            reads.push('service_types')
            // single-active fallback path asks for up to 2 active rows (no name filter)
            const actives = (opts.activeServiceIds ?? [serviceId]).map((id) => ({ id, name: serviceName }))
            return actives
          }
          return []
        },
        // waitlist⋈identities and bookings reads are awaited directly (no .limit()).
        then: (resolve: (rows: unknown[]) => void) => {
          if (builder._table === 'waitlist') {
            reads.push('waitlist')
            // join waitlist→identities, FIFO by createdAt (caller re-ranks)
            const byId = new Map(opts.identities.map((i) => [i.id, i]))
            const rows = opts.waitlist
              .filter((w) => w.status === 'pending' || w.status === 'offered')
              .slice()
              .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
              .map((w) => {
                const idn = byId.get(w.customerId)!
                return {
                  id: w.id,
                  customerId: w.customerId,
                  status: w.status,
                  createdAt: w.createdAt,
                  displayName: idn.displayName,
                  phoneNumber: idn.phoneNumber,
                }
              })
            return resolve(rows)
          }
          if (builder._table === 'bookings') {
            reads.push('bookings')
            // commitment probe: active bookings in [now, now+7d] for ONE customer.
            // The executor scopes by customerId in its WHERE; the fake returns ALL
            // active-in-window bookings and lets the executor's set logic decide.
            // To keep the fake honest per-customer we expose every active booking row;
            // the executor narrows by the customerId it queried — but since the fake
            // can't see the param easily, we return the full active-in-window set and
            // the executor must treat "any row" as commitment for the queried id.
            const windowEnd = new Date(NOW.getTime() + 7 * 24 * 3600 * 1000)
            const active = opts.bookings.filter(
              (b) =>
                (b.state === 'confirmed' || b.state === 'pending_payment' || b.state === 'held') &&
                b.slotStart >= NOW &&
                b.slotStart <= windowEnd,
            )
            return resolve(active.map((b) => ({ customerId: b.customerId })))
          }
          return resolve([])
        },
      }
      return builder
    },
  }

  return {
    ctx: {
      db: db as unknown as ToolContext['db'],
      calendar: {} as ToolContext['calendar'],
      businessId: 'biz-1',
      identityId: 'mgr-1',
      timezone: 'Asia/Jerusalem',
      lang: 'en',
      role: 'manager',
    },
    reads,
  }
}

const args: ViewWaitlistArgs = { serviceName: 'Yoga' }

describe('executeViewWaitlist — owner read-side (WL-9)', () => {
  it('lists waiting customers for a service with name, phone, and status', async () => {
    const { ctx } = viewCtx({
      waitlist: [
        { id: 'w1', customerId: 'c1', status: 'offered', createdAt: new Date('2026-06-20T10:00:00Z') },
        { id: 'w2', customerId: 'c2', status: 'pending', createdAt: new Date('2026-06-21T10:00:00Z') },
      ],
      identities: [
        { id: 'c1', displayName: 'Dana', phoneNumber: '+972500000001' },
        { id: 'c2', displayName: 'Noa', phoneNumber: '+972500000002' },
      ],
      bookings: [], // nobody has any commitment → all priority
    })

    const res = (await executeViewWaitlist(args, ctx)) as {
      count: number
      entries: { name: string | null; phoneNumber: string; status: string; tier: string }[]
    }

    expect(res.count).toBe(2)
    const names = res.entries.map((e) => e.name)
    expect(names).toContain('Dana')
    expect(names).toContain('Noa')
    const dana = res.entries.find((e) => e.name === 'Dana')!
    expect(dana.phoneNumber).toBe('+972500000001')
    expect(dana.status).toBe('offered')
  })

  it('computes tier: no active booking in window → priority; with one → normal', async () => {
    const { ctx } = viewCtx({
      waitlist: [
        // c1 joined first but HAS a booking this week → normal
        { id: 'w1', customerId: 'c1', status: 'pending', createdAt: new Date('2026-06-20T10:00:00Z') },
        // c2 joined second, NO booking → priority
        { id: 'w2', customerId: 'c2', status: 'pending', createdAt: new Date('2026-06-21T10:00:00Z') },
      ],
      identities: [
        { id: 'c1', displayName: 'Booked', phoneNumber: '+972500000001' },
        { id: 'c2', displayName: 'Free', phoneNumber: '+972500000002' },
      ],
      bookings: [
        // c1 has an active booking within [now, now+7d]
        { customerId: 'c1', state: 'confirmed', slotStart: new Date('2026-07-03T08:00:00Z') },
      ],
    })

    const res = (await executeViewWaitlist(args, ctx)) as {
      count: number
      entries: { name: string | null; tier: 'priority' | 'normal' }[]
    }

    expect(res.count).toBe(2)
    const booked = res.entries.find((e) => e.name === 'Booked')!
    const free = res.entries.find((e) => e.name === 'Free')!
    expect(free.tier).toBe('priority')
    expect(booked.tier).toBe('normal')
    // ordering: priority tier first even though it joined later (FIFO within tier)
    expect(res.entries[0]!.name).toBe('Free')
    expect(res.entries[1]!.name).toBe('Booked')
  })

  it('FIFO within the same tier (both priority) preserves join order', async () => {
    const { ctx } = viewCtx({
      waitlist: [
        { id: 'w1', customerId: 'c1', status: 'pending', createdAt: new Date('2026-06-20T10:00:00Z') },
        { id: 'w2', customerId: 'c2', status: 'pending', createdAt: new Date('2026-06-21T10:00:00Z') },
      ],
      identities: [
        { id: 'c1', displayName: 'First', phoneNumber: '+972500000001' },
        { id: 'c2', displayName: 'Second', phoneNumber: '+972500000002' },
      ],
      bookings: [],
    })

    const res = (await executeViewWaitlist(args, ctx)) as { entries: { name: string | null }[] }
    expect(res.entries[0]!.name).toBe('First')
    expect(res.entries[1]!.name).toBe('Second')
  })

  it('empty waitlist → count 0, empty entries', async () => {
    const { ctx } = viewCtx({
      waitlist: [],
      identities: [],
      bookings: [],
    })
    const res = (await executeViewWaitlist(args, ctx)) as { count: number; entries: unknown[] }
    expect(res.count).toBe(0)
    expect(res.entries).toEqual([])
  })

  it('is read-only — never issues insert/update/delete', async () => {
    // The fake db throws on any insert/update/delete; if the executor returned
    // without throwing, no mutation was attempted.
    const { ctx, reads } = viewCtx({
      waitlist: [{ id: 'w1', customerId: 'c1', status: 'pending', createdAt: new Date('2026-06-20T10:00:00Z') }],
      identities: [{ id: 'c1', displayName: 'Dana', phoneNumber: '+972500000001' }],
      bookings: [],
    })
    await executeViewWaitlist(args, ctx)
    // It read waitlist; it must not have mutated (would have thrown).
    expect(reads).toContain('waitlist')
  })
})
