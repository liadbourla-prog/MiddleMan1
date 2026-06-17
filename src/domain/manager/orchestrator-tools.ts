/**
 * Branch 3 orchestrator tool executors.
 * Each function maps to one tool declared in MANAGER_TOOLS.
 * Return value is the JSON object that the Gemini model sees as the tool result.
 */

import { and, desc, eq, gt, gte, ilike, inArray, lt, or } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { identities, bookings, businesses, customerProfiles, managerInstructions, businessContacts, serviceTypes } from '../../db/schema.js'
import type { IdentityRole } from '../../db/schema.js'
import type { Action } from '../authorization/check.js'
import type { CalendarClient } from '../../adapters/calendar/client.js'
import { classifyManagerInstruction, } from '../../adapters/llm/client.js'
import { applyInstruction, pauseConversation, resumeConversation } from './apply.js'
import { tavilySearch, TavilyRateLimitError } from '../../adapters/tavily/client.js'
import { i18n, type Lang } from '../i18n/t.js'
import { createBlock, deleteBlockById, listBlocksInRange, parseBlockId, blockLabel, BLOCK_ID_PREFIX } from '../availability/blocks.js'
import { enqueueBlockMirror, enqueueBlockDeletion } from '../../workers/calendar-mirror.js'
import { getOpenSlots } from '../availability/service.js'
import { resolveSlotRange, resolveRequestedDate, addDaysToDateStr, resolveSlotStart, type RequestedDateParts, type RelativeDay, type SlotRangeReason } from '../availability/resolve-slot.js'
import { findProviderByName } from '../provider/lookup.js'

// ── Structured date/time pieces from the orchestrator (classify-only) ────────
// The LLM supplies these; the deterministic core (resolveSlotRange) computes the
// absolute instant and validates it. The LLM never does calendar arithmetic.
interface DatePieces {
  relativeDay?: RelativeDay
  weekday?: number
  explicitDate?: { year?: number; month?: number; day?: number }
}
interface TimePieces { hour: number; minute: number }

function toDateParts(d: DatePieces | undefined | null): RequestedDateParts {
  return {
    relativeDay: d?.relativeDay ?? null,
    weekday: d?.weekday ?? null,
    explicitDate: d?.explicitDate
      ? { year: d.explicitDate.year ?? null, month: d.explicitDate.month ?? null, day: d.explicitDate.day ?? null }
      : null,
  }
}

// Internal resolution reason → plain-language guidance for the model to phrase.
// Raw codes stay internal (no-leak, §7.3 / §12); the model never echoes them.
const DATE_CLARIFY_GUIDANCE: Record<SlotRangeReason, string> = {
  no_date: 'No usable day was given. Ask the manager which day they mean — naturally, no menu.',
  ambiguous_date: "The day is ambiguous (a vague 'this/next week' with no weekday). Ask which specific day they mean, without repeating the vague phrase.",
  impossible_date: "That date doesn't exist on the calendar. Tell the manager plainly and ask for a real date — don't repeat the bad one.",
  past_year: 'That date looks like it has already passed. Ask which upcoming day they want, without repeating the past date.',
  dst_gap: "That exact clock time doesn't exist that day (a daylight-saving shift). Ask the manager to pick a slightly different time.",
  end_before_start: 'The end time is not after the start time. Ask the manager for a valid start and end — phrase it naturally.',
  no_time: 'No end time or duration was given. Ask the manager how long it runs, or for an end time.',
}

function clarifyDate(reason: SlotRangeReason): object {
  return { success: false, reason, needsClarification: true, guidance: DATE_CLARIFY_GUIDANCE[reason] }
}

export interface ToolContext {
  db: Db
  businessId: string
  identityId: string
  timezone: string
  lang: Lang
  calendar: CalendarClient
  // Caller role + granted actions — used to gate config changes for delegated
  // staff at the apply seam. Optional so existing test contexts default to manager.
  role?: IdentityRole
  delegatedPermissions?: Set<Action>
}

// ── listCalendarEvents ────────────────────────────────────────────────────────

