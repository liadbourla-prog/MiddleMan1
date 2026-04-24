import { eq, and } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { identities } from '../../db/schema.js'
import type { ResolveResult } from './types.js'

// E.164: + followed by 7–15 digits
const E164_REGEX = /^\+[1-9]\d{6,14}$/

export function isValidE164(phoneNumber: string): boolean {
  return E164_REGEX.test(phoneNumber)
}

export async function resolveIdentity(
  db: Db,
  businessId: string,
  phoneNumber: string,
): Promise<ResolveResult> {
  const rows = await db
    .select()
    .from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.phoneNumber, phoneNumber)))
    .limit(1)

  const identity = rows[0]
  if (!identity) return { found: false, reason: 'unknown_number' }
  if (identity.revokedAt !== null) return { found: false, reason: 'revoked' }

  return {
    found: true,
    identity: {
      id: identity.id,
      businessId: identity.businessId,
      phoneNumber: identity.phoneNumber,
      role: identity.role,
      displayName: identity.displayName,
      messagingOptOut: identity.messagingOptOut,
    },
  }
}

export async function registerCustomer(
  db: Db,
  businessId: string,
  phoneNumber: string,
  displayName?: string,
): Promise<string> {
  if (!isValidE164(phoneNumber)) {
    throw new Error(`Invalid phone number format: "${phoneNumber}". Must be E.164 (e.g. +972501234567).`)
  }
  const [row] = await db
    .insert(identities)
    .values({
      businessId,
      phoneNumber,
      role: 'customer',
      displayName: displayName ?? null,
      grantedAt: new Date(),
    })
    .onConflictDoNothing()
    .returning({ id: identities.id })

  if (row) return row.id

  // Already exists — return existing id
  const [existing] = await db
    .select({ id: identities.id })
    .from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.phoneNumber, phoneNumber)))
    .limit(1)

  if (!existing) throw new Error('registerCustomer: conflict but record not found')
  return existing.id
}
