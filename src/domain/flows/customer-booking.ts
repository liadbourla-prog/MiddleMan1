import { eq, and, or, gt, gte, isNull, count } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { serviceTypes, bookings, identities, availability } from '../../db/schema.js'
import type { Business, CalendarBlockType } from '../../db/schema.js'
import type { ResolvedIdentity } from '../identity/types.js'
import type { ActiveSession } from '../session/types.js'
import { buildActionLedgerBlock } from '../audit/ledger-block.js'
import { updateSessionContext, completeSession, failSession } from '../session/manager.js'
import { requestBooking, confirmBooking, cancelBooking } from '../booking/engine.js'
import { extractCustomerIntent, generateCustomerReply } from '../../adapters/llm/client.js'
import { assertsBookingConfirmed } from './reply-guard.js'
import { inferFocusService } from './service-resolution.js'
import { middlemanOneLiner } from '../../adapters/llm/middleman-identity.js'
import type { CalendarClient } from '../../adapters/calendar/client.js'
import { parseConfirmation } from './types.js'
import type { FlowResult, BookingFlowContext } from './types.js'
import type { CustomerIntentOutput } from '../../adapters/llm/types.js'
import type { TranscriptTurn } from '../../adapters/llm/types.js'
import type { HydratedContext } from '../session/hydration.js'
import { checkOwnerEscalationRules, escalateToPlatform } from '../escalation/engine.js'
import type { BusinessKnowledge } from '../../shared/skill-types.js'
import { t } from '../i18n/t.js'
import { getOpenSlots, isSlotBookable } from '../availability/service.js'
import { listDayOptions } from '../availability/day-options.js'
import { resolveRequestedDate, resolveSlotStart, addDaysToDateStr, isDstGap, type RequestedDateParts } from '../availability/resolve-slot.js'
import { localParts } from '../availability/compute.js'
import { validateSlotTiming } from '../booking/engine.js'

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

