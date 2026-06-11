import { describe, it, expect } from 'vitest'
import {
  addDaysToDateStr,
  resolveRequestedDate,
  resolveSlotStart,
  resolveSlotRange,
  isDstGap,
  type RequestedDateParts,
} from './resolve-slot.js'
import { isSlotBookable, getOpenSlots, localParts, type AvailabilityModel } from './compute.js'

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

describe('availability inquiry window — "is Monday open?" reports MONDAY, not Sunday', () => {
  // Studio open Sun/Mon/Tue 09:00–17:00 (the screenshot studio).
  const model: AvailabilityModel = {
    timezone: TZ,
    available247: false,
    weeklyHours: [0, 1, 2].map((d) => ({ dayOfWeek: d, openTime: '09:00', closeTime: '17:00' })),
    dateOverrides: [],
    busy: [],
  }

  it('resolves a Monday-scoped window and only returns Monday openings', () => {
    const resolved = resolveRequestedDate({ ...empty, weekday: 1 }, TZ, NOW) // Monday
    expect(resolved).toEqual({ ok: true, dateStr: '2026-06-08' })
    if (!resolved.ok) return
    const from = resolveSlotStart(resolved.dateStr, { hour: 0, minute: 0 }, TZ)
    const to = resolveSlotStart(addDaysToDateStr(resolved.dateStr, 1), { hour: 0, minute: 0 }, TZ)
    const slots = getOpenSlots(model, { start: from, end: to }, 60, { now: NOW, maxSlots: 6 })
    expect(slots.length).toBeGreaterThan(0)
    // Every returned slot must fall on Monday 2026-06-08 — never the parroted Sunday.
    for (const s of slots) {
      expect(localParts(s.start, TZ).dateStr).toBe('2026-06-08')
    }
  })
})

describe('isDstGap — spring-forward wall-clock that does not exist', () => {
  it('flags 02:30 on the Israeli spring-forward day (02:00→03:00)', () => {
    // 2027-03-26 is the Friday clocks jump forward; 02:30 does not exist.
    const start = resolveSlotStart('2027-03-26', { hour: 2, minute: 30 }, TZ)
    expect(isDstGap(start, { hour: 2, minute: 30 }, TZ)).toBe(true)
  })

  it('does NOT flag a normal time, summer or winter', () => {
    expect(isDstGap(resolveSlotStart('2026-06-09', { hour: 10, minute: 0 }, TZ), { hour: 10, minute: 0 }, TZ)).toBe(false)
    expect(isDstGap(resolveSlotStart('2026-01-10', { hour: 8, minute: 0 }, TZ), { hour: 8, minute: 0 }, TZ)).toBe(false)
    expect(isDstGap(resolveSlotStart('2027-03-26', { hour: 3, minute: 30 }, TZ), { hour: 3, minute: 30 }, TZ)).toBe(false)
  })
})

