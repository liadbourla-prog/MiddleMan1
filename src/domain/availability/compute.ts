/**
 * Pure, timezone-aware availability computation. No DB, no side effects.
 *
 * This is the canonical core of the availability spine: every branch (booking
 * engine, Branch 3 manager read-back, Branch 4 customer flow) resolves "is this
 * slot bookable" / "what's open" through these functions — never by computing
 * availability independently. See CALENDAR_UX_DESIGN.md.
 *
 * Responsibility split: this module owns *spatial* availability (working hours,
 * blocks, conflicts). Temporal policy (min-buffer, max-days-ahead, past-slot)
 * stays in the booking engine.
 */

export interface WeeklyHoursRule {
  dayOfWeek: number // 0=Sun … 6=Sat
  openTime: string // 'HH:MM'
  closeTime: string // 'HH:MM'
}

export interface DateOverrideRule {
  date: string // 'YYYY-MM-DD' in business-local time
  isBlocked: boolean
  openTime: string | null
  closeTime: string | null
}

export interface BusyInterval {
  start: Date
  end: Date
}

export interface AvailabilityModel {
  timezone: string
  available247: boolean
  weeklyHours: WeeklyHoursRule[]
  dateOverrides: DateOverrideRule[]
  busy: BusyInterval[]
}

export interface Slot {
  start: Date
  end: Date
}

export type BookableReason = 'ok' | 'invalid_slot' | 'outside_hours' | 'busy'

export interface BookableResult {
  bookable: boolean
  reason: BookableReason
}

const MINUTES_PER_DAY = 24 * 60

// ── Timezone helpers ────────────────────────────────────────────────────────

const WEEKDAY_MAP: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
}

interface LocalParts {
  dateStr: string // YYYY-MM-DD
  dayOfWeek: number // 0..6
  minutes: number // minutes since local midnight
}

/** Decompose an absolute Date into business-local date/day-of-week/minutes. */
export function localParts(date: Date, tz: string): LocalParts {
  const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(date)
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date)
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun'
  const dayOfWeek = WEEKDAY_MAP[weekday] ?? 0
  const h = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10)
  const m = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10)
  // Intl can emit '24' for midnight in some environments — normalize to 0.
  const hour = h === 24 ? 0 : h
  return { dateStr, dayOfWeek, minutes: hour * 60 + m }
}

function timeToMinutes(t: string): number {
  const [h = '0', m = '0'] = t.split(':')
  return parseInt(h, 10) * 60 + parseInt(m, 10)
}

function minutesToTime(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** Convert a business-local date + 'HH:MM' into an absolute UTC Date. */
export function localTimeToUtc(dateStr: string, timeStr: string, tz: string): Date {
  const [y, mo, d] = dateStr.split('-').map(Number)
  const [h, mi] = timeStr.split(':').map(Number)
  const naive = new Date(Date.UTC(y ?? 1970, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0, 0))
  // What local wall-clock (date + time) does `naive` map to in `tz`? We compare
  // the FULL timestamp, not just minute-of-day, so a midnight-adjacent target
  // that lands on a different local calendar day is corrected without a day-wrap
  // sign error.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(naive)
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? '0', 10)
  const lh = get('hour')
  const lhNorm = lh === 24 ? 0 : lh
  const localMs = Date.UTC(get('year'), get('month') - 1, get('day'), lhNorm, get('minute'), 0)
  const targetMs = Date.UTC(y ?? 1970, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0, 0)
  return new Date(naive.getTime() + (targetMs - localMs))
}

// ── Working-hours window ────────────────────────────────────────────────────

interface DayWindow {
  openMin: number
  closeMin: number
}

/**
 * Resolve the open window for a given business-local date.
 * Precedence: specific-date override > 24/7 > recurring weekly rule.
 * Returns null when the business is closed that day.
 */
