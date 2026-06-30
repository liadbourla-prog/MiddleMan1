import { describe, it, expect } from 'vitest'
import { businessProfileSchema } from './apply.js'
import { requiredActionForInstruction } from '../authorization/check.js'

// The Branch-3 owner-config entry that stores the business's physical address
// (businesses.address, surfaced to customers in Branch 4). The apply writer itself is
// DB-backed (integration-level); this pins the deterministic schema parse the classifier
// output flows through, plus the delegated-user permission gate.

describe('businessProfileSchema — address', () => {
  it('parses a well-formed address ("our address is Herzl 1, Tel Aviv")', () => {
    const parsed = businessProfileSchema.safeParse({ field: 'address', value: 'הרצל 1, תל אביב' })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.field).toBe('address')
      expect(parsed.data.value).toBe('הרצל 1, תל אביב')
    }
  })

  it('trims surrounding whitespace from the address', () => {
    const parsed = businessProfileSchema.safeParse({ field: 'address', value: '  5 Dizengoff St  ' })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.value).toBe('5 Dizengoff St')
  })

  it('rejects an empty / whitespace-only address (nothing to store)', () => {
    expect(businessProfileSchema.safeParse({ field: 'address', value: '   ' }).success).toBe(false)
    expect(businessProfileSchema.safeParse({ field: 'address', value: '' }).success).toBe(false)
  })

  it('rejects an unknown profile field (address-only for now)', () => {
    expect(businessProfileSchema.safeParse({ field: 'phone', value: '+972...' }).success).toBe(false)
  })

  it('captures structured components when the classifier supplies them', () => {
    const parsed = businessProfileSchema.safeParse({
      field: 'address',
      value: 'Herzl 1, Tel Aviv, Israel',
      streetAddress: 'Herzl 1',
      city: 'Tel Aviv',
      country: 'Israel',
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.streetAddress).toBe('Herzl 1')
      expect(parsed.data.city).toBe('Tel Aviv')
      expect(parsed.data.country).toBe('Israel')
      expect(parsed.data.region).toBeUndefined()
    }
  })

  it('drops blank structured parts to undefined (no empty strings persisted)', () => {
    const parsed = businessProfileSchema.safeParse({ field: 'address', value: 'Herzl 1', city: '   ' })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.city).toBeUndefined()
  })

  it('keeps a pasted Google Maps link in mapsUrl', () => {
    const parsed = businessProfileSchema.safeParse({ field: 'address', value: 'Herzl 1', mapsUrl: 'https://g.page/studio' })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.mapsUrl).toBe('https://g.page/studio')
  })

  it('ignores a non-URL mapsUrl rather than failing the whole instruction', () => {
    const parsed = businessProfileSchema.safeParse({ field: 'address', value: 'Herzl 1', mapsUrl: 'near the mall' })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.mapsUrl).toBeUndefined()
  })
})

describe('requiredActionForInstruction — business_profile', () => {
  it('gates business_profile behind policy.change for delegated users', () => {
    expect(requiredActionForInstruction('business_profile')).toBe('policy.change')
  })
})
