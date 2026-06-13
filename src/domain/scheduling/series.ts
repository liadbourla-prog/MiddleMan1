/**
 * Recurring weekly class series — expansion and materialization.
 *
 * Recurrence lives ABOVE the canonical availability spine. A `class_series` row
 * is a master definition; this module expands it into concrete `calendar_blocks`
 * instances (type='class', seriesId set). The booking engine and availability
 * compute keep operating on those instances unchanged, so recurrence adds no new
 * timezone or capacity logic to the deterministic core.
 *
 * `expandSeries` is pure and deterministic (no DB, no clock) so it is fully unit
 * testable. `materializeSeries` is the thin DB-bound wrapper that loads state,
 * calls the pure expander, and inserts the missing instances idempotently.
 *
 * Each weekly occurrence is resolved at the series' LOCAL wall-clock time via
 * localTimeToUtc(), so a 10:00 class stays 10:00 local across DST transitions.
 * See CALENDAR_UX_DESIGN.md §8 and PLAN Track 1A.
 */

import { and, eq, gte, lt, inArray } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { calendarBlocks, classSeries, classSeriesExceptions, bookings } from '../../db/schema.js'
import { localTimeToUtc } from '../availability/compute.js'

export interface SeriesDefinition {
  dayOfWeek: number // 0=Sun … 6=Sat (business-local)
  startTime: string // 'HH:MM' business-local
  durationMinutes: number
  startDate: string // 'YYYY-MM-DD' inclusive, business-local
  endDate: string | null // 'YYYY-MM-DD' inclusive, business-local; null = open-ended
  timezone: string
}

export interface Occurrence {
  occurrenceDate: string // 'YYYY-MM-DD' business-local
  startTs: Date // absolute UTC instant
  endTs: Date
}

/** Add `days` to a 'YYYY-MM-DD' string using pure UTC calendar math. */
function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number)
  const next = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days))
  return next.toISOString().slice(0, 10)
}

/** Day-of-week (0=Sun) for a 'YYYY-MM-DD' calendar date. */
function dayOfWeekOf(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay()
}

/** True when a <= b for 'YYYY-MM-DD' strings (lexicographic works for ISO dates). */
function lte(a: string, b: string): boolean {
  return a <= b
}

/**
 * Expand a series into the occurrences that fall inside [horizonFrom, horizonTo]
 * (inclusive, 'YYYY-MM-DD'), excluding any date in `exceptionDates` and any date
 * already present in `existingDates`. Pure: same inputs → same output, no clock.
 */
export function expandSeries(
  series: SeriesDefinition,
  opts: {
    horizonFrom: string
    horizonTo: string
    exceptionDates?: Iterable<string>
    existingDates?: Iterable<string>
  },
): Occurrence[] {
  const exceptions = new Set(opts.exceptionDates ?? [])
  const existing = new Set(opts.existingDates ?? [])

  // Effective window = series window ∩ horizon.
  let cursor = series.startDate > opts.horizonFrom ? series.startDate : opts.horizonFrom
  const seriesEnd = series.endDate ?? opts.horizonTo
  const windowEnd = seriesEnd < opts.horizonTo ? seriesEnd : opts.horizonTo
  if (cursor > windowEnd) return []

  // Advance cursor to the first matching weekday (bounded to 7 steps).
  let guard = 0
  while (dayOfWeekOf(cursor) !== series.dayOfWeek && lte(cursor, windowEnd) && guard < 7) {
    cursor = addDays(cursor, 1)
    guard++
  }

  const out: Occurrence[] = []
  for (let date = cursor; lte(date, windowEnd); date = addDays(date, 7)) {
    if (exceptions.has(date) || existing.has(date)) continue
    const startTs = localTimeToUtc(date, series.startTime, series.timezone)
    const endTs = new Date(startTs.getTime() + series.durationMinutes * 60_000)
    out.push({ occurrenceDate: date, startTs, endTs })
  }
  return out
}

export interface MaterializeOptions {
  horizonDays?: number // how far ahead to materialize (default 90)
  from?: Date // anchor "now" (default new Date()); slots before this are skipped at booking time, not here
}

