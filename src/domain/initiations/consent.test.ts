import { describe, it, expect } from 'vitest'
import { isPromotionalSuppressed } from './consent.js'

describe('isPromotionalSuppressed', () => {
  it('global messagingOptOut suppresses regardless of opts/category', () => {
    expect(isPromotionalSuppressed(true, null, undefined)).toBe(true)
    expect(isPromotionalSuppressed(true, { winback: true }, 'winback')).toBe(true)
    expect(isPromotionalSuppressed(true, { all: true }, 'review')).toBe(true)
    expect(isPromotionalSuppressed(true, {}, 'coldfill')).toBe(true)
  })

  it('no opt-outs map → not suppressed', () => {
    expect(isPromotionalSuppressed(false, null, 'winback')).toBe(false)
    expect(isPromotionalSuppressed(false, undefined, 'winback')).toBe(false)
  })

  it('all:true suppresses regardless of category (incl. undefined)', () => {
    expect(isPromotionalSuppressed(false, { all: true }, 'winback')).toBe(true)
    expect(isPromotionalSuppressed(false, { all: true }, 'review')).toBe(true)
    expect(isPromotionalSuppressed(false, { all: true }, undefined)).toBe(true)
  })

  it('category opt-out suppresses only the matching category', () => {
    expect(isPromotionalSuppressed(false, { winback: true }, 'winback')).toBe(true)
    expect(isPromotionalSuppressed(false, { winback: true }, 'review')).toBe(false)
    expect(isPromotionalSuppressed(false, { winback: true }, undefined)).toBe(false)
  })

  it('empty opt-outs map → not suppressed', () => {
    expect(isPromotionalSuppressed(false, {}, 'winback')).toBe(false)
    expect(isPromotionalSuppressed(false, {}, undefined)).toBe(false)
  })
})
