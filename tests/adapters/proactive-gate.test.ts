import { describe, it, expect, vi, afterEach } from 'vitest'
import { gateProactiveBody } from '../../src/adapters/llm/client.js'

// T2a.1 — the proactive seam (generateProactiveCustomerMessage) is the third output door.
// It ENFORCES the ACTION class when the caller supplies a structured truth set (swap to the
// caller's `fallback` template on an unbacked claim) and is the structural chokepoint;
// it MONITOR-logs the softer classes. Time is NOT enforced unless an allowlist is supplied
// (RED-TEAM D3 — most workers have no allowlist, so enforcing time there would over-fire).

afterEach(() => vi.restoreAllMocks())

describe('gateProactiveBody (T2a.1)', () => {
  it('ENFORCES action when backedActions is supplied: an unbacked "I texted them / booked you" swaps to the fallback template', () => {
    const r = gateProactiveBody("I've texted them and your booking is confirmed.", {
      language: 'en',
      fallback: 'A quick note from the studio — please get in touch.',
      backedActions: new Set(),
    })
    expect(r.swapped).toBe(true)
    expect(r.body).toBe('A quick note from the studio — please get in touch.')
  })

  it('passes an action claim that IS backed', () => {
    const r = gateProactiveBody("I've texted them.", {
      language: 'en',
      fallback: 'fallback',
      backedActions: new Set(['message_sent'] as const),
    })
    expect(r.swapped).toBe(false)
    expect(r.body).toBe("I've texted them.")
  })

  it('MONITOR-logs the softer classes when no backedActions is supplied (no swap) — H12 "customers have been notified"', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const r = gateProactiveBody('Good news — all your customers have been notified about the new hours.', {
      language: 'en',
      fallback: 'fallback',
    })
    expect(r.swapped).toBe(false)
    expect(r.body).toContain('customers have been notified')
    expect(warn).toHaveBeenCalledWith('[proactive-gate] unverified claim (monitor-only)', expect.objectContaining({ claims: expect.arrayContaining(['broadcast_sent']) }))
  })

  it('does NOT enforce time without an allowlist (D3) — a clock time passes through', () => {
    const r = gateProactiveBody('See you tomorrow at 14:00!', { language: 'en', fallback: 'fallback' })
    expect(r.swapped).toBe(false)
    expect(r.body).toContain('14:00')
  })

  it('DOES enforce time when an allowlist IS supplied (inert-by-default, ready for waitlist callers)', () => {
    const r = gateProactiveBody('A spot opened at 14:00 — want it?', {
      language: 'en',
      fallback: 'A spot opened — want it?',
      allowedTimes: ['10:00'],
    })
    expect(r.swapped).toBe(true)
    expect(r.body).toBe('A spot opened — want it?')
  })

  it('keeps the dunning payUrl precedent intact — a backed body with a link is untouched, and the fallback carries the link on swap', () => {
    const clean = gateProactiveBody('Please complete payment:\nhttps://pay.example/abc', { language: 'en', fallback: 'fb' })
    expect(clean.swapped).toBe(false)
    expect(clean.body).toContain('https://pay.example/abc')

    const swapped = gateProactiveBody("I've refunded you — all done.", {
      language: 'en',
      fallback: 'Reminder to pay:\nhttps://pay.example/abc',
      backedActions: new Set(),
    })
    expect(swapped.swapped).toBe(true)
    expect(swapped.body).toContain('https://pay.example/abc')
  })

  it('passes a body with no checkable claim untouched (warmth/glue is never gated)', () => {
    const r = gateProactiveBody('Hope you have a lovely week — let us know if you need anything!', {
      language: 'en',
      fallback: 'fallback',
      backedActions: new Set(),
    })
    expect(r.swapped).toBe(false)
  })
})
