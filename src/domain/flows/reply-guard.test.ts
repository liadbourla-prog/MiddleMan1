import { describe, it, expect } from 'vitest'
import { assertsBookingConfirmed } from './reply-guard.js'

describe('assertsBookingConfirmed', () => {
  it('flags Hebrew completed-booking claims', () => {
    // The exact prod hallucination that must be caught.
    expect(assertsBookingConfirmed('קבעתי. אתה רשום לסדנת נשימות מחר ב-17:00 ✅', 'he')).toBe(true)
    expect(assertsBookingConfirmed('שריינתי לך מקום ביום חמישי', 'he')).toBe(true)
    expect(assertsBookingConfirmed('נרשמת בהצלחה', 'he')).toBe(true)
    expect(assertsBookingConfirmed('התור נקבע ל-10:00', 'he')).toBe(true)
  })

  it('does NOT flag Hebrew offers/questions (booking not yet made)', () => {
    expect(assertsBookingConfirmed('רוצה שאקבע לך סדנת נשימות מחר ב-17:00?', 'he')).toBe(false)
    expect(assertsBookingConfirmed('יש מקום פנוי ב-10:00 או 17:00, מה מתאים לך?', 'he')).toBe(false)
    expect(assertsBookingConfirmed('סדנת נשימות מחר ב-17:00. לסגור?', 'he')).toBe(false)
    expect(assertsBookingConfirmed('לאיזה יום בא לך לקבוע?', 'he')).toBe(false)
  })

  it('flags English completed-booking claims', () => {
    expect(assertsBookingConfirmed("Done — you're booked for a breathing workshop Thursday at 17:00", 'en')).toBe(true)
    expect(assertsBookingConfirmed("Great, you're all set!", 'en')).toBe(true)
    expect(assertsBookingConfirmed("I've locked it in for you", 'en')).toBe(true)
    expect(assertsBookingConfirmed('Your appointment is confirmed', 'en')).toBe(true)
  })

  it('does NOT flag English offers/questions', () => {
    expect(assertsBookingConfirmed('Want me to lock it in?', 'en')).toBe(false)
    expect(assertsBookingConfirmed("I've got 14:00 or 16:30 — which works?", 'en')).toBe(false)
    expect(assertsBookingConfirmed('Which day would you like to book?', 'en')).toBe(false)
    expect(assertsBookingConfirmed('Shall I book that for you?', 'en')).toBe(false)
  })

  it('flags phantom-reschedule claims (C2) but not move OFFERS', () => {
    // The exact prod hallucination: a "✅ moved your yoga" with no engine write.
    expect(assertsBookingConfirmed('סגור. העברתי את שיעור היוגה שלך ליום ראשון ✅', 'he')).toBe(true)
    expect(assertsBookingConfirmed("Done — I've moved your yoga to Sunday", 'en')).toBe(true)
    expect(assertsBookingConfirmed('moved your appointment to 13:00', 'en')).toBe(true)
    // Offers to move must still pass through (booking not yet changed).
    expect(assertsBookingConfirmed('רוצה שאעביר את היוגה ליום ראשון?', 'he')).toBe(false)
    expect(assertsBookingConfirmed('Want me to move it to Sunday?', 'en')).toBe(false)
  })
})
