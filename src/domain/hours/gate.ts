import { eq, and, isNull } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { availability } from '../../db/schema.js'
import type { Business } from '../../db/schema.js'

export interface HoursCheckResult {
  open: boolean
  opensAt: string | null  // HH:MM in business timezone, null if no schedule found
}

function localDateParts(tz: string, forDate?: Date): { dateStr: string; dayOfWeek: number; nowMinutes: number } {
  const now = forDate ?? new Date()
  const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now) // YYYY-MM-DD
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now)
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  const weekday = parts.find(p => p.type === 'weekday')?.value ?? 'Sun'
  const dayOfWeek = weekdayMap[weekday] ?? new Date(dateStr).getDay()
  const h = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10)
  const m = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10)
  const nowMinutes = h * 60 + m
  return { dateStr, dayOfWeek, nowMinutes }
}

function timeToMinutes(t: string): number {
  const [h = '0', m = '0'] = t.split(':')
  return parseInt(h, 10) * 60 + parseInt(m, 10)
}

// Convert a local date + HH:MM in `tz` to a UTC Date
function localTimeToUtc(dateStr: string, timeStr: string, tz: string): Date {
  const [y, mo, d] = dateStr.split('-').map(Number)
  const [h, mi] = timeStr.split(':').map(Number)
  // Naive UTC approximation at the requested local time
  const naive = new Date(Date.UTC(y!, mo! - 1, d!, h!, mi!, 0))
  // Detect the offset: what local time does `naive` correspond to in `tz`?
  const localParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(naive)
  const lh = parseInt(localParts.find(p => p.type === 'hour')?.value ?? '0', 10)
  const lm = parseInt(localParts.find(p => p.type === 'minute')?.value ?? '0', 10)
  const diffMin = (h! * 60 + mi!) - (lh * 60 + lm)
  return new Date(naive.getTime() + diffMin * 60_000)
}

export async function checkBusinessHours(db: Db, business: Business): Promise<HoursCheckResult> {
  // Always open if configured so (and not specifically blocked)
  const open = { open: true, opensAt: null }

  const { dateStr, dayOfWeek, nowMinutes } = localDateParts(business.timezone)

  // 1. Check for a specific-date rule (overrides everything)
  const [specificRule] = await db
    .select()
    .from(availability)
    .where(and(eq(availability.businessId, business.id), eq(availability.specificDate, dateStr)))
    .limit(1)

  if (specificRule) {
    if (specificRule.isBlocked) return { open: false, opensAt: null }
    // Explicit hours for today
    if (specificRule.openTime && specificRule.closeTime) {
      const openMin = timeToMinutes(specificRule.openTime)
      const closeMin = timeToMinutes(specificRule.closeTime)
      return nowMinutes >= openMin && nowMinutes < closeMin
        ? open
        : { open: false, opensAt: specificRule.openTime }
    }
    // An unblocked specific-date rule with no hours = open all day
    return open
  }

  // 2. If 24/7 and no specific block, always open
  if (business.available247) return open

  // 3. Check the recurring weekly schedule for today
  const [weeklyRule] = await db
    .select()
    .from(availability)
    .where(
      and(
        eq(availability.businessId, business.id),
        eq(availability.dayOfWeek, dayOfWeek),
        isNull(availability.specificDate),
        eq(availability.isBlocked, false),
      ),
    )
    .limit(1)

  if (!weeklyRule || !weeklyRule.openTime || !weeklyRule.closeTime) {
    // No schedule for this day — treat as closed
    return { open: false, opensAt: null }
  }

  const openMin = timeToMinutes(weeklyRule.openTime)
  const closeMin = timeToMinutes(weeklyRule.closeTime)
  return nowMinutes >= openMin && nowMinutes < closeMin
    ? open
    : { open: false, opensAt: weeklyRule.openTime }
}

// Returns milliseconds until the business next opens, or null if undetermined (max 7 days lookahead).
export async function computeNextOpenMs(db: Db, business: Business): Promise<number | null> {
  if (business.available247) return 0

  const tz = business.timezone

  for (let daysAhead = 0; daysAhead <= 7; daysAhead++) {
    const target = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1_000)
    const { dateStr, dayOfWeek, nowMinutes } = localDateParts(tz, target)

    // Specific-date rule takes priority
    const [specificRule] = await db
      .select()
      .from(availability)
      .where(and(eq(availability.businessId, business.id), eq(availability.specificDate, dateStr)))
      .limit(1)

    if (specificRule) {
      if (specificRule.isBlocked) continue
      if (specificRule.openTime && specificRule.closeTime) {
        const openMin = timeToMinutes(specificRule.openTime)
        const closeMin = timeToMinutes(specificRule.closeTime)
        if (daysAhead === 0) {
          if (nowMinutes >= openMin && nowMinutes < closeMin) return 0
          if (nowMinutes >= closeMin) continue
          // Before openTime today
          return Math.max(0, localTimeToUtc(dateStr, specificRule.openTime, tz).getTime() - Date.now())
        }
        return Math.max(0, localTimeToUtc(dateStr, specificRule.openTime, tz).getTime() - Date.now())
      }
      continue
    }

    // Weekly rule
    const [weeklyRule] = await db
      .select()
      .from(availability)
      .where(and(
        eq(availability.businessId, business.id),
        eq(availability.dayOfWeek, dayOfWeek),
        isNull(availability.specificDate),
        eq(availability.isBlocked, false),
      ))
      .limit(1)

    if (!weeklyRule?.openTime || !weeklyRule?.closeTime) continue

    const openMin = timeToMinutes(weeklyRule.openTime)
    const closeMin = timeToMinutes(weeklyRule.closeTime)

    if (daysAhead === 0) {
      if (nowMinutes >= openMin && nowMinutes < closeMin) return 0
      if (nowMinutes < openMin) {
        return Math.max(0, localTimeToUtc(dateStr, weeklyRule.openTime, tz).getTime() - Date.now())
      }
      continue // past closeTime — try tomorrow
    }

    return Math.max(0, localTimeToUtc(dateStr, weeklyRule.openTime, tz).getTime() - Date.now())
  }

  return null
}
