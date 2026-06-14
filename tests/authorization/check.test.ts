import { describe, it, expect } from 'vitest'
import {
  authorize,
  requiredActionForInstruction,
  DEFAULT_DELEGATED_CALENDAR_ACTIONS,
} from '../../src/domain/authorization/check.js'
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

  // The apply-seam gate: a delegated_user with the default calendar grant can run
  // scheduling/cancellation changes but is blocked from pricing, policy, and staff.
  describe('requiredActionForInstruction (apply-seam gate)', () => {
    it('maps each config instruction type to its required manager action', () => {
      expect(requiredActionForInstruction('availability_change')).toBe('schedule.set_availability')
      expect(requiredActionForInstruction('recurring_class_change')).toBe('schedule.set_availability')
      expect(requiredActionForInstruction('service_change')).toBe('service.modify')
      expect(requiredActionForInstruction('policy_change')).toBe('policy.change')
      expect(requiredActionForInstruction('permission_change')).toBe('permission.manage')
      expect(requiredActionForInstruction('booking_cancellation')).toBe('booking.cancel_any')
      expect(requiredActionForInstruction('unknown')).toBeNull()
    })

    it('default calendar grant authorizes schedule + recurring class changes but NOT pricing/policy/permissions', () => {
      const granted = new Set<Action>(DEFAULT_DELEGATED_CALENDAR_ACTIONS)
      const allowed = (type: string) => {
        const req = requiredActionForInstruction(type)
        return req === null || granted.has(req)
      }
      expect(allowed('availability_change')).toBe(true)
      expect(allowed('recurring_class_change')).toBe(true)
      expect(allowed('booking_cancellation')).toBe(true)
      // owner-only powers stay blocked for a plain calendar editor
      expect(allowed('service_change')).toBe(false)
      expect(allowed('policy_change')).toBe(false)
      expect(allowed('permission_change')).toBe(false)
    })
  })
})

describe('staff.manage action', () => {
  it('managers may staff.manage', () => {
    expect(authorize({ role: 'manager' }, 'staff.manage')).toEqual({ allowed: true })
  })
  it('customers may not staff.manage', () => {
    expect(authorize({ role: 'customer' }, 'staff.manage').allowed).toBe(false)
  })
  it('delegated_user may staff.manage only when granted', () => {
    expect(authorize({ role: 'delegated_user' }, 'staff.manage').allowed).toBe(false)
    expect(authorize({ role: 'delegated_user', delegatedPermissions: new Set(['staff.manage']) }, 'staff.manage')).toEqual({ allowed: true })
  })
  it('provider_change maps to staff.manage', () => {
    expect(requiredActionForInstruction('provider_change')).toBe('staff.manage')
  })
})
