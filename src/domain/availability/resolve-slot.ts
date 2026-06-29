/**
 * Deterministic slot resolution. Pure, timezone-aware, no DB, no LLM.
 *
 * Branch 4's LLM is interpretive only: it CLASSIFIES what the customer said into
 * structured pieces (relative day, weekday, explicit date, time). This module is
 * the deterministic core that turns those pieces into an absolute UTC instant —
 * the LLM never does calendar arithmetic. This is what stops "tomorrow" resolving
 * to the wrong weekday/month and "10.01.2016" reaching a confirmation.
 *
 * Spatial/temporal POLICY (hours, blocks, past/buffer/max-days) is NOT decided
 * here — that stays in availability/compute.ts + booking/engine.ts. This module
 * only answers "which calendar date and clock time did the customer mean?".
 */

import { localParts, localTimeToUtc } from './compute.js'

export type RelativeDay = 'today' | 'tomorrow' | 'day_after_tomorrow' | 'this_week' | 'next_week'

export interface RequestedDateParts {
  relativeDay: RelativeDay | null
  weekday: number | null // 0=Sun … 6=Sat
  weekdayAnchor?: 'this' | 'next' | null
  explicitDate: { year: number | null; month: number | null; day: number | null } | null
}

export interface RequestedTime {
  hour: number // 0..23
  minute: number // 0..59
}

// Internal reason codes — NEVER shown to the customer. The flow maps these to
// plain-language wording via REASON_MAP/sanitiseReason (G2: no UI leak).
export type DateResolutionReason =
  | 'no_date' // nothing date-like was provided
  | 'ambiguous_date' // a relative week ref with no weekday to anchor it
  | 'impossible_date' // e.g. 30 February
  | 'past_year' // an explicit year already in the past (the 2016 bug)

export type DateResolution =
  | { ok: true; dateStr: string; ambiguousToday?: true; nextWeekStr?: string } // 'YYYY-MM-DD' in business-local calendar
  | { ok: false; reason: DateResolutionReason }

// ── small pure date-string helpers (calendar-only, tz-agnostic) ──────────────

/** Add n calendar days to a 'YYYY-MM-DD' string. */
export function addDaysToDateStr(dateStr: string, n: number): string {
  const [y = 1970, m = 1, d = 1] = dateStr.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + n)
  return dt.toISOString().slice(0, 10)
}

/** Day-of-week (0=Sun..6=Sat) of a calendar date string. */
function dowOf(dateStr: string): number {
  const [y = 1970, m = 1, d = 1] = dateStr.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay()
}

/** True iff (year, month, day) is a real calendar date (rejects 30 Feb etc.). */
function isRealDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

/** Compare two 'YYYY-MM-DD' strings lexically (safe — ISO is sortable). */
function isBefore(a: string, b: string): boolean {
  return a < b
}

// ── date resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the customer's requested calendar DATE, anchored to business-local
 * "today" derived from `now` in `tz`. Returns a date string or an internal reason.
 *
 * Precedence: explicitDate > weekday > relativeDay. (An explicit "the 9th" beats a
 * vague "next week".) Relative-week refs only resolve when paired with a weekday.
 */
export function resolveRequestedDate(parts: RequestedDateParts, tz: string, now: Date): DateResolution {
  const todayStr = localParts(now, tz).dateStr
  const currentYear = Number(todayStr.slice(0, 4))

  // 1. Explicit calendar date (day + month required; year optional/inferred).
  const ex = parts.explicitDate
  if (ex && ex.day != null && ex.month != null) {
    if (ex.month < 1 || ex.month > 12 || ex.day < 1 || ex.day > 31) {
      return { ok: false, reason: 'impossible_date' }
    }
    if (ex.year != null) {
      if (ex.year < currentYear) return { ok: false, reason: 'past_year' }
      if (!isRealDate(ex.year, ex.month, ex.day)) return { ok: false, reason: 'impossible_date' }
      const dateStr = `${ex.year}-${pad(ex.month)}-${pad(ex.day)}`
      if (isBefore(dateStr, todayStr)) return { ok: false, reason: 'past_year' }
      return { ok: true, dateStr }
    }
    // Year omitted: pick the nearest occurrence that is today or in the future.
    for (const y of [currentYear, currentYear + 1]) {
      if (!isRealDate(y, ex.month, ex.day)) continue
      const dateStr = `${y}-${pad(ex.month)}-${pad(ex.day)}`
      if (!isBefore(dateStr, todayStr)) return { ok: true, dateStr }
    }
    return { ok: false, reason: 'impossible_date' }
  }

  // 2. Weekday (optionally modified by this_week/next_week or weekdayAnchor).
  if (parts.weekday != null && parts.weekday >= 0 && parts.weekday <= 6) {
    const base = nextOccurrenceOfWeekday(todayStr, parts.weekday)
    if (parts.relativeDay === 'next_week' || parts.weekdayAnchor === 'next') {
      return { ok: true, dateStr: addDaysToDateStr(base, 7) }
    }
    if (base === todayStr && parts.weekdayAnchor == null && parts.relativeDay == null) {
      return { ok: true, dateStr: base, ambiguousToday: true, nextWeekStr: addDaysToDateStr(base, 7) }
    }
    return { ok: true, dateStr: base }
  }

  // 3. Pure relative day.
  switch (parts.relativeDay) {
    case 'today':
      return { ok: true, dateStr: todayStr }
    case 'tomorrow':
      return { ok: true, dateStr: addDaysToDateStr(todayStr, 1) }
    case 'day_after_tomorrow':
      return { ok: true, dateStr: addDaysToDateStr(todayStr, 2) }
    case 'this_week':
    case 'next_week':
      // No weekday to anchor it → needs clarification, not a guess.
      return { ok: false, reason: 'ambiguous_date' }
    default:
      return { ok: false, reason: 'no_date' }
  }
}

