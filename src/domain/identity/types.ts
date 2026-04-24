import type { IdentityRole } from '../../db/schema.js'

export interface ResolvedIdentity {
  id: string
  businessId: string
  phoneNumber: string
  role: IdentityRole
  displayName: string | null
  messagingOptOut: boolean
}

export type ResolveResult =
  | { found: true; identity: ResolvedIdentity }
  | { found: false; reason: 'unknown_number' | 'revoked' }