interface ListCalendarEventsArgs {
  intent: 'list_today' | 'list_week' | 'list_range' | 'check_free_slots'
  dateFrom?: DatePieces
  dateTo?: DatePieces
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
      // Resolve range bounds deterministically from classified pieces. A read is
      // low-stakes, so unresolvable bounds clamp to a sane default rather than
      // hard-failing (the LLM still never computes the absolute dates itself).
      const fromRes = resolveRequestedDate(toDateParts(args.dateFrom), tz, now)
      const toRes = resolveRequestedDate(toDateParts(args.dateTo), tz, now)
      from = fromRes.ok ? resolveSlotStart(fromRes.dateStr, { hour: 0, minute: 0 }, tz) : now
      to = toRes.ok
        ? resolveSlotStart(addDaysToDateStr(toRes.dateStr, 1), { hour: 0, minute: 0 }, tz)
        : new Date(from.getTime() + 14 * 24 * 60 * 60_000)
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
        return { freeSlots: [], count: 0 }
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
      return { events: [], count: 0 }
    }

    return { events: formatted, count: formatted.length }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

// ── createCalendarEvent ───────────────────────────────────────────────────────

interface CreateCalendarEventArgs {
  title: string
  date: DatePieces
  startTime: TimePieces
  endTime: TimePieces
  notes?: string
}

