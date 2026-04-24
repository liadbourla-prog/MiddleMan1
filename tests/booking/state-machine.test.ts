import { describe, it, expect } from 'vitest'
import { transition, canTransition } from '../../src/domain/booking/state-machine.js'
import { TERMINAL_STATES, VALID_TRANSITIONS } from '../../src/domain/booking/types.js'
import type { BookingState } from '../../src/domain/booking/types.js'

describe('booking state machine', () => {
  describe('valid transitions', () => {
    it('inquiry → requested', () => {
      expect(transition('inquiry', 'requested')).toEqual({ ok: true, newState: 'requested' })
    })

    it('requested → held', () => {
      expect(transition('requested', 'held')).toEqual({ ok: true, newState: 'held' })
    })

    it('held → confirmed', () => {
      expect(transition('held', 'confirmed')).toEqual({ ok: true, newState: 'confirmed' })
    })

    it('held → pending_payment', () => {
      expect(transition('held', 'pending_payment')).toEqual({ ok: true, newState: 'pending_payment' })
    })

    it('pending_payment → confirmed', () => {
      expect(transition('pending_payment', 'confirmed')).toEqual({ ok: true, newState: 'confirmed' })
    })

    it('confirmed → cancelled', () => {
      expect(transition('confirmed', 'cancelled')).toEqual({ ok: true, newState: 'cancelled' })
    })

    it('held → cancelled', () => {
      expect(transition('held', 'cancelled')).toEqual({ ok: true, newState: 'cancelled' })
    })

    it('held → expired', () => {
      expect(transition('held', 'expired')).toEqual({ ok: true, newState: 'expired' })
    })
  })

  describe('idempotent transitions', () => {
    it('same state → same state is a no-op', () => {
      expect(transition('held', 'held')).toEqual({ ok: true, newState: 'held' })
      expect(transition('confirmed', 'confirmed')).toEqual({ ok: true, newState: 'confirmed' })
    })
  })

  describe('invalid transitions', () => {
    it('inquiry cannot jump to confirmed', () => {
      const result = transition('inquiry', 'confirmed')
      expect(result.ok).toBe(false)
    })

    it('confirmed cannot go back to held', () => {
      const result = transition('confirmed', 'held')
      expect(result.ok).toBe(false)
    })

    it('cancelled is terminal — cannot transition to any state', () => {
      const states: BookingState[] = ['inquiry', 'requested', 'held', 'confirmed', 'pending_payment']
      for (const target of states) {
        const result = transition('cancelled', target)
        expect(result.ok).toBe(false)
      }
    })

    it('expired is terminal — cannot transition to any state', () => {
      const result = transition('expired', 'requested')
      expect(result.ok).toBe(false)
    })

    it('failed is terminal — cannot transition to any state', () => {
      const result = transition('failed', 'confirmed')
      expect(result.ok).toBe(false)
    })

    it('requested can go directly to confirmed (group class direct-confirm path)', () => {
      const result = transition('requested', 'confirmed')
      expect(result.ok).toBe(true)
    })
  })

  describe('invariant: all terminal states have no outgoing transitions', () => {
    it('TERMINAL_STATES entries have empty valid-transition sets', () => {
      for (const state of TERMINAL_STATES) {
        expect(VALID_TRANSITIONS[state].size).toBe(0)
      }
    })
  })
})
