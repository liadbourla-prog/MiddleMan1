import { and, eq, ilike } from 'drizzle-orm'
import { authorize } from '../authorization/check.js'
import { isValidE164, registerContact } from '../identity/resolver.js'
import { resolveSlotRange } from '../availability/resolve-slot.js'
import { startCoordination, advanceFromOwner, type BusinessCtx } from '../coordination/handler.js'
import { findActiveByContact, findById } from '../coordination/repository.js'
import { resolveOutreachIntroducer } from '../coordination/introducer.js'
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
    .select({ name: businesses.name, whatsappPhoneNumberId: businesses.whatsappPhoneNumberId, whatsappAccessToken: businesses.whatsappAccessToken, outreachIdentityMode: businesses.outreachIdentityMode })
    .from(businesses).where(eq(businesses.id, ctx.businessId)).limit(1)
  const [mgr] = await ctx.db
    .select({ name: identities.displayName })
    .from(identities).where(and(eq(identities.businessId, ctx.businessId), eq(identities.role, 'manager'))).limit(1)
  const introducer = resolveOutreachIntroducer({
    mode: (biz?.outreachIdentityMode as 'business' | 'owner_name' | null) ?? null,
    businessName: biz?.name ?? '',
    ownerName: mgr?.name ?? null,
    lang: ctx.lang,
  })
  return {
    businessId: ctx.businessId,
    businessName: biz?.name ?? '',
    lang: ctx.lang,
    timezone: ctx.timezone,
    introducer,
    waCredentials: biz?.whatsappPhoneNumberId && biz.whatsappAccessToken
      ? { accessToken: biz.whatsappAccessToken, phoneNumberId: biz.whatsappPhoneNumberId }
      : undefined,
  }
}

// Persist the owner's self-identification choice so the PA never re-asks and never
// fabricates a name. mode → businesses; a real owner name → the manager's displayName.
async function persistOutreachIdentity(ctx: ToolContext, identifyAs?: 'business' | 'owner_name', ownerName?: string): Promise<void> {
  if (!identifyAs) return
  await ctx.db.update(businesses).set({ outreachIdentityMode: identifyAs }).where(eq(businesses.id, ctx.businessId))
  if (identifyAs === 'owner_name' && ownerName?.trim()) {
    await ctx.db.update(identities).set({ displayName: ownerName.trim() })
      .where(and(eq(identities.businessId, ctx.businessId), eq(identities.role, 'manager')))
  }
}

interface CoordinateMeetingArgs {
  contactName?: string
  phoneNumber?: string
  title: string
  date?: DatePieces
  startTime?: TimePieces
  endTime?: TimePieces
  durationMinutes?: number
  fallbacks?: Array<{ date: DatePieces; startTime: TimePieces }>
  windows?: Array<{ date: DatePieces; startTime: TimePieces; endTime: TimePieces }>
  identifyAs?: 'business' | 'owner_name'
  ownerName?: string
}

