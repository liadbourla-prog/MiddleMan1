import { eq, and, or, gt, gte, isNull, count, inArray, desc } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { serviceTypes, bookings, identities, availability, conversationSessions, waitlist } from '../../db/schema.js'
import type { Business, CalendarBlockType, SessionState } from '../../db/schema.js'
import type { ResolvedIdentity } from '../identity/types.js'
import type { ActiveSession } from '../session/types.js'
import { buildActionLedgerBlock } from '../audit/ledger-block.js'
import { updateSessionContext, completeSession, failSession } from '../session/manager.js'
import { requestBooking, confirmBooking, cancelBooking } from '../booking/engine.js'
import { notifyOwnerBookingChange } from '../initiations/booking-notify.js'
import { extractCustomerIntent, generateCustomerReply } from '../../adapters/llm/client.js'
import { setCustomerName, deriveLastName } from '../identity/customer-resolver.js'
import { canonicalTime } from './slot-fabrication-guard.js'
import { buildTurnLedger } from '../grounding/turn-ledger.js'
import { gateReply, makeRegenBudget, SAFE_AUDIT_FALLBACK } from '../grounding/output-gate.js'
import type { ActionClaim } from './reply-guard.js'
import { matchCancelBookings, type CancelBooking } from './cancellation-match.js'
import { inferFocusService, customerReferencedService } from './service-resolution.js'
import { middlemanOneLiner } from '../../adapters/llm/middleman-identity.js'
import type { CalendarClient } from '../../adapters/calendar/client.js'
import { parseConfirmation, parseRetentionReply, hasRevisionSignal, classifyConfirmWithQuestion } from './types.js'
import { logAudit } from '../audit/logger.js'
import type { FlowResult, BookingFlowContext } from './types.js'
import type { CustomerIntentOutput } from '../../adapters/llm/types.js'
import type { TranscriptTurn } from '../../adapters/llm/types.js'
import type { HydratedContext } from '../session/hydration.js'
import { checkOwnerEscalationRules, escalateToPlatform, escalateUnfulfillableRequest, escalateCustomerQuestion } from '../escalation/engine.js'
import { recordLastCancellation, loadLastCancellation } from '../customer/profile.js'
import type { BusinessKnowledge } from '../../shared/skill-types.js'
import { t } from '../i18n/t.js'
import { getOpenSlots, isSlotBookable } from '../availability/service.js'
import { listDayOptions, type ClassSession, type DayOptions } from '../availability/day-options.js'
import { findClassBlockProviderForSlot } from '../availability/blocks.js'
import { resolveGoogleMapsUrl } from '../location/maps.js'
import { resolveRequestedDate, resolveSlotStart, addDaysToDateStr, isDstGap, type RequestedDateParts } from '../availability/resolve-slot.js'
import { localParts } from '../availability/compute.js'
import { looksLikeGreetingOrSocial } from './social-text.js'
import { validateSlotTiming } from '../booking/engine.js'
import {
  pruneConstraints,
  addRejectedSlots,
  removeRejectedSlot,
  filterOpenSlots,
  isSlotSuppressed,
  mergeAvoid,
  type NegotiationConstraints,
  type AvoidConstraint,
  type RejectedSlot,
} from './negotiation-constraints.js'
import { acceptWaitlistOffer, declineWaitlistOffer } from '../waitlist/accept.js'
import { joinWaitlist } from '../waitlist/join.js'

/** Set or remove negotiationConstraints on a context — omits the key when empty so the
 *  stored jsonb stays minimal (and satisfies exactOptionalPropertyTypes). */
function withConstraints(ctx: BookingFlowContext, c: NegotiationConstraints): BookingFlowContext {
  const { negotiationConstraints: _drop, ...rest } = ctx
  return Object.keys(c).length > 0 ? { ...rest, negotiationConstraints: c } : rest
}

/** Persist a customer's self-stated name the first time we learn it. Only writes when we have no
 *  name on file yet (never clobbers an existing displayName). Best-effort: never throws into the
 *  booking flow. */
export async function persistCapturedName(
  db: Db,
  businessId: string,
  identityId: string,
  storedDisplayName: string | null,
  capturedName: string | null | undefined,
): Promise<void> {
  const name = capturedName?.trim()
  if (!name || storedDisplayName) return
  await setCustomerName(db, businessId, identityId, { displayName: name, lastName: deriveLastName(name) }).catch(() => {})
}

/** WS-D — softly append a one-line name request to a booking/rescheduling reply when the
 *  customer has no name on file, at most once per session. Pure + unit-testable: it does NOT
 *  touch the DB. The caller persists the returned `nameAsked` flag so it isn't re-asked next
 *  turn. Skipped for read-only intents (inquiry/list_bookings), when a name is already stored,
 *  when already asked, and when the reply is empty (a paused/escalation suppressed reply). */
export function appendNameRequest(
  reply: string,
  opts: { intent: CustomerIntentOutput['intent']; displayName: string | null; nameAsked: boolean; lang: 'he' | 'en' },
): { reply: string; nameAsked: boolean } {
  const isBookingPath = opts.intent === 'booking' || opts.intent === 'rescheduling'
  if (!isBookingPath || opts.displayName || opts.nameAsked || !reply.trim()) {
    return { reply, nameAsked: opts.nameAsked }
  }
  return { reply: `${reply}\n\n${t('ask_customer_name', opts.lang)}`, nameAsked: true }
}

/**
 * WL-4 — resolve an explicit join-the-waitlist request into ONE concrete
 * (serviceTypeId, slotStart, slotEnd), reusing the booking path's DETERMINISTIC resolver
 * (resolveRequestedDate → resolveSlotStart; the LLM never computes calendar arithmetic).
 * Returns null when service, a resolvable day, or a time is missing — the flow then falls
 * back to the normal "which session?" clarification instead of inserting a fuzzy row (plan
 * §3.1: "If no concrete full slot is named, the PA asks which session"). Pure + exported for
 * tests. Capacity (full vs. open) is NOT decided here — joinWaitlist re-checks it on a fresh
 * spine and routes an open slot back to booking.
 */
export function resolveConcreteWaitlistSlot(
  intent: CustomerIntentOutput,
  activeServices: Array<{ id: string; name: string; durationMinutes: number; schedulingMode?: 'appointment' | 'class' | null }>,
  businessTimezone: string,
  now: Date,
): { serviceTypeId: string; slotStart: Date; slotEnd: Date } | null {
  const service = resolveService(intent.serviceTypeHint, activeServices)
  if (!service) return null
  const slot = intent.slotRequest
  if (!slot || !slot.time) return null
  const hasDay = Boolean(slot.relativeDay || slot.weekday != null || slot.explicitDate)
  if (!hasDay) return null
  const resolved = resolveRequestedDate(
    {
      relativeDay: slot.relativeDay ?? null,
      weekday: slot.weekday ?? null,
      weekdayAnchor: slot.weekdayAnchor ?? null,
      explicitDate: slot.explicitDate ?? null,
    },
    businessTimezone,
    now,
  )
  if (!resolved.ok || resolved.ambiguousToday) return null
  const slotStart = resolveSlotStart(resolved.dateStr, { hour: slot.time.hour, minute: slot.time.minute }, businessTimezone)
  if (isNaN(slotStart.getTime())) return null
  const slotEnd = new Date(slotStart.getTime() + service.durationMinutes * 60_000)
  return { serviceTypeId: service.id, slotStart, slotEnd }
}

/**
 * WL-4 — shared join handler (WL-3 reuses it). Calls the WL-2 domain op (joinWaitlist) for a
 * single concrete slot and maps its typed outcome to a voice-compliant reply (no YES/NO menu,
 * ≤1 question, warm, clear next step — CHAT_LEVEL_LAWBOOK §9-14). It does NOT decide capacity
 * itself and NEVER re-implements the insert: joinWaitlist re-checks the fresh spine, inserts
 * idempotently, and returns the FIFO position.
 *  • joined        → confirm on the list + state position (Q3: stated, never promised fixed); done.
 *  • already_on_list→ warm "already on it" (no duplicate); done.
 *  • slot_has_space → signal routeToBooking (the slot isn't actually full → book it normally).
 *  • needs_name     → ask for the name (reuse the existing name-ask copy); no insert.
 */
export async function handleWaitlistJoinRequest(
  db: Db,
  identity: ResolvedIdentity,
  slot: { serviceTypeId: string; slotStart: Date; slotEnd: Date },
  deps: {
    lang: 'he' | 'en'
    businessTimezone: string
    businessName: string
    transcript: TranscriptTurn[]
    genReply: GenReply
    ctx: BookingFlowContext
  },
): Promise<{ reply: string; sessionComplete?: boolean; routeToBooking?: boolean }> {
  const { lang, businessTimezone, businessName, transcript, genReply, ctx } = deps
  const persona = ctx.botPersona ? { botPersona: ctx.botPersona } : {}
  const res = await joinWaitlist(db, {
    businessId: identity.businessId,
    customerId: identity.id,
    serviceTypeId: slot.serviceTypeId,
    slotStart: slot.slotStart,
    slotEnd: slot.slotEnd,
  })

  if (res.kind === 'slot_has_space') {
    // The slot is not actually full — let the caller route to the normal booking path.
    return { reply: '', routeToBooking: true }
  }

  if (res.kind === 'needs_name') {
    // Owner needs a name; reuse the existing soft name-ask copy. No insert happened — the
    // offer is re-attempted next turn once a name is on file. Session stays open.
    return { reply: t('ask_customer_name', lang), sessionComplete: false }
  }

  const dateLabel = formatSlotDate(slot.slotStart, businessTimezone)
  const timeLabel = formatSlotTime(slot.slotStart, businessTimezone)
  if (res.kind === 'already_on_list') {
    const reply = await genReply({
      businessTimezone, businessName, language: lang, transcript, ...persona, customerMemory: extractMemory(ctx),
      situation: `The customer is already on the waitlist for the ${dateLabel} at ${timeLabel} session (their place is currently ${res.position}). Warmly reassure them they're already on the list — do NOT add them again — and tell them you'll message them the moment a spot opens.`,
    })
    return { reply, sessionComplete: true }
  }

  // res.kind === 'joined' — Q3: state the position, never promise it stays fixed.
  const reply = await genReply({
    businessTimezone, businessName, language: lang, transcript, ...persona, customerMemory: extractMemory(ctx),
    situation: `The customer is now on the waitlist for the full ${dateLabel} at ${timeLabel} session — their place is ${res.position} in line. Confirm warmly that you've kept their place and state their position (${res.position}), without promising that position will stay the same; tell them you'll message them the moment a spot opens.`,
  })
  return { reply, sessionComplete: true }
}

type CustomerMemoryInput = {
  returningCustomer: boolean
  preferredServiceName: string | null
  displayName: string | null
  recentBookings?: Array<{ serviceName: string; slotStart: string; state: string }>
  sessionSummaries?: string[]
} | null

const REASON_MAP: Record<string, string> = {
  past_slot: 'the requested time has already passed',
  outside_hours: 'the requested time is outside business hours',
  calendar_error: 'the calendar is temporarily unavailable',
  policy_violation: 'the request does not meet the booking policy',
  already_cancelled: 'this booking has already been cancelled',
  hold_conflict: 'another customer just took that slot',
  not_found: 'the booking could not be found',
  not_authorized: 'this action is not permitted',
  slot_conflict: 'that slot is no longer available',
  cutoff_passed: 'the cancellation window has already closed',
  max_days_ahead: 'the requested date is too far in advance',
  min_buffer: 'bookings require more advance notice',
  // Deterministic date-resolution reasons (resolve-slot.ts) — phrased for customers.
  past_year: 'that date looks like it has already passed',
  past_date: 'that date has already passed',
  ambiguous_date: 'it is not clear which day was meant',
  impossible_date: 'that date does not exist on the calendar',
}

function sanitiseReason(reason: string | undefined | null): string {
  if (!reason) return 'an unexpected issue occurred'
  return REASON_MAP[reason] ?? reason.replace(/_/g, ' ').toLowerCase()
}

const HE_DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']
const EN_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Parse the engine sentinel 'provider_unavailable|Name|1:09:00-13:00;3:09:00-13:00'
 *  into a readable instructor + hours phrase. Returns null if not that sentinel. */
export function parseProviderUnavailable(reason: string, lang: 'he' | 'en'): { name: string; hoursPhrase: string } | null {
  if (!reason.startsWith('provider_unavailable|')) return null
  const [, name, hoursRaw] = reason.split('|')
  const days = lang === 'he' ? HE_DAY_NAMES : EN_DAY_NAMES
  const parts = (hoursRaw ?? '').split(';').filter(Boolean).map((seg) => {
    // Format is 'dow:HH:MM-HH:MM' — split on the FIRST colon only (times contain colons).
    const i = seg.indexOf(':')
    const dow = i >= 0 ? seg.slice(0, i) : seg
    const range = i >= 0 ? seg.slice(i + 1) : ''
    const dayLabel = days[Number(dow)] ?? ''
    return `${dayLabel} ${range}`.trim()
  })
  return { name: name ?? '', hoursPhrase: parts.join(', ') }
}

// Greetings / social pleasantries that classify as 'unknown' (there is no
// dedicated greeting intent) but must NOT count toward unknown-intent escalation.
// A message qualifies only when it is SHORT and essentially just a pleasantry —
// "hi can I book tomorrow?" classifies as booking and never reaches this check.
// looksLikeGreetingOrSocial now lives in ./social-text.ts (pure, shared with the owner-ping
// throttle in escalation/engine.ts without a customer-booking ↔ engine import cycle).
// Imported at the top of the file; re-exported here so existing importers/tests keep their entry point.
export { looksLikeGreetingOrSocial }

/**
 * Which day's spine a continuation turn should re-read (T2.2 Hole B). Precedence:
 * the day the customer named THIS turn → the in-flight draft day → the day the prior
 * availability inquiry focused on. The this-turn day winning is exactly the day-change
 * scoping: if they name a different day, the stale inquiry focus is naturally dropped.
 * Pure.
 */
export function resolveContinuationFocusDay(
  thisTurnDateStr: string | undefined,
  draftDateStr: string | undefined,
  lastInquiryDateStr: string | undefined,
): string | undefined {
  return thisTurnDateStr ?? draftDateStr ?? lastInquiryDateStr
}

/**
 * H19 (T2b.3) — every Branch-4 inquiry hands the occupancy gate a focus day, even when the
 * customer scoped none. Without one, Gate-3 signal-a (the fresh-spine backstop) never runs, so
 * an unscoped "nothing available" answer built on a TRANSIENT-empty availability load is trusted
 * blindly. Best-effort precedence: the day the customer scoped → the soonest day we actually
 * surfaced an open option for this turn (genuinely open) → today as a floor. The gate only ever
 * acts on this when the reply itself asserts no availability AND names no concrete time, so a
 * broad floor cannot misfire on an ordinary answer. Pure. Always returns a focus (never undefined).
 */
export function bestEffortInquiryFocusDay(
  resolvedDay: { ok: boolean; dateStr?: string } | null,
  offered: ReadonlyArray<{ start: string; serviceTypeId?: string }>,
  inquiryServiceId: string | undefined,
  tz: string,
  now: Date,
): { dateStr: string; serviceTypeId?: string } {
  const withSvc = (dateStr: string, svc: string | undefined): { dateStr: string; serviceTypeId?: string } =>
    svc ? { dateStr, serviceTypeId: svc } : { dateStr }
  if (resolvedDay && resolvedDay.ok && resolvedDay.dateStr) {
    return withSvc(resolvedDay.dateStr, inquiryServiceId)
  }
  // Soonest genuinely-open day surfaced this turn (ISO strings sort chronologically).
  const earliest = offered.map((o) => o.start).sort()[0]
  if (earliest) {
    const svc = offered.find((o) => o.start === earliest)?.serviceTypeId ?? inquiryServiceId
    return withSvc(localParts(new Date(earliest), tz).dateStr, svc)
  }
  // Floor: today. A transient-empty load must not let an unscoped "nothing available" stand
  // unchecked — the gate re-reads today's fresh spine and corrects if it is genuinely open.
  return withSvc(localParts(now, tz).dateStr, inquiryServiceId)
}

function formatSlotDate(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'long', day: 'numeric', month: 'long',
  }).format(date)
}

function formatSlotTime(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date)
}

// Business-local weekday (0=Sun..6=Sat) of an instant. Used by the C1 confirm-with-question
// arbiter to tell a same-held-day side question from a genuine day revision.
function localWeekdayOf(date: Date, tz: string): number {
  const name = date.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short' })
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[name] ?? date.getUTCDay()
}

// Render a resolved 'YYYY-MM-DD' business-local date for use inside situation
// strings (G2: the customer never sees the raw YYYY-MM-DD form).
function formatLocalDate(dateStr: string, tz: string): string {
  return formatSlotDate(resolveSlotStart(dateStr, { hour: 12, minute: 0 }, tz), tz)
}

// Best-effort focusDay for a bundled side-question on the confirm path (C4). The customer
// asked something like "yes, is Sunday full?" alongside their confirm; if the question names
// a weekday or relative day we can resolve, hand the occupancy gate a focusDay so it can
// re-read the spine for that day (kills cross-turn "full" laundering). Deliberately narrow:
// weekday/relative-day tokens only (mirrors hasRevisionSignal's vocabulary). Returns null
// when no clean day is present — the caller then omits focusDay and gates 1-3 still run.
const FOCUS_WEEKDAY_TOKENS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\b(sunday)\b|ראשון/i, 0], [/\b(monday)\b|שני/i, 1], [/\b(tuesday)\b|שלישי/i, 2],
  [/\b(wednesday)\b|רביעי/i, 3], [/\b(thursday)\b|חמישי/i, 4], [/\b(friday)\b|שישי/i, 5],
  [/\b(saturday)\b|שבת/i, 6],
]
function resolveFocusDayFromText(
  text: string,
  tz: string,
  now: Date,
  serviceTypeId?: string,
): { dateStr: string; serviceTypeId?: string } | null {
  let parts: RequestedDateParts | null = null
  if (/\btomorrow\b|מחר(?!תיים)/i.test(text)) parts = { relativeDay: 'tomorrow', weekday: null, explicitDate: null }
  else if (/מחרתיים/.test(text)) parts = { relativeDay: 'day_after_tomorrow', weekday: null, explicitDate: null }
  else if (/\btoday\b|היום/i.test(text)) parts = { relativeDay: 'today', weekday: null, explicitDate: null }
  else {
    for (const [re, dow] of FOCUS_WEEKDAY_TOKENS) {
      if (re.test(text)) { parts = { relativeDay: null, weekday: dow, explicitDate: null }; break }
    }
  }
  if (!parts) return null
  const res = resolveRequestedDate(parts, tz, now)
  if (!res.ok) return null
  return serviceTypeId ? { dateStr: res.dateStr, serviceTypeId } : { dateStr: res.dateStr }
}

type TimeOfDay = 'morning' | 'afternoon' | 'evening'

// Business definition of the day's parts, by a slot's LOCAL start time:
//   morning   = opening …  < 12:00   (a session STARTING at 12:00 is NOT morning)
//   afternoon = 12:00 … < 18:00
//   evening   = 18:00 … closing      (a session STARTING at 18:00 IS evening)
// Used to honour "what's in the morning/evening?" from real class/slot starts
// instead of letting the model interpolate a part-of-day window.
export function startInBucket(start: Date, tz: string, bucket: TimeOfDay): boolean {
  const m = localParts(start, tz).minutes
  if (bucket === 'morning') return m < 12 * 60
  if (bucket === 'afternoon') return m >= 12 * 60 && m < 18 * 60
  return m >= 18 * 60
}

function extractMemory(ctx: BookingFlowContext): CustomerMemoryInput {
  const hydrated = ctx as unknown as Partial<HydratedContext>
  const recentBookings = hydrated.recentBookings ?? []
  const sessionSummaries = hydrated.sessionSummaries ?? []
  if (!hydrated.customerMemory && !hydrated.returningCustomer && recentBookings.length === 0 && sessionSummaries.length === 0) return null
  return {
    returningCustomer: hydrated.returningCustomer ?? false,
    preferredServiceName: hydrated.preferredServiceName ?? null,
    displayName: hydrated.customerMemory?.displayName ?? null,
    ...(recentBookings.length > 0 ? { recentBookings } : {}),
    ...(sessionSummaries.length > 0 ? { sessionSummaries } : {}),
  }
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

async function loadHoursSummary(db: Db, businessId: string): Promise<string | null> {
  const rows = await db
    .select()
    .from(availability)
    .where(and(eq(availability.businessId, businessId), isNull(availability.specificDate), eq(availability.isBlocked, false)))
    .orderBy(availability.dayOfWeek)

  if (rows.length === 0) return null

  const parts = rows
    .filter((r) => r.dayOfWeek !== null && r.openTime && r.closeTime)
    .map((r) => `${DAY_NAMES[r.dayOfWeek!] ?? r.dayOfWeek}: ${r.openTime}–${r.closeTime}`)

  return parts.length > 0 ? `Business hours: ${parts.join(', ')}.` : null
}

// Distinct open/close boundary times (HH:MM) across the week — legit for a reply to
// state ("we're open 09:00–20:00") so the fabrication guard must not flag them.
async function loadBoundaryTimes(db: Db, businessId: string): Promise<string[]> {
  const rows = await db
    .select({ open: availability.openTime, close: availability.closeTime })
    .from(availability)
    .where(and(eq(availability.businessId, businessId), eq(availability.isBlocked, false)))
  const out = new Set<string>()
  for (const r of rows) {
    if (r.open) out.add(r.open.slice(0, 5))
    if (r.close) out.add(r.close.slice(0, 5))
  }
  return [...out]
}

// HH:MM of this customer's own upcoming occupying bookings — so a reply restating
// "your class is at 14:00" (cancellation/list/reschedule) is never flagged.
async function loadCustomerBookingTimes(db: Db, customerId: string, tz: string): Promise<string[]> {
  const rows = await db
    .select({ start: bookings.slotStart })
    .from(bookings)
    .where(and(
      eq(bookings.customerId, customerId),
      inArray(bookings.state, ['held', 'pending_payment', 'confirmed']),
      gte(bookings.slotStart, new Date()),
    ))
  return [...new Set(rows.map((r) => formatSlotTime(r.start, tz)))]
}

// A suggestion's human text plus the concrete slots it offered. `offered` feeds
// `lastOfferedSlots` so a subsequent batch rejection ("none of those") can mark exactly
// those instants as rejected. `text` is null when nothing fits.
interface SuggestionResult {
  text: string | null
  offered: RejectedSlot[]
  // WL-3: set ONLY when the SPECIFICALLY-requested concrete class exists but is FULL and was
  // therefore dropped by offerable mode (so it can never be presented as bookable). Lets the
  // lead-protection site ADD a waitlist offer for that exact slot alongside the substitute.
  // Additive + optional — existing callers ignore it.
  fullRequestedSlot?: { serviceTypeId: string; slotStart: string; slotEnd: string }
}
const NO_SUGGESTION: SuggestionResult = { text: null, offered: [] }

// H1: the lower bound for a same-day availability search. Floors at the START of the
// requested business-local day (so an already-taken 14:00 still surfaces an open 10:00
// the same day), but never reaches into the past — clamped to `now`. Pure + unit-tested.
export function dayStartFloor(requestedStart: Date, now: Date, tz: string): Date {
  const dayStart = resolveSlotStart(localParts(requestedStart, tz).dateStr, { hour: 0, minute: 0 }, tz)
  return dayStart.getTime() > now.getTime() ? dayStart : now
}

// Enumerate up to 4 real bookable openings for a service, starting from the
// requested time, over the next 14 days. Returns compact human text for the LLM to
// phrase plus the concrete slots offered. Uses the canonical availability spine so
// suggestions never collide with hours, blocks, or existing bookings.
async function suggestOpenSlotsText(
  db: Db,
  business: Business,
  serviceTypeId: string,
  requestedStart: Date,
  requestedEnd: Date,
  tz: string,
  constraints?: NegotiationConstraints,
): Promise<SuggestionResult> {
  const durationMinutes = Math.max(15, Math.round((requestedEnd.getTime() - requestedStart.getTime()) / 60_000))
  const now = new Date()
  // H1: floor the search at the START of the requested DAY (never in the past), not at
  // the requested CLOCK time — so a taken 14:00 still surfaces an open 10:00 the SAME day.
  const from = dayStartFloor(requestedStart, now, tz)
  const to = new Date(from.getTime() + 14 * 24 * 60 * 60_000)
  try {
    // Over-fetch then subtract rejected/avoided times so we still surface up to 4 FRESH
    // openings the customer hasn't already ruled out this session. The generous fetch
    // guards against a broad avoid rule (e.g. "no mornings") emptying a small page.
    const raw = await getOpenSlots(db, business, { start: from, end: to }, durationMinutes, { maxSlots: 40 })
    const slots = filterOpenSlots(raw, constraints, tz).slice(0, 4)
    if (slots.length === 0) return NO_SUGGESTION
    return {
      text: slots.map((s) => `${formatSlotDate(s.start, tz)} at ${formatSlotTime(s.start, tz)}`).join(', '),
      offered: slots.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString(), serviceTypeId })),
    }
  } catch {
    return NO_SUGGESTION
  }
}

