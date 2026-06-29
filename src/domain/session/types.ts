import type { SessionState, SessionIntent } from '../../db/schema.js'

export type { SessionState, SessionIntent }

export interface ActiveSession {
  id: string
  businessId: string
  identityId: string
  intent: SessionIntent
  state: SessionState
  context: Record<string, unknown>
  // B3 (T1.9): the context version read at load time. Pass it back to updateSessionContext as
  // `expectedVersion` to make the write an optimistic CAS that a stale concurrent turn loses.
  contextVersion: number
  expiresAt: Date
}
