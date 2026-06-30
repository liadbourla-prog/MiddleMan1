import type { IdentityRole } from '../../db/schema.js'
import type { Action } from '../authorization/check.js'
import type { AddresseeGender, GenderSource } from './addressee-gender.js'

export interface ResolvedIdentity {
  id: string
  businessId: string
  phoneNumber: string
  role: IdentityRole
  displayName: string | null
  messagingOptOut: boolean
  preferredLanguage: 'he' | 'en' | null
  conversationPausedUntil: Date | null
  // Resolved Hebrew addressee gender (how the PA speaks TO this person) + its provenance,
  // for the precedence resolver. Optional/null = unknown → masculine floor (decision 1).
  addresseeGender?: AddresseeGender | null
  addresseeGenderSource?: GenderSource | null
  // Granted manager-level actions for delegated_user identities (empty otherwise).
  delegatedPermissions?: Set<Action>
}

export type ResolveResult =
  | { found: true; identity: ResolvedIdentity }
  | { found: false; reason: 'unknown_number' | 'revoked' }
