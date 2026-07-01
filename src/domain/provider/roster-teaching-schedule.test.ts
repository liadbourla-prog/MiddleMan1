/**
 * T1.5 — imported-class visibility in the teaching-schedule FAQ (R4).
 *
 * loadTeachingSchedule feeds the "who teaches what" FAQ. The old INNER JOIN on
 * providerId silently dropped a materialized `type='class'` block whose providerId is
 * null (an owner-imported class with no assigned instructor), so it never appeared in the
 * FAQ. Fix: LEFT JOIN + surface "instructor TBD" — the class is visible, the missing
 * instructor is stated honestly (never fabricated).
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
    for (const m of ['where', 'leftJoin', 'innerJoin', 'orderBy']) chain[m] = () => chain
    chain['then'] = (resolve: (v: unknown) => unknown) => {
      if (state.table === 'calendar_blocks') return resolve(h.rows)
      return resolve([])
    }
    return chain
  }
  return { db: { select: () => makeSelectChain() } }
})

import { db } from '../../db/client.js'
import { loadTeachingSchedule, buildTeachingScheduleBlock } from './roster.js'

const NOW = new Date('2026-07-01T00:00:00Z')

beforeEach(() => { h.rows = [] })

describe('T1.5 loadTeachingSchedule — null-provider imported class is visible', () => {
  it('keeps a class whose providerId is null (LEFT JOIN), surfacing instructor=null', async () => {
    h.rows = [
      { providerId: 'p1', instructor: 'Dana', service: 'Yoga', startTs: new Date('2026-07-06T10:00:00Z') }, // Mon 10:00
      { providerId: null, instructor: null, service: 'Pilates', startTs: new Date('2026-07-07T09:00:00Z') }, // Tue 09:00, imported
    ]

    const slots = await loadTeachingSchedule(db, 'biz-1', 'UTC', 7, NOW)

    // Both classes present — the null-provider one is NO LONGER dropped.
    expect(slots).toHaveLength(2)
    const pilates = slots.find((s) => s.service === 'Pilates')
    expect(pilates).toBeDefined()
    expect(pilates!.providerId).toBeNull()
    expect(pilates!.instructor).toBeNull()
    expect(pilates!.dayOfWeek).toBe(2)
    expect(pilates!.startTime).toBe('09:00')
  })

  it('a class with no linked SERVICE is still skipped (unchanged)', async () => {
    h.rows = [{ providerId: null, instructor: null, service: null, startTs: new Date('2026-07-07T09:00:00Z') }]
    const slots = await loadTeachingSchedule(db, 'biz-1', 'UTC', 7, NOW)
    expect(slots).toHaveLength(0)
  })
})

describe('T1.5 buildTeachingScheduleBlock — renders null instructor as "instructor TBD"', () => {
  it('groups a null-instructor class under a localized TBD label, never fabricating a name', () => {
    const block = buildTeachingScheduleBlock([
      { providerId: 'p1', instructor: 'Dana', service: 'Yoga', dayOfWeek: 1, startTime: '10:00' },
      { providerId: null, instructor: null, service: 'Pilates', dayOfWeek: 2, startTime: '09:00' },
    ], 'en')
    expect(block).toContain('Dana: Yoga Mon 10:00')
    expect(block).toContain('instructor TBD: Pilates Tue 09:00')
    expect(block).not.toContain('null')
  })

  it('renders a Hebrew TBD label under he', () => {
    const block = buildTeachingScheduleBlock([
      { providerId: null, instructor: null, service: 'Pilates', dayOfWeek: 2, startTime: '09:00' },
    ], 'he')
    expect(block).not.toContain('null')
    expect(block).not.toContain('instructor TBD') // localized, not the English literal
  })
})
