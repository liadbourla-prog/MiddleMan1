import { describe, it, expect, vi, beforeEach } from 'vitest'

// T0.3 — proves Branch-4 makeGenReply routes EVERY reply through the unified gate
// (grounding/output-gate.ts) rather than its old inline gate body. Mocks only
// generateCustomerReply (the draft + regen source); everything else is the real wiring.
const generateCustomerReply = vi.fn<(input: unknown) => Promise<string>>()
vi.mock('../../adapters/llm/client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../adapters/llm/client.js')>()),
  generateCustomerReply: (input: unknown) => generateCustomerReply(input),
}))

import { makeGenReply } from './customer-booking.js'
import { BOOKING_NOT_CONFIRMED_FALLBACK, FABRICATED_TIME_FALLBACK, SAFE_AUDIT_FALLBACK } from '../grounding/output-gate.js'

const noSpine = async () => ({ openOverall: false, openInService: false, text: null })
const base = { boundaryTimes: [] as string[], bookingTimes: [] as string[] }
const reqInput = { businessName: 'X', language: 'he' as const, situation: 's', transcript: [] }

describe('makeGenReply delegates to the unified gate (T0.3)', () => {
  beforeEach(() => generateCustomerReply.mockReset())

  it('routes a phantom-booking draft through Gate 1 → fallback', async () => {
    generateCustomerReply
      .mockResolvedValueOnce('קבעתי לך תור') // initial draft asserts a booking
      .mockResolvedValueOnce('מצוין, קבעתי!') // regen still asserts
    const genReply = makeGenReply('', '', base, noSpine, 'biz')
    expect(await genReply(reqInput)).toBe(BOOKING_NOT_CONFIRMED_FALLBACK.he)
    expect(generateCustomerReply).toHaveBeenCalledTimes(2)
  })

  it('routes an unbacked time through Gate 2 → fallback', async () => {
    generateCustomerReply
      .mockResolvedValueOnce('יש מקום ב-17:00') // unbacked time
      .mockResolvedValueOnce('אולי ב-19:00') // regen still unbacked
    const genReply = makeGenReply('', '', base, noSpine, 'biz')
    expect(await genReply(reqInput)).toBe(FABRICATED_TIME_FALLBACK.he)
  })

  it('bookingConfirmed bypasses all gates (passes the draft, no regen)', async () => {
    generateCustomerReply.mockResolvedValueOnce('קבעתי לך תור ב-17:00')
    const genReply = makeGenReply('', '', base, noSpine, 'biz')
    expect(await genReply(reqInput, { bookingConfirmed: true })).toBe('קבעתי לך תור ב-17:00')
    expect(generateCustomerReply).toHaveBeenCalledTimes(1)
  })

  it('a clean draft passes through unchanged with no regen', async () => {
    generateCustomerReply.mockResolvedValueOnce('איזה יום מתאים לך?')
    const genReply = makeGenReply('', '', base, noSpine, 'biz')
    expect(await genReply(reqInput)).toBe('איזה יום מתאים לך?')
    expect(generateCustomerReply).toHaveBeenCalledTimes(1)
  })

  // T3.1b — Branch 4 ALWAYS enforces the action-claim gate; per-call `backs` supplies the backing.
  it('an UNbacked cancel claim trips the action gate → SAFE_AUDIT_FALLBACK', async () => {
    generateCustomerReply
      .mockResolvedValueOnce('ביטלתי לך את התור') // draft fabricates a cancel
      .mockResolvedValueOnce('ביטלתי לך את התור') // regen still fabricates
    const genReply = makeGenReply('', '', base, noSpine, 'biz')
    expect(await genReply(reqInput)).toBe(SAFE_AUDIT_FALLBACK.he)
    expect(generateCustomerReply).toHaveBeenCalledTimes(2)
  })

  it('the cancel-SUCCESS path passes backs:[cancelled] → a "ביטלתי" reply is allowed (no regen)', async () => {
    generateCustomerReply.mockResolvedValueOnce('ביטלתי לך את התור, נתראה בפעם הבאה!')
    const genReply = makeGenReply('', '', base, noSpine, 'biz')
    expect(await genReply(reqInput, { backs: ['cancelled'] })).toBe('ביטלתי לך את התור, נתראה בפעם הבאה!')
    expect(generateCustomerReply).toHaveBeenCalledTimes(1)
  })

  // F-rev4 (T-REGEN) — a thrown gate must NOT leak the ungated draft. Here the very first
  // generateCustomerReply (the draft) throws; makeGenReply fails to the gate-owned safe template,
  // never the raw draft.
  it('a thrown gate fails to SAFE_AUDIT_FALLBACK, never the ungated draft (F-rev4)', async () => {
    generateCustomerReply.mockRejectedValueOnce(new Error('LLM blew up'))
    const genReply = makeGenReply('', '', base, noSpine, 'biz')
    expect(await genReply(reqInput)).toBe(SAFE_AUDIT_FALLBACK.he)
  })
})
