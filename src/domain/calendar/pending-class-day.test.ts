/**
 * Finding 3 — surface a pending imported class on a DAY / any-time inquiry (not only a
 * specific-time ask). findPendingImportedClassesForDay returns the pending imported classes
 * (opaque type='block' google_import rows carrying a serviceTypeId marker) that START inside a
 * day window, optionally narrowed to a named service. These are surfaced as "tentative —
 * confirming with the studio", NEVER as bookable (they stay type='block').
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getTableName } from 'drizzle-orm'

const h = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }))

vi.mock('../../db/client.js', () => {
  function tableName(t: unknown): string { try { return getTableName(t as never) } catch { return 'unknown' } }
  function makeSelectChain() {
    const state = { table: 'unknown' }
    const chain: Record<string, unknown> = {}
    chain['from'] = (t: unknown) => { state.table = tableName(t); return chain }
    for (const m of ['where', 'orderBy']) chain[m] = () => chain
    chain['then'] = (resolve: (v: unknown) => unknown) => {
      if (state.table === 'calendar_blocks') return resolve(h.rows)
      return resolve([])
    }
    return chain
  }
  return { db: { select: () => makeSelectChain() } }
})

import { db } from '../../db/client.js'
import { findPendingImportedClassesForDay } from './imported-class.js'

const FROM = new Date('2026-07-05T00:00:00Z')
const TO = new Date('2026-07-06T00:00:00Z')

beforeEach(() => { h.rows = [] })

describe('Finding 3 — findPendingImportedClassesForDay', () => {
  it('returns pending imported classes with a serviceTypeId marker', async () => {
    h.rows = [
      { id: 'blk-1', serviceTypeId: 'svc-pilates', startTs: new Date('2026-07-05T19:00:00Z'), endTs: new Date('2026-07-05T20:00:00Z'), maxParticipants: 8 },
    ]
    const out = await findPendingImportedClassesForDay(db, 'biz-1', FROM, TO)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ serviceTypeId: 'svc-pilates' })
    expect(out[0]!.startTs).toEqual(new Date('2026-07-05T19:00:00Z'))
  })

  it('drops rows with a null serviceTypeId (a plain opaque block is never a pending class)', async () => {
    h.rows = [{ id: 'blk-x', serviceTypeId: null, startTs: new Date('2026-07-05T19:00:00Z'), endTs: new Date('2026-07-05T20:00:00Z'), maxParticipants: null }]
    const out = await findPendingImportedClassesForDay(db, 'biz-1', FROM, TO)
    expect(out).toHaveLength(0)
  })
})
