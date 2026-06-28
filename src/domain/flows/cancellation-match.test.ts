import { describe, it, expect } from 'vitest'
import { matchCancelBookings, weekdayFromText, type CancelBooking } from './cancellation-match.js'

const TZ = 'Asia/Jerusalem'

// Israel Daylight Time (UTC+3) in late June / early July 2026.
const BOOKINGS: CancelBooking[] = [
  { id: 'sun-yoga', slotStart: new Date('2026-06-28T07:00:00Z'), serviceTypeId: 'yoga', serviceName: 'יוגה' }, // Sun 10:00
  { id: 'mon-yoga', slotStart: new Date('2026-06-29T07:00:00Z'), serviceTypeId: 'yoga', serviceName: 'יוגה' }, // Mon 10:00
  { id: 'wed-pil', slotStart: new Date('2026-07-01T11:00:00Z'), serviceTypeId: 'pilates', serviceName: 'פילאטיס' }, // Wed 14:00
  { id: 'fri-yoga', slotStart: new Date('2026-07-03T09:00:00Z'), serviceTypeId: 'yoga', serviceName: 'יוגה' }, // Fri 12:00
]

describe('weekdayFromText', () => {
  it('parses Hebrew "יום <name>"', () => {
    expect(weekdayFromText('יום שישי ב12')).toBe(5)
    expect(weekdayFromText('תבדוק לי יום ראשון')).toBe(0)
  })
  it('parses English weekday names', () => {
    expect(weekdayFromText('cancel the Friday one')).toBe(5)
  })
  it('does NOT treat a bare Hebrew ordinal as a weekday (שני = "second")', () => {
    expect(weekdayFromText('השני')).toBeNull()
  })
  it('null when no weekday', () => {
    expect(weekdayFromText('ב12')).toBeNull()
  })
})

describe('matchCancelBookings', () => {
  it('uniquely matches day + time ("יום שישי ב12")', () => {
    const m = matchCancelBookings('יום שישי ב12', BOOKINGS, TZ)
    expect(m.map((b) => b.id)).toEqual(['fri-yoga'])
  })

  it('uniquely matches service + day ("יוגה ביום שישי")', () => {
    const m = matchCancelBookings('יוגה ביום שישי', BOOKINGS, TZ)
    expect(m.map((b) => b.id)).toEqual(['fri-yoga'])
  })

  it('narrows by service alone (pilates)', () => {
    const m = matchCancelBookings('תבטל את הפילאטיס', BOOKINGS, TZ)
    expect(m.map((b) => b.id)).toEqual(['wed-pil'])
  })

  it('narrows by time alone, possibly to several', () => {
    const m = matchCancelBookings('זה שב10', BOOKINGS, TZ)
    expect(m.map((b) => b.id).sort()).toEqual(['mon-yoga', 'sun-yoga'])
  })

  it('returns [] when the reply states no usable criterion', () => {
    expect(matchCancelBookings('כן', BOOKINGS, TZ)).toEqual([])
  })

  it('returns [] when a stated criterion matches nothing (no false pick)', () => {
    // Thursday — the customer has no Thursday booking.
    expect(matchCancelBookings('יום חמישי', BOOKINGS, TZ)).toEqual([])
  })
})
