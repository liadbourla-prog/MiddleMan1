import type { IdentityRole } from '../../db/schema.js'
import type { Action } from '../authorization/check.js'

export interface ResolvedIdentity {
  id: string
  businessId: string
  phoneNumber: string
  role: IdentityRole
  displayName: string | null
  messagingOptOut: boolean
  preferredLanguage: 'he' | 'en' | null
  conversationPausedUntil: Date | null
  // Granted manager-level actions for delegated_user identities (empty otherwise).
  delegatedPermissions?: Set<Action>
}

export type ResolveResult =
  | { found: true; identity: ResolvedIdentity }
  | { found: false; reason: 'unknown_number' | 'revoked' }
