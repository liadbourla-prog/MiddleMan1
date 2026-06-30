import { describe, it, expect } from 'vitest'
import { customerIntentSchema } from '../../src/adapters/llm/client.js'

// T0.6 — selfGenderEvidence on the customer intent extractor (schema + JSON template + rule).
describe('selfGenderEvidence extractor field', () => {
  const field = customerIntentSchema.shape.selfGenderEvidence

  it('accepts male/female/none', () => {
    expect(field.parse('male')).toBe('male')
    expect(field.parse('female')).toBe('female')
    expect(field.parse('none')).toBe('none')
  })

  it('defaults to "none" when omitted (consumer always has a value)', () => {
    expect(field.parse(undefined)).toBe('none')
    // omitted from a full parse → none
    const parsed = customerIntentSchema.parse({ intent: 'booking' } as unknown)
    expect(parsed.selfGenderEvidence).toBe('none')
  })

  it('falls back to "none" on an invalid value (never throws)', () => {
    expect(field.parse('banana')).toBe('none')
    expect(field.parse(42)).toBe('none')
  })
})