export function dayWindow(model: AvailabilityModel, dateStr: string, dayOfWeek: number): DayWindow | null {
  const override = model.dateOverrides.find((o) => o.date === dateStr)
  if (override) {
    if (override.isBlocked) return null
    if (override.openTime && override.closeTime) {
      return { openMin: timeToMinutes(override.openTime), closeMin: timeToMinutes(override.closeTime) }
    }
    // Unblocked override with no explicit hours = open all day.
    return { openMin: 0, closeMin: MINUTES_PER_DAY }
  }

  if (model.available247) return { openMin: 0, closeMin: MINUTES_PER_DAY }

  const weekly = model.weeklyHours.find((w) => w.dayOfWeek === dayOfWeek)
  if (weekly?.openTime && weekly?.closeTime) {
    return { openMin: timeToMinutes(weekly.openTime), closeMin: timeToMinutes(weekly.closeTime) }
  }
  return null
}

// ── Core checks ─────────────────────────────────────────────────────────────

function overlapsBusy(model: AvailabilityModel, slot: Slot): boolean {
  return model.busy.some((b) => b.start < slot.end && b.end > slot.start)
}

/**
 * Spatial bookability: within working hours for the slot's local day AND not
 * overlapping any busy interval (bookings + blocks). Does NOT enforce temporal
 * policy (past/buffer/max-days) — that is the booking engine's job.
 */
export function isSlotBookable(model: AvailabilityModel, slot: Slot): BookableResult {
  if (!(slot.end.getTime() > slot.start.getTime())) {
    return { bookable: false, reason: 'invalid_slot' }
  }

  const startLocal = localParts(slot.start, model.timezone)
  const endLocal = localParts(slot.end, model.timezone)

  let endMin = endLocal.minutes
  if (endLocal.dateStr !== startLocal.dateStr) {
    // Slot ending exactly at local midnight is fine (treat as 1440 on the start day);
    // anything genuinely spanning into the next day is out of a single day's hours.
    if (endLocal.minutes === 0) endMin = MINUTES_PER_DAY
    else return { bookable: false, reason: 'outside_hours' }
  }

  const window = dayWindow(model, startLocal.dateStr, startLocal.dayOfWeek)
  if (!window) return { bookable: false, reason: 'outside_hours' }
  if (startLocal.minutes < window.openMin || endMin > window.closeMin) {
    return { bookable: false, reason: 'outside_hours' }
  }

  if (overlapsBusy(model, slot)) return { bookable: false, reason: 'busy' }

  return { bookable: true, reason: 'ok' }
}

export interface OpenSlotsOptions {
  stepMinutes?: number // granularity of candidate start times (default 30)
  now?: Date // slots starting before this are excluded (default new Date())
  maxSlots?: number // cap on returned slots (default 12)
}

/**
 * Enumerate bookable slots of `durationMinutes` within [range.start, range.end].
 * Powers proactive suggestion ("I have 3pm or 4:30 free"). Bounded and pure.
 */
export function getOpenSlots(
  model: AvailabilityModel,
  range: Slot,
  durationMinutes: number,
  opts: OpenSlotsOptions = {},
): Slot[] {
  const stepMinutes = opts.stepMinutes ?? 30
  const now = opts.now ?? new Date()
  const maxSlots = opts.maxSlots ?? 12
  const effectiveFrom = new Date(Math.max(range.start.getTime(), now.getTime()))
  if (effectiveFrom >= range.end || durationMinutes <= 0) return []

  const results: Slot[] = []
  const seenDates = new Set<string>()
  const dayCount = Math.ceil((range.end.getTime() - effectiveFrom.getTime()) / 86_400_000) + 1

  for (let i = 0; i <= dayCount; i++) {
    const probe = new Date(effectiveFrom.getTime() + i * 86_400_000)
    const { dateStr, dayOfWeek } = localParts(probe, model.timezone)
    if (seenDates.has(dateStr)) continue
    seenDates.add(dateStr)

    const window = dayWindow(model, dateStr, dayOfWeek)
    if (!window) continue

    for (let startMin = window.openMin; startMin + durationMinutes <= window.closeMin; startMin += stepMinutes) {
      const slotStart = localTimeToUtc(dateStr, minutesToTime(startMin), model.timezone)
      const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60_000)
      if (slotStart < effectiveFrom) continue
      if (slotEnd > range.end) break
      if (isSlotBookable(model, { start: slotStart, end: slotEnd }).bookable) {
        results.push({ start: slotStart, end: slotEnd })
        if (results.length >= maxSlots) return results
      }
    }
  }

  return results
}
