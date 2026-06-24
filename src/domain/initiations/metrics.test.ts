import { describe, it, expect } from 'vitest'
import { northStarLines, ownerDigestLines } from './metrics.js'

describe('northStarLines', () => {
  it('renders both lines with interpolated numbers when bookings and OAU are nonzero (he)', () => {
    const result = northStarLines(5, 3, 'he')
    expect(result).toContain('*5*')
    expect(result).toContain('*3*')
    expect(result).toContain('השבוע')
    expect(result).toContain('הייתי צריך אותך')
  })

  it('renders both lines with interpolated numbers when bookings and OAU are nonzero (en)', () => {
    const result = northStarLines(5, 3, 'en')
    expect(result).toContain('*5*')
    expect(result).toContain('*3*')
    expect(result).toContain('This week')
    expect(result).toContain('I needed your input')
  })

  it('celebrates the zero-OAU case without a number (he)', () => {
    const result = northStarLines(7, 0, 'he')
    expect(result).toContain('לא נדרשת התערבות שלך')
    expect(result).not.toContain('הייתי צריך אותך')
  })

  it('celebrates the zero-OAU case without a number (en)', () => {
    const result = northStarLines(7, 0, 'en')
    expect(result).toContain('Nothing needed your attention')
    expect(result).not.toContain('I needed your input')
  })

  it('shows 0 in the bookings line when there were no bookings (he)', () => {
    const result = northStarLines(0, 2, 'he')
    expect(result).toContain('*0*')
  })

  it('shows 0 in the bookings line when there were no bookings (en)', () => {
    const result = northStarLines(0, 2, 'en')
    expect(result).toContain('*0*')
  })

  it('returns exactly two lines (one newline)', () => {
    const he = northStarLines(5, 3, 'he')
    const en = northStarLines(5, 3, 'en')
    expect(he.split('\n')).toHaveLength(2)
    expect(en.split('\n')).toHaveLength(2)
  })
})

describe('ownerDigestLines', () => {
  it('shows tomorrow count + churn line when churns are nonzero (he)', () => {
    const result = ownerDigestLines(4, 2, 'he')
    expect(result).toContain('*4*')
    expect(result).toContain('מחר')
    expect(result).toContain('*2*')
    expect(result).toContain('לא חזרו מזמן')
    expect(result.split('\n')).toHaveLength(2)
  })

  it('shows tomorrow count + churn line when churns are nonzero (en)', () => {
    const result = ownerDigestLines(4, 2, 'en')
    expect(result).toContain('*4*')
    expect(result).toContain('Tomorrow')
    expect(result).toContain('*2*')
    expect(result).toContain("haven't been back")
    expect(result.split('\n')).toHaveLength(2)
  })

  it('omits the churn line when there are no likely churns (he + en)', () => {
    const he = ownerDigestLines(3, 0, 'he')
    const en = ownerDigestLines(3, 0, 'en')
    expect(he).not.toContain('לא חזרו מזמן')
    expect(en).not.toContain("haven't been back")
    expect(he.split('\n')).toHaveLength(1)
    expect(en.split('\n')).toHaveLength(1)
  })

  it('shows 0 bookings tomorrow plainly', () => {
    expect(ownerDigestLines(0, 0, 'en')).toContain('*0*')
    expect(ownerDigestLines(0, 0, 'he')).toContain('*0*')
  })
})
