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
