/**
 * Branch 3 orchestrator tool executors.
 * Each function maps to one tool declared in MANAGER_TOOLS.
 * Return value is the JSON object that the Gemini model sees as the tool result.
 */

import { and, desc, eq, gt, gte, ilike, inArray, lt, or } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { identities, bookings, businesses, customerProfiles, managerInstructions, businessContacts, serviceTypes } from '../../db/schema.js'
import type { CalendarClient } from '../../adapters/calendar/client.js'
import { classifyManagerInstruction, } from '../../adapters/llm/client.js'
import { applyInstruction, pauseConversation, resumeConversation } from './apply.js'
import { tavilySearch, TavilyRateLimitError } from '../../adapters/tavily/client.js'
import type { Lang } from '../i18n/t.js'
import { createBlock, deleteBlockById, listBlocksInRange, parseBlockId, blockLabel, BLOCK_ID_PREFIX } from '../availability/blocks.js'
import { enqueueBlockMirror, enqueueBlockDeletion } from '../../workers/calendar-mirror.js'
import { getOpenSlots } from '../availability/service.js'

export interface ToolContext {
  db: Db
  businessId: string
  identityId: string
  timezone: string
  lang: Lang
  calendar: CalendarClient
}

// ── listCalendarEvents ────────────────────────────────────────────────────────

interface ListCalendarEventsArgs {
  intent: 'list_today' | 'list_week' | 'list_range' | 'check_free_slots'
  dateFrom?: string
  dateTo?: string
}

