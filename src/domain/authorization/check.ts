import type { IdentityRole } from '../../db/schema.js'

export type Action =
  | 'booking.request'
  | 'booking.cancel_own'
  | 'booking.cancel_any'
  | 'booking.reschedule_own'
  | 'booking.reschedule_any'
  | 'booking.view_availability'
  | 'schedule.set_availability'
  | 'service.modify'
  | 'permission.manage'
  | 'policy.change'

export type AuthResult =
  | { allowed: true }
  | { allowed: false; reason: string }

// Delegated permissions are stored as a Set of actions the delegated_user may perform.
// For V1 this is held in memory per-request; in future it would be loaded from DB per identity.
export interface AuthContext {
  role: IdentityRole
  delegatedPermissions?: Set<Action>
}

const MANAGER_ACTIONS = new Set<Action>([
  'booking.request',
  'booking.cancel_own',
  'booking.cancel_any',
  'booking.reschedule_own',
  'booking.reschedule_any',
  'booking.view_availability',
  'schedule.set_availability',
  'service.modify',
  'permission.manage',
  'policy.change',
])

const CUSTOMER_ACTIONS = new Set<Action>([
  'booking.request',
  'booking.cancel_own',
  'booking.reschedule_own',
  'booking.view_availability',
])

export function authorize(ctx: AuthContext, action: Action): AuthResult {
  switch (ctx.role) {
    case 'manager':
      if (MANAGER_ACTIONS.has(action)) return { allowed: true }
      return { allowed: false, reason: `Action '${action}' not in manager capability set` }

    case 'customer':
      if (CUSTOMER_ACTIONS.has(action)) return { allowed: true }
      return { allowed: false, reason: `Action '${action}' is not available to customers` }

    case 'delegated_user': {
      const granted = ctx.delegatedPermissions ?? new Set<Action>()
      // Delegated users always have the customer baseline
      if (CUSTOMER_ACTIONS.has(action)) return { allowed: true }
      if (granted.has(action)) return { allowed: true }
      return {
        allowed: false,
        reason: `Action '${action}' has not been granted to this delegated user`,
      }
    }
  }
}
