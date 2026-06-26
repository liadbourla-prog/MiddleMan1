import { describe, it, expect } from 'vitest'
// Imported from contact-gate.js (not webhook.js): webhook.ts imports db/client.js, which throws at
// import time without DATABASE_URL, plus the LLM adapters. webhook.ts re-exports isInboundBlocked
// from this same module, so this tests the exact function the webhook uses.
import { isInboundBlocked } from './contact-gate.js'

describe('isInboundBlocked (contact restriction gate)', () => {
  const list = [{ phone: '+972501234567', addedAt: 'x' }]
  it('off → never blocked', () => {
    expect(isInboundBlocked(false, list, '+972500000000', 'customer')).toBe(false)
    expect(isInboundBlocked(false, list, '+972500000000', null)).toBe(false)
  })
  it('on → manager/delegated/contact/provider always pass', () => {
    expect(isInboundBlocked(true, [], '+972500000000', 'manager')).toBe(false)
    expect(isInboundBlocked(true, [], '+972500000000', 'delegated_user')).toBe(false)
    expect(isInboundBlocked(true, [], '+972500000000', 'contact')).toBe(false)
  })
  it('on → listed customer passes, unlisted customer/unknown blocked', () => {
    expect(isInboundBlocked(true, list, '+972501234567', 'customer')).toBe(false)
    expect(isInboundBlocked(true, list, '+972500000000', 'customer')).toBe(true)
    expect(isInboundBlocked(true, list, '+972500000000', null)).toBe(true)
  })
})
