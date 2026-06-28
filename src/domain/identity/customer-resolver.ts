import { and, eq, ilike, desc } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { identities, bookings, serviceTypes } from '../../db/schema.js'
import { isValidE164 } from './resolver.js'
import { sanitize } from '../flows/fence.js'

export type TargetRole = 'customer' | 'contact'

export interface CandidateView {
  id: string
  displayName: string | null
  lastName: string | null
  phoneNumber: string
  lastBooking: { date: string; service: string | null } | null
}

export interface ResolveInput {
  role: TargetRole
  name?: string
  lastName?: string
  phoneNumber?: string
  timezone: string
  lang: 'he' | 'en'
}

export type CustomerResolution =
  | { status: 'resolved'; target: CandidateView }
  | { status: 'ambiguous'; query: string; candidates: CandidateView[] }
  | { status: 'not_found'; query: string }
  | { status: 'phone_unknown'; phoneNumber: string }

/** Last whitespace-delimited token of a name, or null for single-token/empty/nullish. */
export function deriveLastName(name: string | null | undefined): string | null {
  if (!name) return null
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return parts.length >= 2 ? parts[parts.length - 1]! : null
}

/**
 * The single deterministic gate every owner-initiated action that targets a customer/contact
 * MUST pass through before acting. Classifies a name/phone into resolved | ambiguous |
 * not_found | phone_unknown. Performs NO writes, NO sends, NO authorization (callers are
 * already gated). On a name collision it returns every candidate with the data the owner needs
 * to verify: last name, full phone number, and (for customers) their most recent booking.
 */
export async function resolveTargetForOwnerAction(
  db: Db,
  businessId: string,
  input: ResolveInput,
): Promise<CustomerResolution> {
  const phone = input.phoneNumber?.replace(/[\s-]/g, '')

  // Phone path — unambiguous by construction (phone is unique per business).
  if (phone && isValidE164(phone)) {
    const [hit] = await db
      .select({ id: identities.id, displayName: identities.displayName, lastName: identities.lastName, phoneNumber: identities.phoneNumber })
      .from(identities)
      .where(and(eq(identities.businessId, businessId), eq(identities.phoneNumber, phone)))
      .limit(1)
    if (!hit) return { status: 'phone_unknown', phoneNumber: phone }
    return { status: 'resolved', target: await toCandidate(db, businessId, hit, input) }
  }

  // Name path.
  if (input.name && input.name.trim()) {
    const name = input.name.trim()
    const conds = [
      eq(identities.businessId, businessId),
      eq(identities.role, input.role),
      ilike(identities.displayName, `%${name}%`),
    ]
    if (input.lastName && input.lastName.trim()) {
      conds.push(ilike(identities.lastName, `%${input.lastName.trim()}%`))
    }
    const rows = await db
      .select({ id: identities.id, displayName: identities.displayName, lastName: identities.lastName, phoneNumber: identities.phoneNumber })
      .from(identities)
      .where(and(...conds))
      .limit(5)

    if (rows.length === 0) return { status: 'not_found', query: name }
    if (rows.length === 1) {
      return { status: 'resolved', target: await toCandidate(db, businessId, rows[0]!, input) }
    }
    const candidates: CandidateView[] = []
    for (const row of rows) candidates.push(await toCandidate(db, businessId, row, input))
    return { status: 'ambiguous', query: name, candidates }
  }

  // Neither phone nor name — caller must ask who to target.
  return { status: 'not_found', query: input.name ?? '' }
}

async function toCandidate(
  db: Db,
  businessId: string,
  row: { id: string; displayName: string | null; lastName: string | null; phoneNumber: string },
  input: ResolveInput,
): Promise<CandidateView> {
  const lastBooking = input.role === 'customer'
    ? await latestBookingFor(db, businessId, row.id, input.timezone, input.lang)
    : null
  return { id: row.id, displayName: row.displayName, lastName: row.lastName, phoneNumber: row.phoneNumber, lastBooking }
}

/** Shared deterministic write for a target's name fields. Skips the DB entirely when no field
 *  is supplied. Used by booking capture, the owner setCustomerName tool, and opportunistic
 *  save at disambiguation.
 *
 *  Gate-2(i): customer-supplied names are sanitized before persisting (INJ2 vector — a name
 *  like "ignore previous instructions…" is later interpolated into Branch-4 reply prompts).
 *  - Non-null strings are sanitized and capped to 100 chars (names are short; 2000 would let
 *    an absurd "name" slip through).
 *  - null clears the field (preserves existing null-clear semantics).
 *  - undefined means "don't touch this field" (preserves existing skip semantics).
 */
export async function setCustomerName(
  db: Db,
  businessId: string,
  identityId: string,
  fields: { displayName?: string | null; lastName?: string | null },
): Promise<void> {
  const patch: Record<string, unknown> = {}
  if (fields.displayName !== undefined) {
    patch['displayName'] = fields.displayName !== null ? sanitize(fields.displayName, 100) : null
  }
  if (fields.lastName !== undefined) {
    patch['lastName'] = fields.lastName !== null ? sanitize(fields.lastName, 100) : null
  }
  if (Object.keys(patch).length === 0) return
  await db.update(identities).set(patch).where(and(eq(identities.businessId, businessId), eq(identities.id, identityId)))
}

/** Most recent booking (date + service name) for an identity, or null if none. */
export async function latestBookingFor(
  db: Db,
  businessId: string,
  identityId: string,
  timezone: string,
  lang: 'he' | 'en',
): Promise<{ date: string; service: string | null } | null> {
  const [b] = await db
    .select({ slotStart: bookings.slotStart, service: serviceTypes.name })
    .from(bookings)
    .leftJoin(serviceTypes, eq(bookings.serviceTypeId, serviceTypes.id))
    .where(and(eq(bookings.businessId, businessId), eq(bookings.customerId, identityId)))
    .orderBy(desc(bookings.slotStart))
    .limit(1)
  if (!b) return null
  return {
    date: b.slotStart.toLocaleDateString(lang === 'he' ? 'he-IL' : 'en-GB', { timeZone: timezone }),
    service: b.service ?? null,
  }
}
