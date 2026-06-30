/**
 * Central-number manager resolution (Branch 3 on the shared MiddleMan number).
 *
 * On a business's own PA number, the inbound number identifies the business. On the shared
 * central number (PROVIDER_WA_NUMBER) it cannot — so the business is resolved from the
 * SENDER's identity: the business for which this phone is an active manager AND which has
 * opted into the central manager channel (`businesses.managerChannel = 'central'`).
 *
 * Tenant-safety guards (see docs/superpowers/specs/2026-06-30-central-number-manager-channel.md §6a):
 *  - G1: the lookup asserts EXACTLY ONE match. Two central-managed businesses for one owner
 *        phone returns `{ kind: 'multiple' }` — the caller MUST hard-refuse, never silently
 *        pick a tenant. (The multi-business active-pointer is a later spec.)
 *  - G2: strictly `role = 'manager'` and `revokedAt IS NULL` and `managerChannel = 'central'`.
 *        A customer/contact/delegated row must never bind the central path.
 */
import { eq, and, isNull } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { identities, businesses } from '../../db/schema.js'
import type { Business } from '../../db/schema.js'

export type CentralManagerResolution =
  | { kind: 'none' }
  | { kind: 'one'; business: Business }
  | { kind: 'multiple' }

/**
 * Resolve the central-managed business for an inbound sender on the shared central number.
 * Returns `none` (→ fall through to onboarding), `one` (→ bind Branch 3), or `multiple`
 * (→ caller hard-refuses; never an arbitrary pick).
 */
export async function findCentralManagedBusinessForOwner(
  db: Db,
  fromNumber: string,
): Promise<CentralManagerResolution> {
  const rows = await db
    .select()
    .from(identities)
    .innerJoin(businesses, eq(businesses.id, identities.businessId))
    .where(
      and(
        eq(identities.phoneNumber, fromNumber),
        eq(identities.role, 'manager'),
        isNull(identities.revokedAt),
        eq(businesses.managerChannel, 'central'),
      ),
    )
    .limit(2)

  if (rows.length === 0) return { kind: 'none' }
  if (rows.length > 1) return { kind: 'multiple' }
  return { kind: 'one', business: rows[0]!.businesses }
}
