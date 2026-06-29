import { describe, it, expect } from 'vitest'
import { decideAmbiguousTodayWeekday, ambiguousTodayWeekdayAsk } from './customer-booking.js'

// WS3-T3.5: pure tests for the bare same-day weekday clarification — the 3-state decision
// and the VOICE-GATE ask string.

describe('decideAmbiguousTodayWeekday — 3-state same-day decision', () => {
  it("'ask' when an open class still remains today", () => {
    expect(decideAmbiguousTodayWeekday([{ spotsLeft: 2 }], false)).toBe('ask')
  })

  it("'ask' when no open class but a private slot is still open today", () => {
    expect(decideAmbiguousTodayWeekday([{ spotsLeft: 0 }], true)).toBe('ask')
    expect(decideAmbiguousTodayWeekday([], true)).toBe('ask')
  })

  it("'full' when sessions remain today but every one is full", () => {
    expect(decideAmbiguousTodayWeekday([{ spotsLeft: 0 }, { spotsLeft: 0 }], false)).toBe('full')
  })

  it("'roll' when every session today has already started (nothing live)", () => {
    expect(decideAmbiguousTodayWeekday([], false)).toBe('roll')
  })
})

describe('ambiguousTodayWeekdayAsk — VOICE GATE golden shape', () => {
  const ask = ambiguousTodayWeekdayAsk('Yoga', 'Sunday, 7 June')

  it('names the service and "next week", and points at today vs same-day-next-week', () => {
    expect(ask).toContain('Yoga')
    expect(ask).toContain('next week')
    expect(ask).toContain('TODAY')
  })

  it('asks ONE question — no numbered menu, no yes/no, no grovel', () => {
    // exactly one question-instruction; never a digit menu
    expect(ask).toMatch(/ONE warm, first-person question/)
    expect(ask).not.toMatch(/\b1\.|\b2\.|\(1\)|\(2\)/) // no numbered/menu digits
    expect(ask).not.toMatch(/\(כן\/לא\)/) // no Hebrew yes/no
    expect(ask).not.toMatch(/\(yes\/no\)/i)
    expect(ask).toMatch(/do not present a numbered menu/)
    expect(ask).toMatch(/do not ask a yes\/no/)
  })
})
