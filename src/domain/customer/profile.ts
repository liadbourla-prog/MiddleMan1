import { eq, and, sql } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { customerProfiles, bookings, serviceTypes } from '../../db/schema.js'
import type { CustomerProfile } from '../../db/schema.js'

export interface CustomerMemory {
  displayName: string | null
  preferredServiceName: string | null
  lastBookingAt: Date | null
  totalBookings: number
  notes: string | null
}

// Called after a booking is confirmed — upserts the customer profile
export async function recordCompletedBooking(
  db: Db,
  businessId: string,
  identityId: string,
  bookingId: string,
  serviceTypeId: string,
): Promise<void> {
  const existing = await db
    .select({ id: customerProfiles.id, totalBookings: customerProfiles.totalBookings })
    .from(customerProfiles)
    .where(eq(customerProfiles.identityId, identityId))
    .limit(1)

  const now = new Date()

  if (existing.length === 0) {
    await db.insert(customerProfiles).values({
      businessId,
      identityId,
      preferredServiceTypeId: serviceTypeId,
      lastBookingId: bookingId,
      lastBookingAt: now,
      totalBookings: 1,
      updatedAt: now,
    })
    return
  }

  const profile = existing[0]!
  await db
    .update(customerProfiles)
    .set({
      preferredServiceTypeId: serviceTypeId,
      lastBookingId: bookingId,
      lastBookingAt: now,
      totalBookings: profile.totalBookings + 1,
      updatedAt: now,
    })
    .where(eq(customerProfiles.identityId, identityId))
}

// Loads a customer's memory for session hydration — returns null for first-time customers
export async function loadCustomerMemory(
  db: Db,
  identityId: string,
): Promise<CustomerMemory | null> {
  const rows = await db
    .select({
      displayName: customerProfiles.displayName,
      preferredServiceTypeId: customerProfiles.preferredServiceTypeId,
      lastBookingAt: customerProfiles.lastBookingAt,
      totalBookings: customerProfiles.totalBookings,
      notes: customerProfiles.notes,
      serviceName: serviceTypes.name,
    })
    .from(customerProfiles)
    .leftJoin(serviceTypes, eq(customerProfiles.preferredServiceTypeId, serviceTypes.id))
    .where(eq(customerProfiles.identityId, identityId))
    .limit(1)

  const row = rows[0]
  if (!row) return null

  return {
    displayName: row.displayName,
    preferredServiceName: row.serviceName ?? null,
    lastBookingAt: row.lastBookingAt,
    totalBookings: row.totalBookings,
    notes: row.notes,
  }
}
