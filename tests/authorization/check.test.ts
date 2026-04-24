import { describe, it, expect } from 'vitest'
import { authorize } from '../../src/domain/authorization/check.js'
import type { Action } from '../../src/domain/authorization/check.js'

describe('authorization', () => {
  describe('manager', () => {
    it('can perform all actions', () => {
      const managerOnlyActions: Action[] = [
        'service.modify',
        'permission.manage',
        'policy.change',
        'booking.cancel_any',
        'booking.reschedule_any',
        'schedule.set_availability',
      ]
      for (const action of managerOnlyActions) {
        expect(authorize({ role: 'manager' }, action).allowed).toBe(true)
      }
    })
  })

  describe('customer', () => {
    it('can request and manage own bookings', () => {
      expect(authorize({ role: 'customer' }, 'booking.request').allowed).toBe(true)
      expect(authorize({ role: 'customer' }, 'booking.cancel_own').allowed).toBe(true)
      expect(authorize({ role: 'customer' }, 'booking.reschedule_own').allowed).toBe(true)
      expect(authorize({ role: 'customer' }, 'booking.view_availability').allowed).toBe(true)
    })

    it('cannot perform manager-only actions', () => {
      const forbidden: Action[] = [
        'booking.cancel_any',
        'booking.reschedule_any',
        'schedule.set_availability',
        'service.modify',
        'permission.manage',
        'policy.change',
      ]
      for (const action of forbidden) {
        const result = authorize({ role: 'customer' }, action)
        expect(result.allowed).toBe(false)
      }
    })
  })

  describe('delegated_user', () => {
    it('inherits customer baseline without explicit grants', () => {
      expect(authorize({ role: 'delegated_user' }, 'booking.request').allowed).toBe(true)
      expect(authorize({ role: 'delegated_user' }, 'booking.cancel_own').allowed).toBe(true)
    })

    it('cannot perform manager actions without explicit grant', () => {
      expect(authorize({ role: 'delegated_user' }, 'booking.cancel_any').allowed).toBe(false)
      expect(authorize({ role: 'delegated_user' }, 'service.modify').allowed).toBe(false)
    })

    it('can perform explicitly granted actions', () => {
      const granted = new Set<Action>(['booking.cancel_any', 'schedule.set_availability'])
      expect(authorize({ role: 'delegated_user', delegatedPermissions: granted }, 'booking.cancel_any').allowed).toBe(true)
      expect(authorize({ role: 'delegated_user', delegatedPermissions: granted }, 'schedule.set_availability').allowed).toBe(true)
    })

    it('cannot perform actions not in grant set even if delegated', () => {
      const granted = new Set<Action>(['booking.cancel_any'])
      expect(authorize({ role: 'delegated_user', delegatedPermissions: granted }, 'service.modify').allowed).toBe(false)
    })
  })

  describe('authorization result shape', () => {
    it('denied result includes a reason', () => {
      const result = authorize({ role: 'customer' }, 'service.modify')
      expect(result.allowed).toBe(false)
      if (!result.allowed) {
        expect(typeof result.reason).toBe('string')
        expect(result.reason.length).toBeGreaterThan(0)
      }
    })
  })
})
