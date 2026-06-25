import { describe, it, expect } from 'vitest'
import { deriveLastName, latestBookingFor } from './customer-resolver.js'
import type { Db } from '../../db/client.js'

// Each terminal `.limit()` resolves the next queued result-set, in call order.
function fakeDb(results: unknown[][]): Db {
  let i = 0
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'from', 'where', 'leftJoin', 'innerJoin', 'orderBy']) {
    chain[m] = () => chain
  }
  chain['limit'] = () => Promise.resolve(results[i++] ?? [])
  return { select: () => chain } as unknown as Db
}

describe('latestBookingFor', () => {
  it('formats the most recent booking date + service', async () => {
    const db = fakeDb([[{ slotStart: new Date('2026-03-03T12:00:00Z'), service: 'Haircut' }]])
    const r = await latestBookingFor(db, 'biz1', 'id1', 'Asia/Jerusalem', 'en')
    expect(r).toEqual({ date: expect.stringContaining('2026'), service: 'Haircut' })
  })
  it('returns null when the target has no bookings', async () => {
    const db = fakeDb([[]])
    const r = await latestBookingFor(db, 'biz1', 'id1', 'Asia/Jerusalem', 'en')
    expect(r).toBeNull()
  })
})

describe('deriveLastName', () => {
  it('returns the last token of a multi-word name', () => {
    expect(deriveLastName('Guy Cohen')).toBe('Cohen')
    expect(deriveLastName('  Guy   Cohen  ')).toBe('Cohen')
    expect(deriveLastName('Mary Jane Watson')).toBe('Watson')
  })
  it('returns null for single-token, empty, or nullish names', () => {
    expect(deriveLastName('Guy')).toBeNull()
    expect(deriveLastName('')).toBeNull()
    expect(deriveLastName('   ')).toBeNull()
    expect(deriveLastName(null)).toBeNull()
    expect(deriveLastName(undefined)).toBeNull()
  })
})

import { resolveTargetForOwnerAction } from './customer-resolver.js'

const TZ = 'Asia/Jerusalem'
const row = (id: string, displayName: string, lastName: string | null, phone: string) =>
  ({ id, displayName, lastName, phoneNumber: phone })

describe('resolveTargetForOwnerAction', () => {
  it('phone given + found → resolved (no ambiguity ever for a phone)', async () => {
    const db = fakeDb([
      [row('c1', 'Guy', null, '+972500000001')],   // identity lookup by phone
      [],                                            // latestBookingFor → no bookings
    ])
    const r = await resolveTargetForOwnerAction(db, 'biz1', {
      role: 'customer', phoneNumber: '+972500000001', timezone: TZ, lang: 'en',
    })
    expect(r.status).toBe('resolved')
  })

  it('phone given + not on file → phone_unknown', async () => {
    const db = fakeDb([[]])
    const r = await resolveTargetForOwnerAction(db, 'biz1', {
      role: 'customer', phoneNumber: '+972500000009', timezone: TZ, lang: 'en',
    })
    expect(r).toEqual({ status: 'phone_unknown', phoneNumber: '+972500000009' })
  })

  it('name with one match → resolved', async () => {
    const db = fakeDb([
      [row('c1', 'Guy Cohen', 'Cohen', '+972500000001')],
      [{ slotStart: new Date('2026-03-03T12:00:00Z'), service: 'Haircut' }],
    ])
    const r = await resolveTargetForOwnerAction(db, 'biz1', {
      role: 'customer', name: 'Guy', timezone: TZ, lang: 'en',
    })
    expect(r.status).toBe('resolved')
    if (r.status === 'resolved') {
      expect(r.target.lastName).toBe('Cohen')
      expect(r.target.lastBooking?.service).toBe('Haircut')
    }
  })

  it('name with two matches → ambiguous with full candidate views', async () => {
    const db = fakeDb([
      [row('c1', 'Guy Cohen', 'Cohen', '+972500000001'), row('c2', 'Guy Levi', 'Levi', '+972500000002')],
      [{ slotStart: new Date('2026-03-03T12:00:00Z'), service: 'Haircut' }], // booking for c1
      [],                                                                     // booking for c2
    ])
    const r = await resolveTargetForOwnerAction(db, 'biz1', {
      role: 'customer', name: 'Guy', timezone: TZ, lang: 'en',
    })
    expect(r.status).toBe('ambiguous')
    if (r.status === 'ambiguous') {
      expect(r.candidates).toHaveLength(2)
      expect(r.candidates[0]).toMatchObject({ lastName: 'Cohen', phoneNumber: '+972500000001' })
      expect(r.candidates[1]).toMatchObject({ lastName: 'Levi', lastBooking: null })
    }
  })

  it('name with zero matches → not_found', async () => {
    const db = fakeDb([[]])
    const r = await resolveTargetForOwnerAction(db, 'biz1', {
      role: 'customer', name: 'Nobody', timezone: TZ, lang: 'en',
    })
    expect(r).toEqual({ status: 'not_found', query: 'Nobody' })
  })

  it('contact role never queries bookings (lastBooking always null)', async () => {
    const db = fakeDb([
      [row('k1', 'Guy Supplier', 'Supplier', '+972500000003')],
    ])
    const r = await resolveTargetForOwnerAction(db, 'biz1', {
      role: 'contact', name: 'Guy', timezone: TZ, lang: 'en',
    })
    expect(r.status).toBe('resolved')
    if (r.status === 'resolved') expect(r.target.lastBooking).toBeNull()
  })

  it('lastName narrows two matches down to one (re-entry after owner clarifies)', async () => {
    const db = fakeDb([
      [row('c1', 'Guy Cohen', 'Cohen', '+972500000001')], // DB already filtered by lastName
      [],
    ])
    const r = await resolveTargetForOwnerAction(db, 'biz1', {
      role: 'customer', name: 'Guy', lastName: 'Cohen', timezone: TZ, lang: 'en',
    })
    expect(r.status).toBe('resolved')
  })
})
