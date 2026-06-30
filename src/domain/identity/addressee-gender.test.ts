import { describe, it, expect } from 'vitest'
import { resolveAddresseeGender, shouldPersist } from './addressee-gender.js'

describe('resolveAddresseeGender', () => {
  it('returns null when nothing resolves', () => {
    expect(resolveAddresseeGender({})).toBeNull()
    expect(resolveAddresseeGender({ stored: null, storedSource: null, nameSignal: null, morphologySignal: null })).toBeNull()
  })

  it('resolves a name-only signal at rank "name"', () => {
    expect(resolveAddresseeGender({ nameSignal: 'female' })).toEqual({ gender: 'female', source: 'name' })
  })

  it('prefers self-morphology over a name signal (higher confidence)', () => {
    expect(resolveAddresseeGender({ nameSignal: 'male', morphologySignal: 'female' }))
      .toEqual({ gender: 'female', source: 'self_morphology' })
  })

  it('self-morphology overrides a stored name guess (the correction case)', () => {
    expect(resolveAddresseeGender({ stored: 'male', storedSource: 'name', morphologySignal: 'female' }))
      .toEqual({ gender: 'female', source: 'self_morphology' })
  })

  it('NEVER downgrades an explicit owner-set value', () => {
    expect(resolveAddresseeGender({ stored: 'female', storedSource: 'explicit', nameSignal: 'male', morphologySignal: 'male' }))
      .toEqual({ gender: 'female', source: 'explicit' })
  })

  it('keeps the stored value when there is no fresh signal this turn', () => {
    expect(resolveAddresseeGender({ stored: 'male', storedSource: 'self_morphology' }))
      .toEqual({ gender: 'male', source: 'self_morphology' })
  })

  it('a fresh morphology refreshes an equal-rank stored morphology (latest wins)', () => {
    expect(resolveAddresseeGender({ stored: 'male', storedSource: 'self_morphology', morphologySignal: 'female' }))
      .toEqual({ gender: 'female', source: 'self_morphology' })
  })

  it('overrides a stored default with a name signal', () => {
    expect(resolveAddresseeGender({ stored: 'male', storedSource: 'default', nameSignal: 'female' }))
      .toEqual({ gender: 'female', source: 'name' })
  })
})

describe('shouldPersist', () => {
  it('persists when nothing is stored yet', () => {
    expect(shouldPersist(null, null, { gender: 'female', source: 'name' })).toBe(true)
  })

  it('persists when the resolved gender or source changed (incl. a confidence upgrade)', () => {
    expect(shouldPersist('male', 'name', { gender: 'female', source: 'self_morphology' })).toBe(true)
    expect(shouldPersist('male', 'name', { gender: 'male', source: 'self_morphology' })).toBe(true)
  })

  it('does NOT persist when identical to stored', () => {
    expect(shouldPersist('male', 'self_morphology', { gender: 'male', source: 'self_morphology' })).toBe(false)
  })

  it('does NOT persist a null resolution', () => {
    expect(shouldPersist('male', 'name', null)).toBe(false)
  })

  it('does NOT persist a downgrade (defensive)', () => {
    expect(shouldPersist('female', 'explicit', { gender: 'male', source: 'name' })).toBe(false)
  })
})
