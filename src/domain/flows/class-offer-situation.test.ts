import { describe, it, expect } from 'vitest'
import { classOfferSituation } from './customer-booking.js'

// Pure tests for the testable seam that guarantees "never dead-end a lead" at the three
// class-offer sites. We assert the three states (same-day exists / substitute-only /
// both-empty) and the VOICE GATE invariants on each produced instruction string.

const SVC = 'Yoga'
const DAY = 'Monday, 2 Sep'

// A representative offerable buildDayOptionsText text (full classes already dropped, so
// it can never contain "(full)").
const SAME_DAY = 'Classes on Monday, 2 Sep: Yoga at 10:00 (3 spots left).'
// A representative suggestNextClassesText substitute (next real classes on later days).
const SUBSTITUTE = 'Upcoming scheduled classes (these are the real options — there are no others): Yoga on Wed at 10:00 (2 spots left).'

describe('classOfferSituation — case 1: same-day real options exist', () => {
  const s = classOfferSituation(SVC, DAY, SAME_DAY, SUBSTITUTE)
  it('offers the same-day times (does not jump to the substitute)', () => {
    expect(s).toContain(SAME_DAY)
    expect(s).not.toContain('next real classes')
  })
  it('asks a single actionable question to pick one', () => {
    expect(s).toMatch(/ask which they'd like/i)
  })
})

describe('classOfferSituation — case 2: same-day empty, substitute exists', () => {
  const s = classOfferSituation(SVC, DAY, null, SUBSTITUTE)
  it('surfaces the next real classes (no dead-end)', () => {
    expect(s).toContain(SUBSTITUTE)
    expect(s).toMatch(/no more Yoga classes on Monday/i)
  })
  it('offers them and asks which they\'d like', () => {
    expect(s).toMatch(/offer these and ask which they'd like/i)
  })
  it('never instructs offering a "(full)" class', () => {
    expect(s.toLowerCase()).not.toContain('(full)')
  })
})

describe('classOfferSituation — case 3: both empty (genuinely nothing ahead)', () => {
  const s = classOfferSituation(SVC, DAY, null, null)
  it('still contains a forward step — not a bare dead-end', () => {
    // must offer a concrete next action (another day OR let the studio know)
    expect(s).toMatch(/another day/i)
    expect(s).toMatch(/let the studio know/i)
  })
  it('is a single question, not a numbered/IVR menu', () => {
    expect(s.toLowerCase()).not.toContain('(full)')
    expect(s).not.toMatch(/\b1\.|\b2\.|reply with a number/i)
    // no Hebrew yes/no IVR leak
    expect(s).not.toContain('(כן/לא)')
  })
  it('never invents a time and keeps things moving', () => {
    expect(s).toMatch(/never invent a time/i)
  })
})

describe('classOfferSituation — VOICE GATE across all branches', () => {
  const variants = [
    classOfferSituation(SVC, DAY, SAME_DAY, SUBSTITUTE),
    classOfferSituation(SVC, DAY, null, SUBSTITUTE),
    classOfferSituation(SVC, DAY, null, null),
  ]
  it('no branch contains a numbered menu, "(full)", or a yes/no IVR token', () => {
    for (const s of variants) {
      expect(s.toLowerCase()).not.toContain('(full)')
      expect(s).not.toContain('(כן/לא)')
      expect(s).not.toMatch(/reply with a number/i)
    }
  })
})
