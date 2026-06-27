import { eq, and, or, gt, gte, isNull, count, inArray } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { serviceTypes, bookings, identities, availability, conversationSessions } from '../../db/schema.js'
import type { Business, CalendarBlockType, SessionState } from '../../db/schema.js'
import type { ResolvedIdentity } from '../identity/types.js'
import type { ActiveSession } from '../session/types.js'
import { buildActionLedgerBlock } from '../audit/ledger-block.js'
import { updateSessionContext, completeSession, failSession } from '../session/manager.js'
import { requestBooking, confirmBooking, cancelBooking } from '../booking/engine.js'
import { notifyOwnerBookingChange } from '../initiations/booking-notify.js'
import { extractCustomerIntent, generateCustomerReply } from '../../adapters/llm/client.js'
import { setCustomerName, deriveLastName } from '../identity/customer-resolver.js'
import { assertsBookingConfirmed } from './reply-guard.js'
import { extractClockTimes, extractMentionedTimes, findUnbackedTimes } from './slot-fabrication-guard.js'
import { inferFocusService } from './service-resolution.js'
import { middlemanOneLiner } from '../../adapters/llm/middleman-identity.js'
import type { CalendarClient } from '../../adapters/calendar/client.js'
import { parseConfirmation, parseRetentionReply } from './types.js'
import { logAudit } from '../audit/logger.js'
import type { FlowResult, BookingFlowContext } from './types.js'
import type { CustomerIntentOutput } from '../../adapters/llm/types.js'
import type { TranscriptTurn } from '../../adapters/llm/types.js'
import type { HydratedContext } from '../session/hydration.js'
import { checkOwnerEscalationRules, escalateToPlatform } from '../escalation/engine.js'
import type { BusinessKnowledge } from '../../shared/skill-types.js'
import { t } from '../i18n/t.js'
import { getOpenSlots, isSlotBookable } from '../availability/service.js'
import { listDayOptions } from '../availability/day-options.js'
import { findClassBlockProviderForSlot } from '../availability/blocks.js'
import { resolveRequestedDate, resolveSlotStart, addDaysToDateStr, isDstGap, type RequestedDateParts } from '../availability/resolve-slot.js'
import { localParts } from '../availability/compute.js'
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
const GREETING_SOCIAL_RE =
  /^(?:hi+|hey+|hello+|yo|sup|hiya|good\s*(?:morning|afternoon|evening|night)|how\s*(?:are|r)\s*(?:you|u)|how's\s*it\s*going|what'?s\s*up|thanks?|thank\s*you|thx|ty|ok(?:ay)?|cool|nice|great|bye+|goodbye|see\s*you|cheers|שלום|היי+|הי|הלו|אהלן|אהל[ןן]|בוקר\s*טוב|צהריים\s*טובים|ערב\s*טוב|לילה\s*טוב|מה\s*נשמע|מה\s*קורה|מה\s*שלומ(?:ך|ך)|תודה(?:\s*רבה)?|סבבה|אוקיי?|יופי|מגניב|ביי+|להתראות|כל\s*טוב)$/iu

