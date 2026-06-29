/**
 * Waitlist offer fresh-spine re-validation (Unified Anti-Fabrication Gate — T2a.2, H3/H18).
 *
 * Between the cancellation that frees a slot and the moment the waitlist worker actually sends
 * the "a spot just opened" offer, the slot can be retaken (someone books it directly, or another
 * waitlister takes the class seat). Sending an offer for a slot that is gone is a fabrication —
 * and the offer must never claim the slot is "held"/"reserved" (no hold exists; owner decision:
 * re-word to honest "first to reply gets it"). This module is the fresh-spine check the worker
 * runs BEFORE the send: re-read the focused day's real capacity and confirm the slot is still
 * genuinely open. The booking-time availability check remains the final backstop if two reply.
 */
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client.js'
import { businesses } from '../db/schema.js'
import { listDayOptions, type DayOptions } from '../domain/availability/day-options.js'

/**
 * Is the specific freed slot still open in the day's fresh spine? A class seat is open iff that
 * session still has spotsLeft > 0; a private/1-on-1 slot is open iff it is still enumerated as a
 * bookable opening. Pure — operates on an already-read DayOptions so the open-detection logic is
 * unit-testable without a DB.
 */
export function isSlotStillOpenInDay(day: DayOptions, slotStart: Date): boolean {
  const ts = slotStart.getTime()
  if (day.classes.some((c) => c.start.getTime() === ts && c.spotsLeft > 0)) return true
  if (day.privateOpenings.some((p) => p.slots.some((s) => s.getTime() === ts))) return true
  return false
}

/**
 * Fresh-spine re-validation for a waitlist offer. Returns true iff the freed (serviceTypeId,
 * slotStart) is still genuinely open right now. Fail-OPEN: if the business can't be loaded the
 * offer still goes out (the booking-time check is the backstop) — we never suppress a real
 * offer on a transient read error.
 */
export async function revalidateWaitlistSlotOpen(
  database: Db,
  businessId: string,
  serviceTypeId: string,
  slotStart: Date,
): Promise<boolean> {
  const [biz] = await database
    .select()
    .from(businesses)
    .where(and(eq(businesses.id, businessId)))
    .limit(1)
  if (!biz) return true
  const dateStr = slotStart.toLocaleDateString('en-CA', { timeZone: biz.timezone })
  const day = await listDayOptions(database, biz, dateStr, biz.timezone, { serviceTypeId })
  return isSlotStillOpenInDay(day, slotStart)
}