export async function executeCoordinateMeeting(args: CoordinateMeetingArgs, ctx: ToolContext): Promise<object> {
  if (!ownerAuth(ctx).allowed) {
    return { success: false, reason: 'not_authorized', guidance: 'Only the owner can have me coordinate a meeting.' }
  }

  // Persist the identification preference (if the owner just answered) BEFORE building
  // the business context, so the resolved introducer reflects the new choice.
  await persistOutreachIdentity(ctx, args.identifyAs, args.ownerName)

  // 1. Resolve the negotiation boundary: day/time WINDOWS, or a discrete primary + fallbacks.
  let candidateSlots: Slot[] = []
  let allowedWindows: Slot[] | undefined
  let durationMinutes: number

  if (args.windows && args.windows.length > 0) {
    if (!args.durationMinutes || args.durationMinutes <= 0) {
      return { success: false, needsClarification: true, reason: 'no_duration', guidance: 'Ask the owner how long the meeting should run (e.g. 90 minutes).' }
    }
    durationMinutes = args.durationMinutes
    const wins: Slot[] = []
    for (const w of args.windows) {
      const r = resolveSlotRange({ date: toParts(w.date), startTime: w.startTime, endTime: w.endTime, durationMinutes: null }, ctx.timezone, new Date())
      if (r.ok && (r.end.getTime() - r.start.getTime()) >= durationMinutes * 60000) wins.push({ start: r.start, end: r.end })
    }
    if (wins.length === 0) {
      return { success: false, needsClarification: true, reason: 'no_valid_windows', guidance: 'Ask the owner for day/time windows wide enough to fit the meeting.' }
    }
    allowedWindows = wins
  } else {
    if (!args.date || !args.startTime) {
      return { success: false, needsClarification: true, reason: 'no_time', guidance: 'Ask the owner for a primary time (and how long the meeting runs), or for day/time windows.' }
    }
    const primary = resolveSlotRange(
      { date: toParts(args.date), startTime: args.startTime, endTime: args.endTime ?? null, durationMinutes: args.durationMinutes ?? null },
      ctx.timezone, new Date(),
    )
    if (!primary.ok) {
      return { success: false, needsClarification: true, reason: primary.reason, guidance: 'Ask the owner for a valid primary time (and how long the meeting runs).' }
    }
    durationMinutes = Math.round((primary.end.getTime() - primary.start.getTime()) / 60000)
    candidateSlots = [{ start: primary.start, end: primary.end }]
    for (const fb of args.fallbacks ?? []) {
      const r = resolveSlotRange({ date: toParts(fb.date), startTime: fb.startTime, endTime: null, durationMinutes }, ctx.timezone, new Date())
      if (r.ok) candidateSlots.push({ start: r.start, end: r.end })
    }
  }

  // 2. Resolve / register the counterparty. An EXISTING CUSTOMER may be the counterparty
  //    (keeps role='customer', no CRM pollution); a brand-new person becomes role='contact'.
  //    The owner / staff can never be the counterparty.
  let contactId: string
  let contactPhone: string
  const phone = args.phoneNumber?.replace(/[\s-]/g, '')
  if (phone && isValidE164(phone)) {
    const [existing] = await ctx.db.select({ id: identities.id, phone: identities.phoneNumber, role: identities.role })
      .from(identities).where(and(eq(identities.businessId, ctx.businessId), eq(identities.phoneNumber, phone))).limit(1)
    if (existing && (existing.role === 'manager' || existing.role === 'delegated_user' || existing.role === 'provider')) {
      return { success: false, reason: 'cannot_coordinate_with_self', guidance: 'That number belongs to you or your staff — I can only coordinate with an external person or a customer.' }
    } else if (existing) {
      contactId = existing.id; contactPhone = existing.phone
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

  // 3. One active coordination per counterparty.
  const active = await findActiveByContact(ctx.db, ctx.businessId, contactId)
  if (active) {
    return { success: false, reason: 'already_active', guidance: 'There is already an open meeting coordination with this person. Resolve or abandon that one first.' }
  }

  // 4. Kick off.
  const businessCtx = await loadBusinessCtx(ctx)
  const res = await startCoordination(ctx.db, ctx.calendar, {
    businessId: ctx.businessId, ownerId: ctx.identityId, contactId, contactPhone,
    title: args.title, durationMinutes, candidateSlots,
    ...(allowedWindows ? { allowedWindows } : {}), ctx: businessCtx,
  })
  if (!res.ok) {
    if (res.reason === 'no_free_candidates') {
      return { success: false, reason: 'no_free_candidates', guidance: 'None of those times are free on your calendar. Ask the owner for other times.' }
    }
    // contact_unreachable: the coordination was created, but the first message couldn't go out
    // (the contact has not messaged in WhatsApp's 24h window). Be honest — do NOT claim it was sent.
    return { success: true, partial: true, message: `I saved the meeting request, but I couldn't message ${args.contactName ?? 'them'} yet — they need to message us first. I'll relay their reply the moment they do.` }
  }
  return { success: true, coordinationId: res.id, message: `Reaching out to ${args.contactName ?? 'them'} with your time${(allowedWindows ?? candidateSlots).length > 1 || allowedWindows ? ' options' : ''}.` }
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
