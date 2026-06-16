import { and, eq, ilike, isNull } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { identities } from '../../db/schema.js'

export type ProviderLookupResult =
  | { status: 'found'; id: string }
  | { status: 'none' }
  | { status: 'ambiguous' }

/**
 * Resolve an ACTIVE provider identity by display name within a business.
 * Case-insensitive exact match (ilike, no wildcards). Returns 'ambiguous' when
 * more than one active provider shares the name. Single source of truth reused by
 * the manager apply pipeline and the orchestrator tool layer.
 */
export async function findProviderByName(
  db: Db,
  businessId: string,
  name: string,
): Promise<ProviderLookupResult> {
  const rows = await db
    .select({ id: identities.id })
    .from(identities)
    .where(and(
      eq(identities.businessId, businessId),
      eq(identities.role, 'provider'),
      ilike(identities.displayName, name),
      isNull(identities.revokedAt),
    ))
  if (rows.length === 0) return { status: 'none' }
  if (rows.length > 1) return { status: 'ambiguous' }
  return { status: 'found', id: rows[0]!.id }
}
