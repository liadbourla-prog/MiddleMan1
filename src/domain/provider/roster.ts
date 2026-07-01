import { and, eq, isNull, ilike, gte, lte } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { identities, providerAssignments, serviceTypes, availability, calendarBlocks } from '../../db/schema.js'
import { localParts } from '../availability/compute.js'

export interface InstructorWeeklyHours { dayOfWeek: number; startTime: string; endTime: string }
export interface InstructorRosterEntry { id: string; name: string; services: string[]; weeklyHours: InstructorWeeklyHours[] }

function normTime(t: string | null): string { return (t ?? '').slice(0, 5) } // 'HH:MM:SS' → 'HH:MM'

async function weeklyHoursFor(db: Db, providerId: string): Promise<InstructorWeeklyHours[]> {
  const rows = await db.select({
    dayOfWeek: availability.dayOfWeek, openTime: availability.openTime, closeTime: availability.closeTime,
  }).from(availability).where(and(
    eq(availability.providerId, providerId), isNull(availability.specificDate), eq(availability.isBlocked, false),
  ))
  return rows
    .filter((r) => r.dayOfWeek !== null && r.openTime && r.closeTime)
    .map((r) => ({ dayOfWeek: r.dayOfWeek as number, startTime: normTime(r.openTime), endTime: normTime(r.closeTime) }))
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek)
}

/** Full instructor roster for a business (active providers + their active services + weekly hours). */
export async function loadInstructorRoster(db: Db, businessId: string): Promise<InstructorRosterEntry[]> {
  const provs = await db.select({ id: identities.id, name: identities.displayName }).from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.role, 'provider'), isNull(identities.revokedAt)))

  const out: InstructorRosterEntry[] = []
  for (const prov of provs) {
    const svc = await db.select({ name: serviceTypes.name }).from(providerAssignments)
      .innerJoin(serviceTypes, eq(providerAssignments.serviceTypeId, serviceTypes.id))
      .where(and(eq(providerAssignments.identityId, prov.id), eq(providerAssignments.isActive, true)))
    out.push({
      id: prov.id, name: prov.name ?? '',
      services: svc.map((s) => s.name),
      weeklyHours: await weeklyHoursFor(db, prov.id),
    })
  }
  return out
}

/** For the customer-side reactive fallback: an instructor assigned to a service, matched by name hint. */
export async function getInstructorHours(
  db: Db, businessId: string, serviceTypeId: string, nameHint: string,
): Promise<{ name: string; weeklyHours: InstructorWeeklyHours[] } | null> {
  const [row] = await db.select({ id: identities.id, name: identities.displayName }).from(providerAssignments)
    .innerJoin(identities, eq(providerAssignments.identityId, identities.id))
    .where(and(
      eq(providerAssignments.businessId, businessId),
      eq(providerAssignments.serviceTypeId, serviceTypeId),
      eq(providerAssignments.isActive, true),
      isNull(identities.revokedAt),
      ilike(identities.displayName, `%${nameHint}%`),
    )).limit(1)
  if (!row) return null
  return { name: row.name ?? nameHint, weeklyHours: await weeklyHoursFor(db, row.id) }
}

/** Render the roster for the manager orchestrator system prompt. Empty roster → ''. */
export function buildInstructorRosterBlock(roster: InstructorRosterEntry[], lang: 'he' | 'en'): string {
  if (roster.length === 0) return ''
  const days = lang === 'he'
    ? ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש']
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const lines = ['Instructors (for your reference — do not volunteer to customers):']
  for (const e of roster) {
    const svc = e.services.join(', ') || '—'
    const hrs = e.weeklyHours.length
      ? e.weeklyHours.map((h) => `${days[h.dayOfWeek]} ${h.startTime}–${h.endTime}`).join(', ')
      : 'no hours set'
    lines.push(`- ${e.name}: ${svc} (${hrs})`)
  }
  return lines.join('\n')
}

