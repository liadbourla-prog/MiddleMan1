import type { Db } from '../../db/client.js'
import type { CalendarClient } from '../../adapters/calendar/client.js'
import { nextCoordinationState, classifyContactReply } from './state.js'
import { interpretContactReply } from './interpret.js'
import * as repo from './repository.js'
import type { ContactReplyClass, OwnerDecision, Slot } from './types.js'
import { renderBookingEvent } from '../calendar/event-content.js'
import { logAudit } from '../audit/logger.js'
import { sendMessage } from '../../adapters/whatsapp/sender.js'
import { generateProactiveCustomerMessage } from '../../adapters/llm/client.js'
import { i18n, type Lang } from '../i18n/t.js'

const COORDINATION_EXPIRY_HOURS = parseInt(process.env['COORDINATION_EXPIRY_HOURS'] ?? '72', 10)

export interface BusinessCtx {
  businessId: string
  businessName: string
  lang: Lang
  timezone: string
  waCredentials: { accessToken: string; phoneNumberId: string } | undefined
}

function formatSlot(slot: Slot, ctx: BusinessCtx): string {
  const locale = ctx.lang === 'he' ? 'he-IL' : 'en-GB'
  const date = new Intl.DateTimeFormat(locale, { timeZone: ctx.timezone, weekday: 'long', day: 'numeric', month: 'long' }).format(slot.start)
  const time = new Intl.DateTimeFormat(locale, { timeZone: ctx.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(slot.start)
  return `${date} ${time}`
}

function describeCandidates(slots: Slot[], ctx: BusinessCtx): string {
  return slots.map((s) => formatSlot(s, ctx)).join(' / ')
}

async function phraseAndSend(opts: { toNumber: string; situation: string; fallback: string; ctx: BusinessCtx }): Promise<boolean> {
  const body = await generateProactiveCustomerMessage({
    businessName: opts.ctx.businessName,
    language: opts.ctx.lang,
    situation: opts.situation,
    fallback: opts.fallback,
    timeoutMs: 2500,
  })
  const res = await sendMessage({ toNumber: opts.toNumber, body }, opts.ctx.waCredentials)
  return res.ok
}

// Owner asks the PA to coordinate. Contact already registered + slots resolved by the tool.
export async function startCoordination(db: Db, calendar: CalendarClient, input: {
  businessId: string; ownerId: string; contactId: string; contactPhone: string;
  title: string; durationMinutes: number; candidateSlots: Slot[]; ctx: BusinessCtx;
}): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  // Availability guard: keep only candidates the owner's calendar is free for.
  const freeSlots: Slot[] = []
  for (const s of input.candidateSlots) {
    const avail = await calendar.checkAvailability(s)
    if (avail.status === 'available') freeSlots.push(s)
  }
  if (freeSlots.length === 0) return { ok: false, reason: 'no_free_candidates' }

  const expiresAt = new Date(Date.now() + COORDINATION_EXPIRY_HOURS * 3_600_000)
  const id = await repo.insertCoordination(db, {
    businessId: input.businessId, ownerId: input.ownerId, contactId: input.contactId,
    title: input.title, durationMinutes: input.durationMinutes, candidateSlots: freeSlots, expiresAt,
  })

  const times = describeCandidates(freeSlots, input.ctx)
  const sent = await phraseAndSend({
    toNumber: input.contactPhone,
    situation: `You are reaching out on behalf of the business to set up a meeting ("${input.title}"). Offer these times and invite them to pick one or propose another: ${times}.`,
    fallback: i18n.coordination_offer_to_contact[input.ctx.lang](input.ctx.businessName, times),
    ctx: input.ctx,
  })

  await logAudit(db, { businessId: input.businessId, actorId: input.ownerId, action: 'coordination.started', entityType: 'meeting_coordination', entityId: id, metadata: { contactId: input.contactId, sent } })

  if (!sent) return { ok: false, reason: 'contact_unreachable' }
  return { ok: true, id }
}

// Contact replied (inbound route). Interpret, classify, transition, act.
export async function advanceFromContact(db: Db, calendar: CalendarClient, row: repo.CoordinationRow, replyText: string, ctx: BusinessCtx): Promise<void> {
  const intent = await interpretContactReply({
    replyText,
    candidateSummaries: describeCandidates(row.candidateSlots, ctx),
    durationMinutes: row.durationMinutes,
    timezone: ctx.timezone,
    lang: ctx.lang,
  })

  // Unclear → ask the contact one clarifying question; no state change.
  if (intent.kind === 'unclear') {
    const { phone } = await repo.getIdentityContact(db, row.contactId)
    if (phone) {
      const times = describeCandidates(row.candidateSlots, ctx)
      await phraseAndSend({
        toNumber: phone,
        situation: `Their reply about the meeting time was unclear. Ask one short question to clarify which of these works, or what time they prefer: ${times}.`,
        fallback: i18n.coordination_offer_to_contact[ctx.lang](ctx.businessName, times),
        ctx,
      })
    }
    return
  }

  const reply: ContactReplyClass = intent.kind === 'time'
    ? classifyContactReply(intent.slot, row.candidateSlots)
    : { kind: 'decline' }

  const t = nextCoordinationState(row.status, { type: 'contact_reply', reply, candidates: row.candidateSlots })
  await applyTransition(db, calendar, row, t, ctx)
}

// Owner decided (resolveMeetingCoordination tool).
export async function advanceFromOwner(db: Db, calendar: CalendarClient, row: repo.CoordinationRow, decision: OwnerDecision, ctx: BusinessCtx): Promise<void> {
  const agreedSlot = row.agreedSlotStart && row.agreedSlotEnd
    ? { start: row.agreedSlotStart, end: row.agreedSlotEnd }
    : undefined
  const t = nextCoordinationState(row.status, { type: 'owner_decision', decision, candidates: row.candidateSlots, ...(agreedSlot ? { agreedSlot } : {}) })
  await applyTransition(db, calendar, row, t, ctx)
}

type Transition = ReturnType<typeof nextCoordinationState>

async function applyTransition(db: Db, calendar: CalendarClient, row: repo.CoordinationRow, t: Transition, ctx: BusinessCtx): Promise<void> {
  const owner = await repo.getIdentityContact(db, row.ownerId)
  const contact = await repo.getIdentityContact(db, row.contactId)
  const contactName = contact.name ?? contact.phone ?? (ctx.lang === 'he' ? 'איש הקשר' : 'the contact')
  const e = t.effect

  const auditContactReplied = (outcome: string, slot?: Slot) =>
    logAudit(db, { businessId: ctx.businessId, actorId: row.contactId, action: 'coordination.contact_replied', entityType: 'meeting_coordination', entityId: row.id, metadata: { outcome, ...(slot ? { slotStart: slot.start.toISOString() } : {}) } })

  switch (e.kind) {
    case 'ping_owner_confirm': {
      await repo.updateCoordination(db, row.id, { status: t.status, agreedSlot: e.slot })
      const time = formatSlot(e.slot, ctx)
      if (owner.phone) await phraseAndSend({ toNumber: owner.phone, situation: `The contact ${contactName} agreed to meet at ${time} for "${row.title}". Ask the owner to confirm so you can book it.`, fallback: i18n.coordination_confirm_to_owner[ctx.lang](contactName, time), ctx })
      if (contact.phone) await phraseAndSend({ toNumber: contact.phone, situation: `Acknowledge their chosen time softly — you'll confirm with the owner and get back to them. Do NOT say it is booked yet.`, fallback: i18n.coordination_soft_ack_to_contact[ctx.lang](), ctx })
      await auditContactReplied('accepted', e.slot)
      break
    }
    case 'relay_counter_to_owner': {
      // Persist the countered slot as BOTH counter and agreed, so an owner "confirm" books it.
      await repo.updateCoordination(db, row.id, { status: t.status, counterSlot: e.slot, agreedSlot: e.slot })
      const time = formatSlot(e.slot, ctx)
      if (owner.phone) await phraseAndSend({ toNumber: owner.phone, situation: `The contact ${contactName} can't make the offered times and suggests ${time} for "${row.title}". Ask the owner whether to take it or offer another time.`, fallback: i18n.coordination_counter_to_owner[ctx.lang](contactName, time), ctx })
      await auditContactReplied('countered', e.slot)
      break
    }
    case 'relay_decline_to_owner': {
      await repo.updateCoordination(db, row.id, { status: t.status })
      if (owner.phone) await phraseAndSend({ toNumber: owner.phone, situation: `The contact ${contactName} declined the meeting "${row.title}".`, fallback: i18n.coordination_decline_to_owner[ctx.lang](contactName), ctx })
      await auditContactReplied('declined')
      break
    }
    case 'message_contact_new_candidate': {
      const newCandidates = [...row.candidateSlots, e.slot]
      await repo.updateCoordination(db, row.id, { status: t.status, candidateSlots: newCandidates })
      const time = formatSlot(e.slot, ctx)
      if (contact.phone) await phraseAndSend({ toNumber: contact.phone, situation: `Offer the contact a new meeting time the owner proposed: ${time}. Ask if it works.`, fallback: i18n.coordination_offer_to_contact[ctx.lang](ctx.businessName, time), ctx })
      await logAudit(db, { businessId: ctx.businessId, actorId: row.ownerId, action: 'coordination.owner_counter_offer', entityType: 'meeting_coordination', entityId: row.id, metadata: { slotStart: e.slot.start.toISOString() } })
      break
    }
    case 'book_and_notify': {
      const avail = await calendar.checkAvailability(e.slot)
      if (avail.status !== 'available') {
        if (owner.phone) await phraseAndSend({ toNumber: owner.phone, situation: `The agreed meeting time for "${row.title}" just became busy on the calendar. Tell the owner plainly and offer to pick another time. Do NOT say it was booked.`, fallback: i18n.coordination_counter_to_owner[ctx.lang](contactName, formatSlot(e.slot, ctx)), ctx })
        await logAudit(db, { businessId: ctx.businessId, actorId: row.ownerId, action: 'coordination.book_conflict', entityType: 'meeting_coordination', entityId: row.id, metadata: { slotStart: e.slot.start.toISOString() } })
        return // do NOT persist 'confirmed'
      }
      const rendered = renderBookingEvent({ kind: 'meeting', title: row.title, contact: { name: contact.name, phone: contact.phone } }, ctx.lang)
      const mirror = await calendar.upsertMirrorEvent({ summary: rendered.title, description: rendered.description, start: e.slot.start, end: e.slot.end, privateProps: { paType: 'meeting', coordinationId: row.id } })
      if (mirror.status !== 'ok') {
        if (owner.phone) await phraseAndSend({ toNumber: owner.phone, situation: `I couldn't add the meeting "${row.title}" to the calendar. Tell the owner honestly and offer to try again. Do NOT claim it was booked.`, fallback: i18n.coordination_expired_to_owner[ctx.lang](contactName), ctx })
        await logAudit(db, { businessId: ctx.businessId, actorId: row.ownerId, action: 'coordination.book_failed', entityType: 'meeting_coordination', entityId: row.id, metadata: { reason: mirror.reason } })
        return
      }
      await repo.updateCoordination(db, row.id, { status: 'confirmed', agreedSlot: e.slot, calendarEventId: mirror.eventId, googleEtag: mirror.etag })
      const time = formatSlot(e.slot, ctx)
      if (contact.phone) await phraseAndSend({ toNumber: contact.phone, situation: `Tell the contact the meeting is confirmed for ${time}.`, fallback: i18n.coordination_booked_to_contact[ctx.lang](time), ctx })
      await logAudit(db, { businessId: ctx.businessId, actorId: row.ownerId, action: 'coordination.booked', entityType: 'meeting_coordination', entityId: row.id, metadata: { calendarEventId: mirror.eventId, slotStart: e.slot.start.toISOString() } })
      break
    }
    case 'notify_owner_expired': {
      await repo.updateCoordination(db, row.id, { status: t.status })
      if (owner.phone) await phraseAndSend({ toNumber: owner.phone, situation: `No reply came from ${contactName} about the meeting "${row.title}" in time. Let the owner know and offer to try again.`, fallback: i18n.coordination_expired_to_owner[ctx.lang](contactName), ctx })
      await logAudit(db, { businessId: ctx.businessId, actorId: row.ownerId, action: 'coordination.expired', entityType: 'meeting_coordination', entityId: row.id })
      break
    }
    case 'message_contact_candidates': {
      const times = describeCandidates(row.candidateSlots, ctx)
      if (contact.phone) await phraseAndSend({ toNumber: contact.phone, situation: `Re-send the meeting time options: ${times}.`, fallback: i18n.coordination_offer_to_contact[ctx.lang](ctx.businessName, times), ctx })
      break
    }
    case 'none':
    default: {
      // e.g. owner abandon → persist the terminal status.
      if (t.status !== row.status) await repo.updateCoordination(db, row.id, { status: t.status })
      break
    }
  }
}

// Periodic sweep entry (wired by a later task).
export async function expireStaleCoordinations(db: Db, calendarFor: (businessId: string) => Promise<CalendarClient | null>, ctxFor: (businessId: string) => Promise<BusinessCtx | null>): Promise<void> {
  const rows = await repo.findExpired(db, new Date())
  for (const row of rows) {
    const calendar = await calendarFor(row.businessId)
    const ctx = await ctxFor(row.businessId)
    if (!calendar || !ctx) continue
    const t = nextCoordinationState(row.status, { type: 'expire' })
    await applyTransition(db, calendar, row, t, ctx)
  }
}