export async function executeListCalendarEvents(
  args: ListCalendarEventsArgs,
  ctx: ToolContext,
): Promise<object> {
  const now = new Date()
  const tz = ctx.timezone

  let from: Date
  let to: Date

  switch (args.intent) {
    case 'list_today': {
      const todayStr = now.toLocaleDateString('en-CA', { timeZone: tz })
      from = new Date(`${todayStr}T00:00:00`)
      to = new Date(`${todayStr}T23:59:59`)
      break
    }
    case 'list_week': {
      from = now
      to = new Date(now.getTime() + 7 * 24 * 60 * 60_000)
      break
    }
    case 'list_range': {
      if (!args.dateFrom || !args.dateTo) {
        return { error: 'dateFrom and dateTo are required for list_range' }
      }
      from = new Date(args.dateFrom)
      to = new Date(args.dateTo + 'T23:59:59')
      break
    }
    case 'check_free_slots': {
      const todayStr = now.toLocaleDateString('en-CA', { timeZone: tz })
      from = new Date(`${todayStr}T00:00:00`)
      to = new Date(from.getTime() + 7 * 24 * 60 * 60_000)
      break
    }
  }

  const locale = ctx.lang === 'he' ? 'he-IL' : 'en-GB'

  // Proactive open-slot suggestion — the canonical availability spine enumerates
  // bookable gaps (working hours − blocks − bookings) over the next 7 days.
  if (args.intent === 'check_free_slots') {
    try {
      const [business] = await ctx.db.select().from(businesses).where(eq(businesses.id, ctx.businessId)).limit(1)
      if (!business) return { error: 'Business not found' }

      // Use the shortest active service as the probe duration so we surface the
      // finest-grained openings; default to 30 min when no service is configured.
      const [svc] = await ctx.db
        .select({ durationMinutes: serviceTypes.durationMinutes })
        .from(serviceTypes)
        .where(and(eq(serviceTypes.businessId, ctx.businessId), eq(serviceTypes.isActive, true)))
        .orderBy(serviceTypes.durationMinutes)
        .limit(1)
      const duration = svc?.durationMinutes ?? 30

      const slots = await getOpenSlots(ctx.db, business, { start: from, end: to }, duration, { maxSlots: 12 })
      if (slots.length === 0) {
        return { freeSlots: [], summary: ctx.lang === 'he' ? 'אין משבצות פנויות בשבוע הקרוב.' : 'No open slots in the next 7 days.' }
      }
      return {
        freeSlots: slots.map((s) => ({
          start: s.start.toLocaleString(locale, { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
          end: s.end.toLocaleString(locale, { timeZone: tz, hour: '2-digit', minute: '2-digit' }),
        })),
        durationMinutes: duration,
        count: slots.length,
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  }

  try {
    // Merge two internal-truth sources: bookings/Google events (via the calendar
    // client) AND calendar_blocks (personal events, intra-day blocks, classes).
    // Both must show in read-back so Branch 3 reflects the full picture.
    const events = await ctx.calendar.listEvents(from, to)
    const blocks = await listBlocksInRange(ctx.db, ctx.businessId, from, to)

    const formatted = [
      ...events.map((ev) => ({
        eventId: ev.eventId,
        title: ev.title,
        start: ev.start.toLocaleString(locale, { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
        end: ev.end.toLocaleString(locale, { timeZone: tz, hour: '2-digit', minute: '2-digit' }),
        isBooking: ev.isBooking,
        kind: 'booking' as const,
        _sortTs: ev.start.getTime(),
      })),
      ...blocks.map((b) => ({
        eventId: `${BLOCK_ID_PREFIX}${b.id}`,
        title: blockLabel(b, ctx.lang === 'he' ? 'he' : 'en'),
        start: b.startTs.toLocaleString(locale, { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
        end: b.endTs.toLocaleString(locale, { timeZone: tz, hour: '2-digit', minute: '2-digit' }),
        isBooking: false,
        kind: b.type,
        _sortTs: b.startTs.getTime(),
      })),
    ].sort((a, b) => a._sortTs - b._sortTs)
      .map(({ _sortTs: _omit, ...rest }) => rest)

    if (formatted.length === 0) {
      return { events: [], summary: ctx.lang === 'he' ? 'אין אירועים בתקופה זו.' : 'No events in this period.' }
    }

    return { events: formatted, count: formatted.length }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

// ── createCalendarEvent ───────────────────────────────────────────────────────

interface CreateCalendarEventArgs {
  title: string
  startDatetime: string
  endDatetime: string
  notes?: string
}

export async function executeCreateCalendarEvent(
  args: CreateCalendarEventArgs,
  ctx: ToolContext,
): Promise<object> {
  const start = new Date(args.startDatetime)
  const end = new Date(args.endDatetime)

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return { success: false, error: 'Invalid datetime format. Use ISO 8601.' }
  }
  if (end <= start) {
    return { success: false, error: 'End time must be after start time.' }
  }

  // Guard: refuse to create if it overlaps an active customer booking. Precise
  // overlap predicate: existing.start < new.end AND existing.end > new.start.
  // (Personal events MAY fall outside working hours — that is the owner's own
  // time — so we deliberately do NOT enforce business hours here.)
  const actualConflicts = await ctx.db
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(
      eq(bookings.businessId, ctx.businessId),
      inArray(bookings.state, ['held', 'pending_payment', 'confirmed']),
      lt(bookings.slotStart, end),
      gt(bookings.slotEnd, start),
    ))
    .limit(5)

  if (actualConflicts.length > 0) {
    const msg = ctx.lang === 'he'
      ? `אותה שעה כוללת ${actualConflicts.length} תור/ים מאושר/ים. יצירת האירוע תגרום לחפיפה. האם לבטל את התורים קודם, או לבחור שעה אחרת?`
      : `That slot has ${actualConflicts.length} confirmed booking(s). Creating the event anyway would show as double-booked. Do you want to cancel the booking(s) first, or choose a different time?`
    return { success: false, message: msg }
  }

  // Persist to calendar_blocks — the internal source of truth. This is the fix
  // for the old data-loss bug where internal-mode personal events silently
  // vanished (CALENDAR_UX_DESIGN.md §4).
  const block = await createBlock(ctx.db, {
    businessId: ctx.businessId,
    type: 'personal',
    start,
    end,
    title: args.title,
    reason: args.notes ?? null,
  })

  // Durable outbound mirror (Phase 2): the internal row is the source of truth;
  // a queued worker write-throughs it into Google with retries + etag tracking.
  // No-op for internal-mode businesses.
  await enqueueBlockMirror(ctx.businessId, block.id)

  return { success: true, eventId: `${BLOCK_ID_PREFIX}${block.id}` }
}

// ── scheduleGroupSession ──────────────────────────────────────────────────────

interface ScheduleGroupSessionArgs {
  serviceName?: string
  title?: string
  startDatetime: string
  endDatetime: string
  maxParticipants?: number
}

/**
 * Proactively place a group session (class) on the calendar as a first-class
 * primitive — the manager no longer has to wait for the first customer to book
 * for a class to "exist" (CALENDAR_UX_DESIGN.md §4). Stored as a calendar_blocks
 * row of type 'class', linked to a service type when one matches.
 */
export async function executeScheduleGroupSession(
  args: ScheduleGroupSessionArgs,
  ctx: ToolContext,
): Promise<object> {
  const start = new Date(args.startDatetime)
  const end = new Date(args.endDatetime)
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return { success: false, error: 'Invalid datetime format. Use ISO 8601.' }
  }
  if (end <= start) {
    return { success: false, error: 'End time must be after start time.' }
  }

  // Resolve the linked service (gives capacity + a canonical title) if named.
  let serviceTypeId: string | null = null
  let serviceName: string | null = null
  let serviceCapacity: number | null = null
  if (args.serviceName) {
    const [svc] = await ctx.db
      .select({ id: serviceTypes.id, name: serviceTypes.name, maxParticipants: serviceTypes.maxParticipants })
      .from(serviceTypes)
      .where(and(eq(serviceTypes.businessId, ctx.businessId), ilike(serviceTypes.name, `%${args.serviceName}%`)))
      .limit(1)
    if (svc) {
      serviceTypeId = svc.id
      serviceName = svc.name
      serviceCapacity = svc.maxParticipants
    }
  }

  // Conflict guard: a class cannot run over an active customer booking or over
  // manager-blocked/personal time (but may overlap other classes).
  const bookingConflicts = await ctx.db
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(
      eq(bookings.businessId, ctx.businessId),
      inArray(bookings.state, ['held', 'pending_payment', 'confirmed']),
      lt(bookings.slotStart, end),
      gt(bookings.slotEnd, start),
    ))
    .limit(5)
  if (bookingConflicts.length > 0) {
    return {
      success: false,
      message: ctx.lang === 'he'
        ? `אותה שעה כוללת ${bookingConflicts.length} תור/ים פעיל/ים. בטל אותם קודם או בחר שעה אחרת.`
        : `That time overlaps ${bookingConflicts.length} active booking(s). Cancel them first or choose another time.`,
    }
  }

  const maxParticipants = args.maxParticipants ?? serviceCapacity ?? null
  const title = args.title ?? serviceName ?? (ctx.lang === 'he' ? 'שיעור קבוצתי' : 'Group class')

  const block = await createBlock(ctx.db, {
    businessId: ctx.businessId,
    type: 'class',
    start,
    end,
    title,
    serviceTypeId,
    maxParticipants,
  })

  // Durable outbound mirror (Phase 2) — no-op in internal mode.
  await enqueueBlockMirror(ctx.businessId, block.id)

  const locale = ctx.lang === 'he' ? 'he-IL' : 'en-GB'
  const when = start.toLocaleString(locale, { timeZone: ctx.timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  const capStr = maxParticipants ? (ctx.lang === 'he' ? ` (עד ${maxParticipants} משתתפים)` : ` (up to ${maxParticipants} participants)`) : ''
  return {
    success: true,
    eventId: `${BLOCK_ID_PREFIX}${block.id}`,
    confirmation: ctx.lang === 'he'
      ? `✅ ${title} נקבע ל-${when}${capStr}.`
      : `✅ ${title} scheduled for ${when}${capStr}.`,
  }
}

// ── deleteCalendarEvent ───────────────────────────────────────────────────────

interface DeleteCalendarEventArgs {
  eventId: string
  confirmationHint?: string
}

export async function executeDeleteCalendarEvent(
  args: DeleteCalendarEventArgs,
  ctx: ToolContext,
): Promise<object> {
  // calendar_blocks (personal events, intra-day blocks, classes) carry a
  // 'block:' prefix in read-back. Delete them from the internal store directly.
  const blockId = parseBlockId(args.eventId)
  if (blockId) {
    const removed = await deleteBlockById(ctx.db, ctx.businessId, blockId)
    if (!removed) {
      return { success: false, message: ctx.lang === 'he' ? 'האירוע לא נמצא.' : 'Event not found.' }
    }
    // Durable mirror: remove the corresponding Google event when one was created.
    if (removed.googleEventId) {
      await enqueueBlockDeletion(ctx.businessId, removed.id, removed.googleEventId)
    }
    const hint = args.confirmationHint ? ` (${args.confirmationHint})` : ''
    return { success: true, message: ctx.lang === 'he' ? `האירוע${hint} נמחק.` : `Event${hint} deleted.` }
  }

  // Guard: refuse to delete events that correspond to active customer bookings
  const bookingRow = await ctx.db
    .select({ id: bookings.id, state: bookings.state })
    .from(bookings)
    .where(and(
      eq(bookings.businessId, ctx.businessId),
      eq(bookings.calendarEventId, args.eventId),
      or(eq(bookings.state, 'confirmed'), eq(bookings.state, 'held')),
    ))
    .limit(1)

  if (bookingRow.length > 0) {
    const msg = ctx.lang === 'he'
      ? 'לא ניתן למחוק אירוע זה — הוא מכיל תור לקוח מאושר. השתמש ב"ביטול תור" דרך הגדרות העסק.'
      : 'Cannot delete this event — it contains an active customer booking. Use manageBusinessSettings to cancel bookings.'
    return { success: false, message: msg }
  }

  const result = await ctx.calendar.deleteEvent(args.eventId)

  if (result.status === 'deleted') {
    const hint = args.confirmationHint ? ` (${args.confirmationHint})` : ''
    return { success: true, message: ctx.lang === 'he' ? `האירוע${hint} נמחק.` : `Event${hint} deleted.` }
  }
  if (result.status === 'not_found') {
    return { success: false, message: ctx.lang === 'he' ? 'האירוע לא נמצא.' : 'Event not found.' }
  }
  return { success: false, error: result.status === 'error' ? result.reason : 'Unknown error' }
}

// ── manageBusinessSettings ────────────────────────────────────────────────────

interface ManageBusinessSettingsArgs {
  instruction: string
}

export async function executeManageBusinessSettings(
  args: ManageBusinessSettingsArgs,
  ctx: ToolContext,
): Promise<object> {
  const classified = await classifyManagerInstruction(
    args.instruction,
    { businessId: ctx.businessId, timezone: ctx.timezone },
    ctx.lang,
  )

  if (!classified.ok) {
    return { success: false, error: 'Classification failed. Try rephrasing the instruction.' }
  }

  if (classified.data.ambiguous && classified.data.clarificationNeeded) {
    return { success: false, clarificationNeeded: classified.data.clarificationNeeded }
  }

  if (classified.data.instructionType === 'unknown') {
    return { success: false, error: ctx.lang === 'he' ? 'לא הצלחתי להבין את ההוראה.' : 'Could not understand the instruction.' }
  }

  const [saved] = await ctx.db
    .insert(managerInstructions)
    .values({
      businessId: ctx.businessId,
      identityId: ctx.identityId,
      rawMessage: args.instruction,
      receivedAt: new Date(),
      classifiedAs: classified.data.instructionType,
      structuredOutput: classified.data as unknown as Record<string, unknown>,
      applyStatus: 'pending',
    })
    .returning({ id: managerInstructions.id })

  if (!saved) {
    return { success: false, error: ctx.lang === 'he' ? 'שגיאה בשמירת ההוראה.' : 'Failed to save instruction.' }
  }

  const result = await applyInstruction(
    ctx.db,
    saved.id,
    ctx.businessId,
    ctx.identityId,
    classified.data.instructionType,
    classified.data.structuredParams as Record<string, unknown>,
    ctx.lang,
  )

  if (!result.ok) {
    return { success: false, error: result.reason }
  }

  return { success: true, confirmation: result.confirmationMessage }
}

// ── searchWeb ─────────────────────────────────────────────────────────────────

interface SearchWebArgs {
  query: string
  depth?: 'basic' | 'advanced'
}

export async function executeSearchWeb(
  args: SearchWebArgs,
  ctx: ToolContext,
): Promise<object> {
  try {
    const response = await tavilySearch(ctx.businessId, args.query, {
      searchDepth: args.depth ?? 'basic',
      maxResults: args.depth === 'advanced' ? 8 : 5,
    })

    if (response.results.length === 0) {
      return { results: [], summary: ctx.lang === 'he' ? 'לא נמצאו תוצאות.' : 'No results found.' }
    }

    return {
      results: response.results.map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content.slice(0, 400),
      })),
    }
  } catch (err) {
    if (err instanceof TavilyRateLimitError) {
      return {
        error: ctx.lang === 'he'
          ? 'הגעת למגבלת החיפוש היומית. נסה שוב מחר.'
          : 'Daily web search limit reached. Try again tomorrow.',
      }
    }
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

// ── lookupCustomer ────────────────────────────────────────────────────────────

interface LookupCustomerArgs {
  queryType: 'find_by_name' | 'find_by_phone' | 'booking_history' | 'segment'
  identifier?: string
  segmentFilter?: { serviceTypeId?: string; inactiveSinceDays?: number; hasBooking?: boolean }
}

export async function executeLookupCustomer(
  args: LookupCustomerArgs,
  ctx: ToolContext,
): Promise<object> {
  const { queryType, identifier } = args

  if (queryType === 'find_by_name' || queryType === 'find_by_phone') {
    if (!identifier) return { error: 'identifier is required for this query type' }

    const where = queryType === 'find_by_name'
      ? and(eq(identities.businessId, ctx.businessId), ilike(identities.displayName, `%${identifier}%`))
      : and(eq(identities.businessId, ctx.businessId), eq(identities.phoneNumber, identifier))

    const rows = await ctx.db
      .select({
        id: identities.id,
        displayName: identities.displayName,
        phoneNumber: identities.phoneNumber,
        preferredLanguage: identities.preferredLanguage,
      })
      .from(identities)
      .where(where)
      .limit(5)

    if (rows.length === 0) {
      return { found: false, message: ctx.lang === 'he' ? 'לא נמצא לקוח.' : 'No customer found.' }
    }

    // Fetch profile notes for each result
    const withProfiles = await Promise.all(rows.map(async (row) => {
      const [profile] = await ctx.db
        .select({ notes: customerProfiles.notes, displayName: customerProfiles.displayName })
        .from(customerProfiles)
        .where(eq(customerProfiles.identityId, row.id))
        .limit(1)
      return { ...row, notes: profile?.notes ?? null }
    }))

    return { found: true, customers: withProfiles }
  }

  if (queryType === 'booking_history') {
    if (!identifier) return { error: 'identifier (identityId or phone) is required' }

    // Resolve identityId from phone if needed
    let identityId = identifier
    if (identifier.startsWith('+') || /^\d{10,}$/.test(identifier)) {
      const [id] = await ctx.db
        .select({ id: identities.id })
        .from(identities)
        .where(and(eq(identities.businessId, ctx.businessId), eq(identities.phoneNumber, identifier)))
        .limit(1)
      if (!id) return { found: false, message: ctx.lang === 'he' ? 'לא נמצא לקוח.' : 'No customer found.' }
      identityId = id.id
    }

    const recentBookings = await ctx.db
      .select({
        id: bookings.id,
        slotStart: bookings.slotStart,
        state: bookings.state,
      })
      .from(bookings)
      .where(and(eq(bookings.businessId, ctx.businessId), eq(bookings.customerId, identityId)))
      .orderBy(desc(bookings.slotStart))
      .limit(10)

    return { found: true, bookings: recentBookings.map((b) => ({
      id: b.id,
      date: b.slotStart.toLocaleDateString(ctx.lang === 'he' ? 'he-IL' : 'en-GB', { timeZone: ctx.timezone }),
      state: b.state,
    })) }
  }

  if (queryType === 'segment') {
    const filter = args.segmentFilter ?? {}
    const whereConditions: ReturnType<typeof and>[] = [
      eq(identities.businessId, ctx.businessId),
      eq(identities.role, 'customer'),
    ]

    const rows = await ctx.db
      .select({ id: identities.id, displayName: identities.displayName, phoneNumber: identities.phoneNumber })
      .from(identities)
      .where(and(...whereConditions))
      .limit(50)

    // Post-filter for inactiveSinceDays if requested
    if (filter.inactiveSinceDays) {
      const cutoff = new Date(Date.now() - filter.inactiveSinceDays * 24 * 60 * 60_000)
      const active = new Set<string>()
      const activeBookings = await ctx.db
        .select({ customerId: bookings.customerId })
        .from(bookings)
        .where(and(eq(bookings.businessId, ctx.businessId), gte(bookings.slotStart, cutoff)))
      activeBookings.forEach((b) => active.add(b.customerId))
      return { count: rows.filter((r) => !active.has(r.id)).length, customers: rows.filter((r) => !active.has(r.id)).slice(0, 20) }
    }

    return { count: rows.length, customers: rows.slice(0, 20) }
  }

  return { error: 'Unknown queryType' }
}

// ── saveContactNote ───────────────────────────────────────────────────────────

interface SaveContactNoteArgs {
  targetType: 'customer' | 'business_contact'
  identifier: string
  note: string
}

export async function executeSaveContactNote(
  args: SaveContactNoteArgs,
  ctx: ToolContext,
): Promise<object> {
  if (args.targetType === 'customer') {
    // identifier is identityId
    const existing = await ctx.db
      .select({ id: customerProfiles.id, notes: customerProfiles.notes })
      .from(customerProfiles)
      .where(eq(customerProfiles.identityId, args.identifier))
      .limit(1)

    if (existing.length > 0) {
      const appended = [existing[0]!.notes, args.note].filter(Boolean).join('\n')
      await ctx.db
        .update(customerProfiles)
        .set({ notes: appended })
        .where(eq(customerProfiles.id, existing[0]!.id))
    } else {
      await ctx.db.insert(customerProfiles).values({
        identityId: args.identifier,
        businessId: ctx.businessId,
        notes: args.note,
      }).onConflictDoNothing()
    }

    return { success: true, message: ctx.lang === 'he' ? 'הערה נשמרה.' : 'Note saved.' }
  }

  if (args.targetType === 'business_contact') {
    // Upsert by name within business
    const existing = await ctx.db
      .select({ id: businessContacts.id, notes: businessContacts.notes })
      .from(businessContacts)
      .where(and(eq(businessContacts.businessId, ctx.businessId), ilike(businessContacts.name, args.identifier)))
      .limit(1)

    if (existing.length > 0) {
      const appended = [existing[0]!.notes, args.note].filter(Boolean).join('\n')
      await ctx.db
        .update(businessContacts)
        .set({ notes: appended, updatedAt: new Date() })
        .where(eq(businessContacts.id, existing[0]!.id))
    } else {
      await ctx.db.insert(businessContacts).values({
        businessId: ctx.businessId,
        name: args.identifier,
        notes: args.note,
      })
    }

    return { success: true, message: ctx.lang === 'he' ? 'הערה נשמרה לאיש הקשר.' : 'Note saved to contact.' }
  }

  return { error: 'Unknown targetType' }
}

// ── pauseConversation ─────────────────────────────────────────────────────────

interface PauseConversationArgs {
  customer_identifier: string
  duration_minutes?: number
}

export async function executePauseConversation(
  args: PauseConversationArgs,
  ctx: ToolContext,
): Promise<object> {
  const duration = typeof args.duration_minutes === 'number' && args.duration_minutes > 0
    ? args.duration_minutes
    : 30
  const message = await pauseConversation(ctx.db, ctx.businessId, args.customer_identifier, duration, ctx.lang)
  return { success: true, message }
}

// ── resumeConversation ────────────────────────────────────────────────────────

interface ResumeConversationArgs {
  customer_identifier: string
}

export async function executeResumeConversation(
  args: ResumeConversationArgs,
  ctx: ToolContext,
): Promise<object> {
  const message = await resumeConversation(ctx.db, ctx.businessId, args.customer_identifier, ctx.lang)
  return { success: true, message }
}
