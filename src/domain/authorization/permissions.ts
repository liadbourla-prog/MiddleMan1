/**
 * DB-backed loading and granting of delegated permissions. Kept separate from the
 * pure check.ts so authorization logic stays side-effect free and unit testable.
 */

import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { delegatedPermissions } from '../../db/schema.js'
import type { Action } from './check.js'

/** Load the set of currently-granted (non-revoked) actions for a delegated user. */
export async function loadDelegatedPermissions(db: Db, identityId: string): Promise<Set<Action>> {
  const rows = await db
    .select({ action: delegatedPermissions.action })
    .from(delegatedPermissions)
    .where(and(eq(delegatedPermissions.identityId, identityId), isNull(delegatedPermissions.revokedAt)))
  return new Set(rows.map((r) => r.action as Action))
}

/** Grant a set of actions to an identity (idempotent per (identity, action)). */
export async function grantDelegatedPermissions(
  db: Db,
  businessId: string,
  identityId: string,
  actions: Action[],
  grantedBy: string,
): Promise<void> {
  if (actions.length === 0) return
  await db
    .insert(delegatedPermissions)
    .values(actions.map((action) => ({ businessId, identityId, action, grantedBy })))
    .onConflictDoNothing()
}

/** Revoke all granted actions for an identity (used when staff access is removed). */
export async function revokeAllDelegatedPermissions(db: Db, identityId: string): Promise<void> {
  await db
    .update(delegatedPermissions)
    .set({ revokedAt: new Date() })
    .where(and(eq(delegatedPermissions.identityId, identityId), isNull(delegatedPermissions.revokedAt)))
}
