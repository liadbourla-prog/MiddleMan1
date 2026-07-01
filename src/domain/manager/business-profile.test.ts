import { describe, it, expect } from 'vitest'
import { businessProfileSchema, policyChangeSchema } from './apply.js'
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

  it('rejects an unknown profile field', () => {
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
    if (parsed.success && parsed.data.field === 'address') {
      expect(parsed.data.streetAddress).toBe('Herzl 1')
      expect(parsed.data.city).toBe('Tel Aviv')
      expect(parsed.data.country).toBe('Israel')
      expect(parsed.data.region).toBeUndefined()
    }
  })

  it('drops blank structured parts to undefined (no empty strings persisted)', () => {
    const parsed = businessProfileSchema.safeParse({ field: 'address', value: 'Herzl 1', city: '   ' })
    expect(parsed.success).toBe(true)
    if (parsed.success && parsed.data.field === 'address') expect(parsed.data.city).toBeUndefined()
  })

  it('keeps a pasted Google Maps link in mapsUrl', () => {
    const parsed = businessProfileSchema.safeParse({ field: 'address', value: 'Herzl 1', mapsUrl: 'https://g.page/studio' })
    expect(parsed.success).toBe(true)
    if (parsed.success && parsed.data.field === 'address') expect(parsed.data.mapsUrl).toBe('https://g.page/studio')
  })

  it('ignores a non-URL mapsUrl rather than failing the whole instruction', () => {
    const parsed = businessProfileSchema.safeParse({ field: 'address', value: 'Herzl 1', mapsUrl: 'near the mall' })
    expect(parsed.success).toBe(true)
    if (parsed.success && parsed.data.field === 'address') expect(parsed.data.mapsUrl).toBeUndefined()
  })
})

describe('requiredActionForInstruction — business_profile', () => {
  it('gates business_profile behind policy.change for delegated users', () => {
    expect(requiredActionForInstruction('business_profile')).toBe('policy.change')
  })
})

describe('businessProfileSchema — scalar owner-preference fields (Tier 2)', () => {
  it('parses a business name', () => {
    const p = businessProfileSchema.safeParse({ field: 'name', value: 'Studio Flow' })
    expect(p.success).toBe(true)
    if (p.success) expect(p.data.value).toBe('Studio Flow')
  })

  it('parses bot_persona enum and rejects a bad value', () => {
    expect(businessProfileSchema.safeParse({ field: 'bot_persona', value: 'female' }).success).toBe(true)
    expect(businessProfileSchema.safeParse({ field: 'bot_persona', value: 'neutral' }).success).toBe(true)
    expect(businessProfileSchema.safeParse({ field: 'bot_persona', value: 'robot' }).success).toBe(false)
  })

  it('parses confirmation_gate enum', () => {
    expect(businessProfileSchema.safeParse({ field: 'confirmation_gate', value: 'post_payment' }).success).toBe(true)
    expect(businessProfileSchema.safeParse({ field: 'confirmation_gate', value: 'someday' }).success).toBe(false)
  })

  it('parses default_language enum', () => {
    expect(businessProfileSchema.safeParse({ field: 'default_language', value: 'he' }).success).toBe(true)
    expect(businessProfileSchema.safeParse({ field: 'default_language', value: 'fr' }).success).toBe(false)
  })

  it('available_247 needs a real boolean — no stringy coercion', () => {
    expect(businessProfileSchema.safeParse({ field: 'available_247', value: true }).success).toBe(true)
    expect(businessProfileSchema.safeParse({ field: 'available_247', value: false }).success).toBe(true)
    // "false" must NOT sneak through as truthy — this is the whole reason we avoid z.coerce.boolean.
    expect(businessProfileSchema.safeParse({ field: 'available_247', value: 'false' }).success).toBe(false)
  })

  it('google_review_url must be a URL', () => {
    expect(businessProfileSchema.safeParse({ field: 'google_review_url', value: 'https://g.page/studio/review' }).success).toBe(true)
    expect(businessProfileSchema.safeParse({ field: 'google_review_url', value: 'not a link' }).success).toBe(false)
  })

  it('brand_voice accepts free text and rejects blank', () => {
    expect(businessProfileSchema.safeParse({ field: 'brand_voice', value: 'warm and playful' }).success).toBe(true)
    expect(businessProfileSchema.safeParse({ field: 'brand_voice', value: '   ' }).success).toBe(false)
  })
})

describe('policyChangeSchema — reminder_offset (Tier 2)', () => {
  it('accepts reminder_offset with valueHours', () => {
    const p = policyChangeSchema.safeParse({ subtype: 'reminder_offset', valueHours: 48, description: 'remind 48h before' })
    expect(p.success).toBe(true)
    if (p.success) {
      expect(p.data.subtype).toBe('reminder_offset')
      expect(p.data.valueHours).toBe(48)
    }
  })
})
