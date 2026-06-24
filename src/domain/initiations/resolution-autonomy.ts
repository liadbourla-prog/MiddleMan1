import { and, eq, gte, inArray } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { auditLog } from '../../db/schema.js'

// Resolution autonomy (Phase 7.1; design §6/§11). A MANAGED negotiation (reshuffle, coordination)
// either resolves itself or dead-letters to the owner (an involuntary OAU). These are the audit
// actions that mark each terminal outcome. By-design owner confirms (e.g. coordination's
// ping-owner-to-confirm, reshuffle's proposal-pending-approval) are VOLUNTARY OAU and are NOT
// counted here — only could-not-resolve dead-letters are.
export const RESOLVED_ACTIONS = ['coordination.booked', 'reshuffle.applied'] as const
export const DEAD_LETTER_ACTIONS = [
  'coordination.book_conflict',
  'coordination.book_failed',
  'coordination.expired',
  'reshuffle.failed',
] as const

export type ManagedOutcome = 'resolved' | 'dead_letter' | 'other'

/** Classify a managed-conversation audit action into its terminal outcome (pure). */
export function classifyManagedOutcome(action: string): ManagedOutcome {
  if ((RESOLVED_ACTIONS as readonly string[]).includes(action)) return 'resolved'
  if ((DEAD_LETTER_ACTIONS as readonly string[]).includes(action)) return 'dead_letter'
  return 'other'
}

/** Resolution autonomy = resolved / (resolved + dead-lettered). 1 when there were no negotiations. */
export function resolutionAutonomyRatio(resolved: number, deadLettered: number): number {
  const total = resolved + deadLettered
  return total === 0 ? 1 : resolved / total
}

export interface ManagedOutcomeCounts {
  resolved: number
  deadLettered: number
}

/** Count managed-conversation terminal outcomes for a business since `since` (from the audit log). */
export async function countManagedOutcomes(db: Db, businessId: string, since: Date): Promise<ManagedOutcomeCounts> {
  const rows = await db
    .select({ action: auditLog.action })
    .from(auditLog)
    .where(and(
      eq(auditLog.businessId, businessId),
      gte(auditLog.createdAt, since),
      inArray(auditLog.action, [...RESOLVED_ACTIONS, ...DEAD_LETTER_ACTIONS]),
    ))
  let resolved = 0
  let deadLettered = 0
  for (const r of rows) {
    const o = classifyManagedOutcome(r.action)
    if (o === 'resolved') resolved++
    else if (o === 'dead_letter') deadLettered++
  }
  return { resolved, deadLettered }
}
