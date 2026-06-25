import { describe, it, expect } from 'vitest'
import { deriveLastName } from './customer-resolver.js'

describe('deriveLastName', () => {
  it('returns the last token of a multi-word name', () => {
    expect(deriveLastName('Guy Cohen')).toBe('Cohen')
    expect(deriveLastName('  Guy   Cohen  ')).toBe('Cohen')
    expect(deriveLastName('Mary Jane Watson')).toBe('Watson')
  })
  it('returns null for single-token, empty, or nullish names', () => {
    expect(deriveLastName('Guy')).toBeNull()
    expect(deriveLastName('')).toBeNull()
    expect(deriveLastName('   ')).toBeNull()
    expect(deriveLastName(null)).toBeNull()
    expect(deriveLastName(undefined)).toBeNull()
  })
})
