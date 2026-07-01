/**
 * T1.3 — pending-imported-class state machine (occupy-and-ASK).
 *
 * An UNCERTAIN owner-added class is occupied by an opaque `type='block'` row that
 * carries a pending-class marker (source='google_import' + serviceTypeId set). It
 * occupies the slot — so the PA never says "free"/"nothing there" — but is NOT bookable
 * (findClassBlockProviderForSlot requires type='class'). It becomes a real class ONLY
 * when the owner confirms.
 *
 * This module owns that lifecycle's three moves:
 *  - detect a pending class occupying a slot (customer read),
 *  - relay a waiting customer's interest to the owner (reusing the pending_owner_questions
 *    spine, linked to the block), returning the honest "let me confirm with the studio" reply,
 *  - confirm: flip block→class (now bookable) and re-notify every waiting customer.
 *
 * Every customer-facing string is a code template (Gate-4 owns phrasing) — no new LLM
 * authority. Occupancy is always counted internally; nothing here trusts a Google head-count.
 */

import { and, eq, gte, isNull, lt } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { businesses, calendarBlocks, identities, pendingOwnerQuestions, serviceTypes, type Business } from '../../db/schema.js'
import { enqueueMessage } from '../../workers/message-retry.js'
import { dispatchInitiation } from '../initiations/dispatch.js'
import { getInitiator } from '../initiations/registry.js'
import { i18n, type Lang } from '../i18n/t.js'

export interface PendingImportedClass {
  id: string
  serviceTypeId: string
  startTs: Date
  endTs: Date
  maxParticipants: number | null
}

/**
 * Is `slotStart` occupied by a pending (not-yet-confirmed) imported class for this
 * service? A pending class is an opaque `type='block'` row that carries the marker
 * (source='google_import' + matching serviceTypeId). Returns it, or null.
 */
export async function findPendingImportedClassForSlot(
  db: Db,
  businessId: string,
  serviceTypeId: string,
  slotStart: Date,
): Promise<PendingImportedClass | null> {
  const [row] = await db
    .select({
      id: calendarBlocks.id,
      serviceTypeId: calendarBlocks.serviceTypeId,
      startTs: calendarBlocks.startTs,
      endTs: calendarBlocks.endTs,
      maxParticipants: calendarBlocks.maxParticipants,
    })
    .from(calendarBlocks)
    .where(and(
      eq(calendarBlocks.businessId, businessId),
      eq(calendarBlocks.type, 'block'),
      eq(calendarBlocks.source, 'google_import'),
      eq(calendarBlocks.serviceTypeId, serviceTypeId),
      eq(calendarBlocks.startTs, slotStart),
    ))
    .limit(1)
  if (!row || !row.serviceTypeId) return null
  return {
    id: row.id as string,
    serviceTypeId: row.serviceTypeId as string,
    startTs: row.startTs as Date,
    endTs: row.endTs as Date,
    maxParticipants: (row.maxParticipants as number | null) ?? null,
  }
}

/**
 * Finding 3: the pending imported classes that START inside a day window, optionally narrowed
 * to a named service. Used to surface a pending class on a DAY / any-time inquiry ("any Pilates
 * Sunday?") — not only on a specific-time ask — so the day never reads as empty when a tentative
 * class exists. These stay opaque type='block' rows (occupy-and-ask) and are surfaced as
 * "tentative — confirming with the studio", NEVER as bookable. Occupancy is internal; nothing
 * here trusts a Google head-count.
 */
export async function findPendingImportedClassesForDay(
  db: Db,
  businessId: string,
  from: Date,
  to: Date,
  serviceTypeId?: string,
): Promise<PendingImportedClass[]> {
  const conds = [
    eq(calendarBlocks.businessId, businessId),
    eq(calendarBlocks.type, 'block'),
    eq(calendarBlocks.source, 'google_import'),
    gte(calendarBlocks.startTs, from),
    lt(calendarBlocks.startTs, to),
  ]
  if (serviceTypeId) conds.push(eq(calendarBlocks.serviceTypeId, serviceTypeId))
  const rows = await db
    .select({
      id: calendarBlocks.id,
      serviceTypeId: calendarBlocks.serviceTypeId,
      startTs: calendarBlocks.startTs,
      endTs: calendarBlocks.endTs,
      maxParticipants: calendarBlocks.maxParticipants,
    })
    .from(calendarBlocks)
    .where(and(...conds))
  // A plain opaque block (no serviceTypeId marker) is NOT a pending class — drop it.
  return rows
    .filter((r): r is typeof r & { serviceTypeId: string } => r.serviceTypeId != null)
    .map((r) => ({
      id: r.id as string,
      serviceTypeId: r.serviceTypeId,
      startTs: r.startTs as Date,
      endTs: r.endTs as Date,
      maxParticipants: (r.maxParticipants as number | null) ?? null,
    }))
}

/**
 * Customer path (test b): a customer asked about a pending imported class. Record their
 * interest as a pending_owner_question LINKED to the block (relatedBlockId), ping the
 * owner to confirm, and return the honest "let me confirm with the studio" reply. Reuses
 * the existing relay spine; the linkage lets confirmImportedClass re-notify this exact
 * customer when the owner opens the class. Best-effort — a notify hiccup never throws into
 * the reply path (the row persists so the owner can still confirm).
 */
