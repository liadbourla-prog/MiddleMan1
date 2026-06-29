import { describe, it, expect } from 'vitest'
import { customerIntentSchema } from '../../src/adapters/llm/client.js'

// The extractor calls a live LLM (callWithSchema), so end-to-end intent assertions
// live in tests/quality. Here we pin the SCHEMA CONTRACT for the two escalation flags
// (specialArrangementRequest, restorePrevious). They are THREE-STATE:
//   - present true  → true   (intent fires)
//   - present false → false  (explicitly not requested)
//   - OMITTED        → undefined (NOT false — the model dropped the field; the caller
//                      can tell "model said no" apart from "model never spoke")
//   - non-boolean    → undefined (caught locally — must NOT become false, and must NOT
//                      nuke the whole-object parse)
// This prevents one template omission from silently disabling the feature.
describe('customerIntentSchema — specialArrangementRequest', () => {
  const base = { intent: 'booking', detectedLanguage: 'he' }

  it('keeps specialArrangementRequest=true when present', () => {
    const r = customerIntentSchema.parse({ ...base, specialArrangementRequest: true })
    expect(r.specialArrangementRequest).toBe(true)
  })

  it('keeps specialArrangementRequest=false when present', () => {
    const r = customerIntentSchema.parse({ ...base, specialArrangementRequest: false })
    expect(r.specialArrangementRequest).toBe(false)
  })

  it('leaves specialArrangementRequest undefined when omitted (NOT false)', () => {
    const r = customerIntentSchema.parse({ ...base })
    expect(r.specialArrangementRequest).toBeUndefined()
  })

  it('catches a non-boolean to undefined (NOT false) without failing the whole parse', () => {
    const r = customerIntentSchema.parse({
      ...base,
      specialArrangementRequest: 'yes' as unknown as boolean,
    })
    // localized catch → undefined, not false, not a thrown error
    expect(r.specialArrangementRequest).toBeUndefined()
    // rest of the object survived intact
    expect(r.intent).toBe('booking')
    expect(r.detectedLanguage).toBe('he')
  })
})

describe('customerIntentSchema — restorePrevious', () => {
  const base = { intent: 'booking', detectedLanguage: 'he' }

  it('keeps restorePrevious=true when present', () => {
    expect(customerIntentSchema.parse({ ...base, restorePrevious: true }).restorePrevious).toBe(true)
  })

  it('keeps restorePrevious=false when present', () => {
    expect(customerIntentSchema.parse({ ...base, restorePrevious: false }).restorePrevious).toBe(false)
  })

  it('leaves restorePrevious undefined when omitted (NOT false)', () => {
    expect(customerIntentSchema.parse({ ...base }).restorePrevious).toBeUndefined()
  })

  it('catches a non-boolean to undefined (NOT false) without failing the whole parse', () => {
    const r = customerIntentSchema.parse({
      ...base,
      restorePrevious: 'yes' as unknown as boolean,
    })
    expect(r.restorePrevious).toBeUndefined()
    expect(r.intent).toBe('booking')
    expect(r.detectedLanguage).toBe('he')
  })
})
