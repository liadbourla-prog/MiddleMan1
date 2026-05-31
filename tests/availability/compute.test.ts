import { describe, it, expect } from 'vitest'
import {
  type AvailabilityModel,
  dayWindow,
  getOpenSlots,
  isSlotBookable,
  localParts,
  localTimeToUtc,
} from '../../src/domain/availability/compute.js'

// All scenarios use a real IANA zone with DST (America/New_York) plus a fixed
// zone (Asia/Jerusalem) to prove the timezone math is not server-local.

const NY = 'America/New_York'

function baseModel(overrides: Partial<AvailabilityModel> = {}): AvailabilityModel {
  return {
    timezone: NY,
    available247: false,
    weeklyHours: [
      // Mon–Fri 09:00–17:00
      { dayOfWeek: 1, openTime: '09:00', closeTime: '17:00' },
      { dayOfWeek: 2, openTime: '09:00', closeTime: '17:00' },
      { dayOfWeek: 3, openTime: '09:00', closeTime: '17:00' },
      { dayOfWeek: 4, openTime: '09:00', closeTime: '17:00' },
      { dayOfWeek: 5, openTime: '09:00', closeTime: '17:00' },
    ],
    dateOverrides: [],
    busy: [],
    ...overrides,
  }
}

// Helper: build a UTC Date from a local wall-clock time in a tz.
const at = (date: string, time: string, tz = NY) => localTimeToUtc(date, time, tz)

describe('localParts', () => {
  it('decomposes an absolute Date into business-local fields', () => {
    // 2026-06-01 is a Monday. 14:30 local in NY (EDT, UTC-4) = 18:30 UTC.
    const utc = new Date('2026-06-01T18:30:00Z')
    const p = localParts(utc, NY)
    expect(p.dateStr).toBe('2026-06-01')
    expect(p.dayOfWeek).toBe(1) // Monday
    expect(p.minutes).toBe(14 * 60 + 30)
  })

  it('rolls into the correct local date across the UTC boundary', () => {
    // 03:30 UTC on Jun 2 is 23:30 local on Jun 1 in NY.
    const utc = new Date('2026-06-02T03:30:00Z')
    const p = localParts(utc, NY)
    expect(p.dateStr).toBe('2026-06-01')
    expect(p.minutes).toBe(23 * 60 + 30)
  })
})

describe('localTimeToUtc', () => {
  it('round-trips with localParts under DST', () => {
    const utc = at('2026-07-15', '10:00')
    const p = localParts(utc, NY)
    expect(p.dateStr).toBe('2026-07-15')
    expect(p.minutes).toBe(10 * 60)
  })

  it('honours a non-DST winter offset', () => {
    // January: NY is EST (UTC-5). 09:00 local = 14:00 UTC.
    const utc = at('2026-01-15', '09:00')
    expect(utc.toISOString()).toBe('2026-01-15T14:00:00.000Z')
  })
})

describe('dayWindow', () => {
  it('returns the weekly window for an in-schedule weekday', () => {
    const w = dayWindow(baseModel(), '2026-06-01', 1)
    expect(w).toEqual({ openMin: 9 * 60, closeMin: 17 * 60 })
  })

  it('returns null for a day with no weekly rule', () => {
    expect(dayWindow(baseModel(), '2026-06-07', 0)).toBeNull() // Sunday
  })

  it('specific-date block overrides the weekly rule', () => {
    const m = baseModel({
      dateOverrides: [{ date: '2026-06-01', isBlocked: true, openTime: null, closeTime: null }],
    })
    expect(dayWindow(m, '2026-06-01', 1)).toBeNull()
  })

  it('specific-date custom hours override the weekly rule', () => {
    const m = baseModel({
      dateOverrides: [{ date: '2026-06-01', isBlocked: false, openTime: '12:00', closeTime: '14:00' }],
    })
    expect(dayWindow(m, '2026-06-01', 1)).toEqual({ openMin: 12 * 60, closeMin: 14 * 60 })
  })

  it('unblocked override with no hours = open all day', () => {
    const m = baseModel({
      dateOverrides: [{ date: '2026-06-07', isBlocked: false, openTime: null, closeTime: null }],
    })
    expect(dayWindow(m, '2026-06-07', 0)).toEqual({ openMin: 0, closeMin: 24 * 60 })
  })

  it('24/7 opens every day, but specific-date block still wins', () => {
    const m = baseModel({ available247: true })
    expect(dayWindow(m, '2026-06-07', 0)).toEqual({ openMin: 0, closeMin: 24 * 60 })
    const blocked = baseModel({
      available247: true,
      dateOverrides: [{ date: '2026-06-07', isBlocked: true, openTime: null, closeTime: null }],
    })
    expect(dayWindow(blocked, '2026-06-07', 0)).toBeNull()
  })
})

