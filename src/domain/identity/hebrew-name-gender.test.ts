import { describe, it, expect } from 'vitest'
import { genderFromName } from './hebrew-name-gender.js'

describe('genderFromName', () => {
  it('classifies common masculine Hebrew given names', () => {
    for (const n of ['דוד', 'משה', 'יוסי', 'אברהם', 'יעקב', 'איתי', 'אורי', 'ניר', 'אלון', 'חיים']) {
      expect(genderFromName(n), n).toBe('male')
    }
  })

  it('classifies common feminine Hebrew given names', () => {
    for (const n of ['שרה', 'רחל', 'נועה', 'דנה', 'מיכל', 'יעל', 'תמר', 'שירה', 'מאיה', 'רונית']) {
      expect(genderFromName(n), n).toBe('female')
    }
  })

  it('returns null for genuinely unisex names — never guesses', () => {
    for (const n of ['גל', 'שיר', 'רותם', 'עדן', 'אופיר', 'טל', 'נועם', 'יובל', 'עמית', 'אור']) {
      expect(genderFromName(n), n).toBeNull()
    }
  })

  it('uses only the FIRST token of a full name', () => {
    expect(genderFromName('דוד כהן')).toBe('male')
    expect(genderFromName('נועה לוי')).toBe('female')
    expect(genderFromName('  משה   לוי בן דוד ')).toBe('male')
  })

  it('strips niqqud and surrounding punctuation/emoji', () => {
    expect(genderFromName('דָּוִד')).toBe('male')
    expect(genderFromName(' שרה! ')).toBe('female')
    expect(genderFromName('נועה 😀')).toBe('female')
  })

  it('returns null for empty, Latin-script, emoji-only, or unknown tokens', () => {
    expect(genderFromName('')).toBeNull()
    expect(genderFromName('   ')).toBeNull()
    expect(genderFromName('David')).toBeNull()
    expect(genderFromName('Sarah Cohen')).toBeNull()
    expect(genderFromName('😀')).toBeNull()
    expect(genderFromName('זזזזחחח')).toBeNull()
  })
})
