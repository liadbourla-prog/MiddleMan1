/**
 * WL-2 — Join resolution + insert (Path A — JOIN).
 *
 * Domain module that puts a customer onto the waitlist for a single concrete, full slot.
 * Two ways in (prompted offer, explicit "add me") converge on this one code path. It does
 * DB work (model: `freed-slot.ts`) but never sends messages and never phrases customer text
 * — it returns a typed result the flow layer phrases later (in the customer's language,
 * voice-compliant).
 *
 * Logic (plan §3.1, all LOCKED):
 *  1. Name-capture gate — no displayName ⇒ `needs_name`, no insert (flow captures, re-calls).
 *  2. Fresh-spine capacity re-check — if the slot has space now, route to normal booking
 *     (`slot_has_space`); only insert when it is genuinely full.
 *  3. Idempotent insert — ON CONFLICT (businessId, slotStart, customerId) DO NOTHING. A row
 *     ⇒ `joined`; a conflict ⇒ `already_on_list` (no duplicate audit).
 *  4. Position — 1-based FIFO place among `pending` entries for the slot (informational; Q3).
 *  5. Audit `waitlist.joined` on a fresh join only.
 *
 * No schema change (the table already has every column).
 */
import { and, asc, eq } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { identities, waitlist } from '../../db/schema.js'
import { revalidateWaitlistSlotOpen } from '../../workers/waitlist-revalidate.js'
import { logAudit } from '../audit/logger.js'

export type JoinWaitlistResult =
  | { kind: 'joined'; waitlistId: string; position: number }
  | { kind: 'already_on_list'; waitlistId: string; position: number }
  | { kind: 'slot_has_space' }
  | { kind: 'needs_name' }

export async function joinWaitlist(
  db: Db,
  params: {
    businessId: string
    customerId: string
    serviceTypeId: string
    slotStart: Date
    slotEnd: Date
  },
): Promise<JoinWaitlistResult> {
  const { businessId, customerId, serviceTypeId, slotStart, slotEnd } = params

  // 1. Name-capture gate. The owner needs a name; if we don't have one yet, the flow
  //    captures it and re-calls. Do NOT insert.
  const [identity] = await db
    .select({ displayName: identities.displayName })
    .from(identities)
    .where(eq(identities.id, customerId))
    .limit(1)

  if (!identity || identity.displayName == null || identity.displayName.trim() === '') {
    return { kind: 'needs_name' }
  }

  // 2. Fresh-spine capacity re-check. revalidateWaitlistSlotOpen returns true when the slot
  //    still has space (OPEN) — in that case route to normal booking, not the waitlist.
  const stillOpen = await revalidateWaitlistSlotOpen(db, businessId, serviceTypeId, slotStart)
  if (stillOpen) {
    return { kind: 'slot_has_space' }
  }

  // 3. Idempotent insert. A repeat "add me" is a no-op (onConflictDoNothing on the unique
  //    index columns), and we report the customer is already on the list.
  const inserted = await db
    .insert(waitlist)
    .values({ businessId, serviceTypeId, slotStart, slotEnd, customerId, status: 'pending' })
    .onConflictDoNothing({ target: [waitlist.businessId, waitlist.slotStart, waitlist.customerId] })
    .returning({ id: waitlist.id })

  if (inserted.length === 0) {
    // Conflict — the customer is already on this slot's list. Find their existing pending
    // row and report position; NO duplicate audit.
    const [existing] = await db
      .select({ id: waitlist.id })
      .from(waitlist)
      .where(
        and(
          eq(waitlist.businessId, businessId),
          eq(waitlist.slotStart, slotStart),
          eq(waitlist.customerId, customerId),
          eq(waitlist.status, 'pending'),
        ),
      )
      .limit(1)

    const waitlistId = existing?.id ?? ''
    const position = await computePosition(db, businessId, serviceTypeId, slotStart, waitlistId)
    return { kind: 'already_on_list', waitlistId, position }
  }

  const waitlistId = inserted[0]!.id
  const position = await computePosition(db, businessId, serviceTypeId, slotStart, waitlistId)

  // 5. Audit on a fresh join only.
  await logAudit(db, {
    businessId,
    actorId: customerId,
    action: 'waitlist.joined',
    entityType: 'waitlist',
    entityId: waitlistId,
    metadata: { serviceTypeId, slotStart },
  })

  return { kind: 'joined', waitlistId, position }
}

/**
 * 1-based FIFO place of `waitlistId` among the `pending` entries for (businessId,
 * serviceTypeId, slotStart), ordered by createdAt asc. Position is informational (Q3 — we
 * tell the customer their place but never promise it stays fixed; priority tiering may move
 * them up later). Falls back to 0 if the row can't be located.
 */
async function computePosition(
  db: Db,
  businessId: string,
  serviceTypeId: string,
  slotStart: Date,
  waitlistId: string,
): Promise<number> {
  const pending = await db
    .select({ id: waitlist.id })
    .from(waitlist)
    .where(
      and(
        eq(waitlist.businessId, businessId),
        eq(waitlist.serviceTypeId, serviceTypeId),
        eq(waitlist.slotStart, slotStart),
        eq(waitlist.status, 'pending'),
      ),
    )
    .orderBy(asc(waitlist.createdAt))

  const idx = pending.findIndex((r) => r.id === waitlistId)
  return idx === -1 ? 0 : idx + 1
}