describe('resolveSlotRange — deterministic manager calendar writes', () => {
  it('resolves a clear weekday + start/end into the correct UTC range', () => {
    // Tuesday from a Sunday → 2026-06-09; 11:00–12:00 local (UTC+3 in June) → 08:00–09:00Z
    const r = resolveSlotRange(
      { date: { ...empty, weekday: 2 }, startTime: { hour: 11, minute: 0 }, endTime: { hour: 12, minute: 0 } },
      TZ, NOW,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.dateStr).toBe('2026-06-09')
    expect(r.start.toISOString()).toBe('2026-06-09T08:00:00.000Z')
    expect(r.end.toISOString()).toBe('2026-06-09T09:00:00.000Z')
  })

  it('derives end from durationMinutes when no endTime is given', () => {
    const r = resolveSlotRange(
      { date: { ...empty, relativeDay: 'tomorrow' }, startTime: { hour: 9, minute: 0 }, durationMinutes: 90 },
      TZ, NOW,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.end.getTime() - r.start.getTime()).toBe(90 * 60_000)
  })

  it('propagates date guards: past year, impossible date, ambiguous week', () => {
    expect(resolveSlotRange({ date: { ...empty, explicitDate: { year: 2016, month: 1, day: 10 } }, startTime: { hour: 10, minute: 0 }, endTime: { hour: 11, minute: 0 } }, TZ, NOW))
      .toEqual({ ok: false, reason: 'past_year' })
    expect(resolveSlotRange({ date: { ...empty, explicitDate: { year: 2026, month: 2, day: 30 } }, startTime: { hour: 10, minute: 0 }, endTime: { hour: 11, minute: 0 } }, TZ, NOW))
      .toEqual({ ok: false, reason: 'impossible_date' })
    expect(resolveSlotRange({ date: { ...empty, relativeDay: 'next_week' }, startTime: { hour: 10, minute: 0 }, endTime: { hour: 11, minute: 0 } }, TZ, NOW))
      .toEqual({ ok: false, reason: 'ambiguous_date' })
  })

  it('rejects a DST-gap start time', () => {
    expect(resolveSlotRange({ date: { ...empty, explicitDate: { year: 2027, month: 3, day: 26 } }, startTime: { hour: 2, minute: 30 }, endTime: { hour: 4, minute: 0 } }, TZ, NOW))
      .toEqual({ ok: false, reason: 'dst_gap' })
  })

  it('rejects end <= start and missing end', () => {
    expect(resolveSlotRange({ date: { ...empty, relativeDay: 'tomorrow' }, startTime: { hour: 12, minute: 0 }, endTime: { hour: 11, minute: 0 } }, TZ, NOW))
      .toEqual({ ok: false, reason: 'end_before_start' })
    expect(resolveSlotRange({ date: { ...empty, relativeDay: 'tomorrow' }, startTime: { hour: 12, minute: 0 } }, TZ, NOW))
      .toEqual({ ok: false, reason: 'no_time' })
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

// The whole point of the deterministic core is that resolution is anchored to the
// BUSINESS timezone, not UTC and not the server's zone. These cases use a zone far
// from Israel so a UTC/local confusion would visibly break them.
describe('cross-timezone resolution — anchored to business-local, not UTC', () => {
  const NY = 'America/New_York'
  const LA = 'America/Los_Angeles'

  it('composes the correct UTC instant in a western zone, summer and winter', () => {
    // 2026-06-09 09:00 EDT (UTC-4 in June) → 13:00Z
    expect(resolveSlotStart('2026-06-09', { hour: 9, minute: 0 }, NY).toISOString()).toBe('2026-06-09T13:00:00.000Z')
    // 2026-01-12 09:00 EST (UTC-5 in winter) → 14:00Z
    expect(resolveSlotStart('2026-01-12', { hour: 9, minute: 0 }, NY).toISOString()).toBe('2026-01-12T14:00:00.000Z')
  })

  it('anchors "today" to the business calendar day even when UTC has already rolled over', () => {
    // NOW is 2026-06-07T06:00:00Z. In Los Angeles (UTC-7, PDT) that is still
    // 23:00 on 2026-06-06 — so business-local "today" must be the 6th, not the 7th.
    expect(resolveRequestedDate({ ...empty, relativeDay: 'today' }, LA, NOW)).toEqual({ ok: true, dateStr: '2026-06-06' })
    // …and "tomorrow" follows from that local anchor.
    expect(resolveRequestedDate({ ...empty, relativeDay: 'tomorrow' }, LA, NOW)).toEqual({ ok: true, dateStr: '2026-06-07' })
  })

  it('resolveSlotRange yields a positive UTC range in a western zone', () => {
    const r = resolveSlotRange(
      { date: { ...empty, explicitDate: { year: 2026, month: 6, day: 9 } }, startTime: { hour: 9, minute: 0 }, endTime: { hour: 10, minute: 30 } },
      NY, NOW,
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.start.toISOString()).toBe('2026-06-09T13:00:00.000Z')
    expect(r.end.toISOString()).toBe('2026-06-09T14:30:00.000Z')
  })
})