// Answer an availability INQUIRY ("is Monday open?", "what's later this week?")
// from the canonical spine instead of parroting one slot. If the customer named a
// day/range we report THAT window; otherwise the next real openings. The returned
// string is already human-formatted (G2: no raw dates/enums leak).
async function buildInquiryAvailabilityText(
  db: Db,
  business: Business,
  slot: CustomerIntentOutput['slotRequest'],
  activeServices: Array<{ durationMinutes: number }>,
  tz: string,
  constraints?: NegotiationConstraints,
): Promise<SuggestionResult> {
  const now = new Date()
  const duration = activeServices.length > 0
    ? Math.min(...activeServices.map((s) => s.durationMinutes))
    : 60
  const dayStartOf = (dateStr: string): Date => resolveSlotStart(dateStr, { hour: 0, minute: 0 }, tz)

  let from = now
  let to = new Date(now.getTime() + 14 * 86_400_000)
  let scoped = false // customer named a specific day/week

  if (slot && (slot.relativeDay || slot.weekday != null || slot.explicitDate)) {
    const parts: RequestedDateParts = {
      relativeDay: slot.relativeDay ?? null,
      weekday: slot.weekday ?? null,
      explicitDate: slot.explicitDate ?? null,
    }
    const resolved = resolveRequestedDate(parts, tz, now)
    if (resolved.ok) {
      const start = dayStartOf(resolved.dateStr)
      from = start < now ? now : start
      to = dayStartOf(addDaysToDateStr(resolved.dateStr, 1))
      scoped = true
    } else if (slot.relativeDay === 'this_week' || slot.relativeDay === 'next_week') {
      const today = localParts(now, tz).dateStr
      const base = slot.relativeDay === 'next_week' ? addDaysToDateStr(today, 7) : today
      const start = dayStartOf(base)
      from = start < now ? now : start
      to = dayStartOf(addDaysToDateStr(base, 7))
      scoped = true
    }
  }

  // Honour an explicit part-of-day ("evening?") by keeping only slots whose LOCAL
  // start falls in that bucket — never widen back to all-day, which is what tempts
  // the model to fabricate (e.g. "evening" → inventing 17:00/19:00).
  const bucket: TimeOfDay | null = slot?.timeOfDay ?? null
  const byBucket = <T extends { start: Date }>(ss: T[]): T[] =>
    bucket ? ss.filter((s) => startInBucket(s.start, tz, bucket)) : ss
  const ofDay = bucket ? ` ${bucket}` : ''

  try {
    const offeredOf = (ss: { start: Date; end: Date }[]): RejectedSlot[] =>
      ss.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() }))
    const rawSlots = await getOpenSlots(db, business, { start: from, end: to }, duration, { maxSlots: 40 })
    const slots = byBucket(filterOpenSlots(rawSlots, constraints, tz)).slice(0, 6)
    if (slots.length > 0) {
      const list = slots.map((s) => `${formatSlotDate(s.start, tz)} at ${formatSlotTime(s.start, tz)}`).join('; ')
      return { text: `Actual open times in the window the customer asked about: ${list}.`, offered: offeredOf(slots) }
    }
    if (!scoped) return { text: `No open${ofDay} times in the next two weeks.`, offered: [] }
    // Specific day/week had nothing — offer the next real opening overall, honestly.
    const rawFallback = await getOpenSlots(db, business, { start: now, end: new Date(now.getTime() + 14 * 86_400_000) }, duration, { maxSlots: 30 })
    const fallback = byBucket(filterOpenSlots(rawFallback, constraints, tz)).slice(0, 3)
    if (fallback.length === 0) return { text: `Nothing open${ofDay} in the window they asked about, and nothing in the next two weeks.`, offered: [] }
    const list = fallback.map((s) => `${formatSlotDate(s.start, tz)} at ${formatSlotTime(s.start, tz)}`).join('; ')
    return { text: `Nothing open${ofDay} in the window they asked about. The next real openings are: ${list}.`, offered: offeredOf(fallback) }
  } catch {
    return NO_SUGGESTION
  }
}

// Render the options of a specific day — scheduled classes (with remaining spots)
// and open private slots — into a compact, human-readable facts string the reply
// LLM phrases. Already human-formatted (G2: no raw IDs/ISO/enums leak). Returns
// null when the day has nothing to offer so the caller can fall back.
async function buildDayOptionsText(
  db: Db,
  business: Business,
  dateStr: string,
  tz: string,
  serviceTypeId: string | undefined,
  constraints?: NegotiationConstraints,
  timeOfDay?: TimeOfDay | null,
  offerable = false,
  // WL-3: the exact concrete slot the customer asked for, so renderDayOptions can flag it as
  // `fullRequestedSlot` when it exists but is full (and is therefore dropped in offerable mode).
  requestedStart?: Date,
): Promise<SuggestionResult> {
  const day = await listDayOptions(db, business, dateStr, tz, serviceTypeId ? { serviceTypeId } : {})
  return renderDayOptions(day, dateStr, tz, { offerable, ...(timeOfDay != null ? { timeOfDay } : {}), ...(constraints != null ? { constraints } : {}), ...(requestedStart != null ? { requestedStart } : {}) })
}

// PURE renderer for an already-fetched DayOptions — the human-facing facts string plus the
// concrete `offered` slots. Split out of buildDayOptionsText so it's unit-testable (no DB).
//
// Two modes:
//   offerable:false (GROUNDING) — current behavior unchanged. FULL classes are LISTED with a
//     "(full)" label and pushed to `offered` (so grounding/no-availability checks see them).
//   offerable:true (CUSTOMER OFFER) — full classes (spotsLeft <= 0) are DROPPED entirely: they
//     appear in neither the text nor `offered`, so the PA can never present an unpickable slot.
export function renderDayOptions(
  day: DayOptions,
  dateStr: string,
  tz: string,
  opts: { offerable: boolean; timeOfDay?: TimeOfDay | null; constraints?: NegotiationConstraints; requestedStart?: Date },
): SuggestionResult {
  const { offerable, timeOfDay, constraints, requestedStart } = opts
  const dayLabel = formatLocalDate(dateStr, tz)
  const parts: string[] = []
  const offered: RejectedSlot[] = []
  // WL-3: when offerable mode drops the SPECIFICALLY-requested class because it's full, capture
  // that exact slot here so the caller can offer the waitlist for it (never a dead-end).
  let fullRequestedSlot: { serviceTypeId: string; slotStart: string; slotEnd: string } | undefined

  // Narrow to the requested part-of-day (real class/slot starts only) so an
  // "evening?" inquiry can never widen back into invented full-day times.
  const byBucket = <T extends { start: Date }>(ss: T[]): T[] =>
    timeOfDay ? ss.filter((s) => startInBucket(s.start, tz, timeOfDay)) : ss
  const datesByBucket = (ds: Date[]): Date[] =>
    timeOfDay ? ds.filter((d) => startInBucket(d, tz, timeOfDay)) : ds

  // Drop class instances and private openings the customer already ruled out this session.
  // In offerable mode, additionally drop FULL classes — they must never be presented.
  let classes = byBucket(filterOpenSlots(day.classes, constraints, tz))
  if (offerable) {
    // WL-3: before dropping full classes, flag the exact requested one if it's full — that
    // concrete slot is real, just unbookable, so the caller can offer to hold their place on it.
    if (requestedStart) {
      const req = day.classes.find((c) => c.start.getTime() === requestedStart.getTime())
      if (req && req.spotsLeft <= 0) {
        fullRequestedSlot = { serviceTypeId: req.serviceTypeId, slotStart: req.start.toISOString(), slotEnd: req.end.toISOString() }
      }
    }
    classes = classes.filter((c) => c.spotsLeft > 0)
  }
  if (classes.length > 0) {
    const items = classes.slice(0, 10).map((c) => {
      offered.push({ start: c.start.toISOString(), end: c.end.toISOString(), serviceTypeId: c.serviceTypeId })
      const cap = c.spotsLeft <= 0 ? 'full' : `${c.spotsLeft} spot${c.spotsLeft === 1 ? '' : 's'} left`
      return `${c.serviceName} at ${formatSlotTime(c.start, tz)} (${cap})`
    })
    parts.push(`Classes on ${dayLabel}: ${items.join('; ')}.`)
  }

  const privateOpenings = day.privateOpenings
    .map((p) => ({ ...p, slots: datesByBucket(p.slots.filter((s) => !isSlotSuppressed(s, constraints, tz))) }))
    .filter((p) => p.slots.length > 0)
  if (privateOpenings.length > 0) {
    const items = privateOpenings.slice(0, 6).map((p) => {
      const shown = p.slots.slice(0, 4)
      for (const s of shown) {
        offered.push({ start: s.toISOString(), end: new Date(s.getTime() + p.durationMinutes * 60_000).toISOString(), serviceTypeId: p.serviceTypeId })
      }
      return `${p.serviceName} at ${shown.map((s) => formatSlotTime(s, tz)).join(', ')}`
    })
    parts.push(`Open private times on ${dayLabel}: ${items.join('; ')}.`)
  }

  const flag = fullRequestedSlot ? { fullRequestedSlot } : {}
  if (parts.length > 0) return { text: parts.join(' '), offered, ...flag }
  // A part-of-day was asked but nothing real falls in it.
  if (timeOfDay) {
    // F2a / Symptom-2 — SAME-DAY-FIRST. The asked part is empty, but if the day HAS real
    // options at OTHER times, offer those (scoping the negative to the asked part) instead
    // of dead-ending on "no <part>" — which the caller generalized into a false
    // whole-day-empty and a premature jump to OTHER days ("Tuesday at 5pm has no class" must
    // NOT become "Tuesday has no classes at all"). Render the day UNFILTERED by part.
    const altItems: string[] = []
    let altClasses = filterOpenSlots(day.classes, constraints, tz)
    if (offerable) altClasses = altClasses.filter((c) => c.spotsLeft > 0)
    for (const c of altClasses.slice(0, 10)) {
      offered.push({ start: c.start.toISOString(), end: c.end.toISOString(), serviceTypeId: c.serviceTypeId })
      const cap = c.spotsLeft <= 0 ? 'full' : `${c.spotsLeft} spot${c.spotsLeft === 1 ? '' : 's'} left`
      altItems.push(`${c.serviceName} at ${formatSlotTime(c.start, tz)} (${cap})`)
    }
    const altPrivate = day.privateOpenings
      .map((p) => ({ ...p, slots: p.slots.filter((s) => !isSlotSuppressed(s, constraints, tz)) }))
      .filter((p) => p.slots.length > 0)
    for (const p of altPrivate.slice(0, 6)) {
      const shown = p.slots.slice(0, 4)
      for (const s of shown) {
        offered.push({ start: s.toISOString(), end: new Date(s.getTime() + p.durationMinutes * 60_000).toISOString(), serviceTypeId: p.serviceTypeId })
      }
      altItems.push(`${p.serviceName} at ${shown.map((s) => formatSlotTime(s, tz)).join(', ')}`)
    }
    if (altItems.length > 0) {
      return { text: `No ${timeOfDay} classes or open times on ${dayLabel}, but ${dayLabel} does have: ${altItems.join('; ')}. Offer these same-day times first.`, offered, ...flag }
    }
    // Genuinely nothing that day — state it explicitly so the caller does NOT fall back to
    // an all-day answer (which reopens the fabrication).
    return { text: `No ${timeOfDay} classes or open times on ${dayLabel}.`, offered: [], ...flag }
  }
  return { ...NO_SUGGESTION, ...flag }
}

// The class analogue of suggestOpenSlotsText: enumerate the next real CLASS
// instances (with spots left) over the next 14 days. Class-mode services are NOT
// bookable into arbitrary gaps, so their availability is the scheduled classes —
// NOT getOpenSlots, which reports zero on a fully-tiled week (classes+blocks) and
// makes the PA wrongly claim "fully booked" when classes with open seats exist.
// `serviceTypeId` undefined → all class services. Scans day-by-day and early-exits
// once enough are collected (a daily-class business fills the first day).
export async function suggestNextClassesText(
  db: Db,
  business: Business,
  serviceTypeId: string | undefined,
  tz: string,
  constraints?: NegotiationConstraints,
  timeOfDay?: TimeOfDay | null,
  now: Date = new Date(),
  maxClasses = 6,
): Promise<SuggestionResult> {
  const collected: ClassSession[] = []
  let dateStr = localParts(now, tz).dateStr
  for (let i = 0; i < 14 && collected.length < maxClasses; i++) {
    const day = await listDayOptions(db, business, dateStr, tz, { ...(serviceTypeId ? { serviceTypeId } : {}), now })
    let dayClasses = filterOpenSlots(day.classes, constraints, tz).filter((c) => c.spotsLeft > 0)
    if (timeOfDay) dayClasses = dayClasses.filter((c) => startInBucket(c.start, tz, timeOfDay))
    collected.push(...dayClasses)
    dateStr = addDaysToDateStr(dateStr, 1)
  }
  const shown = collected.slice(0, maxClasses)
  if (shown.length === 0) return NO_SUGGESTION
  const offered: RejectedSlot[] = shown.map((c) => ({ start: c.start.toISOString(), end: c.end.toISOString(), serviceTypeId: c.serviceTypeId }))
  const items = shown.map((c) => {
    const cap = c.spotsLeft === 1 ? '1 spot left' : `${c.spotsLeft} spots left`
    return `${c.serviceName} on ${formatSlotDate(c.start, tz)} at ${formatSlotTime(c.start, tz)} (${cap})`
  })
  return { text: `Upcoming scheduled classes (these are the real options — there are no others): ${items.join('; ')}.`, offered }
}

// PURE situation-string builder for the three class-offer sites (day-known/time-missing,
// classInstanceMissing gate, taken-at-confirm class miss). It is the testable seam for
// "never dead-end a lead": given the requested day's offerable options and the next-real-class
// substitute, it returns the LLM instruction for whichever of the three states holds.
//
//   1. sameDayText present              → offer the real same-day class times.
//   2. sameDayText null, substituteText → no more that day; offer the next REAL classes
//                                         (a later day) so the lead is never dead-ended.
//   3. both null                        → genuinely nothing on the horizon; an honest, warm,
//                                         forward-moving close (check another day OR let the
//                                         studio know) — never a bare dead-end, never a menu.
//
// VOICE GATE: every branch yields a first-person, single-question, no-IVR-menu, no-grovel
// reply that ALWAYS carries a concrete next step. Branches 2/3 must never instruct offering a
// "(full)" class — the offerable inputs have already dropped those.
export function classOfferSituation(
  serviceName: string,
  dayLabel: string,
  sameDayText: string | null,
  substituteText: string | null,
): string {
  if (sameDayText) {
    return `Booking ${serviceName} on ${dayLabel}. These are the only real class times that day: ${sameDayText} Offer ONLY these and ask which they'd like — do NOT re-ask the day or service, and never invent a time.`
  }
  if (substituteText) {
    return `There are no more ${serviceName} classes on ${dayLabel}. The next real classes are: ${substituteText} Offer these and ask which they'd like — never invent a time.`
  }
  return `There are no more ${serviceName} classes on ${dayLabel}, and nothing else is scheduled in the period ahead. Warmly let them know, and in a single question ask whether they'd like you to check another day or to let the studio know they're after this — never invent a time, and keep the conversation moving.`
}

// WS3-T3.5: a bare same-day weekday ("Sunday" when today IS Sunday) is ambiguous — the
// customer may mean today or the same day next week. PURE 3-state decision over today's
// sessions that have NOT yet started (the rest of the day):
//   'ask'  → some today-session is still bookable → ask "today or next week?"
//   'full' → sessions remain today but every one is full → say so + offer next real classes
//   'roll' → every session already started → silently roll to next week
export function decideAmbiguousTodayWeekday(
  liveClasses: { spotsLeft: number }[], // today's sessions that have NOT yet started
  livePrivateOpen: boolean, // any open private slot still to come today
): 'ask' | 'roll' | 'full' {
  if (liveClasses.some((c) => c.spotsLeft > 0) || livePrivateOpen) return 'ask'
  if (liveClasses.length > 0) return 'full' // sessions remain today but all full
  return 'roll' // every session already started → next week
}

// WS3-T3.5 BUG4: should a previously-stashed ambiguity marker survive THIS turn? PURE.
// True when the marker exists, the customer gave neither a today/next-week answer (which would
// BIND a date) nor a fresh concrete day (which supersedes it) — e.g. they just named the
// service after a serviceless ambiguity turn. The caller then re-raises the "today or next
// week?" ask once the service resolves, instead of silently booking today.
export function carriesWeekdayClarification(
  hasMarker: boolean,
  boundADate: boolean,
  broughtFreshDay: boolean,
): boolean {
  return hasMarker && !boundADate && !broughtFreshDay
}

// WS3-T3.5: consume a customer's answer to the "today or next week?" ambiguity ask. PURE.
// Returns the bound 'YYYY-MM-DD' (today or next-week, from the stashed pair) when the answer
// resolves the ambiguity, or null when this turn names a DIFFERENT concrete day (the caller
// then falls through to normal date resolution). Binding here is authoritative: the answer
// "next week" carries no weekday of its own (relativeDay:'next_week', weekday:null), so it
// must NOT be re-resolved (resolveRequestedDate would return ambiguous_date and loop).
export function consumeWeekdayClarification(
  pending: { todayStr: string; nextWeekStr: string },
  slot: { relativeDay: string | null; weekdayAnchor: string | null },
): string | null {
  if (slot.relativeDay === 'today' || slot.weekdayAnchor === 'this') return pending.todayStr
  if (slot.relativeDay === 'next_week' || slot.weekdayAnchor === 'next') return pending.nextWeekStr
  return null
}

// WS3-T3.5 VOICE-GATE: the "today or next week?" ask. English-neutral situation instruction;
// the LLM emits in the detected language. One warm first-person question — no numbered menu,
// no yes/no — naming the service and "next week" to keep it moving toward booking.
export function ambiguousTodayWeekdayAsk(serviceName: string, weekdayLabel: string): string {
  return `The customer asked to book ${serviceName} on ${weekdayLabel}, and that weekday is in fact TODAY — they may have meant today or the same day next week. There are still open ${serviceName} sessions today. In ONE warm, first-person question, check whether they'd like one of today's remaining sessions or the same day next week — do not present a numbered menu, do not ask a yes/no, and keep it moving toward booking.`
}

/**
 * Schedule-driven gate decision: is the requested slot off-schedule for a class service?
 *
 * A 'class' service (e.g. yoga, pilates) is bookable ONLY into a real materialized class
 * instance — never an arbitrary in-hours time. Returns true when the service is class-mode
 * AND no class block exists at `slotStart`, so the caller must re-offer real class times
 * instead of confirming an invented slot. 'appointment'-mode services are never gated here
 * (returns false without touching the DB). Mirrors the engine's no_class_at_time backstop,
 * surfaced ahead of the confirmation step so the PA never asserts a class that isn't scheduled.
 */
export async function classInstanceMissing(
  db: Db,
  businessId: string,
  svc: { id: string; schedulingMode: 'appointment' | 'class' },
  slotStart: Date,
): Promise<boolean> {
  if (svc.schedulingMode !== 'class') return false
  const block = await findClassBlockProviderForSlot(db, businessId, svc.id, slotStart)
  return !block.found
}

/** Is this service schedule-driven (a 'class' that runs only at fixed instances)? */
async function isClassModeService(db: Db, serviceTypeId: string): Promise<boolean> {
  const [row] = await db
    .select({ schedulingMode: serviceTypes.schedulingMode })
    .from(serviceTypes)
    .where(eq(serviceTypes.id, serviceTypeId))
    .limit(1)
  return row?.schedulingMode === 'class'
}

/**
 * Memory for a reply made WHILE a specific service is in flight. Cross-session
 * "preferred service" memory names a service the customer often books — which may be a
 * DIFFERENT service than the one being booked right now. Left as-is, the LLM can silently
 * switch the conversation to it (e.g. drop yoga, offer pilates). Anchor the preferred
 * service to the in-flight one so the reply stays on the service actually in play.
 */
export function memoryForActiveService(ctx: BookingFlowContext, activeServiceName: string | null): CustomerMemoryInput {
  const mem = extractMemory(ctx)
  if (!mem || activeServiceName == null) return mem
  return { ...mem, preferredServiceName: activeServiceName }
}

// Safe clarification used when the LLM keeps asserting a booking that was never
// made (cardinal "said done, didn't do" backstop — see reply-guard.ts).
// How many slot/date clarification fumbles before the PA nudges toward a phone
// call (while keeping the session alive — see nudgeAfterRepeatedTries). A confused
// customer hits 3 quickly, so allow a little more patience before nudging.
const MAX_CLARIFICATION_ATTEMPTS = 4

// The safe fallbacks + corrective instructions now live in `../grounding/output-gate.ts`
// (the gate owns them, reused by every seam). makeGenReply delegates to `gateReply`.

// Bound reply function: built once per request with the business's authoritative
// facts so every customer reply is grounded in real config (no invented services,
// instructors, prices, or policies — C3/C4). Callers never pass businessFacts.
type GenReply = (
  input: Parameters<typeof generateCustomerReply>[0],
  opts?: {
    bookingConfirmed?: boolean
    focusDay?: { dateStr: string; serviceTypeId?: string }
    // Action classes the deterministic core actually performed for THIS call (T3.1b). The gate
    // backs them so a legitimate "ביטלתי"/"I cancelled" reply at a real success site is allowed,
    // while any UNbacked action claim (the fabrication) is caught. `booking_made` is NOT a valid
    // member — it stays owned by `bookingConfirmed`.
    backs?: Exclude<ActionClaim, 'booking_made'>[]
  },
) => Promise<string>

// Reply-vs-state binding guard — the single intent-path-agnostic Branch-4 seam. Every
// customer reply funnels through here: a draft is generated, then run through the unified
// output gate (`gateReply`, ../grounding/output-gate.ts), which enforces the booking, time,
// and occupancy claim-classes (detect → regenerate-once → safe fallback) and monitors the
// rest. `businessFacts`/`actionLedger` are closed over and merged into every reply so the
// LLM is grounded in real, exhaustive config on EVERY path — not just inquiries. The
// per-turn truth ledger holds only the stable base; the gate rebuilds the time allowlist
// PER-CALL from this call's situation + customer-raised times (D1).
export function makeGenReply(
  businessFacts: string,
  actionLedger: string,
  timeGuard: { boundaryTimes: string[]; bookingTimes: string[] },
  dayHasOpenOptions: (dateStr: string, serviceTypeId?: string) => Promise<{ open: boolean; text: string | null }>,
  businessId?: string,
): GenReply {
  const ledger = buildTurnLedger({
    businessFacts,
    actionLedger,
    baseAllowedTimes: timeGuard,
    occupancySpine: dayHasOpenOptions,
    businessId,
  })
  // T-REGEN — ONE shared regen budget per TURN (built at closure-build time so every genReply
  // call in this turn draws from the same pool). Up to five enforce points each regenerate
  // once; the budget caps the total LLM round-trips so the 60s identity lock cannot expire.
  const budget = makeRegenBudget()
  return async (input, opts = {}) => {
    const grounded = {
      ...input,
      ...(businessFacts ? { businessFacts } : {}),
      ...(actionLedger ? { actionLedger } : {}),
    }
    // Regenerate once, appending the gate's corrective to THIS call's situation — exactly
    // the `${situation}\n\n${instruction}` shape the inline gates used.
    const regen = (instruction: string): Promise<string> =>
      generateCustomerReply({ ...grounded, situation: `${input.situation}\n\n${instruction}` })
    // T3.1b — Branch 4 ALWAYS enforces the action-claim gate. The per-turn base ledger holds an
    // empty backedActions set; per-call `opts.backs` (set at the deterministic success sites)
    // merges on top, mirroring the time allowlist's base∪per-call pattern. `booking_made` is NOT
    // here — it stays owned by `opts.bookingConfirmed`.
    const callLedger = opts.backs?.length
      ? { ...ledger, backedActions: new Set<ActionClaim>([...ledger.backedActions, ...opts.backs]) }
      : ledger
    // F-rev4 fail-safe: a throw anywhere in the reply pipeline — the draft generation OR a thrown
    // gate — is a POTENTIAL FABRICATION LEAK / dropped turn. Fail to a gate-owned safe template,
    // NEVER the raw ungated draft (which may be the very lie the gate exists to catch) and never
    // an unhandled exception. gateReply also swallows per-gate regen throws internally; this is
    // the outer backstop (draft-gen throw, an occupancySpine read that throws, etc.).
    try {
      const reply = await generateCustomerReply(grounded)
      const result = await gateReply(reply, {
        ledger: callLedger,
        input: { language: input.language, situation: input.situation, transcript: input.transcript },
        opts: { ...opts, enforceActionClaims: true },
        regen,
        budget,
      })
      return result.reply
    } catch {
      return SAFE_AUDIT_FALLBACK[input.language]
    }
  }
}

