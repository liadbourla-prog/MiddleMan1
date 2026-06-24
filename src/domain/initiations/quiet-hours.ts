// Quiet-hours evaluation (Phase 5.2) — pure. A business-local window { start, end } in 'HH:MM'.
// Used by the dispatcher to compute nowInQuietHours for promotional sends (the gate then skips
// them with reason 'quiet_hours'). Handles wrap-around windows (e.g. 21:00–08:00 spans midnight).

export interface QuietHoursWindow {
  start: string // 'HH:MM' business-local
  end: string   // 'HH:MM' business-local
}

/** Parse 'HH:MM' to minutes-of-day, or null when malformed. */
function parseHhmm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (!m) return null
  const h = parseInt(m[1]!, 10)
  const min = parseInt(m[2]!, 10)
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** Local minutes-of-day for `now` in the given IANA timezone. */
function localMinutesOfDay(now: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now)
  const h = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10)
  const m = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10)
  return (h === 24 ? 0 : h) * 60 + m   // Intl can emit '24' for midnight — normalize
}

/**
 * Whether `now` falls inside the business-local quiet-hours window. A window whose start
 * equals end (or is malformed) is treated as empty → never in quiet hours. Wrap-around
 * windows (start > end) span midnight.
 */
export function isWithinQuietHours(now: Date, tz: string, window: QuietHoursWindow): boolean {
  const startM = parseHhmm(window.start)
  const endM = parseHhmm(window.end)
  if (startM === null || endM === null || startM === endM) return false
  const nowM = localMinutesOfDay(now, tz)
  if (startM < endM) return nowM >= startM && nowM < endM
  return nowM >= startM || nowM < endM // wrap-around past midnight
}