// providerId/instructor are nullable: an owner-imported class (source='google_import',
// T1.5/R4) has no assigned instructor yet. It is still listed — the missing instructor is
// surfaced honestly as "instructor TBD", never fabricated (G6-safe).
export interface TeachingSlot { providerId: string | null; instructor: string | null; service: string; dayOfWeek: number; startTime: string }

/**
 * Derive "who teaches what" from the upcoming scheduled class blocks
 * (calendar_blocks type='class' with a providerId) over the next `horizonDays`.
 * This is the live source for the instructor FAQ — it reflects the actual
 * week-to-week schedule, not a typed-once paragraph. A class with no linked service is
 * skipped; a class with no assigned instructor (an owner-imported class, providerId=null)
 * is KEPT via a LEFT JOIN and surfaced as "instructor TBD" (T1.5/R4) — the old INNER JOIN
 * silently dropped it.
 */
export async function loadTeachingSchedule(
  db: Db,
  businessId: string,
  timezone: string,
  horizonDays = 7,
  now: Date = new Date(),
): Promise<TeachingSlot[]> {
  const to = new Date(now.getTime() + horizonDays * 86_400_000)
  const rows = await db
    .select({
      providerId: calendarBlocks.providerId,
      instructor: identities.displayName,
      service: serviceTypes.name,
      startTs: calendarBlocks.startTs,
    })
    .from(calendarBlocks)
    .leftJoin(identities, eq(calendarBlocks.providerId, identities.id))
    .innerJoin(serviceTypes, eq(calendarBlocks.serviceTypeId, serviceTypes.id))
    .where(and(
      eq(calendarBlocks.businessId, businessId),
      eq(calendarBlocks.type, 'class'),
      gte(calendarBlocks.startTs, now),
      lte(calendarBlocks.startTs, to),
    ))

  // Dedup to one row per (provider, service, weekday, start-time) so a manager
  // sees "Dana — Yoga Mon 10:00" once even across multiple weeks in the horizon.
  const seen = new Set<string>()
  const out: TeachingSlot[] = []
  for (const r of rows) {
    // Only a linked service is required. A null providerId/instructor (owner-imported class)
    // is KEPT and rendered as "instructor TBD" — never dropped, never given a fabricated name.
    if (!r.service) continue
    const lp = localParts(r.startTs, timezone)
    const startTime = `${String(Math.floor(lp.minutes / 60)).padStart(2, '0')}:${String(lp.minutes % 60).padStart(2, '0')}`
    const key = `${r.providerId ?? 'tbd'}|${r.service}|${lp.dayOfWeek}|${startTime}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ providerId: r.providerId, instructor: r.instructor, service: r.service, dayOfWeek: lp.dayOfWeek, startTime })
  }
  return out
}

/**
 * Render the derived teaching schedule for a system prompt, grouped by
 * instructor. Pure (no DB/clock). Empty input → ''.
 */
export function buildTeachingScheduleBlock(slots: TeachingSlot[], lang: 'he' | 'en'): string {
  if (slots.length === 0) return ''
  const days = lang === 'he'
    ? ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש']
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  // A null instructor (owner-imported class, T1.5) renders as a localized "instructor TBD"
  // — the class is still listed, the missing instructor stated honestly (never fabricated).
  const tbd = lang === 'he' ? 'מדריך/ה טרם נקבע' : 'instructor TBD'
  const byInstructor = new Map<string, TeachingSlot[]>()
  for (const s of slots) {
    const who = s.instructor ?? tbd
    const arr = byInstructor.get(who) ?? []
    arr.push(s)
    byInstructor.set(who, arr)
  }
  const lines = ['Upcoming classes by instructor (live; answer on demand, do not volunteer to customers):']
  for (const [instructor, list] of byInstructor) {
    list.sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime))
    const parts = list.map((s) => `${s.service} ${days[s.dayOfWeek]} ${s.startTime}`)
    lines.push(`- ${instructor}: ${parts.join(', ')}`)
  }
  return lines.join('\n')
}
