import { and, eq } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { bookings } from '../../db/schema.js'
import { transition } from './state-machine.js'
import { logAudit } from '../audit/logger.js'

export type AttendanceOutcome = 'attended' | 'no_show'

export type MarkAttendanceResult = { ok: true } | { ok: false; reason: string }

/**
 * Record whether a booked customer showed up. Attendance is only reachable from a
 * CONFIRMED booking AND only after the slot has ended (CRM_STANDARD.md invariant
 * #6). Never written by an inbound Google sync; never mirrored back to Google.
 */
export async function markAttendance(
  db: Db,
  businessId: string,
  bookingId: string,
  outcome: AttendanceOutcome,
  now: Date = new Date(),
): Promise<MarkAttendanceResult> {
  const [booking] = await db
    .select({ state: bookings.state, slotEnd: bookings.slotEnd, customerId: bookings.customerId })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.businessId, businessId)))
    .limit(1)

  if (!booking) return { ok: false, reason: 'Booking not found' }
  if (booking.slotEnd > now) return { ok: false, reason: 'Cannot mark attendance before the session has ended' }

  const t = transition(booking.state, outcome)
  if (!t.ok) return { ok: false, reason: t.reason }

  await db
    .update(bookings)
    .set({ state: outcome, updatedAt: new Date() })
    .where(eq(bookings.id, bookingId))

  await logAudit(db, {
    businessId,
    actorId: null,
    action: `booking.${outcome}`,
    entityType: 'booking',
    entityId: bookingId,
    beforeState: { state: booking.state },
    afterState: { state: outcome },
  })

  return { ok: true }
}
