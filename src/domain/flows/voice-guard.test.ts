import { describe, it, expect } from 'vitest'
import {
  hasNumberedMenu,
  hasYesNoMenu,
  hasBilingualLeak,
  hasSplitGender,
  hasStackedQuestions,
  hasGrovel,
  hasDeadEnd,
  hasActionFabrication,
  detectBotTells,
  type BotTell,
} from './voice-guard.js'

describe('hasNumberedMenu', () => {
  it('flags English IVR/numbered-menu tells', () => {
    expect(hasNumberedMenu('reply 1 to book, 2 to cancel')).toBe(true)
    expect(hasNumberedMenu('reply with the number that suits you')).toBe(true)
    expect(hasNumberedMenu('Please press 1 for reception')).toBe(true)
    expect(hasNumberedMenu('Pick a slot:\n1. 09:00\n2. 11:00')).toBe(true)
  })

  it('flags Hebrew IVR/numbered-menu tells', () => {
    expect(hasNumberedMenu('ענה את המספר שמתאים לך')).toBe(true)
    expect(hasNumberedMenu('בחר את המספר')).toBe(true)
    expect(hasNumberedMenu('מספר 1 ליום ראשון')).toBe(true)
    expect(hasNumberedMenu('בחר:\n1) בוקר\n2) ערב')).toBe(true)
  })

  it('does NOT flag a bare time or price', () => {
    expect(hasNumberedMenu('יש מקום מחר ב-10:00, מתאים?')).toBe(false)
    expect(hasNumberedMenu("that's 80 ₪ for the session")).toBe(false)
    expect(hasNumberedMenu('Thursday at 11:00 works')).toBe(false)
    expect(hasNumberedMenu('קבעתי לך ל-09:00')).toBe(false)
  })
})

describe('hasYesNoMenu', () => {
  it('flags English yes/no menus', () => {
    expect(hasYesNoMenu('Want me to book it? (yes/no)')).toBe(true)
    expect(hasYesNoMenu('Confirm? (yes / no)')).toBe(true)
    expect(hasYesNoMenu('reply YES to confirm')).toBe(true)
  })

  it('flags Hebrew yes/no menus', () => {
    expect(hasYesNoMenu('לקבוע? (כן/לא)')).toBe(true)
    expect(hasYesNoMenu('מתאים? (כן / לא)')).toBe(true)
    expect(hasYesNoMenu('השב כן לאישור')).toBe(true)
  })

  it('does NOT flag a plain-words confirmation', () => {
    expect(hasYesNoMenu('נשמע טוב? לקבוע?')).toBe(false)
    expect(hasYesNoMenu('Sound good?')).toBe(false)
    expect(hasYesNoMenu('מתאים לך מחר בבוקר?')).toBe(false)
  })

  it('does NOT flag a benign "לא הצלחתי…" clarifying reply (only a real yes/no MENU fires)', () => {
    expect(hasYesNoMenu('לא הצלחתי להבין')).toBe(false)
    expect(hasYesNoMenu('מתאים לך? (כן/לא)')).toBe(true)
  })
})

describe('hasBilingualLeak', () => {
  it('flags a Hebrew message with a run of Latin words', () => {
    expect(hasBilingualLeak('קבעתי לך, please confirm the booking')).toBe(true)
    expect(hasBilingualLeak('היי, the session is scheduled')).toBe(true)
  })

  it('tolerates allowlisted brand/service/loanwords inside Hebrew', () => {
    expect(hasBilingualLeak('יש שיעור pilates מחר')).toBe(false)
    expect(hasBilingualLeak('קבעתי לך yoga ב-10:00')).toBe(false)
    expect(hasBilingualLeak('אשלח לך פרטים ב-whatsapp')).toBe(false)
    expect(hasBilingualLeak('נתראה ב-zoom מחר')).toBe(false)
  })

  it('does NOT flag a monolingual message', () => {
    expect(hasBilingualLeak('קבעתי לך מחר ב-10:00')).toBe(false)
    expect(hasBilingualLeak('Done, see you Thursday')).toBe(false)
    expect(hasBilingualLeak('')).toBe(false)
  })
})

describe('hasSplitGender', () => {
  it('flags Hebrew split-gender verb conjugation', () => {
    expect(hasSplitGender('תכתוב/י לי מתי נוח')).toBe(true)
    expect(hasSplitGender('תרצה/תרצי לקבוע?')).toBe(true)
    expect(hasSplitGender('אתה מעוניין/ת בשיעור?')).toBe(true)
    expect(hasSplitGender('תגיד/י לי מתי')).toBe(true)
  })

  it('does NOT flag Hebrew NOUN alternation (precision case)', () => {
    expect(hasSplitGender('יש לנו יוגה/פילאטיס מחר')).toBe(false)
    expect(hasSplitGender('בוקר/צהריים מתאים לך?')).toBe(false)
  })

  it('does NOT flag a clean masculine-address reply', () => {
    expect(hasSplitGender('תכתוב לי מתי נוח לך')).toBe(false)
    expect(hasSplitGender('Want to book?')).toBe(false)
  })
})

describe('hasStackedQuestions', () => {
  it('flags more than one question mark (En + He)', () => {
    expect(hasStackedQuestions('What day? What time?')).toBe(true)
    expect(hasStackedQuestions('איזה יום? ובאיזו שעה？')).toBe(true)
  })

  it('does NOT flag a single question', () => {
    expect(hasStackedQuestions('מתאים לך מחר?')).toBe(false)
    expect(hasStackedQuestions('Sound good?')).toBe(false)
    expect(hasStackedQuestions('Done, see you then.')).toBe(false)
  })
})

