import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { observeVoiceTells } from './voice-guard.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('observeVoiceTells — MONITOR-ONLY (detect + log, never mutate)', () => {
  it('returns the SAME string (identity) and logs once when a tell is present', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reply = 'לקבוע? (כן/לא)'
    const out = observeVoiceTells(reply, { businessId: 'biz-1', language: 'he' })
    // MONITOR-ONLY: byte-for-byte identity, never a mutated copy.
    expect(out).toBe(reply)
    expect(warn).toHaveBeenCalledTimes(1)
    const [, fields] = warn.mock.calls[0] as [string, Record<string, unknown>]
    expect(fields.gate).toBe('voice')
    expect(fields.businessId).toBe('biz-1')
    expect(fields.tells).toContain('yes_no_menu')
  })

  it('logs a numbered-menu tell with gate:voice', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reply = 'Pick a slot:\n1. 09:00\n2. 11:00'
    const out = observeVoiceTells(reply, { businessId: 'biz-2', language: 'en' })
    expect(out).toBe(reply)
    expect(warn).toHaveBeenCalledTimes(1)
    const [, fields] = warn.mock.calls[0] as [string, Record<string, unknown>]
    expect(fields.gate).toBe('voice')
    expect(fields.tells).toContain('numbered_menu')
  })

  it('a clean warm reply returns unchanged and does NOT log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reply = 'קיבלתי — קבעתי לך מחר ב-10:00, נתראה'
    const out = observeVoiceTells(reply, { businessId: 'biz-3', language: 'he' })
    expect(out).toBe(reply)
    expect(warn).not.toHaveBeenCalled()
  })

  it('exempts dead_end for a safe-fallback string (isSafeFallback:true)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A terse unavailability assertion with no forward step trips dead_end.
    const reply = 'אין מקום בשיעור הזה.'
    const out = observeVoiceTells(reply, { businessId: 'biz-4', language: 'he' }, { isSafeFallback: true })
    expect(out).toBe(reply)
    // dead_end is exempted, and nothing else fires → no warn at all.
    expect(warn).not.toHaveBeenCalled()
  })

  it('still logs OTHER tells on a safe-fallback string (only dead_end is exempted)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Unavailability (dead_end) AND a stacked-question tell in one reply.
    const reply = 'That time is not available. What day? What time?'
    const out = observeVoiceTells(reply, { businessId: 'biz-5', language: 'en' }, { isSafeFallback: true })
    expect(out).toBe(reply)
    expect(warn).toHaveBeenCalledTimes(1)
    const [, fields] = warn.mock.calls[0] as [string, Record<string, unknown>]
    const tells = fields.tells as string[]
    expect(tells).not.toContain('dead_end')
    expect(tells).toContain('stacked_questions')
  })

  it('without isSafeFallback, dead_end IS logged for a terse unavailability reply', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const reply = 'אין מקום בשיעור הזה.'
    const out = observeVoiceTells(reply, { businessId: 'biz-6', language: 'he' })
    expect(out).toBe(reply)
    expect(warn).toHaveBeenCalledTimes(1)
    const [, fields] = warn.mock.calls[0] as [string, Record<string, unknown>]
    expect(fields.tells).toContain('dead_end')
  })
})

// Source-introspection guard (mirrors customer-booking.test.ts readFileSync pattern):
// every gateReply return point must be wrapped in observeVoiceTells so a future edit
// can't silently bypass the deterministic Gate 7 (non-bypass invariant). The Branch-4
// voice monitor moved into the unified gate (grounding/output-gate.ts); makeGenReply
// delegates every reply to it.
describe('non-bypass invariant — gateReply returns are wrapped in observeVoiceTells', () => {
  it('every gateReply return point routes through observeVoiceTells', () => {
    const src = readFileSync(new URL('../grounding/output-gate.ts', import.meta.url), 'utf8')
    const fnStart = src.indexOf('export async function gateReply(')
    expect(fnStart).toBeGreaterThan(-1)
    const body = src.slice(fnStart) // gateReply is the last symbol in the file

    // Every value-returning `return {` inside gateReply must hand its reply to observeVoiceTells.
    const returns = (body.match(/\breturn\s+\{/g) ?? []).length
    const observed = (body.match(/reply: observeVoiceTells\(/g) ?? []).length
    expect(returns).toBeGreaterThanOrEqual(3)
    expect(observed).toBe(returns)

    // And the safe-fallback exemption is wired on the occupancy + final exits.
    expect(body).toMatch(/isSafeFallback: out === OCCUPANCY_FALLBACK\[language\]/)
    expect(body).toMatch(/isSafeFallback: reply === FABRICATED_TIME_FALLBACK\[language\]/)
  })
})
