// The ONE customer-segment / profile reader (one-reader-per-fact discipline). Both the
// skills SkillContext (context-builder.ts) and the Branch-3 orchestrator
// (orchestrator-tools.ts `segment` lookup) call through here, instead of each rolling its
// own partial query. I/O wrapper around the pure customer-profile.ts derivations.

import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { identities, bookings } from '../../db/schema.js'
import type { CustomerSummary, SegmentFilter } from '../../shared/skill-types.js'
import { computeCustomerProfile, matchesSegment, type ProfileBooking, type SegmentMatchFilter } from './customer-profile.js'

/** Load one customer's full behavioral profile (Phase 3 cold-fill / value scoring read this). */
export async function loadCustomerProfile(db: Db, businessId: string, identityId: string, timezone: string) {
  const rows = await db
    .select({ slotStart: bookings.slotStart, state: bookings.state, serviceTypeId: bookings.serviceTypeId, providerId: bookings.providerId, amount: bookings.amount })
    .from(bookings)
    .where(and(eq(bookings.businessId, businessId), eq(bookings.customerId, identityId)))
  return computeCustomerProfile(rows as ProfileBooking[], timezone)
}

/**
 * Resolve a customer segment for a business. Fetches all customers + their bookings once,
 * derives each profile, and applies the filter (booking-derived facts via the pure
 * matchesSegment; VIP via the identity row). Returns enriched CustomerSummary rows.
 */
export async function queryCustomerSegment(
  db: Db,
  businessId: string,
  filter: SegmentFilter,
  timezone: string,
): Promise<CustomerSummary[]> {
  const customers = await db
    .select({ id: identities.id, phoneNumber: identities.phoneNumber, displayName: identities.displayName, vip: identities.vip })
    .from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.role, 'customer')))

  if (customers.length === 0) return []

  // One pass over this business's bookings, grouped by customer (avoids N queries).
  const customerIds = customers.map((c) => c.id)
  const allBookings = await db
    .select({ customerId: bookings.customerId, slotStart: bookings.slotStart, state: bookings.state, serviceTypeId: bookings.serviceTypeId, providerId: bookings.providerId, amount: bookings.amount })
    .from(bookings)
    .where(and(eq(bookings.businessId, businessId), inArray(bookings.customerId, customerIds)))

  const byCustomer = new Map<string, ProfileBooking[]>()
  for (const b of allBookings) {
    const list = byCustomer.get(b.customerId) ?? []
    list.push({ slotStart: b.slotStart, state: b.state, serviceTypeId: b.serviceTypeId, providerId: b.providerId, amount: b.amount })
    byCustomer.set(b.customerId, list)
  }

  const now = new Date()
  const bookingFilter: SegmentMatchFilter = {
    ...(filter.serviceTypeId !== undefined && { serviceTypeId: filter.serviceTypeId }),
    ...(filter.inactiveSinceDays !== undefined && { inactiveSinceDays: filter.inactiveSinceDays }),
    ...(filter.hasBooking !== undefined && { hasBooking: filter.hasBooking }),
    ...(filter.preferredDayOfWeek !== undefined && { preferredDayOfWeek: filter.preferredDayOfWeek }),
    ...(filter.preferredTimeBand !== undefined && { preferredTimeBand: filter.preferredTimeBand }),
    ...(filter.lapsed !== undefined && { lapsed: filter.lapsed }),
    ...(filter.providerId !== undefined && { providerId: filter.providerId }),
  }

  // First pass: derive + filter, keeping each survivor's profile.
  const matched: { c: (typeof customers)[number]; profile: ReturnType<typeof computeCustomerProfile> }[] = []
  for (const c of customers) {
    if (filter.vip !== undefined && filter.vip !== c.vip) continue
    const profile = computeCustomerProfile(byCustomer.get(c.id) ?? [], timezone)
    if (!matchesSegment(profile, bookingFilter, now)) continue
    matched.push({ c, profile })
  }

  // Resolve preferred-instructor display names in one query so copy can say "with Dana".
  const providerIds = [...new Set(matched.map((m) => m.profile.preferredProviderId).filter((p): p is string => !!p))]
  const providerNames = new Map<string, string | null>()
  if (providerIds.length > 0) {
    const rows = await db
      .select({ id: identities.id, displayName: identities.displayName })
      .from(identities)
      .where(and(eq(identities.businessId, businessId), inArray(identities.id, providerIds)))
    for (const r of rows) providerNames.set(r.id, r.displayName)
  }

  return matched.map(({ c, profile }) => ({
    identityId: c.id,
    phoneNumber: c.phoneNumber,
    displayName: c.displayName,
    totalBookings: profile.lifetimeBookings,
    lastBookingAt: profile.lastBookingAt,
    cadenceDays: profile.cadenceDays,
    preferredServiceTypeId: profile.preferredServiceTypeId,
    preferredProviderId: profile.preferredProviderId,
    preferredProviderName: profile.preferredProviderId ? (providerNames.get(profile.preferredProviderId) ?? null) : null,
    lifetimeSpend: profile.lifetimeSpend,
    preferredDayOfWeek: profile.preferredDayOfWeek,
    preferredTimeBand: profile.preferredTimeBand,
    noShowRate: profile.noShowRate,
    vip: c.vip,
  }))
}