describe('hasGrovel', () => {
  it('flags robotic apology/grovel (En + He)', () => {
    expect(hasGrovel('I sincerely apologize for the inconvenience')).toBe(true)
    expect(hasGrovel('We apologize for the trouble')).toBe(true)
    expect(hasGrovel('אני מתנצל על אי הנוחות')).toBe(true)
    expect(hasGrovel('אנחנו מתנצלים על התקלה')).toBe(true)
  })

  it('does NOT flag a polite "sorry" at the start of a clarifying question (precision case)', () => {
    expect(hasGrovel('סליחה, לא הבנתי — תוכל לחדד?')).toBe(false)
    expect(hasGrovel('sorry, which day did you mean?')).toBe(false)
  })

  it('does NOT flag a clean reply', () => {
    expect(hasGrovel('קבעתי לך מחר ב-10:00')).toBe(false)
    expect(hasGrovel('Done, see you Thursday')).toBe(false)
  })
})

describe('hasDeadEnd', () => {
  it('flags a real unavailability assertion with no forward step (En + He)', () => {
    expect(hasDeadEnd('That time is not available.')).toBe(true)
    expect(hasDeadEnd('אין מקום בשיעור הזה.')).toBe(true)
    expect(hasDeadEnd("We're fully booked.")).toBe(true)
    expect(hasDeadEnd('Sunday is fully booked.')).toBe(true)
  })

  it('does NOT flag a negative paired with a forward step (offered time / question / next)', () => {
    expect(hasDeadEnd("That time's gone, but Thursday 11:00 is open")).toBe(false)
    expect(hasDeadEnd('אין מקום מחר, אבל יש יום אחר פנוי')).toBe(false)
    expect(hasDeadEnd('That slot is not available — want another day?')).toBe(false)
    expect(hasDeadEnd('אין מקום, אעביר לסטודיו שיחזרו אליך')).toBe(false)
  })

  it('does NOT flag bare negation that is not an unavailability assertion (calibration)', () => {
    // "No problem." / "אין בעיה." are negation, not unavailability. They must stay
    // false, or monitor-mode floods with benign replies and loses calibration value.
    expect(hasDeadEnd('No problem.')).toBe(false)
    expect(hasDeadEnd('אין בעיה.')).toBe(false)
    expect(hasDeadEnd('No worries, talk soon')).toBe(false)
  })

  it('does NOT flag a clean positive reply', () => {
    expect(hasDeadEnd('קבעתי לך מחר ב-10:00')).toBe(false)
    expect(hasDeadEnd('Done, see you Thursday')).toBe(false)
  })
})

describe('detectBotTells', () => {
  it('returns [] for a clean warm reply', () => {
    expect(detectBotTells('קיבלתי — קבעתי לך מחר ב-10:00, נתראה')).toEqual([])
    expect(detectBotTells('Got it — you’re booked for Thursday at 11:00')).toEqual([])
  })

  it('returns every tell that fires', () => {
    const tells = detectBotTells('Confirm? (yes/no) reply 1 to book')
    expect(tells).toContain<BotTell>('yes_no_menu')
    expect(tells).toContain<BotTell>('numbered_menu')
  })

  it('returns both tells for a stacked-question grovel reply', () => {
    const tells = detectBotTells('I sincerely apologize. What day? What time?')
    expect(tells).toContain<BotTell>('grovel')
    expect(tells).toContain<BotTell>('stacked_questions')
  })
})

// Gate 4 (F3a/F3b/S3) — action-fabrication: an LLM reply that CLAIMS an escalation/follow-up
// the PA can't self-perform. Honest escalation replies come from code templates and bypass
// this gate, so any such claim here is the model fabricating a follow-up with no backing.
describe('hasActionFabrication (Gate 4)', () => {
  const fabrications = [
    "I'll check with the studio and get back to you.",
    "I've asked the owner — one of our guides will get back to you with the answer.",
    'אחזור אליך עם תשובה מדויקת.',
    'בדקתי את זה מול הסטודיו, אין לי את המידע.',
    'העברתי את השאלה למנהל.',
    'אחד המדריכים יחזור אליך.',
  ]
  for (const t of fabrications) {
    it(`flags: "${t.slice(0, 32)}…"`, () => expect(hasActionFabrication(t)).toBe(true))
  }
  const clean = [
    'יש שיעור יוגה היום ב-16:00. מתאים לך?',
    'We have classes at 10:00 and 12:00 — which works for you?',
    'אין לי את המידע הזה כרגע — הכי טוב לפנות ישירות לעסק.',
  ]
  for (const t of clean) {
    it(`clean: "${t.slice(0, 32)}…"`, () => expect(hasActionFabrication(t)).toBe(false))
  }
  it('is a SEPARATE signal — NOT in the mechanical detectBotTells aggregator (a backed escalation hand-off must pass the voice bar)', () => {
    // A warm, backed hand-off reads clean to the mechanical detectors; action-fabrication is
    // monitored separately (Gate 4) because text alone can't prove it's unbacked.
    expect(detectBotTells("I'll check and get back to you")).not.toContain('action_fabrication')
  })
})
