/**
 * Branch 3 orchestrator tool executors.
 * Each function maps to one tool declared in MANAGER_TOOLS.
 * Return value is the JSON object that the Gemini model sees as the tool result.
 */

import { and, desc, eq, gt, ilike, inArray, isNull, lt, or } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { identities, bookings, businesses, customerProfiles, managerInstructions, businessContacts, serviceTypes, classSeries, conversationSessions, conversationMessages, initiationApprovals } from '../../db/schema.js'
import { createSeries } from '../scheduling/series.js'
import type { IdentityRole } from '../../db/schema.js'
import { authorize, type Action } from '../authorization/check.js'
import type { CalendarClient } from '../../adapters/calendar/client.js'
import { classifyManagerInstruction, } from '../../adapters/llm/client.js'
import { applyInstruction, pauseConversation, resumeConversation, applyReshuffleConfigUpdate, applyPaymentTimingUpdate } from './apply.js'
import type { PaymentLinkSendPolicy } from '../payments/timing.js'
import { reshuffleCampaigns, reshuffleProposals, freedSlotApprovals } from '../../db/schema.js'
import { approveProposal, rejectProposal } from '../reshuffle/gate.js'
import { resolveInitiationProposal } from '../initiations/approvals.js'
import { runBroadcast } from '../initiations/broadcast.js'
import type { SegmentFilter } from '../../shared/skill-types.js'
import { upsertNotificationRule, removeNotificationRule, type NotificationEvent, type NotificationAction, type NotificationRule } from '../initiations/notification-rules.js'
import { setAutonomyState } from '../initiations/autonomy.js'
import { triggerWaitlistForSlot } from '../../workers/waitlist.js'
import { runSentinelForBusiness } from '../../workers/integrity-sentinel.js'
import { tavilySearch, TavilyRateLimitError } from '../../adapters/tavily/client.js'
import { queryCustomerSegment } from '../crm/segment-repository.js'
import { isPaymentsConnected, createPaymentConnectToken, buildPaymentConnectUrl } from '../payments/credentials.js'
import { createCharge, refundCharge } from '../payments/service.js'
import { paymentRequests } from '../../db/schema.js'
import { i18n, type Lang } from '../i18n/t.js'
import { createBlock, deleteBlockById, getBlockById, updateBlock, listBlocksInRange, parseBlockId, blockLabel, BLOCK_ID_PREFIX, type UpdateBlockPatch } from '../availability/blocks.js'
import { enqueueBlockMirror, enqueueBlockDeletion } from '../../workers/calendar-mirror.js'
import { reconcileScheduleWindowOnRead } from '../calendar/inbound-sync.js'
import type { ListedEvent } from '../../adapters/calendar/types.js'
import type { CalendarBlock } from '../../db/schema.js'
import { getOpenSlots } from '../availability/service.js'
import { filterOpenSlots, type NegotiationConstraints } from '../flows/negotiation-constraints.js'
import { blockOpenTimeAroundClasses, blockAroundClassesReplyGuidance } from '../availability/block-around-classes.js'
import { localParts } from '../availability/compute.js'
import { resolveSlotRange, resolveRequestedDate, addDaysToDateStr, resolveSlotStart, type RequestedDateParts, type RelativeDay, type SlotRangeReason } from '../availability/resolve-slot.js'
import { findProviderByName } from '../provider/lookup.js'
import { sendMessage, sendTemplateMessage, canSendFreeForm } from '../../adapters/whatsapp/sender.js'
import { bodyComponents } from '../../adapters/whatsapp/templates.js'
import { registerCustomer, isValidE164 } from '../identity/resolver.js'
import { resolveTargetForOwnerAction, setCustomerName, deriveLastName, type CandidateView } from '../identity/customer-resolver.js'
import { logAudit } from '../audit/logger.js'
import { resolveCalendarSwitch, isPlausibleCalendarId, isWritableRole, type CalendarListEntry } from '../calendar/calendar-id.js'
import { cancelClassSessionBookings, summarizeSessionCancellation } from '../scheduling/session-cancellation.js'
import { resolveBookingApproval, selectPendingApproval, type PendingApprovalCandidate } from '../booking/approval.js'

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
  // Whether this business mirrors to Google. Drives mirror-honest wording (F-c): in
  // google mode a freshly-created event is saved internally and syncing OUT to Google
  // asynchronously, so the reply must not claim it is already in Google Calendar.
  calendarMode?: 'google' | 'internal'
  // Per-business booking authority (design 2026-06-25). 'owner_approval' holds a PA/owner-
  // initiated calendar write until the owner explicitly confirms; 'auto' (default) commits
  // straight away. Optional so existing contexts default to 'auto'.
  bookingAuthority?: 'auto' | 'owner_approval'
  // Caller role + granted actions — used to gate config changes for delegated
  // staff at the apply seam. Optional so existing test contexts default to manager.
  role?: IdentityRole
  delegatedPermissions?: Set<Action>
  // Negotiation memory (Branch 3 read-side only): times the owner has ruled out this
  // session are subtracted from proactive free-slot suggestions. Capture is deferred
  // (managers don't reject slots through a deterministic transition), so this is
  // currently inert — wired and ready for when a capture path lands (e.g. meeting
  // coordination). See negotiation-constraints.ts and NEGOTIATION_MEMORY_PLAN.md.
  negotiationConstraints?: NegotiationConstraints
}

// Builds the guidance string the orchestrator LLM relays when a name is ambiguous. Lists each
// candidate's last name (when known), full phone, and last booking so the owner can verify which
// person is meant, and tells the model to re-call the SAME tool with the chosen lastName or phone.
export function disambiguationGuidance(query: string, candidates: CandidateView[], tool: string): string {
  const lines = candidates.map((c) => {
    const name = c.displayName ?? query
    const last = c.lastName ? ` (last name ${c.lastName})` : ' (no last name on file)'
    const booking = c.lastBooking ? `, last booking ${c.lastBooking.date}${c.lastBooking.service ? ` for ${c.lastBooking.service}` : ''}` : ', no bookings on file'
    return `• ${name}${last} — ${c.phoneNumber}${booking}`
  })
  return `Several people match "${query}". Ask the owner which one, showing these details so they can confirm:\n${lines.join('\n')}\nThen call ${tool} again with the chosen person's lastName (or their phoneNumber).`
}

// ── listCalendarEvents ────────────────────────────────────────────────────────

interface ListCalendarEventsArgs {
  intent: 'list_today' | 'list_week' | 'list_range' | 'check_free_slots'
  dateFrom?: DatePieces
  dateTo?: DatePieces
}

interface ScheduleViewEntry {
  eventId: string
  title: string
  start: string
  end: string
  isBooking: boolean
  kind: string
}

/**
 * Merge the two internal-truth sources — the calendar client's events and the
 * `calendar_blocks` rows — into one sorted schedule view.
 *
 * In connected Google mode the client's `listEvents` reads LIVE from Google, which
 * already contains every block we mirror out there (classes, personal events,
 * intra-day blocks). Re-adding those same rows from `calendar_blocks` would
 * double-count them — and would resurrect a block the owner deleted in Google
 * whose row still lingers internally until reconcile catches up. That double-count
 * + resurrection was the live bug. So in google mode we fold in ONLY blocks not
 * yet mirrored (no googleEventId); the mirrored ones — and the owner's own edits —
 * come from the live read, the single source that reflects what the owner sees.
 * In internal mode there is no Google read, so every block must be included.
 */