describe('isSlotBookable', () => {
  it('accepts a slot fully inside working hours with no conflicts', () => {
    const r = isSlotBookable(baseModel(), { start: at('2026-06-01', '10:00'), end: at('2026-06-01', '11:00') })
    expect(r).toEqual({ bookable: true, reason: 'ok' })
  })

  it('rejects a zero-length / inverted slot', () => {
    const t = at('2026-06-01', '10:00')
    expect(isSlotBookable(baseModel(), { start: t, end: t }).reason).toBe('invalid_slot')
  })

  it('rejects a slot starting before opening', () => {
    const r = isSlotBookable(baseModel(), { start: at('2026-06-01', '08:30'), end: at('2026-06-01', '09:30') })
    expect(r.reason).toBe('outside_hours')
  })

  it('rejects a slot ending after closing', () => {
    const r = isSlotBookable(baseModel(), { start: at('2026-06-01', '16:30'), end: at('2026-06-01', '17:30') })
    expect(r.reason).toBe('outside_hours')
  })

  it('rejects a slot on a closed day', () => {
    const r = isSlotBookable(baseModel(), { start: at('2026-06-07', '10:00'), end: at('2026-06-07', '11:00') })
    expect(r.reason).toBe('outside_hours')
  })

  it('rejects a slot overlapping a busy interval', () => {
    const m = baseModel({ busy: [{ start: at('2026-06-01', '10:30'), end: at('2026-06-01', '11:30') }] })
    const r = isSlotBookable(m, { start: at('2026-06-01', '10:00'), end: at('2026-06-01', '11:00') })
    expect(r.reason).toBe('busy')
  })

  it('allows a slot exactly abutting a busy interval (no overlap)', () => {
    const m = baseModel({ busy: [{ start: at('2026-06-01', '11:00'), end: at('2026-06-01', '12:00') }] })
    const r = isSlotBookable(m, { start: at('2026-06-01', '10:00'), end: at('2026-06-01', '11:00') })
    expect(r.bookable).toBe(true)
  })

  it('allows a 24/7 slot ending exactly at local midnight', () => {
    const m = baseModel({ available247: true })
    const r = isSlotBookable(m, { start: at('2026-06-01', '23:00'), end: at('2026-06-02', '00:00') })
    expect(r.bookable).toBe(true)
  })

  it('rejects a slot genuinely spanning past midnight', () => {
    const m = baseModel({ available247: true })
    const r = isSlotBookable(m, { start: at('2026-06-01', '23:00'), end: at('2026-06-02', '01:00') })
    expect(r.reason).toBe('outside_hours')
  })
})

describe('getOpenSlots', () => {
  const NOW = new Date('2026-06-01T00:00:00Z') // before the working day starts

  it('enumerates 60-min slots across the open window at 30-min steps', () => {
    const slots = getOpenSlots(
      baseModel(),
      { start: at('2026-06-01', '09:00'), end: at('2026-06-01', '17:00') },
      60,
      { now: NOW, stepMinutes: 60, maxSlots: 100 },
    )
    // 09–17 with 60-min slots at 60-min steps => starts 09..16 = 8 slots.
    expect(slots).toHaveLength(8)
    expect(localParts(slots[0]!.start, NY).minutes).toBe(9 * 60)
    expect(localParts(slots.at(-1)!.start, NY).minutes).toBe(16 * 60)
  })

  it('skips slots that collide with busy intervals', () => {
    const m = baseModel({ busy: [{ start: at('2026-06-01', '10:00'), end: at('2026-06-01', '12:00') }] })
    const slots = getOpenSlots(
      m,
      { start: at('2026-06-01', '09:00'), end: at('2026-06-01', '17:00') },
      60,
      { now: NOW, stepMinutes: 60, maxSlots: 100 },
    )
    const startMins = slots.map((s) => localParts(s.start, NY).minutes)
    expect(startMins).not.toContain(10 * 60)
    expect(startMins).not.toContain(11 * 60)
    expect(startMins).toContain(9 * 60)
    expect(startMins).toContain(12 * 60)
  })

  it('respects maxSlots cap', () => {
    const slots = getOpenSlots(
      baseModel(),
      { start: at('2026-06-01', '09:00'), end: at('2026-06-01', '17:00') },
      30,
      { now: NOW, stepMinutes: 30, maxSlots: 3 },
    )
    expect(slots).toHaveLength(3)
  })

  it('excludes slots starting before now', () => {
    const lateNow = at('2026-06-01', '14:00') // 2pm local
    const slots = getOpenSlots(
      baseModel(),
      { start: at('2026-06-01', '09:00'), end: at('2026-06-01', '17:00') },
      60,
      { now: lateNow, stepMinutes: 60, maxSlots: 100 },
    )
    for (const s of slots) {
      expect(s.start.getTime()).toBeGreaterThanOrEqual(lateNow.getTime())
    }
    expect(localParts(slots[0]!.start, NY).minutes).toBe(14 * 60)
  })

  it('spans multiple days, skipping closed weekend days', () => {
    // Fri 2026-06-05 .. Mon 2026-06-08; Sat/Sun closed.
    const slots = getOpenSlots(
      baseModel(),
      { start: at('2026-06-05', '09:00'), end: at('2026-06-08', '17:00') },
      60,
      { now: new Date('2026-06-05T00:00:00Z'), stepMinutes: 60, maxSlots: 100 },
    )
    const dates = new Set(slots.map((s) => localParts(s.start, NY).dateStr))
    expect(dates.has('2026-06-05')).toBe(true) // Fri
    expect(dates.has('2026-06-08')).toBe(true) // Mon
    expect(dates.has('2026-06-06')).toBe(false) // Sat
    expect(dates.has('2026-06-07')).toBe(false) // Sun
  })

  it('returns empty when duration exceeds the window', () => {
    const slots = getOpenSlots(
      baseModel(),
      { start: at('2026-06-01', '09:00'), end: at('2026-06-01', '17:00') },
      600, // 10h > 8h window
      { now: NOW },
    )
    expect(slots).toHaveLength(0)
  })
})
