import { and, eq, ilike } from 'drizzle-orm'
import { authorize } from '../authorization/check.js'
import { isValidE164, registerContact } from '../identity/resolver.js'
import { resolveSlotRange } from '../availability/resolve-slot.js'
import { startCoordination, advanceFromOwner, type BusinessCtx } from '../coordination/handler.js'
import { findActiveByContact, findById } from '../coordination/repository.js'
import type { OwnerDecision, Slot } from '../coordination/types.js'
import { identities, businesses } from '../../db/schema.js'
import type { ToolContext } from './orchestrator-tools.js'

interface DatePieces {
  relativeDay?: 'today' | 'tomorrow' | 'day_after_tomorrow' | 'this_week' | 'next_week' | null
  weekday?: number | null
  explicitDate?: { year?: number | null; month?: number | null; day?: number | null } | null
}
interface TimePieces { hour: number; minute: number }

function toParts(d: DatePieces | undefined | null) {
  return {
    relativeDay: d?.relativeDay ?? null,
    weekday: d?.weekday ?? null,
    explicitDate: d?.explicitDate
      ? { year: d.explicitDate.year ?? null, month: d.explicitDate.month ?? null, day: d.explicitDate.day ?? null }
      : null,
  }
}

function ownerAuth(ctx: ToolContext) {
  return authorize(
    { role: ctx.role ?? 'manager', ...(ctx.delegatedPermissions ? { delegatedPermissions: ctx.delegatedPermissions } : {}) },
    'meeting.coordinate',
  )
}

async function loadBusinessCtx(ctx: ToolContext): Promise<BusinessCtx> {
  const [biz] = await ctx.db
    .select({ name: businesses.name, whatsappPhoneNumberId: businesses.whatsappPhoneNumberId, whatsappAccessToken: businesses.whatsappAccessToken })
    .from(businesses).where(eq(businesses.id, ctx.businessId)).limit(1)
  return {
    businessId: ctx.businessId,
    businessName: biz?.name ?? '',
    lang: ctx.lang,
    timezone: ctx.timezone,
    waCredentials: biz?.whatsappPhoneNumberId && biz.whatsappAccessToken
      ? { accessToken: biz.whatsappAccessToken, phoneNumberId: biz.whatsappPhoneNumberId }
      : undefined,
  }
}

interface CoordinateMeetingArgs {
  contactName?: string
  phoneNumber?: string
  title: string
  date: DatePieces
  startTime: TimePieces
  endTime?: TimePieces
  durationMinutes?: number
  fallbacks?: Array<{ date: DatePieces; startTime: TimePieces }>
}