// Build the authoritative, closed-world business-facts block injected into every
// customer reply. Exhaustive service list (model/capacity/price) + an explicit
// no-invented-staff rule + the real booking-horizon policy. This is the ground
// truth that overrides anything the transcript implies (kills C3/C4).
export function buildBusinessFacts(
  activeServices: Array<{ id: string; name: string; durationMinutes: number; maxParticipants: number; narrative?: string | null }>,
  businessKnowledge: BusinessKnowledge | undefined,
  business: Business | undefined,
  instructors: Array<{ name: string; services: string[] }> = [],
): string {
  if (activeServices.length === 0) {
    return 'This business has NO bookable services configured. Do not offer to book anything or invent any service; tell the customer to contact the business directly.'
  }
  const lines: string[] = ['Services offered (this is the COMPLETE list — there are no other services):']
  for (const s of activeServices) {
    const model = s.maxParticipants > 1
      ? `group class, up to ${s.maxParticipants} people`
      : 'private 1-on-1 (one person per booking)'
    const k = businessKnowledge?.services.find((ks) => ks.id === s.id)
    const price = k?.price != null
      ? `${k.price}${k.currency ? ' ' + k.currency : ''}`
      : 'no price on record — do NOT quote a price'
    lines.push(`• ${s.name} — ${s.durationMinutes} min, ${model}, ${price}`)
    // T2b.1: surface the owner-authored narrative closed-world. This is the studio's own
    // words about the service (equipment, level, what to expect) — the model may answer
    // from it verbatim instead of inventing or relaying. Attached to ITS service line so a
    // narrated service never leaks attributes onto an un-narrated one. When absent, nothing
    // is emitted: the only honest route stays "answer from facts, else relay" (no invention).
    const narrative = s.narrative?.trim()
    if (narrative) lines.push(`   ↳ ${s.name} — about this service (owner's own description, treat as authoritative): ${narrative}`)
  }
  if (instructors.length > 0) {
    const list = instructors.map((i) => i.services.length > 0 ? `${i.name} (${i.services.join(', ')})` : i.name).join('; ')
    lines.push(`Instructors (this is the COMPLETE list — never name or invent anyone else): ${list}. Do NOT proactively advertise who teaches what; only name an instructor if the customer asks.`)
  } else {
    lines.push('Instructors/staff: none on record — do NOT name, suggest, or invent any instructor. If the customer names one, say plainly there is no one by that name on record; do NOT promise to check or get back to them.')
  }
  if (business?.maxBookingDaysAhead != null) {
    lines.push(`Bookings can be made up to ${business.maxBookingDaysAhead} days ahead — never claim a date within that window is "not open yet".`)
  }
  // The business's physical address — the ONLY source for "where are you?" / location questions.
  // Give it verbatim when asked, with the map link when available; when absent, there is no address
  // on record (do NOT invent one or promise to find out — the honest route is the ask-the-owner relay).
  const address = business?.address?.trim()
  if (address) {
    lines.push(`Business address (give this verbatim if the customer asks where you are located): ${address}`)
    const mapsUrl = business ? resolveGoogleMapsUrl(business) : null
    if (mapsUrl) lines.push(`Map link for the address (share it alongside the address when the customer asks where you are): ${mapsUrl}`)
  } else {
    lines.push('Business address: none on record — if the customer asks where you are located, do NOT invent or guess an address or a map link.')
  }
  return lines.join('\n')
}

// F3a/S3 — ask-the-owner sentinel. The answering model (which HAS the facts/FAQs) decides it
// cannot answer and emits ONLY this token; code then performs the REAL escalation and an honest
// reply. This replaces the model freely saying "I'll check with the studio" with no backing
// action (the reported fabrication) — the model can no longer self-author that promise.
const ASK_STUDIO_SENTINEL = '[[ASK_STUDIO]]'
const ASK_STUDIO_INSTRUCTION = `If — and ONLY if — you genuinely cannot answer the customer's specific question from the business facts, FAQs, and availability provided above, output EXACTLY this token and nothing else: ${ASK_STUDIO_SENTINEL}. Do NOT say you will check, ask, or get back to them yourself, and do NOT guess — the system relays the question to the business and sends the reply. Never output this token if you can answer from the information above.`

// True when a drafted reply is the model's "I can't answer" signal. Pure + exported for tests.
export function isAskStudioSentinel(reply: string): boolean {
  return reply.trim().includes(ASK_STUDIO_SENTINEL)
}

// F3a/S3 — perform the real owner escalation for an unanswerable question and return the honest
// customer reply. On no business / no reachable owner, returns a truthful no-promise message
// (never claims it asked anyone — that would re-introduce the fabrication).
async function relayUnansweredToOwner(
  db: Db,
  business: Business | undefined,
  identity: ResolvedIdentity,
  questionText: string,
  lang: 'he' | 'en',
): Promise<string> {
  const honestNoOwner = lang === 'he'
    ? 'אין לי את המידע הזה כרגע — הכי טוב לפנות ישירות לעסק.'
    : "I don't have that information on hand right now — it's best to contact the business directly."
  if (!business) return honestNoOwner
  const res = await escalateCustomerQuestion(db, business, { id: identity.id, phoneNumber: identity.phoneNumber }, questionText, lang)
  return res.escalated && res.customerReply ? res.customerReply : honestNoOwner
}

// F1c/S1 — the open waitlist offer (if any) this customer can accept by replying. The
// "a spot opened" proactive offer (workers/waitlist.ts) flips the row to 'offered' but wires
// NO session state and has no inbound consumer, so a "yes" used to fall through to fresh
// intent and the system flailed (the live-test loop's primary trigger). This is that
// consumer's loader: the most recent un-expired offered row + its service name.
async function loadOpenWaitlistOffer(
  db: Db,
  businessId: string,
  customerId: string,
  now: Date,
): Promise<{ id: string; serviceTypeId: string; slotStart: Date; slotEnd: Date } | null> {
  const [row] = await db
    .select({
      id: waitlist.id,
      serviceTypeId: waitlist.serviceTypeId,
      slotStart: waitlist.slotStart,
      slotEnd: waitlist.slotEnd,
      offerExpiresAt: waitlist.offerExpiresAt,
    })
    .from(waitlist)
    .where(and(eq(waitlist.businessId, businessId), eq(waitlist.customerId, customerId), eq(waitlist.status, 'offered')))
    .orderBy(desc(waitlist.offeredAt))
    .limit(1)
  if (!row) return null
  // Respect the offer TTL: an expired offer is no longer bindable (the expire_offer worker
  // may not have swept it yet). A null expiry is treated as still-open (defensive).
  if (row.offerExpiresAt && row.offerExpiresAt <= now) return null
  return { id: row.id, serviceTypeId: row.serviceTypeId, slotStart: row.slotStart, slotEnd: row.slotEnd }
}

// F1e/S1 — which of last turn's offered slots may be batch-rejected this turn. Everything
// offered is off the table EXCEPT the slot currently awaiting confirmation: rejecting that
// one suppresses it from a later re-resolution and drifts the booking to a different date.
// Pure + exported for unit testing.
export function promotableOfferedSlots(
  lastOffered: RejectedSlot[],
  pendingStart: string | undefined,
): RejectedSlot[] {
  return pendingStart ? lastOffered.filter((s) => s.start !== pendingStart) : lastOffered
}