/** Nearest date >= today (business-local) whose weekday is `target` (0..6). */
function nextOccurrenceOfWeekday(todayStr: string, target: number): string {
  const todayDow = dowOf(todayStr)
  const delta = (target - todayDow + 7) % 7 // 0 = today itself
  return addDaysToDateStr(todayStr, delta)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * Compose a resolved date string + clock time into an absolute UTC Date,
 * via the DST-correct localTimeToUtc primitive.
 */
export function resolveSlotStart(dateStr: string, time: RequestedTime, tz: string): Date {
  return localTimeToUtc(dateStr, `${pad(time.hour)}:${pad(time.minute)}`, tz)
}

/**
 * True iff the requested wall-clock time does not exist on the local calendar
 * that day — the spring-forward DST gap (e.g. 02:30 when the clocks jump
 * 02:00→03:00). We resolve the instant, render it BACK to business-local time,
 * and compare to what was asked: a gap means the resolved instant lands on a
 * different local minute-of-day than requested. Shared by Branch 4 (customer
 * booking) and Branch 3 (manager calendar writes) so both use one correct check.
 */
export function isDstGap(slotStart: Date, time: RequestedTime, tz: string): boolean {
  if (isNaN(slotStart.getTime())) return true
  return localParts(slotStart, tz).minutes !== time.hour * 60 + time.minute
}

// ── slot-range resolution (manager calendar writes need start AND end) ───────

export type SlotRangeReason = DateResolutionReason | 'dst_gap' | 'end_before_start' | 'no_time'

export interface RequestedSlotRange {
  date: RequestedDateParts
  startTime: RequestedTime
  endTime?: RequestedTime | null
  durationMinutes?: number | null
}

export type SlotRangeResolution =
  | { ok: true; start: Date; end: Date; dateStr: string }
  | { ok: false; reason: SlotRangeReason }

/**
 * Resolve a manager-stated date + start/end into an absolute UTC range, fully
 * deterministically. The LLM only ever supplies the structured pieces — this is
 * the calendar arithmetic (Principle #1). Applies the same guards as Branch 4:
 * past-year, impossible-date, ambiguous-week, and DST gap all fail closed so the
 * caller asks for clarification instead of writing a wrong instant.
 *
 * End is taken from `endTime` when given, else `durationMinutes`. Either one is
 * required; the range must be strictly positive.
 */
export function resolveSlotRange(req: RequestedSlotRange, tz: string, now: Date): SlotRangeResolution {
  const dateRes = resolveRequestedDate(req.date, tz, now)
  if (!dateRes.ok) return { ok: false, reason: dateRes.reason }

  const start = resolveSlotStart(dateRes.dateStr, req.startTime, tz)
  if (isDstGap(start, req.startTime, tz)) return { ok: false, reason: 'dst_gap' }

  let end: Date
  if (req.endTime) {
    end = resolveSlotStart(dateRes.dateStr, req.endTime, tz)
    if (isDstGap(end, req.endTime, tz)) return { ok: false, reason: 'dst_gap' }
  } else if (req.durationMinutes != null && req.durationMinutes > 0) {
    end = new Date(start.getTime() + req.durationMinutes * 60_000)
  } else {
    return { ok: false, reason: 'no_time' }
  }

  if (end.getTime() <= start.getTime()) return { ok: false, reason: 'end_before_start' }
  return { ok: true, start, end, dateStr: dateRes.dateStr }
}
