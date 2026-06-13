import { describe, it, expect } from 'vitest'
import { expandSeries, type SeriesDefinition } from '../../src/domain/scheduling/series.js'

// Validates the pure recurrence expander (PLAN Track 1A). DB-bound
// materializeSeries idempotency is covered in the integration suite.

const NY = 'America/New_York'
const JLM = 'Asia/Jerusalem'

// Decompose an absolute Date back into local {date, hour, minute} for assertions.
function localOf(d: Date, tz: string): { date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  const h = parseInt(get('hour'), 10)
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: h === 24 ? 0 : h, minute: parseInt(get('minute'), 10) }
}

function mondaySeries(overrides: Partial<SeriesDefinition> = {}): SeriesDefinition {
  return {
    dayOfWeek: 1, // Monday
    startTime: '10:00',
    durationMinutes: 60,
    startDate: '2026-01-05', // a Monday
    endDate: null,
    timezone: JLM,
    ...overrides,
  }
}

describe('expandSeries', () => {
  it('expands a weekly series to one occurrence per matching weekday', () => {
    const occ = expandSeries(mondaySeries(), { horizonFrom: '2026-01-01', horizonTo: '2026-02-28' })
    // Mondays Jan 5,12,19,26; Feb 2,9,16,23 = 8
    expect(occ.length).toBe(8)
    expect(occ[0]!.occurrenceDate).toBe('2026-01-05')
    expect(occ.at(-1)!.occurrenceDate).toBe('2026-02-23')
    // every occurrence is a Monday at 10:00 local and 60 minutes long
    for (const o of occ) {
      const l = localOf(o.startTs, JLM)
      expect(l.hour).toBe(10)
      expect(l.minute).toBe(0)
      expect(o.endTs.getTime() - o.startTs.getTime()).toBe(60 * 60_000)
    }
  })

  it('keeps local clock time stable across a DST transition (10:00 stays 10:00)', () => {
    // US DST springs forward Sun 2026-03-08. A Monday 10:00 class in NY must stay
    // 10:00 local on both the pre- and post-transition Mondays even though the UTC
    // offset changes from -05:00 to -04:00.
    const occ = expandSeries(mondaySeries({ timezone: NY, startDate: '2026-03-02' }), {
      horizonFrom: '2026-03-01',
      horizonTo: '2026-03-20',
    })
    const dates = occ.map((o) => o.occurrenceDate)
    expect(dates).toContain('2026-03-02') // before DST (EST)
    expect(dates).toContain('2026-03-09') // after DST (EDT)
    for (const o of occ) expect(localOf(o.startTs, NY).hour).toBe(10)
    // and the UTC instants differ by the offset shift, proving it's not naive +7d
    const pre = occ.find((o) => o.occurrenceDate === '2026-03-02')!
    const post = occ.find((o) => o.occurrenceDate === '2026-03-09')!
    const naiveWeek = 7 * 86_400_000
    expect(post.startTs.getTime() - pre.startTs.getTime()).toBe(naiveWeek - 3_600_000)
  })

  it('skips excepted occurrence dates but continues the series', () => {
    const occ = expandSeries(mondaySeries(), {
      horizonFrom: '2026-01-01',
      horizonTo: '2026-01-31',
      exceptionDates: ['2026-01-12'],
    })
    const dates = occ.map((o) => o.occurrenceDate)
    expect(dates).toEqual(['2026-01-05', '2026-01-19', '2026-01-26'])
  })

  it('is idempotent — already-materialized dates are not re-emitted', () => {
    const occ = expandSeries(mondaySeries(), {
      horizonFrom: '2026-01-01',
      horizonTo: '2026-01-31',
      existingDates: ['2026-01-05', '2026-01-12'],
    })
    expect(occ.map((o) => o.occurrenceDate)).toEqual(['2026-01-19', '2026-01-26'])
  })

  it('respects endDate (no occurrences after the series ends)', () => {
    const occ = expandSeries(mondaySeries({ endDate: '2026-01-19' }), {
      horizonFrom: '2026-01-01',
      horizonTo: '2026-03-01',
    })
    expect(occ.map((o) => o.occurrenceDate)).toEqual(['2026-01-05', '2026-01-12', '2026-01-19'])
  })

  it('starts at startDate even when the horizon opens earlier', () => {
    const occ = expandSeries(mondaySeries({ startDate: '2026-01-19' }), {
      horizonFrom: '2026-01-01',
      horizonTo: '2026-01-31',
    })
    expect(occ[0]!.occurrenceDate).toBe('2026-01-19')
  })

  it('returns nothing when the series window is entirely outside the horizon', () => {
    const occ = expandSeries(mondaySeries({ startDate: '2026-06-01' }), {
      horizonFrom: '2026-01-01',
      horizonTo: '2026-02-01',
    })
    expect(occ).toEqual([])
  })
})
