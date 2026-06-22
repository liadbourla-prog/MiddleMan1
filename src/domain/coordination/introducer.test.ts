import { describe, it, expect } from 'vitest'
import { resolveOutreachIntroducer } from './introducer.js'

describe('resolveOutreachIntroducer', () => {
  it('uses the business name when mode is business', () => {
    expect(resolveOutreachIntroducer({ mode: 'business', businessName: 'Studyoga', ownerName: 'Dana', lang: 'en' }))
      .toBe('Studyoga')
  })

  it('uses the owner name in English when mode is owner_name and a real name exists', () => {
    expect(resolveOutreachIntroducer({ mode: 'owner_name', businessName: 'Studyoga', ownerName: 'Dana', lang: 'en' }))
      .toBe("Dana's assistant")
  })

  it('uses the owner name in Hebrew', () => {
    expect(resolveOutreachIntroducer({ mode: 'owner_name', businessName: 'סטודיוגה', ownerName: 'דנה', lang: 'he' }))
      .toBe('העוזר/ת של דנה')
  })

  it('falls back to the business name when owner_name is chosen but the name is the placeholder', () => {
    expect(resolveOutreachIntroducer({ mode: 'owner_name', businessName: 'Studyoga', ownerName: 'Owner', lang: 'en' }))
      .toBe('Studyoga')
  })

  it('falls back to the business name when mode is unset', () => {
    expect(resolveOutreachIntroducer({ mode: null, businessName: 'Studyoga', ownerName: null, lang: 'en' }))
      .toBe('Studyoga')
  })
})
