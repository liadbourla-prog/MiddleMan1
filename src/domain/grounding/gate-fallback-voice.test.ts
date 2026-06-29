import { describe, it, expect } from 'vitest'
import {
  BOOKING_NOT_CONFIRMED_FALLBACK,
  FABRICATED_TIME_FALLBACK,
  OCCUPANCY_FALLBACK,
} from './output-gate.js'
import { detectBotTells, hasActionFabrication } from '../flows/voice-guard.js'

// T0.4 / VOICE GATE — the gate fallbacks must read like our best chat, not terse-safe IVR.
// Owner #3a: honest is never robotic. Owner D1 wording: a fabricated-time steer must use
// "available / open" framing, never "real time" (which implies the customer asked for a
// fake one). Each fallback: passes detectBotTells (no mechanical tell), asks at most one
// question, carries a forward step, claims nothing false, and (the time/occupancy steers)
// uses open/available framing.

const ALL = [
  { name: 'BOOKING_NOT_CONFIRMED', v: BOOKING_NOT_CONFIRMED_FALLBACK },
  { name: 'FABRICATED_TIME', v: FABRICATED_TIME_FALLBACK },
  { name: 'OCCUPANCY', v: OCCUPANCY_FALLBACK },
] as const

const atMostOneQuestion = (s: string) => (s.match(/[?？]/g) ?? []).length <= 1

describe('gate fallbacks meet the chat-UI voice bar (T0.4 / #3a)', () => {
  for (const { name, v } of ALL) {
    for (const lang of ['he', 'en'] as const) {
      const reply = v[lang]
      it(`${name}.${lang} — no mechanical bot-tell`, () => {
        expect(detectBotTells(reply)).toEqual([])
      })
      it(`${name}.${lang} — at most one question + a forward step`, () => {
        expect(atMostOneQuestion(reply)).toBe(true)
        expect(/[?？]/.test(reply)).toBe(true) // a warm next-step question
      })
      it(`${name}.${lang} — asserts no action/booking (honest)`, () => {
        // The fallback exists precisely because nothing was backed; it must not itself claim one.
        expect(hasActionFabrication(reply)).toBe(false)
      })
    }
  }

  it('FABRICATED_TIME never frames the steer as a "real time" (owner D1 wording)', () => {
    expect(/real\s*time/i.test(FABRICATED_TIME_FALLBACK.en)).toBe(false)
    expect(/זמן\s*אמיתי/.test(FABRICATED_TIME_FALLBACK.he)).toBe(false)
  })

  it('FABRICATED_TIME + OCCUPANCY steer with open/available framing', () => {
    expect(/\b(open|available)\b/i.test(FABRICATED_TIME_FALLBACK.en)).toBe(true)
    expect(/פנוי/.test(FABRICATED_TIME_FALLBACK.he)).toBe(true)
    expect(/\b(open|available)\b/i.test(OCCUPANCY_FALLBACK.en)).toBe(true)
    expect(/פנוי/.test(OCCUPANCY_FALLBACK.he)).toBe(true)
  })
})
