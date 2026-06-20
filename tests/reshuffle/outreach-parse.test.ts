import { describe, it, expect } from 'vitest'
import { interpretOutreachReply } from '../../src/domain/reshuffle/outreach.js'
import type { RawOutreachClassification } from '../../src/domain/reshuffle/outreach.js'
import type { Slot } from '../../src/domain/reshuffle/types.js'

const WED_09: Slot = { start: '2026-06-24T09:00:00.000Z', durationMin: 60 }

// A stub classifier that returns whatever the test wants the "LLM" to have said.
const classifier = (raw: RawOutreachClassification) => async () => raw

describe('interpretOutreachReply — interpretive LLM behind a deterministic guardrail', () => {
  it('accepts a clear yes', async () => {
    const v = await interpretOutreachReply('yes, that works for me', classifier({ intent: 'accept', confidence: 0.95 }))
    expect(v).toEqual({ verdict: 'yes' })
  })

  it('declines a clear no', async () => {
    const v = await interpretOutreachReply('no thanks, I need my time', classifier({ intent: 'decline', confidence: 0.9 }))
    expect(v).toEqual({ verdict: 'no' })
  })

  it('C2 — parses a counter-offer into a slot', async () => {
    const v = await interpretOutreachReply(
      "I can't do 10:00 but Wednesday 9am works",
      classifier({ intent: 'counter', counterSlot: WED_09, confidence: 0.9 }),
    )
    expect(v).toEqual({ verdict: 'counter', counterSlot: WED_09 })
  })

  it('C2 — parses a Hebrew counter-offer', async () => {
    const v = await interpretOutreachReply(
      'לא מתאים לי, אבל יום רביעי בתשע בבוקר כן',
      classifier({ intent: 'counter', counterSlot: WED_09, confidence: 0.88 }),
    )
    expect(v).toEqual({ verdict: 'counter', counterSlot: WED_09 })
  })

  it('a counter without a usable slot is unclear, not an acceptance', async () => {
    const v = await interpretOutreachReply('maybe another day?', classifier({ intent: 'counter', counterSlot: null }))
    expect(v).toEqual({ verdict: 'unclear' })
  })

  it('C3 — an ambiguous reply is NEVER treated as yes, even if the LLM says accept', async () => {
    for (const hedge of ['maybe', 'let me check', "I'll think about it", 'not sure', 'אולי']) {
      const v = await interpretOutreachReply(hedge, classifier({ intent: 'accept', confidence: 0.99 }))
      expect(v).toEqual({ verdict: 'unclear' })
    }
  })

  it('a low-confidence acceptance is downgraded to unclear (never a false yes)', async () => {
    const v = await interpretOutreachReply('ok I guess', classifier({ intent: 'accept', confidence: 0.4 }))
    expect(v).toEqual({ verdict: 'unclear' })
  })
})