export async function relayPendingClassToOwner(
  db: Db,
  business: Business,
  customer: { id: string; phoneNumber: string },
  block: PendingImportedClass,
  serviceName: string,
  customerLang: Lang = 'he',
): Promise<{ customerReply: string; escalated: boolean }> {
  // The honest customer reply stands regardless — the slot is genuinely occupied by a
  // class we haven't confirmed open. If we can reach the owner we ALSO relay + link, so
  // this customer is re-notified when the owner opens it.
  const customerReply = i18n.class_pending_studio_confirm[customerLang](serviceName)

  const [manager] = await db
    .select({ id: identities.id, phoneNumber: identities.phoneNumber })
    .from(identities)
    .where(and(eq(identities.businessId, business.id), eq(identities.role, 'manager'), isNull(identities.revokedAt)))
    .limit(1)
  if (!manager) return { customerReply, escalated: false }

  // Dedup: this customer already has an open question — don't re-ping on a rephrase.
  const existing = await db
    .select({ id: pendingOwnerQuestions.id })
    .from(pendingOwnerQuestions)
    .where(and(eq(pendingOwnerQuestions.businessId, business.id), eq(pendingOwnerQuestions.customerId, customer.id), eq(pendingOwnerQuestions.status, 'pending')))
    .limit(1)
  if (existing.length > 0) return { customerReply, escalated: true }

  const questionText = `Customer asked about ${serviceName} at ${block.startTs.toISOString()} (pending imported class ${block.id})`.slice(0, 1000)
  const [row] = await db
    .insert(pendingOwnerQuestions)
    .values({
      businessId: business.id,
      customerId: customer.id,
      customerPhone: customer.phoneNumber,
      questionText,
      status: 'pending',
      askedManagerId: manager.id,
      relatedBlockId: block.id,
    })
    .returning({ id: pendingOwnerQuestions.id })
  if (!row) return { customerReply, escalated: false }

  const managerLang: Lang = (business.defaultLanguage as Lang | null | undefined) ?? 'he'
  const managerMessage = i18n.calendar_owner_class_confirm[managerLang](serviceName, block.startTs.toISOString())
  await dispatchInitiation(db, getInitiator('question.relay'), {
    businessId: business.id,
    recipientId: manager.id,
    dedupKey: `question.relay:${row.id}`,
  }, {
    sendFreeForm: async () => { await enqueueMessage(business.id, manager.phoneNumber, managerMessage).catch(() => {}) },
  }).catch(() => { /* non-fatal: the row persists so the owner can still confirm */ })

  return { customerReply, escalated: true }
}

/**
 * Owner confirms (test f): open a pending imported class. Flips the opaque pending block
 * to a bookable `type='class'` (CAS: only when it is still a pending google_import block),
 * then re-notifies every customer who was waiting on it (via the linked pending_owner_questions
 * rows) with the re-engage template and resolves those rows to 'answered'. Idempotent — a
 * second confirm flips nothing and notifies nobody.
 */
export async function confirmImportedClass(
  db: Db,
  businessId: string,
  blockId: string,
): Promise<{ opened: boolean; notifiedCustomers: number }> {
  // CAS flip: only a still-pending google_import block opens. RETURNING tells us if it did.
  const flipped = await db
    .update(calendarBlocks)
    .set({ type: 'class', updatedAt: new Date() })
    .where(and(
      eq(calendarBlocks.id, blockId),
      eq(calendarBlocks.businessId, businessId),
      eq(calendarBlocks.type, 'block'),
      eq(calendarBlocks.source, 'google_import'),
    ))
    .returning({ id: calendarBlocks.id, serviceTypeId: calendarBlocks.serviceTypeId, startTs: calendarBlocks.startTs })
  const opened = flipped[0]
  if (!opened) return { opened: false, notifiedCustomers: 0 }

  // Display context for the re-engage message.
  const [business] = await db
    .select({ timezone: businesses.timezone, defaultLanguage: businesses.defaultLanguage })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)
  const lang: Lang = (business?.defaultLanguage as Lang | null | undefined) ?? 'he'
  const timezone = (business?.timezone as string | undefined) ?? 'UTC'
  let serviceName = 'class'
  if (opened.serviceTypeId) {
    const [svc] = await db
      .select({ name: serviceTypes.name })
      .from(serviceTypes)
      .where(eq(serviceTypes.id, opened.serviceTypeId as string))
      .limit(1)
    if (svc?.name) serviceName = svc.name as string
  }
  const when = formatWhen(opened.startTs as Date, timezone, lang)

  // Re-notify every customer who was waiting on THIS block.
  const waiting = await db
    .select({ id: pendingOwnerQuestions.id, customerPhone: pendingOwnerQuestions.customerPhone })
    .from(pendingOwnerQuestions)
    .where(and(
      eq(pendingOwnerQuestions.businessId, businessId),
      eq(pendingOwnerQuestions.relatedBlockId, blockId),
      eq(pendingOwnerQuestions.status, 'pending'),
    ))

  let notified = 0
  for (const q of waiting) {
    await enqueueMessage(businessId, q.customerPhone as string, i18n.class_now_open_reengage[lang](serviceName, when)).catch(() => {})
    await db
      .update(pendingOwnerQuestions)
      .set({ status: 'answered', answeredAt: new Date() })
      .where(eq(pendingOwnerQuestions.id, q.id as string))
    notified += 1
  }

  return { opened: true, notifiedCustomers: notified }
}

/** Business-local "when" (e.g. "Sun 19:00") for the re-engage note — never a raw UTC ISO. */
function formatWhen(start: Date, timezone: string, lang: Lang): string {
  const day = new Intl.DateTimeFormat(lang === 'he' ? 'he-IL' : 'en-US', { timeZone: timezone, weekday: 'short' }).format(start)
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(start)
  return `${day} ${time}`
}
