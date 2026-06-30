import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { findCentralManagedBusinessForOwner } from './central-manager.js'
import type { Db } from '../../db/client.js'

// Minimal chain stub: select().from().innerJoin().where().limit(2) → canned rows.
// Drizzle returns joined rows shaped as { identities: {...}, businesses: {...} }.
function fakeDb(rows: unknown[]): Db {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  }
  return { select: () => chain } as unknown as Db
}

const bizRow = (id: string) => ({ businesses: { id, managerChannel: 'central' }, identities: { id: `idn-${id}`, role: 'manager' } })

describe('findCentralManagedBusinessForOwner — resolution branching (G1)', () => {
  it('no match → none (falls through to onboarding)', async () => {
    const res = await findCentralManagedBusinessForOwner(fakeDb([]), '+972500000000')
    expect(res.kind).toBe('none')
  })

  it('exactly one match → one, with that business', async () => {
    const res = await findCentralManagedBusinessForOwner(fakeDb([bizRow('biz-1')]), '+972501111111')
    expect(res.kind).toBe('one')
    if (res.kind === 'one') expect(res.business.id).toBe('biz-1')
  })

  it('more than one match → multiple (caller MUST hard-refuse, never pick a tenant)', async () => {
    const res = await findCentralManagedBusinessForOwner(fakeDb([bizRow('biz-1'), bizRow('biz-2')]), '+972502222222')
    expect(res.kind).toBe('multiple')
  })
})

describe('findCentralManagedBusinessForOwner — query scoping (G2 source guard)', () => {
  // The unit mock can't introspect the opaque Drizzle predicate, so guard the source: the
  // lookup must filter strictly by manager role, non-revoked, AND central channel.
  it('filters by manager role, non-revoked, and central channel', () => {
    const src = readFileSync(new URL('./central-manager.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/eq\(identities\.role, 'manager'\)/)
    expect(src).toMatch(/isNull\(identities\.revokedAt\)/)
    expect(src).toMatch(/eq\(businesses\.managerChannel, 'central'\)/)
    // LIMIT 2 so >1 is detectable (G1); never a silent limit(1) pick.
    expect(src).toMatch(/\.limit\(2\)/)
  })
})
