/**
 * Provider resolution for multi-instructor scheduling.
 *
 * Given a service type and an optional provider hint (name/phone),
 * returns the best-matching available provider identity for the requested slot.
 *
 * Resolution order:
 *  1. Explicit provider hint matched by name or phone
 *  2. First active provider assigned to the service with availability in the slot
 *  3. null if no providers are assigned (business-level booking, no provider required)
 */

import { eq, and, isNull, isNotNull, or, lte, gt, lt, gte } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { providerAssignments, identities, availability, bookings } from '../../db/schema.js'
import { localParts } from '../availability/compute.js'

export interface ResolvedProvider {
  identityId: string
  displayName: string | null
  phoneNumber: string
}

export async function resolveProvider(
  db: Db,
  businessId: string,
  serviceTypeId: string,
  slotStart: Date,
  slotEnd: Date,
  providerHint?: string | null,
  timezone: string = 'UTC',
): Promise<ResolvedProvider | null> {
  // Get all active providers assigned to this service
  const assignments = await db
    .select({
      identityId: providerAssignments.identityId,
      displayName: identities.displayName,
      phoneNumber: identities.phoneNumber,
    })
    .from(providerAssignments)
    .innerJoin(identities, eq(providerAssignments.identityId, identities.id))
    .where(
      and(
        eq(providerAssignments.businessId, businessId),
        eq(providerAssignments.serviceTypeId, serviceTypeId),
        eq(providerAssignments.isActive, true),
        isNull(identities.revokedAt),
      ),
    )

  if (assignments.length === 0) return null

  // Filter to hint match if provided
  let candidates = assignments
  if (providerHint) {
    const lower = providerHint.toLowerCase()
    const matched = assignments.filter(
      (a) =>
        (a.displayName?.toLowerCase().includes(lower) ?? false) ||
        a.phoneNumber.includes(providerHint),
    )
    if (matched.length > 0) candidates = matched
  }

  // For each candidate, check they have availability in the slot and no conflicting booking
  for (const candidate of candidates) {
    const available = await isProviderAvailable(db, businessId, candidate.identityId, slotStart, slotEnd, timezone)
    if (available) return candidate
  }

  return null
}

async function isProviderAvailable(
  db: Db,
  businessId: string,
  providerId: string,
  slotStart: Date,
  slotEnd: Date,
  timezone: string,
): Promise<boolean> {
  // Check for conflicting confirmed/held bookings for this provider
  const conflicts = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.businessId, businessId),
        eq(bookings.providerId, providerId),
        or(
          and(lte(bookings.slotStart, slotStart), gt(bookings.slotEnd, slotStart)),
          and(lt(bookings.slotStart, slotEnd), gte(bookings.slotEnd, slotEnd)),
          and(gte(bookings.slotStart, slotStart), lte(bookings.slotEnd, slotEnd)),
        ),
        or(
          eq(bookings.state, 'held'),
          eq(bookings.state, 'pending_payment'),
          eq(bookings.state, 'confirmed'),
        ),
      ),
    )
    .limit(1)

  if (conflicts.length > 0) return false

  // Check provider has availability rules covering this slot. Decompose the slot
  // in BUSINESS-LOCAL time, not server-UTC — otherwise a Friday-09:00 local rule
  // is checked against the UTC weekday/hour and silently mismatches off-zero zones
  // and across DST. localParts() is the canonical, DST-correct decomposition.
  const startLocal = localParts(slotStart, timezone)
  const endLocal = localParts(slotEnd, timezone)
  const dayOfWeek = startLocal.dayOfWeek
  const dateStr = startLocal.dateStr
  const slotTimeMs = startLocal.minutes * 60_000

  // Provider-specific block check (specific date)
  const blocked = await db
    .select({ id: availability.id })
    .from(availability)
    .where(
      and(
        eq(availability.businessId, businessId),
        eq(availability.providerId, providerId),
        eq(availability.isBlocked, true),
        or(
          eq(availability.specificDate, dateStr),
          eq(availability.dayOfWeek, dayOfWeek),
        ),
      ),
    )
    .limit(1)

  if (blocked.length > 0) return false

  // Check provider-specific hours for this day
  const providerHours = await db
    .select({ openTime: availability.openTime, closeTime: availability.closeTime })
    .from(availability)
    .where(
      and(
        eq(availability.businessId, businessId),
        eq(availability.providerId, providerId),
        eq(availability.isBlocked, false),
        or(eq(availability.specificDate, dateStr), eq(availability.dayOfWeek, dayOfWeek)),
      ),
    )
    .limit(1)

  if (providerHours.length > 0) {
    const hrs = providerHours[0]!
    if (!hrs.openTime || !hrs.closeTime) return true
    const openMs = timeToMs(hrs.openTime)
    const closeMs = timeToMs(hrs.closeTime)
    const slotEndMs = endLocal.minutes * 60_000
    return slotTimeMs >= openMs && slotEndMs <= closeMs
  }

  // No hours row covers THIS day. A provider who has declared ANY weekly hours is
  // off on days they did not declare → unavailable. Only a provider with NO weekly
  // hours at all (the studio model: their scheduled classes ARE their schedule)
  // falls back to available-by-default. Without this guard a Wed-only instructor
  // resolves on Monday (CRM_STANDARD.md data-point #2: instructor hours must hold).
  const [anyWeekly] = await db
    .select({ id: availability.id })
    .from(availability)
    .where(
      and(
        eq(availability.businessId, businessId),
        eq(availability.providerId, providerId),
        eq(availability.isBlocked, false),
        isNotNull(availability.dayOfWeek),
        isNotNull(availability.openTime),
      ),
    )
    .limit(1)
  return anyWeekly === undefined
}

function timeToMs(time: string): number {
  const [h = '0', m = '0'] = time.split(':')
  return (parseInt(h, 10) * 60 + parseInt(m, 10)) * 60_000
}
