import { describe, it, expect } from 'vitest'
import {
  addDaysToDateStr,
  resolveRequestedDate,
  resolveSlotStart,
  type RequestedDateParts,
} from './resolve-slot.js'
import { isSlotBookable, type AvailabilityModel } from './compute.js'

// Anchor "now" deterministically. 2026-06-07 is a Sunday in Asia/Jerusalem.
const TZ = 'Asia/Jerusalem'
const NOW = new Date('2026-06-07T09:00:00+03:00') // Sun 7 Jun 2026, 09:00 local

const empty: RequestedDateParts = { relativeDay: null, weekday: null, explicitDate: null }

describe('addDaysToDateStr', () => {
  it('adds across month and year boundaries', () => {
    expect(addDaysToDateStr('2026-06-07', 1)).toBe('2026-06-08')
    expect(addDaysToDateStr('2026-06-30', 2)).toBe('2026-07-02')
    expect(addDaysToDateStr('2026-12-31', 1)).toBe('2027-01-01')
  })
})

describe('resolveRequestedDate — relative days', () => {
  it('today / tomorrow / day_after_tomorrow anchor to business-local today', () => {
    expect(resolveRequestedDate({ ...empty, relativeDay: 'today' }, TZ, NOW)).toEqual({ ok: true, dateStr: '2026-06-07' })
    expect(resolveRequestedDate({ ...empty, relativeDay: 'tomorrow' }, TZ, NOW)).toEqual({ ok: true, dateStr: '2026-06-08' })
    // "מחרתיים" — day after tomorrow
    expect(resolveRequestedDate({ ...empty, relativeDay: 'day_after_tomorrow' }, TZ, NOW)).toEqual({ ok: true, dateStr: '2026-06-09' })
  })

  it('this_week / next_week with no weekday is ambiguous (clarify, never guess)', () => {
    expect(resolveRequestedDate({ ...empty, relativeDay: 'this_week' }, TZ, NOW)).toEqual({ ok: false, reason: 'ambiguous_date' })
    expect(resolveRequestedDate({ ...empty, relativeDay: 'next_week' }, TZ, NOW)).toEqual({ ok: false, reason: 'ambiguous_date' })
  })
})

describe('resolveRequestedDate — weekday', () => {
  it('resolves the nearest future occurrence (Tuesday from a Sunday → +2)', () => {
    // Tuesday = 2; today Sun = 0 → 2026-06-09
    expect(resolveRequestedDate({ ...empty, weekday: 2 }, TZ, NOW)).toEqual({ ok: true, dateStr: '2026-06-09' })
  })

  it('weekday === today resolves to today (time gate handles past-time separately)', () => {
    expect(resolveRequestedDate({ ...empty, weekday: 0 }, TZ, NOW)).toEqual({ ok: true, dateStr: '2026-06-07' })
  })

  it('next_week modifier pushes the occurrence a week out', () => {
    expect(resolveRequestedDate({ ...empty, weekday: 2, relativeDay: 'next_week' }, TZ, NOW)).toEqual({ ok: true, dateStr: '2026-06-16' })
  })
})

describe('resolveRequestedDate — explicit dates', () => {
  it('day+month with no year picks the nearest future occurrence', () => {
    // 9 June is in the future this year
    expect(resolveRequestedDate({ ...empty, explicitDate: { year: null, month: 6, day: 9 } }, TZ, NOW)).toEqual({ ok: true, dateStr: '2026-06-09' })
    // 1 January already passed this year → roll to next year
    expect(resolveRequestedDate({ ...empty, explicitDate: { year: null, month: 1, day: 1 } }, TZ, NOW)).toEqual({ ok: true, dateStr: '2027-01-01' })
  })

  it('REJECTS an explicit past year — the 10.01.2016 bug', () => {
    expect(resolveRequestedDate({ ...empty, explicitDate: { year: 2016, month: 1, day: 10 } }, TZ, NOW)).toEqual({ ok: false, reason: 'past_year' })
  })

  it('accepts an explicit future-or-current year date', () => {
    expect(resolveRequestedDate({ ...empty, explicitDate: { year: 2026, month: 12, day: 25 } }, TZ, NOW)).toEqual({ ok: true, dateStr: '2026-12-25' })
  })

  it('rejects impossible calendar dates (30 February)', () => {
    expect(resolveRequestedDate({ ...empty, explicitDate: { year: 2026, month: 2, day: 30 } }, TZ, NOW)).toEqual({ ok: false, reason: 'impossible_date' })
    expect(resolveRequestedDate({ ...empty, explicitDate: { year: null, month: 13, day: 1 } }, TZ, NOW)).toEqual({ ok: false, reason: 'impossible_date' })
  })
})

describe('resolveRequestedDate — nothing date-like', () => {
  it('returns no_date', () => {
    expect(resolveRequestedDate(empty, TZ, NOW)).toEqual({ ok: false, reason: 'no_date' })
  })
})

describe('deterministic gate — resolve + business-hours (the 5:00 AM bug)', () => {
  // Studio open 09:00–17:00 every day.
  const model: AvailabilityModel = {
    timezone: TZ,
    available247: false,
    weeklyHours: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, openTime: '09:00', closeTime: '17:00' })),
    dateOverrides: [],
    busy: [],
  }

  it('rejects 05:00 (before open) as outside_hours — never reaches confirmation', () => {
    const start = resolveSlotStart('2026-06-09', { hour: 5, minute: 0 }, TZ)
    const end = new Date(start.getTime() + 60 * 60_000)
    expect(isSlotBookable(model, { start, end })).toEqual({ bookable: false, reason: 'outside_hours' })
  })

  it('accepts 09:00 (open) as bookable', () => {
    const start = resolveSlotStart('2026-06-09', { hour: 9, minute: 0 }, TZ)
    const end = new Date(start.getTime() + 60 * 60_000)
    expect(isSlotBookable(model, { start, end })).toEqual({ bookable: true, reason: 'ok' })
  })
})

describe('resolveSlotStart — UTC composition', () => {
  it('composes a business-local date+time into the correct UTC instant', () => {
    // 2026-06-09 09:00 in Asia/Jerusalem (UTC+3 in June) → 06:00Z
    const start = resolveSlotStart('2026-06-09', { hour: 9, minute: 0 }, TZ)
    expect(start.toISOString()).toBe('2026-06-09T06:00:00.000Z')
  })

  it('handles a winter date across the DST boundary (UTC+2 in January)', () => {
    // 2026-01-10 08:00 in Asia/Jerusalem (UTC+2 in winter) → 06:00Z
    const start = resolveSlotStart('2026-01-10', { hour: 8, minute: 0 }, TZ)
    expect(start.toISOString()).toBe('2026-01-10T06:00:00.000Z')
  })
})