export function buildScheduleView(
  events: ListedEvent[],
  blocks: CalendarBlock[],
  opts: { calendarMode?: 'google' | 'internal'; lang: 'he' | 'en'; locale: string; tz: string },
): ScheduleViewEntry[] {
  const visibleBlocks = opts.calendarMode === 'google'
    ? blocks.filter((b) => !b.googleEventId)
    : blocks

  return [
    ...events.map((ev) => ({
      eventId: ev.eventId,
      title: ev.title,
      start: ev.start.toLocaleString(opts.locale, { timeZone: opts.tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
      end: ev.end.toLocaleString(opts.locale, { timeZone: opts.tz, hour: '2-digit', minute: '2-digit' }),
      isBooking: ev.isBooking,
      kind: 'booking',
      _sortTs: ev.start.getTime(),
    })),
    ...visibleBlocks.map((b) => ({
      eventId: `${BLOCK_ID_PREFIX}${b.id}`,
      title: blockLabel(b, opts.lang),
      start: b.startTs.toLocaleString(opts.locale, { timeZone: opts.tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
      end: b.endTs.toLocaleString(opts.locale, { timeZone: opts.tz, hour: '2-digit', minute: '2-digit' }),
      isBooking: false,
      kind: b.type,
      _sortTs: b.startTs.getTime(),
    })),
  ].sort((a, b) => a._sortTs - b._sortTs)
    .map(({ _sortTs: _omit, ...rest }) => rest)
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

  // Reconcile-on-read (connected Google mode): fold the owner's own Google edits —
  // events they added or deleted directly in Google Calendar — back into the
  // internal record BEFORE we read it, so both the schedule we show and the
  // availability we compute match what the owner sees in Google. Best-effort: a
  // Google hiccup must never break the read (see inbound-sync §reconcile-on-read).
  if (ctx.calendarMode === 'google') {
    await reconcileScheduleWindowOnRead(ctx.businessId, { from, to }).catch(() => { /* non-fatal */ })
  }

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

      // Over-fetch then subtract any session-rejected/avoided times so re-suggestions
      // never resurface a slot the owner already ruled out. Inert until capture exists.
      const rawSlots = await getOpenSlots(ctx.db, business, { start: from, end: to }, duration, { maxSlots: 40 })
      const slots = filterOpenSlots(rawSlots, ctx.negotiationConstraints, ctx.timezone).slice(0, 12)
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

    const formatted = buildScheduleView(events, blocks, {
      ...(ctx.calendarMode ? { calendarMode: ctx.calendarMode } : {}),
      lang: ctx.lang === 'he' ? 'he' : 'en',
      locale,
      tz,
    })

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
  // Set true ONLY after the owner has explicitly confirmed, in a business whose
  // bookingAuthority is 'owner_approval'. Ignored in 'auto' mode.
  ownerApproved?: boolean
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

  // Owner-approval gate (design 2026-06-25, §4.2). In a business whose bookingAuthority is
  // 'owner_approval', a PA/owner-initiated calendar write is held until the owner explicitly
  // confirms. First call (no ownerApproved) returns a proposal and writes NOTHING — the gap
  // forces a turn where the owner says yes; only then is the tool re-called with ownerApproved.
  // 'auto' (the default, and unset) commits straight away as before. Customer self-bookings
  // never reach this tool, so they are unaffected (decision D1).
  if (ctx.bookingAuthority === 'owner_approval' && args.ownerApproved !== true) {
    return {
      success: false,
      status: 'awaiting_owner_approval',
      proposed: { title: args.title, start: start.toISOString(), end: end.toISOString() },
      guidance: 'This business requires the owner\'s explicit OK before you write anything to the calendar. Tell the owner what you\'re about to book and ask whether to go ahead. Do NOT say it is booked. Only call createCalendarEvent again — this time with ownerApproved:true — after the owner clearly approves.',
    }
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

  // Mirror-honest wording (F-c): in google mode the event is now saved INTERNALLY
  // (authoritative) and syncing OUT to Google asynchronously — it is NOT yet in Google
  // Calendar. The PA must say "saved — syncing to your Google calendar", never claim it
  // is already on the calendar. The root cause of the live incident was the opposite:
  // a 404'd Google write while the PA reported "done". Internal mode has no Google view,
  // so a plain "saved/done" is accurate there.
  if (ctx.calendarMode === 'google') {
    return {
      success: true,
      eventId: `${BLOCK_ID_PREFIX}${block.id}`,
      mirrorStatus: 'syncing',
      guidance: "Confirm the event is saved in your records (it's set). Say it is now syncing to their Google Calendar — do NOT claim it already appears in Google Calendar, the sync happens in the background.",
    }
  }

  return { success: true, eventId: `${BLOCK_ID_PREFIX}${block.id}` }
}

// ── selectCalendar ────────────────────────────────────────────────────────────

interface SelectCalendarArgs {
  action: 'list' | 'switch'
  calendarName?: string
}

/**
 * List the connected Google account's calendars, or switch which one the PA manages
 * (F-b — "supports secondary calendars"). The active calendar lives in
 * businesses.googleCalendarId; we only ever persist a validated, writable calendar id,
 * so the phone-number-in-calendar-id bug can never recur from this path.
 *
 * Internal note: switching the active calendar does NOT migrate already-mirrored events.
 * The internal record stays authoritative; the outbound mirror + Sentinel reconcile the
 * new calendar over time. We surface that plainly to the owner.
 */
export async function executeSelectCalendar(
  args: SelectCalendarArgs,
  ctx: ToolContext,
): Promise<object> {
  const [biz] = await ctx.db
    .select({ calendarMode: businesses.calendarMode, googleCalendarId: businesses.googleCalendarId })
    .from(businesses)
    .where(eq(businesses.id, ctx.businessId))
    .limit(1)

  if (!biz || biz.calendarMode !== 'google') {
    return {
      success: false,
      reason: 'not_google_mode',
      guidance: 'The calendar is not connected to Google, so there is nothing to choose. Tell the manager they can connect Google Calendar first.',
    }
  }

  let candidates: CalendarListEntry[]
  try {
    const all = await ctx.calendar.listCalendars()
    candidates = all.filter((c) => isWritableRole(c.accessRole))
  } catch {
    return {
      success: false,
      reason: 'calendar_read_failed',
      guidance: "Couldn't read the calendar list from Google just now. Ask the manager to try again in a moment.",
    }
  }

  const activeId = biz.googleCalendarId
  const describe = (c: CalendarListEntry) => ({ name: c.summary, active: c.id === activeId })

  if (args.action === 'list' || !args.calendarName) {
    return {
      success: true,
      activeCalendar: candidates.find((c) => c.id === activeId)?.summary ?? activeId,
      calendars: candidates.map(describe),
      guidance: 'List the calendars for the manager and note which one is active. They can switch by naming another.',
    }
  }

  const resolved = resolveCalendarSwitch(candidates, args.calendarName)
  if (resolved.status === 'not_found') {
    return {
      success: false,
      needsClarification: true,
      reason: 'calendar_not_found',
      requested: args.calendarName,
      calendars: candidates.map((c) => c.summary),
      guidance: "That calendar name didn't match any writable calendar on the account. Show the manager the available names and ask which one.",
    }
  }
  if (resolved.status === 'ambiguous') {
    return {
      success: false,
      needsClarification: true,
      reason: 'calendar_ambiguous',
      matches: resolved.matches.map((c) => c.summary),
      guidance: 'Several calendars match that name. Ask the manager which one they mean.',
    }
  }

  const target = resolved.calendar
  if (target.id === activeId) {
    return { success: true, alreadyActive: true, activeCalendar: target.summary, guidance: 'That calendar is already the active one — let the manager know.' }
  }

  // Persist only a validated, writable calendar id (defence in depth alongside the
  // resolver, which already excluded read-only calendars).
  if (!isPlausibleCalendarId(target.id)) {
    return { success: false, reason: 'invalid_calendar_id', guidance: 'That calendar could not be selected. Ask the manager to try another.' }
  }

  await ctx.db.update(businesses).set({ googleCalendarId: target.id }).where(eq(businesses.id, ctx.businessId))

  await logAudit(ctx.db, {
    businessId: ctx.businessId,
    actorId: ctx.identityId,
    action: 'calendar.calendar_selected',
    entityType: 'business',
    entityId: ctx.businessId,
    metadata: { calendarId: target.id, calendarName: target.summary },
  }).catch(() => { /* best-effort */ })

  return {
    success: true,
    switchedTo: target.summary,
    guidance: 'Confirm to the manager that you will now manage that calendar. New events go there from now on; existing events stay where they are and stay correct in your records.',
  }
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

// ── blockOpenTimeAroundClasses ────────────────────────────────────────────────
// Issue 3: the owner wants "this week, customers may only book the existing classes
// — block everything else." A single atomic, idempotent call that materializes the
// complementary in-hours gaps around existing class instances as `block` rows. Two
// visibility modes (see CALENDAR_UX_DESIGN.md): 'google' = real blocked time the owner
// sees in their calendar; 'internal' (default) = off-limits hours the customer engine
// still refuses but that never clutter Google. Both still hard-stop customer bookings.

interface BlockAroundClassesArgs {
  fromDate: DatePieces
  toDate: DatePieces
  weekdays?: number[]
  visibility?: 'internal' | 'google'
}

export async function executeBlockOpenTimeAroundClasses(
  args: BlockAroundClassesArgs,
  ctx: ToolContext,
): Promise<object> {
  const now = new Date()
  const fromRes = resolveRequestedDate(toDateParts(args.fromDate), ctx.timezone, now)
  if (!fromRes.ok) return clarifyDate(fromRes.reason)
  const toRes = resolveRequestedDate(toDateParts(args.toDate), ctx.timezone, now)
  if (!toRes.ok) return clarifyDate(toRes.reason)
  if (toRes.dateStr < fromRes.dateStr) {
    return {
      success: false,
      needsClarification: true,
      guidance: 'The end date is before the start date. Ask the owner for a valid date range — do not guess.',
    }
  }

  const [biz] = await ctx.db.select().from(businesses).where(eq(businesses.id, ctx.businessId)).limit(1)
  if (!biz) return { success: false, message: 'Business not found.' }

  // Default to internal/off-limits (this case's intent). Only mirror to Google when
  // the owner explicitly wants visible blocked time. The tool description tells the
  // model to ASK once when the owner's intent is ambiguous.
  const mirror = args.visibility === 'google'

  const summary = await blockOpenTimeAroundClasses(ctx.db, biz, {
    from: fromRes.dateStr,
    to: toRes.dateStr,
    ...(args.weekdays && args.weekdays.length > 0 ? { weekdays: args.weekdays } : {}),
    mirror,
  })

  // Enqueue an outbound mirror for each created block. The worker skips internal-only
  // rows, so this is a no-op for soft blocks and a real push for visible ones.
  for (const id of summary.createdBlockIds) await enqueueBlockMirror(ctx.businessId, id)

  await logAudit(ctx.db, {
    businessId: ctx.businessId,
    actorId: ctx.identityId,
    action: 'calendar.block_around_classes',
    entityType: 'business',
    entityId: ctx.businessId,
    metadata: {
      from: fromRes.dateStr,
      to: toRes.dateStr,
      weekdays: args.weekdays ?? null,
      mirror,
      daysProcessed: summary.daysProcessed,
      blocksCreated: summary.blocksCreated,
      classesPreserved: summary.classesPreserved,
    },
  })

  return {
    success: true,
    visibility: mirror ? 'google' : 'internal',
    result: {
      daysProcessed: summary.daysProcessed,
      blocksCreated: summary.blocksCreated,
      classesPreserved: summary.classesPreserved,
      from: fromRes.dateStr,
      to: toRes.dateStr,
    },
    guidance: blockAroundClassesReplyGuidance(summary, mirror),
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
    // Read the block first: a class session may have a roster + instructor that must NOT be
    // silently orphaned by a bare delete. Cancel the bookings (notifying each customer with a
    // rebooking offer) and notify the instructor BEFORE removing the block.
    const block = await getBlockById(ctx.db, ctx.businessId, blockId)
    if (!block) {
      return { success: false, reason: 'not_found' }
    }

    let cancellation = { cancelledCount: 0, instructorNotified: false }
    if (block.type === 'class') {
      cancellation = await cancelClassSessionBookings(ctx.db, {
        businessId: ctx.businessId,
        block,
        actorId: ctx.identityId,
        lang: ctx.lang,
      })
    }

    const removed = await deleteBlockById(ctx.db, ctx.businessId, blockId)
    if (!removed) {
      return { success: false, reason: 'not_found' }
    }
    // Durable mirror: remove the corresponding Google event when one was created.
    if (removed.googleEventId) {
      await enqueueBlockDeletion(ctx.businessId, removed.id, removed.googleEventId)
    }

    if (block.type === 'class') {
      return {
        success: true,
        deleted: { what: args.confirmationHint ?? block.title ?? null },
        cancelledBookings: cancellation.cancelledCount,
        instructorNotified: cancellation.instructorNotified,
        guidance: summarizeSessionCancellation(cancellation.cancelledCount, cancellation.instructorNotified),
      }
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

// ── editClassSession ──────────────────────────────────────────────────────────

interface EditClassSessionArgs {
  eventId: string
  instructor?: string | null
  date?: DatePieces
  startTime?: TimePieces
  endTime?: TimePieces
  durationMinutes?: number
  maxParticipants?: number
}

/**
 * Edit an ALREADY-scheduled group session (calendar_blocks type='class') IN PLACE:
 * swap its instructor, move its time, or change its capacity — without the
 * delete+recreate dance that orphans the slot's bookings. Identify the session by
 * the eventId from a prior listCalendarEvents read-back. Guards: a time move is
 * refused while active bookings sit on the slot; capacity can't drop below the
 * number already booked. (WS-D D1 — manager's "change the instructor/time of this
 * session" request.)
 */
export async function executeEditClassSession(args: EditClassSessionArgs, ctx: ToolContext): Promise<object> {
  // Arg-only guards fail closed BEFORE any DB read (no work on an unactionable edit).
  const blockId = parseBlockId(args.eventId)
  if (!blockId) {
    return { success: false, reason: 'not_found', guidance: i18n.edit_session_not_found[ctx.lang]() }
  }
  const wantsInstructor = args.instructor != null && args.instructor.trim().length > 0
  const wantsTime = !!(args.date || args.startTime || args.endTime || args.durationMinutes != null)
  const wantsCapacity = args.maxParticipants != null
  if (!wantsInstructor && !wantsTime && !wantsCapacity) {
    return { success: false, needsClarification: true, message: i18n.edit_session_nothing_to_change[ctx.lang]() }
  }

  const block = await getBlockById(ctx.db, ctx.businessId, blockId)
  if (!block || block.type !== 'class') {
    return { success: false, reason: 'not_found', guidance: i18n.edit_session_not_found[ctx.lang]() }
  }

  // Active seats on this slot — identity of a class session is (serviceTypeId, slotStart).
  let bookedCount = 0
  if (block.serviceTypeId) {
    const seats = await ctx.db
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(
        eq(bookings.businessId, ctx.businessId),
        eq(bookings.serviceTypeId, block.serviceTypeId),
        eq(bookings.slotStart, block.startTs),
        inArray(bookings.state, ['held', 'pending_payment', 'confirmed']),
      ))
    bookedCount = seats.length
  }

  const patch: UpdateBlockPatch = {}

  if (wantsInstructor) {
    const found = await findProviderByName(ctx.db, ctx.businessId, args.instructor!.trim())
    if (found.status === 'none') return { success: false, needsClarification: true, message: i18n.schedule_instructor_not_found[ctx.lang](args.instructor!.trim()) }
    if (found.status === 'ambiguous') return { success: false, needsClarification: true, message: i18n.schedule_instructor_ambiguous[ctx.lang](args.instructor!.trim()) }
    patch.providerId = found.id
  }

  if (wantsTime) {
    // Don't move a session's time out from under people who booked it.
    if (bookedCount > 0) {
      return { success: false, reason: 'has_active_bookings', guidance: i18n.edit_session_time_locked_bookings[ctx.lang](bookedCount) }
    }
    // Default any unspecified piece to the session's CURRENT date/time/duration.
    const lp = localParts(block.startTs, ctx.timezone)
    const [y, mo, d] = lp.dateStr.split('-').map(Number)
    const currentDateParts: RequestedDateParts = { relativeDay: null, weekday: null, explicitDate: { year: y!, month: mo!, day: d! } }
    const currentTime: TimePieces = { hour: Math.floor(lp.minutes / 60), minute: lp.minutes % 60 }
    const currentDurationMin = Math.round((block.endTs.getTime() - block.startTs.getTime()) / 60_000)
    const resolved = resolveSlotRange(
      {
        date: args.date ? toDateParts(args.date) : currentDateParts,
        startTime: args.startTime ?? currentTime,
        endTime: args.endTime ?? null,
        durationMinutes: args.durationMinutes ?? (args.endTime ? null : currentDurationMin),
      },
      ctx.timezone,
      new Date(),
    )
    if (!resolved.ok) return clarifyDate(resolved.reason)
    patch.start = resolved.start
    patch.end = resolved.end
  }

  if (wantsCapacity) {
    if (args.maxParticipants! < bookedCount) {
      return { success: false, reason: 'capacity_below_booked', guidance: i18n.edit_session_capacity_below_booked[ctx.lang](bookedCount) }
    }
    patch.maxParticipants = args.maxParticipants!
  }

  const updated = await updateBlock(ctx.db, ctx.businessId, block.id, patch)
  if (!updated) return { success: false, reason: 'not_found', guidance: i18n.edit_session_not_found[ctx.lang]() }

  await enqueueBlockMirror(ctx.businessId, updated.id)

  const locale = ctx.lang === 'he' ? 'he-IL' : 'en-GB'
  const when = updated.startTs.toLocaleString(locale, { timeZone: ctx.timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  return {
    success: true,
    updated: {
      what: updated.title ?? null,
      when,
      instructorChanged: wantsInstructor,
      timeChanged: wantsTime,
      maxParticipants: updated.maxParticipants ?? null,
    },
    guidance: 'The session was changed in place (its bookings are intact). Confirm what changed to the manager in your own words; after a customer-facing change, offer to notify the booked participants.',
  }
}

// ── scheduleRecurringClasses ──────────────────────────────────────────────────

interface RecurringClassSpec {
  serviceName: string
  instructor?: string
  daysOfWeek: number[]
  times: TimePieces[]
  durationMinutes?: number
  maxParticipants?: number
  startDate?: DatePieces
  endDate?: DatePieces
}
interface ScheduleRecurringClassesArgs {
  classes: RecurringClassSpec[]
}

// Cap one batch so a pathological "every minute" request can't blow up the DB.
const MAX_SERIES_PER_BATCH = 200
// Materialize only the near horizon synchronously; the series-materializer worker
// rolls each series forward to the full horizon afterwards.
const BATCH_HORIZON_DAYS = 28

// Google Calendar event colorIds (1–11) handed out to class services so different
// class types render in distinct colors. Ordered for visual contrast; '2' (the
// default green used for confirmed one-off bookings) is intentionally excluded so
// classes stay visually distinct from regular appointments.
const CLASS_COLOR_PALETTE = [11, 9, 5, 7, 3, 10, 6, 8, 1, 4] as const

function fmtTime(t: TimePieces): string {
  return `${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`
}

/**
 * Set up MANY recurring weekly classes from one instruction — e.g. "yoga and
 * pilates every hour 09:00–20:00 Sunday–Thursday". The orchestrator expands the
 * request into explicit specs (service × daysOfWeek × times); this executor loops
 * createSeries for each (service, day, time), idempotently (an active series for
 * the same slot is skipped, so re-running never duplicates). Reuses the WS-C
 * cap-must-be>1 guard and instructor resolution; collects per-service counts and a
 * skipped list with reasons. (WS-D D2.)
 */
export async function executeScheduleRecurringClasses(args: ScheduleRecurringClassesArgs, ctx: ToolContext): Promise<object> {
  const specs = Array.isArray(args.classes) ? args.classes : []
  if (specs.length === 0) {
    return { success: false, needsClarification: true, guidance: 'No classes were given. Ask the manager which weekly classes to set up — service, which days, and what times.' }
  }

  const now = new Date()
  const defaultStartDate = localParts(now, ctx.timezone).dateStr

  // Sanity cap on total weekly series in one call.
  let plannedTuples = 0
  for (const s of specs) plannedTuples += (Array.isArray(s.daysOfWeek) ? s.daysOfWeek.length : 0) * (Array.isArray(s.times) ? s.times.length : 0)
  if (plannedTuples > MAX_SERIES_PER_BATCH) {
    return { success: false, needsClarification: true, guidance: `That works out to ${plannedTuples} separate weekly classes at once — a lot to create blindly. Ask the manager to confirm or narrow it (fewer days or times) before setting them all up.` }
  }

  let seriesCreated = 0
  let instancesCreated = 0
  const skipped: Array<{ what: string; reason: string }> = []
  const createdByService: Record<string, number> = {}

  // Per-type colors (owner request: "פילאטיס בצבע אחד ושיעורי יוגה בצבע אחר"). The
  // block→Google mirror already paints each event with serviceTypes.colorId, but
  // class setup never assigned one, so every class defaulted to the same green.
  // Seed the "used" set from colors already on this business's services, then hand
  // out a distinct Google colorId (1–11) to each class service that lacks one.
  const usedColorRows = await ctx.db
    .select({ colorId: serviceTypes.colorId })
    .from(serviceTypes)
    .where(and(eq(serviceTypes.businessId, ctx.businessId), eq(serviceTypes.isActive, true)))
  const usedColors = new Set<number>(usedColorRows.map((r) => r.colorId).filter((c): c is number => c != null))
  const nextColorId = (): number | null => {
    const next = CLASS_COLOR_PALETTE.find((c) => !usedColors.has(c))
    if (next == null) return null
    usedColors.add(next)
    return next
  }

  for (const spec of specs) {
    const name = (spec.serviceName ?? '').trim()
    const days = Array.isArray(spec.daysOfWeek) ? spec.daysOfWeek.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6) : []
    const times = Array.isArray(spec.times) ? spec.times.filter((t) => t && Number.isInteger(t.hour)) : []
    if (!name || days.length === 0 || times.length === 0) {
      skipped.push({ what: name || 'class', reason: 'incomplete' })
      continue
    }

    const [svc] = await ctx.db
      .select({ id: serviceTypes.id, name: serviceTypes.name, durationMinutes: serviceTypes.durationMinutes, maxParticipants: serviceTypes.maxParticipants, colorId: serviceTypes.colorId, schedulingMode: serviceTypes.schedulingMode })
      .from(serviceTypes)
      .where(and(eq(serviceTypes.businessId, ctx.businessId), eq(serviceTypes.isActive, true), ilike(serviceTypes.name, `%${name}%`)))
      .limit(1)
    if (!svc) { skipped.push({ what: name, reason: 'service_not_found' }); continue }

    // WS-C invariant: a class needs a real group capacity (>1).
    const cap = spec.maxParticipants ?? svc.maxParticipants ?? 1
    if (cap <= 1) { skipped.push({ what: svc.name, reason: 'needs_capacity' }); continue }

    // Bug E: make this service schedule-driven so customers can only book INTO the
    // scheduled class instances (not arbitrary open times), and lift its default
    // capacity to the class size so the whole booking stack routes it as a group
    // class. Without this the service stayed cap-1/'appointment' and customers were
    // booked private appointments at times with no class. Idempotent.
    if ((svc.maxParticipants ?? 1) < cap || svc.schedulingMode !== 'class') {
      await ctx.db
        .update(serviceTypes)
        .set({ maxParticipants: Math.max(svc.maxParticipants ?? 1, cap), schedulingMode: 'class' })
        .where(eq(serviceTypes.id, svc.id))
    }

    // Give this class service a distinct Google Calendar color if it has none yet,
    // so different class types render in different colors (owner request). Best-effort.
    if (svc.colorId == null) {
      const color = nextColorId()
      if (color != null) {
        await ctx.db.update(serviceTypes).set({ colorId: color }).where(eq(serviceTypes.id, svc.id))
        usedColors.add(color)
      }
    }

    let providerId: string | null = null
    if (spec.instructor && spec.instructor.trim().length > 0) {
      const found = await findProviderByName(ctx.db, ctx.businessId, spec.instructor.trim())
      if (found.status === 'none') { skipped.push({ what: `${svc.name} (${spec.instructor.trim()})`, reason: 'instructor_not_found' }); continue }
      if (found.status === 'ambiguous') { skipped.push({ what: `${svc.name} (${spec.instructor.trim()})`, reason: 'instructor_ambiguous' }); continue }
      providerId = found.id
    }

    let startDate = defaultStartDate
    if (spec.startDate) {
      const r = resolveRequestedDate(toDateParts(spec.startDate), ctx.timezone, now)
      if (r.ok) startDate = r.dateStr
    }
    let endDate: string | null = null
    if (spec.endDate) {
      const r = resolveRequestedDate(toDateParts(spec.endDate), ctx.timezone, now)
      if (r.ok) endDate = r.dateStr
    }

    for (const dow of days) {
      for (const t of times) {
        const startTime = fmtTime(t)
        // Idempotency: an active series for this exact slot already exists → skip.
        const [existing] = await ctx.db
          .select({ id: classSeries.id })
          .from(classSeries)
          .where(and(
            eq(classSeries.businessId, ctx.businessId),
            eq(classSeries.serviceTypeId, svc.id),
            eq(classSeries.dayOfWeek, dow),
            eq(classSeries.startTime, startTime),
            eq(classSeries.isActive, true),
          ))
          .limit(1)
        if (existing) { skipped.push({ what: `${svc.name} ${startTime}`, reason: 'already_exists' }); continue }

        const { created } = await createSeries(ctx.db, {
          businessId: ctx.businessId,
          serviceTypeId: svc.id,
          providerId,
          dayOfWeek: dow,
          startTime,
          durationMinutes: spec.durationMinutes ?? svc.durationMinutes,
          maxParticipants: cap,
          title: svc.name,
          startDate,
          endDate,
          timezone: ctx.timezone,
        }, { horizonDays: BATCH_HORIZON_DAYS })
        seriesCreated++
        instancesCreated += created
        createdByService[svc.name] = (createdByService[svc.name] ?? 0) + 1
      }
    }
  }

  if (seriesCreated === 0) {
    return {
      success: false,
      skipped,
      guidance: 'Nothing was created. Tell the manager what was skipped and why (unknown service, a private service that needs a group capacity, or an unknown instructor) in your own words, and offer to fix it.',
    }
  }
  return {
    success: true,
    created: { series: seriesCreated, instances: instancesCreated, byService: createdByService },
    skipped,
    guidance: 'Recurring weekly classes are set up and the first weeks are on the internal calendar (the rest roll out automatically). They are syncing to the connected Google Calendar now and will appear there within a moment — do NOT claim they are already fully synced/visible in Google. Summarize for the manager in your own words — how many of which class, plus anything skipped and why. Offer to adjust or notify customers.',
  }
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
  queryType: 'find_by_name' | 'find_by_phone' | 'booking_history' | 'recent_messages' | 'segment'
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
        lastName: identities.lastName,
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

  if (queryType === 'recent_messages') {
    if (!identifier) return { error: 'identifier (phone, name, or identityId) is required' }

    // Resolve to an identityId from phone / name / id.
    let identityId = identifier
    if (identifier.startsWith('+') || /^\d{7,}$/.test(identifier)) {
      const [id] = await ctx.db
        .select({ id: identities.id })
        .from(identities)
        .where(and(eq(identities.businessId, ctx.businessId), eq(identities.phoneNumber, identifier)))
        .limit(1)
      if (!id) return { found: false }
      identityId = id.id
    } else if (!/^[0-9a-f-]{36}$/i.test(identifier)) {
      const [id] = await ctx.db
        .select({ id: identities.id })
        .from(identities)
        .where(and(eq(identities.businessId, ctx.businessId), ilike(identities.displayName, `%${identifier}%`)))
        .limit(1)
      if (!id) return { found: false }
      identityId = id.id
    }

    const msgs = await ctx.db
      .select({ role: conversationMessages.role, text: conversationMessages.text, at: conversationMessages.createdAt })
      .from(conversationMessages)
      .innerJoin(conversationSessions, eq(conversationMessages.sessionId, conversationSessions.id))
      .where(and(eq(conversationSessions.businessId, ctx.businessId), eq(conversationSessions.identityId, identityId)))
      .orderBy(desc(conversationMessages.createdAt))
      .limit(8)

    // Ground truth for "did the customer reply?" — read it here, never guess. A proactive
    // outreach sent via messageCustomer is not in this thread; the customer REPLYING shows
    // up as customer-role turns. No customer turns = they have not written back yet.
    const customerHasReplied = msgs.some((m) => m.role === 'customer')
    return {
      found: true,
      customerHasReplied,
      messages: msgs
        .slice()
        .reverse()
        .map((m) => ({
          from: m.role === 'customer' ? 'customer' : 'assistant',
          text: m.text,
          at: m.at.toLocaleString(ctx.lang === 'he' ? 'he-IL' : 'en-GB', { timeZone: ctx.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }),
        })),
    }
  }

  if (queryType === 'segment') {
    // One shared reader (segment-repository) — derives real per-customer profiles, not the
    // old zero-stub / partial post-filter. Behavioral filters (lapsed, preferredDay/Band)
    // are honored when present; the manager LLM still passes the basic subset today.
    const summaries = await queryCustomerSegment(ctx.db, ctx.businessId, args.segmentFilter ?? {}, ctx.timezone)
    return {
      count: summaries.length,
      customers: summaries.slice(0, 20).map((s) => ({
        id: s.identityId,
        displayName: s.displayName,
        phoneNumber: s.phoneNumber,
        totalBookings: s.totalBookings,
        lastBookingAt: s.lastBookingAt,
      })),
    }
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

// ── setCustomerName ───────────────────────────────────────────────────────────

// Owner sets/corrects a customer's name (e.g. after disambiguating two same-name customers, or
// fixing a typo). Authorization-gated like other customer-management actions. Derives the last
// name from displayName when the owner gives only a full name and no explicit lastName.
interface SetCustomerNameArgs {
  identityId?: string
  displayName?: string
  lastName?: string
}

export async function executeSetCustomerName(args: SetCustomerNameArgs, ctx: ToolContext): Promise<object> {
  const auth = authorize(
    { role: ctx.role ?? 'manager', ...(ctx.delegatedPermissions ? { delegatedPermissions: ctx.delegatedPermissions } : {}) },
    'customer.manage',
  )
  if (!auth.allowed) {
    return { ok: false, reason: 'not_authorized', guidance: 'This person is not allowed to edit customer details. Tell them only the owner (or granted staff) can do that.' }
  }
  if (!args.identityId) {
    return { ok: false, reason: 'no_target', guidance: 'Look up the customer first (lookupCustomer) to get their id, then set the name.' }
  }
  const displayName = args.displayName?.trim()
  const lastName = args.lastName?.trim() || deriveLastName(displayName ?? null) || undefined
  if (!displayName && !lastName) {
    return { ok: false, reason: 'nothing_to_set', guidance: 'Ask the owner what name to save (a first/display name and optionally a last name).' }
  }
  await setCustomerName(ctx.db, ctx.businessId, args.identityId, {
    ...(displayName !== undefined ? { displayName } : {}),
    ...(lastName !== undefined ? { lastName } : {}),
  })
  return { ok: true, guidance: 'Tell the owner the name is saved, in your own words.' }
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

// ── Freed-slot owner-approval gate (WS-C / #6 / #8) ──────────────────────────────

interface DecideFreedSlotOfferArgs {
  // Approve or decline offering the freed slot to the people waiting.
  decision: 'offer' | 'leave_open'
  // Optional standing preference for future freed slots.
  setStandingPreference?: 'always_auto' | 'always_ask' | 'never'
}

/** The most recent freed slot still awaiting the owner's decision (not yet past). */
async function latestPendingFreedSlot(ctx: ToolContext) {
  const [row] = await ctx.db
    .select({
      id: freedSlotApprovals.id,
      serviceTypeId: freedSlotApprovals.serviceTypeId,
      slotStart: freedSlotApprovals.slotStart,
      slotEnd: freedSlotApprovals.slotEnd,
      candidateCount: freedSlotApprovals.candidateCount,
    })
    .from(freedSlotApprovals)
    .where(
      and(
        eq(freedSlotApprovals.businessId, ctx.businessId),
        eq(freedSlotApprovals.status, 'pending'),
        gt(freedSlotApprovals.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(freedSlotApprovals.createdAt))
    .limit(1)
  return row ?? null
}

export async function executeDecideFreedSlotOffer(
  args: DecideFreedSlotOfferArgs,
  ctx: ToolContext,
): Promise<object> {
  // Setting a standing preference is allowed on its own, with or without a pending slot.
  let prefNote = ''
  if (args.setStandingPreference) {
    const policy =
      args.setStandingPreference === 'always_auto' ? 'auto'
      : args.setStandingPreference === 'never' ? 'never'
      : 'ask'
    await ctx.db.update(businesses).set({ freedSlotOfferPolicy: policy }).where(eq(businesses.id, ctx.businessId))
    await logAudit(ctx.db, {
      businessId: ctx.businessId,
      actorId: ctx.identityId,
      action: 'waitlist.policy_set',
      entityType: 'business',
      entityId: ctx.businessId,
      metadata: { policy },
    }).catch(() => { /* best-effort */ })
    prefNote =
      policy === 'auto' ? ' From now on, freed slots will be offered automatically.'
      : policy === 'never' ? ' From now on, freed slots will not be offered.'
      : ' From now on, I will ask you each time.'
  }

  const pending = await latestPendingFreedSlot(ctx)
  if (!pending) {
    if (args.setStandingPreference) {
      return { success: true, fact: `Preference saved.${prefNote}`, guidance: 'Confirm the new preference to the owner in your own words. There is no freed slot waiting right now.' }
    }
    return { success: false, reason: 'no_pending_freed_slot', guidance: 'There is no freed slot waiting for a decision. Tell the owner that plainly.' }
  }

  if (args.decision === 'offer') {
    await ctx.db
      .update(freedSlotApprovals)
      .set({ status: 'approved', decidedAt: new Date() })
      .where(eq(freedSlotApprovals.id, pending.id))
    await triggerWaitlistForSlot(ctx.businessId, pending.serviceTypeId, pending.slotStart, pending.slotEnd)
    await logAudit(ctx.db, {
      businessId: ctx.businessId,
      actorId: ctx.identityId,
      action: 'waitlist.offer_approved',
      entityType: 'booking',
      metadata: { slotStart: pending.slotStart.toISOString(), waiting: pending.candidateCount },
    }).catch(() => { /* best-effort */ })
    return {
      success: true,
      fact: `Offering the freed slot to ${pending.candidateCount} waiting customer(s).${prefNote}`,
      guidance: "Tell the owner you're now offering the slot to the people waiting — the first in line is next to be contacted. Do NOT claim the message has already been delivered.",
    }
  }

  await ctx.db
    .update(freedSlotApprovals)
    .set({ status: 'declined', decidedAt: new Date() })
    .where(eq(freedSlotApprovals.id, pending.id))
  await logAudit(ctx.db, {
    businessId: ctx.businessId,
    actorId: ctx.identityId,
    action: 'waitlist.offer_declined',
    entityType: 'booking',
    metadata: { slotStart: pending.slotStart.toISOString(), waiting: pending.candidateCount },
  }).catch(() => { /* best-effort */ })
  return {
    success: true,
    fact: `Left the slot open.${prefNote}`,
    guidance: 'Confirm to the owner the slot stays open and no one was offered it.',
  }
}

// ── Integrity Sentinel: on-demand "is everything correct?" (WS-B / WS-F) ─────────

export async function executeCheckCalendarIntegrity(
  _args: Record<string, never>,
  ctx: ToolContext,
): Promise<object> {
  // Refresh on demand so the answer reflects reality right now, then report the open
  // findings. The result IS the grounding for any "all clear" claim — never assert this
  // from memory (L1/L2 grounding contract).
  const open = await runSentinelForBusiness(ctx.businessId)
  if (open.length === 0) {
    return {
      success: true,
      clear: true,
      fact: 'Calendar integrity check passed — no issues found.',
      guidance: 'Tell the owner everything checks out and there are no calendar problems right now. This was just verified against the calendar, not assumed.',
    }
  }
  const critical = open.filter((f) => f.severity === 'critical')
  return {
    success: true,
    clear: false,
    criticalCount: critical.length,
    warningCount: open.length - critical.length,
    findings: open.slice(0, 10).map((f) => ({
      kind: f.kind,
      severity: f.severity,
      slotStart: f.slotStart?.toISOString() ?? null,
      detail: f.detail,
    })),
    guidance: 'Report the issues to the owner plainly with their severity. Do not minimize critical issues; offer to help resolve them.',
  }
}

// ── Reshuffle engine: owner gate + config ───────────────────────────────────────

/** Find the most recent proposal awaiting the owner's decision for this business. */
async function latestPendingProposal(ctx: ToolContext): Promise<{ id: string; touchedCount: number; kind: string } | null> {
  const [row] = await ctx.db
    .select({ id: reshuffleProposals.id, touchedCount: reshuffleProposals.touchedCount, kind: reshuffleProposals.kind })
    .from(reshuffleProposals)
    .innerJoin(reshuffleCampaigns, eq(reshuffleProposals.campaignId, reshuffleCampaigns.id))
    .where(and(eq(reshuffleCampaigns.businessId, ctx.businessId), inArray(reshuffleProposals.status, ['pending', 'amended'])))
    .orderBy(desc(reshuffleProposals.presentedToOwnerAt))
    .limit(1)
  return row ?? null
}

export async function executeApproveReshuffle(_args: Record<string, never>, ctx: ToolContext): Promise<object> {
  const proposal = await latestPendingProposal(ctx)
  if (!proposal) return { success: false, reason: 'no_pending_proposal', guidance: 'There is no reshuffle plan waiting for approval. Tell the owner that plainly.' }
  const res = await approveProposal(ctx.db, proposal.id, new Date())
  if (!res.ok) return { success: false, reason: res.reason, guidance: 'The plan could not be applied (it may be stale). Tell the owner and offer to re-run the search. reason is raw — phrase it naturally.' }
  return { success: true, fact: `Applied ${res.movedCount} move(s).`, guidance: 'The swap is live and everyone moved was already in agreement. Confirm to the owner in your own words.' }
}

export async function executeRejectReshuffle(_args: Record<string, never>, ctx: ToolContext): Promise<object> {
  const proposal = await latestPendingProposal(ctx)
  if (!proposal) return { success: false, reason: 'no_pending_proposal', guidance: 'There is no reshuffle plan waiting. Tell the owner plainly.' }
  const res = await rejectProposal(ctx.db, proposal.id, new Date())
  if (!res.ok) return { success: false, reason: res.reason }
  return { success: true, fact: 'Plan rejected; nothing changed.', guidance: 'Confirm to the owner that nothing changed and anyone contacted will be told never mind.' }
}

// ── Proactive-proposal owner gate (win-back etc.) ───────────────────────────────
//
// The win-back detector PROPOSES to the owner (proposeInitiation records a pending
// initiationApprovals row + pings the owner) and never messages the customer on its own
// judgement. This tool closes the loop: the owner says "yes, send it" / "no, she's away"
// and we resolve the pending proposal via resolveInitiationProposal — which is what
// actually phrases + sends (or records the decline) and is idempotent under a double-tap.
//
// Authorization mirrors executeApproveReshuffle: no extra role gate here — the orchestrator
// only reaches Branch-3 tools for an owner/manager (or a granted delegate).

interface ResolveProactiveProposalArgs {
  decision: 'approve' | 'decline'
  recipientName?: string
}

export async function executeResolveProactiveProposal(
  args: ResolveProactiveProposalArgs,
  ctx: ToolContext,
): Promise<object> {
  // Pending proposals for this business that have not expired (expiresAt null or future).
  const rows = await ctx.db
    .select({
      id: initiationApprovals.id,
      ownerSummary: initiationApprovals.ownerSummary,
      displayName: identities.displayName,
    })
    .from(initiationApprovals)
    .leftJoin(identities, eq(initiationApprovals.recipientId, identities.id))
    .where(and(
      eq(initiationApprovals.businessId, ctx.businessId),
      eq(initiationApprovals.status, 'pending'),
      or(isNull(initiationApprovals.expiresAt), gt(initiationApprovals.expiresAt, new Date())),
    ))
    .orderBy(desc(initiationApprovals.createdAt))

  // Narrow by name when the owner named someone ("yes, message Dana").
  const wanted = args.recipientName?.trim().toLowerCase()
  const candidates = wanted
    ? rows.filter((r) => (r.displayName ?? '').toLowerCase().includes(wanted))
    : rows

  if (candidates.length === 0) {
    return { ok: false, reason: 'no_pending_proposals', guidance: 'There is no proactive suggestion waiting for a decision (matching that name, if one was given). Tell the owner that plainly.' }
  }

  if (candidates.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      pending: candidates.map((r) => ({ recipient: r.displayName ?? null, summary: r.ownerSummary })),
      guidance: 'Several proactive suggestions are waiting. List who they are for and ask the owner which one to act on.',
    }
  }

  const candidate = candidates[0]!
  const res = await resolveInitiationProposal(ctx.db, candidate.id, args.decision)
  if (!res.ok) {
    // Resolved out from under us (already decided / expired) since the read above.
    return { ok: false, reason: 'not_pending', guidance: 'That suggestion is no longer waiting (it was already handled or expired). Tell the owner plainly.' }
  }

  if (res.outcome === 'unreachable') {
    return {
      ok: true,
      recipient: candidate.displayName ?? null,
      decision: args.decision,
      outcome: 'unreachable',
      guidance: 'You approved the outreach, but the customer can\'t be messaged right now (more than 24h since they last wrote, and no template exists to reopen contact). The message was NOT sent. Tell the owner it is approved but couldn\'t go out yet, and you\'ll reach them once they message first.',
    }
  }

  return {
    ok: true,
    recipient: candidate.displayName ?? null,
    decision: args.decision,
    outcome: res.outcome,
    guidance: res.outcome === 'sent'
      ? 'The check-in was actually sent. Confirm to the owner in your own words and offer to update them when the customer replies.'
      : 'The suggestion was declined and nothing was sent. Confirm to the owner plainly.',
  }
}

// ── resolveBookingApproval ────────────────────────────────────────────────────

interface ResolveBookingApprovalArgs {
  decision: 'approve' | 'decline'
  customerHint?: string
  serviceHint?: string
  bookingId?: string
}

/**
 * Free-text resolution of a customer self-booking that is HELD for the owner's approval
 * (design 2026-06-25, §4). Looks up THIS business's pending requests, maps the owner's reply onto
 * exactly one (by customer / service / explicit id), and calls the deterministic resolver. Several
 * pending + an ambiguous reference → returns a disambiguation prompt rather than guessing.
 */
export async function executeResolveBookingApproval(
  args: ResolveBookingApprovalArgs,
  ctx: ToolContext,
): Promise<object> {
  const rows = await ctx.db
    .select({
      bookingId: bookings.id,
      slotStart: bookings.slotStart,
      customerName: identities.displayName,
      customerPhone: identities.phoneNumber,
      serviceName: serviceTypes.name,
    })
    .from(bookings)
    .leftJoin(identities, eq(bookings.customerId, identities.id))
    .leftJoin(serviceTypes, eq(bookings.serviceTypeId, serviceTypes.id))
    .where(and(
      eq(bookings.businessId, ctx.businessId),
      eq(bookings.state, 'held'),
      eq(bookings.approvalStatus, 'pending'),
    ))
    .orderBy(bookings.slotStart)

  const locale = ctx.lang === 'he' ? 'he-IL' : 'en-GB'
  const candidates: PendingApprovalCandidate[] = rows.map((r) => ({
    bookingId: r.bookingId,
    customerName: r.customerName ?? null,
    customerPhone: r.customerPhone ?? null,
    serviceName: r.serviceName ?? null,
    slotLabel: r.slotStart.toLocaleString(locale, { timeZone: ctx.timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
  }))

  const selection = selectPendingApproval(candidates, {
    bookingId: args.bookingId ?? null,
    customerHint: args.customerHint ?? null,
    serviceHint: args.serviceHint ?? null,
  })

  if (selection.kind === 'none') {
    return {
      success: false,
      reason: 'no_pending_request',
      guidance: 'There is no customer booking request waiting for your approval (matching what was said, if anything). Tell the owner plainly.',
    }
  }

  if (selection.kind === 'ambiguous') {
    return {
      success: false,
      reason: 'ambiguous',
      pending: selection.candidates.map((c) => ({ customer: c.customerName ?? c.customerPhone, service: c.serviceName, when: c.slotLabel })),
      guidance: 'Several booking requests are waiting for approval. List who they are for (customer, service, time) and ask the owner which one they mean — do not guess.',
    }
  }

  const chosen = selection.booking
  const res = await resolveBookingApproval(ctx.db, chosen.bookingId, args.decision, ctx.identityId)
  if (!res.ok) {
    // Resolved out from under us (already decided / expired) since the read above.
    return { success: false, reason: 'not_pending', guidance: 'That request is no longer waiting for a decision (it was already handled or expired). Tell the owner plainly.' }
  }

  const who = chosen.customerName ?? chosen.customerPhone ?? (ctx.lang === 'he' ? 'הלקוח' : 'the customer')
  const svc = chosen.serviceName ?? (ctx.lang === 'he' ? 'התור' : 'the appointment')
  if (res.outcome === 'declined') {
    return {
      success: true,
      outcome: 'declined',
      fact: i18n.approval_resolved_declined_owner[ctx.lang](who, svc),
      guidance: 'The request was declined, the slot released, and the customer told (with an invitation to rebook). fact is raw — confirm it to the owner in your own words.',
    }
  }
  return {
    success: true,
    outcome: res.outcome, // 'confirmed' | 'pending_payment'
    fact: i18n.approval_resolved_confirmed_owner[ctx.lang](who, svc),
    guidance: res.outcome === 'pending_payment'
      ? 'You approved the request; because this service is paid, the customer now gets a pay-link and the booking confirms on payment. Tell the owner it is approved and awaiting payment, in your own words.'
      : 'You approved the request: it is now booked, mirrored to the calendar, and the customer has been notified. Confirm to the owner in your own words.',
  }
}

interface ConfigureReshuffleArgs {
  enabled?: boolean
  approvalMode?: 'require_approval' | 'auto_apply'
  batchSize?: number
  maxChainLength?: number
  maxOutreachPerCampaign?: number
  protectWindowHours?: number
  protectVip?: boolean
  contactScope?: 'conflicting_only' | 'service_match' | 'all_booked'
}

export async function executeConfigureReshuffle(args: ConfigureReshuffleArgs, ctx: ToolContext): Promise<object> {
  // Strip undefined keys so only what the owner specified is patched.
  const patch: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args)) if (v !== undefined) patch[k] = v
  if (Object.keys(patch).length === 0) return { success: false, reason: 'nothing_to_change', guidance: 'Ask the owner which reshuffle setting they want to change.' }

  const res = await applyReshuffleConfigUpdate(ctx.db, ctx.businessId, patch, ctx.identityId)
  if (!res.ok) return { success: false, reason: res.reason }
  return { success: true, fact: JSON.stringify(res.config), guidance: 'Settings saved. Confirm the change to the owner in plain words (fact is raw config — never quote it).' }
}

interface ConfigureNotificationsArgs {
  event: NotificationEvent
  action?: NotificationAction
  withinHours?: number
  remove?: boolean
}

export async function executeConfigureNotifications(args: ConfigureNotificationsArgs, ctx: ToolContext): Promise<object> {
  if (!args.event) return { success: false, reason: 'missing_event', guidance: 'Ask the owner which event they want to change notifications for.' }

  const [biz] = await ctx.db
    .select({ notificationRules: businesses.notificationRules })
    .from(businesses)
    .where(eq(businesses.id, ctx.businessId))
    .limit(1)
  const current = (biz?.notificationRules as NotificationRule[] | null) ?? null

  let next: NotificationRule[]
  if (args.remove === true) {
    next = removeNotificationRule(current, args.event)
  } else {
    if (!args.action) return { success: false, reason: 'missing_action', guidance: "Ask the owner whether to notify, notify with action buttons, or handle this event silently." }
    const rule: NotificationRule = { event: args.event, action: args.action }
    if (args.withinHours !== undefined) rule.condition = { withinHours: args.withinHours }
    next = upsertNotificationRule(current, rule)
  }

  await ctx.db.update(businesses).set({ notificationRules: next as unknown as Record<string, unknown>[] }).where(eq(businesses.id, ctx.businessId))
  await logAudit(ctx.db, { businessId: ctx.businessId, actorId: ctx.identityId, action: 'notification_rules.updated', entityType: 'business', entityId: ctx.businessId, metadata: { event: args.event, removed: args.remove === true } })

  return { success: true, fact: JSON.stringify(next), guidance: 'Notification rule saved. Confirm the change to the owner in plain words (fact is raw config — never quote it).' }
}

interface ConfigurePaymentTimingArgs {
  policy?: PaymentLinkSendPolicy
  offsetMinutes?: number
}

// Owner-configurable pay-link timing (Grow Phase 3, §3.1): the owner says WHEN the first
// pay-link goes out relative to the appointment ("send pay-links 24h before the session",
// "send it at booking", "1 hour after the appointment"). The LLM converts the phrase into a
// policy + a minute offset (negative = before slot_start, positive = after); the deterministic
// applyPaymentTimingUpdate clamps and persists it.
export async function executeConfigurePaymentTiming(args: ConfigurePaymentTimingArgs, ctx: ToolContext): Promise<object> {
  if (args.policy !== 'at_booking' && args.policy !== 'offset') {
    return { success: false, reason: 'missing_policy', guidance: 'Ask the owner whether to send pay-links right when the booking is made, or a set time before/after the appointment.' }
  }
  if (args.policy === 'offset' && (args.offsetMinutes == null || !Number.isFinite(args.offsetMinutes))) {
    return { success: false, reason: 'missing_offset', guidance: 'Ask the owner how long before or after the appointment to send the pay-link (you pass minutes — negative for before, positive for after).' }
  }

  const res = await applyPaymentTimingUpdate(
    ctx.db,
    ctx.businessId,
    { policy: args.policy, ...(args.offsetMinutes != null ? { offsetMinutes: args.offsetMinutes } : {}) },
    ctx.identityId,
  )
  if (!res.ok) return { success: false, reason: res.reason }
  return { success: true, fact: JSON.stringify(res), guidance: 'Pay-link timing saved. Confirm the change to the owner in plain words (e.g. "I\'ll send pay-links 24 hours before each appointment") — fact is raw config, never quote it.' }
}

interface SetInitiationAutonomyArgs {
  category: string
  mode: 'auto' | 'ask'
}

// Trust-ratchet owner control (Phase 6.2): the owner sets whether a proactive-outreach category is
// handled automatically (owner_configured) or proposed for approval each time (ai_proposed). 'ask'
// sets vetoed=true so the ratchet will not auto-promote this category again.
export async function executeSetInitiationAutonomy(args: SetInitiationAutonomyArgs, ctx: ToolContext): Promise<object> {
  if (!args.category || (args.mode !== 'auto' && args.mode !== 'ask')) {
    return { success: false, reason: 'invalid_args', guidance: 'Ask the owner which outreach category and whether to handle it automatically or keep asking.' }
  }
  if (args.mode === 'auto') {
    await setAutonomyState(ctx.db, ctx.businessId, args.category, 'owner_configured')
  } else {
    await setAutonomyState(ctx.db, ctx.businessId, args.category, 'ai_proposed', { vetoed: true })
  }
  await logAudit(ctx.db, { businessId: ctx.businessId, actorId: ctx.identityId, action: 'initiation.autonomy_set', entityType: 'initiation_autonomy', entityId: args.category, metadata: { mode: args.mode } })
  return { success: true, fact: JSON.stringify({ category: args.category, mode: args.mode }), guidance: 'Saved. Confirm to the owner in plain words (fact is raw — never quote it).' }
}

interface AmendReshuffleArgs {
  change: string
}

export async function executeAmendReshuffle(args: AmendReshuffleArgs, ctx: ToolContext): Promise<object> {
  // Amend (decision D3) re-validates a modified plan and re-consents affected customers.
  // The re-solve-on-amendment backing is not built yet, so we never silently apply a tweak:
  // record the request and tell the owner it needs a fresh search rather than fake success.
  const proposal = await latestPendingProposal(ctx)
  if (!proposal) return { success: false, reason: 'no_pending_proposal' }
  return {
    success: false,
    reason: 'amend_not_yet_supported',
    requestedChange: args.change,
    guidance: 'Tell the owner you can approve or reject this plan as-is, and that tweaking it (then re-checking with the affected customers) is coming soon — do not imply the tweak was applied.',
  }
}

// ── connectGoogleCalendar ───────────────────────────────────────────────────────

// The PA's only way to connect Google Calendar post-onboarding. Without this tool
// the orchestrator has no link to offer and the model fabricates one ("I emailed
// it") — there is no email channel anywhere in the system. Returns the real OAuth
// URL for the PA to send IN WHATSAPP.
function publicBaseUrl(): string {
  const explicit = process.env['PUBLIC_BASE_URL']
  if (explicit) return explicit.replace(/\/$/, '')
  // Fall back to the OAuth redirect's origin so the link is always correct even if
  // PUBLIC_BASE_URL is unset (the redirect URI is required for OAuth to work at all).
  const redirect = process.env['GOOGLE_REDIRECT_URI']
  if (redirect) {
    try { return new URL(redirect).origin } catch { /* ignore */ }
  }
  return ''
}

export async function executeConnectGoogleCalendar(
  _args: Record<string, never>,
  ctx: ToolContext,
): Promise<object> {
  const [biz] = await ctx.db
    .select({ refreshToken: businesses.googleRefreshToken, calendarMode: businesses.calendarMode })
    .from(businesses)
    .where(eq(businesses.id, ctx.businessId))
    .limit(1)

  if (biz?.refreshToken && biz.calendarMode === 'google') {
    return {
      ok: true,
      alreadyConnected: true,
      guidance: 'Google Calendar is already connected and syncing for this business. Reassure the owner it is connected — do not send another link unless they want to reconnect a different account.',
    }
  }

  const base = publicBaseUrl()
  if (!base) {
    return { ok: false, reason: 'no_base_url', guidance: 'Tell the owner you hit a configuration problem generating the connect link and will follow up — do not invent a link or claim it was sent.' }
  }

  const connectUrl = `${base}/oauth/google?businessId=${ctx.businessId}`
  return {
    ok: true,
    connectUrl,
    guidance: 'Send this exact link to the owner here in WhatsApp, on its own line. Tell them it opens a standard Google sign-in that lets the PA read and sync their calendar so bookings never clash, it is safe, and they can disconnect any time. The PA has NO email — never offer to email the link or claim you did.',
  }
}

// ── connectPayments ─────────────────────────────────────────────────────────────
// On-demand counterpart to the onboarding payment step (design §4.1): generates the signed
// one-time link the owner taps to connect their Grow (Meshulam) merchant account so the PA
// can send pay-links + invoices automatically. Mirrors executeConnectGoogleCalendar: it
// only produces a link — connecting actually happens on the web form, which live-validates
// against Grow and writes the payment.connected audit row.
export async function executeConnectPayments(
  _args: Record<string, never>,
  ctx: ToolContext,
): Promise<object> {
  if (await isPaymentsConnected(ctx.db, ctx.businessId)) {
    return {
      ok: true,
      alreadyConnected: true,
      guidance: 'Payments are already connected for this business — the PA can send pay-links and invoices. Reassure the owner; do not send another link unless they explicitly want to reconnect with different credentials.',
    }
  }

  const base = publicBaseUrl()
  if (!base) {
    return { ok: false, reason: 'no_base_url', guidance: 'Tell the owner you hit a configuration problem generating the connect link and will follow up — do not invent a link or claim it was sent.' }
  }

  // The connect token records who initiated it (for the WhatsApp confirmation after connect).
  const [caller] = await ctx.db
    .select({ phoneNumber: identities.phoneNumber })
    .from(identities)
    .where(eq(identities.id, ctx.identityId))
    .limit(1)

  const token = await createPaymentConnectToken(ctx.db, ctx.businessId, caller?.phoneNumber ?? '')
  const connectUrl = buildPaymentConnectUrl(base, token)
  return {
    ok: true,
    connectUrl,
    guidance: "Send this exact link to the owner here in WhatsApp, on its own line. Tell them it opens a secure form to paste their Grow (Meshulam) API credentials (userId, pageCode, API key) — NOT their Grow password — so the PA can send pay-links and invoices automatically. The link is valid for 30 minutes and single-use. The PA has NO email — never offer to email it or claim you did.",
  }
}

// ── requestPayment (Case B — owner-commanded charge) ─────────────────────────────
// The owner tells the PA, in management chat, to charge a customer ("send Dana a link for
// the ₪300 session"). Honors CLAUDE.md Principle 1: the LLM extracts only {customer, amount,
// description}; this deterministic executor authorizes, validates the amount, asks the Grow
// adapter (via PaymentService.createCharge) for the real pay-link, and delivers it into the
// customer's Branch-4 conversation. Authorization-gated like other money actions: managers
// always; delegated users only if granted payment.charge; customers/contacts never.

interface RequestPaymentArgs {
  customer?: string // name on file OR phone in E.164
  phoneNumber?: string // explicit phone (reach a new contact)
  amount?: number
  description?: string
}

export async function executeRequestPayment(args: RequestPaymentArgs, ctx: ToolContext): Promise<object> {
  // 1. Authorization — managers always; delegated only with the grant; customers never.
  const auth = authorize(
    { role: ctx.role ?? 'manager', ...(ctx.delegatedPermissions ? { delegatedPermissions: ctx.delegatedPermissions } : {}) },
    'payment.charge',
  )
  if (!auth.allowed) {
    return { ok: false, reason: 'not_authorized', guidance: 'This person is not allowed to charge customers. Tell them only the owner (or staff the owner has granted payments to) can send pay-links — do not send anything.' }
  }

  // 2. Validate the amount (the LLM never touches money beyond passing the number).
  const amount = typeof args.amount === 'number' ? args.amount : Number(args.amount)
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: 'invalid_amount', guidance: 'Ask the owner how much to charge (a positive amount).' }
  }
  const description = (args.description ?? '').trim()
  if (!description) {
    return { ok: false, reason: 'missing_description', guidance: 'Ask the owner what the charge is for (a short description that appears on the customer\'s pay-link / invoice).' }
  }

  // 3. Resolve the target customer (explicit phone → existing or new; else name on file).
  const rawPhone = (args.phoneNumber ?? '').replace(/[\s-]/g, '')
  const customerAsPhone = (args.customer ?? '').replace(/[\s-]/g, '')
  const phone = isValidE164(rawPhone) ? rawPhone : isValidE164(customerAsPhone) ? customerAsPhone : ''

  let target: { id: string; phoneNumber: string; name: string | null } | null = null
  if (phone) {
    const [existing] = await ctx.db
      .select({ id: identities.id, phoneNumber: identities.phoneNumber, name: identities.displayName })
      .from(identities)
      .where(and(eq(identities.businessId, ctx.businessId), eq(identities.phoneNumber, phone)))
      .limit(1)
    if (existing) {
      target = existing
    } else {
      const newId = await registerCustomer(ctx.db, ctx.businessId, phone, args.customer)
      target = { id: newId, phoneNumber: phone, name: args.customer ?? null }
    }
  } else if (args.customer) {
    const resolution = await resolveTargetForOwnerAction(ctx.db, ctx.businessId, {
      role: 'customer', name: args.customer, timezone: ctx.timezone, lang: ctx.lang,
    })
    if (resolution.status === 'not_found') return { ok: false, reason: 'customer_not_found', guidance: `No customer named "${args.customer}" is on file. Ask the owner for the phone number so you can reach them.` }
    if (resolution.status === 'ambiguous') {
      return { ok: false, reason: 'ambiguous_customer', candidates: resolution.candidates, guidance: disambiguationGuidance(args.customer, resolution.candidates, 'requestPayment') }
    }
    if (resolution.status === 'phone_unknown') return { ok: false, reason: 'no_recipient', guidance: 'Ask the owner who to charge — a name on file or a phone number.' }
    target = { id: resolution.target.id, phoneNumber: resolution.target.phoneNumber, name: resolution.target.displayName }
  } else {
    return { ok: false, reason: 'no_recipient', guidance: 'Ask the owner who to charge — a name on file or a phone number.' }
  }

  // 4. Create the Grow pay-link (deterministic core). Ad-hoc charge → no booking attached.
  const charge = await createCharge(ctx.db, {
    businessId: ctx.businessId,
    customerId: target.id,
    amount,
    description,
    source: 'owner_command',
    dedupKey: `payment.request:owner:${target.id}:${Date.now()}`,
    customer: { fullName: target.name ?? undefined, phone: target.phoneNumber },
  })
  if (!charge.ok) {
    if (charge.reason === 'not_connected') {
      return { ok: false, reason: 'payments_not_connected', guidance: 'Payments are not connected for this business yet. Tell the owner you can set that up first (the connectPayments link), then send the charge — do not claim a link was sent.' }
    }
    return { ok: false, reason: charge.reason, guidance: 'The pay-link could not be created. Tell the owner it did not go through and you will retry — do not claim a link was sent.' }
  }

  // 5. Deliver the link into the customer's Branch-4 conversation.
  const [biz] = await ctx.db
    .select({ defaultLanguage: businesses.defaultLanguage, whatsappPhoneNumberId: businesses.whatsappPhoneNumberId, whatsappAccessToken: businesses.whatsappAccessToken })
    .from(businesses)
    .where(eq(businesses.id, ctx.businessId))
    .limit(1)
  const lang: Lang = (biz?.defaultLanguage as Lang | null | undefined) ?? 'he'
  const body = lang === 'he'
    ? `כדי להשלים את התשלום עבור ${description}:\n${charge.paymentUrl}`
    : `To complete payment for ${description}:\n${charge.paymentUrl}`

  const waCredentials = biz?.whatsappPhoneNumberId && biz.whatsappAccessToken
    ? { accessToken: biz.whatsappAccessToken, phoneNumberId: biz.whatsappPhoneNumberId }
    : undefined

  const recordOutreach = (action: 'payment.link_sent' | 'payment.link_blocked', meta: Record<string, unknown>) =>
    logAudit(ctx.db, { businessId: ctx.businessId, actorId: ctx.identityId, action, entityType: 'payment_request', entityId: charge.paymentRequestId, metadata: { to: target!.phoneNumber, ...meta } }).catch(() => {})

  const res = await sendMessage({ toNumber: target.phoneNumber, body }, waCredentials)
  if (!res.ok) {
    if (res.outsideWindow) {
      await recordOutreach('payment.link_blocked', { reason: 'outside_window' })
      return { ok: false, reason: 'outside_messaging_window', sentTo: target.phoneNumber, guidance: 'The pay-link was created but WhatsApp would not deliver it because the customer has not messaged in over 24h (no template is set up to reopen contact). Tell the owner the link is ready and you will send it as soon as the customer writes, or they can share it — do not claim it was delivered.' }
    }
    if (res.userOptedOut) {
      await recordOutreach('payment.link_blocked', { reason: 'opted_out' })
      return { ok: false, reason: 'opted_out', guidance: 'The customer has opted out of messages, so the pay-link could not be delivered. Tell the owner honestly.' }
    }
    await recordOutreach('payment.link_blocked', { reason: 'send_failed' })
    return { ok: false, reason: 'send_failed', guidance: 'The pay-link was created but failed to send. Tell the owner it did not go through and you will retry — do not claim it was delivered.' }
  }

  await recordOutreach('payment.link_sent', { amount, description })
  return { ok: true, sentTo: target.phoneNumber, fact: JSON.stringify({ amount, description }), guidance: 'The pay-link was actually delivered to the customer. Confirm to the owner in your own words that you sent it and will let them know when it is paid (you handle the confirmation + invoice automatically).' }
}

// ── refundTransaction (owner-commanded refund) ───────────────────────────────────
// The owner asks to refund a customer ("refund Dana's payment", "give Yossi his ₪300 back").
// v1 refunds are owner-commanded only (no automation, design §0/§9.5). The LLM passes only who
// to refund; this executor authorizes (payment.refund), finds that customer's most recent
// settled charge, and hands it to PaymentService.refundCharge (which owns the Grow call + ledger
// flip). Guarded like requestPayment: managers always; delegated only with the grant; never customers.

interface RefundTransactionArgs {
  customer?: string // name on file OR phone in E.164
  phoneNumber?: string
}

export async function executeRefundPayment(args: RefundTransactionArgs, ctx: ToolContext): Promise<object> {
  const auth = authorize(
    { role: ctx.role ?? 'manager', ...(ctx.delegatedPermissions ? { delegatedPermissions: ctx.delegatedPermissions } : {}) },
    'payment.refund',
  )
  if (!auth.allowed) {
    return { ok: false, reason: 'not_authorized', guidance: 'This person is not allowed to issue refunds. Tell them only the owner (or staff the owner has granted payments to) can refund — do not refund anything.' }
  }

  // Resolve the customer whose charge to refund (phone → exact; else name on file).
  const rawPhone = (args.phoneNumber ?? '').replace(/[\s-]/g, '')
  const customerAsPhone = (args.customer ?? '').replace(/[\s-]/g, '')
  const phone = isValidE164(rawPhone) ? rawPhone : isValidE164(customerAsPhone) ? customerAsPhone : ''

  let customerId: string | null = null
  if (phone) {
    const [c] = await ctx.db
      .select({ id: identities.id })
      .from(identities)
      .where(and(eq(identities.businessId, ctx.businessId), eq(identities.phoneNumber, phone)))
      .limit(1)
    customerId = c?.id ?? null
  } else if (args.customer) {
    const rows = await ctx.db
      .select({ id: identities.id })
      .from(identities)
      .where(and(eq(identities.businessId, ctx.businessId), eq(identities.role, 'customer'), ilike(identities.displayName, `%${args.customer}%`)))
      .limit(5)
    if (rows.length > 1) return { ok: false, reason: 'ambiguous_customer', guidance: `Several customers match "${args.customer}". Ask the owner which one (or for the phone number).` }
    customerId = rows[0]?.id ?? null
  } else {
    return { ok: false, reason: 'no_recipient', guidance: 'Ask the owner which customer to refund — a name on file or a phone number.' }
  }
  if (!customerId) return { ok: false, reason: 'customer_not_found', guidance: `No customer matching "${args.customer ?? args.phoneNumber}" is on file. Ask the owner to confirm who to refund.` }

  // Find that customer's most recent settled charge.
  const [charge] = await ctx.db
    .select({ id: paymentRequests.id })
    .from(paymentRequests)
    .where(and(eq(paymentRequests.businessId, ctx.businessId), eq(paymentRequests.customerId, customerId), eq(paymentRequests.status, 'paid')))
    .orderBy(desc(paymentRequests.updatedAt))
    .limit(1)
  if (!charge) return { ok: false, reason: 'no_refundable_charge', guidance: 'There is no completed payment on file for this customer to refund. Tell the owner there is nothing to refund — do not claim a refund happened.' }

  const res = await refundCharge(ctx.db, { businessId: ctx.businessId, paymentRequestId: charge.id, actorId: ctx.identityId })
  if (!res.ok) {
    if (res.reason === 'not_connected') return { ok: false, reason: 'payments_not_connected', guidance: 'Payments are not connected for this business, so a refund cannot be issued. Tell the owner plainly.' }
    if (res.reason === 'not_refundable') return { ok: false, reason: 'not_refundable', guidance: 'That charge cannot be refunded (it is not a completed payment). Tell the owner there is nothing to refund.' }
    return { ok: false, reason: res.reason, guidance: 'The refund did not go through at the payment processor. Tell the owner it failed and you will look into it — do not claim it was refunded.' }
  }
  return { ok: true, fact: JSON.stringify(res), guidance: 'The refund was actually issued at the payment processor. Confirm to the owner in your own words (fact is raw — never quote it).' }
}

// ── messageCustomer ─────────────────────────────────────────────────────────────

interface MessageCustomerArgs {
  phoneNumber?: string
  name?: string
  lastName?: string
  message: string
  // Present only when the owner is asking the customer to move an existing appointment as a
  // favour. Carries human-readable current/new times so an out-of-window send can fall back to
  // the approved reschedule_favor_request template instead of failing silently.
  rescheduleFavor?: { currentTime: string; newTime: string }
}

// Proactively send a WhatsApp message to one specific customer on the owner's behalf
// (e.g. "ask Harel when he's free this week"). Replaces the prior gap where the model
// claimed "I sent it" with no tool behind it. Reports the REAL outcome only — WhatsApp
// forbids free-form messages to a customer who hasn't messaged in the last 24h, so an
// out-of-window send is reported as not-sent rather than faked.
export async function executeMessageCustomer(
  args: MessageCustomerArgs,
  ctx: ToolContext,
): Promise<object> {
  const body = (args.message ?? '').trim()
  if (!body) return { ok: false, reason: 'empty_message', guidance: 'No message text was provided. Ask the owner what they want said.' }

  const [biz] = await ctx.db
    .select({
      name: businesses.name,
      defaultLanguage: businesses.defaultLanguage,
      whatsappPhoneNumberId: businesses.whatsappPhoneNumberId,
      whatsappAccessToken: businesses.whatsappAccessToken,
    })
    .from(businesses)
    .where(eq(businesses.id, ctx.businessId))
    .limit(1)

  // Resolve the target customer. Prefer an explicit phone number (can register a
  // brand-new contact so their reply routes back as a customer); otherwise match a
  // known customer by name.
  let target: { id: string; phoneNumber: string; optOut: boolean } | null = null
  const phone = args.phoneNumber?.replace(/[\s-]/g, '')

  if (phone && isValidE164(phone)) {
    const [existing] = await ctx.db
      .select({ id: identities.id, phoneNumber: identities.phoneNumber, optOut: identities.messagingOptOut })
      .from(identities)
      .where(and(eq(identities.businessId, ctx.businessId), eq(identities.phoneNumber, phone)))
      .limit(1)
    if (existing) {
      target = existing
    } else {
      const newId = await registerCustomer(ctx.db, ctx.businessId, phone, args.name)
      target = { id: newId, phoneNumber: phone, optOut: false }
    }
  } else if (args.name) {
    const resolution = await resolveTargetForOwnerAction(ctx.db, ctx.businessId, {
      role: 'customer', name: args.name, ...(args.lastName ? { lastName: args.lastName } : {}),
      timezone: ctx.timezone, lang: ctx.lang,
    })
    if (resolution.status === 'not_found') {
      return { ok: false, reason: 'customer_not_found', guidance: `No customer named "${args.name}" is on file. Ask the owner for the phone number so you can reach them.` }
    }
    if (resolution.status === 'ambiguous') {
      return {
        ok: false,
        reason: 'ambiguous_customer',
        candidates: resolution.candidates,
        guidance: disambiguationGuidance(args.name, resolution.candidates, 'messageCustomer'),
      }
    }
    if (resolution.status !== 'resolved') {
      return { ok: false, reason: 'customer_not_found', guidance: `No customer named "${args.name}" is on file. Ask the owner for the phone number so you can reach them.` }
    }
    // resolved — opportunistic save: the owner disambiguated by a last name we didn't have on file.
    const t = resolution.target
    if (args.lastName && !t.lastName) {
      await setCustomerName(ctx.db, ctx.businessId, t.id, { lastName: args.lastName.trim() }).catch(() => {})
    }
    const [optRow] = await ctx.db
      .select({ optOut: identities.messagingOptOut })
      .from(identities).where(eq(identities.id, t.id)).limit(1)
    target = { id: t.id, phoneNumber: t.phoneNumber, optOut: optRow?.optOut ?? false }
  } else {
    return { ok: false, reason: 'no_recipient', guidance: 'Ask the owner who to message — a name on file or a phone number.' }
  }

  // Every outcome — sent or blocked — is written to the action ledger (audit_log) so the
  // ground-truth context can later contradict any false "I sent it" claim. This is the
  // L1 grounding contract: a state-changing tool MUST record what actually happened.
  const recordOutreach = (action: 'outreach.message_sent' | 'outreach.message_blocked', meta: Record<string, unknown>) =>
    logAudit(ctx.db, {
      businessId: ctx.businessId,
      actorId: ctx.identityId,
      action,
      entityType: 'identity',
      entityId: target!.id,
      metadata: { to: target!.phoneNumber, ...meta },
    }).catch(() => { /* ledger write is best-effort; never fail the send on it */ })

  if (target.optOut) {
    await recordOutreach('outreach.message_blocked', { reason: 'opted_out' })
    return { ok: false, reason: 'opted_out', guidance: 'This customer has opted out of messages. Tell the owner you cannot contact them — do not claim the message was sent.' }
  }

  const waCredentials = biz?.whatsappPhoneNumberId && biz.whatsappAccessToken
    ? { accessToken: biz.whatsappAccessToken, phoneNumberId: biz.whatsappPhoneNumberId }
    : undefined
  const lang = (biz?.defaultLanguage as 'he' | 'en' | null | undefined) ?? 'he'

  // Out-of-window fallback. A free-form message to a customer who hasn't written in 24h is
  // ACCEPTED by Meta (HTTP 200 + message id) but then fails delivery asynchronously
  // (re-engagement 131047) — so "let Meta be the authority on the synchronous response" silently
  // drops the message while we report success (the bug behind the false "I sent it"). Instead,
  // when the window is closed we send an APPROVED template (always deliverable) and report
  // honestly: a reschedule-favour ask if the owner supplied times, else a generic reach-out nudge
  // that invites the customer to reply (the owner's verbatim message can follow once they do).
  const outOfWindowFallback = async (): Promise<object> => {
    if (args.rescheduleFavor?.currentTime && args.rescheduleFavor?.newTime) {
      const tmpl = await sendTemplateMessage({
        toNumber: target!.phoneNumber,
        templateName: 'reschedule_favor_request',
        languageCode: lang === 'he' ? 'he' : 'en',
        components: bodyComponents([biz?.name ?? '', args.rescheduleFavor.currentTime, args.rescheduleFavor.newTime]),
        bodyText: body,
        ...(waCredentials !== undefined && { credentials: waCredentials }),
      })
      if (tmpl.ok) {
        await recordOutreach('outreach.message_sent', { body, viaTemplate: 'reschedule_favor_request' })
        return { ok: true, sentTo: target!.phoneNumber, guidance: 'The customer is outside the 24-hour window, so the reschedule request went out as an approved template asking them to move the appointment. Tell the owner it was sent and you will update them when the customer replies.' }
      }
      await recordOutreach('outreach.message_blocked', { reason: 'template_send_failed', viaTemplate: 'reschedule_favor_request' })
      return { ok: false, reason: 'send_failed', guidance: 'The reschedule request could not be sent. Tell the owner it did not go through — do not claim it was delivered.' }
    }
    // Generic reach-out nudge (the owner's free-text cannot ride a template, so the verbatim
    // message is NOT delivered here — only an invitation to re-establish contact).
    const tmpl = await sendTemplateMessage({
      toNumber: target!.phoneNumber,
      templateName: 'business_outreach_nudge',
      languageCode: lang === 'he' ? 'he' : 'en',
      components: bodyComponents([biz?.name ?? '']),
      ...(waCredentials !== undefined && { credentials: waCredentials }),
    })
    if (tmpl.ok) {
      await recordOutreach('outreach.message_sent', { body, viaTemplate: 'business_outreach_nudge', verbatimDelivered: false })
      return {
        ok: true,
        sentTo: target!.phoneNumber,
        outsideWindow: true,
        guidance: "This customer hasn't messaged in 24h, so WhatsApp will NOT deliver a free-form message — your exact wording was NOT sent. I sent an approved short note inviting them to get back in touch instead. Tell the owner this honestly: do not claim their message was delivered; say you reached out asking the customer to reply, and you'll pass their message along as soon as the customer does.",
      }
    }
    await recordOutreach('outreach.message_blocked', { reason: 'outside_window' })
    return {
      ok: false,
      reason: 'outside_messaging_window',
      guidance: 'The customer is outside the 24-hour window and the reach-out note could not be sent either. The message was NOT delivered. Tell the owner plainly and suggest the customer message first.',
    }
  }

  // Pre-check the window. Closed → go straight to the template fallback: a free-form send here
  // would be accepted-then-silently-dropped by Meta and falsely reported as delivered. canSendFreeForm
  // now reads identities.lastInboundAt (written on every inbound), so it tracks Meta's real window —
  // the old false-negative class ("hasn't messaged in 24h" when they actually had) that made this
  // report a wrong claim to the owner is fixed at the source (2026-06-25).
  if (!(await canSendFreeForm(target.id))) {
    return await outOfWindowFallback()
  }

  const res = await sendMessage({ toNumber: target.phoneNumber, body }, waCredentials)
  if (!res.ok) {
    if (res.userOptedOut) {
      await recordOutreach('outreach.message_blocked', { reason: 'opted_out' })
      return { ok: false, reason: 'opted_out', guidance: 'The customer has blocked/opted out. Tell the owner the message could not be delivered.' }
    }
    if (res.outsideWindow) {
      // Our session view said in-window but Meta disagrees synchronously → use the template fallback.
      return await outOfWindowFallback()
    }
    await recordOutreach('outreach.message_blocked', { reason: 'send_failed' })
    return { ok: false, reason: 'send_failed', guidance: 'The message failed to send. Tell the owner it did not go through and you will retry — do not claim it was delivered.' }
  }

  await recordOutreach('outreach.message_sent', { body })
  return { ok: true, sentTo: target.phoneNumber, guidance: 'The message was actually delivered. Confirm to the owner in your own words that you sent it and will update them when the customer replies.' }
}

// ── broadcastAnnouncement ─────────────────────────────────────────────────────

interface BroadcastAnnouncementArgs {
  kind?: string
  detail?: string
  segmentFilter?: SegmentFilter
}

// Owner-triggered fan-out of one of three fixed-shape announcements (hours / address / promo) to
// a customer segment. The runner enforces the gate per recipient (opt-out + quiet hours + budget)
// and a blast-radius breaker; out-of-window recipients receive the matching broadcast_* template.
export async function executeBroadcastAnnouncement(args: BroadcastAnnouncementArgs, ctx: ToolContext): Promise<object> {
  // Owner-level action — delegated staff cannot blast the customer base.
  if (ctx.role && ctx.role !== 'manager') {
    return { ok: false, reason: 'not_authorized', guidance: "Only the business owner can send a broadcast. Tell the user you can't do this on their behalf." }
  }
  const kind = args.kind
  if (kind !== 'hours_change' && kind !== 'address_change' && kind !== 'promo') {
    return { ok: false, reason: 'invalid_kind', guidance: 'Ask the owner whether this is a change of opening hours, a change of address, or a promotion — broadcasts come in those three fixed shapes.' }
  }
  const detail = (args.detail ?? '').trim()
  if (!detail) {
    return { ok: false, reason: 'missing_detail', guidance: 'Ask the owner for the specific detail to announce (the new hours, the new address, or the promo terms).' }
  }

  const result = await runBroadcast(ctx.db, {
    businessId: ctx.businessId,
    kind,
    detail,
    ...(args.segmentFilter ? { filter: args.segmentFilter } : {}),
  })

  await logAudit(ctx.db, {
    businessId: ctx.businessId,
    actorId: ctx.identityId,
    action: 'broadcast.triggered',
    entityType: 'business',
    entityId: ctx.businessId,
    metadata: { kind, matched: result.matched, sent: result.sent, optOuts: result.optOuts, errors: result.errors, aborted: result.aborted },
  }).catch(() => { /* ledger write is best-effort */ })

  return {
    ok: true,
    matched: result.matched,
    sent: result.sent,
    skipped: result.matched - result.sent,
    aborted: result.aborted,
    guidance: result.matched === 0
      ? 'No customers matched, so nothing was sent. Tell the owner there was no one to reach with this segment.'
      : `Sent the announcement to ${result.sent} of ${result.matched} matched customer(s) — some may be outside the 24-hour window or opted out.${result.aborted ? ' It was stopped early as a safety measure after unusual delivery results, so some were not reached.' : ''} Confirm the outcome to the owner honestly, in your own words.`,
  }
}
