import { describe, it, expect } from 'vitest'
import { parseConfirmation, parseRetentionReply, classifyConfirmWithQuestion, type RetentionReply } from './types.js'

describe('classifyConfirmWithQuestion — same-day side-question vs day revision (C1)', () => {
  const SUN = 0, TUE = 2

  it('C4 canonical: "yes, is Sunday full?" with held slot ON Sunday → confirm (side question)', () => {
    expect(classifyConfirmWithQuestion('yes, is Sunday full?', SUN)).toBe('confirm')
  })

  it('"yes, anything Thursday?" with held slot on Tuesday → revise (different day)', () => {
    expect(classifyConfirmWithQuestion('yes, anything Thursday?', TUE)).toBe('revise')
  })

  it('a relative-day token ("tomorrow"/"next week") always revises', () => {
    expect(classifyConfirmWithQuestion('yes, but tomorrow instead?', TUE)).toBe('revise')
    expect(classifyConfirmWithQuestion('yes, can we do next week?', SUN)).toBe('revise')
  })

  it('mentioning the held weekday AND a different one → revise', () => {
    expect(classifyConfirmWithQuestion('yes, is Sunday or Thursday better?', SUN)).toBe('revise')
  })

  it('no resolvable day token → confirm (plain side question)', () => {
    expect(classifyConfirmWithQuestion("yes, who's the instructor?", SUN)).toBe('confirm')
  })

  it('no held weekday known + a day token → revise (cannot prove same-day)', () => {
    expect(classifyConfirmWithQuestion('yes, is Sunday full?', null)).toBe('revise')
  })

  it('Hebrew held-day side question confirms', () => {
    // ראשון = Sunday
    expect(classifyConfirmWithQuestion('כן, ראשון מלא?', SUN)).toBe('confirm')
  })
})

describe('parseRetentionReply', () => {
  // Truth table with offeredCount=3 (the v1 max offered).
  const cases: Array<{ name: string; text: string; expected: RetentionReply }> = [
    { name: "'1' picks the first slot", text: '1', expected: { kind: 'accept', index: 0 } },
    { name: "'2' picks the second slot", text: '2', expected: { kind: 'accept', index: 1 } },
    { name: "'3' picks the third slot", text: '3', expected: { kind: 'accept', index: 2 } },
    { name: "'2.' (trailing punctuation) still parses to second slot", text: '2.', expected: { kind: 'accept', index: 1 } },
    { name: "'0' is below range — unclear", text: '0', expected: { kind: 'unclear' } },
    { name: "'4' is above range — unclear", text: '4', expected: { kind: 'unclear' } },
    { name: "'maybe' is not a number — unclear", text: 'maybe', expected: { kind: 'unclear' } },
    { name: "'' empty — unclear", text: '', expected: { kind: 'unclear' } },
    { name: "'yes' does NOT accept (no number) — unclear", text: 'yes', expected: { kind: 'unclear' } },
    { name: "'cancel' declines", text: 'cancel', expected: { kind: 'decline' } },
    { name: "'no' declines", text: 'no', expected: { kind: 'decline' } },
    { name: "'בטל' (Hebrew cancel) declines", text: 'בטל', expected: { kind: 'decline' } },
  ]
  for (const c of cases) {
    it(c.name, () => {
      expect(parseRetentionReply(c.text, 3)).toEqual(c.expected)
    })
  }
})

// Documents the shared dependency: parseRetentionReply's decline path delegates to
// parseConfirmation, which must keep its existing yes/no/unclear classification.
describe('parseConfirmation (shared dependency)', () => {
  it("classifies 'yes' as yes", () => {
    expect(parseConfirmation('yes')).toBe('yes')
  })
  it("classifies 'cancel' as no", () => {
    expect(parseConfirmation('cancel')).toBe('no')
  })
  it("classifies 'maybe' as unclear", () => {
    expect(parseConfirmation('maybe')).toBe('unclear')
  })
})

