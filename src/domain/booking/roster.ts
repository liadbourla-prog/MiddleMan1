import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { bookings, identities, serviceTypes } from '../../db/schema.js'
import type { BookingState, PaymentStatus } from '../../db/schema.js'
import { findClassBlockProviderForSlot } from '../availability/blocks.js'

export interface SessionParticipant {
  customerId: string
  displayName: string | null
  state: BookingState
  paymentStatus: PaymentStatus
  attendance: 'attended' | 'no_show' | null
}

export interface SessionRoster {
  instance: {
    serviceTypeId: string
    serviceName: string | null
    instructorId: string | null
    instructorName: string | null
    start: Date
    end: Date | null
    capacity: number | null
  }
  participants: SessionParticipant[]
  spotsLeft: number | null
}

// States that occupy a seat in the session (everything except the dead states).
const SEAT_STATES: BookingState[] = ['requested', 'held', 'pending_payment', 'confirmed', 'attended', 'no_show']

/**
 * The single authoritative "who booked this session" read (CRM_STANDARD.md §2).
 * Works for a class instance (calendar_blocks type='class' at the slot) AND a
 * 1-on-1 slot (no class block — capacity 1, instructor from the booking). Returns
 * null when neither a class block nor any booking exists for the slot.
 */
export async function loadSessionRoster(
  db: Db,
  businessId: string,
  params: { serviceTypeId: string; slotStart: Date },
): Promise<SessionRoster | null> {
  const { serviceTypeId, slotStart } = params

  const rows = await db
    .select({
      customerId: bookings.customerId,
      displayName: identities.displayName,
      state: bookings.state,
      paymentStatus: bookings.paymentStatus,
      providerId: bookings.providerId,
      slotEnd: bookings.slotEnd,
    })
    .from(bookings)
    .innerJoin(identities, eq(bookings.customerId, identities.id))
    .where(
      and(
        eq(bookings.businessId, businessId),
        eq(bookings.serviceTypeId, serviceTypeId),
        eq(bookings.slotStart, slotStart),
        inArray(bookings.state, SEAT_STATES),
      ),
    )

  const block = await findClassBlockProviderForSlot(db, businessId, serviceTypeId, slotStart)
  if (!block.found && rows.length === 0) return null

  const [svc] = await db
    .select({ name: serviceTypes.name })
    .from(serviceTypes)
    .where(and(eq(serviceTypes.id, serviceTypeId), eq(serviceTypes.businessId, businessId)))
    .limit(1)

  // Instructor + capacity: the class block is the SoT; for a 1-on-1 fall back to
  // the booking's provider and capacity 1.
  const instructorId = block.found ? block.providerId : (rows[0]?.providerId ?? null)
  const capacity = block.found ? block.maxParticipants : 1

  let instructorName: string | null = null
  if (instructorId) {
    const [inst] = await db
      .select({ name: identities.displayName })
      .from(identities)
      .where(eq(identities.id, instructorId))
      .limit(1)
    instructorName = inst?.name ?? null
  }

  const participants: SessionParticipant[] = rows.map((r) => ({
    customerId: r.customerId,
    displayName: r.displayName,
    state: r.state,
    paymentStatus: r.paymentStatus,
    attendance: r.state === 'attended' || r.state === 'no_show' ? r.state : null,
  }))

  const spotsLeft = capacity == null ? null : Math.max(0, capacity - participants.length)
  const end = rows[0]?.slotEnd ?? null

  return {
    instance: {
      serviceTypeId,
      serviceName: svc?.name ?? null,
      instructorId,
      instructorName,
      start: slotStart,
      end,
      capacity,
    },
    participants,
    spotsLeft,
  }
}
