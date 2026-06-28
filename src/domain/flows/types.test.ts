import { describe, it, expect } from 'vitest'
import { parseConfirmation, parseRetentionReply, type RetentionReply } from './types.js'

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
