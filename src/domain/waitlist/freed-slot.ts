import { and, eq, asc } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { businesses, identities, serviceTypes, waitlist, freedSlotApprovals } from '../../db/schema.js'
import { triggerWaitlistForSlot } from '../../workers/waitlist.js'
import { enqueueMessage } from '../../workers/message-retry.js'
import { logAudit } from '../audit/logger.js'
import { i18n, type Lang } from '../i18n/t.js'
import { decideFreedSlotAction } from './freed-slot-policy.js'

export interface FreedSlot {
  businessId: string
  serviceTypeId: string
  slotStart: Date
  slotEnd: Date
  /** The cancelled booking that freed the slot (provenance / dedup). */
  sourceBookingId?: string
}

/**
 * Decide what to do with a slot that a cancellation just freed, honouring the owner's
 * standing preference (WS-C / #6 / #8). Replaces the old unconditional auto-fire in
 * `cancelBooking`:
 *   - no one waiting        → nothing
 *   - policy 'auto'         → offer immediately (legacy behaviour, now opt-in)
 *   - policy 'never'        → suppress (audit only)
 *   - policy 'ask' / unset  → hold the slot, ask the owner (first time: also offer to
 *                             make it automatic), and persist a pending approval.
 *
 * Best-effort and self-contained: any failure here must never fail the cancellation that
 * triggered it (the caller fires-and-forgets).
 */
export async function handleFreedSlot(db: Db, slot: FreedSlot): Promise<void> {
  // Only act if at least one customer is actually waiting for this exact slot.
  const waiting = await db
    .select({ id: waitlist.id })
    .from(waitlist)
    .where(
      and(
        eq(waitlist.businessId, slot.businessId),
        eq(waitlist.serviceTypeId, slot.serviceTypeId),
        eq(waitlist.slotStart, slot.slotStart),
        eq(waitlist.status, 'pending'),
      ),
    )

  if (waiting.length === 0) return // nobody waiting — nothing to offer or ask about

  const [business] = await db
    .select({
      freedSlotOfferPolicy: businesses.freedSlotOfferPolicy,
      name: businesses.name,
      timezone: businesses.timezone,
      defaultLanguage: businesses.defaultLanguage,
    })
    .from(businesses)
    .where(eq(businesses.id, slot.businessId))
    .limit(1)

  if (!business) return

  const decision = decideFreedSlotAction(business.freedSlotOfferPolicy ?? null)

  if (decision.kind === 'offer') {
    await triggerWaitlistForSlot(slot.businessId, slot.serviceTypeId, slot.slotStart, slot.slotEnd)
    await logAudit(db, {
      businessId: slot.businessId,
      actorId: null,
      action: 'waitlist.offer_auto',
      entityType: 'booking',
      ...(slot.sourceBookingId ? { entityId: slot.sourceBookingId } : {}),
      metadata: { slotStart: slot.slotStart.toISOString(), waiting: waiting.length, policy: 'auto' },
    }).catch(() => { /* best-effort */ })
    return
  }

  if (decision.kind === 'suppress') {
    await logAudit(db, {
      businessId: slot.businessId,
      actorId: null,
      action: 'waitlist.offer_suppressed',
      entityType: 'booking',
      ...(slot.sourceBookingId ? { entityId: slot.sourceBookingId } : {}),
      metadata: { slotStart: slot.slotStart.toISOString(), waiting: waiting.length, policy: 'never' },
    }).catch(() => { /* best-effort */ })
    return
  }

  // decision.kind === 'ask' — persist a pending approval and notify the owner.
  // Expire at the slot itself: there is no point offering a slot that has already passed.
  await db.insert(freedSlotApprovals).values({
    businessId: slot.businessId,
    serviceTypeId: slot.serviceTypeId,
    slotStart: slot.slotStart,
    slotEnd: slot.slotEnd,
    sourceBookingId: slot.sourceBookingId ?? null,
    candidateCount: waiting.length,
    status: 'pending',
    expiresAt: slot.slotStart,
  })

  await logAudit(db, {
    businessId: slot.businessId,
    actorId: null,
    action: 'waitlist.offer_pending_approval',
    entityType: 'booking',
    ...(slot.sourceBookingId ? { entityId: slot.sourceBookingId } : {}),
    metadata: { slotStart: slot.slotStart.toISOString(), waiting: waiting.length, firstTime: decision.firstTime },
  }).catch(() => { /* best-effort */ })

  // Notify the owner in the business (manager) language.
  const [manager] = await db
    .select({ phoneNumber: identities.phoneNumber })
    .from(identities)
    .where(and(eq(identities.businessId, slot.businessId), eq(identities.role, 'manager')))
    .orderBy(asc(identities.createdAt))
    .limit(1)

  if (!manager) return

  const [service] = await db
    .select({ name: serviceTypes.name })
    .from(serviceTypes)
    .where(eq(serviceTypes.id, slot.serviceTypeId))
    .limit(1)

  const lang: Lang = (business.defaultLanguage as Lang | null | undefined) ?? 'he'
  const locale = lang === 'he' ? 'he-IL' : 'en-GB'
  const dateStr = new Intl.DateTimeFormat(locale, {
    timeZone: business.timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(slot.slotStart)
  const serviceName = service?.name ?? (lang === 'he' ? 'תור' : 'appointment')

  const body = decision.firstTime
    ? i18n.freed_slot_ask_first_time[lang](serviceName, dateStr, waiting.length)
    : i18n.freed_slot_ask[lang](serviceName, dateStr, waiting.length)

  await enqueueMessage(manager.phoneNumber, body).catch(() => { /* retry queue handles failures */ })
}
