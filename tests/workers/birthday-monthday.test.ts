import { describe, it, expect } from 'vitest'
import { localMonthDay } from '../../src/workers/birthday.js'

// localMonthDay derives the business-local "MM-DD" + year used to match identities.birthday
// (stored 'YYYY-MM-DD', year not meaningful). The detector compares birthday.slice(5) to monthDay.
describe('localMonthDay', () => {
  it('formats month+day and year in the business timezone', () => {
    const { monthDay, year } = localMonthDay(new Date('2026-06-24T09:00:00Z'), 'Asia/Jerusalem')
    expect(monthDay).toBe('06-24')
    expect(year).toBe('2026')
  })

  it('rolls to the next local day when UTC is still the prior day', () => {
    // 22:30 UTC is 01:30 next-day in Jerusalem (UTC+3 in June).
    const { monthDay } = localMonthDay(new Date('2026-06-24T22:30:00Z'), 'Asia/Jerusalem')
    expect(monthDay).toBe('06-25')
  })

  it('matches a stored birthday by month+day regardless of stored year', () => {
    const { monthDay } = localMonthDay(new Date('2026-06-24T09:00:00Z'), 'Asia/Jerusalem')
    const storedBirthday = '1990-06-24' // a date column value
    expect(storedBirthday.slice(5)).toBe(monthDay)
    expect('1990-06-25'.slice(5)).not.toBe(monthDay)
  })
})
