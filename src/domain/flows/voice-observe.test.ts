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
// the three makeGenReply return points must each be wrapped in observeVoiceTells so a
// future edit can't silently bypass the deterministic Gate 7 (non-bypass invariant).
describe('non-bypass invariant — makeGenReply returns are wrapped in observeVoiceTells', () => {
  it('every makeGenReply return point routes through observeVoiceTells', () => {
    const src = readFileSync(new URL('./customer-booking.ts', import.meta.url), 'utf8')
    // Isolate the makeGenReply body so we count ITS returns, not other functions'.
    const fnStart = src.indexOf('function makeGenReply(')
    expect(fnStart).toBeGreaterThan(-1)
    // Scope to the INNER async reply function — the factory's `return async (...) => {`
    // is itself a return we must not count (it yields the function, not a reply).
    const innerStart = src.indexOf('return async (input, opts', fnStart)
    expect(innerStart).toBeGreaterThan(-1)
    const after = src.slice(innerStart)
    // The body ends at the next top-level function/export declaration.
    const endRel = after.indexOf('\nexport function buildBusinessFacts(')
    expect(endRel).toBeGreaterThan(-1)
    const body = after.slice('return async (input, opts'.length, endRel)

    // Every `return ` inside the inner reply function must hand its value to observeVoiceTells.
    const returns = (body.match(/\breturn\s+/g) ?? []).length
    const observed = (body.match(/return observeVoiceTells\(/g) ?? []).length
    expect(returns).toBeGreaterThanOrEqual(3)
    expect(observed).toBe(returns)

    // And the safe-fallback exemption is wired on the occupancy + final exits.
    expect(body).toMatch(/isSafeFallback: out === OCCUPANCY_FALLBACK\[input\.language\]/)
    expect(body).toMatch(/isSafeFallback: reply === FABRICATED_TIME_FALLBACK\[input\.language\]/)
  })
})