export function looksLikeGreetingOrSocial(text: string): boolean {
  // Strip emoji, punctuation, and collapse whitespace, then bound the length so a
  // genuine request that merely opens with "hi" is never swallowed here.
  const cleaned = text
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')
    .replace(/['’]/g, '') // strip apostrophes so "what's" → "whats" (not "what s")
    .replace(/[!?.,;:"()\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length === 0) return false
  if (cleaned.split(' ').length > 4) return false
  return GREETING_SOCIAL_RE.test(cleaned)
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

// Render a resolved 'YYYY-MM-DD' business-local date for use inside situation
// strings (G2: the customer never sees the raw YYYY-MM-DD form).
function formatLocalDate(dateStr: string, tz: string): string {
  return formatSlotDate(resolveSlotStart(dateStr, { hour: 12, minute: 0 }, tz), tz)
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
}
const NO_SUGGESTION: SuggestionResult = { text: null, offered: [] }

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
  const from = requestedStart.getTime() > now.getTime() ? requestedStart : now
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
): Promise<SuggestionResult> {
  const day = await listDayOptions(db, business, dateStr, tz, serviceTypeId ? { serviceTypeId } : {})
  const dayLabel = formatLocalDate(dateStr, tz)
  const parts: string[] = []
  const offered: RejectedSlot[] = []

  // Narrow to the requested part-of-day (real class/slot starts only) so an
  // "evening?" inquiry can never widen back into invented full-day times.
  const byBucket = <T extends { start: Date }>(ss: T[]): T[] =>
    timeOfDay ? ss.filter((s) => startInBucket(s.start, tz, timeOfDay)) : ss
  const datesByBucket = (ds: Date[]): Date[] =>
    timeOfDay ? ds.filter((d) => startInBucket(d, tz, timeOfDay)) : ds

  // Drop class instances and private openings the customer already ruled out this session.
  const classes = byBucket(filterOpenSlots(day.classes, constraints, tz))
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

  if (parts.length > 0) return { text: parts.join(' '), offered }
  // A part-of-day was asked but nothing real falls in it — state that explicitly so
  // the caller does NOT fall back to an all-day answer (which reopens the fabrication).
  if (timeOfDay) return { text: `No ${timeOfDay} classes or open times on ${dayLabel}.`, offered: [] }
  return NO_SUGGESTION
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

const BOOKING_NOT_CONFIRMED_FALLBACK: Record<'he' | 'en', string> = {
  he: 'רגע, עוד לא סגרנו את זה — לאיזה יום ושעה בא לך?',
  en: "Hang on — that's not booked yet. What day and time works for you?",
}

// Safe reply when the model keeps stating times the spine never offered (a
// fabricated-availability claim that survived one regeneration). States no time at
// all — better to ask than to offer a slot that does not exist / is blocked.
const FABRICATED_TIME_FALLBACK: Record<'he' | 'en', string> = {
  he: 'בוא נמצא לך זמן אמיתי — לאיזה יום שאבדוק עבורך?',
  en: "Let me get you a real time — which day should I check for you?",
}

// Appended to the situation when the first draft offered an unbacked time. Forces
// the model back onto the deterministic, block-aware times already in the situation.
const TIME_GUARD_INSTRUCTION =
  'CRITICAL: Your draft offered a time that is NOT available. The ONLY bookable times are those explicitly listed as open times / classes in the context above. Business hours describe when the studio is open, NOT bookable slots — never present a time as available just because it falls within opening hours or between classes. If nothing listed fits what the customer asked, say plainly there is nothing available for that and invite them to pick from the listed options or choose another day. Do NOT state any other clock time as available.'

// Bound reply function: built once per request with the business's authoritative
// facts so every customer reply is grounded in real config (no invented services,
// instructors, prices, or policies — C3/C4). Callers never pass businessFacts.
type GenReply = (
  input: Parameters<typeof generateCustomerReply>[0],
  opts?: { bookingConfirmed?: boolean },
) => Promise<string>

// Reply-vs-state binding guard. Every customer reply goes through here. When the
// caller has NOT actually persisted a booking this turn (bookingConfirmed falsy)
// and the drafted reply nonetheless CLAIMS one was made, regenerate once forbidding
// the claim, then fall back to a safe clarification. Confirmation sites pass
// bookingConfirmed:true to allow the legitimate "you're booked" wording.
//
// `businessFacts` is closed over here and merged into every reply so the LLM is
// grounded in the real, exhaustive config on EVERY path — not just inquiries.
// Assemble the set of clock times a reply is allowed to state, WITHOUT any per-path
// wiring: the situation string is system-authored and already block-aware, so every
// time the spine legitimately surfaced this turn is in it. Union that with the times
// the customer raised (a reply may echo/refuse them), the business-hour boundaries,
// and the customer's own booking times. Anything else in the reply is a fabrication.
function buildAllowedTimes(
  input: Parameters<typeof generateCustomerReply>[0],
  timeGuard: { boundaryTimes: string[]; bookingTimes: string[] },
): Set<string> {
  const allowed = new Set<string>([...timeGuard.boundaryTimes, ...timeGuard.bookingTimes])
  for (const t of extractClockTimes(input.situation ?? '')) allowed.add(t)
  for (const turn of input.transcript ?? []) {
    if (turn.role === 'customer') for (const t of extractMentionedTimes(turn.text)) allowed.add(t)
  }
  return allowed
}

// Reply-vs-state binding guard. Every customer reply goes through here. Two output
// gates run unless the caller asserted a real persisted booking (bookingConfirmed):
//   1. phantom "booking confirmed" claim (assertsBookingConfirmed) — said-done/didn't,
//   2. fabricated availability — a clock time the deterministic spine never offered
//      (the recurring Branch-4 bug: the model interpolating bookable times from open
//      hours / the class cadence). Each gate regenerates once, then falls back to a
//      deterministic, time-free reply. This is the single intent-path-agnostic seam.
//
// `businessFacts` is closed over here and merged into every reply so the LLM is
// grounded in the real, exhaustive config on EVERY path — not just inquiries.
function makeGenReply(
  businessFacts: string,
  actionLedger: string,
  timeGuard: { boundaryTimes: string[]; bookingTimes: string[] },
): GenReply {
  return async (input, opts = {}) => {
    const grounded = {
      ...input,
      ...(businessFacts ? { businessFacts } : {}),
      ...(actionLedger ? { actionLedger } : {}),
    }
    let reply = await generateCustomerReply(grounded)
    if (opts.bookingConfirmed) return reply

    // Gate 1 — phantom booking-confirmed claim.
    if (assertsBookingConfirmed(reply, input.language)) {
      const corrected = await generateCustomerReply({
        ...grounded,
        situation: `${input.situation}\n\nCRITICAL: No booking has been made or confirmed. Do NOT state or imply the appointment is booked, reserved, registered, or done. If a decision is needed, ask for it plainly.`,
      })
      reply = assertsBookingConfirmed(corrected, input.language)
        ? BOOKING_NOT_CONFIRMED_FALLBACK[input.language]
        : corrected
    }

    // Gate 2 — fabricated availability (a clock time the spine never offered).
    const allowed = buildAllowedTimes(input, timeGuard)
    if (findUnbackedTimes(reply, allowed).length > 0) {
      const corrected = await generateCustomerReply({
        ...grounded,
        situation: `${input.situation}\n\n${TIME_GUARD_INSTRUCTION}`,
      })
      reply = findUnbackedTimes(corrected, allowed).length > 0
        ? FABRICATED_TIME_FALLBACK[input.language]
        : corrected
    }

    return reply
  }
}

// Build the authoritative, closed-world business-facts block injected into every
// customer reply. Exhaustive service list (model/capacity/price) + an explicit
// no-invented-staff rule + the real booking-horizon policy. This is the ground
// truth that overrides anything the transcript implies (kills C3/C4).
export function buildBusinessFacts(
  activeServices: Array<{ id: string; name: string; durationMinutes: number; maxParticipants: number }>,
  businessKnowledge: BusinessKnowledge | undefined,
  business: Business | undefined,
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
  }
  lines.push('Instructors/staff: do NOT name, list, suggest, or invent any instructor or staff member. If the customer names one, do not confirm or deny by name — say you will check with the business.')
  if (business?.maxBookingDaysAhead != null) {
    lines.push(`Bookings can be made up to ${business.maxBookingDaysAhead} days ahead — never claim a date within that window is "not open yet".`)
  }
  return lines.join('\n')
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
    const promoted = addRejectedSlots(ctx.negotiationConstraints, ctx.lastOfferedSlots)
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
    })
    .from(serviceTypes)
    .where(and(eq(serviceTypes.businessId, identity.businessId), eq(serviceTypes.isActive, true)))

  const businessFacts = buildBusinessFacts(activeServices, businessKnowledge, business)
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
  const genReply = makeGenReply(businessFacts, actionLedger, { boundaryTimes, bookingTimes })

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

  // ── Branch: cancellation_selection (multi-booking numbered pick) ──────────
  if (session.state === 'waiting_clarification' && ctx.awaitingConfirmationFor === 'cancellation_selection') {
    return handleCancellationSelection(db, calendar, identity, session, ctx, messageText, businessTimezone, businessName, transcript, genReply)
  }

  // ── Branch: waiting for hold confirmation ────────────────────────────────
  if (session.state === 'waiting_confirmation' && ctx.awaitingConfirmationFor === 'hold') {
    const holdResult = await handleHoldConfirmation(db, calendar, identity, session, ctx, messageText, businessTimezone, businessName, transcript, genReply, business)
    if (!holdResult.redispatch) return holdResult
    // Customer redirected away from the pending slot (an inquiry / a different request).
    // handleHoldConfirmation already cleared the hold from the session in the DB; mirror
    // that in-memory and fall through to fresh intent handling so their actual request is
    // answered instead of the stale slot being re-asked.
    const { pendingSlot: _ps, pendingBookingId: _pb, awaitingConfirmationFor: _a, ...clearedCtx } = ctx
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
  const updatedCtx: BookingFlowContext = {
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
        return handleCancellationIntent(db, calendar, identity, session, updatedCtx, businessTimezone, businessName, transcript, genReply)

      case 'list_bookings':
        return handleListBookings(db, identity, session, updatedCtx, businessTimezone, businessName, transcript, genReply)

      case 'inquiry': {
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
        if (business) {
          const inquiryService = resolveService(intent.serviceTypeHint, activeServices)
          const dayParts: RequestedDateParts | null =
            intent.slotRequest && (intent.slotRequest.relativeDay || intent.slotRequest.weekday != null || intent.slotRequest.explicitDate)
              ? {
                  relativeDay: intent.slotRequest.relativeDay ?? null,
                  weekday: intent.slotRequest.weekday ?? null,
                  explicitDate: intent.slotRequest.explicitDate ?? null,
                }
              : null
          const resolvedDay = dayParts ? resolveRequestedDate(dayParts, businessTimezone, new Date()) : null
          // Explicit re-ask about a specific time un-suppresses it: the customer is
          // proactively asking about a slot they earlier ruled out, so surface it again.
          if (resolvedDay && resolvedDay.ok && intent.slotRequest?.time) {
            const askedStart = resolveSlotStart(resolvedDay.dateStr, intent.slotRequest.time, businessTimezone)
            ctx = withConstraints(ctx, removeRejectedSlot(ctx.negotiationConstraints, askedStart.toISOString()))
          }
          if (resolvedDay && resolvedDay.ok) {
            const r = await buildDayOptionsText(db, business, resolvedDay.dateStr, businessTimezone, inquiryService?.id, ctx.negotiationConstraints, intent.slotRequest?.timeOfDay ?? null)
            availabilityText = r.text
            inquiryOffered.push(...r.offered)
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
          await updateSessionContext(db, session.id, inquiryCtx, 'active')
        }
        const hoursSummary = business ? await loadHoursSummary(db, business.id) : null

        const customerCtx = recentBookingCount > 0
          ? `Returning customer with ${recentBookingCount} booking(s) in the last 90 days.`
          : 'First-time or lapsed customer.'
        const slotCtx = availabilityText ? ` ${availabilityText}` : ''
        const hoursCtx = hoursSummary ? ` ${hoursSummary}` : ''

        const situation = activeServices.length > 0
          ? `${firstMsgPrefix}Customer asked a question about the business, services, hours, or availability. ${customerCtx}${hoursCtx}${slotCtx} Services available: ${serviceDescriptions}. Answer their specific question using the FAQs and service info above. CRITICAL on times: the ONLY bookable times are those explicitly listed above as open times / classes. Business hours describe when the studio is OPEN — they are NOT a list of bookable slots; never present a time as available just because it falls within opening hours or between classes. If they asked which times/days are open, give the listed open times as a short bullet list and invite them to pick one. If nothing is listed for what they asked, say plainly there is nothing available and offer the listed alternatives or another day — never invent or infer a time. If the customer asks to book with a specific instructor by name, that is supported — bookings go through here. Do NOT proactively bring up, list, or advertise individual instructors or who teaches what; only engage with instructor specifics if the customer raises them first.`
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
        })
        return { reply: inquiryReply, sessionComplete: false }
      }

      case 'system_explanation': {
        // Read-only intent — keep the session active (see inquiry note above).
        await updateSessionContext(db, session.id, updatedCtx, 'active')
        const oneLiner = middlemanOneLiner(detectedLanguage, businessName)
        const situation = `${firstMsgPrefix}The customer EXPLICITLY asked what system, platform, or technology powers this assistant. Authorized platform explanation — give exactly this one fact, phrased naturally, and nothing more (no marketing, no extra detail): "${oneLiner}". Then briefly invite them back to booking.`
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
        return { reply: explainReply, sessionComplete: false }
      }

      default: {
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
        // ONLY the genuine first message of a session may introduce the PA. Every
        // later turn continues the conversation — it must never re-greet or
        // re-announce identity (that was the verbatim-reintroduction bug).
        const unknownSituation = mayGreet
          ? `This is the customer's first message and it is unclear or generic. Greet them warmly as ${businessName}, say in one line you can help with booking, changing, or cancelling appointments${hasFaqs ? ' and answer questions about the business' : ''}, and ask how you can help. Keep it short and human.`
          : hasFaqs
            ? `Mid-conversation: the customer said "${messageText}", which isn't a clear booking/cancel/reschedule. Do NOT greet or re-introduce yourself. If a FAQ above answers it, answer directly; otherwise reply like a person — briefly acknowledge, then nudge toward what you can help with (booking, changing, cancelling, checking appointments).`
            : `Mid-conversation: the customer said "${messageText}", which you couldn't map to a booking action. Do NOT greet or re-introduce yourself and do NOT repeat a canned capability list. Reply like a human employee — a short, warm acknowledgement that keeps things moving toward booking, changing, cancelling, or checking an appointment.`

        const unknownKnowledgeFields = businessKnowledge ? {
          brandVoice: businessKnowledge.brandVoice,
          ...(businessKnowledge.communicationStyle ? { communicationStyle: businessKnowledge.communicationStyle } : {}),
          faqs: businessKnowledge.faqs,
        } : {}
        const unknownReply = await genReply({
          businessTimezone,
          businessName,
          language: detectedLanguage,
          situation: unknownSituation,
          transcript,
          customerMemory: extractMemory(updatedCtx),
          ...unknownKnowledgeFields,
        })
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
  const isRedirect = !isRebuild &&
    (intent.intent === 'inquiry' || intent.intent === 'cancellation' || intent.intent === 'list_bookings')
  if (!isRebuild && !isRedirect) return null

  // Release any hold already placed for the stale slot so it isn't orphaned.
  if (ctx.pendingBookingId) {
    await cancelBooking(db, calendar, identity, ctx.pendingBookingId, 'Customer revised the request before confirming').catch(() => { /* non-fatal */ })
  }

  const ps = ctx.pendingSlot
  const seededDraft = ps ? slotDraftFromPending(ps, businessTimezone) : ctx.slotDraft
  const { pendingSlot: _ps, pendingBookingId: _pb, awaitingConfirmationFor: _a, ...rest } = ctx
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

  // Date — resolved DETERMINISTICALLY from structured pieces; LLM never computes.
  let dateProblem: string | null = null
  if (slot && (slot.relativeDay || slot.weekday != null || slot.explicitDate)) {
    const parts: RequestedDateParts = {
      relativeDay: slot.relativeDay ?? null,
      weekday: slot.weekday ?? null,
      explicitDate: slot.explicitDate ?? null,
    }
    const resolved = resolveRequestedDate(parts, businessTimezone, now)
    if (resolved.ok) draft.dateStr = resolved.dateStr
    else if (resolved.reason !== 'no_date') dateProblem = resolved.reason
  }
  if (slot?.time) draft.time = { hour: slot.time.hour, minute: slot.time.minute }

  const service =
    resolveService(intent.serviceTypeHint, activeServices) ??
    (draft.serviceTypeId ? activeServices.find((s) => s.id === draft.serviceTypeId) ?? null : null) ??
    // Referential fallback: the customer is continuing ("the one we discussed",
    // "sign me up", "yes") without re-naming the service. Adopt the single service
    // the conversation has clearly been about — never guess when it's ambiguous.
    inferFocusService(transcript, activeServices)
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
    const { dateStr: _droppedDate, time: _droppedTime, ...keptDraft } = draft
    await updateSessionContext(
      db, session.id,
      { ...ctx, slotDraft: keptDraft, clarificationAttempts: 0 },
      'waiting_clarification',
    )
    const reply = await genReply({
      businessTimezone,
      businessName, language: lang, transcript, ...persona, customerMemory: extractMemory(ctx),
      situation: 'The customer has struggled to land on a workable date/time after several tries. Warmly suggest it might be quickest to sort out by phone with the business — but stay open: invite them to just name another day and you will keep trying. Do NOT end the conversation or say goodbye.',
    })
    return { reply, sessionComplete: false }
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
    await updateSessionContext(db, session.id, { ...ctx, slotDraft: draft, clarificationAttempts: newAttempts }, 'waiting_clarification')

    let ask: string
    if (!draft.serviceTypeId) {
      const list = activeServices.map((s) => s.name).join(', ')
      ask = `The customer wants to book but hasn't said which service. Available: ${list}. Ask which one — one question, naturally.`
    } else if (!draft.dateStr) {
      ask = `Booking ${draft.serviceName}. Still need the day — ask which day works. Do NOT re-ask the service.`
    } else {
      ask = `Booking ${draft.serviceName} on ${formatLocalDate(draft.dateStr, businessTimezone)}. Still need the time — ask what time. Do NOT re-ask the day or service.`
    }
    const reply = await genReply({
      businessTimezone,
      businessName, language: lang, transcript, ...persona, customerMemory: extractMemory(ctx),
      situation: `${firstMsgPrefix}${ask}`,
    })
    return { reply, sessionComplete: false }
  }

  // ── All pieces present: compose the absolute slot, then the DETERMINISTIC gate ─
  const svc = activeServices.find((s) => s.id === draft.serviceTypeId)!

  // Party-size vs service model: don't silently confirm "yoga for 3" on a 1-on-1.
  if (draft.participants != null && draft.participants > 1 && svc.maxParticipants === 1) {
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
    const suggestion = await buildDayOptionsText(db, business, localParts(slotStart, businessTimezone).dateStr, businessTimezone, svc.id, ctx.negotiationConstraints)
    await updateSessionContext(db, session.id, {
      ...ctx, slotDraft: draftKeep, clarificationAttempts: 0,
      ...(suggestion.offered.length > 0 ? { lastOfferedSlots: suggestion.offered } : {}),
    }, 'waiting_clarification')
    const classTimesText = suggestion.text
    const situation = [
      `${svc.name} doesn't run at the time the customer asked — it only runs at set class times, so that exact time can't be booked.`,
      classTimesText
        ? `Offer these actual scheduled times and ask which they'd like: ${classTimesText}.`
        : `There are no more ${svc.name} classes on that day. Don't invent a time — offer to check another day.`,
    ].filter(Boolean).join(' ')
    const reply = await genReply({
      businessTimezone,
      businessName, language: lang, transcript, ...persona, customerMemory: extractMemory(ctx),
      situation,
    })
    return { reply, sessionComplete: false }
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
  const confirmation = parseConfirmation(messageText)

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
    const confirmedDate = pendingSlot ? formatSlotDate(new Date(pendingSlot.start), businessTimezone) : 'the requested date'
    const confirmedTime = pendingSlot ? formatSlotTime(new Date(pendingSlot.start), businessTimezone) : 'the requested time'
    const reply = await genReply({
      businessTimezone,
      businessName,
      language: lang,
      situation: `Booking confirmed for ${pendingSlot?.serviceName ?? 'appointment'} on ${confirmedDate} at ${confirmedTime}.`,
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    }, { bookingConfirmed: true })
    return { reply, sessionComplete: true }
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
    const { pendingSlot: _clearedSlot, awaitingConfirmationFor: _clearedAwait, lastOfferedSlots: _loClear, ...ctxWithoutPending } = ctx
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
    const classSuggestion = classModeMiss && business
      ? await buildDayOptionsText(db, business, localParts(new Date(pendingSlot.start), businessTimezone).dateStr, businessTimezone, pendingSlot.serviceTypeId, ctx.negotiationConstraints)
      : NO_SUGGESTION
    const offeredAlternatives = classModeMiss ? classSuggestion.offered : openSuggestion.offered
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
            classTimesText
              ? `Offer these actual scheduled times and ask which they'd like: ${classTimesText}.`
              : `There are no more ${pendingSlot.serviceName} classes on that day. Don't invent a time — offer to check another day.`,
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
    })
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

  // Private session — hold placed, ask for a final confirmation (plain words)
  const newCtx: BookingFlowContext = {
    ...ctx,
    pendingBookingId: result.bookingId,
    awaitingConfirmationFor: 'hold',
  }
  await updateSessionContext(db, session.id, newCtx, 'waiting_confirmation')

  const heldDate = formatSlotDate(new Date(pendingSlot.start), businessTimezone)
  const heldTime = formatSlotTime(new Date(pendingSlot.start), businessTimezone)
  const reply = await genReply({
    businessTimezone,
    businessName,
    language: lang,
    situation: `Slot successfully held for ${pendingSlot.serviceName} on ${heldDate} at ${heldTime}. Ask the customer to confirm they want it locked in — naturally, no menu.`,
    transcript,
    customerMemory: extractMemory(ctx),
  })
  return { reply, sessionComplete: false }
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

  const detectedLanguage = intentResult.data.detectedLanguage
  const mergedCtx: BookingFlowContext = { ...updatedContext, detectedLanguage }
  await updateSessionContext(db, session.id, mergedCtx, 'active')
  return handleBookingIntent(
    db, calendar, identity,
    { ...session, state: 'active', context: mergedCtx },
    mergedCtx, intentResult.data, activeServices, businessTimezone, businessName, transcript, genReply, '', business,
  )
}

async function handleCancellationIntent(
  db: Db,
  calendar: CalendarClient,
  identity: ResolvedIdentity,
  session: ActiveSession,
  ctx: BookingFlowContext,
  businessTimezone: string,
  businessName: string,
  transcript: TranscriptTurn[],
  genReply: GenReply,
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

async function handleCancellationSelection(
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
): Promise<FlowResult> {
  const lang = ctx.detectedLanguage ?? 'en'
  const candidates = ctx.cancellationCandidates ?? []
  const n = parseInt(messageText.trim(), 10)

  if (isNaN(n) || n < 1 || n > candidates.length) {
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

  const selectedId = candidates[n - 1]!
  const newCtx: BookingFlowContext = {
    ...ctx,
    targetBookingId: selectedId,
    awaitingConfirmationFor: 'cancellation',
  }
  await updateSessionContext(db, session.id, newCtx, 'waiting_confirmation')

  // Ask for explicit confirmation before acting — do NOT auto-confirm
  const situation = ctx.isReschedulingFlow
    ? `Customer selected booking #${n} as the one to move. Confirm that's the booking they want to reschedule — naturally, no menu. (It stays booked until the new time is set.)`
    : `Customer selected booking #${n} to cancel. Ask them to confirm the cancellation — naturally, no menu.`
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
  const confirmation = parseConfirmation(messageText)

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
    const { targetBookingId: _t, awaitingConfirmationFor: _a, cancellationCandidates: _c, isReschedulingFlow: _r, ...rest } = ctx
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

  await completeSession(db, session.id)
  const reply = await genReply({
    businessTimezone,
    businessName,
    language: lang,
    situation: 'Booking successfully cancelled.',
    transcript,
    customerMemory: extractMemory(ctx),
  })
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
    })
    return { reply, sessionComplete: true }
  }

  // parsed.kind === 'accept' — convert the cancel into a reschedule (deferred-cancel).
  const chosen = offered[parsed.index]!
  const { targetBookingId: _t, awaitingConfirmationFor: _a, retentionOfferedSlots: _r, cancellationCandidates: _c, isReschedulingFlow: _i, ...rest } = ctx
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

function resolveService(
  hint: string | null,
  services: Array<{ id: string; name: string; durationMinutes: number; maxParticipants: number; category: string | null }>,
) {
  if (services.length === 0) return null
  if (services.length === 1) return services[0]!
  if (!hint) return null

  const lower = hint.toLowerCase()
  return services.find((s) => s.name.toLowerCase().includes(lower)) ?? null
}
