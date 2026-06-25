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
