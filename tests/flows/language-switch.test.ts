import { describe, it, expect } from 'vitest'
import { hasLanguageSignal, resolveTurnLanguage } from '../../src/domain/flows/language-switch.js'

describe('hasLanguageSignal — low-signal tokens must not flip language', () => {
  it('returns false for tokens onboarding constantly sees', () => {
    for (const t of ['24/7', 'GO', 'ok', 'Bit', 'PayPal', '', '03-1234567', '21:00', '9:00-18:00']) {
      expect(hasLanguageSignal(t)).toBe(false)
    }
  })
  it('returns true for Hebrew and real multi-word English', () => {
    expect(hasLanguageSignal('שלום')).toBe(true)
    expect(hasLanguageSignal('I want to set my hours')).toBe(true)
    expect(hasLanguageSignal('credit card')).toBe(true)
  })
})

describe('resolveTurnLanguage', () => {
  const he = 'he' as const
  it('keeps the default on a no-signal token — no flip, no offer', () => {
    const r = resolveTurnLanguage({ body: '24/7', defaultLang: he, preferredLanguage: null, sessionOverride: undefined })
    expect(r.turnLang).toBe('he')
    expect(r.shouldOfferSwitch).toBe(false)
  })
  it('flips and offers on a real other-language sentence', () => {
    const r = resolveTurnLanguage({ body: 'I want to set my hours', defaultLang: he, preferredLanguage: null, sessionOverride: undefined })
    expect(r.turnLang).toBe('en')
    expect(r.detected).toBe('en')
    expect(r.shouldOfferSwitch).toBe(true)
  })
  it('a locked preferredLanguage wins and suppresses the offer', () => {
    const r = resolveTurnLanguage({ body: 'I want to set my hours', defaultLang: he, preferredLanguage: he, sessionOverride: undefined })
    expect(r.turnLang).toBe('he')
    expect(r.shouldOfferSwitch).toBe(false)
  })
  it('a session override wins when no preference is set', () => {
    const r = resolveTurnLanguage({ body: 'I want to set my hours', defaultLang: he, preferredLanguage: null, sessionOverride: he })
    expect(r.turnLang).toBe('he')
    expect(r.shouldOfferSwitch).toBe(false)
  })
  it('an empty body never flips or offers (WhatsApp empty payloads)', () => {
    const r = resolveTurnLanguage({ body: '', defaultLang: he, preferredLanguage: null, sessionOverride: undefined })
    expect(r.turnLang).toBe('he')
    expect(r.detected).toBe('he')
    expect(r.shouldOfferSwitch).toBe(false)
  })
  it('a Hebrew body on a Hebrew-default business stays Hebrew, no offer', () => {
    const r = resolveTurnLanguage({ body: 'ראשון עד חמישי 9 עד 18', defaultLang: he, preferredLanguage: null, sessionOverride: undefined })
    expect(r.turnLang).toBe('he')
    expect(r.shouldOfferSwitch).toBe(false)
  })
})
