import { describe, it, expect, afterEach, vi } from 'vitest'
import { operatorAddresseeGender } from '../../src/adapters/llm/client.js'

// T1.5 — operator (Branch 1) addressee gender comes from the OPERATOR_GENDER env, defaulting to
// masculine (decision 1 floor). One known human; lowest stakes, configured not inferred.
describe('operatorAddresseeGender', () => {
  afterEach(() => { vi.unstubAllEnvs() })

  it('defaults to masculine when the env is unset', () => {
    vi.stubEnv('OPERATOR_GENDER', '')
    expect(operatorAddresseeGender()).toBe('male')
  })

  it('honours OPERATOR_GENDER=female', () => {
    vi.stubEnv('OPERATOR_GENDER', 'female')
    expect(operatorAddresseeGender()).toBe('female')
  })

  it('falls back to masculine on any unrecognised value (the floor)', () => {
    vi.stubEnv('OPERATOR_GENDER', 'banana')
    expect(operatorAddresseeGender()).toBe('male')
  })
})
