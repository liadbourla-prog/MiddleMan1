/**
 * Cross-seam voice golden set (T3.3 — Phase 3 of the Unified Anti-Fabrication Gate).
 *
 * THE POSITIVE QUALITY BAR for the gate's OWN outputs. T3.2 proves no reply can BYPASS the
 * gate; this file proves the safe fallbacks the gate EMITS (when it suppresses a fabrication)
 * still read like our best chat — so a fabrication fix never degrades the voice (owner #3a:
 * honest is never robotic).
 *
 * It consolidates, in ONE positive-bar suite, every gate-owned fallback across the seams —
 * including the T3.1a/T3.1b additions (the gate-owned, promise-free `SAFE_AUDIT_FALLBACK`) and
 * the Branch-3 orchestrator's manager-facing `SAFE_AUDIT_FALLBACK`. It uses the REAL detectors
 * (`detectBotTells` / `hasActionFabrication` from `../flows/voice-guard.js`,
 * `assertsBookingConfirmed` from `../flows/reply-guard.js`).
 *
 * RELATED (do not duplicate — this file ADDS the cross-seam consolidation + the orchestrator
 * fallback + `hasActionFabrication`-false on the GATE-owned SAFE_AUDIT_FALLBACK across langs):
 *  - `./gate-fallback-voice.test.ts` (T0.4) — per-fallback voice asserts for the three
 *    original gate fallbacks (booking / time / occupancy).
 *  - `../flows/voice-golden.test.ts` — the golden GOOD/BAD shape harness for Branch-4 replies.
 *
 * Pure: imports only the fallback strings + the detectors. No DB, no network, no engine mocks.
 */

import { describe, it, expect } from 'vitest'
import {
  BOOKING_NOT_CONFIRMED_FALLBACK,
  FABRICATED_TIME_FALLBACK,
  OCCUPANCY_FALLBACK,
  SAFE_AUDIT_FALLBACK as GATE_SAFE_AUDIT_FALLBACK,
} from './output-gate.js'
import { SAFE_AUDIT_FALLBACK as ORCH_SAFE_AUDIT_FALLBACK } from '../../adapters/llm/orchestrator.js'
import { detectBotTells, hasActionFabrication } from '../flows/voice-guard.js'
import { assertsBookingConfirmed } from '../flows/reply-guard.js'

// ── Shape helpers (mirror voice-golden.test.ts; local to the GOOD-reply asserts, NOT the gate) ──

/** At most one question mark (ASCII or full-width) — a human PA asks ONE thing, never stacks. */
const atMostOneQuestion = (s: string): boolean => (s.match(/[?？]/g) ?? []).length <= 1

/** Number of question marks (ASCII or full-width) — used where exactly one is required. */
const questionCount = (s: string): number => (s.match(/[?？]/g) ?? []).length

/**
 * A sharp PA reply always leaves a door open. Satisfied by ANY forward marker: an inviting
 * question, or an explicit offer to book / change / check / find an open time (He or En).
 * Robust by design — a presence check on `?` OR a known forward token, not the exact wording.
 * Mirrors the FORWARD_STEP intuition from voice-golden.test.ts.
 */
const hasNextStep = (s: string): boolean => {
  const invitingQuestion = /[?？]/.test(s)
  const enForward = /\b(book|change|check|look|find|open|do next|get back)\b/i.test(s)
  const heForward = /(לקבוע|לשנות|לבדוק|למצוא|פנוי|פנויה|לעשות|אבדוק|אחזור)/.test(s)
  return invitingQuestion || enForward || heForward
}

// ════════════════════════════════════════════════════════════════════════════
// PART 1 — Gate-OWNED fallbacks (output-gate.ts). Each: in he AND en, the gate's own
// suppression output must read like our best chat (owner #3a).
// ════════════════════════════════════════════════════════════════════════════

const GATE_FALLBACKS = [
  // `assertsBooking` flags whether `assertsBookingConfirmed` should be false on this string.
  // BOOKING_NOT_CONFIRMED is deliberately EXEMPT: its honest wording is the NEGATED claim
  // ("עדיין לא קבעתי כלום" / "I haven't booked anything yet"), and `assertsBookingConfirmed`
  // is a coarse substring matcher with NO negation handling — `/קבעתי/` matches inside
  // "לא קבעתי". This is a detector blind-spot, NOT a false claim by the string, and it is
  // HARMLESS in the gate: BOOKING_NOT_CONFIRMED_FALLBACK is a TERMINAL, and the gate's
  // post-regen re-check skips terminals (output-gate.ts: `if (!TERMINALS.has(reply))`), so
  // `assertsBookingConfirmed` is never run on this string in production. We therefore assert
  // the property that genuinely holds for honesty here — `hasActionFabrication === false` —
  // and skip the `assertsBookingConfirmed === false` assertion for this one string only.
  { name: 'BOOKING_NOT_CONFIRMED', v: BOOKING_NOT_CONFIRMED_FALLBACK, assertsBooking: false },
  { name: 'FABRICATED_TIME', v: FABRICATED_TIME_FALLBACK, assertsBooking: true },
  { name: 'OCCUPANCY', v: OCCUPANCY_FALLBACK, assertsBooking: true },
  { name: 'SAFE_AUDIT', v: GATE_SAFE_AUDIT_FALLBACK, assertsBooking: true },
] as const

