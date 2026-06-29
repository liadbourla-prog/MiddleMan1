import { describe, it, expect } from 'vitest'
import { decideAmbiguousTodayWeekday, ambiguousTodayWeekdayAsk, consumeWeekdayClarification, carriesWeekdayClarification } from './customer-booking.js'

// WS3-T3.5 BUG4: a same-day weekday with no service that turn must NOT silently book today —
// the ambiguity marker survives a serviceless turn so the "today or next week?" ask still
// fires once the service is named.
describe('carriesWeekdayClarification — marker survives a serviceless turn', () => {
  it('keeps the marker when no date bound AND no fresh day this turn (e.g. just named the service)', () => {
    expect(carriesWeekdayClarification(true, false, false)).toBe(true)
  })

  it('drops the marker when the answer BOUND a date (today/next week)', () => {
    expect(carriesWeekdayClarification(true, true, false)).toBe(false)
  })

  it('drops the marker when a fresh concrete day supersedes it', () => {
    expect(carriesWeekdayClarification(true, false, true)).toBe(false)
  })

  it('no marker → nothing to carry', () => {
    expect(carriesWeekdayClarification(false, false, false)).toBe(false)
  })
})

// WS3-T3.5 BUG3: the consume must BIND the stashed date for a today/next-week answer so the
// date-resolution block is skipped — a bare "next week" answer (relativeDay:'next_week',
// weekday:null) must NOT be re-resolved (resolveRequestedDate → ambiguous_date → clarify loop).
describe('consumeWeekdayClarification — bind today/next-week answer to a stashed date', () => {
  const pending = { todayStr: '2026-06-29', nextWeekStr: '2026-07-06' }

  it('"next week" (relativeDay) binds to nextWeekStr, not ambiguous re-resolution', () => {
    expect(consumeWeekdayClarification(pending, { relativeDay: 'next_week', weekdayAnchor: null })).toBe('2026-07-06')
  })

  it('"next" anchor binds to nextWeekStr', () => {
    expect(consumeWeekdayClarification(pending, { relativeDay: null, weekdayAnchor: 'next' })).toBe('2026-07-06')
  })

  it('"today" (relativeDay) binds to todayStr', () => {
    expect(consumeWeekdayClarification(pending, { relativeDay: 'today', weekdayAnchor: null })).toBe('2026-06-29')
  })

  it('"this" anchor binds to todayStr', () => {
    expect(consumeWeekdayClarification(pending, { relativeDay: null, weekdayAnchor: 'this' })).toBe('2026-06-29')
  })

  it('a different concrete day this turn does NOT bind → null (normal resolution wins)', () => {
    expect(consumeWeekdayClarification(pending, { relativeDay: null, weekdayAnchor: null })).toBeNull()
    expect(consumeWeekdayClarification(pending, { relativeDay: 'tomorrow', weekdayAnchor: null })).toBeNull()
  })
})

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
