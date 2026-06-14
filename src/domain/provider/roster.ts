import { and, eq, isNull, ilike } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { identities, providerAssignments, serviceTypes, availability } from '../../db/schema.js'

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