export async function handleBookingFlow(
  db: Db,
  calendar: CalendarClient,
  identity: ResolvedIdentity,
  session: ActiveSession,
  messageText: string,
  businessTimezone: string,
  businessName: string,
  transcript: TranscriptTurn[],
  botPersona?: 'female' | 'male' | 'neutral',
  business?: Business,
  businessDefaultLanguage?: 'he' | 'en',
  businessKnowledge?: BusinessKnowledge,
  isFirstMessage?: boolean,
  instructorRoster?: Array<{ name: string; services: string[] }>,
): Promise<FlowResult> {
  let ctx = {
    ...(session.context as BookingFlowContext),
    ...(botPersona ? { botPersona } : {}),
  } as BookingFlowContext
  // Negotiation memory: drop rejected slots whose time has passed and cap the list
  // before this turn reads (filters suggestions) or writes it. Pruned in-memory; the
  // compacted set persists on the next updateSessionContext call.
  if (ctx.negotiationConstraints) {
    ctx = withConstraints(ctx, pruneConstraints(ctx.negotiationConstraints, new Date()))
  }
  // Batch rejection: a list of times was offered last turn. Whatever the customer does
  // now, those exact slots are off the table — fold them into the rejected set so a
  // re-suggest won't surface them again. If the customer is actually pursuing one, the
  // explicit-pursuit un-suppress (booking/inquiry paths below) pulls it back out.
  if (ctx.lastOfferedSlots && ctx.lastOfferedSlots.length > 0) {
    // F1e/S1: never promote the slot the customer is actively confirming — promoting it
    // suppresses it from any later re-resolution and silently drifts the booking to a
    // different date (the July-5 drift). The explicit-pursuit un-suppress still pulls back
    // any other offered slot the customer concretely chases.
    const promoted = addRejectedSlots(ctx.negotiationConstraints, promotableOfferedSlots(ctx.lastOfferedSlots, ctx.pendingSlot?.start))
    const { lastOfferedSlots: _consumed, ...rest } = ctx
    ctx = withConstraints(rest, promoted)
  }
  const defaultLang: 'he' | 'en' = businessDefaultLanguage ?? 'he'
  const lang: 'he' | 'en' = (ctx.languageOverride ?? ctx.detectedLanguage) ?? defaultLang

  // ── Per-conversation pause guard ─────────────────────────────────────────
  if (identity.conversationPausedUntil) {
    if (identity.conversationPausedUntil > new Date()) {
      return { reply: '', sessionComplete: false, paused: true }
    }
    // Pause expired — clear it and continue
    await db.update(identities).set({ conversationPausedUntil: null }).where(eq(identities.id, identity.id))
  }

  // ── Business-wide pause guard ─────────────────────────────────────────────
  if (business?.paused) {
    const pauseLang: 'he' | 'en' = (ctx.languageOverride ?? ctx.detectedLanguage) ?? (businessDefaultLanguage ?? 'he')
    return { reply: t('pa_paused_customer', pauseLang), sessionComplete: false }
  }

  // ── Ground every reply in real config ───────────────────────────────────
  // Load the active services once, up front, and build the authoritative
  // business-facts block. genReply closes over it so EVERY reply on EVERY path
  // (confirmations, clarifications, inquiries, errors) is grounded — the LLM can
  // never invent services/instructors/prices/policy (C3/C4).
  const activeServices = await db
    .select({
      id: serviceTypes.id,
      name: serviceTypes.name,
      durationMinutes: serviceTypes.durationMinutes,
      maxParticipants: serviceTypes.maxParticipants,
      category: serviceTypes.category,
      schedulingMode: serviceTypes.schedulingMode,
      narrative: serviceTypes.narrative,
    })
    .from(serviceTypes)
    .where(and(eq(serviceTypes.businessId, identity.businessId), eq(serviceTypes.isActive, true)))

  const businessFacts = buildBusinessFacts(activeServices, businessKnowledge, business, instructorRoster ?? [])
  // L1 grounding: surface any real action involving this customer — chiefly a proactive
  // outreach the business just sent them — so a reply continues that thread instead of
  // cold-greeting, and never invents an action. Best-effort; never block a reply on it.
  const actionLedger = await buildActionLedgerBlock(db, {
    businessId: identity.businessId,
    timezone: businessTimezone,
    lang,
    scope: 'customer',
    identityId: identity.id,
  }).catch(() => '')
  // Fabrication-guard context: loaded once so the output gate in genReply can tell a
  // real time (offered/hours/own-booking) from an invented one. Best-effort — a load
  // failure just narrows the allowlist (the regenerate→fallback path stays safe).
  const [boundaryTimes, bookingTimes] = await Promise.all([
    loadBoundaryTimes(db, identity.businessId).catch(() => [] as string[]),
    loadCustomerBookingTimes(db, identity.id, businessTimezone).catch(() => [] as string[]),
  ])
  // Fresh-spine occupancy reader for the output gate: re-reads a focused day's real
  // class/slot availability so a "full" claim can never launder past makeGenReply
  // without a current spine check. `open` counts ONLY genuinely-open capacity (classes
  // with spotsLeft > 0, or any private gap) — buildDayOptionsText's `offered` includes
  // FULL classes too, so it must NOT be used as the open signal (that would misfire the
  // gate on a genuinely full day and degrade a correct "fully booked" reply). We
  // deliberately read WITHOUT negotiation constraints: the backstop only judges the
  // truthfulness of a BLANKET "full" claim, and the fallback names no specific time, so
  // a session-rejected-but-open slot should still prevent a false "the whole day is dead".
  const dayHasOpenOptions = async (dateStr: string, serviceTypeId?: string): Promise<{ open: boolean; text: string | null }> => {
    if (!business) return { open: false, text: null }
    try {
      const day = await listDayOptions(db, business, dateStr, businessTimezone, serviceTypeId ? { serviceTypeId } : {})
      const open = day.classes.some((c) => c.spotsLeft > 0) || day.privateOpenings.some((p) => p.slots.length > 0)
      const r = await buildDayOptionsText(db, business, dateStr, businessTimezone, serviceTypeId, undefined)
      return { open, text: r.text }
    } catch {
      return { open: false, text: null }
    }
  }
  const genReply = makeGenReply(businessFacts, actionLedger, { boundaryTimes, bookingTimes }, dayHasOpenOptions, business?.id)

  // ── REBOOK shortcut — treat as fresh booking intent (B5: includes Hebrew variants) ──
  const rebookVariants = /^(rebook|re-book|תיאום מחדש|קביעת תור מחדש|לקבוע מחדש|להזמין מחדש)$/i
  if (rebookVariants.test(messageText.trim())) {
    await updateSessionContext(db, session.id, { ...ctx, detectedLanguage: lang }, 'active')
    const reply = await genReply({
      businessTimezone,
      businessName,
      language: lang,
      situation: 'Customer replied REBOOK — they want to book a new appointment after a cancellation. Ask them what service and when they would like.',
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: false }
  }

  // ── Language switch: handle YES/NO response to a pending inline offer ───────
  if (ctx.languageSwitchOfferPending && !ctx.languageOverride) {
    const switchAnswer = parseConfirmation(messageText)
    if (switchAnswer === 'yes') {
      const chosenLang: 'he' | 'en' = lang === defaultLang
        ? (defaultLang === 'he' ? 'en' : 'he')
        : lang
      try {
        await db.update(identities).set({ preferredLanguage: chosenLang }).where(eq(identities.id, identity.id))
      } catch { /* non-fatal */ }
      const newCtx: BookingFlowContext = { ...ctx, languageOverride: chosenLang, languageSwitchOfferPending: false }
      await updateSessionContext(db, session.id, newCtx, 'active')
      const reply = await genReply({
        businessTimezone,
        businessName,
        language: chosenLang,
        situation: 'Language preference saved. Acknowledge briefly and ask how you can help.',
        transcript,
        ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
        customerMemory: extractMemory(newCtx),
      })
      return { reply, sessionComplete: false }
    }
    if (switchAnswer === 'no') {
      const newCtx: BookingFlowContext = { ...ctx, languageOverride: defaultLang, languageSwitchOfferPending: false }
      await updateSessionContext(db, session.id, newCtx, 'active')
      // Re-process the original message in the default language
    }
    // 'unclear' — fall through and re-process; offer will be appended again
  }

  // ── Owner-rule escalation check (intent-INDEPENDENT rules only) ───────────
  // Runs before classification, so it can only evaluate rules that don't depend
  // on the message's intent: keyword and emotional (the latter via body regex).
  // The unknown_intent rule is evaluated AFTER classification, in the genuine
  // 'unknown' case below, using the real intent + a consecutive-unknown count —
  // otherwise every message (a clear booking included) was treated as "unknown"
  // and escalated on count alone (the over-escalation bug). Sentinel intent
  // 'pending' ensures the unknown_intent rule cannot match here.
  if (business) {
    const ownerEscalation = await checkOwnerEscalationRules(
      db, business, identity.phoneNumber, messageText, 'pending', 0, lang,
    )
    if (ownerEscalation.escalated) {
      await completeSession(db, session.id)
      return {
        reply: ownerEscalation.customerReply ?? '',
        sessionComplete: true,
        escalated: true,
      }
    }
  }

  // ── Branch: waitlist offer acceptance (F1c/S1) ───────────────────────────
  // T3.1b NOTE — Branch 4 has NO waitlist-ADD (customer-JOIN) site: there is no `insert(waitlist)`
  // anywhere in the codebase; this branch only flips an EXISTING offer row's status
  // (offered → accepted/expired), it does not add a customer to the list. Likewise there is NO
  // Branch-4 site that sends a message to a third party/customer on the customer's behalf. So no
  // `backs: ['waitlist_added']` or `backs: ['message_sent']` is wired here — and the action-claim
  // gate therefore correctly CATCHES any unbacked "added you to the waitlist" / "I messaged him"
  // claim as a fabrication (no backing is fabricated to suppress it).
  //
  // The "a spot opened" proactive offer sets no session pending state; bind the reply to the
  // open offer HERE so a "yes" actually books it, instead of falling through to fresh intent
  // (the loop's primary trigger). Only engages when no booking step is already in flight, so
  // it never hijacks an in-progress confirmation/clarification.
  if (session.state === 'active' && !ctx.pendingSlot && !ctx.pendingDecision && !ctx.awaitingConfirmationFor) {
    const offer = await loadOpenWaitlistOffer(db, identity.businessId, identity.id, new Date())
    if (offer) {
      const offerServiceName = activeServices.find((s) => s.id === offer.serviceTypeId)?.name ?? (lang === 'he' ? 'התור' : 'the appointment')
      const decision = parseConfirmation(messageText)
      if (decision === 'no') {
        // WL-6: explicit decline. declineWaitlistOffer releases the WL-5 hold, CAS-flips the row
        // offered→expired, and cascades to the next in line — it owns ALL waitlist status writes,
        // so no manual db.update(waitlist) here (that would double-write).
        await declineWaitlistOffer(db, calendar, {
          id: offer.id,
          businessId: identity.businessId,
          customerId: identity.id,
          serviceTypeId: offer.serviceTypeId,
          slotStart: offer.slotStart,
          slotEnd: offer.slotEnd,
        })
        await completeSession(db, session.id)
        const reply = await genReply({
          businessTimezone, businessName, language: lang,
          situation: `The customer declined the ${offerServiceName} spot that just opened up. Acknowledge warmly and let them know they can reach out anytime to book.`,
          transcript, ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}), customerMemory: extractMemory(ctx),
        })
        return { reply, sessionComplete: true }
      }
      if (decision === 'yes') {
        // WL-6: confirm the GENUINE WL-5 hold (acceptWaitlistOffer → confirmBooking + CAS-flip
        // offered→accepted, both-or-neither). NOT a fresh first-come requestBooking. The domain op
        // owns the waitlist status write.
        const res = await acceptWaitlistOffer(db, calendar, identity, identity.displayName ?? identity.phoneNumber, offer)
        const offerDate = formatSlotDate(offer.slotStart, businessTimezone)
        const offerTime = formatSlotTime(offer.slotStart, businessTimezone)
        if (res.kind === 'accepted') {
          await completeSession(db, session.id)
          const reply = await genReply({
            businessTimezone, businessName, language: lang,
            situation: `Booking confirmed for ${offerServiceName} on ${offerDate} at ${offerTime} — the spot that opened up is now theirs.`,
            transcript, ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}), customerMemory: extractMemory(ctx),
          }, { bookingConfirmed: true })
          return { reply, sessionComplete: true }
        }
        // res.kind === 'just_went' — lost the race; the held spot slipped away just now. Warm
        // fallback, NEVER a dead-end: apologise and offer to keep them on the waitlist / find
        // another time.
        await completeSession(db, session.id)
        const reply = await genReply({
          businessTimezone, businessName, language: lang,
          situation: `Unfortunately the ${offerServiceName} spot on ${offerDate} at ${offerTime} slipped away just now. Apologise warmly and offer to keep them on the waitlist or find another time.`,
          transcript, ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}), customerMemory: extractMemory(ctx),
        })
        return { reply, sessionComplete: true }
      }
      // Unclear → fall through to normal handling; the offer stays open until its TTL.
    }
  }

  // ── Branch: booking_selection (multi-booking pick — cancel or reschedule) ──
  // WS3-T3.2: a customer's answer binds to THE asked list-question's options first
  // (deterministic pick), with a C-PIVOT escape-hatch — a mid-flow revision ("actually
  // Thursday instead") falls through to fresh handling instead of mis-binding as an answer.
  if (session.state === 'waiting_clarification' &&
      (ctx.pendingDecision?.kind === 'booking_selection' ||
       ctx.awaitingConfirmationFor === 'cancellation_selection')) {
    const sel = await handleBookingSelection(db, calendar, identity, session, ctx, messageText, businessTimezone, businessName, transcript, genReply, business)
    if (!sel.redispatch) return sel
    // Pivot/redirect → the handler (via rebuildOnSlotPivot) already cleared pending state in
    // the DB; mirror that in-memory and fall through to fresh intent (mirrors the hold branch).
    const { pendingDecision: _pd, cancellationCandidates: _cc, awaitingConfirmationFor: _a, isReschedulingFlow: _r, pendingWaitlistJoin: _pwj, ...cleared } = ctx
    ctx = cleared as BookingFlowContext
    session = { ...session, state: 'active', context: ctx }
  }

  // ── Branch: waiting for hold confirmation ────────────────────────────────
  if (session.state === 'waiting_confirmation' && ctx.awaitingConfirmationFor === 'hold') {
    const holdResult = await handleHoldConfirmation(db, calendar, identity, session, ctx, messageText, businessTimezone, businessName, transcript, genReply, business)
    if (!holdResult.redispatch) return holdResult
    // Customer redirected away from the pending slot (an inquiry / a different request).
    // handleHoldConfirmation already cleared the hold from the session in the DB; mirror
    // that in-memory and fall through to fresh intent handling so their actual request is
    // answered instead of the stale slot being re-asked.
    const { pendingSlot: _ps, pendingBookingId: _pb, awaitingConfirmationFor: _a, pendingWaitlistJoin: _pwj, ...clearedCtx } = ctx
    ctx = clearedCtx as BookingFlowContext
    session = { ...session, state: 'active', context: ctx }
  }

  // ── Branch: waiting for cancellation confirmation ────────────────────────
  if (session.state === 'waiting_confirmation' && ctx.awaitingConfirmationFor === 'cancellation') {
    return handleCancellationConfirmation(db, calendar, identity, session, ctx, messageText, businessTimezone, businessName, transcript, genReply, business)
  }

  // ── Branch: reschedule-retention offer response ──────────────────────────
  if (session.state === 'waiting_confirmation' && ctx.awaitingConfirmationFor === 'retention_offer') {
    return handleRetentionResponse(db, calendar, identity, session, ctx, messageText, businessTimezone, businessName, transcript, genReply, business)
  }

  // ── Branch: waiting for clarification on vague slot ──────────────────────
  if (session.state === 'waiting_clarification') {
    return handleClarification(db, calendar, identity, session, ctx, messageText, businessTimezone, businessName, transcript, genReply, business)
  }

  // ── Default: new message, extract intent ─────────────────────────────────
  // activeServices already loaded above (hoisted for businessFacts).
  const serviceNames = activeServices.map((s) => s.name)

  const hoursForIntent = business ? await loadHoursSummary(db, business.id) : null

  // Pass a clean transcript-based context instead of the raw internal state machine object
  const intentContext: Record<string, unknown> = {
    recentMessages: transcript.slice(-6).map((t) => `${t.role === 'customer' ? 'Customer' : 'Assistant'}: ${t.text}`),
    sessionState: session.state,
    ...(hoursForIntent ? { businessHours: hoursForIntent } : {}),
  }

  const intentResult = await extractCustomerIntent(
    messageText,
    intentContext,
    businessTimezone,
    serviceNames,
  )

  if (!intentResult.ok) {
    // Phase 4 (churn): a transient extraction/quota hiccup must NOT destroy the
    // session — that fragments the conversation and loses any draft. Keep it alive
    // so the customer's retry continues in the same session.
    if (intentResult.error === 'quota_exceeded') {
      const quotaReply = lang === 'he'
        ? 'אנחנו עסוקים כרגע. אנא נסה שוב בעוד מספר דקות.'
        : "We're a bit busy right now. Please try again in a few minutes."
      return { reply: quotaReply, sessionComplete: false }
    }
    const reply = await genReply({
      businessTimezone,
      businessName,
      language: lang,
      situation: 'Intent extraction failed. Ask the customer to rephrase their request.',
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: false }
  }

  const intent = intentResult.data
  // Capture the customer's name the first time they state it (non-blocking, never clobbers).
  await persistCapturedName(db, identity.businessId, identity.id, identity.displayName ?? null, intent.customerNameHint ?? null)
  const detectedLanguage = intent.detectedLanguage

  // Negotiation memory: fold any newly-stated categorical exclusion ("no mornings",
  // "not Thursdays") into the session constraints, so every suggestion from this turn
  // onward honours it deterministically. Merged into ctx before handlers/inquiry run.
  if (intent.avoidConstraints) {
    const a = intent.avoidConstraints
    const avoid: AvoidConstraint = {}
    if (a.beforeHour != null) avoid.beforeHour = a.beforeHour
    if (a.afterHour != null) avoid.afterHour = a.afterHour
    if (a.weekdays && a.weekdays.length > 0) avoid.weekdays = a.weekdays
    if (Object.keys(avoid).length > 0) {
      ctx = withConstraints(ctx, mergeAvoid(ctx.negotiationConstraints, avoid))
    }
  }

  // Determine whether to append an inline language switch offer after this reply.
  // Offer when: detected language differs from default, no override locked yet.
  const shouldOfferSwitch = !ctx.languageOverride && detectedLanguage !== defaultLang

  // Greet at most once per session. firstMsgPrefix is the ONLY thing that licenses
  // a greeting/intro; every later turn must continue without re-introducing.
  const mayGreet = isFirstMessage && !ctx.greeted

  // Persist language detection into context so all subsequent branches use it.
  // Reset the consecutive-unknown tally on any actionable intent so the count
  // tracks UNKNOWNS IN A ROW (a customer who's genuinely stuck), not a lifetime
  // total — handlers receive updatedCtx and persist from it, so the reset sticks.
  // WL-3: `let` (not const) — the full-slot waitlist follow-up clears pendingWaitlistJoin in-place
  // before falling through to normal booking on the slot_has_space (re-opened seat) path.
  let updatedCtx: BookingFlowContext = {
    ...ctx,
    detectedLanguage,
    ...(mayGreet ? { greeted: true } : {}),
    ...(shouldOfferSwitch ? { languageSwitchOfferPending: true } : {}),
    ...(intent.intent !== 'unknown' ? { sessionUnknownCount: 0 } : {}),
  }

  // Prefix injected into situation strings for first-message targeted intents
  const firstMsgPrefix = mayGreet
    ? 'This is the customer\'s first message — include a brief warm greeting before addressing their request. '
    : 'Do NOT greet or re-introduce yourself — continue the conversation directly. '

  const intentResult2 = await (async (): Promise<FlowResult> => {
    // WL-3 — follow-up to a full-slot waitlist OFFER (set as pendingWaitlistJoin by the
    // lead-protection site). A "yes" joins THAT exact slot via the shared WL-4 helper — NOT a
    // fresh booking — so the yes is never re-parsed as a new intent. Placed before fresh
    // extraction; guarded so it can't hijack an in-progress confirmation/selection.
    if (updatedCtx.pendingWaitlistJoin && !updatedCtx.pendingSlot && !updatedCtx.pendingDecision && !updatedCtx.awaitingConfirmationFor) {
      const decision = parseConfirmation(messageText)
      if (decision === 'yes') {
        const pending = updatedCtx.pendingWaitlistJoin
        const { pendingWaitlistJoin: _drop, ...clearedCtx } = updatedCtx
        const join = await handleWaitlistJoinRequest(
          db, identity,
          { serviceTypeId: pending.serviceTypeId, slotStart: new Date(pending.slotStart), slotEnd: new Date(pending.slotEnd) },
          { lang: detectedLanguage, businessTimezone, businessName, transcript, genReply, ctx: clearedCtx as BookingFlowContext },
        )
        // slot_has_space → the seat freed in the meantime; fall through to normal booking (no dead-end).
        if (!join.routeToBooking) {
          if (join.sessionComplete) await completeSession(db, session.id)
          else await updateSessionContext(db, session.id, clearedCtx as BookingFlowContext, 'active')
          return { reply: join.reply, ...(join.sessionComplete ? { sessionComplete: true } : { sessionComplete: false }) }
        }
        updatedCtx = clearedCtx as BookingFlowContext
      } else if (decision === 'no') {
        // Warm acknowledgement, clear the offer, fall through (they may say what they'd like next).
        const { pendingWaitlistJoin: _drop, ...clearedCtx } = updatedCtx
        await updateSessionContext(db, session.id, clearedCtx as BookingFlowContext, 'active')
        const reply = await genReply({
          businessTimezone, businessName, language: detectedLanguage, transcript, ...(updatedCtx.botPersona ? { botPersona: updatedCtx.botPersona } : {}), customerMemory: extractMemory(updatedCtx),
          situation: `${firstMsgPrefix}The customer doesn't want to be added to the waitlist for the full session. Acknowledge warmly with no pressure, and in one gentle question check whether they'd like you to look at another day instead.`,
        })
        return { reply, sessionComplete: false }
      }
      // Unclear → fall through; the offer stays pending (pendingWaitlistJoin unchanged).
    }
    // WL-4 — explicit "put me on the waitlist" / "תכניס אותי לרשימת המתנה". Branch on === true
    // so an omitted/undefined flag (the model never spoke) NEVER fires this. The guards mirror
    // the waitlist-offer binding (~the offer branch above): never engage when a booking step is
    // already in flight, so it can't hijack an in-progress confirmation/selection. The
    // in-progress branches already returned earlier this turn; the guard makes that explicit.
    if (intent.joinWaitlist === true && !updatedCtx.pendingSlot && !updatedCtx.pendingDecision && !updatedCtx.awaitingConfirmationFor) {
      // Resolve the concrete full slot the SAME deterministic way the booking path does.
      const concrete = resolveConcreteWaitlistSlot(intent, activeServices, businessTimezone, new Date())
      if (concrete) {
        const join = await handleWaitlistJoinRequest(db, identity, concrete, {
          lang: detectedLanguage, businessTimezone, businessName, transcript, genReply, ctx: updatedCtx,
        })
        // slot_has_space → fall through to normal booking for that slot (NOT a dead-end).
        if (!join.routeToBooking) {
          if (join.sessionComplete) await completeSession(db, session.id)
          else await updateSessionContext(db, session.id, updatedCtx, 'active')
          return { reply: join.reply, ...(join.sessionComplete ? { sessionComplete: true } : { sessionComplete: false }) }
        }
        // routeToBooking → fall through to the normal booking handling below for this slot.
      }
      // No concrete full slot named → fall through to the normal booking path, which reuses the
      // existing day/slot clarification ("which session?") instead of inserting a fuzzy row.
    }
    // P4: "give me back the class we cancelled" → re-offer the exact cancelled slot from
    // the snapshot. Falls through to normal handling when there's nothing fresh to restore.
    if (intent.restorePrevious === true) {
      const restored = await handleRestoreCancelled(db, calendar, identity, session, updatedCtx, businessTimezone, businessName, transcript, genReply, activeServices, business)
      if (restored) return restored
    }
    switch (intent.intent) {
      case 'booking':
        return handleBookingIntent(db, calendar, identity, session, updatedCtx, intent, activeServices, businessTimezone, businessName, transcript, genReply, firstMsgPrefix, business)

      case 'rescheduling':
        // If a reschedule is already in progress (the booking to move is designated
        // via `rescheduledFrom`, but not yet released — deferred cancel), this turn is
        // the customer supplying the NEW time. Route it to the booking path; re-entering
        // the reschedule handler would see the still-active original and bounce back
        // into booking selection. The old slot is released on confirmation.
        if (updatedCtx.rescheduledFrom) {
          return handleBookingIntent(db, calendar, identity, session, updatedCtx, intent, activeServices, businessTimezone, businessName, transcript, genReply, firstMsgPrefix, business)
        }
        return handleReschedulingIntent(db, calendar, identity, session, updatedCtx, intent, activeServices, businessTimezone, businessName, transcript, genReply, business)

      case 'cancellation':
        return handleCancellationIntent(db, calendar, identity, session, updatedCtx, intent, activeServices, businessTimezone, businessName, transcript, genReply)

      case 'list_bookings':
        return handleListBookings(db, identity, session, updatedCtx, businessTimezone, businessName, transcript, genReply)

      case 'inquiry': {
        // Symptom 3: a "private/one-off version of a group class" request is inquiry-shaped
        // (no concrete date/time), so it never reaches the post-slot escalation branches.
        // Ping the owner once here too — the guard inside is idempotent per session.
        if (intent.specialArrangementRequest === true) {
          const esc = await maybeEscalateSpecial(db, business, updatedCtx, session, identity, intent, transcript, detectedLanguage)
          if (esc) return esc
        }
        // Read-only intent: keep the session ACTIVE so a continuing conversation
        // stays ONE session. Completing here spawns a fresh session on the next
        // turn → isFirstMessage=true → re-greeting (the session-churn bug). The
        // 30-min customer expiry still reaps idle sessions.
        await updateSessionContext(db, session.id, updatedCtx, 'active')
        const serviceDescriptions = activeServices.map((s) => {
          const type = s.maxParticipants > 1 ? `group class, ${s.maxParticipants} spots` : 'private'
          const price = businessKnowledge?.services.find((ks) => ks.id === s.id)?.price
          const priceStr = price != null ? `, ${price} ${businessKnowledge?.services.find((ks) => ks.id === s.id)?.currency ?? ''}` : ''
          return `${s.name} (${s.durationMinutes} min, ${type}${priceStr})`
        }).join('; ')

        // Enrich inquiry context with recent booking count and next open window
        const ninetyDaysAgo = new Date()
        ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)
        const [countRow] = await db
          .select({ total: count() })
          .from(bookings)
          .where(and(eq(bookings.customerId, identity.id), eq(bookings.state, 'confirmed'), gte(bookings.slotStart, ninetyDaysAgo)))
        const recentBookingCount = Number(countRow?.total ?? 0)

        // Real availability. When the customer scoped a specific DAY ("what's on
        // Monday?"), enumerate that day's actual options — scheduled classes (with
        // spots left) + open private slots — narrowed to a named service only when
        // they concretely asked for one. Otherwise fall back to the general
        // next-openings answer. Never a single parroted slot. (G2: all human-rendered.)
        let availabilityText: string | null = null
        const inquiryOffered: RejectedSlot[] = []
        // Hoisted to case scope so the inquiryReply genReply call below can pass focusDay.
        let inquiryService: typeof activeServices[number] | null = null
        let resolvedDay: ReturnType<typeof resolveRequestedDate> | null = null
        if (business) {
          inquiryService = resolveService(intent.serviceTypeHint, activeServices)
          const dayParts: RequestedDateParts | null =
            intent.slotRequest && (intent.slotRequest.relativeDay || intent.slotRequest.weekday != null || intent.slotRequest.explicitDate)
              ? {
                  relativeDay: intent.slotRequest.relativeDay ?? null,
                  weekday: intent.slotRequest.weekday ?? null,
                  explicitDate: intent.slotRequest.explicitDate ?? null,
                }
              : null
          resolvedDay = dayParts ? resolveRequestedDate(dayParts, businessTimezone, new Date()) : null
          // Explicit re-ask about a specific time un-suppresses it: the customer is
          // proactively asking about a slot they earlier ruled out, so surface it again.
          if (resolvedDay && resolvedDay.ok && intent.slotRequest?.time) {
            const askedStart = resolveSlotStart(resolvedDay.dateStr, intent.slotRequest.time, businessTimezone)
            ctx = withConstraints(ctx, removeRejectedSlot(ctx.negotiationConstraints, askedStart.toISOString()))
          }
          if (resolvedDay && resolvedDay.ok) {
            const r = await buildDayOptionsText(db, business, resolvedDay.dateStr, businessTimezone, inquiryService?.id, ctx.negotiationConstraints, intent.slotRequest?.timeOfDay ?? null, true)
            availabilityText = r.text
            inquiryOffered.push(...r.offered)
          }
          // No specific day resolved (or that day had nothing): answer from the right
          // availability MODEL. For a class-mode focus — or a class business with no
          // appointment focus — that is the scheduled CLASSES, never getOpenSlots gaps
          // (which read empty on a fully-tiled week and make the PA cry "fully booked"
          // while classes with open seats exist). Appointment focus still uses gaps.
          if (!availabilityText) {
            const focalIsAppointment = inquiryService?.schedulingMode === 'appointment'
            const hasClassService = activeServices.some((s) => s.schedulingMode === 'class')
            if (!focalIsAppointment && hasClassService) {
              const classSvcId = inquiryService?.schedulingMode === 'class' ? inquiryService.id : undefined
              const r = await suggestNextClassesText(db, business, classSvcId, businessTimezone, ctx.negotiationConstraints, intent.slotRequest?.timeOfDay ?? null)
              availabilityText = r.text
              inquiryOffered.push(...r.offered)
            }
          }
          if (!availabilityText) {
            const r = await buildInquiryAvailabilityText(db, business, intent.slotRequest, activeServices, businessTimezone, ctx.negotiationConstraints)
            availabilityText = r.text
            inquiryOffered.push(...r.offered)
          }
          // Persist the offered times (and any avoid/un-suppress folded into ctx this
          // turn) so a follow-up "none of those work" can batch-reject them — the
          // inquiry path is otherwise read-only and wouldn't carry this forward.
          let inquiryCtx = withConstraints(updatedCtx, ctx.negotiationConstraints ?? {})
          if (inquiryOffered.length > 0) inquiryCtx = { ...inquiryCtx, lastOfferedSlots: inquiryOffered }
          // Persist the focused day so a bare continuation ("I want to join") re-reads the
          // SAME day's fresh spine and corrects a stale "full" (T2.2 Hole B).
          if (resolvedDay && resolvedDay.ok) {
            inquiryCtx = { ...inquiryCtx, lastInquiryFocus: { dateStr: resolvedDay.dateStr, ...(inquiryService ? { serviceTypeId: inquiryService.id } : {}) } }
          }
          await updateSessionContext(db, session.id, inquiryCtx, 'active')
        }
        const hoursSummary = business ? await loadHoursSummary(db, business.id) : null

        const customerCtx = recentBookingCount > 0
          ? `Returning customer with ${recentBookingCount} booking(s) in the last 90 days.`
          : 'First-time or lapsed customer.'
        const slotCtx = availabilityText ? ` ${availabilityText}` : ''
        const hoursCtx = hoursSummary ? ` ${hoursSummary}` : ''

        const situation = activeServices.length > 0
          ? `${firstMsgPrefix}Customer asked a question about the business, services, hours, or availability. ${customerCtx}${hoursCtx}${slotCtx} Services available: ${serviceDescriptions}. Answer their specific question using the FAQs and service info above. CRITICAL on times: the ONLY bookable times are those explicitly listed above as open times / classes. Business hours describe when the studio is OPEN — they are NOT a list of bookable slots; never present a time as available just because it falls within opening hours or between classes. If they asked which times/days are open, give the listed open times as a short bullet list and invite them to pick one. If nothing is listed for what they asked, say plainly there is nothing available and offer the listed alternatives or another day — never invent or infer a time. If the customer asks to book with a specific instructor by name, that is supported — bookings go through here. Do NOT proactively bring up, list, or advertise individual instructors or who teaches what; only engage with instructor specifics if the customer raises them first. ${ASK_STUDIO_INSTRUCTION}`
          : `${firstMsgPrefix}Customer asked about the business. ${customerCtx} No services are configured yet. Direct them to contact the business directly.`
        const knowledgeFields = businessKnowledge ? {
          brandVoice: businessKnowledge.brandVoice,
          ...(businessKnowledge.communicationStyle ? { communicationStyle: businessKnowledge.communicationStyle } : {}),
          faqs: businessKnowledge.faqs,
        } : {}
        const inquiryReply = await genReply({
          businessTimezone,
          businessName,
          language: detectedLanguage,
          situation,
          transcript,
          customerMemory: extractMemory(updatedCtx),
          ...knowledgeFields,
        }, { focusDay: bestEffortInquiryFocusDay(resolvedDay, inquiryOffered, inquiryService?.id, businessTimezone, new Date()) })
        // F3a/S3: the model signalled it can't answer → relay the question to the owner FOR
        // REAL and reply honestly, instead of fabricating "I'll check with the studio".
        if (isAskStudioSentinel(inquiryReply)) {
          const relay = await relayUnansweredToOwner(db, business, identity, messageText, detectedLanguage)
          return { reply: relay, sessionComplete: false }
        }
        return { reply: inquiryReply, sessionComplete: false }
      }

      case 'system_explanation': {
        // Read-only intent — keep the session active (see inquiry note above).
        await updateSessionContext(db, session.id, updatedCtx, 'active')
        const oneLiner = middlemanOneLiner(detectedLanguage, businessName)
        // T2b.2: the explanation path passes FAQs but had no escape hatch — a bundled question
        // the one-liner can't answer would be fabricated. Add the sentinel so a genuine gap
        // relays for real instead of inventing; the default is still to answer/steer.
        const situation = `${firstMsgPrefix}The customer EXPLICITLY asked what system, platform, or technology powers this assistant. Authorized platform explanation — give exactly this one fact, phrased naturally, and nothing more (no marketing, no extra detail): "${oneLiner}". Then briefly invite them back to booking. ${ASK_STUDIO_INSTRUCTION}`
        const knowledgeFields = businessKnowledge ? {
          brandVoice: businessKnowledge.brandVoice,
          ...(businessKnowledge.communicationStyle ? { communicationStyle: businessKnowledge.communicationStyle } : {}),
          faqs: businessKnowledge.faqs,
        } : {}
        const explainReply = await genReply({
          businessTimezone,
          businessName,
          language: detectedLanguage,
          situation,
          transcript,
          customerMemory: extractMemory(updatedCtx),
          ...knowledgeFields,
        })
        // F3a/S3: the model signalled it can't answer a bundled gap → relay for real.
        if (isAskStudioSentinel(explainReply)) {
          const relay = await relayUnansweredToOwner(db, business, identity, messageText, detectedLanguage)
          return { reply: relay, sessionComplete: false }
        }
        return { reply: explainReply, sessionComplete: false }
      }

      default: {
        // Symptom 3: an unknown/unclear-shaped special-arrangement request (the LLM set
        // the flag but couldn't map a concrete slot) must still ping the owner once,
        // before it dead-ends in the generic "I couldn't map that" reply below.
        if (intent.specialArrangementRequest === true) {
          const esc = await maybeEscalateSpecial(db, business, updatedCtx, session, identity, intent, transcript, detectedLanguage)
          if (esc) return esc
        }
        // Greetings / social pleasantries land here (no greeting intent exists) but
        // are benign — they must NOT count toward unknown-intent escalation. Only a
        // genuine unparseable message advances the consecutive-unknown tally.
        const isSocial = looksLikeGreetingOrSocial(messageText)
        const unknownCount = isSocial ? 0 : ((updatedCtx.sessionUnknownCount as number | undefined) ?? 0) + 1
        const ctxWithCount: BookingFlowContext = { ...updatedCtx, sessionUnknownCount: unknownCount }

        // Owner unknown_intent escalation — evaluated HERE with the REAL intent and
        // the consecutive-unknown count (never on a clear request or a greeting).
        if (!isSocial && business) {
          const ownerEscalation = await checkOwnerEscalationRules(
            db, business, identity.phoneNumber, messageText, 'unknown', unknownCount, detectedLanguage,
          )
          if (ownerEscalation.escalated) {
            await completeSession(db, session.id)
            return { reply: ownerEscalation.customerReply ?? '', sessionComplete: true, escalated: true }
          }
          // Platform escalation (operator ping) after repeated consecutive unknowns.
          if (unknownCount >= 2) {
            await escalateToPlatform(db, business, identity.phoneNumber, messageText)
          }
        }

        await updateSessionContext(db, session.id, ctxWithCount)

        const hasFaqs = (businessKnowledge?.faqs?.length ?? 0) > 0
        // Re-ground: if this turn references a day (or continues an in-flight one), inject
        // that day's REAL options so a challenge ("are you sure it's full?") or continuation
        // ("I want to join") is answered from the spine, never from a stale transcript claim.
        let unknownFocus: { dateStr: string; serviceTypeId?: string } | undefined
        let unknownDayText: string | null = null
        if (business) {
          const dp = intent.slotRequest && (intent.slotRequest.relativeDay || intent.slotRequest.weekday != null || intent.slotRequest.explicitDate)
            ? resolveRequestedDate({ relativeDay: intent.slotRequest.relativeDay ?? null, weekday: intent.slotRequest.weekday ?? null, explicitDate: intent.slotRequest.explicitDate ?? null }, businessTimezone, new Date())
            : null
          const focusDateStr = resolveContinuationFocusDay(dp?.ok ? dp.dateStr : undefined, updatedCtx.slotDraft?.dateStr, updatedCtx.lastInquiryFocus?.dateStr)
          const focusSvc = resolveService(intent.serviceTypeHint, activeServices)?.id ?? updatedCtx.slotDraft?.serviceTypeId ?? updatedCtx.lastInquiryFocus?.serviceTypeId
          if (focusDateStr) {
            const r = await buildDayOptionsText(db, business, focusDateStr, businessTimezone, focusSvc, updatedCtx.negotiationConstraints)
            unknownDayText = r.text
            unknownFocus = { dateStr: focusDateStr, ...(focusSvc ? { serviceTypeId: focusSvc } : {}) }
          }
        }
        // ONLY the genuine first message of a session may introduce the PA. Every
        // later turn continues the conversation — it must never re-greet or
        // re-announce identity (that was the verbatim-reintroduction bug).
        const unknownSituation = mayGreet
          ? `This is the customer's first message and it is unclear or generic. Greet them warmly as ${businessName}, say in one line you can help with booking, changing, or cancelling appointments${hasFaqs ? ' and answer questions about the business' : ''}, and ask how you can help. Keep it short and human.`
          : hasFaqs
            ? `Mid-conversation: the customer said "${messageText}", which isn't a clear booking/cancel/reschedule. Do NOT greet or re-introduce yourself. If a FAQ above answers it, answer directly; otherwise reply like a person — briefly acknowledge, then nudge toward what you can help with (booking, changing, cancelling, checking appointments).`
            : `Mid-conversation: the customer said "${messageText}", which you couldn't map to a booking action. Do NOT greet or re-introduce yourself and do NOT repeat a canned capability list. Reply like a human employee — a short, warm acknowledgement that keeps things moving toward booking, changing, cancelling, or checking an appointment.`

        const unknownSituationGrounded = unknownDayText
          ? `${unknownSituation} Real options for the day in question: ${unknownDayText} Never tell the customer a day/class is full if options are listed here.`
          : unknownSituation
        // T2b.2: give the mid-conversation unknown path the same escape hatch the inquiry path
        // has — a real, unanswerable side-question relays for real instead of being fabricated.
        // The first-message greeting (mayGreet) is excluded: there is no question to relay, and
        // steering is always the default — the relay only ever fires on the model's sentinel.
        const unknownSituationFinal = mayGreet
          ? unknownSituationGrounded
          : `${unknownSituationGrounded} ${ASK_STUDIO_INSTRUCTION}`
        const unknownKnowledgeFields = businessKnowledge ? {
          brandVoice: businessKnowledge.brandVoice,
          ...(businessKnowledge.communicationStyle ? { communicationStyle: businessKnowledge.communicationStyle } : {}),
          faqs: businessKnowledge.faqs,
        } : {}
        const unknownReply = await genReply({
          businessTimezone,
          businessName,
          language: detectedLanguage,
          situation: unknownSituationFinal,
          transcript,
          customerMemory: extractMemory(updatedCtx),
          ...unknownKnowledgeFields,
        }, unknownFocus ? { focusDay: unknownFocus } : undefined)
        // F3a/S3: the model signalled it can't answer → relay the question to the owner for real.
        if (isAskStudioSentinel(unknownReply)) {
          const relay = await relayUnansweredToOwner(db, business, identity, messageText, detectedLanguage)
          return { reply: relay, sessionComplete: false }
        }
        return { reply: unknownReply, sessionComplete: false }
      }
    }
  })()

  let result = intentResult2

  // ── Soft name request (WS-D) ─────────────────────────────────────────────
  // Single chokepoint: every booking/rescheduling reply funnels through here. When the
  // customer has no name on file, append one soft one-line ask (at most once per session)
  // so the owner's calendar isn't left with a bare phone number. Skipped for terminal
  // hard replies (escalation/pause/failure) and for the successful-booking case where the
  // handler already completed the session (asking on a closed session can't be guarded).
  const isHardReply = result.escalated || result.paused || result.sessionFailed
  if (!isHardReply && !result.sessionComplete) {
    const named = appendNameRequest(result.reply, {
      intent: intent.intent,
      displayName: identity.displayName ?? null,
      nameAsked: updatedCtx.nameAsked ?? false,
      lang,
    })
    if (named.nameAsked && !(updatedCtx.nameAsked ?? false)) {
      // The handler already persisted its own (richer) context this turn. Merge the
      // nameAsked flag onto the just-written row so it isn't clobbered, then carry the
      // appended reply forward.
      result = { ...result, reply: named.reply }
      const [row] = await db
        .select({ context: conversationSessions.context, state: conversationSessions.state })
        .from(conversationSessions)
        .where(eq(conversationSessions.id, session.id))
      const persisted = (row?.context as BookingFlowContext | undefined) ?? updatedCtx
      await updateSessionContext(db, session.id, { ...persisted, nameAsked: true }, row?.state as SessionState | undefined).catch(() => {})
    }
  }

  // ── Inline language switch offer ─────────────────────────────────────────
  // Append once per turn when we detected a different language and no override is set yet.
  if (shouldOfferSwitch && result.reply && !result.sessionComplete) {
    const offerSuffix = detectedLanguage === 'en'
      ? '\n\nWant me to keep going in English? Just say the word.'
      : '\n\nרוצה שאמשיך בעברית? פשוט תכתוב לי כן.'
    return { ...result, reply: result.reply + offerSuffix }
  }

  return result
}

