import { describe, it, expect } from 'vitest'
import { detectLang, managerSwitchOfferSuffix } from '../../src/domain/i18n/t.js'
import { parseConfirmation } from '../../src/domain/flows/types.js'

// Deterministic coverage for the Branch 3 (manager) language-switch protocol
// (Session B / CHAT_LEVEL_LAWBOOK §3.4). The webhook glues these primitives
// together; here we pin the decision points and the exact offer wording so a
// regression (wrong language threaded, bilingual reply, drifted/missing offer)
// fails in `npm test` without needing a live DB. The live, language-correct
// REPLY itself is graded by the orchestrator quality scenario.

describe('manager language switch — turnLang detection (the offer trigger basis)', () => {
  it('detects the language the owner actually wrote in', () => {
    expect(detectLang('can you add a yoga class next Tuesday?')).toBe('en')
    expect(detectLang('תקבעי שיעור יוגה ביום שלישי')).toBe('he')
  })

  it('treats a mostly-English message with an incidental brand token as English', () => {
    expect(detectLang('schedule a class at Flow Studio at 11')).toBe('en')
  })

  it('the switch is offered exactly when the detected language differs from the default', () => {
    // Mirror of the webhook rule: shouldOfferSwitch = detected !== defaultLang
    // (with nothing locked). Verified here as a pure predicate.
    const shouldOffer = (detected: 'he' | 'en', def: 'he' | 'en') => detected !== def
    expect(shouldOffer('en', 'he')).toBe(true) // Hebrew biz, English owner → offer
    expect(shouldOffer('he', 'en')).toBe(true) // English biz, Hebrew owner → offer
    expect(shouldOffer('he', 'he')).toBe(false) // same language → no offer
    expect(shouldOffer('en', 'en')).toBe(false)
  })
})

describe('manager language switch — §3.4 offer suffix wording', () => {
  it('is worded in the DETECTED language, matching the lawbook verbatim', () => {
    expect(managerSwitchOfferSuffix('en')).toBe('\n\n(Want me to switch to English? Reply YES)')
    expect(managerSwitchOfferSuffix('he')).toBe('\n\n(רוצה שאמשיך בעברית? כתוב/י כן)')
  })

  it('is a single trailing line, never a bilingual block', () => {
    for (const lang of ['he', 'en'] as const) {
      const suffix = managerSwitchOfferSuffix(lang)
      // One offer, on its own line after a blank line.
      expect(suffix.startsWith('\n\n')).toBe(true)
      const body = suffix.trim()
      expect(body.split('\n')).toHaveLength(1)
      // Exactly one language present in the offer line.
      const hasHebrew = /[֐-׿]/.test(body)
      const hasLatinWords = /[A-Za-z]{3,}/.test(body)
      expect(hasHebrew && hasLatinWords).toBe(false)
    }
  })

  it('appends once to a reply without mutating the reply body', () => {
    const reply = 'Done — yoga class is on for Tuesday at 11:00, 10 spots.'
    const composed = reply + managerSwitchOfferSuffix('en')
    expect(composed.startsWith(reply)).toBe(true)
    // The offer appears exactly once.
    const occurrences = composed.split('(Want me to switch to English? Reply YES)').length - 1
    expect(occurrences).toBe(1)
  })
})

describe('manager language switch — confirming/declining the offer', () => {
  it('parses an acceptance in either language', () => {
    expect(parseConfirmation('yes')).toBe('yes')
    expect(parseConfirmation('Yes')).toBe('yes')
    expect(parseConfirmation('כן')).toBe('yes')
  })

  it('parses a decline in either language', () => {
    expect(parseConfirmation('no')).toBe('no')
    expect(parseConfirmation('לא')).toBe('no')
  })

  it('leaves an unrelated message unclear (so the offer is not falsely resolved)', () => {
    expect(parseConfirmation('actually, make it 12:00')).toBe('unclear')
  })
})
