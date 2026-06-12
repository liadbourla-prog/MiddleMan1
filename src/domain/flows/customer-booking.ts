import { eq, and, or, gt, gte, isNull, count } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { serviceTypes, bookings, identities, availability } from '../../db/schema.js'
import type { Business, CalendarBlockType } from '../../db/schema.js'
import type { ResolvedIdentity } from '../identity/types.js'
import type { ActiveSession } from '../session/types.js'
import { updateSessionContext, completeSession, failSession } from '../session/manager.js'
import { requestBooking, confirmBooking, cancelBooking } from '../booking/engine.js'
import { extractCustomerIntent, generateCustomerReply } from '../../adapters/llm/client.js'
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
  if (!hydrated.customerMemory && !hydrated.returningCustomer && recentBookings.length === 0) return null
  return {
    returningCustomer: hydrated.returningCustomer ?? false,
    preferredServiceName: hydrated.preferredServiceName ?? null,
    displayName: hydrated.customerMemory?.displayName ?? null,
    ...(recentBookings.length > 0 ? { recentBookings } : {}),
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

  // ── REBOOK shortcut — treat as fresh booking intent (B5: includes Hebrew variants) ──
  const rebookVariants = /^(rebook|re-book|תיאום מחדש|קביעת תור מחדש|לקבוע מחדש|להזמין מחדש)$/i
  if (rebookVariants.test(messageText.trim())) {
    await updateSessionContext(db, session.id, { ...ctx, detectedLanguage: lang }, 'active')
    const reply = await generateCustomerReply({
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
      const reply = await generateCustomerReply({
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

  // ── Owner-rule escalation check (runs before any intent logic) ────────────
  if (business) {
    // +1 because sessionUnknownCount is the stored tally from prior turns;
    // the current message will increment it if it resolves to unknown.
    const unknownCount = ((ctx.sessionUnknownCount as number | undefined) ?? 0) + 1
    const ownerEscalation = await checkOwnerEscalationRules(
      db, business, identity.phoneNumber, messageText, 'unknown', unknownCount, lang,
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
    return handleCancellationSelection(db, calendar, identity, session, ctx, messageText, businessTimezone, businessName, transcript)
  }

  // ── Branch: waiting for hold confirmation ────────────────────────────────
  if (session.state === 'waiting_confirmation' && ctx.awaitingConfirmationFor === 'hold') {
    return handleHoldConfirmation(db, calendar, identity, session, ctx, messageText, businessTimezone, businessName, transcript, business)
  }

  // ── Branch: waiting for cancellation confirmation ────────────────────────
  if (session.state === 'waiting_confirmation' && ctx.awaitingConfirmationFor === 'cancellation') {
    return handleCancellationConfirmation(db, calendar, identity, session, ctx, messageText, businessTimezone, businessName, transcript)
  }

  // ── Branch: waiting for clarification on vague slot ──────────────────────
  if (session.state === 'waiting_clarification') {
    return handleClarification(db, calendar, identity, session, ctx, messageText, businessTimezone, businessName, transcript, business)
  }

  // ── Default: new message, extract intent ─────────────────────────────────
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
    await failSession(db, session.id)
    if (intentResult.error === 'quota_exceeded') {
      const quotaReply = lang === 'he'
        ? 'אנחנו עסוקים כרגע. אנא נסה שוב בעוד מספר דקות.'
        : "We're a bit busy right now. Please try again in a few minutes."
      return { reply: quotaReply, sessionComplete: true, sessionFailed: true }
    }
    const reply = await generateCustomerReply({
      businessTimezone,
      businessName,
      language: lang,
      situation: 'Intent extraction failed. Ask the customer to rephrase their request.',
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: true, sessionFailed: true }
  }

  const intent = intentResult.data
  const detectedLanguage = intent.detectedLanguage

  // Determine whether to append an inline language switch offer after this reply.
  // Offer when: detected language differs from default, no override locked yet.
  const shouldOfferSwitch = !ctx.languageOverride && detectedLanguage !== defaultLang

  // Greet at most once per session. firstMsgPrefix is the ONLY thing that licenses
  // a greeting/intro; every later turn must continue without re-introducing.
  const mayGreet = isFirstMessage && !ctx.greeted

  // Persist language detection into context so all subsequent branches use it
  const updatedCtx: BookingFlowContext = {
    ...ctx,
    detectedLanguage,
    ...(mayGreet ? { greeted: true } : {}),
    ...(shouldOfferSwitch ? { languageSwitchOfferPending: true } : {}),
  }

  // Prefix injected into situation strings for first-message targeted intents
  const firstMsgPrefix = mayGreet
    ? 'This is the customer\'s first message — include a brief warm greeting before addressing their request. '
    : 'Do NOT greet or re-introduce yourself — continue the conversation directly. '

  const intentResult2 = await (async (): Promise<FlowResult> => {
    switch (intent.intent) {
      case 'booking':
        return handleBookingIntent(db, calendar, identity, session, updatedCtx, intent, activeServices, businessTimezone, businessName, transcript, firstMsgPrefix, business)

      case 'rescheduling':
        return handleReschedulingIntent(db, calendar, identity, session, updatedCtx, intent, activeServices, businessTimezone, businessName, transcript, business)

      case 'cancellation':
        return handleCancellationIntent(db, calendar, identity, session, updatedCtx, businessTimezone, businessName, transcript)

      case 'list_bookings':
        return handleListBookings(db, identity, session, updatedCtx, businessTimezone, businessName, transcript)

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
          ? `${firstMsgPrefix}Customer asked a question about the business, services, hours, or availability. ${customerCtx}${hoursCtx}${slotCtx} Services available: ${serviceDescriptions}. Answer their specific question using the hours, real open times, FAQs, and service info above. If they asked which times/days are open, give the actual open times above as a short bullet list and invite them to pick one — never invent times. We do not track individual staff members' personal schedules; if asked about a specific instructor's hours, answer with the studio's hours/openings and say bookings go through here.`
          : `${firstMsgPrefix}Customer asked about the business. ${customerCtx} No services are configured yet. Direct them to contact the business directly.`
        const knowledgeFields = businessKnowledge ? {
          brandVoice: businessKnowledge.brandVoice,
          ...(businessKnowledge.communicationStyle ? { communicationStyle: businessKnowledge.communicationStyle } : {}),
          faqs: businessKnowledge.faqs,
        } : {}
        const inquiryReply = await generateCustomerReply({
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
        const explainReply = await generateCustomerReply({
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
        const unknownCount = ((updatedCtx.sessionUnknownCount as number | undefined) ?? 0) + 1
        const ctxWithCount: BookingFlowContext = { ...updatedCtx, sessionUnknownCount: unknownCount }

        if (unknownCount >= 2 && business) {
          await escalateToPlatform(db, business, identity.phoneNumber, messageText)
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
        const unknownReply = await generateCustomerReply({
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
    (draft.serviceTypeId ? activeServices.find((s) => s.id === draft.serviceTypeId) ?? null : null)
  if (service) {
    draft.serviceTypeId = service.id
    draft.serviceName = service.name
  }
  if (intent.participantsHint != null) draft.participants = intent.participantsHint

  const failAfterThreeTries = async (): Promise<FlowResult> => {
    await failSession(db, session.id)
    const reply = await generateCustomerReply({
      businessTimezone,
      businessName, language: lang, transcript, ...persona, customerMemory: extractMemory(ctx),
      situation: 'The customer has not landed on a workable date/time after several tries. Wrap up warmly and suggest they call the business directly.',
    })
    return { reply, sessionComplete: true, sessionFailed: true }
  }

  // ── A bad date (past / impossible / ambiguous): clarify, don't echo it back ─
  if (dateProblem) {
    const newAttempts = attempts + 1
    if (newAttempts >= 3) return failAfterThreeTries()
    await updateSessionContext(db, session.id, { ...ctx, slotDraft: draft, clarificationAttempts: newAttempts }, 'waiting_clarification')
    const reply = await generateCustomerReply({
      businessTimezone,
      businessName, language: lang, transcript, ...persona, customerMemory: extractMemory(ctx),
      situation: `${firstMsgPrefix}The customer wants to book but ${sanitiseReason(dateProblem)}. Without repeating the unusable date back, ask which upcoming day they'd like.`,
    })
    return { reply, sessionComplete: false }
  }

  // ── Still missing one of {service, date, time}? Ask for exactly one ────────
  if (!draft.serviceTypeId || !draft.dateStr || !draft.time) {
    const newAttempts = attempts + 1
    if (newAttempts >= 3) return failAfterThreeTries()
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
    const reply = await generateCustomerReply({
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
    const reply = await generateCustomerReply({
      businessTimezone,
      businessName, language: lang, transcript, ...persona, customerMemory: extractMemory(ctx),
      situation: `${svc.name} is a private, one-on-one session — it can't take ${draft.participants} people on a single booking. Ask whether they'd like to go ahead with just one spot, or if they meant something else.`,
    })
    return { reply, sessionComplete: false }
  }
  if (draft.participants != null && draft.participants > svc.maxParticipants && svc.maxParticipants > 1) {
    const { participants: _dropParticipants, ...draftKeep } = draft
    await updateSessionContext(db, session.id, { ...ctx, slotDraft: draftKeep, clarificationAttempts: attempts + 1 }, 'waiting_clarification')
    const reply = await generateCustomerReply({
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
    const reply = await generateCustomerReply({
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
    const reply = await generateCustomerReply({
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
  const reply = await generateCustomerReply({
    businessTimezone,
    businessName, language: lang, transcript, ...persona, customerMemory: extractMemory(ctx),
    situation: `${firstMsgPrefix}Customer wants to book ${svc.name} on ${displayDate} at ${displayTime}. Restate the service, day, date and time clearly, then ask them to confirm.`,
  })
  return { reply, sessionComplete: false }
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
    return handleBookingIntent(db, calendar, identity, session, ctx, intent, activeServices, businessTimezone, businessName, transcript, '', business)
  }

  if (activeBookings.length > 1) {
    return enterCancellationSelection(db, session, ctx, activeBookings, businessTimezone, businessName, transcript, lang, true)
  }

  const existing = activeBookings[0]!
  const cancelResult = await cancelBooking(db, calendar, identity, existing.id, 'Rescheduled by customer via WhatsApp')
  if (!cancelResult.ok) {
    const reply = await generateCustomerReply({
      businessTimezone,
      businessName,
      language: lang,
      situation: `Could not cancel the existing booking in order to reschedule because ${sanitiseReason(cancelResult.reason)}. Apologise and suggest they contact the business directly.`,
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: true }
  }

  const newCtx: BookingFlowContext = { ...ctx, rescheduledFrom: existing.id }
  return handleBookingIntent(db, calendar, identity, session, newCtx, intent, activeServices, businessTimezone, businessName, transcript, '', business)
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
  business?: Business,
): Promise<FlowResult> {
  const lang = ctx.detectedLanguage ?? 'en'
  const confirmation = parseConfirmation(messageText)

  if (confirmation === 'unclear') {
    const reply = await generateCustomerReply({
      businessTimezone,
      businessName,
      language: lang,
      situation: "Customer's reply was unclear. Gently ask again whether they want to go ahead with the booking or not — in plain words, no menu.",
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: false }
  }

  if (confirmation === 'no') {
    await completeSession(db, session.id)
    const reply = await generateCustomerReply({
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
      const reply = await generateCustomerReply({
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

    const pendingSlot = ctx.pendingSlot
    const confirmedDate = pendingSlot ? formatSlotDate(new Date(pendingSlot.start), businessTimezone) : 'the requested date'
    const confirmedTime = pendingSlot ? formatSlotTime(new Date(pendingSlot.start), businessTimezone) : 'the requested time'
    const reply = await generateCustomerReply({
      businessTimezone,
      businessName,
      language: lang,
      situation: `Booking confirmed for ${pendingSlot?.serviceName ?? 'appointment'} on ${confirmedDate} at ${confirmedTime}.`,
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: true }
  }

  // No hold placed yet — place the hold first
  const pendingSlot = ctx.pendingSlot
  if (!pendingSlot) {
    await failSession(db, session.id)
    const reply = await generateCustomerReply({
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
    await completeSession(db, session.id)
    const hoursSummary = business ? await loadHoursSummary(db, business.id) : null
    // Proactive suggestion: enumerate real bookable openings near the request so
    // we can offer concrete alternatives ("I have 3pm or 4:30 free") instead of a
    // bare "that time doesn't work". Canonical spine — honours hours + blocks +
    // existing bookings. (CALENDAR_UX_DESIGN.md decision D.)
    const openSlotsText = business
      ? await suggestOpenSlotsText(db, business, pendingSlot.serviceTypeId, new Date(pendingSlot.start), new Date(pendingSlot.end), businessTimezone)
      : null
    const unavailSituation = [
      `The requested slot is unavailable because ${sanitiseReason(result.reason)}.`,
      hoursSummary ?? '',
      openSlotsText
        ? `Offer these actual open times and ask which they'd like: ${openSlotsText}.`
        : 'Suggest the customer pick a different time that falls within business hours.',
    ].filter(Boolean).join(' ')
    const reply = await generateCustomerReply({
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
    const confirmedDate = formatSlotDate(new Date(pendingSlot.start), businessTimezone)
    const confirmedTime = formatSlotTime(new Date(pendingSlot.start), businessTimezone)
    const reply = await generateCustomerReply({
      businessTimezone,
      businessName,
      language: lang,
      situation: `Spot confirmed in ${pendingSlot.serviceName} class on ${confirmedDate} at ${confirmedTime}. ${result.message}`,
      transcript,
      customerMemory: extractMemory(ctx),
    })
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
  const reply = await generateCustomerReply({
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
    const reply = await generateCustomerReply({
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
    mergedCtx, intentResult.data, activeServices, businessTimezone, businessName, transcript, '', business,
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
    const reply = await generateCustomerReply({
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

    const reply = await generateCustomerReply({
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

  return enterCancellationSelection(db, session, ctx, activeBookings, businessTimezone, businessName, transcript, lang, false)
}

async function enterCancellationSelection(
  db: Db,
  session: ActiveSession,
  ctx: BookingFlowContext,
  activeBookings: Array<{ id: string; slotStart: Date; serviceTypeId: string }>,
  businessTimezone: string,
  businessName: string,
  transcript: TranscriptTurn[],
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
  const reply = await generateCustomerReply({
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
): Promise<FlowResult> {
  const lang = ctx.detectedLanguage ?? 'en'
  const candidates = ctx.cancellationCandidates ?? []
  const n = parseInt(messageText.trim(), 10)

  if (isNaN(n) || n < 1 || n > candidates.length) {
    const reply = await generateCustomerReply({
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

  // Ask for explicit confirmation before cancelling — do NOT auto-confirm
  const reply = await generateCustomerReply({
    businessTimezone,
    businessName,
    language: lang,
    situation: `Customer selected booking #${n} to cancel. Ask them to confirm the cancellation — naturally, no menu.`,
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
): Promise<FlowResult> {
  const lang = ctx.detectedLanguage ?? 'en'
  const confirmation = parseConfirmation(messageText)

  if (confirmation === 'unclear') {
    const reply = await generateCustomerReply({
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
    const reply = await generateCustomerReply({
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
    const reply = await generateCustomerReply({
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

  const result = await cancelBooking(db, calendar, identity, bookingId, 'Customer requested via WhatsApp')

  if (!result.ok) {
    await completeSession(db, session.id)
    const reply = await generateCustomerReply({
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

  // B1 fix: if this cancellation was part of a reschedule flow, continue to booking
  if (ctx.isReschedulingFlow) {
    const { targetBookingId: _t, awaitingConfirmationFor: _a, cancellationCandidates: _c, isReschedulingFlow: _r, ...rest } = ctx
    const newCtx: BookingFlowContext = { ...rest, rescheduledFrom: bookingId }
    await updateSessionContext(db, session.id, newCtx, 'active')
    const reply = await generateCustomerReply({
      businessTimezone,
      businessName,
      language: lang,
      situation: 'Old booking successfully cancelled as part of reschedule. Ask the customer what date and time they would like for their new appointment.',
      transcript,
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: false }
  }

  await completeSession(db, session.id)
  const reply = await generateCustomerReply({
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
    const reply = await generateCustomerReply({
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

  const reply = await generateCustomerReply({
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
