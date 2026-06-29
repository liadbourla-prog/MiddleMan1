import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseConfirmation } from '../../src/domain/flows/types.js'

// WS3-T3.6 (C4): a leading "yes" bundled with a SIDE question (no clock time, no slot
// revision) confirms the booking AND answers the question. The answer must run through the
// anti-fabrication gates (gates 1-3 in makeGenReply) — i.e. it must NOT be issued under
// bookingConfirmed:true, which exempts a reply from those gates. Otherwise the confirmed
// reply could fabricate an availability claim ("yes, and Sunday is wide open") ungated.

describe('WS3-T3.6 — bundled side-question classification (lock)', () => {
  it('classifies "yes + side question" (no clock time) as yes_with_question', () => {
    expect(parseConfirmation('yes, is Sunday full?')).toBe('yes_with_question')
    // Hebrew equivalent: leading affirmative + a question mark, no clock time
    expect(parseConfirmation('כן, יש מקום ביום ראשון?')).toBe('yes_with_question')
  })
})

// Source-introspection guard (mirrors special-arrangement-escalation.test.ts): with no DB
// harness, assert the confirmed yes_with_question path issues a SEPARATE genReply for the
// bundled question that does NOT pass bookingConfirmed:true (so the answer is gated).
describe('WS3-T3.6 — bundled-answer is gated (source guard)', () => {
  const srcPath = fileURLToPath(new URL('../../src/domain/flows/customer-booking.ts', import.meta.url))
  const src = readFileSync(srcPath, 'utf8')

  it('the successful hold-confirm path branches on yes_with_question', () => {
    expect(src).toContain("parsed === 'yes_with_question'")
  })

  it('issues a SEPARATE bundled-question genReply WITHOUT bookingConfirmed (gated)', () => {
    // The bundled answer's situation string is the anchor: locate the genReply call that
    // answers the bundled question and assert its opts do NOT carry bookingConfirmed:true.
    const anchor = 'ALSO asked a question in the same message'
    const idx = src.indexOf(anchor)
    expect(idx).toBeGreaterThan(-1)
    // Window from the situation anchor to the close of that genReply call's opts argument.
    const window = src.slice(idx, idx + 1200)
    // The answer genReply must NOT be flagged as a confirmed booking (gates 1-3 must run).
    expect(window).not.toContain('bookingConfirmed: true')
  })

  it('the confirmation reply suppresses answering the side-question itself', () => {
    // The bookingConfirmed:true confirmation reply gains an instruction NOT to answer the
    // bundled question — that is delegated to the separate, gated reply.
    expect(src).toContain('Do NOT answer any other question the customer asked in this message')
  })
})
