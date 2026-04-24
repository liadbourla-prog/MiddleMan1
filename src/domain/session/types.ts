import type { SessionState, SessionIntent } from '../../db/schema.js'

export type { SessionState, SessionIntent }

export interface ActiveSession {
  id: string
  businessId: string
  identityId: string
  intent: SessionIntent
  state: SessionState
  context: Record<string, unknown>
  expiresAt: Date
}