// Regression for the live Branch-4 confirmation loop (סטודיוגה, 2026-06-26): a clear
// affirmative with trailing words, and the one-char כן typo, were classified 'unclear'
// and re-asked repeatedly. They must now resolve to 'yes' — while genuine revisions and
// hedged replies must stay 'unclear' so the revision / re-ask path still handles them.
describe('parseConfirmation — lenient affirmatives', () => {
  const yes = [
    'כן',
    'כו', // one-char כן typo from the live transcript
    'כן תקבע לי בבקשה', // "yes, book me please"
    'כן בבקשה',
    'yes book me please',
    'ok do it',
    'סבבה',
    'אישור.',
  ]
  for (const t of yes) {
    it(`'${t}' → yes`, () => expect(parseConfirmation(t)).toBe('yes'))
  }

  const unclear = [
    'כן אבל יום שלישי', // affirmative-led but a revised DAY → must not auto-confirm
    'כן אבל לא בא לי', // hedged with a negation
    'yes but actually tuesday',
    'אולי', // maybe
    'תקבע לי יוגה ברביעי', // a fresh request, no leading affirmative
    'מה לגבי 5?', // a question
  ]
  for (const t of unclear) {
    it(`'${t}' → unclear`, () => expect(parseConfirmation(t)).toBe('unclear'))
  }

  const no = ['לא', 'no', 'בטל', 'cancel']
  for (const t of no) {
    it(`'${t}' → no`, () => expect(parseConfirmation(t)).toBe('no'))
  }
})

describe('parseConfirmation — bundled yes + question', () => {
  it('treats a leading yes with a trailing question as yes_with_question', () => {
    expect(parseConfirmation('כן בבקשה, מי המורה דרך אגב?')).toBe('yes_with_question')
    expect(parseConfirmation('yes please, who is the instructor?')).toBe('yes_with_question')
  })
  it('still treats a plain leading yes as yes', () => {
    expect(parseConfirmation('כן בבקשה')).toBe('yes')
    expect(parseConfirmation('yes book me please')).toBe('yes')
  })
  it('does NOT confirm a revision that changes the slot', () => {
    expect(parseConfirmation('כן אבל ביום שלישי ב-19:00')).toBe('unclear')
    expect(parseConfirmation('yes but make it Tuesday 19:00')).toBe('unclear')
  })
  it('does NOT confirm when a negation appears', () => {
    expect(parseConfirmation('כן אבל לא בא לי, מתי עוד יש?')).toBe('unclear')
  })
})

// F1a / Symptom-1 (live-test confirm loop): an affirmative that is NOT the whole message
// and NOT the first word ("save it for me, yes" / "you're driving me crazy, yes I'm
// interested") was misread as 'unclear', so the PA re-asked the same slot indefinitely and
// the booking never committed. A windowed affirmative — an affirm token ANYWHERE, with no
// negation, no clock time, and no day-revision token — is a confirmation.
describe('parseConfirmation — windowed embedded affirmatives (F1a / S1)', () => {
  const yes = [
    'תשמור לי כן', // "save it for me, yes" — affirm is the 3rd word (verbatim live-test message)
    'אתה ממש משגע אותי כן אני מעוניינת', // verbatim live-test message — affirm mid-sentence
    'אני מעוניינת כן',
    'לי זה מתאים כן',
    'go on then, yes',
  ]
  for (const t of yes) {
    it(`'${t}' → yes`, () => expect(parseConfirmation(t)).toBe('yes'))
  }

  // Guards — an embedded affirmative must NOT auto-confirm when a revision or negation rides along.
  const unclear = [
    'בא לי כן אבל ביום חמישי', // embedded yes + a DAY revision → not a plain confirm
    'כן אבל לא משנה', // a negation appears → hedged
    'אולי כן ב-19:00', // a clock-time revision
  ]
  for (const t of unclear) {
    it(`'${t}' → unclear`, () => expect(parseConfirmation(t)).toBe('unclear'))
  }

  // An embedded affirmative bundled with a side QUESTION (no clock) stays yes_with_question
  // so the hold-confirm handler can discriminate a same-day side question from a revision.
  it('embedded affirmative + side question → yes_with_question', () => {
    expect(parseConfirmation('מצוין תודה, כן מי המדריך?')).toBe('yes_with_question')
  })
})
