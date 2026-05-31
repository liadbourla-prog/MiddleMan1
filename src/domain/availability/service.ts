/**
 * DB-backed availability service. Loads the canonical AvailabilityModel for a
 * business from Postgres, then delegates every decision to the pure functions in
 * compute.ts. This is the single seam every branch goes through to answer "is
 * this slot bookable" / "what's open" — see CALENDAR_UX_DESIGN.md §5.2.
 *
 * What it composes into one model:
 *   - working hours   ← `availability` (weekly rules + specific-date overrides)
 *   - blocks/personal/classes ← `calendar_blocks`
 *   - conflicting bookings    ← `bookings` in held/pending_payment/confirmed
 *
 * The Google-mode write-time freebusy guard is layered on TOP of this in Phase 2
 * (it is a connected-mode optimization, not part of the internal source of truth).
 */

import { and, eq, gte, inArray, lte } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { availability, bookings, businesses, calendarBlocks } from '../../db/schema.js'
import type { Business, CalendarBlockType } from '../../db/schema.js'
import {
  type AvailabilityModel,
  type BookableResult,
  type BusyInterval,
  type DateOverrideRule,
  type Slot,
  type WeeklyHoursRule,
  getOpenSlots as computeOpenSlots,
  isSlotBookable as computeSlotBookable,
} from './compute.js'

// Booking states that occupy a slot (a held/pending/confirmed slot is "busy").
const OCCUPYING_BOOKING_STATES: Array<'held' | 'pending_payment' | 'confirmed'> = [
  'held',
  'pending_payment',
  'confirmed',
]

export interface LoadModelOptions {
  /** Restrict working-hours + busy lookups to a window. Both bounds are absolute. */
  range?: Slot
  /** Exclude this booking from the busy set (e.g. when re-validating its own slot). */
  excludeBookingId?: string
  /**
   * Which calendar_block types count as busy. Default: all types.
   * Callers booking INTO a class exclude 'class' so the container block is not
   * treated as a conflict (capacity is governed separately).
   */
  blockTypes?: CalendarBlockType[]
  /**
   * Whether occupying bookings (held/pending_payment/confirmed) count as busy.
   * Default true. The booking engine sets this false for its pre-flight because
   * its own transactional FOR UPDATE check is the race-safe authority.
   */
  includeBookings?: boolean
}

const ALL_BLOCK_TYPES: CalendarBlockType[] = ['block', 'personal', 'class']

/**
 * Build the canonical AvailabilityModel for a business over an optional range.
 * Pure data assembly — no policy decisions live here.
 */
export async function loadAvailabilityModel(
  db: Db,
  business: Business,
  opts: LoadModelOptions = {},
): Promise<AvailabilityModel> {
  const businessId = business.id

  // 1. Working hours: weekly recurring rules + specific-date overrides.
  const availabilityRows = await db
    .select()
    .from(availability)
    .where(eq(availability.businessId, businessId))

  const weeklyHours: WeeklyHoursRule[] = []
  const dateOverrides: DateOverrideRule[] = []
  for (const row of availabilityRows) {
    if (row.specificDate) {
      dateOverrides.push({
        date: row.specificDate,
        isBlocked: row.isBlocked,
        openTime: row.openTime,
        closeTime: row.closeTime,
      })
    } else if (row.dayOfWeek !== null && row.openTime && row.closeTime) {
      weeklyHours.push({
        dayOfWeek: row.dayOfWeek,
        openTime: row.openTime,
        closeTime: row.closeTime,
      })
    }
  }

  // 2. Busy intervals: calendar_blocks + occupying bookings, optionally windowed.
  const busy: BusyInterval[] = []

  const blockTypes = opts.blockTypes ?? ALL_BLOCK_TYPES
  const blockRows = await db
    .select({ start: calendarBlocks.startTs, end: calendarBlocks.endTs })
    .from(calendarBlocks)
    .where(
      and(
        rangeFilter(calendarBlocks.startTs, calendarBlocks.endTs, businessId, calendarBlocks.businessId, opts.range),
        inArray(calendarBlocks.type, blockTypes),
      ),
    )
  for (const b of blockRows) busy.push({ start: b.start, end: b.end })

  if (opts.includeBookings !== false) {
    const bookingRows = await db
      .select({ id: bookings.id, start: bookings.slotStart, end: bookings.slotEnd })
      .from(bookings)
      .where(
        and(
          eq(bookings.businessId, businessId),
          inArray(bookings.state, OCCUPYING_BOOKING_STATES),
          rangeOverlap(bookings.slotStart, bookings.slotEnd, opts.range),
        ),
      )
    for (const row of bookingRows) {
      if (opts.excludeBookingId && row.id === opts.excludeBookingId) continue
      busy.push({ start: row.start, end: row.end })
    }
  }

  return {
    timezone: business.timezone,
    available247: business.available247,
    weeklyHours,
    dateOverrides,
    busy,
  }
}