// Reconstruct an incremental slot draft from a slot that was about to be confirmed,
// so a one-field correction ("make it 7pm") keeps the rest while the new piece
// overrides on merge. Business-local date/time via localParts (DST-correct).
function slotDraftFromPending(
  ps: NonNullable<BookingFlowContext['pendingSlot']>,
  tz: string,
): NonNullable<BookingFlowContext['slotDraft']> {
  const lp = localParts(new Date(ps.start), tz)
  return {
    serviceTypeId: ps.serviceTypeId,
    serviceName: ps.serviceName,
    dateStr: lp.dateStr,
    time: { hour: Math.floor(lp.minutes / 60), minute: lp.minutes % 60 },
  }
}

// Capture the slot pieces a customer stated up front (service/day/time) into a
// draft, resolving the date deterministically. Used so a multi-booking reschedule
// ("move my yoga to Sunday 3pm") doesn't drop the new slot during the
// which-booking selection detour and then re-ask for it.
function buildDraftFromIntent(
  intent: CustomerIntentOutput,
  activeServices: Array<{ id: string; name: string; durationMinutes: number; maxParticipants: number; category: string | null; schedulingMode: 'appointment' | 'class' }>,
  tz: string,
  now: Date = new Date(),
): NonNullable<BookingFlowContext['slotDraft']> | null {
  const draft: NonNullable<BookingFlowContext['slotDraft']> = {}
  const slot = intent.slotRequest
  if (slot && (slot.relativeDay || slot.weekday != null || slot.explicitDate)) {
    const resolved = resolveRequestedDate(
      { relativeDay: slot.relativeDay ?? null, weekday: slot.weekday ?? null, explicitDate: slot.explicitDate ?? null },
      tz, now,
    )
    if (resolved.ok) draft.dateStr = resolved.dateStr
  }
  if (slot?.time) draft.time = { hour: slot.time.hour, minute: slot.time.minute }
  const svc = resolveService(intent.serviceTypeHint, activeServices)
  if (svc) {
    draft.serviceTypeId = svc.id
    draft.serviceName = svc.name
  }
  return Object.keys(draft).length > 0 ? draft : null
}

// On a single-booking reschedule, anchor the new slot on the EXISTING booking: keep its
// day and service unless the customer explicitly states a new one. Fixes "move 10:00->12:00"
// (a time-only change) being treated as a fresh booking that asks "which day?".
export function anchorRescheduleDraft(
  existing: { slotStart: Date; serviceTypeId: string },
  intent: CustomerIntentOutput,
  activeServices: Array<{ id: string; name: string; durationMinutes: number; maxParticipants: number; category: string | null; schedulingMode: 'appointment' | 'class' }>,
  tz: string,
  now: Date = new Date(),
): NonNullable<BookingFlowContext['slotDraft']> {
  const captured = buildDraftFromIntent(intent, activeServices, tz, now) ?? {}
  const svc = activeServices.find((s) => s.id === existing.serviceTypeId)
  const anchor: NonNullable<BookingFlowContext['slotDraft']> = {
    serviceTypeId: existing.serviceTypeId,
    ...(svc ? { serviceName: svc.name } : {}),
    dateStr: localParts(existing.slotStart, tz).dateStr,
  }
  // captured (what the customer actually said) overrides the anchor; buildDraftFromIntent only
  // sets dateStr when the customer named a day, so a time-only change keeps the anchor's date.
  return { ...anchor, ...captured }
}

// Root B — while a slot is awaiting confirmation, a non-"yes" reply may be the
// customer REVISING the request ("no, breathing instead", "make it Tuesday 7pm"),
// not answering yes/no. Re-extract intent; if they named a different
// service/day/time, release any held slot, seed a fresh draft from the slot they
// were about to confirm, and rebuild through the booking path so the NEW slot is
// what gets confirmed/committed. Returns the rebuilt FlowResult, or null when the
// reply carried no new slot information (genuine yes/no/ambiguity — caller handles).
async function rebuildOnSlotPivot(
  db: Db,
  calendar: CalendarClient,
  identity: ResolvedIdentity,
  session: ActiveSession,
  ctx: BookingFlowContext,
  messageText: string,
  businessTimezone: string,
  businessName: string,
  transcript: TranscriptTurn[],
  genReply: GenReply,
  business?: Business,
): Promise<FlowResult | null> {
  const svcRows = await db
    .select({
      id: serviceTypes.id,
      name: serviceTypes.name,
      durationMinutes: serviceTypes.durationMinutes,
      maxParticipants: serviceTypes.maxParticipants,
      category: serviceTypes.category,
      schedulingMode: serviceTypes.schedulingMode,
    })
    .from(serviceTypes)
    .where(and(eq(serviceTypes.businessId, identity.businessId), eq(serviceTypes.isActive, true)))

  const re = await extractCustomerIntent(
    messageText,
    {
      recentMessages: transcript.slice(-6).map((t) => `${t.role === 'customer' ? 'Customer' : 'Assistant'}: ${t.text}`),
      sessionState: session.state,
    },
    businessTimezone,
    svcRows.map((s) => s.name),
  )
  if (!re.ok) return null

  const intent = re.data
  // Capture a self-stated name supplied while a hold was pending (e.g. "I'm Harel, actually make
  // it Thursday"). This redispatch path extracts intent but otherwise bypasses the default
  // capture at line ~877. Non-blocking, never clobbers an existing name.
  await persistCapturedName(db, identity.businessId, identity.id, identity.displayName ?? null, intent.customerNameHint ?? null)
  const ns = intent.slotRequest
  const hasNewSlot =
    intent.serviceTypeHint != null ||
    (ns != null && (ns.time != null || ns.relativeDay != null || ns.weekday != null || ns.explicitDate != null))

  // The reply may not answer the pending slot at all. Two escape hatches:
  //  • REBUILD — a fresh booking/reschedule with a new slot → re-run the booking flow.
  //  • REDIRECT — an inquiry / cancellation / list ("what's free Wednesday?", "cancel
  //    Monday") → the customer has moved on; hand back to the dispatcher to answer it.
  // Without these, such a message parses as an 'unclear' confirmation and the PA re-asks
  // the SAME stale slot indefinitely (the live-test confirmation loop).
  const isRebuild = (intent.intent === 'booking' || intent.intent === 'rescheduling') && hasNewSlot
  // A pure inquiry / list while a HOLD is awaiting confirmation is a SIDE QUESTION, not
  // abandonment — do NOT redirect (which would clear the pending slot). Only a cancellation
  // (genuinely leaving the booking) still redirects from the confirmation step.
  const awaitingHold = session.state === 'waiting_confirmation' && ctx.awaitingConfirmationFor === 'hold'
  const isRedirect = !isRebuild && (
    intent.intent === 'cancellation' ||
    (!awaitingHold && (intent.intent === 'inquiry' || intent.intent === 'list_bookings'))
  )
  if (!isRebuild && !isRedirect) return null

  // Release any hold already placed for the stale slot so it isn't orphaned.
  if (ctx.pendingBookingId) {
    await cancelBooking(db, calendar, identity, ctx.pendingBookingId, 'Customer revised the request before confirming').catch(() => { /* non-fatal */ })
  }

  const ps = ctx.pendingSlot
  const seededDraft = ps ? slotDraftFromPending(ps, businessTimezone) : ctx.slotDraft
  // WS3-T3.2: also drop pendingDecision (and its legacy twins) so a redirect can't leave
  // stale booking-selection state that would re-bind the redirected reply next turn.
  const { pendingSlot: _ps, pendingBookingId: _pb, awaitingConfirmationFor: _a, pendingDecision: _pd, cancellationCandidates: _cc, isReschedulingFlow: _ir, pendingWaitlistJoin: _pwj, ...rest } = ctx
  // Negotiation memory: the customer just moved OFF the slot that was awaiting
  // confirmation — record it as rejected so we never re-offer that exact instant later
  // this session. (The new slot they pivoted to is pursued explicitly below, which
  // un-suppresses it if it happened to be on the rejected list.)
  const constraintsAfterReject = ps
    ? addRejectedSlots(rest.negotiationConstraints, [{ start: ps.start, end: ps.end, serviceTypeId: ps.serviceTypeId }])
    : rest.negotiationConstraints
  const rebuildCtx: BookingFlowContext = {
    ...rest,
    ...(seededDraft ? { slotDraft: seededDraft } : {}),
    ...(constraintsAfterReject && Object.keys(constraintsAfterReject).length > 0 ? { negotiationConstraints: constraintsAfterReject } : {}),
    clarificationAttempts: 0,
  }
  await updateSessionContext(db, session.id, rebuildCtx, 'active')

  // Redirect: the hold is now cleared in the DB; bubble a sentinel up so the dispatcher
  // re-routes the message through normal intent handling (the inquiry/cancellation
  // handlers there carry full business-knowledge context this helper doesn't).
  if (isRedirect) return { reply: '', sessionComplete: false, redispatch: true }

  return handleBookingIntent(
    db, calendar, identity,
    { ...session, state: 'active', context: rebuildCtx },
    rebuildCtx, intent, svcRows, businessTimezone, businessName, transcript, genReply, '', business,
  )
}

// P3: when the customer asks for an arrangement the catalog can't express (private/
// group/out-of-hours — flagged by the LLM as `specialArrangementRequest`) and the
// deterministic core has confirmed it's unfulfillable, notify the owner once per session
// and tell the customer it's been passed on. Returns a FlowResult to short-circuit the
// reject/clarify branch, or null to keep today's behaviour (no flag, no business, or
// already escalated this session).
export async function maybeEscalateSpecial(
  db: Db,
  business: Business | undefined,
  ctx: BookingFlowContext,
  session: ActiveSession,
  identity: ResolvedIdentity,
  intent: CustomerIntentOutput,
  transcript: TranscriptTurn[],
  lang: 'he' | 'en',
): Promise<FlowResult | null> {
  if (!business || intent.specialArrangementRequest !== true || ctx.specialRequestEscalated) return null
  const lastCustomer = [...transcript].reverse().find((t) => t.role === 'customer')?.text
  const requestText = intent.summary ?? lastCustomer ?? 'a special arrangement'
  const { customerReply } = await escalateUnfulfillableRequest(db, business, identity.phoneNumber, requestText, lang)
  // Keep the session OPEN (the customer may continue) but mark it escalated so we never
  // re-notify the owner for the same conversation.
  await updateSessionContext(db, session.id, { ...ctx, specialRequestEscalated: true }, 'active')
  return { reply: customerReply ?? '', sessionComplete: false, escalated: true }
}

// P4: after a successful cancel, snapshot the slot onto the customer profile so a
// follow-up "give me back the class we cancelled" can re-offer the exact time — even in
// a fresh session. The row still exists post-cancel (state='cancelled'), so we read it
// here. Best-effort: restore memory must never break the cancellation reply.
async function recordCancellationSnapshot(db: Db, identity: ResolvedIdentity, bookingId: string): Promise<void> {
  try {
    const [row] = await db
      .select({ serviceTypeId: bookings.serviceTypeId, serviceName: serviceTypes.name, slotStart: bookings.slotStart })
      .from(bookings)
      .innerJoin(serviceTypes, eq(serviceTypes.id, bookings.serviceTypeId))
      .where(eq(bookings.id, bookingId))
      .limit(1)
    if (!row) return
    await recordLastCancellation(db, identity.businessId, identity.id, {
      bookingId,
      serviceTypeId: row.serviceTypeId,
      serviceName: row.serviceName,
      slotStartIso: row.slotStart.toISOString(),
    })
  } catch { /* non-fatal */ }
}

// P4: a customer asking to undo a cancellation gets the EXACT cancelled slot re-offered
// from the per-identity snapshot, routed through the normal booking gate (which re-checks
// availability and asks for a fresh confirmation). Returns null — falling through to
// ordinary handling — when there's no usable snapshot (none recorded, older than the
// freshness window, the slot is now in the past, or the service is no longer active).
const LAST_CANCEL_RESTORE_WINDOW_MINUTES = parseInt(process.env['LAST_CANCEL_RESTORE_WINDOW_MINUTES'] ?? '120', 10)

// Pure decision: given a cancellation snapshot, decide whether (and as what draft) it can
// be restored. Returns null when there's nothing usable — stale (older than the window),
// the slot is now in the past, malformed, or the service is no longer active.
export function buildRestoreDraft(
  snap: { serviceTypeId: string; serviceName: string; slotStartIso: string },
  at: Date,
  now: Date,
  windowMinutes: number,
  activeServiceIds: Set<string>,
  tz: string,
): NonNullable<BookingFlowContext['slotDraft']> | null {
  const ageMinutes = (now.getTime() - at.getTime()) / 60_000
  const slotStart = new Date(snap.slotStartIso)
  if (ageMinutes > windowMinutes || isNaN(slotStart.getTime()) || slotStart.getTime() <= now.getTime()) return null
  if (!activeServiceIds.has(snap.serviceTypeId)) return null
  const lp = localParts(slotStart, tz)
  return {
    serviceTypeId: snap.serviceTypeId,
    serviceName: snap.serviceName,
    dateStr: lp.dateStr,
    time: { hour: Math.floor(lp.minutes / 60), minute: lp.minutes % 60 },
  }
}

async function handleRestoreCancelled(
  db: Db,
  calendar: CalendarClient,
  identity: ResolvedIdentity,
  session: ActiveSession,
  ctx: BookingFlowContext,
  businessTimezone: string,
  businessName: string,
  transcript: TranscriptTurn[],
  genReply: GenReply,
  activeServices: Array<{ id: string; name: string; durationMinutes: number; maxParticipants: number; category: string | null; schedulingMode: 'appointment' | 'class' }>,
  business?: Business,
): Promise<FlowResult | null> {
  const lang = ctx.detectedLanguage ?? 'en'
  const last = await loadLastCancellation(db, identity.id).catch(() => null)
  if (!last) return null

  const slotDraft = buildRestoreDraft(
    last.snap, last.at, new Date(), LAST_CANCEL_RESTORE_WINDOW_MINUTES,
    new Set(activeServices.map((s) => s.id)), businessTimezone,
  )
  if (!slotDraft) return null
  const newCtx: BookingFlowContext = { ...ctx, slotDraft }
  await updateSessionContext(db, session.id, newCtx, 'active')

  // Synthetic booking intent: the slot is fully in the draft, so the booking path runs
  // the deterministic gate (re-validates the slot is still open) and asks to confirm —
  // if someone took it meanwhile, the customer is told and offered alternatives.
  const synthetic: CustomerIntentOutput = {
    intent: 'booking', slotRequest: null, serviceTypeHint: null, providerHint: null,
    customerNameHint: null, participantsHint: null, summary: null, rawEntities: {}, detectedLanguage: lang,
  }
  return handleBookingIntent(
    db, calendar, identity,
    { ...session, state: 'active', context: newCtx },
    newCtx, synthetic, activeServices, businessTimezone, businessName, transcript, genReply, '', business,
  )
}

// ── Intent handlers ───────────────────────────────────────────────────────────

