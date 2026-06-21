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
  | 'staff.manage'

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
  'staff.manage',
])

const CUSTOMER_ACTIONS = new Set<Action>([
  'booking.request',
  'booking.cancel_own',
  'booking.reschedule_own',
  'booking.view_availability',
])

// Default capability set granted when an owner adds a staff member as a calendar
// editor without naming specific powers: edit the schedule and manage bookings,
// but NOT change pricing/services, policy, or other staff permissions.
export const DEFAULT_DELEGATED_CALENDAR_ACTIONS: Action[] = [
  'schedule.set_availability',
  'booking.cancel_any',
  'booking.reschedule_any',
]

// Maps a classified manager instruction to the manager-level Action it requires.
// Used to gate a delegated_user at the apply seam: managers always pass; a
// delegated_user must hold the mapped action. Returns null for types that need
// no manager-level grant.
export function requiredActionForInstruction(instructionType: string): Action | null {
  switch (instructionType) {
    case 'availability_change':
    case 'recurring_class_change':
      return 'schedule.set_availability'
    case 'service_change':
      return 'service.modify'
    case 'policy_change':
      return 'policy.change'
    case 'permission_change':
      return 'permission.manage'
    case 'booking_cancellation':
      return 'booking.cancel_any'
    case 'provider_change':
      return 'staff.manage'
    default:
      return null
  }
}

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

    case 'provider':
      // Instructors do not operate the PA in V1; grant only the customer baseline.
      if (CUSTOMER_ACTIONS.has(action)) return { allowed: true }
      return { allowed: false, reason: `Action '${action}' is not available to providers` }

    case 'contact':
      // External meeting counterparties have no PA-facing actions.
      return { allowed: false, reason: `Action '${action}' is not available to contacts` }
  }
}
