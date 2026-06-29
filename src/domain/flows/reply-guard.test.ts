import { describe, it, expect } from 'vitest'
import { assertsBookingConfirmed, detectActionClaims } from './reply-guard.js'

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

describe('detectActionClaims (L2 multi-action auditor)', () => {
  it('flags the exact Branch-3 message-sent hallucination', () => {
    // "I sent it to him, I'll update you when he replies" — the prod incident.
    expect(detectActionClaims('שלחתי לו. אעדכן אותך כשיענה.', 'he')).toContain('message_sent')
    expect(detectActionClaims('ההודעה להראל נשלחה. אני ממתין לתשובה.', 'he')).toContain('message_sent')
    expect(detectActionClaims("I've messaged Harel — I'll let you know when he replies", 'en')).toContain('message_sent')
    expect(detectActionClaims('I sent him a message', 'en')).toContain('message_sent')
  })

  it('does NOT flag message OFFERS, or handing the OWNER something in-chat', () => {
    expect(detectActionClaims('לשלוח לו את ההודעה?', 'he')).not.toContain('message_sent')
    expect(detectActionClaims('Want me to text him?', 'en')).not.toContain('message_sent')
    // "I sent YOU the link" is the PA giving the owner something inline, not an outreach.
    expect(detectActionClaims('שלחתי לך את הקישור כאן', 'he')).not.toContain('message_sent')
  })

  it('flags the calendar-connected hallucination (the emailed-link incident class)', () => {
    expect(detectActionClaims('היומן שלך מחובר עכשיו לגוגל', 'he')).toContain('calendar_connected')
    expect(detectActionClaims('Your calendar is now connected', 'en')).toContain('calendar_connected')
  })

  it('does NOT flag sending/offering the connect LINK', () => {
    // Sending the link is legitimate; only claiming the connection is complete is not.
    expect(detectActionClaims('הנה הקישור לחיבור היומן, פשוט תלחץ עליו', 'he')).not.toContain('calendar_connected')
    expect(detectActionClaims("Here's the link to connect your calendar", 'en')).not.toContain('calendar_connected')
  })

  it('flags cancellation claims but not cancellation questions', () => {
    expect(detectActionClaims('ביטלתי את התור של מחר', 'he')).toContain('cancelled')
    expect(detectActionClaims('I cancelled your appointment', 'en')).toContain('cancelled')
    expect(detectActionClaims('לבטל את התור של מחר?', 'he')).not.toContain('cancelled')
    expect(detectActionClaims('Want me to cancel it?', 'en')).not.toContain('cancelled')
  })

  it('returns no claims for a plain question', () => {
    expect(detectActionClaims('מתי נוח לך השבוע?', 'he')).toEqual([])
    expect(detectActionClaims('What time works for you?', 'en')).toEqual([])
  })
})

// ── T1.3 — new backed-action classes (refund / broadcast / settings) ──────────────
describe('detectActionClaims — refund / broadcast / settings (T1.3)', () => {
  it('flags completed REFUND claims (He + En), not offers', () => {
    expect(detectActionClaims('Done — I refunded ₪300 to Dana.', 'en')).toContain('refunded')
    expect(detectActionClaims("I've issued the refund.", 'en')).toContain('refunded')
    expect(detectActionClaims('החזרתי לדנה את ה-300 ₪.', 'he')).toContain('refunded')
    expect(detectActionClaims('הזיכוי בוצע.', 'he')).toContain('refunded')
    // Offers/questions move the action forward — never flagged.
    expect(detectActionClaims('Want me to refund Dana?', 'en')).not.toContain('refunded')
    expect(detectActionClaims('להחזיר לדנה את התשלום?', 'he')).not.toContain('refunded')
  })

  it('flags completed BROADCAST/notify-everyone claims (He + En), not offers', () => {
    expect(detectActionClaims("I've notified all your customers about the new hours.", 'en')).toContain('broadcast_sent')
    expect(detectActionClaims('The announcement was sent out.', 'en')).toContain('broadcast_sent')
    expect(detectActionClaims('עדכנתי את כל הלקוחות על השעות החדשות.', 'he')).toContain('broadcast_sent')
    expect(detectActionClaims('ההודעה נשלחה לכל הלקוחות.', 'he')).toContain('broadcast_sent')
    expect(detectActionClaims('Should I let everyone know about the new hours?', 'en')).not.toContain('broadcast_sent')
  })

  it('flags completed SETTINGS-change claims (He + En), not booking/offers', () => {
    expect(detectActionClaims("Done — I've set the price to ₪300.", 'en')).toContain('settings_changed')
    expect(detectActionClaims('I updated your hours to 09:00–18:00.', 'en')).toContain('settings_changed')
    expect(detectActionClaims('עדכנתי את המחיר ל-300 ₪.', 'he')).toContain('settings_changed')
    expect(detectActionClaims('שיניתי את השעות.', 'he')).toContain('settings_changed')
    // Must not collide with the booking class (קבעתי = booked, not a settings change).
    expect(detectActionClaims('קבעתי לך תור מחר ב-10:00', 'he')).not.toContain('settings_changed')
    expect(detectActionClaims('Want me to change the price?', 'en')).not.toContain('settings_changed')
  })
})