async function handleBookingIntent(
  db: Db,
  calendar: CalendarClient,
  identity: ResolvedIdentity,
  session: ActiveSession,
  ctx: BookingFlowContext,
  intent: CustomerIntentOutput,
  activeServices: Array<{ id: string; name: string; durationMinutes: number; maxParticipants: number; category: string | null; schedulingMode: 'appointment' | 'class' }>,
  businessTimezone: string,
  businessName: string,
  transcript: TranscriptTurn[],
  genReply: GenReply,
  firstMsgPrefix: string = '',
  business?: Business,
): Promise<FlowResult> {
  const lang = ctx.detectedLanguage ?? 'en'
  const now = new Date()
  const slot = intent.slotRequest
  const attempts = (ctx.clarificationAttempts as number | undefined) ?? 0
  const persona = ctx.botPersona ? { botPersona: ctx.botPersona } : {}

  // ── Merge newly-extracted pieces into the incremental slot draft ──────────
  // We never re-ask something already captured. Internal state only (G2).
  const draft: NonNullable<BookingFlowContext['slotDraft']> = { ...(ctx.slotDraft ?? {}) }

  // WS3-T3.5: consume a pending "today or next week?" clarification FIRST. Last turn we
  // asked because a bare same-day weekday was ambiguous; bind this turn's answer to one of
  // the two stashed dates, then clear the pending marker (whatever the answer was — a
  // different concrete day falls through to normal resolution below, which wins).
  // When the consume BINDS the date from the two stashed dates (the answer was today/this or
  // next_week/next), the date-resolution block below must be SKIPPED — otherwise it re-runs
  // resolveRequestedDate on the bare "next week" answer (relativeDay:'next_week', weekday:null),
  // gets ambiguous_date, and dead-ends into the "which day?" clarify loop, discarding the
  // perfectly good bound date. A different concrete day this turn does NOT bind here and falls
  // through to normal resolution (which wins).
  let boundFromWeekdayClarification = false
  // WS3-T3.5 BUG4: a marker may survive a serviceless turn — when last turn detected the
  // ambiguity but no service was known yet (so the "today or next week?" ask couldn't fire),
  // we stashed the marker WITHOUT committing a date. If this turn brings neither a today/
  // next-week answer NOR a fresh concrete day (e.g. the customer just now names the service),
  // keep the marker alive so the ask re-fires once the service resolves below — never let it
  // silently fall through and book today.
  let carriedWeekdayClarification: BookingFlowContext['pendingWeekdayClarification'] | null = null
  if (ctx.pendingWeekdayClarification) {
    const pending = ctx.pendingWeekdayClarification
    const bound = consumeWeekdayClarification(pending, {
      relativeDay: slot?.relativeDay ?? null,
      weekdayAnchor: slot?.weekdayAnchor ?? null,
    })
    const broughtFreshDay = Boolean(slot && (slot.relativeDay || slot.weekday != null || slot.explicitDate))
    if (bound) { draft.dateStr = bound; boundFromWeekdayClarification = true }
    else if (carriesWeekdayClarification(true, false, broughtFreshDay)) carriedWeekdayClarification = pending
    // else: a different concrete day this turn → normal resolution below wins.
    const { pendingWeekdayClarification: _clearedPending, ...restCtx } = ctx
    ctx = restCtx as BookingFlowContext
  }

  // Date — resolved DETERMINISTICALLY from structured pieces; LLM never computes.
  let dateProblem: string | null = null
  let ambiguousTodayWeekday: { weekday: number; todayStr: string; nextWeekStr: string } | null = null
  if (!boundFromWeekdayClarification && slot && (slot.relativeDay || slot.weekday != null || slot.explicitDate)) {
    const parts: RequestedDateParts = {
      relativeDay: slot.relativeDay ?? null,
      weekday: slot.weekday ?? null,
      weekdayAnchor: slot.weekdayAnchor ?? null,
      explicitDate: slot.explicitDate ?? null,
    }
    const resolved = resolveRequestedDate(parts, businessTimezone, now)
    if (resolved.ok) {
      draft.dateStr = resolved.dateStr
      // WS3-T3.5: bare same-day weekday — the resolver flags it; the actual ask/roll/full
      // decision needs the resolved SERVICE, so we defer it to AFTER service resolution.
      if (resolved.ambiguousToday && resolved.nextWeekStr && slot.weekday != null) {
        ambiguousTodayWeekday = { weekday: slot.weekday, todayStr: resolved.dateStr, nextWeekStr: resolved.nextWeekStr }
      }
    } else if (resolved.reason !== 'no_date') dateProblem = resolved.reason
  }
  // WS3-T3.5 BUG4: re-hydrate the deferred ambiguity from a carried marker (a serviceless turn
  // last time stashed it without a date). Only when this turn produced no fresh ambiguity of its
  // own and bound no date — so once the service resolves below, the "today or next week?" ask
  // fires instead of silently booking today.
  if (!ambiguousTodayWeekday && !boundFromWeekdayClarification && carriedWeekdayClarification && draft.dateStr == null) {
    ambiguousTodayWeekday = {
      weekday: carriedWeekdayClarification.weekday,
      todayStr: carriedWeekdayClarification.todayStr,
      nextWeekStr: carriedWeekdayClarification.nextWeekStr,
    }
  }
  if (slot?.time) draft.time = { hour: slot.time.hour, minute: slot.time.minute }

  let service =
    resolveService(intent.serviceTypeHint, activeServices) ??
    (draft.serviceTypeId ? activeServices.find((s) => s.id === draft.serviceTypeId) ?? null : null) ??
    // Referential fallback: the customer is continuing ("the one we discussed",
    // "sign me up", "yes") without re-naming the service. Adopt the single service
    // the conversation has clearly been about — never guess when it's ambiguous.
    inferFocusService(transcript, activeServices)

  // Anti-fabrication, service-fidelity (ANTI_FABRICATION §4.2). Never LOCK the
  // customer's remembered "usual" service when they did not raise it THIS
  // conversation. The PA may have proposed it from cross-session preferred-service
  // memory ("yoga as usual?"); inferFocusService would then launder that proposal
  // back in from the PA's own turn and book a service the customer never affirmed
  // (observed live: a pilates thread silently switched to yoga on an underspecified
  // "sign me up for 12"). Require a real customer signal — an explicit hint this
  // turn, an already-locked draft, or the customer naming it — before adopting the
  // remembered favourite. Otherwise drop to null so the flow asks which service.
  // `memoryForActiveService` covers the in-flight case; this covers fresh bookings.
  const preferredFavourite = (ctx as unknown as Partial<HydratedContext>).preferredServiceName ?? null
  if (
    service &&
    activeServices.length > 1 &&
    !intent.serviceTypeHint &&
    !draft.serviceTypeId &&
    preferredFavourite != null &&
    service.name === preferredFavourite &&
    !customerReferencedService(transcript, service)
  ) {
    service = null
  }

  if (service) {
    draft.serviceTypeId = service.id
    draft.serviceName = service.name
  }
  if (intent.participantsHint != null) draft.participants = intent.participantsHint

  // Phase 4 (churn): after several failed tries, DON'T fail the session — that ends
  // it, so the next message spawns a fresh session that re-greets and loses the
  // draft (the 18-sessions-in-90-min churn). Instead keep it alive: drop the
  // unworkable date/time (keep the service), reset the counter, and nudge toward a
  // call while staying open to keep trying. One continuous session, state intact.
  const nudgeAfterRepeatedTries = async (): Promise<FlowResult> => {
    // Only nudge toward a phone call when the spine GENUINELY has nothing — never on a
    // string of fabricated/empty turns. If real options exist, surface them instead.
    const svcId = draft.serviceTypeId
    const next = business
      ? await suggestNextClassesText(db, business, svcId, businessTimezone, ctx.negotiationConstraints).catch(() => NO_SUGGESTION)
      : NO_SUGGESTION
    const { dateStr: _droppedDate, time: _droppedTime, ...keptDraft } = draft
    if (next.text) {
      await updateSessionContext(db, session.id, {
        ...ctx, slotDraft: keptDraft, clarificationAttempts: 0,
        ...(next.offered.length > 0 ? { lastOfferedSlots: next.offered } : {}),
      }, 'waiting_clarification')
      const reply = await genReply({
        businessTimezone,
        businessName, language: lang, transcript, ...persona, customerMemory: extractMemory(ctx),
        situation: `The customer has gone back and forth on dates/times. Don't suggest a phone call — there ARE real upcoming options: ${next.text} Offer these and ask which they'd like. Do NOT say anything is full.`,
      })
      return { reply, sessionComplete: false }
    }
    await updateSessionContext(db, session.id, { ...ctx, slotDraft: keptDraft, clarificationAttempts: 0 }, 'waiting_clarification')
    const reply = await genReply({
      businessTimezone,
      businessName, language: lang, transcript, ...persona, customerMemory: extractMemory(ctx),
      situation: 'The customer has struggled to land on a workable date/time after several tries, and there are genuinely no upcoming openings to offer. Warmly suggest it might be quickest to sort out by phone with the business — but stay open: invite them to name another day and you will keep trying. Do NOT end the conversation or say goodbye.',
    })
    return { reply, sessionComplete: false }
  }

  // ── WS3-T3.5 BUG4: ambiguity detected but no service yet → DON'T silently book today.
  // Previously this branch was gated on draft.serviceTypeId, so a serviceless turn skipped it,
  // the missing-pieces gate persisted draft.dateStr=today, and next turn (service named, no
  // weekday) the ambiguity was gone → silent same-day booking. Instead: drop the provisional
  // `today` date and stash the marker (without a serviceTypeId — it's still unknown) so the
  // ask survives. Once the service arrives next turn, the carried-marker re-hydration above
  // re-raises the ambiguity and the ask fires. No customer-facing string here.
  if (ambiguousTodayWeekday && !draft.serviceTypeId) {
    const { dateStr: _dropProvisionalToday, ...draftNoDate } = draft
    await updateSessionContext(db, session.id, {
      ...ctx,
      slotDraft: draftNoDate,
      pendingWeekdayClarification: {
        weekday: ambiguousTodayWeekday.weekday,
        todayStr: ambiguousTodayWeekday.todayStr,
        nextWeekStr: ambiguousTodayWeekday.nextWeekStr,
      },
    }, 'waiting_clarification')
    const list = activeServices.map((s) => s.name).join(', ')
    const reply = await genReply({
      businessTimezone,
      businessName, language: lang, transcript, ...persona, customerMemory: extractMemory(ctx),
      situation: `${firstMsgPrefix}The customer wants to book but hasn't said which service. Available: ${list}. Ask which one — one question, naturally.`,
    })
    return { reply, sessionComplete: false }
  }

  // ── WS3-T3.5: bare same-day weekday — today or same day next week? ──────────
  // The resolver flagged ambiguity; the decision needs the resolved SERVICE, so it runs
  // HERE (after service resolution). If no service is known yet, the branch above handled it.
  if (ambiguousTodayWeekday && draft.serviceTypeId && business) {
    const serviceTypeId = draft.serviceTypeId
    const serviceName = draft.serviceName ?? 'this'
    const todayStr = ambiguousTodayWeekday.todayStr // == business-local today
    // Single DB fetch with now=midnight disables past-filtering → ALL of today's sessions.
    const dayMidnight = resolveSlotStart(todayStr, { hour: 0, minute: 0 }, businessTimezone)
    const fullDay = await listDayOptions(db, business, todayStr, businessTimezone, { serviceTypeId, now: dayMidnight })
    // Split in memory against the REAL now: only sessions still to come today are "live".
    const liveClasses = fullDay.classes.filter((c) => c.start.getTime() >= now.getTime())
    const livePrivateOpen = fullDay.privateOpenings.some((p) => p.slots.some((s) => s.getTime() >= now.getTime()))
    const decision = decideAmbiguousTodayWeekday(liveClasses, livePrivateOpen)

    if (decision === 'roll') {
      // Every session already started → silently roll to next week; fall through to normal flow.
      draft.dateStr = ambiguousTodayWeekday.nextWeekStr
    } else if (decision === 'ask') {
      const weekdayLabel = formatLocalDate(todayStr, businessTimezone)
      await updateSessionContext(db, session.id, {
        ...ctx,
        slotDraft: draft,
        pendingWeekdayClarification: { weekday: ambiguousTodayWeekday.weekday, todayStr, nextWeekStr: ambiguousTodayWeekday.nextWeekStr, serviceTypeId },
      }, 'waiting_clarification')
      const reply = await genReply({
        businessTimezone,
        businessName, language: lang, transcript, ...persona, customerMemory: memoryForActiveService(ctx, serviceName),
        situation: `${firstMsgPrefix}${ambiguousTodayWeekdayAsk(serviceName, weekdayLabel)}`,
      })
      return { reply, sessionComplete: false }
    } else {
      // 'full': sessions remain today but all full → say so + offer the next real classes.
      const substitute = await suggestNextClassesText(db, business, serviceTypeId, businessTimezone, ctx.negotiationConstraints)
      await updateSessionContext(db, session.id, {
        ...ctx,
        slotDraft: draft,
        ...(substitute.offered.length > 0 ? { lastOfferedSlots: substitute.offered } : {}),
      }, 'waiting_clarification')
      const reply = await genReply({
        businessTimezone,
        businessName, language: lang, transcript, ...persona, customerMemory: memoryForActiveService(ctx, serviceName),
        situation: `${firstMsgPrefix}${classOfferSituation(serviceName, formatLocalDate(todayStr, businessTimezone), null, substitute.text)}`,
      })
      return { reply, sessionComplete: false }
    }
  }

  // ── A bad date (past / impossible / ambiguous): clarify, don't echo it back ─
  if (dateProblem) {
    const newAttempts = attempts + 1
    if (newAttempts >= MAX_CLARIFICATION_ATTEMPTS) return nudgeAfterRepeatedTries()
    await updateSessionContext(db, session.id, { ...ctx, slotDraft: draft, clarificationAttempts: newAttempts }, 'waiting_clarification')
    const reply = await genReply({
      businessTimezone,
      businessName, language: lang, transcript, ...persona, customerMemory: extractMemory(ctx),
      situation: `${firstMsgPrefix}The customer wants to book but ${sanitiseReason(dateProblem)}. Without repeating the unusable date back, ask which upcoming day they'd like.`,
    })
    return { reply, sessionComplete: false }
  }

  // ── Still missing one of {service, date, time}? Ask for exactly one ────────
  if (!draft.serviceTypeId || !draft.dateStr || !draft.time) {
    const newAttempts = attempts + 1
    if (newAttempts >= MAX_CLARIFICATION_ATTEMPTS) return nudgeAfterRepeatedTries()

    let ask: string
    let offeredSlots: RejectedSlot[] = []
    if (!draft.serviceTypeId) {
      const list = activeServices.map((s) => s.name).join(', ')
      ask = `The customer wants to book but hasn't said which service. Available: ${list}. Ask which one — one question, naturally.`
    } else if (!draft.dateStr) {
      ask = `Booking ${draft.serviceName}. Still need the day — ask which day works. Do NOT re-ask the service.`
    } else {
      // Day known, time missing: surface THAT day's real options into the situation
      // so the PA offers true times (which the fabrication guard accepts) instead of
      // recalling them from the transcript (which the guard strips → unhelpful "which
      // day?" fallback) or, worse, asserting the day is full.
      const dayOpts = business
        ? await buildDayOptionsText(db, business, draft.dateStr, businessTimezone, draft.serviceTypeId, ctx.negotiationConstraints, null, true)
        : NO_SUGGESTION
      const dayLabel = formatLocalDate(draft.dateStr, businessTimezone)
      // Same-day empty/all-full → substitute the next REAL class on a later day so the lead
      // is never dead-ended; bind the pick to whichever set actually carries options.
      const substitute = dayOpts.text || !business
        ? NO_SUGGESTION
        : await suggestNextClassesText(db, business, draft.serviceTypeId, businessTimezone, ctx.negotiationConstraints)
      offeredSlots = dayOpts.text ? dayOpts.offered : substitute.offered
      ask = classOfferSituation(draft.serviceName ?? 'this', dayLabel, dayOpts.text, substitute.text)
    }
    await updateSessionContext(db, session.id, {
      ...ctx, slotDraft: draft, clarificationAttempts: newAttempts,
      ...(offeredSlots.length > 0 ? { lastOfferedSlots: offeredSlots } : {}),
    }, 'waiting_clarification')
    const reply = await genReply({
      businessTimezone,
      businessName, language: lang, transcript, ...persona, customerMemory: extractMemory(ctx),
      situation: `${firstMsgPrefix}${ask}`,
    }, { focusDay: { dateStr: draft.dateStr!, ...(draft.serviceTypeId ? { serviceTypeId: draft.serviceTypeId } : {}) } })
    return { reply, sessionComplete: false }
  }

  // ── All pieces present: compose the absolute slot, then the DETERMINISTIC gate ─
  const svc = activeServices.find((s) => s.id === draft.serviceTypeId)!

  // Party-size vs service model: don't silently confirm "yoga for 3" on a 1-on-1.
  if (draft.participants != null && draft.participants > 1 && svc.maxParticipants === 1) {
    // A genuine special-arrangement request (e.g. "private session for 5") → pass it to
    // the owner instead of dead-ending with "it's 1-on-1".
    const esc = await maybeEscalateSpecial(db, business, ctx, session, identity, intent, transcript, lang)
    if (esc) return esc
    const { participants: _dropParticipants, ...draftKeep } = draft
    await updateSessionContext(db, session.id, { ...ctx, slotDraft: draftKeep, clarificationAttempts: attempts + 1 }, 'waiting_clarification')
    const reply = await genReply({
      businessTimezone,
      businessName, language: lang, transcript, ...persona, customerMemory: extractMemory(ctx),
      situation: `${svc.name} is a private, one-on-one session — it can't take ${draft.participants} people on a single booking. Ask whether they'd like to go ahead with just one spot, or if they meant something else.`,
    })
    return { reply, sessionComplete: false }
  }
  if (draft.participants != null && draft.participants > svc.maxParticipants && svc.maxParticipants > 1) {
    const esc = await maybeEscalateSpecial(db, business, ctx, session, identity, intent, transcript, lang)
    if (esc) return esc
    const { participants: _dropParticipants, ...draftKeep } = draft
    await updateSessionContext(db, session.id, { ...ctx, slotDraft: draftKeep, clarificationAttempts: attempts + 1 }, 'waiting_clarification')
    const reply = await genReply({
      businessTimezone,
      businessName, language: lang, transcript, ...persona, customerMemory: extractMemory(ctx),
      situation: `${svc.name} holds at most ${svc.maxParticipants} people, and they asked for ${draft.participants}. Let them know the limit and ask how they'd like to proceed.`,
    })
    return { reply, sessionComplete: false }
  }

  const slotStart = resolveSlotStart(draft.dateStr, draft.time, businessTimezone)
  const slotEnd = new Date(slotStart.getTime() + svc.durationMinutes * 60_000)

  // DST gap — the requested wall-clock time doesn't exist that day.
  if (isNaN(slotStart.getTime()) || isDstGap(slotStart, draft.time, businessTimezone)) {
    const { time: _dropTime, ...draftKeep } = draft
    await updateSessionContext(db, session.id, { ...ctx, slotDraft: draftKeep, clarificationAttempts: attempts + 1 }, 'waiting_clarification')
    const reply = await genReply({
      businessTimezone,
      businessName, language: lang, transcript, ...persona, customerMemory: extractMemory(ctx),
      situation: 'That exact time does not exist on the clock that day (a daylight-saving shift). Ask the customer to pick a different time.',
    })
    return { reply, sessionComplete: false }
  }

  // Timing policy (past / buffer / max-days) + business hours — BEFORE confirming.
  const buffer = business?.minBookingBufferMinutes ?? 30
  const maxDays = business?.maxBookingDaysAhead ?? 365
  const timingError = validateSlotTiming(slotStart, slotEnd, buffer, maxDays)
  let outsideHours = false
  if (!timingError && business) {
    const blockTypes: CalendarBlockType[] = svc.maxParticipants > 1 ? ['block', 'personal'] : ['block', 'personal', 'class']
    const bookable = await isSlotBookable(db, business, { start: slotStart, end: slotEnd }, { includeBookings: false, blockTypes })
    if (!bookable.bookable && (bookable.reason === 'outside_hours' || bookable.reason === 'invalid_slot')) outsideHours = true
  }

  if (timingError || outsideHours) {
    // A genuine "private session OUTSIDE opening hours" request → pass it to the owner
    // rather than just bouncing the customer to in-hours slots. Only when the time is
    // actually out-of-hours (not a past/buffer timingError) and the LLM flagged a
    // special arrangement; an ordinary bad-time keeps today's "here are real openings".
    if (outsideHours && !timingError) {
      const esc = await maybeEscalateSpecial(db, business, ctx, session, identity, intent, transcript, lang)
      if (esc) return esc
    }
    // Drop the bad time, keep date + service, and offer real openings immediately.
    const { time: _dropTime, ...draftKeep } = draft
    const suggestion = business
      ? await suggestOpenSlotsText(db, business, svc.id, slotStart, slotEnd, businessTimezone, ctx.negotiationConstraints)
      : NO_SUGGESTION
    await updateSessionContext(db, session.id, {
      ...ctx, slotDraft: draftKeep, clarificationAttempts: 0,
      ...(suggestion.offered.length > 0 ? { lastOfferedSlots: suggestion.offered } : {}),
    }, 'waiting_clarification')
    const openSlotsText = suggestion.text
    const hoursSummary = business ? await loadHoursSummary(db, business.id) : null
    const problemReason = timingError ? sanitiseReason(timingError) : sanitiseReason('outside_hours')
    const situation = [
      `The customer asked to book ${svc.name} at a time that won't work — ${problemReason}.`,
      hoursSummary ?? '',
      openSlotsText
        ? `Offer these actual open times and ask which they'd like: ${openSlotsText}.`
        : 'Ask them to pick a time within business hours.',
    ].filter(Boolean).join(' ')
    const reply = await genReply({
      businessTimezone,
      businessName, language: lang, transcript, ...persona, customerMemory: extractMemory(ctx),
      situation,
    })
    return { reply, sessionComplete: false }
  }

  // ── Schedule-driven class gate: a 'class' service is bookable ONLY into a real
  // scheduled class instance. Verify a class block exists at the resolved slot BEFORE
  // we ever ask the customer to confirm — otherwise the PA fabricates a class at an
  // invented time ("yes, there's a yoga class at 17:00" when yoga only runs 10/12/16),
  // and the customer is led to confirm a slot that does not exist on the calendar. This
  // mirrors the engine's no_class_at_time backstop (Bug E) but moves it ahead of the
  // confirmation step, so the PA never asserts a class that isn't on the schedule.
  if (business && await classInstanceMissing(db, business.id, svc, slotStart)) {
    const { time: _dropTime, ...draftKeep } = draft
    const missDateStr = localParts(slotStart, businessTimezone).dateStr
    const suggestion = await buildDayOptionsText(db, business, missDateStr, businessTimezone, svc.id, ctx.negotiationConstraints, null, true)
    // Same-day empty/all-full → substitute the next REAL class so we never dead-end the lead.
    const substitute = suggestion.text
      ? NO_SUGGESTION
      : await suggestNextClassesText(db, business, svc.id, businessTimezone, ctx.negotiationConstraints)
    const offeredAlts = suggestion.text ? suggestion.offered : substitute.offered
    await updateSessionContext(db, session.id, {
      ...ctx, slotDraft: draftKeep, clarificationAttempts: 0,
      ...(offeredAlts.length > 0 ? { lastOfferedSlots: offeredAlts } : {}),
    }, 'waiting_clarification')
    const situation = [
      `${svc.name} doesn't run at the time the customer asked — it only runs at set class times, so that exact time can't be booked.`,
      classOfferSituation(svc.name, formatLocalDate(missDateStr, businessTimezone), suggestion.text, substitute.text),
    ].filter(Boolean).join(' ')
    const reply = await genReply({
      businessTimezone,
      businessName, language: lang, transcript, ...persona, customerMemory: extractMemory(ctx),
      situation,
    }, { focusDay: { dateStr: missDateStr, serviceTypeId: svc.id } })
    return { reply, sessionComplete: false }
  }

  // ── WL-3: the requested class EXISTS on the schedule but is FULL ───────────
  // It passed classInstanceMissing (the block is real), so it's a genuine session with no seats.
  // ADD a waitlist offer for that exact slot ALONGSIDE the later-session substitute — one warm
  // message, one question, never a dead-end. We stash the offered slot in pendingWaitlistJoin so a
  // follow-up "yes" joins THAT slot via handleWaitlistJoinRequest (not a fresh booking). offerable
  // mode drops the full class and flags it as fullRequestedSlot; an open class never sets it, so
  // normal booking proceeds untouched.
  if (business && svc.schedulingMode === 'class') {
    const reqDateStr = localParts(slotStart, businessTimezone).dateStr
    const dayOpts = await buildDayOptionsText(db, business, reqDateStr, businessTimezone, svc.id, ctx.negotiationConstraints, null, true, slotStart)
    if (dayOpts.fullRequestedSlot) {
      const { time: _dropTime, ...draftKeep } = draft
      // Substitute the next REAL classes so the lead is never dead-ended — kept SEPARATE from the
      // waitlist offer (WL-3 ADDS the offer, it does not replace the substitute).
      const substitute = await suggestNextClassesText(db, business, svc.id, businessTimezone, ctx.negotiationConstraints)
      const offeredAlts = substitute.offered
      const newCtx: BookingFlowContext = {
        ...ctx, slotDraft: draftKeep, clarificationAttempts: 0,
        pendingWaitlistJoin: dayOpts.fullRequestedSlot,
        ...(offeredAlts.length > 0 ? { lastOfferedSlots: offeredAlts } : {}),
      }
      await updateSessionContext(db, session.id, newCtx, 'waiting_clarification')
      const dayLabel = formatLocalDate(reqDateStr, businessTimezone)
      const timeLabel = formatSlotTime(slotStart, businessTimezone)
      const substituteClause = substitute.text
        ? ` If they'd rather take a real spot sooner, the next real ${svc.name} classes are: ${substitute.text} — offer those too, in the same breath.`
        : ''
      const situation = `The ${svc.name} session on ${dayLabel} at ${timeLabel} is full. In ONE warm, first-person message, offer to keep their place on the waitlist for that exact session and let them know you'll message them the moment a spot opens — phrase it as a single gentle question (no yes/no menu, no numbered list).${substituteClause} Never present the full session as bookable, and never dead-end them.`
      const reply = await genReply({
        businessTimezone,
        businessName, language: lang, transcript, ...persona, customerMemory: extractMemory(ctx),
        situation: `${firstMsgPrefix}${situation}`,
      }, { focusDay: { dateStr: reqDateStr, serviceTypeId: svc.id } })
      return { reply, sessionComplete: false }
    }
  }

  // ── Passed every gate: confirmation built from the RESOLVED slot (never the LLM's date) ─
  const displayDate = formatSlotDate(slotStart, businessTimezone)
  const displayTime = formatSlotTime(slotStart, businessTimezone)

  const { slotDraft: _clearDraft, negotiationConstraints: _ncDrop, lastOfferedSlots: _loDrop, ...ctxBase } = ctx
  // Explicit pursuit of this exact slot overrides any earlier rejection of it
  // (mind-change): clear it from the rejected list so it isn't shadow-suppressed later.
  const constraintsForConfirm = removeRejectedSlot(ctx.negotiationConstraints, slotStart.toISOString())
  const newCtx: BookingFlowContext = {
    ...ctxBase,
    ...(Object.keys(constraintsForConfirm).length > 0 ? { negotiationConstraints: constraintsForConfirm } : {}),
    clarificationAttempts: 0,
    pendingSlot: {
      start: slotStart.toISOString(),
      end: slotEnd.toISOString(),
      serviceTypeId: svc.id,
      serviceName: svc.name,
      providerHint: intent.providerHint ?? null,
    },
    awaitingConfirmationFor: 'hold',
  }

  await updateSessionContext(db, session.id, newCtx, 'waiting_confirmation')
  const reply = await genReply({
    businessTimezone,
    businessName, language: lang, transcript, ...persona, customerMemory: extractMemory(ctx),
    situation: `${firstMsgPrefix}Customer wants to book ${svc.name} on ${displayDate} at ${displayTime}. Restate the service, day, date and time clearly, then ask them to confirm.`,
  })
  return { reply, sessionComplete: false }
}

/**
 * Release the booking that a reschedule is replacing. Called only once the new
 * booking is actually secured (confirmed), so a customer is never left without an
 * appointment if the requested new slot turns out to be unavailable.
 *
 * Best-effort by design: the replacement booking has already committed, so a
 * failure here means the customer briefly holds two slots — a visible, recoverable
 * state — rather than losing the new booking we just made. We never throw out of
 * the confirmation path on account of the old slot.
 */
async function releaseSupersededBooking(
  db: Db,
  calendar: CalendarClient,
  identity: ResolvedIdentity,
  ctx: BookingFlowContext,
  // The id of the replacement booking. Defaults to ctx.pendingBookingId (appointment path, where
  // the hold is confirmed). The group-class direct-confirm path has no pendingBookingId — it passes
  // result.bookingId explicitly so the 'moved' notice still fires (Defect 2).
  newBookingIdOverride?: string,
): Promise<void> {
  if (!ctx.rescheduledFrom) return
  const newBookingId = newBookingIdOverride ?? ctx.pendingBookingId
  let oldSlot: Date | null = null
  let newSlot: Date | null = null
  let serviceTypeId: string | null = null
  try {
    const [oldB] = await db
      .select({ slotStart: bookings.slotStart, serviceTypeId: bookings.serviceTypeId })
      .from(bookings)
      .where(eq(bookings.id, ctx.rescheduledFrom))
      .limit(1)
    oldSlot = oldB?.slotStart ?? null
    serviceTypeId = oldB?.serviceTypeId ?? null
    if (newBookingId) {
      const [newB] = await db
        .select({ slotStart: bookings.slotStart })
        .from(bookings)
        .where(eq(bookings.id, newBookingId))
        .limit(1)
      newSlot = newB?.slotStart ?? null
    }
    await cancelBooking(db, calendar, identity, ctx.rescheduledFrom, 'Superseded by reschedule')
  } catch {
    /* old slot lingers; surfaced via the customer's upcoming-appointments view + reminders */
  }

  // A reschedule is a single owner-facing 'moved' notice (customer-originated), not a cancel +
  // a new booking. The customer-self new-booking notice is suppressed at the engine (the confirm/
  // request callers pass suppressOwnerNewBookingNotice on the reschedule path), so this is the only
  // owner notice for the move — we surface it once, with both slots.
  if (oldSlot && newSlot && newBookingId) {
    notifyOwnerBookingChange(db, identity.businessId, {
      kind: 'moved',
      origin: 'customer',
      actorIsManager: false,
      bookingId: newBookingId,
      customerId: identity.id,
      serviceTypeId,
      fromSlotStart: oldSlot,
      slotStart: newSlot,
    }).catch(() => { /* non-fatal */ })
  }
}

async function handleReschedulingIntent(
  db: Db,
  calendar: CalendarClient,
  identity: ResolvedIdentity,
  session: ActiveSession,
  ctx: BookingFlowContext,
  intent: CustomerIntentOutput,
  activeServices: Array<{ id: string; name: string; durationMinutes: number; maxParticipants: number; category: string | null; schedulingMode: 'appointment' | 'class' }>,
  businessTimezone: string,
  businessName: string,
  transcript: TranscriptTurn[],
  genReply: GenReply,
  business?: Business,
): Promise<FlowResult> {
  const lang = ctx.detectedLanguage ?? 'en'

  const activeBookings = await db
    .select({ id: bookings.id, slotStart: bookings.slotStart, serviceTypeId: bookings.serviceTypeId })
    .from(bookings)
    .where(
      and(
        eq(bookings.customerId, identity.id),
        eq(bookings.businessId, identity.businessId),
        or(eq(bookings.state, 'confirmed'), eq(bookings.state, 'held')),
      ),
    )

  if (activeBookings.length === 0) {
    return handleBookingIntent(db, calendar, identity, session, ctx, intent, activeServices, businessTimezone, businessName, transcript, genReply, '', business)
  }

  if (activeBookings.length > 1) {
    // Preserve any new slot the customer already gave ("move my yoga to Sunday 3pm")
    // so the which-booking selection detour doesn't drop it and re-ask. It's applied
    // once they pick which booking to move (see handleCancellationConfirmation).
    const captured = buildDraftFromIntent(intent, activeServices, businessTimezone)
    const ctxForSelection: BookingFlowContext = captured
      ? { ...ctx, slotDraft: { ...(ctx.slotDraft ?? {}), ...captured } }
      : ctx
    return enterCancellationSelection(db, session, ctxForSelection, activeBookings, businessTimezone, businessName, transcript, genReply, lang, true)
  }

  const existing = activeBookings[0]!
  // Deferred-cancel reschedule. Do NOT release the current booking yet. If we cancel
  // first and the requested new slot turns out to be unavailable (e.g. a fully-booked
  // week where the customer asks to move onto an already-taken slot), the customer is
  // left with nothing — original gone, replacement refused. Instead we carry
  // `rescheduledFrom` through the booking flow and release the old slot only once the
  // new one is actually secured (see releaseSupersededBooking, called at the
  // confirmation success points in handleHoldConfirmation). Until then — including if
  // the customer declines the proposed slot — they keep their original appointment.
  const anchored = anchorRescheduleDraft(existing, intent, activeServices, businessTimezone)
  const newCtx: BookingFlowContext = {
    ...ctx,
    rescheduledFrom: existing.id,
    slotDraft: { ...(ctx.slotDraft ?? {}), ...anchored },
  }
  return handleBookingIntent(db, calendar, identity, session, newCtx, intent, activeServices, businessTimezone, businessName, transcript, genReply, '', business)
}

