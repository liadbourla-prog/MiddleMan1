import { describe, it, expect } from 'vitest'
import { addAllowedContact, removeAllowedContact, isAllowed, type AllowedContact } from './allowed-contacts.js'

describe('allowed-contacts helpers', () => {
  it('adds a normalized contact and is idempotent', () => {
    const a = addAllowedContact(null, '+972501234567', 'Dana', '2026-06-26T00:00:00.000Z')
    expect(a).toEqual([{ phone: '+972501234567', label: 'Dana', addedAt: '2026-06-26T00:00:00.000Z' }])
    const b = addAllowedContact(a, '+972501234567', undefined, '2026-06-27T00:00:00.000Z')
    expect(b).toHaveLength(1) // no duplicate; original entry preserved
    expect(b[0]!.label).toBe('Dana')
  })

  it('throws on an invalid phone number', () => {
    expect(() => addAllowedContact(null, '0501234567', undefined, '2026-06-26T00:00:00.000Z')).toThrow()
  })

  it('removes a contact', () => {
    const list: AllowedContact[] = [{ phone: '+972501234567', addedAt: 'x' }]
    expect(removeAllowedContact(list, '+972501234567')).toEqual([])
    expect(removeAllowedContact(list, '+972500000000')).toEqual(list) // no-op
  })

  it('isAllowed matches exactly on E.164', () => {
    const list: AllowedContact[] = [{ phone: '+972501234567', addedAt: 'x' }]
    expect(isAllowed(list, '+972501234567')).toBe(true)
    expect(isAllowed(list, '+972500000000')).toBe(false)
    expect(isAllowed(null, '+972501234567')).toBe(false)
  })
})
