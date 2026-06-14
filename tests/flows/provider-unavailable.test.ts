// Pure unit test for parseProviderUnavailable — the customer-side parser that
// turns the engine's 'provider_unavailable|Name|dow:HH:MM-HH:MM;...' sentinel
// into a readable instructor + hours phrase. No DB, runs under `npm test`.

import { describe, it, expect } from 'vitest'
import { parseProviderUnavailable } from '../../src/domain/flows/customer-booking.js'

describe('parseProviderUnavailable', () => {
  it('returns null for a non-sentinel reason', () => {
    expect(parseProviderUnavailable('Slot is no longer available', 'en')).toBeNull()
    expect(parseProviderUnavailable('', 'en')).toBeNull()
  })

  it('parses a single day/time correctly (times contain colons)', () => {
    const res = parseProviderUnavailable('provider_unavailable|Dana|1:09:00-13:00', 'en')
    expect(res).toEqual({ name: 'Dana', hoursPhrase: 'Monday 09:00-13:00' })
  })

  it('parses multiple days and joins them', () => {
    const res = parseProviderUnavailable('provider_unavailable|Dana|1:09:00-13:00;3:16:00-20:00', 'en')
    expect(res?.name).toBe('Dana')
    expect(res?.hoursPhrase).toBe('Monday 09:00-13:00, Wednesday 16:00-20:00')
  })

  it('renders Hebrew day names', () => {
    const res = parseProviderUnavailable('provider_unavailable|דנה|0:08:00-12:00', 'he')
    expect(res?.name).toBe('דנה')
    expect(res?.hoursPhrase).toBe('ראשון 08:00-12:00')
  })

  it('handles an instructor with no hours set (empty hours segment)', () => {
    const res = parseProviderUnavailable('provider_unavailable|Dana|', 'en')
    expect(res).toEqual({ name: 'Dana', hoursPhrase: '' })
  })
})
