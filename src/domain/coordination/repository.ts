import { and, eq, inArray, lt } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { meetingCoordinations, identities } from '../../db/schema.js'
import type { CoordinationStatus, Slot } from './types.js'

const ACTIVE = ['awaiting_counterparty', 'countered', 'awaiting_owner_confirm'] as const

export interface CoordinationRow {
  id: string
  businessId: string
  ownerId: string
  contactId: string
  title: string
  durationMinutes: number
  candidateSlots: Slot[]
  status: CoordinationStatus
  agreedSlotStart: Date | null
  agreedSlotEnd: Date | null
  expiresAt: Date
}

function hydrate(row: typeof meetingCoordinations.$inferSelect): CoordinationRow {
  const raw = (row.candidateSlots as Array<{ start: string; end: string }>)
  return {
    id: row.id, businessId: row.businessId, ownerId: row.ownerId, contactId: row.contactId,
    title: row.title, durationMinutes: row.durationMinutes,
    candidateSlots: raw.map((s) => ({ start: new Date(s.start), end: new Date(s.end) })),
    status: row.status as CoordinationStatus,
    agreedSlotStart: row.agreedSlotStart, agreedSlotEnd: row.agreedSlotEnd, expiresAt: row.expiresAt,
  }
}

export async function insertCoordination(db: Db, input: {
  businessId: string; ownerId: string; contactId: string; title: string;
  durationMinutes: number; candidateSlots: Slot[]; expiresAt: Date
}): Promise<string> {
  const [row] = await db.insert(meetingCoordinations).values({
    businessId: input.businessId, ownerId: input.ownerId, contactId: input.contactId,
    title: input.title, durationMinutes: input.durationMinutes,
    candidateSlots: input.candidateSlots.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })),
    status: 'awaiting_counterparty', expiresAt: input.expiresAt,
  }).returning({ id: meetingCoordinations.id })
  return row!.id
}

export async function findActiveByContact(db: Db, businessId: string, contactId: string): Promise<CoordinationRow | null> {
  const [row] = await db.select().from(meetingCoordinations)
    .where(and(
      eq(meetingCoordinations.businessId, businessId),
      eq(meetingCoordinations.contactId, contactId),
      inArray(meetingCoordinations.status, ACTIVE as unknown as CoordinationStatus[]),
    )).limit(1)
  return row ? hydrate(row) : null
}

export async function findActiveByBusiness(db: Db, businessId: string): Promise<CoordinationRow[]> {
  const rows = await db.select().from(meetingCoordinations)
    .where(and(
      eq(meetingCoordinations.businessId, businessId),
      inArray(meetingCoordinations.status, ACTIVE as unknown as CoordinationStatus[]),
    ))
  return rows.map(hydrate)
}

export async function findById(db: Db, businessId: string, id: string): Promise<CoordinationRow | null> {
  const [row] = await db.select().from(meetingCoordinations)
    .where(and(eq(meetingCoordinations.businessId, businessId), eq(meetingCoordinations.id, id))).limit(1)
  return row ? hydrate(row) : null
}

export async function updateCoordination(db: Db, id: string, patch: {
  status: CoordinationStatus; agreedSlot?: Slot; counterSlot?: Slot; candidateSlots?: Slot[]; calendarEventId?: string; googleEtag?: string | null
}): Promise<void> {
  await db.update(meetingCoordinations).set({
    status: patch.status,
    ...(patch.agreedSlot ? { agreedSlotStart: patch.agreedSlot.start, agreedSlotEnd: patch.agreedSlot.end } : {}),
    ...(patch.counterSlot ? { counterSlotStart: patch.counterSlot.start, counterSlotEnd: patch.counterSlot.end } : {}),
    ...(patch.candidateSlots ? { candidateSlots: patch.candidateSlots.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })) } : {}),
    ...(patch.calendarEventId !== undefined ? { calendarEventId: patch.calendarEventId } : {}),
    ...(patch.googleEtag !== undefined ? { googleEtag: patch.googleEtag } : {}),
    updatedAt: new Date(),
  }).where(eq(meetingCoordinations.id, id))
}

export async function getIdentityContact(db: Db, identityId: string): Promise<{ phone: string | null; name: string | null }> {
  const [row] = await db.select({ phone: identities.phoneNumber, name: identities.displayName })
    .from(identities).where(eq(identities.id, identityId)).limit(1)
  return { phone: row?.phone ?? null, name: row?.name ?? null }
}

export async function findExpired(db: Db, now: Date): Promise<CoordinationRow[]> {
  const rows = await db.select().from(meetingCoordinations)
    .where(and(
      inArray(meetingCoordinations.status, ['awaiting_counterparty', 'countered'] as unknown as CoordinationStatus[]),
      lt(meetingCoordinations.expiresAt, now),
    ))
  return rows.map(hydrate)
}
