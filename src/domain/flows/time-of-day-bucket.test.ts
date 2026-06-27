import { describe, it, expect } from 'vitest'
import { startInBucket } from './customer-booking.js'

// Asia/Jerusalem is UTC+3 (IDT) in late June, so local HH:00 = (HH-3):00 UTC.
const TZ = 'Asia/Jerusalem'
const at = (localHour: number, localMinute = 0): Date =>
  new Date(Date.UTC(2026, 5, 29, localHour - 3, localMinute)) // 2026-06-29

describe('startInBucket — business part-of-day definitions', () => {
  it('morning is [opening, 12:00) — 12:00 start is NOT morning', () => {
    expect(startInBucket(at(9, 0), TZ, 'morning')).toBe(true)
    expect(startInBucket(at(11, 59), TZ, 'morning')).toBe(true)
    expect(startInBucket(at(12, 0), TZ, 'morning')).toBe(false)
  })

  it('afternoon is [12:00, 18:00)', () => {
    expect(startInBucket(at(12, 0), TZ, 'afternoon')).toBe(true)
    expect(startInBucket(at(17, 59), TZ, 'afternoon')).toBe(true)
    expect(startInBucket(at(18, 0), TZ, 'afternoon')).toBe(false)
  })

  it('evening is [18:00, closing] — 18:00 start IS evening', () => {
    expect(startInBucket(at(18, 0), TZ, 'evening')).toBe(true)
    expect(startInBucket(at(19, 30), TZ, 'evening')).toBe(true)
    expect(startInBucket(at(17, 0), TZ, 'evening')).toBe(false)
  })

  it("the studio's actual Monday classes bucket correctly", () => {
    // Yoga/Pilates run hourly 09:00–18:00. Evening should yield ONLY the 18:00 start.
    const starts = [9, 10, 11, 12, 14, 16, 18]
    const evening = starts.filter((h) => startInBucket(at(h, 0), TZ, 'evening'))
    expect(evening).toEqual([18])
    const morning = starts.filter((h) => startInBucket(at(h, 0), TZ, 'morning'))
    expect(morning).toEqual([9, 10, 11]) // 12:00 excluded
  })
})
