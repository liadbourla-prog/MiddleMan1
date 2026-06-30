import { describe, it, expect } from 'vitest'
import { inferSelfGenderFromHebrew } from './hebrew-self-morphology.js'

describe('inferSelfGenderFromHebrew', () => {
  it('detects feminine first-person self-reference', () => {
    expect(inferSelfGenderFromHebrew('אני מעוניינת לקבוע שיעור')).toBe('female')
    expect(inferSelfGenderFromHebrew('אני צריכה לבטל את התור')).toBe('female')
    expect(inferSelfGenderFromHebrew('אני גרה בתל אביב')).toBe('female')
    expect(inferSelfGenderFromHebrew('שלום, אני דנה ואני מעוניינת בפרטים')).toBe('female')
  })

  it('detects masculine first-person self-reference', () => {
    expect(inferSelfGenderFromHebrew('אני מעוניין לקבוע')).toBe('male')
    expect(inferSelfGenderFromHebrew('אני לא בטוח מתי')).toBe('male')
    expect(inferSelfGenderFromHebrew('אני פנוי מחר בבוקר')).toBe('male')
  })

  it('binds to the SENDER (first אני), not a third party they mention', () => {
    // "I[m] know that you[f] need help" → male (the sender), not female (the addressee).
    expect(inferSelfGenderFromHebrew('אני יודע שאת צריכה עזרה')).toBe('male')
    // a request ABOUT a third party, no first-person pronoun → unknown.
    expect(inferSelfGenderFromHebrew('תשאל אותה אם היא מעוניינת')).toBeNull()
    expect(inferSelfGenderFromHebrew('הלקוחה מעוניינת בשיעור')).toBeNull()
  })

  it('returns null on ambiguous unvocalized forms (no false guess)', () => {
    expect(inferSelfGenderFromHebrew('אני רוצה לקבוע')).toBeNull() // רוצה = rotzeh/rotza
    expect(inferSelfGenderFromHebrew('אני באה מחר')).toBeNull() // ba/ba'a ambiguous
  })

  it('strips niqqud before matching', () => {
    expect(inferSelfGenderFromHebrew('אֲנִי צְרִיכָה')).toBe('female')
    expect(inferSelfGenderFromHebrew('אֲנִי צָרִיךְ')).toBe('male')
  })

  it('returns null for English, empty, or no gendered self-reference', () => {
    expect(inferSelfGenderFromHebrew('')).toBeNull()
    expect(inferSelfGenderFromHebrew('I want to book a class')).toBeNull()
    expect(inferSelfGenderFromHebrew('מתי אתם פתוחים?')).toBeNull()
    expect(inferSelfGenderFromHebrew('קבעתי תור אתמול')).toBeNull() // past tense = gender-neutral
  })
})
