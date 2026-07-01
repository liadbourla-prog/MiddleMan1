/**
 * T1.2 (pure parts) — the two deterministic certainty helpers used by the
 * inbound-translator classifier:
 *   - parseStructuredClassMarker: reads a MACHINE-READABLE description convention
 *     ("class: <service>; capacity: <n>"). Free-text prose is explicitly NOT a
 *     marker — an implied head-count like "2/8 booked" is NEVER trusted.
 *   - localWeekday: the business-local weekday of a UTC instant (0=Sun), so the
 *     template-match certainty signal ("Sunday already runs Pilates") is timezone-correct.
 */
import { describe, it, expect } from 'vitest'
import { parseStructuredClassMarker, localWeekday, hasNegativeMarker, hasOccupancyProse } from './classify.js'

describe('parseStructuredClassMarker', () => {
  it('parses "class: <service>; capacity: <n>"', () => {
    expect(parseStructuredClassMarker('class: Pilates; capacity: 8')).toEqual({ serviceName: 'Pilates', capacity: 8 })
  })

  it('parses the marker with no capacity clause (capacity null)', () => {
    expect(parseStructuredClassMarker('class: Pilates')).toEqual({ serviceName: 'Pilates', capacity: null })
  })

  it('is case-insensitive on the keys and tolerates surrounding text/whitespace', () => {
    expect(parseStructuredClassMarker('Notes\nCLASS:  Yoga ;  CAPACITY: 12\nmore')).toEqual({ serviceName: 'Yoga', capacity: 12 })
  })

  it('does NOT treat free-text prose as a marker (the "2/8 booked" repro)', () => {
    expect(parseStructuredClassMarker('Pilates evening — 2/8 booked, walk-ins ok')).toBeNull()
    expect(parseStructuredClassMarker('great class today!')).toBeNull()
    expect(parseStructuredClassMarker(null)).toBeNull()
    expect(parseStructuredClassMarker('')).toBeNull()
  })

  it('ignores a non-numeric / non-positive capacity (falls back to null, never a bad number)', () => {
    expect(parseStructuredClassMarker('class: Pilates; capacity: lots')).toEqual({ serviceName: 'Pilates', capacity: null })
    expect(parseStructuredClassMarker('class: Pilates; capacity: 0')).toEqual({ serviceName: 'Pilates', capacity: null })
  })
})

describe('hasNegativeMarker', () => {
  it('vetoes on an EN private/closed marker as a whole token (title or description)', () => {
    expect(hasNegativeMarker('Private Pilates', null)).toBe(true)
    expect(hasNegativeMarker('Pilates', 'closed session, staff only')).toBe(true)
    expect(hasNegativeMarker('Pilates', 'blocked')).toBe(true)
    expect(hasNegativeMarker('personal', null)).toBe(true)
    expect(hasNegativeMarker('Pilates (hold)', null)).toBe(true)
    expect(hasNegativeMarker('Pilates', 'cancelled')).toBe(true)
    expect(hasNegativeMarker('Pilates', 'canceled')).toBe(true)
  })

  it('vetoes on a multi-word EN phrase ("do not book")', () => {
    expect(hasNegativeMarker('Pilates', 'do not book — invite only')).toBe(true)
  })

  it('vetoes on HE private/closed markers', () => {
    expect(hasNegativeMarker('פילאטיס פרטי', null)).toBe(true) // private
    expect(hasNegativeMarker('פילאטיס', 'סגור')).toBe(true) // closed
    expect(hasNegativeMarker('פילאטיס', 'חסום')).toBe(true) // blocked
    expect(hasNegativeMarker('אישי', null)).toBe(true) // personal
    expect(hasNegativeMarker('פילאטיס', 'מבוטל')).toBe(true) // cancelled
    expect(hasNegativeMarker('פילאטיס', 'ביטול')).toBe(true) // cancellation
    expect(hasNegativeMarker('פילאטיס', 'לא לקבוע')).toBe(true) // do not schedule (phrase)
  })

  it('does NOT veto a clean class title/description, and never on a partial-word substring', () => {
    expect(hasNegativeMarker('Pilates', null)).toBe(false)
    expect(hasNegativeMarker('Evening Pilates', 'walk-ins welcome')).toBe(false)
    // "household"/"stronghold" contain "hold" but must NOT trip the single-token marker.
    expect(hasNegativeMarker('household budgeting', null)).toBe(false)
    expect(hasNegativeMarker(null, null)).toBe(false)
  })
})

describe('hasOccupancyProse', () => {
  it('vetoes on an N/M head-count pattern (never trust a Google count)', () => {
    expect(hasOccupancyProse('regular class, 2/8 booked')).toBe(true)
    expect(hasOccupancyProse('spots 2 / 8')).toBe(true)
  })

  it('vetoes on occupancy words (EN + HE)', () => {
    expect(hasOccupancyProse('fully booked tonight')).toBe(true)
    expect(hasOccupancyProse('נרשמו 5 אנשים')).toBe(true) // registered
    expect(hasOccupancyProse('השיעור תפוס')).toBe(true) // occupied
    expect(hasOccupancyProse('מלא')).toBe(true) // full
  })

  it('does NOT veto a clean or absent description', () => {
    expect(hasOccupancyProse('evening class, walk-ins ok')).toBe(false)
    expect(hasOccupancyProse('class: Pilates; capacity: 8')).toBe(false)
    expect(hasOccupancyProse(null)).toBe(false)
    expect(hasOccupancyProse('')).toBe(false)
  })
})

describe('localWeekday', () => {
  it('returns the business-local weekday (0=Sun) of a UTC instant', () => {
    // 2026-07-05T19:00:00Z is a Sunday in UTC and in Asia/Jerusalem (22:00 local).
    expect(localWeekday(new Date('2026-07-05T19:00:00Z'), 'Asia/Jerusalem')).toBe(0)
    // 2026-07-06T05:00:00Z is Monday.
    expect(localWeekday(new Date('2026-07-06T05:00:00Z'), 'Asia/Jerusalem')).toBe(1)
  })

  it('respects the timezone across the date boundary', () => {
    // 2026-07-06T00:30:00Z is Monday in UTC but still Sunday 21:30 in America/New_York.
    expect(localWeekday(new Date('2026-07-06T00:30:00Z'), 'UTC')).toBe(1)
    expect(localWeekday(new Date('2026-07-06T00:30:00Z'), 'America/New_York')).toBe(0)
  })
})
