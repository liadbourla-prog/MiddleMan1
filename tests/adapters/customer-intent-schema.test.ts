import { describe, it, expect } from 'vitest'
import { customerIntentSchema } from '../../src/adapters/llm/client.js'

// The extractor calls a live LLM (callWithSchema), so end-to-end intent assertions
// live in tests/quality. Here we pin the SCHEMA CONTRACT: new flags must parse when
// present and default safely (false) when the model omits them.
describe('customerIntentSchema — specialArrangementRequest', () => {
  const base = { intent: 'booking', detectedLanguage: 'he' }

  it('keeps specialArrangementRequest=true when present', () => {
    const r = customerIntentSchema.parse({ ...base, specialArrangementRequest: true })
    expect(r.specialArrangementRequest).toBe(true)
  })

  it('defaults specialArrangementRequest to false when omitted', () => {
    const r = customerIntentSchema.parse({ ...base })
    expect(r.specialArrangementRequest).toBe(false)
  })

  it('coerces a non-boolean to false (catch)', () => {
    const r = customerIntentSchema.parse({ ...base, specialArrangementRequest: 'yes' as unknown as boolean })
    expect(r.specialArrangementRequest).toBe(false)
  })
})

describe('customerIntentSchema — restorePrevious', () => {
  const base = { intent: 'booking', detectedLanguage: 'he' }

  it('keeps restorePrevious=true when present', () => {
    expect(customerIntentSchema.parse({ ...base, restorePrevious: true }).restorePrevious).toBe(true)
  })

  it('defaults restorePrevious to false when omitted', () => {
    expect(customerIntentSchema.parse({ ...base }).restorePrevious).toBe(false)
  })
})