/**
 * Spatial bookability for a single slot (working hours + block/booking overlap).
 * Does NOT enforce temporal policy (past/buffer/max-days) — the booking engine
 * owns that. Loads a model windowed tightly around the slot for efficiency.
 */
export async function isSlotBookable(
  db: Db,
  business: Business,
  slot: Slot,
  opts: { excludeBookingId?: string; blockTypes?: CalendarBlockType[]; includeBookings?: boolean } = {},
): Promise<BookableResult> {
  const model = await loadAvailabilityModel(db, business, {
    range: { start: slot.start, end: slot.end },
    ...(opts.excludeBookingId ? { excludeBookingId: opts.excludeBookingId } : {}),
    ...(opts.blockTypes ? { blockTypes: opts.blockTypes } : {}),
    ...(opts.includeBookings !== undefined ? { includeBookings: opts.includeBookings } : {}),
  })
  return computeSlotBookable(model, slot)
}

export interface OpenSlotsServiceOptions {
  stepMinutes?: number
  now?: Date
  maxSlots?: number
}

/**
 * Enumerate bookable slots of `durationMinutes` within [range.start, range.end].
 * Powers proactive suggestion in Branch 3/4.
 */
export async function getOpenSlots(
  db: Db,
  business: Business,
  range: Slot,
  durationMinutes: number,
  opts: OpenSlotsServiceOptions = {},
): Promise<Slot[]> {
  const model = await loadAvailabilityModel(db, business, { range })
  return computeOpenSlots(model, range, durationMinutes, opts)
}

/** Convenience: load the business row then build its model. */
export async function loadAvailabilityModelById(
  db: Db,
  businessId: string,
  opts: LoadModelOptions = {},
): Promise<AvailabilityModel | null> {
  const [business] = await db.select().from(businesses).where(eq(businesses.id, businessId)).limit(1)
  if (!business) return null
  return loadAvailabilityModel(db, business, opts)
}

// ── range helpers ───────────────────────────────────────────────────────────

// An interval [start,end] overlaps [range.start, range.end] iff start < range.end
// AND end > range.start. Returned as a drizzle condition (undefined = no filter).
function rangeOverlap(
  startCol: typeof bookings.slotStart,
  endCol: typeof bookings.slotEnd,
  range?: Slot,
) {
  if (!range) return undefined
  return and(lte(startCol, range.end), gte(endCol, range.start))
}

// calendar_blocks variant — same overlap predicate plus the business filter,
// kept together so the businessId equality and range bounds compose cleanly.
function rangeFilter(
  startCol: typeof calendarBlocks.startTs,
  endCol: typeof calendarBlocks.endTs,
  businessId: string,
  businessCol: typeof calendarBlocks.businessId,
  range?: Slot,
) {
  const businessEq = eq(businessCol, businessId)
  if (!range) return businessEq
  return and(businessEq, lte(startCol, range.end), gte(endCol, range.start))
}