async function handleHoldConfirmation(
  db: Db,
  calendar: CalendarClient,
  identity: ResolvedIdentity,
  session: ActiveSession,
  ctx: BookingFlowContext,
  messageText: string,
  businessTimezone: string,
  businessName: string,
  transcript: TranscriptTurn[],
  genReply: GenReply,
  business?: Business,
): Promise<FlowResult> {
  const lang = ctx.detectedLanguage ?? 'en'
  const parsed = parseConfirmation(messageText)
  // A leading yes bundled with a side question (e.g. "yes, who's the instructor?") is still
  // a confirmation — the grounded reply answers the question (roster/facts are in businessFacts).
  // BUT (C1): a yes_with_question carrying a DAY REVISION ("yes, anything Thursday?") parses as
  // yes_with_question (it has a '?', no clock time) yet must NOT book the stale slot. The cheap
  // hasRevisionSignal pre-gate flags ANY day token — but that over-triggers on a confirming
  // side-QUESTION about the HELD day ("yes, is Sunday full?" when the held slot IS Sunday).
  // classifyConfirmWithQuestion is the arbiter: it compares the mentioned day to the held slot's
  // weekday. Only a DIFFERENT day (or a relative-day token) is a revision → 'unclear' (pivot
  // path); a same-held-day side question stays 'yes' so the confirm+bundled-answer split (T3.6)
  // books AND answers it.
  const heldWeekday = ctx.pendingSlot
    ? localWeekdayOf(new Date(ctx.pendingSlot.start), businessTimezone)
    : null
  const confirmation: 'yes' | 'no' | 'unclear' =
    parsed === 'yes_with_question'
      ? (hasRevisionSignal(messageText) && classifyConfirmWithQuestion(messageText, heldWeekday) === 'revise'
          ? 'unclear'
          : 'yes')
      : parsed

  // Root B: a non-"yes" reply may be REVISING the slot, not answering. If so, rebuild
  // from the new request so the revised slot is what gets booked (not the stale one).
  if (confirmation !== 'yes') {
    const rebuilt = await rebuildOnSlotPivot(
      db, calendar, identity, session, ctx, messageText, businessTimezone, businessName, transcript, genReply, business,
    )
    if (rebuilt) return rebuilt
  }

  if (confirmation === 'unclear') {
    // Phase 2: re-ask is self-describing — anchored on the EXACT pending slot, not
    // whatever the transcript implies, so a stale conversation can't mislead it.
    const ps = ctx.pendingSlot
    const slotPhrase = ps
      ? `${ps.serviceName} on ${formatSlotDate(new Date(ps.start), businessTimezone)} at ${formatSlotTime(new Date(ps.start), businessTimezone)}`
      : 'the appointment'
    const reply = await genReply({
      businessTimezone,
      businessName,
      language: lang,
      situation: `The customer's reply wasn't a clear yes or no. The slot waiting to be confirmed is: ${slotPhrase}. Restate exactly that slot (service, day, time) and ask in plain words whether to lock it in — no menu. Use ONLY these details; ignore any different service/day/time mentioned earlier in the chat.`,
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: memoryForActiveService(ctx, ctx.pendingSlot?.serviceName ?? null),
    })
    return { reply, sessionComplete: false }
  }

  if (confirmation === 'no') {
    await completeSession(db, session.id)
    const declinedService = ctx.pendingSlot?.serviceName ?? null
    const reply = await genReply({
      businessTimezone,
      businessName,
      language: lang,
      situation: declinedService
        ? `Customer declined the ${declinedService} slot. Booking not made. Offer to try a different time — stay on ${declinedService} unless THEY ask for something else; do NOT switch to a different service on your own.`
        : 'Customer declined the slot. Booking not made. Offer to try a different time.',
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: memoryForActiveService(ctx, declinedService),
    })
    return { reply, sessionComplete: true }
  }

  // If pendingBookingId is set, hold is already placed — this YES is the final confirmation
  if (ctx.pendingBookingId) {
    const confirmResult = await confirmBooking(
      db, calendar, identity, ctx.pendingBookingId,
      (ctx as unknown as Record<string, string>)['displayName'] ?? 'Customer',
      // On a reschedule the move surfaces as a single owner 'moved' notice (releaseSupersededBooking
      // below); suppress the engine's new-booking notice so the owner isn't double-notified.
      { suppressOwnerNewBookingNotice: Boolean(ctx.rescheduledFrom) },
    )
    await completeSession(db, session.id)

    if (!confirmResult.ok) {
      const reply = await genReply({
        businessTimezone,
        businessName,
        language: lang,
        situation: `The booking could not be finalised because ${sanitiseReason(confirmResult.reason)}. Apologise and suggest they try again or contact the business directly.`,
        transcript,
        ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
      })
      return { reply, sessionComplete: true }
    }

    // New booking is committed — now (and only now) release the slot it replaces.
    await releaseSupersededBooking(db, calendar, identity, ctx)

    const pendingSlot = ctx.pendingSlot
    // C2 (belt-and-suspenders): guarantee the just-confirmed slot is never left in
    // rejectedSlots, so a future re-suggest in any later session can't shadow-suppress what
    // was actually booked. The session completes immediately below, so this has no live
    // effect today (the hold-placement path already un-suppressed the slot and dropped
    // lastOfferedSlots before this turn — see ~ctx un-suppress at hold creation), but it
    // closes the gap structurally and is correct regardless of upstream changes.
    if (pendingSlot) {
      ctx = withConstraints(ctx, removeRejectedSlot(ctx.negotiationConstraints, new Date(pendingSlot.start).toISOString()))
    }
    const confirmedDate = pendingSlot ? formatSlotDate(new Date(pendingSlot.start), businessTimezone) : 'the requested date'
    const confirmedTime = pendingSlot ? formatSlotTime(new Date(pendingSlot.start), businessTimezone) : 'the requested time'
    // C4: a "yes + side question" (e.g. "yes, btw is Sunday full?") collapsed to a plain
    // confirm above. The confirmation reply is bookingConfirmed-exempt (gates 1-3 skipped),
    // so it must NOT also answer the bundled question — an ungated availability claim could
    // be fabricated. Split: confirm here (exempt, told to ignore the question), then answer
    // the question in a SEPARATE genReply WITHOUT bookingConfirmed so gates 1-3 run on it.
    const bundledQuestion = parsed === 'yes_with_question'
    const confirmedReply = await genReply({
      businessTimezone,
      businessName,
      language: lang,
      situation: `Booking confirmed for ${pendingSlot?.serviceName ?? 'appointment'} on ${confirmedDate} at ${confirmedTime}.${bundledQuestion ? ' Do NOT answer any other question the customer asked in this message — a separate reply handles that.' : ''}`,
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    }, { bookingConfirmed: true })
    if (!bundledQuestion) return { reply: confirmedReply, sessionComplete: true }

    // Answer the bundled side-question on a GATED path (no bookingConfirmed). If the question
    // references a day we can resolve, pass a focusDay so the occupancy gate can re-read the
    // spine; otherwise omit it — gates 1-3 still run either way.
    const bundledFocusDay = resolveFocusDayFromText(messageText, businessTimezone, new Date(), pendingSlot?.serviceTypeId)
    const answerReply = await genReply({
      businessTimezone,
      businessName,
      language: lang,
      situation: `The customer confirmed their booking and ALSO asked a question in the same message: "${messageText}". Answer ONLY that question, grounded strictly in the real business facts/availability provided — do not restate or re-confirm the booking. If you don't have grounded info to answer, say plainly you don't have that detail to hand rather than guessing — do NOT promise to check or get back to them.`,
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    }, bundledFocusDay ? { focusDay: bundledFocusDay } : {})
    return { reply: `${confirmedReply}\n\n${answerReply}`, sessionComplete: true }
  }

  // No hold placed yet — place the hold first
  const pendingSlot = ctx.pendingSlot
  if (!pendingSlot) {
    await failSession(db, session.id)
    const reply = await genReply({
      businessTimezone,
      businessName,
      language: lang,
      situation: 'Internal error: no pending slot found in session. Ask customer to start over.',
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: true, sessionFailed: true }
  }

  const result = await requestBooking(db, calendar, identity, {
    serviceTypeId: pendingSlot.serviceTypeId,
    slotStart: new Date(pendingSlot.start),
    slotEnd: new Date(pendingSlot.end),
    providerHint: (pendingSlot as unknown as { providerHint?: string }).providerHint ?? null,
  }, {
    // On a reschedule, a directly-confirmed booking (group class) emits a single owner 'moved'
    // notice via releaseSupersededBooking below — suppress the engine's new-booking notice so the
    // owner isn't double-notified. No-op for the non-reschedule and hold-then-confirm paths.
    suppressOwnerNewBookingNotice: Boolean(ctx.rescheduledFrom),
  })

  if (!result.ok) {
    // F1d/S1 — the customer ALREADY holds this exact class. That is a POSITIVE state, not a
    // dead slot: reassure them their spot is confirmed. Routing it through the generic
    // re-offer below laundered "you're already booked" into "that's unavailable, here's
    // another date" — the July-5 drift. Short-circuit BEFORE the substitute path. The
    // booking genuinely exists, so the confirm-claim is true (bookingConfirmed-exempt).
    if (result.code === 'already_booked') {
      await completeSession(db, session.id)
      const bookedDate = formatSlotDate(new Date(pendingSlot.start), businessTimezone)
      const bookedTime = formatSlotTime(new Date(pendingSlot.start), businessTimezone)
      const reply = await genReply({
        businessTimezone,
        businessName,
        language: lang,
        situation: `The customer is ALREADY booked for ${pendingSlot.serviceName} on ${bookedDate} at ${bookedTime}. Warmly reassure them their spot is confirmed and they're on the list — do NOT offer a different time or day, and do NOT imply anything is unavailable.`,
        transcript,
        ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
        customerMemory: extractMemory(ctx),
      }, { bookingConfirmed: true })
      return { reply, sessionComplete: true }
    }

    // Reshuffle engine entry (decision X2 / A5): a reschedule onto a taken slot, with the
    // feature enabled, becomes a proactive swap campaign instead of a dead-end. The
    // customer keeps their current booking (deferred-cancel) until an approved plan applies.
    // Dynamic import keeps Redis/BullMQ out of this module's static graph.
    const providerUnavailEarly = parseProviderUnavailable(result.reason, lang)
    if (ctx.rescheduledFrom && business && !providerUnavailEarly) {
      const { openReshuffleCampaign } = await import('../reshuffle/entry.js')
      const campaignId = await openReshuffleCampaign(db, {
        businessId: identity.businessId,
        requesterId: identity.id,
        requesterBookingId: ctx.rescheduledFrom,
        serviceTypeId: pendingSlot.serviceTypeId,
        targetSlotStart: new Date(pendingSlot.start),
        targetSlotEnd: new Date(pendingSlot.end),
      }).catch(() => null)
      if (campaignId) {
        await completeSession(db, session.id)
        const reply = await genReply({
          businessTimezone,
          businessName,
          language: lang,
          situation: 'The requested time is taken, but you are going to try to arrange a swap with other customers to free it up. Tell them warmly that their current appointment stays booked in the meantime, and you will message them as soon as you know more. Do NOT promise it will work.',
          transcript,
          ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
          customerMemory: extractMemory(ctx),
        })
        return { reply, sessionComplete: true }
      }
    }

    // Slot taken — keep the session OPEN so the customer's pick of an offered
    // alternative continues THIS booking instead of starting over. Completing the
    // session here was dropping all in-flight context: the next message ("let's do
    // 5") spawned a fresh session that re-asked and forgot the booking. Keep the
    // service + date, drop the taken time, and re-enter clarification.
    const reofferDraft = slotDraftFromPending(pendingSlot, businessTimezone)
    const { time: _takenTime, ...keptReofferDraft } = reofferDraft
    const { pendingSlot: _clearedSlot, awaitingConfirmationFor: _clearedAwait, lastOfferedSlots: _loClear, pendingWaitlistJoin: _pwj, ...ctxWithoutPending } = ctx
    // Bug E: a schedule-driven ('class') service asked for at a time with no class.
    // Offer the ACTUAL scheduled class times for that service/day — never arbitrary
    // open slots (this is exactly how a customer got booked into a 17:00 with no class).
    // This applies to EVERY conflict on a class-mode service, not just 'no_class_at_time':
    // a class that's full (or any other refusal) must still be re-offered as real class
    // times, never as open-slot gaps between classes (13:00/15:00… are not class times).
    const classModeMiss = result.reason === 'no_class_at_time'
      || (business ? await isClassModeService(db, pendingSlot.serviceTypeId) : false)
    const hoursSummary = !classModeMiss && business ? await loadHoursSummary(db, business.id) : null
    // Proactive suggestion: enumerate real bookable openings near the request so
    // we can offer concrete alternatives ("I have 3pm or 4:30 free") instead of a
    // bare "that time doesn't work". Canonical spine — honours hours + blocks +
    // existing bookings. (CALENDAR_UX_DESIGN.md decision D.)
    const openSuggestion = !classModeMiss && business
      ? await suggestOpenSlotsText(db, business, pendingSlot.serviceTypeId, new Date(pendingSlot.start), new Date(pendingSlot.end), businessTimezone, ctx.negotiationConstraints)
      : NO_SUGGESTION
    const classDateStr = localParts(new Date(pendingSlot.start), businessTimezone).dateStr
    const classSuggestion = classModeMiss && business
      ? await buildDayOptionsText(db, business, classDateStr, businessTimezone, pendingSlot.serviceTypeId, ctx.negotiationConstraints, null, true)
      : NO_SUGGESTION
    // Class same-day empty/all-full → substitute the next REAL class on a later day.
    const classSubstitute = classModeMiss && business && !classSuggestion.text
      ? await suggestNextClassesText(db, business, pendingSlot.serviceTypeId, businessTimezone, ctx.negotiationConstraints)
      : NO_SUGGESTION
    const offeredAlternatives = classModeMiss
      ? (classSuggestion.text ? classSuggestion.offered : classSubstitute.offered)
      : openSuggestion.offered
    await updateSessionContext(
      db,
      session.id,
      {
        ...ctxWithoutPending, slotDraft: keptReofferDraft, clarificationAttempts: 0,
        ...(offeredAlternatives.length > 0 ? { lastOfferedSlots: offeredAlternatives } : {}),
      },
      'waiting_clarification',
    )
    const openSlotsText = openSuggestion.text
    const classTimesText = classSuggestion.text
    // Reactive instructor case: the customer named an instructor who teaches this
    // service but isn't free for the chosen slot. Surface that instructor's hours
    // (we only volunteer this because the customer raised the instructor first —
    // never proactively advertise staff schedules).
    const providerUnavail = parseProviderUnavailable(result.reason, lang)
    const unavailSituation = providerUnavail
      ? `The customer asked to book with ${providerUnavail.name}, but ${providerUnavail.name} does not teach at the time they chose. ${providerUnavail.name}'s teaching times are: ${providerUnavail.hoursPhrase}. Reactively offer one of those times OR another instructor — do not invent times, and do not volunteer other staff names unprompted. Keep it warm and brief.`
      : classModeMiss
        ? [
            `${pendingSlot.serviceName} doesn't run at the time the customer asked — it only runs at set class times, so that time can't be booked.`,
            classOfferSituation(pendingSlot.serviceName, formatLocalDate(classDateStr, businessTimezone), classTimesText, classSubstitute.text),
          ].filter(Boolean).join(' ')
      : [
          `The requested slot is unavailable because ${sanitiseReason(result.reason)}.`,
          hoursSummary ?? '',
          openSlotsText
            ? `Offer these actual open times and ask which they'd like: ${openSlotsText}.`
            : 'Suggest the customer pick a different time that falls within business hours.',
        ].filter(Boolean).join(' ')
    const reply = await genReply({
      businessTimezone,
      businessName,
      language: lang,
      situation: unavailSituation,
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    }, { focusDay: { dateStr: localParts(new Date(pendingSlot.start), businessTimezone).dateStr, serviceTypeId: pendingSlot.serviceTypeId } })
    return { reply, sessionComplete: false }
  }

  // Owner-approval gate (design 2026-06-25): this service requires the owner's OK before a
  // customer self-booking lands. The slot is held + pending; the owner decides in Branch 3.
  // Tell the customer their request is in and pending the business's confirmation — never that
  // it is booked. No second YES; the session is done from the customer's side until the owner
  // approves/declines (which fires its own outbound message).
  if (result.pendingApproval) {
    // Deferred-cancel reschedule into an approval-gated service: the new slot is only HELD-pending,
    // not yet secured, so the customer KEEPS their original booking for now (we don't release it).
    // Persist the supersede link onto the held booking so that, IF the owner approves, the resolver
    // releases the old slot — and if the owner declines or it expires, the original simply stays.
    if (ctx.rescheduledFrom) {
      await db.update(bookings).set({ rescheduledFrom: ctx.rescheduledFrom }).where(eq(bookings.id, result.bookingId)).catch(() => { /* non-fatal */ })
    }
    await completeSession(db, session.id)
    const requestedDate = formatSlotDate(new Date(pendingSlot.start), businessTimezone)
    const requestedTime = formatSlotTime(new Date(pendingSlot.start), businessTimezone)
    const reply = await genReply({
      businessTimezone,
      businessName,
      language: lang,
      situation: `The customer's request for ${pendingSlot.serviceName} on ${requestedDate} at ${requestedTime} has been received and is now waiting for the business to confirm. Warmly let them know the request is in and the business will confirm shortly — do NOT say it is booked, reserved, or confirmed yet.`,
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: true }
  }

  // Group class — booking already confirmed, no second YES needed
  if (result.directlyConfirmed) {
    await completeSession(db, session.id)
    // New booking is committed — release the slot it replaces (reschedule into a class). The
    // group-class booking id lives in result.bookingId (ctx.pendingBookingId is unset on this
    // direct-confirm path), so pass it explicitly or the 'moved' notice would never fire (Defect 2).
    await releaseSupersededBooking(db, calendar, identity, ctx, result.bookingId)
    const confirmedDate = formatSlotDate(new Date(pendingSlot.start), businessTimezone)
    const confirmedTime = formatSlotTime(new Date(pendingSlot.start), businessTimezone)
    const reply = await genReply({
      businessTimezone,
      businessName,
      language: lang,
      situation: `Spot confirmed in ${pendingSlot.serviceName} class on ${confirmedDate} at ${confirmedTime}. ${result.message}`,
      transcript,
      customerMemory: extractMemory(ctx),
    }, { bookingConfirmed: true })
    return { reply, sessionComplete: true }
  }

  // Private session — hold placed. F1b/S1: the customer ALREADY said yes (we only reach
  // requestBooking here on a 'yes'), so confirm IMMEDIATELY instead of asking a second time.
  // The old flow set pendingBookingId + re-asked "lock it in?", producing the double-confirm
  // ("to book?" then "lock it in?") — one yes must be one confirm, mirroring the class path.
  const confirmAfterHold = await confirmBooking(
    db, calendar, identity, result.bookingId,
    (ctx as unknown as Record<string, string>)['displayName'] ?? 'Customer',
    { suppressOwnerNewBookingNotice: Boolean(ctx.rescheduledFrom) },
  )
  await completeSession(db, session.id)
  if (!confirmAfterHold.ok) {
    const reply = await genReply({
      businessTimezone,
      businessName,
      language: lang,
      situation: `The booking could not be finalised because ${sanitiseReason(confirmAfterHold.reason)}. Apologise and suggest they try again or contact the business directly.`,
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: true }
  }
  // New booking committed — release any slot it replaces (reschedule).
  await releaseSupersededBooking(db, calendar, identity, ctx, result.bookingId)
  const confirmedDate = formatSlotDate(new Date(pendingSlot.start), businessTimezone)
  const confirmedTime = formatSlotTime(new Date(pendingSlot.start), businessTimezone)
  const reply = await genReply({
    businessTimezone,
    businessName,
    language: lang,
    situation: `Booking confirmed for ${pendingSlot.serviceName} on ${confirmedDate} at ${confirmedTime}.`,
    transcript,
    ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
    customerMemory: extractMemory(ctx),
  }, { bookingConfirmed: true })
  return { reply, sessionComplete: true }
}

async function handleClarification(
  db: Db,
  calendar: CalendarClient,
  identity: ResolvedIdentity,
  session: ActiveSession,
  ctx: BookingFlowContext,
  messageText: string,
  businessTimezone: string,
  businessName: string,
  transcript: TranscriptTurn[],
  genReply: GenReply,
  business?: Business,
): Promise<FlowResult> {
  const lang = ctx.detectedLanguage ?? 'en'

  const activeServices = await db
    .select({
      id: serviceTypes.id,
      name: serviceTypes.name,
      durationMinutes: serviceTypes.durationMinutes,
      maxParticipants: serviceTypes.maxParticipants,
      category: serviceTypes.category,
      schedulingMode: serviceTypes.schedulingMode,
    })
    .from(serviceTypes)
    .where(and(eq(serviceTypes.businessId, identity.businessId), eq(serviceTypes.isActive, true)))

  // Include recent transcript in context so the LLM can combine partial info
  // (e.g. date from one turn + time from next turn) during clarification
  const recentMessages = transcript
    .slice(-8)
    .map((t) => `${t.role === 'customer' ? 'Customer' : 'Assistant'}: ${t.text}`)
  const updatedContext = { ...ctx, clarificationReply: messageText, recentMessages }
  const intentResult = await extractCustomerIntent(
    messageText,
    updatedContext,
    businessTimezone,
    activeServices.map((s) => s.name),
  )

  if (!intentResult.ok) {
    const reply = await genReply({
      businessTimezone,
      businessName,
      language: lang,
      situation: 'Second intent extraction attempt failed. Ask the customer for a specific date and time, e.g. "Tuesday 3 May at 3pm".',
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: false }
  }

  // Capture a self-stated name on the clarification path too. This is the path the name
  // almost always arrives on: when we softly ask "what's your name?" the session is in
  // waiting_clarification, so the customer's answer routes here — NOT through the default
  // intent path (line ~877) where capture also runs. Without this, asking for the name
  // structurally guarantees the answer is never persisted (display_name stays null, and the
  // owner notification + calendar roster fall back to "no name"). Non-blocking, never clobbers.
  await persistCapturedName(db, identity.businessId, identity.id, identity.displayName ?? null, intentResult.data.customerNameHint ?? null)

  const detectedLanguage = intentResult.data.detectedLanguage
  const mergedCtx: BookingFlowContext = { ...updatedContext, detectedLanguage }

  // Symptom 3: a special-arrangement request can arrive as the clarification reply
  // (e.g. after we asked them to specify, they restate "actually I want a private
  // version of the group class"). Escalate once before re-routing into booking, where
  // an inquiry/unknown-shaped restatement would otherwise dead-end with no owner ping.
  if (intentResult.data.specialArrangementRequest === true) {
    const esc = await maybeEscalateSpecial(db, business, mergedCtx, session, identity, intentResult.data, transcript, detectedLanguage)
    if (esc) return esc
  }

  await updateSessionContext(db, session.id, mergedCtx, 'active')
  return handleBookingIntent(
    db, calendar, identity,
    { ...session, state: 'active', context: mergedCtx },
    mergedCtx, intentResult.data, activeServices, businessTimezone, businessName, transcript, genReply, '', business,
  )
}

// Business-local 'YYYY-MM-DD' for a slot — matches the format resolveRequestedDate
// returns, so a stated day can be compared against a booking's date deterministically.
function localDateStr(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

// Narrow a customer's bookings to those consistent with the service / day / time
// their cancellation request already stated. Any criterion that matches nothing is
// dropped (return the full set) rather than filtering to empty — better to show the
// menu than to wrongly claim they have no such booking.
function narrowCancelCandidates<B extends { id: string; slotStart: Date; serviceTypeId: string }>(
  candidates: B[],
  intent: CustomerIntentOutput,
  activeServices: Array<{ id: string; name: string }>,
  tz: string,
): B[] {
  const svc = intent.serviceTypeHint ? resolveService(intent.serviceTypeHint, activeServices) : null
  const slot = intent.slotRequest
  let dateStr: string | null = null
  if (slot && (slot.relativeDay || slot.weekday != null || slot.explicitDate)) {
    const r = resolveRequestedDate(
      { relativeDay: slot.relativeDay ?? null, weekday: slot.weekday ?? null, explicitDate: slot.explicitDate ?? null },
      tz, new Date(),
    )
    if (r.ok) dateStr = r.dateStr
  }
  const hhmm = slot?.time ? canonicalTime(slot.time.hour, slot.time.minute) : null
  if (!svc && !dateStr && !hhmm) return candidates

  const filtered = candidates.filter((b) => {
    if (svc && b.serviceTypeId !== svc.id) return false
    if (dateStr && localDateStr(b.slotStart, tz) !== dateStr) return false
    if (hhmm && formatSlotTime(b.slotStart, tz) !== hhmm) return false
    return true
  })
  return filtered.length > 0 ? filtered : candidates
}

async function handleCancellationIntent(
  db: Db,
  calendar: CalendarClient,
  identity: ResolvedIdentity,
  session: ActiveSession,
  ctx: BookingFlowContext,
  intent: CustomerIntentOutput,
  activeServices: Array<{ id: string; name: string }>,
  businessTimezone: string,
  businessName: string,
  transcript: TranscriptTurn[],
  genReply: GenReply,
): Promise<FlowResult> {
  const lang = ctx.detectedLanguage ?? 'en'

  const allBookings = await db
    .select({ id: bookings.id, slotStart: bookings.slotStart, serviceTypeId: bookings.serviceTypeId })
    .from(bookings)
    .where(
      and(
        eq(bookings.customerId, identity.id),
        eq(bookings.businessId, identity.businessId),
        or(eq(bookings.state, 'confirmed'), eq(bookings.state, 'held')),
      ),
    )

  if (allBookings.length === 0) {
    await completeSession(db, session.id)
    const reply = await genReply({
      businessTimezone,
      businessName,
      language: lang,
      situation: 'Customer requested cancellation but has no active bookings.',
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: true }
  }

  // Pre-filter by what the customer ALREADY stated ("cancel my yoga on Friday at
  // 12"). When their request uniquely identifies one booking, skip the menu and go
  // straight to a single confirmation; when it narrows to a few, show only those.
  // A criterion that matches nothing is ignored (don't filter to empty and mislead).
  const activeBookings = narrowCancelCandidates(allBookings, intent, activeServices, businessTimezone)

  if (activeBookings.length === 1) {
    const booking = activeBookings[0]!
    const date = `${formatSlotDate(booking.slotStart, businessTimezone)} at ${formatSlotTime(booking.slotStart, businessTimezone)}`

    const newCtx: BookingFlowContext = { ...ctx, awaitingConfirmationFor: 'cancellation', targetBookingId: booking.id }
    await updateSessionContext(db, session.id, newCtx, 'waiting_confirmation')

    const reply = await genReply({
      businessTimezone,
      businessName,
      language: lang,
      situation: `Customer wants to cancel their booking on ${date}. Ask them to confirm they want it cancelled — naturally, no menu.`,
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: false }
  }

  return enterCancellationSelection(db, session, ctx, activeBookings, businessTimezone, businessName, transcript, genReply, lang, false)
}

/**
 * WS3-T3.2 — deterministically resolve a customer's answer to the "which booking?"
 * list-question against the offered candidates. Lifted VERBATIM from the inline match
 * that used to live in handleBookingSelection so the bind path has a pure regression net:
 *
 *   • a bare number in range → that candidate by SORTED position (candidates arrive sorted)
 *   • else a UNIQUE matchCancelBookings hit (service/weekday/time) → that candidate
 *   • else null (ambiguous / no usable criterion / out of range)
 *
 * Returns ONLY the id so the caller stays in control of the row it confirms. This runs
 * FIRST in the handler, before the pivot escape-hatch — so a confident pick never reaches
 * an LLM call (zero added latency on the verified path), and a mid-flow revision
 * ("actually Thursday instead") yields null here and falls through to the pivot.
 */
export function matchBookingSelection(
  messageText: string,
  candidates: CancelBooking[],
  tz: string,
): { id: string } | null {
  const n = parseInt(messageText.trim(), 10)
  if (!isNaN(n) && n >= 1 && n <= candidates.length) {
    const byPos = candidates[n - 1]
    return byPos ? { id: byPos.id } : null
  }
  const matches = matchCancelBookings(messageText, candidates, tz)
  if (matches.length === 1) return { id: matches[0]!.id }
  return null
}

/**
 * Reorder DB-loaded rows to match the authoritative candidateIds order.
 *
 * `enterCancellationSelection` builds candidateIds SORTED by slotStart and numbers the
 * displayed list in that order. But the DB `inArray(...)` load returns rows in arbitrary
 * order — so a bare-number pick ("2") via matchBookingSelection (which uses positional
 * indexing) would resolve against the wrong slot. This binds the rows back to the
 * displayed (sorted) order so position N always means the Nth shown booking. candidateIds
 * with no matching row (e.g. a stale id) are dropped.
 */
export function orderRowsByCandidates<T extends { id: string }>(rows: T[], candidateIds: string[]): T[] {
  return candidateIds
    .map((id) => rows.find((r) => r.id === id))
    .filter((r): r is T => r != null)
}

async function enterCancellationSelection(
  db: Db,
  session: ActiveSession,
  ctx: BookingFlowContext,
  activeBookings: Array<{ id: string; slotStart: Date; serviceTypeId: string }>,
  businessTimezone: string,
  businessName: string,
  transcript: TranscriptTurn[],
  genReply: GenReply,
  lang: 'he' | 'en',
  isRescheduling: boolean,
): Promise<FlowResult> {
  const candidates = activeBookings
    .sort((a, b) => a.slotStart.getTime() - b.slotStart.getTime())
    .map((b) => b.id)

  const numberedList = activeBookings
    .sort((a, b) => a.slotStart.getTime() - b.slotStart.getTime())
    .map((b, i) =>
      `${i + 1}. ${formatSlotDate(b.slotStart, businessTimezone)} ${formatSlotTime(b.slotStart, businessTimezone)}`,
    )
    .join('; ')

  const newCtx: BookingFlowContext = {
    ...ctx,
    // WS3-T3.2: typed binding set IN PARALLEL with the legacy fields below (kept as the
    // source of truth for the confirm/reschedule callers, untouched this task).
    pendingDecision: { kind: 'booking_selection', candidateIds: candidates, isRescheduling },
    cancellationCandidates: candidates,
    awaitingConfirmationFor: 'cancellation_selection',
    isReschedulingFlow: isRescheduling,
  }
  await updateSessionContext(db, session.id, newCtx, 'waiting_clarification')

  const action = isRescheduling ? 'reschedule' : 'cancel'
  const reply = await genReply({
    businessTimezone,
    businessName,
    language: lang,
    situation: `Customer wants to ${action} but has ${activeBookings.length} upcoming bookings. List them as a bullet list (numbered for easy reference) and ask, like a person, which one they mean — they can just reply with its number. Bookings: ${numberedList}`,
    transcript,
    customerMemory: extractMemory(ctx),
  })
  return { reply, sessionComplete: false }
}

async function handleBookingSelection(
  db: Db,
  calendar: CalendarClient,
  identity: ResolvedIdentity,
  session: ActiveSession,
  ctx: BookingFlowContext,
  messageText: string,
  businessTimezone: string,
  businessName: string,
  transcript: TranscriptTurn[],
  genReply: GenReply,
  business?: Business,
): Promise<FlowResult> {
  const lang = ctx.detectedLanguage ?? 'en'
  // Only the booking_selection variant carries candidateIds/isRescheduling (this handler is
  // entered solely on that kind); narrow to keep the widened pendingDecision union typesafe.
  const selection = ctx.pendingDecision?.kind === 'booking_selection' ? ctx.pendingDecision : undefined
  const candidates = selection?.candidateIds ?? ctx.cancellationCandidates ?? []
  const isRescheduling = selection?.isRescheduling ?? ctx.isReschedulingFlow ?? false

  // Candidate bookings with service names, so we can resolve a natural-language
  // pick and name the chosen slot back in the confirmation.
  const rows = candidates.length > 0
    ? await db
        .select({ id: bookings.id, slotStart: bookings.slotStart, serviceTypeId: bookings.serviceTypeId, serviceName: serviceTypes.name })
        .from(bookings)
        .innerJoin(serviceTypes, eq(serviceTypes.id, bookings.serviceTypeId))
        .where(and(inArray(bookings.id, candidates), or(eq(bookings.state, 'confirmed'), eq(bookings.state, 'held'))))
    : []

  // The DB `inArray` load returns rows in arbitrary order; reorder them to match the
  // authoritative candidateIds (sorted by slotStart — the displayed/numbered order) so a
  // bare-number pick resolves against the slot the customer actually saw at that position.
  const orderedRows = orderRowsByCandidates(rows, candidates)

  // DETERMINISTIC BIND FIRST (verified-solid, lifted verbatim into matchBookingSelection):
  // a bare number picks by position; otherwise a UNIQUE service/weekday/time reference
  // auto-selects. Runs BEFORE the pivot escape so a confident pick NEVER reaches an LLM
  // call (zero added latency on the verified path).
  const pick = matchBookingSelection(messageText, orderedRows, businessTimezone)
  const selected: (typeof rows)[number] | null = pick ? orderedRows.find((r) => r.id === pick.id) ?? null : null

  if (!selected) {
    // No confident bind. Before re-asking, give the C-PIVOT escape-hatch a chance: the
    // reply may be a mid-flow revision ("actually Thursday instead") rather than an answer
    // to the asked question. rebuildOnSlotPivot re-extracts intent and either rebuilds the
    // booking (returns the result) or redirects (returns { redispatch:true }); only when it
    // returns null does the warm re-ask run. The deterministic bind above already consumed
    // every confident pick, so a clean number/reference never lands here.
    const pivoted = await rebuildOnSlotPivot(
      db, calendar, identity, session, ctx, messageText, businessTimezone, businessName, transcript, genReply, business,
    )
    if (pivoted) return pivoted

    const reply = await genReply({
      businessTimezone,
      businessName,
      language: lang,
      situation: `That wasn't a clear pick. Warmly ask which of their ${candidates.length} bookings they mean — they can reply with its number.`,
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: false }
  }

  const newCtx: BookingFlowContext = {
    ...ctx,
    targetBookingId: selected.id,
    awaitingConfirmationFor: 'cancellation',
  }
  await updateSessionContext(db, session.id, newCtx, 'waiting_confirmation')

  // Ask for explicit confirmation before acting — do NOT auto-confirm. Name the
  // exact slot so the customer confirms the right one with a single yes.
  const slotLabel = `${selected.serviceName} on ${formatSlotDate(selected.slotStart, businessTimezone)} at ${formatSlotTime(selected.slotStart, businessTimezone)}`
  const situation = isRescheduling
    ? `Customer chose ${slotLabel} as the one to move. Confirm that's the booking they want to reschedule — naturally, no menu. (It stays booked until the new time is set.)`
    : `Customer wants to cancel ${slotLabel}. Ask them to confirm the cancellation — naturally, no menu.`
  const reply = await genReply({
    businessTimezone,
    businessName,
    language: lang,
    situation,
    transcript,
    customerMemory: extractMemory(ctx),
  })
  return { reply, sessionComplete: false }
}

async function handleCancellationConfirmation(
  db: Db,
  calendar: CalendarClient,
  identity: ResolvedIdentity,
  session: ActiveSession,
  ctx: BookingFlowContext,
  messageText: string,
  businessTimezone: string,
  businessName: string,
  transcript: TranscriptTurn[],
  genReply: GenReply,
  business?: Business,
): Promise<FlowResult> {
  const lang = ctx.detectedLanguage ?? 'en'
  const parsedCancel = parseConfirmation(messageText)
  const confirmation: 'yes' | 'no' | 'unclear' = parsedCancel === 'yes_with_question' ? 'yes' : parsedCancel

  if (confirmation === 'unclear') {
    const reply = await genReply({
      businessTimezone,
      businessName,
      language: lang,
      situation: "Customer's reply was unclear. Ask again whether they want to cancel it or keep it — in plain words, no menu.",
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: false }
  }

  if (confirmation === 'no') {
    await completeSession(db, session.id)
    const reply = await genReply({
      businessTimezone,
      businessName,
      language: lang,
      situation: 'Customer chose not to cancel. Booking remains active.',
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: true }
  }

  const bookingId = ctx.targetBookingId
  if (!bookingId) {
    await failSession(db, session.id)
    const reply = await genReply({
      businessTimezone,
      businessName,
      language: lang,
      situation: 'Internal error: no booking ID found in session. Ask customer to try again.',
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: true, sessionFailed: true }
  }

  // Reschedule flow (multi-booking path): the customer has picked WHICH booking to
  // move. Do NOT cancel it yet — deferred-cancel, same invariant as the single-booking
  // path. We carry it as `rescheduledFrom` and ask for the new time; it is released
  // only once the replacement is secured (releaseSupersededBooking). If the new slot
  // turns out to be unavailable (e.g. a fully-booked week), the customer keeps this
  // booking instead of being stranded. The next turn is routed straight to the booking
  // path via the `rescheduledFrom` guard in the intent dispatch, so the still-active
  // original does not bounce us back into booking selection.
  if (ctx.isReschedulingFlow) {
    const { targetBookingId: _t, awaitingConfirmationFor: _a, cancellationCandidates: _c, isReschedulingFlow: _r, pendingDecision: _pd, pendingWaitlistJoin: _pwj, ...rest } = ctx
    const newCtx: BookingFlowContext = { ...rest, rescheduledFrom: bookingId }

    // If the customer already gave the new slot up front ("move my yoga to Sunday
    // 3pm"), continue straight to it instead of re-asking for the time they already
    // provided. The captured draft was carried through the selection detour.
    const d = newCtx.slotDraft
    if (d?.serviceTypeId && d?.dateStr && d?.time) {
      const svcRows = await db
        .select({
          id: serviceTypes.id,
          name: serviceTypes.name,
          durationMinutes: serviceTypes.durationMinutes,
          maxParticipants: serviceTypes.maxParticipants,
          category: serviceTypes.category,
          schedulingMode: serviceTypes.schedulingMode,
        })
        .from(serviceTypes)
        .where(and(eq(serviceTypes.businessId, identity.businessId), eq(serviceTypes.isActive, true)))
      await updateSessionContext(db, session.id, newCtx, 'active')
      // Synthetic intent: the slot is already in the draft, so no new pieces to merge.
      const synthetic: CustomerIntentOutput = {
        intent: 'booking', slotRequest: null, serviceTypeHint: null, providerHint: null,
        customerNameHint: null, participantsHint: null, summary: null, rawEntities: {}, detectedLanguage: lang,
      }
      return handleBookingIntent(
        db, calendar, identity,
        { ...session, state: 'active', context: newCtx },
        newCtx, synthetic, svcRows, businessTimezone, businessName, transcript, genReply, '', business,
      )
    }

    await updateSessionContext(db, session.id, newCtx, 'active')
    const reply = await genReply({
      businessTimezone,
      businessName,
      language: lang,
      situation: 'Customer picked which booking to move. Keep it for now — ask what date and time they would like for the new appointment.',
      transcript,
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: false }
  }

  // Phase 3b reschedule-retention: before cancelling, optionally offer alternate slots.
  // Returns null (and the flow proceeds to cancel as today) when the flag is OFF or no
  // suitable slots exist — so behaviour is unchanged for every business that hasn't opted in.
  const retention = await maybeEnterRetentionOffer(
    db, identity, session, ctx, bookingId, businessTimezone, businessName, transcript, genReply, business,
  )
  if (retention) return retention

  const result = await cancelBooking(db, calendar, identity, bookingId, 'Customer requested via WhatsApp')

  if (!result.ok) {
    await completeSession(db, session.id)
    const reply = await genReply({
      businessTimezone,
      businessName,
      language: lang,
      situation: `The cancellation could not be completed because ${sanitiseReason(result.reason)}. Apologise and suggest they contact the business directly.`,
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: true }
  }

  await recordCancellationSnapshot(db, identity, bookingId)
  await completeSession(db, session.id)
  const reply = await genReply({
    businessTimezone,
    businessName,
    language: lang,
    situation: 'Booking successfully cancelled.',
    transcript,
    customerMemory: extractMemory(ctx),
  }, { backs: ['cancelled'] }) // T3.1b — real cancel; back the 'cancelled' claim so "ביטלתי"/"I cancelled" is allowed.
  return { reply, sessionComplete: true }
}

// Phase 3b reschedule-retention (design §7.5). On a GENUINE confirmed cancellation,
// optionally offer up to 3 open alternate slots for the same service (next 14 days)
// before releasing the booking. Returns a FlowResult when an offer was made (the session
// pivots to 'retention_offer'), or null to let the caller cancel exactly as today.
// v1 scope: private/1-on-1 services only — group classes fall through to normal cancel.
async function maybeEnterRetentionOffer(
  db: Db,
  identity: ResolvedIdentity,
  session: ActiveSession,
  ctx: BookingFlowContext,
  bookingId: string,
  businessTimezone: string,
  businessName: string,
  transcript: TranscriptTurn[],
  genReply: GenReply,
  business?: Business,
): Promise<FlowResult | null> {
  if (!business || business.rescheduleRetentionEnabled !== true) return null

  const lang = ctx.detectedLanguage ?? 'en'

  const [bookingRow] = await db
    .select({ serviceTypeId: bookings.serviceTypeId })
    .from(bookings)
    .where(eq(bookings.id, bookingId))
    .limit(1)
  if (!bookingRow?.serviceTypeId) return null

  const [svc] = await db
    .select({
      id: serviceTypes.id,
      name: serviceTypes.name,
      durationMinutes: serviceTypes.durationMinutes,
      maxParticipants: serviceTypes.maxParticipants,
    })
    .from(serviceTypes)
    .where(eq(serviceTypes.id, bookingRow.serviceTypeId))
    .limit(1)
  if (!svc) return null

  // v1 scope: only private/1-on-1 services. Group classes are not retained here.
  if ((svc.maxParticipants ?? 1) > 1) return null

  const now = new Date()
  const to = new Date(now.getTime() + 14 * 24 * 60 * 60_000)
  const slots = await getOpenSlots(db, business, { start: now, end: to }, svc.durationMinutes, { maxSlots: 3 }).catch(() => [])
  if (slots.length === 0) return null

  const retentionOfferedSlots = slots.map((s) => ({
    start: s.start.toISOString(),
    end: s.end.toISOString(),
    serviceTypeId: svc.id,
    serviceName: svc.name,
  }))

  const newCtx: BookingFlowContext = {
    ...ctx,
    awaitingConfirmationFor: 'retention_offer',
    targetBookingId: bookingId,
    retentionOfferedSlots,
  }
  await updateSessionContext(db, session.id, newCtx, 'waiting_confirmation')

  await logAudit(db, {
    businessId: identity.businessId,
    actorId: null,
    action: 'reschedule_retention.offered',
    entityType: 'booking',
    entityId: bookingId,
    metadata: { offered: slots.length },
  })

  const numbered = slots
    .map((s, i) => `${i + 1}. ${formatSlotDate(s.start, businessTimezone)} at ${formatSlotTime(s.start, businessTimezone)}`)
    .join('; ')

  const reply = await genReply({
    businessTimezone,
    businessName,
    language: lang,
    situation: `The customer asked to cancel their ${svc.name} booking. Before cancelling, warmly offer to MOVE it to one of these open times instead, listed numbered so they can reply with a number: ${numbered}. Make clear they can simply reply "cancel" to go ahead with cancelling. Brief, friendly, never pushy.`,
    transcript,
    ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
    customerMemory: extractMemory(ctx),
  })
  return { reply, sessionComplete: false }
}

// Phase 3b reschedule-retention: handle the customer's reply to the alternate-slot offer.
// A number accepts that slot and converts the cancel into a reschedule (deferred-cancel,
// mirroring the isReschedulingFlow accept path); 'cancel'/'no' declines and runs the same
// cancel logic the genuine-cancel path uses; anything else re-asks.
async function handleRetentionResponse(
  db: Db,
  calendar: CalendarClient,
  identity: ResolvedIdentity,
  session: ActiveSession,
  ctx: BookingFlowContext,
  messageText: string,
  businessTimezone: string,
  businessName: string,
  transcript: TranscriptTurn[],
  genReply: GenReply,
  business?: Business,
): Promise<FlowResult> {
  const lang = ctx.detectedLanguage ?? 'en'
  const offered = ctx.retentionOfferedSlots ?? []
  const parsed = parseRetentionReply(messageText, offered.length)

  if (parsed.kind === 'unclear') {
    const reply = await genReply({
      businessTimezone,
      businessName,
      language: lang,
      situation: "The reply wasn't clear. Ask them to pick one of the offered times by number, or reply 'cancel' to cancel the booking — naturally, no menu.",
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: false }
  }

  if (parsed.kind === 'decline') {
    const result = await cancelBooking(db, calendar, identity, ctx.targetBookingId!, 'Customer requested via WhatsApp')

    if (!result.ok) {
      await completeSession(db, session.id)
      const reply = await genReply({
        businessTimezone,
        businessName,
        language: lang,
        situation: `The cancellation could not be completed because ${sanitiseReason(result.reason)}. Apologise and suggest they contact the business directly.`,
        transcript,
        ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
        customerMemory: extractMemory(ctx),
      })
      return { reply, sessionComplete: true }
    }

    await recordCancellationSnapshot(db, identity, ctx.targetBookingId!)
    await completeSession(db, session.id)
    await logAudit(db, {
      businessId: identity.businessId,
      actorId: null,
      action: 'reschedule_retention.declined',
      entityType: 'booking',
      entityId: ctx.targetBookingId!,
      metadata: {},
    })
    const reply = await genReply({
      businessTimezone,
      businessName,
      language: lang,
      situation: 'Booking successfully cancelled.',
      transcript,
      customerMemory: extractMemory(ctx),
    }, { backs: ['cancelled'] }) // T3.1b — real cancel (retention-declined path); back the 'cancelled' claim.
    return { reply, sessionComplete: true }
  }

  // parsed.kind === 'accept' — convert the cancel into a reschedule (deferred-cancel).
  const chosen = offered[parsed.index]!
  const { targetBookingId: _t, awaitingConfirmationFor: _a, retentionOfferedSlots: _r, cancellationCandidates: _c, isReschedulingFlow: _i, pendingDecision: _pd, pendingWaitlistJoin: _pwj, ...rest } = ctx
  const lp = localParts(new Date(chosen.start), businessTimezone)
  const slotDraft = {
    serviceTypeId: chosen.serviceTypeId,
    serviceName: chosen.serviceName,
    dateStr: lp.dateStr,
    time: { hour: Math.floor(lp.minutes / 60), minute: lp.minutes % 60 },
  }
  const newCtx: BookingFlowContext = { ...rest, rescheduledFrom: ctx.targetBookingId!, slotDraft }

  await logAudit(db, {
    businessId: identity.businessId,
    actorId: null,
    action: 'reschedule_retention.accepted',
    entityType: 'booking',
    entityId: ctx.targetBookingId!,
    metadata: { newSlot: chosen.start },
  })

  const svcRows = await db
    .select({
      id: serviceTypes.id,
      name: serviceTypes.name,
      durationMinutes: serviceTypes.durationMinutes,
      maxParticipants: serviceTypes.maxParticipants,
      category: serviceTypes.category,
      schedulingMode: serviceTypes.schedulingMode,
    })
    .from(serviceTypes)
    .where(and(eq(serviceTypes.businessId, identity.businessId), eq(serviceTypes.isActive, true)))
  await updateSessionContext(db, session.id, newCtx, 'active')

  const synthetic: CustomerIntentOutput = {
    intent: 'booking', slotRequest: null, serviceTypeHint: null, providerHint: null,
    customerNameHint: null, participantsHint: null, summary: null, rawEntities: {}, detectedLanguage: lang,
  }
  return handleBookingIntent(
    db, calendar, identity,
    { ...session, state: 'active', context: newCtx },
    newCtx, synthetic, svcRows, businessTimezone, businessName, transcript, genReply, '', business,
  )
}

async function handleListBookings(
  db: Db,
  identity: ResolvedIdentity,
  session: ActiveSession,
  ctx: BookingFlowContext,
  businessTimezone: string,
  businessName: string,
  transcript: TranscriptTurn[],
  genReply: GenReply,
): Promise<FlowResult> {
  const lang = ctx.detectedLanguage ?? 'en'

  const upcoming = await db
    .select({ id: bookings.id, slotStart: bookings.slotStart, slotEnd: bookings.slotEnd, state: bookings.state, serviceTypeId: bookings.serviceTypeId })
    .from(bookings)
    .where(
      and(
        eq(bookings.customerId, identity.id),
        eq(bookings.businessId, identity.businessId),
        or(eq(bookings.state, 'confirmed'), eq(bookings.state, 'held')),
        gt(bookings.slotStart, new Date()),
      ),
    )
    .orderBy(bookings.slotStart)
    .limit(5)

  // Read-only intent — keep the session active so the conversation stays one
  // session (see the inquiry note in handleBookingFlow). 30-min expiry reaps idle.
  await updateSessionContext(db, session.id, ctx, 'active')

  if (upcoming.length === 0) {
    const reply = await genReply({
      businessTimezone,
      businessName,
      language: lang,
      situation: 'Customer asked for their bookings. They have no upcoming confirmed or held bookings.',
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: false }
  }

  const list = upcoming
    .map((b, i) => `${i + 1}. ${formatSlotDate(b.slotStart, businessTimezone)} at ${formatSlotTime(b.slotStart, businessTimezone)} (${b.state})`)
    .join('; ')

  const reply = await genReply({
    businessTimezone,
    businessName,
    language: lang,
    situation: `Customer asked for their upcoming bookings. List them: ${list}`,
    transcript,
    customerMemory: extractMemory(ctx),
  })
  return { reply, sessionComplete: false }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function resolveService<
  T extends { id: string; name: string; schedulingMode?: 'appointment' | 'class' | null },
>(hint: string | null, services: T[]): T | null {
  if (services.length === 0) return null
  if (services.length === 1) return services[0]!
  if (!hint) return null

  const lower = hint.toLowerCase()
  const matches = services.filter((s) => s.name.toLowerCase().includes(lower))
  if (matches.length === 0) return null
  // Prefer the class twin: when "yoga" matches both an appointment-mode twin and
  // the real class-mode service, route to the class so only real class instances
  // surface and the empty gaps between sessions are never offered as slots (P4).
  return matches.find((s) => s.schedulingMode === 'class') ?? matches[0]!
}
