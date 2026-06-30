import { describe, it, expect } from 'vitest'
import { identities } from '../../src/db/schema.js'

// T0.3 — the two nullable addressee-gender columns on identities (migration 0055).
describe('identities addressee-gender columns', () => {
  it('addresseeGender is a nullable male|female enum (text)', () => {
    const col = identities.addresseeGender
    expect(col).toBeDefined()
    expect(col.notNull).toBe(false)
    expect([...col.enumValues].sort()).toEqual(['female', 'male'])
  })

  it('addresseeGenderSource is a nullable provenance enum (text)', () => {
    const col = identities.addresseeGenderSource
    expect(col).toBeDefined()
    expect(col.notNull).toBe(false)
    expect([...col.enumValues].sort()).toEqual(['default', 'explicit', 'name', 'self_morphology'])
  })
})
