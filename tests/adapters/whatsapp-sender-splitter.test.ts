/**
 * T4.1 — WhatsApp 4096-char message splitter
 *
 * Contract: splitForWhatsApp(body, limit?) guarantees:
 *   - Every part has length <= limit (default 4096).
 *   - Concatenating all parts with the boundary consumed yields the original content
 *     (i.e., no content is lost, only boundary whitespace may be trimmed at split points).
 *   - No part is empty.
 *   - Preferentially splits at paragraph boundaries (\n\n), then line boundaries (\n),
 *     then hard-chunks at `limit` if no boundary is available.
 */
import { describe, it, expect } from 'vitest'
import { splitForWhatsApp } from '../../src/adapters/whatsapp/sender.js'

const LIMIT = 4096

describe('splitForWhatsApp', () => {
  it('returns the body unchanged in a single-element array when body.length <= limit', () => {
    const body = 'Hello, world!'
    const parts = splitForWhatsApp(body)
    expect(parts).toEqual([body])
  })

  it('returns a single-element array for exactly 4096 chars', () => {
    const body = 'x'.repeat(LIMIT)
    const parts = splitForWhatsApp(body)
    expect(parts).toHaveLength(1)
    expect(parts[0]).toBe(body)
  })

  it('returns a single-element array for a 100-char body (well under limit)', () => {
    const body = 'a'.repeat(100)
    const parts = splitForWhatsApp(body)
    expect(parts).toHaveLength(1)
    expect(parts[0]).toBe(body)
  })

  it('splits a body just over limit at a newline boundary, both parts <= limit', () => {
    // 2048 + newline + 2048 = 4097 chars — just over the 4096 limit
    const line1 = 'a'.repeat(2048)
    const line2 = 'b'.repeat(2048)
    const body2 = line1 + '\n' + line2  // 4097 chars
    const parts = splitForWhatsApp(body2)
    expect(parts.length).toBeGreaterThanOrEqual(2)
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(LIMIT)
    }
    // Content is preserved: joining the parts recovers the original (minus the boundary newline consumed by trimming)
    // At minimum: both halves appear somewhere in the combined output
    const combined = parts.join('')
    expect(combined).toContain(line1)
    expect(combined).toContain(line2)
  })

  it('splits a 5000-char body with no whitespace into parts each <= 4096, content preserved', () => {
    const body = 'z'.repeat(5000)
    const parts = splitForWhatsApp(body)
    expect(parts.length).toBeGreaterThanOrEqual(2)
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(LIMIT)
      expect(p.length).toBeGreaterThan(0)
    }
    // Concatenation must recover exact content (no boundary whitespace to lose in a no-whitespace string)
    expect(parts.join('')).toBe(body)
  })

  it('hard-chunk never severs a surrogate pair (astral char straddling the limit)', () => {
    // 4095 'a' + '😀' (a 2-code-unit astral char). A naive slice at 4096 would cut the
    // emoji's high surrogate into part 1 and its low surrogate into part 2 → two lone
    // surrogates → a corrupt char on the wire. The fix backs the cut off by one.
    const body = 'a'.repeat(4095) + '😀'  // 4097 UTF-16 code units
    const parts = splitForWhatsApp(body)
    expect(parts).toHaveLength(2)
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(LIMIT)
      // No unpaired surrogate in any part: spreading by code point then re-joining must
      // be a no-op. A lone surrogate would survive the round-trip unchanged but flags via
      // the explicit surrogate scan below.
      expect([...p].join('')).toBe(p)
      for (const ch of p) {
        const code = ch.codePointAt(0)!
        // Any char >= 0x10000 came from a *complete* surrogate pair; a lone surrogate
        // (0xD800–0xDFFF) iterated alone is the corruption we are guarding against.
        expect(code >= 0xd800 && code <= 0xdfff).toBe(false)
      }
    }
    // The emoji lands wholly in part 2; part 1 is the 4095 'a' run pushed off by the back-off.
    expect(parts[1]).toContain('😀')
    expect(parts.join('')).toBe(body)
  })

  it('splits a 9000-char multi-paragraph body at paragraph boundaries, all parts <= 4096', () => {
    // Four DISTINCT ~2250-char paragraphs separated by \n\n. Distinct content lets the
    // reconstruction assertion below actually catch mid-paragraph truncation or reorder.
    const paras = ['A', 'B', 'C', 'D'].map(c => c.repeat(2247))
    const body = paras.join('\n\n')
    // total: 4 * 2247 + 3 * 2 = 8994 chars
    const parts = splitForWhatsApp(body)
    expect(parts.length).toBeGreaterThanOrEqual(2)
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(LIMIT)
      expect(p.length).toBeGreaterThan(0)
    }
    // Content preservation: stripping all whitespace from the joined parts must equal the
    // body with whitespace stripped (only boundary \n\n is consumed by the split — never
    // any paragraph content). Each paragraph survives whole and in order.
    const stripWs = (s: string) => s.replace(/\s+/g, '')
    expect(stripWs(parts.join(''))).toBe(stripWs(body))
    for (const para of paras) {
      // No paragraph is split across a part boundary — each appears intact in some part.
      expect(parts.some(p => p.includes(para))).toBe(true)
    }
  })

  it('handles a body that is exactly limit+1 with no whitespace as 2 parts', () => {
    const body = 'x'.repeat(LIMIT + 1)
    const parts = splitForWhatsApp(body)
    expect(parts).toHaveLength(2)
    expect(parts[0]).toBe('x'.repeat(LIMIT))
    expect(parts[1]).toBe('x')
    expect(parts.join('')).toBe(body)
  })

  it('never emits empty parts', () => {
    // Edge: body starting/ending with \n\n
    const body = '\n\n' + 'a'.repeat(4097) + '\n\n'
    const parts = splitForWhatsApp(body)
    for (const p of parts) {
      expect(p.trim().length).toBeGreaterThan(0)
    }
  })

  it('uses a custom limit when provided', () => {
    const body = 'abcde'
    const parts = splitForWhatsApp(body, 3)
    expect(parts.length).toBeGreaterThanOrEqual(2)
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(3)
    }
    expect(parts.join('')).toBe(body)
  })

  it('sim/capture path: a >4096 body yields multiple captured parts (contract pin)', () => {
    // This is a pure splitter test; capture-path integration is verified separately.
    // Just verify that a 5000-char body produces ≥2 parts from the splitter.
    const body = 'A'.repeat(5000)
    const parts = splitForWhatsApp(body)
    expect(parts.length).toBeGreaterThanOrEqual(2)
  })
})
