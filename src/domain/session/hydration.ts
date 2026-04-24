import { eq, and, or, desc } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { bookings, serviceTypes } from '../../db/schema.js'
import type { CustomerMemory } from '../customer/profile.js'

export interface HydratedContext {
  customerMemory: CustomerMemory | null
  // Surfaced directly so the LLM prompt can reference them without parsing
  returningCustomer: boolean
  preferredServiceName: string | null
  daysSinceLastBooking: number | null
  upcomingBooking: {
    id: string
    slotStart: string
    serviceName: string
    state: string
  } | null
}

export async function buildHydratedContext(
  db: Db,
  identityId: string,
  businessId: string,
  memory: CustomerMemory | null,
): Promise<HydratedContext> {
  // Load the next upcoming confirmed booking for this customer, if any
  const now = new Date()
  const upcomingRows = await db
    .select({
      id: bookings.id,
      slotStart: bookings.slotStart,
      state: bookings.state,
      serviceName: serviceTypes.name,
    })
    .from(bookings)
    .leftJoin(serviceTypes, eq(bookings.serviceTypeId, serviceTypes.id))
    .where(
      and(
        eq(bookings.customerId, identityId),
        eq(bookings.businessId, businessId),
        or(eq(bookings.state, 'confirmed'), eq(bookings.state, 'held')),
      ),
    )
    .orderBy(desc(bookings.slotStart))
    .limit(1)

  const upcoming = upcomingRows[0] ?? null

  const daysSinceLastBooking =
    memory?.lastBookingAt != null
      ? Math.floor((now.getTime() - memory.lastBookingAt.getTime()) / (1000 * 60 * 60 * 24))
      : null

  return {
    customerMemory: memory,
    returningCustomer: memory !== null && memory.totalBookings > 0,
    preferredServiceName: memory?.preferredServiceName ?? null,
    daysSinceLastBooking,
    upcomingBooking: upcoming
      ? {
          id: upcoming.id,
          slotStart: upcoming.slotStart.toISOString(),
          serviceName: upcoming.serviceName ?? 'Appointment',
          state: upcoming.state,
        }
      : null,
  }
}
