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
  | { ok: true; dateStr: string } // 'YYYY-MM-DD' in business-local calendar
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

  // 2. Weekday (optionally modified by this_week/next_week).
  if (parts.weekday != null && parts.weekday >= 0 && parts.weekday <= 6) {
    const base = nextOccurrenceOfWeekday(todayStr, parts.weekday)
    const dateStr = parts.relativeDay === 'next_week' ? addDaysToDateStr(base, 7) : base
    return { ok: true, dateStr }
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
