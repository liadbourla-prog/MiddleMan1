import { describe, it, expect } from 'vitest'
import { transition } from '../../src/domain/booking/state-machine.js'

describe('attendance transitions', () => {
  it('allows confirmed → attended', () => {
    expect(transition('confirmed', 'attended')).toEqual({ ok: true, newState: 'attended' })
  })
  it('allows confirmed → no_show', () => {
    expect(transition('confirmed', 'no_show')).toEqual({ ok: true, newState: 'no_show' })
  })
  it('rejects requested → attended', () => {
    expect(transition('requested', 'attended').ok).toBe(false)
  })
  it('treats attended as terminal', () => {
    expect(transition('attended', 'confirmed').ok).toBe(false)
  })
})
