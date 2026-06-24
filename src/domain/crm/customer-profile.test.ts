import { describe, it, expect } from 'vitest'
import { computeCustomerProfile, isLapsed, matchesSegment, type ProfileBooking } from './customer-profile.js'

const TZ = 'Asia/Jerusalem'

// Helper: a visit (confirmed/attended/no_show) at a given UTC instant.
const b = (iso: string, state: string, serviceTypeId = 'svc-a'): ProfileBooking => ({
  slotStart: new Date(iso),
  state,
  serviceTypeId,
})

describe('computeCustomerProfile', () => {
  it('empty history → zeroed profile', () => {
    const p = computeCustomerProfile([], TZ)
    expect(p.lifetimeBookings).toBe(0)
    expect(p.lastBookingAt).toBeNull()
    expect(p.cadenceDays).toBeNull()
    expect(p.preferredServiceTypeId).toBeNull()
    expect(p.preferredDayOfWeek).toBeNull()
    expect(p.preferredTimeBand).toBeNull()
    expect(p.noShowRate).toBe(0)
  })

  it('counts only visit-state bookings as lifetime visits', () => {
    const p = computeCustomerProfile(
      [b('2026-01-01T10:00:00Z', 'attended'), b('2026-02-01T10:00:00Z', 'confirmed'), b('2026-03-01T10:00:00Z', 'cancelled'), b('2026-03-02T10:00:00Z', 'inquiry')],
      TZ,
    )
    expect(p.lifetimeBookings).toBe(2) // attended + confirmed; cancelled/inquiry excluded
  })

  it('cadence is the median gap in days; last booking is the latest visit', () => {
    // visits 7 then 14 days apart → median gap 10.5 → rounded 11 (median of [7,14] = 10.5)
    const p = computeCustomerProfile(
      [b('2026-01-01T10:00:00Z', 'attended'), b('2026-01-08T10:00:00Z', 'attended'), b('2026-01-22T10:00:00Z', 'attended')],
      TZ,
    )
    expect(p.cadenceDays).toBe(11)
    expect(p.lastBookingAt).toEqual(new Date('2026-01-22T10:00:00Z'))
  })

  it('no-show rate is over completed appointments only', () => {
    const p = computeCustomerProfile(
      [b('2026-01-01T10:00:00Z', 'attended'), b('2026-01-08T10:00:00Z', 'no_show'), b('2026-01-15T10:00:00Z', 'confirmed')],
      TZ,
    )
    expect(p.attendedCount).toBe(1)
    expect(p.noShowCount).toBe(1)
    expect(p.noShowRate).toBe(0.5) // 1 / (1 attended + 1 no_show); confirmed not yet completed
  })

  it('preferred service is the modal service across visits', () => {
    const p = computeCustomerProfile(
      [b('2026-01-01T10:00:00Z', 'attended', 'yoga'), b('2026-01-08T10:00:00Z', 'attended', 'yoga'), b('2026-01-15T10:00:00Z', 'attended', 'pilates')],
      TZ,
    )
    expect(p.preferredServiceTypeId).toBe('yoga')
    expect(p.serviceTypeIds.sort()).toEqual(['pilates', 'yoga'])
  })

  it('preferred day-of-week and time band are business-local and modal', () => {
    // 2026-01-06 and 2026-01-13 are Tuesdays; 18:00 UTC = 20:00 Jerusalem (evening).
    const p = computeCustomerProfile(
      [b('2026-01-06T18:00:00Z', 'attended'), b('2026-01-13T18:00:00Z', 'attended')],
      TZ,
    )
    expect(p.preferredDayOfWeek).toBe(2) // Tue
    expect(p.preferredTimeBand).toBe('evening')
  })
})

describe('isLapsed', () => {
  const p = computeCustomerProfile(
    [b('2026-01-01T10:00:00Z', 'attended'), b('2026-01-15T10:00:00Z', 'attended')], // cadence 14
    TZ,
  )
  it('not lapsed within slack × cadence', () => {
    expect(isLapsed(p, new Date('2026-01-29T10:00:00Z'))).toBe(false) // 14d since, < 1.5×14=21
  })
  it('lapsed once past slack × cadence', () => {
    expect(isLapsed(p, new Date('2026-02-10T10:00:00Z'))).toBe(true) // 26d since, > 21
  })
  it('never lapsed without an established cadence', () => {
    const single = computeCustomerProfile([b('2026-01-01T10:00:00Z', 'attended')], TZ)
    expect(isLapsed(single, new Date('2030-01-01T10:00:00Z'))).toBe(false)
  })
})

describe('matchesSegment', () => {
  const now = new Date('2026-02-10T10:00:00Z')
  const p = computeCustomerProfile(
    [b('2026-01-01T10:00:00Z', 'attended', 'yoga'), b('2026-01-15T10:00:00Z', 'attended', 'yoga')],
    TZ,
  )
  it('hasBooking true matches a customer with visits', () => {
    expect(matchesSegment(p, { hasBooking: true }, now)).toBe(true)
    expect(matchesSegment(p, { hasBooking: false }, now)).toBe(false)
  })
  it('serviceTypeId matches by membership', () => {
    expect(matchesSegment(p, { serviceTypeId: 'yoga' }, now)).toBe(true)
    expect(matchesSegment(p, { serviceTypeId: 'pilates' }, now)).toBe(false)
  })
  it('inactiveSinceDays matches when last visit is older than the threshold', () => {
    expect(matchesSegment(p, { inactiveSinceDays: 14 }, now)).toBe(true) // 26d since last
    expect(matchesSegment(p, { inactiveSinceDays: 40 }, now)).toBe(false)
  })
  it('lapsed filter combines cadence + recency', () => {
    expect(matchesSegment(p, { lapsed: true }, now)).toBe(true)
    expect(matchesSegment(p, { lapsed: false }, now)).toBe(false)
  })
})
