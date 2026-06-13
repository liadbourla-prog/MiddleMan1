import { describe, it, expect } from 'vitest'
import { looksLikeGreetingOrSocial } from '../../src/domain/flows/customer-booking.js'

// Guards the greeting/social detector that keeps benign pleasantries from
// counting toward unknown-intent escalation (the Branch-4 over-escalation fix).
// A message only qualifies when it is SHORT and essentially just a pleasantry;
// any real request (even one opening with "hi") must NOT qualify.

describe('looksLikeGreetingOrSocial', () => {
  it('recognizes Hebrew greetings / pleasantries', () => {
    for (const m of ['היי', 'היי!', 'שלום', 'ערב טוב', 'בוקר טוב', 'מה נשמע?', 'תודה רבה', 'סבבה', 'ביי', 'להתראות', 'אהלן']) {
      expect(looksLikeGreetingOrSocial(m), m).toBe(true)
    }
  })

  it('recognizes English greetings / pleasantries', () => {
    for (const m of ['hi', 'Hi!', 'hello', 'hey', 'good evening', 'good morning', 'how are you?', "what's up", 'thanks', 'thank you', 'ok', 'cool', 'bye', 'cheers']) {
      expect(looksLikeGreetingOrSocial(m), m).toBe(true)
    }
  })

  it('tolerates trailing emoji and punctuation', () => {
    expect(looksLikeGreetingOrSocial('היי 😊')).toBe(true)
    expect(looksLikeGreetingOrSocial('hello!!!')).toBe(true)
    expect(looksLikeGreetingOrSocial('ערב טוב 🙏')).toBe(true)
  })

  it('does NOT treat real requests as social — even when they open with a greeting', () => {
    for (const m of [
      'hi can I book tomorrow?',
      'אפשר לקבוע תור?',
      'יש לי שיעורים?',
      'מתי יש',
      'I want to cancel my class',
      'book me yoga monday 10am',
      'מחר יש?',
      'do you have parking?',
    ]) {
      expect(looksLikeGreetingOrSocial(m), m).toBe(false)
    }
  })

  it('returns false for empty / whitespace', () => {
    expect(looksLikeGreetingOrSocial('')).toBe(false)
    expect(looksLikeGreetingOrSocial('   ')).toBe(false)
  })
})
