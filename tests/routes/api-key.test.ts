import { describe, it, expect } from 'vitest'
import { generateApiKey, hashApiKey } from '../../src/routes/public-api/auth.js'

describe('api key util', () => {
  it('generates a publishable key with pk_ prefix and matching hash', () => {
    const k = generateApiKey('publishable')
    expect(k.raw.startsWith('pk_live_')).toBe(true)
    expect(k.prefix).toBe(k.raw.slice(0, 12))
    expect(k.hash).toBe(hashApiKey(k.raw))
    expect(k.hash).toHaveLength(64) // sha256 hex
  })

  it('generates a secret key with sk_ prefix', () => {
    const k = generateApiKey('secret')
    expect(k.raw.startsWith('sk_live_')).toBe(true)
  })

  it('hashApiKey is deterministic and distinct per input', () => {
    expect(hashApiKey('abc')).toBe(hashApiKey('abc'))
    expect(hashApiKey('abc')).not.toBe(hashApiKey('abd'))
  })
})