export async function executeCreateCalendarEvent(
  args: CreateCalendarEventArgs,
  ctx: ToolContext,
): Promise<object> {
  // Deterministic resolution — the LLM only classified the pieces. Past-year,
  // impossible-date, ambiguous-week, and DST gaps all fail closed so we never
  // write a wrong instant (Principle #1; parity with Branch 4).
  const resolved = resolveSlotRange(
    { date: toDateParts(args.date), startTime: args.startTime, endTime: args.endTime },
    ctx.timezone,
    new Date(),
  )
  if (!resolved.ok) return clarifyDate(resolved.reason)
  const { start, end } = resolved

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
    return {
      success: false,
      reason: 'conflicts_with_bookings',
      conflictCount: actualConflicts.length,
      guidance: 'Tell the manager the slot already has confirmed booking(s) and ask whether to cancel those first or pick another time. Phrase it naturally.',
    }
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
  instructor?: string
  date: DatePieces
  startTime: TimePieces
  endTime?: TimePieces
  durationMinutes?: number
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
  // Deterministic resolution from classified pieces (end via endTime or duration).
  const resolved = resolveSlotRange(
    {
      date: toDateParts(args.date),
      startTime: args.startTime,
      endTime: args.endTime ?? null,
      durationMinutes: args.durationMinutes ?? null,
    },
    ctx.timezone,
    new Date(),
  )
  if (!resolved.ok) return clarifyDate(resolved.reason)
  const { start, end } = resolved

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

  // Guard: a private (1-on-1) service must NOT be scheduled as a group class
  // without an explicit capacity. Otherwise it lands as a cap=1 'class' that then
  // surfaces in BOTH the day's class list AND its private-openings, so the customer
  // reply mixes a real class time with a fabricated private slot (WS-C / the hours
  // mismatch). Ask for the group size instead of silently creating that state.
  const explicitCap = args.maxParticipants ?? null
  if (serviceTypeId && (serviceCapacity ?? 1) <= 1 && (explicitCap === null || explicitCap <= 1)) {
    return {
      success: false,
      needsClarification: true,
      message: i18n.schedule_private_service_needs_capacity[ctx.lang](serviceName ?? args.serviceName ?? ''),
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

  // Resolve the named instructor to an EXISTING provider (explicit-add model:
  // never auto-create from a typo). Clarify when unknown/ambiguous.
  let providerId: string | null = null
  if (args.instructor && args.instructor.trim().length > 0) {
    const found = await findProviderByName(ctx.db, ctx.businessId, args.instructor.trim())
    if (found.status === 'none') {
      return { success: false, needsClarification: true, message: i18n.schedule_instructor_not_found[ctx.lang](args.instructor.trim()) }
    }
    if (found.status === 'ambiguous') {
      return { success: false, needsClarification: true, message: i18n.schedule_instructor_ambiguous[ctx.lang](args.instructor.trim()) }
    }
    providerId = found.id
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
    providerId,
  })

  // Durable outbound mirror (Phase 2) — no-op in internal mode.
  await enqueueBlockMirror(ctx.businessId, block.id)

  const locale = ctx.lang === 'he' ? 'he-IL' : 'en-GB'
  const when = start.toLocaleString(locale, { timeZone: ctx.timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  return {
    success: true,
    eventId: `${BLOCK_ID_PREFIX}${block.id}`,
    scheduled: { title, when, maxParticipants: maxParticipants ?? null, instructor: args.instructor?.trim() ?? null },
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
      return { success: false, reason: 'not_found' }
    }
    // Durable mirror: remove the corresponding Google event when one was created.
    if (removed.googleEventId) {
      await enqueueBlockDeletion(ctx.businessId, removed.id, removed.googleEventId)
    }
    return { success: true, deleted: { what: args.confirmationHint ?? null } }
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
    return {
      success: false,
      reason: 'contains_active_booking',
      guidance: 'This event is an active customer booking — it cannot be deleted here. Tell the manager they can cancel the booking via business settings instead. Phrase it naturally.',
    }
  }

  const result = await ctx.calendar.deleteEvent(args.eventId)

  if (result.status === 'deleted') {
    return { success: true, deleted: { what: args.confirmationHint ?? null } }
  }
  if (result.status === 'not_found') {
    return { success: false, reason: 'not_found' }
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
    // detail is the raw classifier failure reason (empty response / quota / schema) —
    // kept internal for diagnosis (logged via orchestrator tool results), never shown
    // to the manager verbatim.
    return { success: false, error: 'Classification failed. Try rephrasing the instruction.', detail: classified.error }
  }

  if (classified.data.ambiguous && classified.data.clarificationNeeded) {
    return { success: false, clarificationNeeded: classified.data.clarificationNeeded }
  }

  if (classified.data.instructionType === 'unknown') {
    return { success: false, reason: 'unclear_instruction', guidance: 'You could not tell what config change the manager wants. Ask them to clarify, in your own words. Phrase it naturally.' }
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
    return { success: false, reason: 'save_failed', guidance: 'The change could not be saved. Tell the manager it did not go through and offer to try again. Phrase it naturally.' }
  }

  const result = await applyInstruction(
    ctx.db,
    saved.id,
    ctx.businessId,
    ctx.identityId,
    classified.data.instructionType,
    classified.data.structuredParams as Record<string, unknown>,
    ctx.lang,
    ctx.role ? { role: ctx.role, ...(ctx.delegatedPermissions ? { permissions: ctx.delegatedPermissions } : {}) } : undefined,
  )

  if (!result.ok) {
    return { success: false, reason: 'apply_failed', detail: result.reason, guidance: 'The change did not apply. Tell the manager plainly and offer to retry. detail is raw — phrase it naturally, never echo it verbatim.' }
  }

  return { success: true, fact: result.confirmationMessage, guidance: 'The change is live. fact is raw data describing what changed — confirm it to the manager in your own words, never quote it. After a customer-facing change, offer to notify customers.' }
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
      return { results: [], count: 0 }
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
      return { success: false, reason: 'rate_limited', guidance: "The daily web-search limit is reached. Tell the manager it'll be available again tomorrow, in your own words." }
    }
    return { success: false, reason: 'search_failed', guidance: 'The web search failed. Tell the manager plainly and offer to try again. Never surface the raw error.' }
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
      return { found: false }
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
      if (!id) return { found: false }
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

    return { success: true, saved: { target: 'customer' }, guidance: 'Note saved. Confirm briefly in your own words, never quote this.' }
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

    return { success: true, saved: { target: 'business_contact', name: args.identifier }, guidance: 'Note saved to the contact. Confirm briefly in your own words, never quote this.' }
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