// The gate flags these to the voice monitor as safe fallbacks, which exempts the `dead_end`
// tell (the terse honest steers legitimately state "nothing booked / find an open slot"
// without inventing a forward time). Mirrors output-gate.ts `isSafeFallback` + the existing
// gate-fallback-voice.test.ts handling — every OTHER mechanical tell must still be absent.
const SUPPRESSIBLE_TELLS = new Set(['dead_end'])

describe('cross-seam voice golden — gate-OWNED fallbacks meet the chat-UI bar (T3.3 / #3a)', () => {
  for (const { name, v, assertsBooking } of GATE_FALLBACKS) {
    for (const lang of ['he', 'en'] as const) {
      const reply = v[lang]

      it(`${name}.${lang} — no mechanical bot-tell (dead_end exempt for safe fallbacks)`, () => {
        const tells = detectBotTells(reply).filter((t) => !SUPPRESSIBLE_TELLS.has(t))
        expect(tells).toEqual([])
      })

      it(`${name}.${lang} — exactly one warm question (not zero, not stacked)`, () => {
        // All four gate-owned fallbacks steer forward with a single question.
        expect(questionCount(reply)).toBe(1)
      })

      it(`${name}.${lang} — first-person / forward-moving (has a next step)`, () => {
        expect(hasNextStep(reply)).toBe(true)
      })

      it(`${name}.${lang} — asserts nothing false (no action fabrication)`, () => {
        // The fallback exists precisely because nothing was backed; it must not itself
        // promise/claim an action it cannot perform. Holds for ALL four (incl. the negated
        // BOOKING_NOT_CONFIRMED wording, which `hasActionFabrication` does not trip).
        expect(hasActionFabrication(reply)).toBe(false)
      })

      if (assertsBooking) {
        it(`${name}.${lang} — asserts no booking (no phantom confirmation)`, () => {
          expect(assertsBookingConfirmed(reply, lang)).toBe(false)
        })
      }
    }
  }

  // The gate-owned SAFE_AUDIT_FALLBACK is the action-gate's TERMINAL fallback. It MUST NOT
  // match hasActionFabrication — otherwise it would re-trip the very detector that fired (the
  // re-trip trap that disqualifies the orchestrator's promise-bearing fallback from this role).
  // T3.3 locks this property in cross-seam, across BOTH langs (the cross-seam coverage the
  // per-seam tests don't assert).
  for (const lang of ['he', 'en'] as const) {
    it(`SAFE_AUDIT.${lang} (gate-owned) is promise-free — hasActionFabrication is false`, () => {
      expect(hasActionFabrication(GATE_SAFE_AUDIT_FALLBACK[lang])).toBe(false)
    })
  }
})

// ════════════════════════════════════════════════════════════════════════════
// PART 2 — Branch-3 orchestrator fallback (orchestrator.ts SAFE_AUDIT_FALLBACK).
// Manager-facing ("I'll check and get back to you"). It IS allowed to promise a check —
// Branch 3 is the owner channel and the orchestrator backs it with a real relay — so we
// assert it against the voice bar but DO NOT assert it is promise-free. It is a
// statement+forward-step (no `?`), so we assert ≤1 question + a next step (not exactly 1).
// ════════════════════════════════════════════════════════════════════════════

describe('cross-seam voice golden — Branch-3 orchestrator SAFE_AUDIT_FALLBACK meets the bar (T3.3 / #3a)', () => {
  for (const lang of ['he', 'en'] as const) {
    const reply = ORCH_SAFE_AUDIT_FALLBACK[lang]

    it(`orchestrator.${lang} — no mechanical bot-tell (dead_end exempt for safe fallbacks)`, () => {
      const tells = detectBotTells(reply).filter((t) => !SUPPRESSIBLE_TELLS.has(t))
      expect(tells).toEqual([])
    })

    it(`orchestrator.${lang} — at most one question + a forward step (statement is allowed)`, () => {
      expect(atMostOneQuestion(reply)).toBe(true)
      expect(hasNextStep(reply)).toBe(true) // not robotic: it commits to a next action
    })

    it(`orchestrator.${lang} — asserts no booking (honest)`, () => {
      expect(assertsBookingConfirmed(reply, lang)).toBe(false)
    })
  }
})
