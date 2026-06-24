import { describe, it, expect } from 'vitest'
import {
  metaCategory,
  buildCreateTemplatePayload,
  isAlreadyExistsError,
  classifyCreateResponse,
} from '../../src/adapters/whatsapp/template-provisioning.js'
import { WA_TEMPLATES } from '../../src/adapters/whatsapp/templates.js'

describe('metaCategory', () => {
  it('maps catalog categories to Meta enums', () => {
    expect(metaCategory('utility')).toBe('UTILITY')
    expect(metaCategory('marketing')).toBe('MARKETING')
    expect(metaCategory('authentication')).toBe('AUTHENTICATION')
  })
})

describe('buildCreateTemplatePayload', () => {
  it('builds a BODY component with a name, language, category and an example per variable', () => {
    const payload = buildCreateTemplatePayload(WA_TEMPLATES.payment_dunning_1, 'he')
    expect(payload).toMatchObject({ name: 'payment_dunning_1', language: 'he', category: 'UTILITY' })
    const components = payload['components'] as Array<Record<string, unknown>>
    expect(components).toHaveLength(1)
    expect(components[0]).toMatchObject({ type: 'BODY' })
    // [service, business] → exactly two example values, nested one level (body_text: [[...]]).
    const example = components[0]!['example'] as { body_text: string[][] }
    expect(example.body_text).toHaveLength(1)
    expect(example.body_text[0]).toHaveLength(2)
  })

  it('produces one example value per declared variable for every catalog template', () => {
    for (const def of Object.values(WA_TEMPLATES)) {
      const payload = buildCreateTemplatePayload(def)
      const components = payload['components'] as Array<Record<string, unknown>>
      const example = components[0]!['example'] as { body_text: string[][] } | undefined
      // Every catalog template has ≥1 variable, so an example block must exist and match arity.
      expect(example, def.name).toBeDefined()
      expect(example!.body_text[0]!.length, def.name).toBe(def.params.length)
    }
  })

  it('keeps the body text verbatim from the catalog', () => {
    const payload = buildCreateTemplatePayload(WA_TEMPLATES.winback_reengage, 'he')
    const components = payload['components'] as Array<Record<string, unknown>>
    expect(components[0]!['text']).toBe(WA_TEMPLATES.winback_reengage.bodies.he)
  })
})

describe('isAlreadyExistsError', () => {
  it('detects Meta duplicate-name errors case-insensitively', () => {
    expect(isAlreadyExistsError('{"error":{"message":"template name already exists"}}')).toBe(true)
    expect(isAlreadyExistsError('Template Name Already Exists in this WABA')).toBe(true)
    expect(isAlreadyExistsError('{"error":{"message":"invalid parameter"}}')).toBe(false)
  })
})

describe('classifyCreateResponse', () => {
  it('treats a duplicate error as idempotent success (exists)', () => {
    const out = classifyCreateResponse(false, 400, '{"error":{"message":"template already exists"}}')
    expect(out.status).toBe('exists')
    expect(out.error).toBeNull()
  })

  it('records a real failure as error with the http status + body', () => {
    const out = classifyCreateResponse(false, 401, 'Unauthorized')
    expect(out.status).toBe('error')
    expect(out.error).toContain('401')
  })

  it('maps a successful create to pending with the returned template id', () => {
    const out = classifyCreateResponse(true, 200, '{"id":"123","status":"PENDING"}')
    expect(out.status).toBe('pending')
    expect(out.metaTemplateId).toBe('123')
  })

  it('maps an approved/rejected status through', () => {
    expect(classifyCreateResponse(true, 200, '{"id":"1","status":"APPROVED"}').status).toBe('approved')
    expect(classifyCreateResponse(true, 200, '{"id":"1","status":"REJECTED"}').status).toBe('rejected')
  })

  it('defaults to pending when the body is unparseable', () => {
    expect(classifyCreateResponse(true, 200, 'not-json').status).toBe('pending')
  })
})
