import { describe, it, expect } from 'vitest'
import { decideFreedSlotAction } from './freed-slot-policy.js'

describe('decideFreedSlotAction', () => {
  it('auto policy → offer immediately', () => {
    expect(decideFreedSlotAction('auto')).toEqual({ kind: 'offer' })
  })

  it('never policy → suppress (no offer, no ask)', () => {
    expect(decideFreedSlotAction('never')).toEqual({ kind: 'suppress' })
  })

  it('ask policy → ask the owner, not first time', () => {
    expect(decideFreedSlotAction('ask')).toEqual({ kind: 'ask', firstTime: false })
  })

  it('null policy (never asked) → ask AND offer to set a standing preference', () => {
    expect(decideFreedSlotAction(null)).toEqual({ kind: 'ask', firstTime: true })
  })

  it('undefined policy is treated as never-asked (defensive)', () => {
    expect(decideFreedSlotAction(undefined as unknown as null)).toEqual({ kind: 'ask', firstTime: true })
  })

  it('never auto-fires unless explicitly set to auto', () => {
    // The cardinal invariant: no freed-slot offer goes out without either an explicit
    // 'auto' preference or owner approval. Any non-'auto' policy must NOT return 'offer'.
    for (const p of ['ask', 'never', null] as const) {
      expect(decideFreedSlotAction(p).kind).not.toBe('offer')
    }
  })
})