export interface MaterializeResult {
  created: number
  seriesId: string
}

/**
 * Idempotently materialize one active series into `calendar_blocks` over a
 * rolling horizon. Re-running never duplicates: occurrences already present
 * (by seriesId + local date) and excepted dates are skipped.
 */
export async function materializeSeries(
  db: Db,
  seriesId: string,
  opts: MaterializeOptions = {},
): Promise<MaterializeResult> {
  const horizonDays = opts.horizonDays ?? 90
  const from = opts.from ?? new Date()

  const [series] = await db.select().from(classSeries).where(eq(classSeries.id, seriesId)).limit(1)
  if (!series || !series.isActive) return { created: 0, seriesId }

  const horizonFrom = from.toISOString().slice(0, 10)
  const horizonTo = new Date(from.getTime() + horizonDays * 86_400_000).toISOString().slice(0, 10)

  const exceptionRows = await db
    .select({ occurrenceDate: classSeriesExceptions.occurrenceDate })
    .from(classSeriesExceptions)
    .where(eq(classSeriesExceptions.seriesId, seriesId))

  // Existing materialized instances within the horizon, keyed by local date.
  const horizonStart = localTimeToUtc(horizonFrom, '00:00', series.timezone)
  const horizonEnd = new Date(localTimeToUtc(horizonTo, '00:00', series.timezone).getTime() + 86_400_000)
  const existingRows = await db
    .select({ startTs: calendarBlocks.startTs })
    .from(calendarBlocks)
    .where(
      and(
        eq(calendarBlocks.seriesId, seriesId),
        gte(calendarBlocks.startTs, horizonStart),
        lt(calendarBlocks.startTs, horizonEnd),
      ),
    )
  const existingDates = existingRows.map((r) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: series.timezone }).format(r.startTs),
  )

  const occurrences = expandSeries(
    {
      dayOfWeek: series.dayOfWeek,
      startTime: series.startTime.slice(0, 5),
      durationMinutes: series.durationMinutes,
      startDate: series.startDate,
      endDate: series.endDate,
      timezone: series.timezone,
    },
    {
      horizonFrom,
      horizonTo,
      exceptionDates: exceptionRows.map((r) => r.occurrenceDate),
      existingDates,
    },
  )

  if (occurrences.length === 0) return { created: 0, seriesId }

  await db.insert(calendarBlocks).values(
    occurrences.map((o) => ({
      businessId: series.businessId,
      type: 'class' as const,
      startTs: o.startTs,
      endTs: o.endTs,
      title: series.title,
      serviceTypeId: series.serviceTypeId,
      maxParticipants: series.maxParticipants,
      seriesId: series.id,
      providerId: series.providerId,
      source: 'internal' as const,
    })),
  )

  return { created: occurrences.length, seriesId }
}

/** Materialize every active series for a business (used by the worker / on create). */
export async function materializeAllActiveSeries(
  db: Db,
  businessId: string,
  opts: MaterializeOptions = {},
): Promise<number> {
  const rows = await db
    .select({ id: classSeries.id })
    .from(classSeries)
    .where(and(eq(classSeries.businessId, businessId), eq(classSeries.isActive, true)))
  let total = 0
  for (const r of rows) total += (await materializeSeries(db, r.id, opts)).created
  return total
}

// ── Series lifecycle (deterministic; called by the manager apply pipeline) ──────

export interface CreateSeriesInput {
  businessId: string
  serviceTypeId: string
  providerId?: string | null
  dayOfWeek: number
  startTime: string // 'HH:MM'
  durationMinutes: number
  maxParticipants: number
  title?: string | null
  startDate: string // 'YYYY-MM-DD'
  endDate?: string | null
  timezone: string
}