export async function executeCoordinateMeeting(args: CoordinateMeetingArgs, ctx: ToolContext): Promise<object> {
  if (!ownerAuth(ctx).allowed) {
    return { success: false, reason: 'not_authorized', guidance: 'Only the owner can have me coordinate a meeting.' }
  }

  // 1. Resolve the primary slot.
  const primary = resolveSlotRange(
    { date: toParts(args.date), startTime: args.startTime, endTime: args.endTime ?? null, durationMinutes: args.durationMinutes ?? null },
    ctx.timezone, new Date(),
  )
  if (!primary.ok) {
    return { success: false, needsClarification: true, reason: primary.reason, guidance: 'Ask the owner for a valid primary time (and how long the meeting runs).' }
  }
  const durationMinutes = Math.round((primary.end.getTime() - primary.start.getTime()) / 60000)

  // 2. Resolve fallbacks (same duration); skip any that don't resolve.
  const candidateSlots: Slot[] = [{ start: primary.start, end: primary.end }]
  for (const fb of args.fallbacks ?? []) {
    const r = resolveSlotRange({ date: toParts(fb.date), startTime: fb.startTime, endTime: null, durationMinutes }, ctx.timezone, new Date())
    if (r.ok) candidateSlots.push({ start: r.start, end: r.end })
  }

  // 3. Resolve / register the contact.
  let contactId: string
  let contactPhone: string
  const phone = args.phoneNumber?.replace(/[\s-]/g, '')
  if (phone && isValidE164(phone)) {
    const [existing] = await ctx.db.select({ id: identities.id, phone: identities.phoneNumber, role: identities.role })
      .from(identities).where(and(eq(identities.businessId, ctx.businessId), eq(identities.phoneNumber, phone))).limit(1)
    if (existing && existing.role === 'contact') {
      contactId = existing.id; contactPhone = existing.phone
    } else if (existing) {
      return { success: false, reason: 'phone_not_a_contact', guidance: `That number already belongs to ${existing.role === 'customer' ? 'a customer' : 'someone else'} on file, so I can't set them up as a separate meeting contact. If you wanted to arrange something with a customer, tell me and I'll handle it as a booking instead.` }
    } else {
      contactId = await registerContact(ctx.db, ctx.businessId, phone, args.contactName); contactPhone = phone
    }
  } else if (args.contactName) {
    const [c] = await ctx.db.select({ id: identities.id, phone: identities.phoneNumber })
      .from(identities).where(and(eq(identities.businessId, ctx.businessId), eq(identities.role, 'contact'), ilike(identities.displayName, `%${args.contactName}%`))).limit(1)
    if (!c) return { success: false, reason: 'need_phone', guidance: `I don't have a number for ${args.contactName}. Ask the owner for their phone number.` }
    contactId = c.id; contactPhone = c.phone
  } else {
    return { success: false, reason: 'no_recipient', guidance: 'Ask the owner who to coordinate with — a name on file or a phone number.' }
  }

  // 4. One active coordination per contact.
  const active = await findActiveByContact(ctx.db, ctx.businessId, contactId)
  if (active) {
    return { success: false, reason: 'already_active', guidance: 'There is already an open meeting coordination with this contact. Resolve or abandon that one first.' }
  }

  // 5. Kick off.
  const businessCtx = await loadBusinessCtx(ctx)
  const res = await startCoordination(ctx.db, ctx.calendar, {
    businessId: ctx.businessId, ownerId: ctx.identityId, contactId, contactPhone,
    title: args.title, durationMinutes, candidateSlots, ctx: businessCtx,
  })
  if (!res.ok) {
    if (res.reason === 'no_free_candidates') {
      return { success: false, reason: 'no_free_candidates', guidance: 'None of those times are free on your calendar. Ask the owner for other times.' }
    }
    // contact_unreachable: the coordination was created, but the first message couldn't go out
    // (the contact has not messaged in WhatsApp's 24h window). Be honest — do NOT claim it was sent.
    return { success: true, partial: true, message: `I saved the meeting request, but I couldn't message ${args.contactName ?? 'them'} yet — they need to message us first. I'll relay their reply the moment they do.` }
  }
  return { success: true, coordinationId: res.id, message: `Reaching out to ${args.contactName ?? 'them'} with your time${candidateSlots.length > 1 ? ' options' : ''}.` }
}

interface ResolveMeetingCoordinationArgs {
  coordinationId: string
  action: 'confirm' | 'counter_offer' | 'abandon'
  counterTime?: { date: DatePieces; startTime: TimePieces }
}

export async function executeResolveMeetingCoordination(args: ResolveMeetingCoordinationArgs, ctx: ToolContext): Promise<object> {
  if (!ownerAuth(ctx).allowed) return { success: false, reason: 'not_authorized' }

  const row = await findById(ctx.db, ctx.businessId, args.coordinationId)
  if (!row) return { success: false, reason: 'not_found', guidance: 'I could not find that meeting coordination.' }

  let decision: OwnerDecision
  if (args.action === 'confirm') decision = { kind: 'confirm' }
  else if (args.action === 'abandon') decision = { kind: 'abandon' }
  else {
    if (!args.counterTime) return { success: false, needsClarification: true, guidance: 'What time should I offer instead?' }
    const r = resolveSlotRange({ date: toParts(args.counterTime.date), startTime: args.counterTime.startTime, endTime: null, durationMinutes: row.durationMinutes }, ctx.timezone, new Date())
    if (!r.ok) return { success: false, needsClarification: true, reason: r.reason, guidance: 'Ask the owner for a valid time to offer.' }
    decision = { kind: 'counter_offer', slot: { start: r.start, end: r.end } }
  }

  const businessCtx = await loadBusinessCtx(ctx)
  await advanceFromOwner(ctx.db, ctx.calendar, row, decision, businessCtx)
  return { success: true }
}
