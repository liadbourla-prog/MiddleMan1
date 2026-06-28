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

// P4: a snapshot of the most recently cancelled booking, kept on the profile so a
// follow-up "give me back the class we cancelled" can re-offer the exact slot even when
// the restore arrives in a fresh session.
export interface LastCancellation {
  bookingId: string
  serviceTypeId: string
  serviceName: string
  slotStartIso: string
}

// Upsert the last-cancellation snapshot. Best-effort restore memory; callers swallow errors.
export async function recordLastCancellation(
  db: Db,
  businessId: string,
  identityId: string,
  snap: LastCancellation,
): Promise<void> {
  const now = new Date()
  const existing = await db
    .select({ id: customerProfiles.id })
    .from(customerProfiles)
    .where(eq(customerProfiles.identityId, identityId))
    .limit(1)

  if (existing.length === 0) {
    await db.insert(customerProfiles).values({
      businessId,
      identityId,
      lastCancelledBooking: snap,
      lastCancelledAt: now,
      updatedAt: now,
    })
    return
  }
  await db
    .update(customerProfiles)
    .set({ lastCancelledBooking: snap, lastCancelledAt: now, updatedAt: now })
    .where(eq(customerProfiles.identityId, identityId))
}

// Load the last-cancellation snapshot (+ when it happened), or null if none recorded.
export async function loadLastCancellation(
  db: Db,
  identityId: string,
): Promise<{ snap: LastCancellation; at: Date } | null> {
  const rows = await db
    .select({ snap: customerProfiles.lastCancelledBooking, at: customerProfiles.lastCancelledAt })
    .from(customerProfiles)
    .where(eq(customerProfiles.identityId, identityId))
    .limit(1)
  const row = rows[0]
  if (!row || !row.snap || !row.at) return null
  return { snap: row.snap, at: row.at }
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
