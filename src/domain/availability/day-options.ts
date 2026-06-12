/**
 * "What's on / what's open" for a single business-local day.
 *
 * Branch 4 customers ask things like "what classes are on Monday?" or "what's
 * free Tuesday afternoon?". The right answer enumerates the day's actual options:
 *   - scheduled group CLASSES (calendar_blocks type='class') with remaining spots
 *   - OPEN private/1-on-1 slots for the day
 *
 * This is the deterministic, timezone-aware spine for that answer. It returns
 * structured facts; the flow layer renders them into a human, lawbook-compliant
 * reply (no raw IDs/ISO/enums leak to the customer — G2). When a specific service
 * is named we restrict to it; otherwise we show everything for the day.
 */

import { and, eq, gte, lt, inArray } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { calendarBlocks, serviceTypes, bookings } from '../../db/schema.js'
import type { Business } from '../../db/schema.js'
import { resolveSlotStart, addDaysToDateStr } from './resolve-slot.js'
import { getOpenSlots } from './service.js'

// Booking states that occupy a class seat — mirrors the capacity check in
// booking/engine.ts requestGroupClassBooking so "spots left" matches reality.
const CLASS_OCCUPYING_STATES = ['requested', 'confirmed', 'pending_payment'] as const

export interface ClassSession {
  serviceTypeId: string
  serviceName: string
  start: Date
  end: Date
  spotsTotal: number
  spotsLeft: number
}

export interface PrivateOpening {
  serviceTypeId: string
  serviceName: string
  durationMinutes: number
  /** Open start times for this service on the day (already future-filtered). */
  slots: Date[]
}

export interface DayOptions {
  dateStr: string
  classes: ClassSession[]
  privateOpenings: PrivateOpening[]
}

export interface ListDayOptionsOpts {
  /** Restrict to a single service (customer named one). */
  serviceTypeId?: string | undefined
  /** Cap open private slots reported per service. Default 4. */
  maxPrivateSlotsPerService?: number
  /** Injectable clock for tests. Defaults to now. */
  now?: Date
}

/**
 * Enumerate the class sessions and open private slots for one business-local day.
 * Pure calendar/timezone logic via resolve-slot primitives — no date math leaks
 * to the LLM. Past sessions (when the day is today) are filtered out.
 */
export async function listDayOptions(
  db: Db,
  business: Business,
  dateStr: string,
  tz: string,
  opts: ListDayOptionsOpts = {},
): Promise<DayOptions> {
  const now = opts.now ?? new Date()
  const maxPrivateSlots = opts.maxPrivateSlotsPerService ?? 4

  const dayStart = resolveSlotStart(dateStr, { hour: 0, minute: 0 }, tz)
  const dayEnd = resolveSlotStart(addDaysToDateStr(dateStr, 1), { hour: 0, minute: 0 }, tz)
  // Never offer or list anything already in the past.
  const from = dayStart.getTime() < now.getTime() ? now : dayStart

  // ── Active services (optionally narrowed to the named one) ─────────────────
  const serviceConds = [eq(serviceTypes.businessId, business.id), eq(serviceTypes.isActive, true)]
  if (opts.serviceTypeId) serviceConds.push(eq(serviceTypes.id, opts.serviceTypeId))
  const services = await db
    .select({
      id: serviceTypes.id,
      name: serviceTypes.name,
      durationMinutes: serviceTypes.durationMinutes,
      maxParticipants: serviceTypes.maxParticipants,
    })
    .from(serviceTypes)
    .where(and(...serviceConds))

  const serviceById = new Map(services.map((s) => [s.id, s]))

  // ── Scheduled class sessions for the day ───────────────────────────────────
  const classBlockConds = [
    eq(calendarBlocks.businessId, business.id),
    eq(calendarBlocks.type, 'class'),
    gte(calendarBlocks.startTs, from),
    lt(calendarBlocks.startTs, dayEnd),
  ]
  if (opts.serviceTypeId) classBlockConds.push(eq(calendarBlocks.serviceTypeId, opts.serviceTypeId))

  const classBlocks = await db
    .select({
      serviceTypeId: calendarBlocks.serviceTypeId,
      startTs: calendarBlocks.startTs,
      endTs: calendarBlocks.endTs,
      maxParticipants: calendarBlocks.maxParticipants,
    })
    .from(calendarBlocks)
    .where(and(...classBlockConds))
    .orderBy(calendarBlocks.startTs)

  // Occupancy: one query for the day's class bookings, tallied in memory by
  // (serviceTypeId, slotStart) — the identity of a class session.
  const classServiceIds = [...new Set(classBlocks.map((b) => b.serviceTypeId).filter((v): v is string => v != null))]
  const occupancy = new Map<string, number>()
  if (classServiceIds.length > 0) {
    const seatRows = await db
      .select({ serviceTypeId: bookings.serviceTypeId, slotStart: bookings.slotStart })
      .from(bookings)
      .where(
        and(
          eq(bookings.businessId, business.id),
          inArray(bookings.serviceTypeId, classServiceIds),
          gte(bookings.slotStart, from),
          lt(bookings.slotStart, dayEnd),
          inArray(bookings.state, [...CLASS_OCCUPYING_STATES]),
        ),
      )
    for (const r of seatRows) {
      const key = `${r.serviceTypeId}|${r.slotStart.getTime()}`
      occupancy.set(key, (occupancy.get(key) ?? 0) + 1)
    }
  }

  const classes: ClassSession[] = []
  for (const b of classBlocks) {
    if (!b.serviceTypeId) continue
    // Never list a session that has already started.
    if (b.startTs.getTime() < from.getTime()) continue
    const svc = serviceById.get(b.serviceTypeId)
    // Skip classes whose service was deactivated or filtered out.
    if (opts.serviceTypeId && b.serviceTypeId !== opts.serviceTypeId) continue
    const spotsTotal = b.maxParticipants ?? svc?.maxParticipants ?? 1
    const taken = occupancy.get(`${b.serviceTypeId}|${b.startTs.getTime()}`) ?? 0
    classes.push({
      serviceTypeId: b.serviceTypeId,
      serviceName: svc?.name ?? 'Class',
      start: b.startTs,
      end: b.endTs,
      spotsTotal,
      spotsLeft: Math.max(0, spotsTotal - taken),
    })
  }

  // ── Open private/1-on-1 slots for the day ──────────────────────────────────
  const privateOpenings: PrivateOpening[] = []
  if (from.getTime() < dayEnd.getTime()) {
    const privateServices = services.filter((s) => (s.maxParticipants ?? 1) <= 1)
    for (const svc of privateServices) {
      let slots: Date[] = []
      try {
        const open = await getOpenSlots(db, business, { start: from, end: dayEnd }, svc.durationMinutes, { maxSlots: maxPrivateSlots })
        slots = open.map((s) => s.start)
      } catch {
        slots = []
      }
      if (slots.length > 0) {
        privateOpenings.push({
          serviceTypeId: svc.id,
          serviceName: svc.name,
          durationMinutes: svc.durationMinutes,
          slots,
        })
      }
    }
  }

  return { dateStr, classes, privateOpenings }
}