/** Create a series and immediately materialize its first horizon. Returns instances created. */
export async function createSeries(
  db: Db,
  input: CreateSeriesInput,
  opts: MaterializeOptions = {},
): Promise<{ seriesId: string; created: number }> {
  const [row] = await db
    .insert(classSeries)
    .values({
      businessId: input.businessId,
      serviceTypeId: input.serviceTypeId,
      providerId: input.providerId ?? null,
      dayOfWeek: input.dayOfWeek,
      startTime: input.startTime,
      durationMinutes: input.durationMinutes,
      maxParticipants: input.maxParticipants,
      title: input.title ?? null,
      startDate: input.startDate,
      endDate: input.endDate ?? null,
      timezone: input.timezone,
    })
    .returning({ id: classSeries.id })
  if (!row) throw new Error('createSeries: insert failed')
  const { created } = await materializeSeries(db, row.id, opts)
  return { seriesId: row.id, created }
}

/**
 * Stop a series going forward: deactivate it and delete its future, UNBOOKED
 * instances (from `from` onward). Past instances and any instance that already
 * has bookings are left untouched — cancelling those is the booking-cancellation
 * flow's responsibility, so customers are always notified through one path.
 */
export async function stopSeries(
  db: Db,
  seriesId: string,
  from: Date = new Date(),
): Promise<{ deletedInstances: number }> {
  await db.update(classSeries).set({ isActive: false, updatedAt: new Date() }).where(eq(classSeries.id, seriesId))
  const future = await db
    .select({ id: calendarBlocks.id })
    .from(calendarBlocks)
    .where(and(eq(calendarBlocks.seriesId, seriesId), gte(calendarBlocks.startTs, from)))
  let deleted = 0
  for (const inst of future) {
    // deleteUnbookedBlock is a no-op when the instance has live bookings.
    const removed = await deleteUnbookedBlock(db, inst.id)
    if (removed) deleted++
  }
  return { deletedInstances: deleted }
}

/**
 * Cancel a single occurrence: record an EXDATE-style exception (so the
 * materializer never recreates it) and remove the instance block if unbooked.
 * If the instance has bookings, the exception is still recorded but the block is
 * left for the booking-cancellation flow to handle (it notifies customers).
 */
export async function cancelOccurrence(
  db: Db,
  seriesId: string,
  occurrenceDate: string,
  reason?: string | null,
): Promise<{ blockRemoved: boolean }> {
  await db
    .insert(classSeriesExceptions)
    .values({ seriesId, occurrenceDate, reason: reason ?? null })
    .onConflictDoNothing()

  const [series] = await db.select({ timezone: classSeries.timezone }).from(classSeries).where(eq(classSeries.id, seriesId)).limit(1)
  if (!series) return { blockRemoved: false }

  const dayStart = localTimeToUtc(occurrenceDate, '00:00', series.timezone)
  const dayEnd = new Date(localTimeToUtc(addDays(occurrenceDate, 1), '00:00', series.timezone).getTime())
  const [inst] = await db
    .select({ id: calendarBlocks.id })
    .from(calendarBlocks)
    .where(and(eq(calendarBlocks.seriesId, seriesId), gte(calendarBlocks.startTs, dayStart), lt(calendarBlocks.startTs, dayEnd)))
    .limit(1)
  if (!inst) return { blockRemoved: false }
  const removed = await deleteUnbookedBlock(db, inst.id)
  return { blockRemoved: removed }
}

/**
 * Delete a class block iff it has no live bookings. Group bookings link to a
 * class slot by (serviceTypeId, slotStart), so we count live bookings on that
 * slot before removing the container. Returns whether the block was removed.
 */
async function deleteUnbookedBlock(db: Db, blockId: string): Promise<boolean> {
  const [block] = await db
    .select({ businessId: calendarBlocks.businessId, serviceTypeId: calendarBlocks.serviceTypeId, startTs: calendarBlocks.startTs })
    .from(calendarBlocks)
    .where(eq(calendarBlocks.id, blockId))
    .limit(1)
  if (!block) return false

  if (block.serviceTypeId) {
    const [live] = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.businessId, block.businessId),
          eq(bookings.serviceTypeId, block.serviceTypeId),
          eq(bookings.slotStart, block.startTs),
          inArray(bookings.state, ['held', 'pending_payment', 'confirmed']),
        ),
      )
      .limit(1)
    if (live) return false // booked — leave for the booking-cancellation flow
  }

  await db.delete(calendarBlocks).where(eq(calendarBlocks.id, blockId))
  return true
}
