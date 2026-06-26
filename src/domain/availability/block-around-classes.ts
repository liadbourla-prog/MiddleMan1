/**
 * "Block open time around existing classes" — the atomic operation behind Issue 3.
 *
 * The owner can say, in Branch 3, "this week customers may only book the existing
 * classes — block everything else." Before this existed, the only block tool placed
 * ONE explicit range per call, so the model had to compute ~20 gap-blocks by hand and
 * could not finish within a turn (MAX_ITERATIONS=5, stateless). The constraint was
 * acknowledged in prose but never materialized into the state Branch 4 reads.
 *
 * This module turns that intent into a single deterministic call: for each in-range
 * day, it computes the complementary in-hours intervals AROUND the existing `class`
 * instances (and any time already blocked) and materializes one `block` row per gap.
 *
 * Two load-bearing invariants:
 *  1. A produced gap NEVER overlaps a `class` instance — blocking a class slot would
 *     re-break the Issue-2 group-class booking fix.
 *  2. Idempotent — re-running subtracts existing `block` rows, so a second run on the
 *     same range produces nothing new.
 *
 * Visibility is the owner's choice (see CALENDAR_UX_DESIGN.md): `mirror: true` makes
 * the blocks real, visible "blocked time" in Google; `mirror: false` keeps them as
 * internal-only off-limits hours (Branch 4 still refuses them to customers — only the
 * Google mirror differs). Defaults to internal-only.
 */

import type { Db } from '../../db/client.js'
import type { Business } from '../../db/schema.js'
import { localTimeToUtc } from './compute.js'
import { createBlock, listBlocksInRange } from './blocks.js'
import { loadAvailabilityModel } from './service.js'

/** A half-open numeric interval [start, end). Units are caller-defined (ms or minutes). */
export interface NumInterval {
  start: number
  end: number
}

/** Merge overlapping/adjacent intervals into a sorted, disjoint set. */
function mergeIntervals(intervals: NumInterval[]): NumInterval[] {
  const sorted = intervals
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start)
  const merged: NumInterval[] = []
  for (const cur of sorted) {
    const last = merged[merged.length - 1]
    if (last && cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end)
    } else {
      merged.push({ ...cur })
    }
  }
  return merged
}

/**
 * The complement of `occupied` within `windows`: every sub-interval of a window that
 * is NOT covered by an occupied interval. Output is sorted, disjoint, and never
 * overlaps any occupied interval (invariant #1). Occupied intervals may overlap each
 * other and may extend outside the windows.
 */
export function complementaryIntervals(windows: NumInterval[], occupied: NumInterval[]): NumInterval[] {
  const busy = mergeIntervals(occupied)
  const gaps: NumInterval[] = []
  for (const window of mergeIntervals(windows)) {
    let cursor = window.start
    for (const b of busy) {
      if (b.end <= cursor) continue // entirely before the cursor
      if (b.start >= window.end) break // past the window
      if (b.start > cursor) gaps.push({ start: cursor, end: Math.min(b.start, window.end) })
      cursor = Math.max(cursor, b.end)
      if (cursor >= window.end) break
    }
    if (cursor < window.end) gaps.push({ start: cursor, end: window.end })
  }
  return gaps
}

export interface BlockAroundClassesOptions {
  /** Inclusive local date range, YYYY-MM-DD. */
  from: string
  to: string
  /** Restrict to these weekdays (0=Sun … 6=Sat). Empty/undefined = all days in range. */
  weekdays?: number[]
  /** true = visible blocked time in Google; false = internal-only off-limits hours. */
  mirror: boolean
  /** Reason/title stamped on each created block. */
  reason?: string | null
}

export interface BlockAroundClassesSummary {
  daysProcessed: number
  blocksCreated: number
  classesPreserved: number
  /** Block row ids created, in case the caller wants to enqueue mirrors. */
  createdBlockIds: string[]
}

/**
 * The guidance the orchestrator relays to the owner after a bulk-block. Honesty rule
 * (Issue 3 §5): because the whole job finished in ONE call, the wording must report the
 * REAL totals and must never promise to continue the task after the turn — there is no
 * background job. Pure + exported so the honesty contract is deterministically testable.
 */