// Enumerate up to 4 real bookable openings for a service, starting from the
// requested time, over the next 14 days. Returns a compact human string for the
// LLM to phrase, or null when nothing is open. Uses the canonical availability
// spine so suggestions never collide with hours, blocks, or existing bookings.
async function suggestOpenSlotsText(
  db: Db,
  business: Business,
  serviceTypeId: string,
  requestedStart: Date,
  requestedEnd: Date,
  tz: string,
): Promise<string | null> {
  const durationMinutes = Math.max(15, Math.round((requestedEnd.getTime() - requestedStart.getTime()) / 60_000))
  const now = new Date()
  const from = requestedStart.getTime() > now.getTime() ? requestedStart : now
  const to = new Date(from.getTime() + 14 * 24 * 60 * 60_000)
  try {
    const slots = await getOpenSlots(db, business, { start: from, end: to }, durationMinutes, { maxSlots: 4 })
    if (slots.length === 0) return null
    return slots
      .map((s) => `${formatSlotDate(s.start, tz)} at ${formatSlotTime(s.start, tz)}`)
      .join(', ')
  } catch {
    return null
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
): Promise<string | null> {
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

  try {
    const slots = await getOpenSlots(db, business, { start: from, end: to }, duration, { maxSlots: 6 })
    if (slots.length > 0) {
      const list = slots.map((s) => `${formatSlotDate(s.start, tz)} at ${formatSlotTime(s.start, tz)}`).join('; ')
      return `Actual open times in the window the customer asked about: ${list}.`
    }
    if (!scoped) return 'No open times in the next two weeks.'
    // Specific day/week had nothing — offer the next real opening overall, honestly.
    const fallback = await getOpenSlots(db, business, { start: now, end: new Date(now.getTime() + 14 * 86_400_000) }, duration, { maxSlots: 3 })
    if (fallback.length === 0) return 'Nothing open in the window they asked about, and nothing in the next two weeks.'
    const list = fallback.map((s) => `${formatSlotDate(s.start, tz)} at ${formatSlotTime(s.start, tz)}`).join('; ')
    return `Nothing open in the window they asked about. The next real openings are: ${list}.`
  } catch {
    return null
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
): Promise<string | null> {
  const day = await listDayOptions(db, business, dateStr, tz, serviceTypeId ? { serviceTypeId } : {})
  const dayLabel = formatLocalDate(dateStr, tz)
  const parts: string[] = []

  if (day.classes.length > 0) {
    const items = day.classes.slice(0, 10).map((c) => {
      const cap = c.spotsLeft <= 0 ? 'full' : `${c.spotsLeft} spot${c.spotsLeft === 1 ? '' : 's'} left`
      return `${c.serviceName} at ${formatSlotTime(c.start, tz)} (${cap})`
    })
    parts.push(`Classes on ${dayLabel}: ${items.join('; ')}.`)
  }

  if (day.privateOpenings.length > 0) {
    const items = day.privateOpenings.slice(0, 6).map((p) => {
      const times = p.slots.slice(0, 4).map((s) => formatSlotTime(s, tz)).join(', ')
      return `${p.serviceName} at ${times}`
    })
    parts.push(`Open private times on ${dayLabel}: ${items.join('; ')}.`)
  }

  return parts.length > 0 ? parts.join(' ') : null
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
function makeGenReply(businessFacts: string, actionLedger: string): GenReply {
  return async (input, opts = {}) => {
    const grounded = {
      ...input,
      ...(businessFacts ? { businessFacts } : {}),
      ...(actionLedger ? { actionLedger } : {}),
    }
    const reply = await generateCustomerReply(grounded)
    if (opts.bookingConfirmed) return reply
    if (!assertsBookingConfirmed(reply, input.language)) return reply

    const correctedInput = {
      ...grounded,
      situation: `${input.situation}\n\nCRITICAL: No booking has been made or confirmed. Do NOT state or imply the appointment is booked, reserved, registered, or done. If a decision is needed, ask for it plainly.`,
    }
    const corrected = await generateCustomerReply(correctedInput)
    if (!assertsBookingConfirmed(corrected, input.language)) return corrected
    return BOOKING_NOT_CONFIRMED_FALLBACK[input.language]
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
  const ctx = {
    ...(session.context as BookingFlowContext),
    ...(botPersona ? { botPersona } : {}),
  } as BookingFlowContext
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
  const genReply = makeGenReply(businessFacts, actionLedger)

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
    return handleHoldConfirmation(db, calendar, identity, session, ctx, messageText, businessTimezone, businessName, transcript, genReply, business)
  }

  // ── Branch: waiting for cancellation confirmation ────────────────────────
  if (session.state === 'waiting_confirmation' && ctx.awaitingConfirmationFor === 'cancellation') {
    return handleCancellationConfirmation(db, calendar, identity, session, ctx, messageText, businessTimezone, businessName, transcript, genReply, business)
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
  const detectedLanguage = intent.detectedLanguage

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
          if (resolvedDay && resolvedDay.ok) {
            availabilityText = await buildDayOptionsText(db, business, resolvedDay.dateStr, businessTimezone, inquiryService?.id)
          }
          if (!availabilityText) {
            availabilityText = await buildInquiryAvailabilityText(db, business, intent.slotRequest, activeServices, businessTimezone)
          }
        }
        const hoursSummary = business ? await loadHoursSummary(db, business.id) : null

        const customerCtx = recentBookingCount > 0
          ? `Returning customer with ${recentBookingCount} booking(s) in the last 90 days.`
          : 'First-time or lapsed customer.'
        const slotCtx = availabilityText ? ` ${availabilityText}` : ''
        const hoursCtx = hoursSummary ? ` ${hoursSummary}` : ''

        const situation = activeServices.length > 0
          ? `${firstMsgPrefix}Customer asked a question about the business, services, hours, or availability. ${customerCtx}${hoursCtx}${slotCtx} Services available: ${serviceDescriptions}. Answer their specific question using the hours, real open times, FAQs, and service info above. If they asked which times/days are open, give the actual open times above as a short bullet list and invite them to pick one — never invent times. If the customer asks to book with a specific instructor by name, that is supported — bookings go through here. Do NOT proactively bring up, list, or advertise individual instructors or who teaches what; only engage with instructor specifics if the customer raises them first.`
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

  // ── Inline language switch offer ─────────────────────────────────────────
  // Append once per turn when we detected a different language and no override is set yet.
  if (shouldOfferSwitch && intentResult2.reply && !intentResult2.sessionComplete) {
    const offerSuffix = detectedLanguage === 'en'
      ? '\n\nWant me to keep going in English? Just say the word.'
      : '\n\nרוצה שאמשיך בעברית? פשוט תכתוב לי כן.'
    return { ...intentResult2, reply: intentResult2.reply + offerSuffix }
  }

  return intentResult2
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
  activeServices: Array<{ id: string; name: string; durationMinutes: number; maxParticipants: number; category: string | null }>,
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
  if ((intent.intent !== 'booking' && intent.intent !== 'rescheduling') || !hasNewSlot) return null

  // Release any hold already placed for the stale slot so it isn't orphaned.
  if (ctx.pendingBookingId) {
    await cancelBooking(db, calendar, identity, ctx.pendingBookingId, 'Customer revised the request before confirming').catch(() => { /* non-fatal */ })
  }

  const ps = ctx.pendingSlot
  const seededDraft = ps ? slotDraftFromPending(ps, businessTimezone) : ctx.slotDraft
  const { pendingSlot: _ps, pendingBookingId: _pb, awaitingConfirmationFor: _a, ...rest } = ctx
  const rebuildCtx: BookingFlowContext = {
    ...rest,
    ...(seededDraft ? { slotDraft: seededDraft } : {}),
    clarificationAttempts: 0,
  }
  await updateSessionContext(db, session.id, rebuildCtx, 'active')

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
  activeServices: Array<{ id: string; name: string; durationMinutes: number; maxParticipants: number; category: string | null }>,
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
    await updateSessionContext(db, session.id, { ...ctx, slotDraft: draftKeep, clarificationAttempts: 0 }, 'waiting_clarification')
    const openSlotsText = business
      ? await suggestOpenSlotsText(db, business, svc.id, slotStart, slotEnd, businessTimezone)
      : null
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

  // ── Passed every gate: confirmation built from the RESOLVED slot (never the LLM's date) ─
  const displayDate = formatSlotDate(slotStart, businessTimezone)
  const displayTime = formatSlotTime(slotStart, businessTimezone)

  const { slotDraft: _clearDraft, ...ctxWithoutDraft } = ctx
  const newCtx: BookingFlowContext = {
    ...ctxWithoutDraft,
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
): Promise<void> {
  if (!ctx.rescheduledFrom) return
  try {
    await cancelBooking(db, calendar, identity, ctx.rescheduledFrom, 'Superseded by reschedule')
  } catch {
    /* old slot lingers; surfaced via the customer's upcoming-appointments view + reminders */
  }
}

async function handleReschedulingIntent(
  db: Db,
  calendar: CalendarClient,
  identity: ResolvedIdentity,
  session: ActiveSession,
  ctx: BookingFlowContext,
  intent: CustomerIntentOutput,
  activeServices: Array<{ id: string; name: string; durationMinutes: number; maxParticipants: number; category: string | null }>,
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
  const newCtx: BookingFlowContext = { ...ctx, rescheduledFrom: existing.id }
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
      situation: 'Customer declined the slot. Booking not made. Offer to try a different time.',
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: true }
  }

  // If pendingBookingId is set, hold is already placed — this YES is the final confirmation
  if (ctx.pendingBookingId) {
    const confirmResult = await confirmBooking(
      db, calendar, identity, ctx.pendingBookingId,
      (ctx as unknown as Record<string, string>)['displayName'] ?? 'Customer',
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

    await completeSession(db, session.id)
    const hoursSummary = business ? await loadHoursSummary(db, business.id) : null
    // Proactive suggestion: enumerate real bookable openings near the request so
    // we can offer concrete alternatives ("I have 3pm or 4:30 free") instead of a
    // bare "that time doesn't work". Canonical spine — honours hours + blocks +
    // existing bookings. (CALENDAR_UX_DESIGN.md decision D.)
    const openSlotsText = business
      ? await suggestOpenSlotsText(db, business, pendingSlot.serviceTypeId, new Date(pendingSlot.start), new Date(pendingSlot.end), businessTimezone)
      : null
    // Reactive instructor case: the customer named an instructor who teaches this
    // service but isn't free for the chosen slot. Surface that instructor's hours
    // (we only volunteer this because the customer raised the instructor first —
    // never proactively advertise staff schedules).
    const providerUnavail = parseProviderUnavailable(result.reason, lang)
    const unavailSituation = providerUnavail
      ? `The customer asked to book with ${providerUnavail.name}, but ${providerUnavail.name} does not teach at the time they chose. ${providerUnavail.name}'s teaching times are: ${providerUnavail.hoursPhrase}. Reactively offer one of those times OR another instructor — do not invent times, and do not volunteer other staff names unprompted. Keep it warm and brief.`
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
    return { reply, sessionComplete: true }
  }

  // Group class — booking already confirmed, no second YES needed
  if (result.directlyConfirmed) {
    await completeSession(db, session.id)
    // New booking is committed — release the slot it replaces (reschedule into a class).
    await releaseSupersededBooking(db, calendar, identity, ctx)
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
        })
        .from(serviceTypes)
        .where(and(eq(serviceTypes.businessId, identity.businessId), eq(serviceTypes.isActive, true)))
      await updateSessionContext(db, session.id, newCtx, 'active')
      // Synthetic intent: the slot is already in the draft, so no new pieces to merge.
      const synthetic: CustomerIntentOutput = {
        intent: 'booking', slotRequest: null, serviceTypeHint: null, providerHint: null,
        participantsHint: null, summary: null, rawEntities: {}, detectedLanguage: lang,
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
