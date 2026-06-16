/**
 * Repository for `calendar_blocks` — the single home for manager-occupied time:
 * intra-day blocks, personal events, and proactively-scheduled group sessions.
 *
 * This is the write/read counterpart to the read-only availability compute core.
 * Every branch that creates "busy time" that is NOT a customer booking goes
 * through here, so internal-mode managers never silently lose data (the bug this
 * fixes — see CALENDAR_UX_DESIGN.md §4). Outbound Google mirroring of these rows
 * is Phase 2; this module only owns the internal source of truth.
 */

import { and, asc, eq, gte, lte } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { calendarBlocks } from '../../db/schema.js'
import type { CalendarBlock, CalendarBlockType } from '../../db/schema.js'

// Read-back ids for calendar_blocks are prefixed so the orchestrator can tell a
// block apart from a Google event id when the manager asks to delete one.
export const BLOCK_ID_PREFIX = 'block:'

export interface CreateBlockInput {
  businessId: string
  type: CalendarBlockType
  start: Date
  end: Date
  title?: string | null
  reason?: string | null
  serviceTypeId?: string | null
  maxParticipants?: number | null
  providerId?: string | null
  googleEventId?: string | null
  googleEtag?: string | null
  source?: 'internal' | 'google_import'
}

/** Insert a calendar block and return the created row. */
export async function createBlock(db: Db, input: CreateBlockInput): Promise<CalendarBlock> {
  const [row] = await db
    .insert(calendarBlocks)
    .values({
      businessId: input.businessId,
      type: input.type,
      startTs: input.start,
      endTs: input.end,
      title: input.title ?? null,
      reason: input.reason ?? null,
      serviceTypeId: input.serviceTypeId ?? null,
      maxParticipants: input.maxParticipants ?? null,
      providerId: input.providerId ?? null,
      googleEventId: input.googleEventId ?? null,
      googleEtag: input.googleEtag ?? null,
      source: input.source ?? 'internal',
    })
    .returning()
  if (!row) throw new Error('Failed to insert calendar block')
  return row
}

/** Fetch blocks overlapping [from, to] for a business, ordered by start. */
export async function listBlocksInRange(
  db: Db,
  businessId: string,
  from: Date,
  to: Date,
): Promise<CalendarBlock[]> {
  // overlap: block.start <= to AND block.end >= from
  return db
    .select()
    .from(calendarBlocks)
    .where(
      and(
        eq(calendarBlocks.businessId, businessId),
        lte(calendarBlocks.startTs, to),
        gte(calendarBlocks.endTs, from),
      ),
    )
    .orderBy(asc(calendarBlocks.startTs))
}

/**
 * Delete a block by its bare UUID (no prefix). Returns the deleted row's id and
 * Google linkage (so the caller can enqueue a mirror deletion), or null if no
 * row matched.
 */
export async function deleteBlockById(
  db: Db,
  businessId: string,
  blockId: string,
): Promise<{ id: string; googleEventId: string | null } | null> {
  const [deleted] = await db
    .delete(calendarBlocks)
    .where(and(eq(calendarBlocks.businessId, businessId), eq(calendarBlocks.id, blockId)))
    .returning({ id: calendarBlocks.id, googleEventId: calendarBlocks.googleEventId })
  return deleted ?? null
}

/** Strip the read-back prefix from a block event id, if present. */
export function parseBlockId(eventId: string): string | null {
  return eventId.startsWith(BLOCK_ID_PREFIX) ? eventId.slice(BLOCK_ID_PREFIX.length) : null
}

/**
 * Find the instructor (providerId) of the scheduled class for a slot.
 *
 * Group bookings link to a class slot by (serviceTypeId, slotStart). The class
 * block placed by scheduleGroupSession / the series materializer is the SoT for
 * who teaches that slot, so a booking into the class inherits its providerId.
 * Returns:
 *  - { found: true, providerId } when a matching class block exists (providerId
 *    may still be null if the manager scheduled it without an instructor)
 *  - { found: false } when there is no class block for the slot.
 */
export async function findClassBlockProviderForSlot(
  db: Db,
  businessId: string,
  serviceTypeId: string,
  slotStart: Date,
): Promise<{ found: true; providerId: string | null } | { found: false }> {
  const [row] = await db
    .select({ providerId: calendarBlocks.providerId })
    .from(calendarBlocks)
    .where(and(
      eq(calendarBlocks.businessId, businessId),
      eq(calendarBlocks.type, 'class'),
      eq(calendarBlocks.serviceTypeId, serviceTypeId),
      eq(calendarBlocks.startTs, slotStart),
    ))
    .limit(1)
  if (!row) return { found: false }
  return { found: true, providerId: row.providerId }
}

/** A human-facing label for a block row, used in calendar read-back. */
export function blockLabel(block: CalendarBlock, lang: 'he' | 'en'): string {
  if (block.title) return block.title
  switch (block.type) {
    case 'class':
      return lang === 'he' ? 'שיעור קבוצתי' : 'Group class'
    case 'personal':
      return lang === 'he' ? 'אירוע אישי' : 'Personal event'
    case 'block':
    default:
      return lang === 'he' ? 'זמן חסום' : 'Blocked time'
  }
}