export function blockAroundClassesReplyGuidance(summary: BlockAroundClassesSummary, mirror: boolean): string {
  if (summary.blocksCreated === 0) {
    return 'Nothing needed blocking — the open in-hours time around the classes is already fully covered for that range. Tell the owner it is already done. Present it as complete; do not imply any further work happens after this reply.'
  }
  const where = mirror
    ? "blocked and will appear as blocked time in the owner's Google calendar"
    : 'held off internally — invisible in Google, but customers can no longer book them'
  return `This is fully done in a single step. Report the REAL outcome to the owner: ${summary.blocksCreated} open slot(s) across ${summary.daysProcessed} day(s) are now ${where}, while the existing ${summary.classesPreserved} class instance(s) stay bookable. Present it as complete — do not imply any further work happens after this reply.`
}

/** Iterate local dates from `from` to `to` inclusive (YYYY-MM-DD, calendar arithmetic). */
function eachDate(from: string, to: string): string[] {
  const out: string[] = []
  // Parse as UTC noon to avoid any DST/offset rollover when only the date matters.
  const start = new Date(`${from}T12:00:00Z`)
  const end = new Date(`${to}T12:00:00Z`)
  for (let d = start; d <= end; d = new Date(d.getTime() + 24 * 60 * 60 * 1000)) {
    out.push(d.toISOString().slice(0, 10))
  }
  return out
}

/** The weekday (0=Sun…6=Sat) of a YYYY-MM-DD date in the given timezone. */
function weekdayOf(dateStr: string, tz: string): number {
  // Noon local-ish; weekday is stable across the day so the exact instant is fine.
  const d = new Date(`${dateStr}T12:00:00Z`)
  const name = d.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' })
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[name] ?? d.getUTCDay()
}

/**
 * Materialize gap-blocks around existing classes for a date range. Deterministic and
 * idempotent. Does NOT cancel existing bookings — it only blocks open time, so a
 * private slot already booked stays valid while NEW non-class bookings are prevented.
 * Never blocks over a `class` instance.
 */
export async function blockOpenTimeAroundClasses(
  db: Db,
  business: Business,
  opts: BlockAroundClassesOptions,
): Promise<BlockAroundClassesSummary> {
  const tz = business.timezone ?? 'UTC'
  const weekdayFilter = opts.weekdays && opts.weekdays.length > 0 ? new Set(opts.weekdays) : null

  // Weekly hours + date overrides (no range needed — we read blocks separately below).
  const rangeStart = new Date(`${opts.from}T00:00:00Z`)
  const rangeEnd = new Date(`${opts.to}T23:59:59Z`)
  const model = await loadAvailabilityModel(db, business)

  // Existing blocks in range, split into class instances (never touch) and prior
  // `block`/`personal` rows (subtract, for idempotency + don't double-cover).
  const existing = await listBlocksInRange(db, business.id, rangeStart, rangeEnd)

  const summary: BlockAroundClassesSummary = { daysProcessed: 0, blocksCreated: 0, classesPreserved: 0, createdBlockIds: [] }

  for (const dateStr of eachDate(opts.from, opts.to)) {
    const weekday = weekdayOf(dateStr, tz)
    if (weekdayFilter && !weekdayFilter.has(weekday)) continue

    // Business hours for this date: a date override wins over the weekly rule.
    const override = model.dateOverrides.find((o) => o.date === dateStr)
    if (override?.isBlocked) continue // whole day already closed
    const rule = override ?? model.weeklyHours.find((w) => w.dayOfWeek === weekday)
    if (!rule) continue // closed that weekday
    const { openTime, closeTime } = rule
    if (!openTime || !closeTime) continue

    const dayOpen = localTimeToUtc(dateStr, openTime, tz).getTime()
    const dayClose = localTimeToUtc(dateStr, closeTime, tz).getTime()
    if (dayClose <= dayOpen) continue

    summary.daysProcessed += 1

    // Occupied = existing class instances + existing blocks that fall in this day.
    const occupied: NumInterval[] = []
    for (const b of existing) {
      const s = b.startTs.getTime()
      const e = b.endTs.getTime()
      if (e <= dayOpen || s >= dayClose) continue // not in this day's window
      if (b.type === 'class') summary.classesPreserved += 1
      occupied.push({ start: s, end: e })
    }

    const gaps = complementaryIntervals([{ start: dayOpen, end: dayClose }], occupied)
    for (const gap of gaps) {
      const block = await createBlock(db, {
        businessId: business.id,
        type: 'block',
        start: new Date(gap.start),
        end: new Date(gap.end),
        title: opts.reason ?? (business.defaultLanguage === 'en' ? 'Blocked time' : 'זמן חסום'),
        reason: opts.reason ?? null,
        mirrorToGoogle: opts.mirror,
      })
      summary.blocksCreated += 1
      summary.createdBlockIds.push(block.id)
    }
  }

  return summary
}
