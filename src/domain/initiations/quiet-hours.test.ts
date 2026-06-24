import { describe, it, expect } from 'vitest'
import { isWithinQuietHours } from './quiet-hours.js'

// Fixed UTC instants. With tz 'UTC', local minute-of-day == UTC minute-of-day, so the
// window math is fully deterministic and tz-independent for these cases.
function utcAt(h: number, m: number): Date {
  return new Date(Date.UTC(2026, 5, 23, h, m, 0)) // 2026-06-23, month is 0-based
}

describe('isWithinQuietHours', () => {
  describe('normal window 09:00–17:00 (tz UTC)', () => {
    const w = { start: '09:00', end: '17:00' }
    it('12:00 → true (inside)', () => {
      expect(isWithinQuietHours(utcAt(12, 0), 'UTC', w)).toBe(true)
    })
    it('08:59 → false (before start)', () => {
      expect(isWithinQuietHours(utcAt(8, 59), 'UTC', w)).toBe(false)
    })
    it('17:00 → false (end exclusive)', () => {
      expect(isWithinQuietHours(utcAt(17, 0), 'UTC', w)).toBe(false)
    })
    it('09:00 → true (start inclusive)', () => {
      expect(isWithinQuietHours(utcAt(9, 0), 'UTC', w)).toBe(true)
    })
  })

  describe('wrap-around window 21:00–08:00 (tz UTC)', () => {
    const w = { start: '21:00', end: '08:00' }
    it('23:00 → true', () => {
      expect(isWithinQuietHours(utcAt(23, 0), 'UTC', w)).toBe(true)
    })
    it('02:00 → true', () => {
      expect(isWithinQuietHours(utcAt(2, 0), 'UTC', w)).toBe(true)
    })
    it('08:00 → false (end exclusive)', () => {
      expect(isWithinQuietHours(utcAt(8, 0), 'UTC', w)).toBe(false)
    })
    it('20:59 → false (before start)', () => {
      expect(isWithinQuietHours(utcAt(20, 59), 'UTC', w)).toBe(false)
    })
    it('21:00 → true (start inclusive)', () => {
      expect(isWithinQuietHours(utcAt(21, 0), 'UTC', w)).toBe(true)
    })
  })

  describe('degenerate / malformed windows', () => {
    it('start == end → false (empty window)', () => {
      expect(isWithinQuietHours(utcAt(10, 0), 'UTC', { start: '10:00', end: '10:00' })).toBe(false)
    })
    it('out-of-range hour 25:00 → false', () => {
      expect(isWithinQuietHours(utcAt(12, 0), 'UTC', { start: '25:00', end: '17:00' })).toBe(false)
    })
    it('non-numeric "abc" → false', () => {
      expect(isWithinQuietHours(utcAt(12, 0), 'UTC', { start: 'abc', end: '17:00' })).toBe(false)
    })
  })

  describe('timezone conversion (Asia/Jerusalem, June = UTC+3)', () => {
    const w = { start: '09:00', end: '17:00' }
    // 06:30 UTC is OUTSIDE the window in UTC, but 09:30 local in Asia/Jerusalem (UTC+3
    // in June DST) → INSIDE. Proves the window is evaluated in business-local time.
    it('06:30 UTC → false in UTC but true in Asia/Jerusalem', () => {
      expect(isWithinQuietHours(utcAt(6, 30), 'UTC', w)).toBe(false)
      expect(isWithinQuietHours(utcAt(6, 30), 'Asia/Jerusalem', w)).toBe(true)
    })
  })
})
