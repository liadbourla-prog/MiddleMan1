import { eq, and, or, gt, isNull } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { serviceTypes, bookings, identities, availability } from '../../db/schema.js'
import type { Business } from '../../db/schema.js'
import type { ResolvedIdentity } from '../identity/types.js'
import type { ActiveSession } from '../session/types.js'
import { updateSessionContext, completeSession, failSession } from '../session/manager.js'
import { requestBooking, confirmBooking, cancelBooking } from '../booking/engine.js'
import { extractCustomerIntent, generateCustomerReply } from '../../adapters/llm/client.js'
import type { CalendarClient } from '../../adapters/calendar/client.js'
import { parseConfirmation } from './types.js'
import type { FlowResult, BookingFlowContext } from './types.js'
import type { CustomerIntentOutput } from '../../adapters/llm/types.js'
import type { TranscriptTurn } from '../../adapters/llm/types.js'
import type { HydratedContext } from '../session/hydration.js'
import { checkOwnerEscalationRules, escalateToPlatform } from '../escalation/engine.js'
import type { BusinessKnowledge } from '../../shared/skill-types.js'

type CustomerMemoryInput = {
  returningCustomer: boolean
  preferredServiceName: string | null
  displayName: string | null
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

function checkDSTGap(isoString: string, businessTz: string): boolean {
  const date = new Date(isoString)
  // Detect DST gap: format back to local and parse — if hour shifts > 0 we hit a gap
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: businessTz, hour: 'numeric', minute: 'numeric', hour12: false,
  }).formatToParts(date)
  const h = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10)
  const m = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10)
  // Also parse from the original ISO to get requested local hour
  const requestedH = parseInt(isoString.slice(11, 13), 10)
  const requestedM = parseInt(isoString.slice(14, 16), 10)
  // If diff > 30min (DST is typically 1h), flag it
  return Math.abs((h * 60 + m) - (requestedH * 60 + requestedM)) > 30
}

function extractMemory(ctx: BookingFlowContext): CustomerMemoryInput {
  const hydrated = ctx as unknown as Partial<HydratedContext>
  if (!hydrated.customerMemory && !hydrated.returningCustomer) return null
  return {
    returningCustomer: hydrated.returningCustomer ?? false,
    preferredServiceName: hydrated.preferredServiceName ?? null,
    displayName: hydrated.customerMemory?.displayName ?? null,
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

  // ── REBOOK shortcut — treat as fresh booking intent (B5: includes Hebrew variants) ──
  const rebookVariants = /^(rebook|re-book|תיאום מחדש|קביעת תור מחדש|לקבוע מחדש|להזמין מחדש)$/i
  if (rebookVariants.test(messageText.trim())) {
    await updateSessionContext(db, session.id, { ...ctx, detectedLanguage: lang }, 'active')
    const reply = await generateCustomerReply({
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
    return handleCancellationConfirmation(db, calendar, identity, session, ctx, messageText, businessName, transcript)
  }

  // ── Branch: waiting for clarification on vague slot ──────────────────────
  if (session.state === 'waiting_clarification') {
    return handleClarification(db, calendar, identity, session, ctx, messageText, businessTimezone, businessName, transcript)
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

  // Persist language detection into context so all subsequent branches use it
  const updatedCtx: BookingFlowContext = {
    ...ctx,
    detectedLanguage,
    ...(shouldOfferSwitch ? { languageSwitchOfferPending: true } : {}),
  }

  // Prefix injected into situation strings for first-message targeted intents
  const firstMsgPrefix = isFirstMessage
    ? 'This is the customer\'s first message — include a brief warm greeting before addressing their request. '
    : ''

  const intentResult2 = await (async (): Promise<FlowResult> => {
    switch (intent.intent) {
      case 'booking':
        return handleBookingIntent(db, calendar, identity, session, updatedCtx, intent, activeServices, businessTimezone, businessName, transcript, firstMsgPrefix)

      case 'rescheduling':
        return handleReschedulingIntent(db, calendar, identity, session, updatedCtx, intent, activeServices, businessTimezone, businessName, transcript)

      case 'cancellation':
        return handleCancellationIntent(db, calendar, identity, session, updatedCtx, businessTimezone, businessName, transcript)

      case 'list_bookings':
        return handleListBookings(db, identity, session, updatedCtx, businessTimezone, businessName, transcript)

      case 'inquiry': {
        await completeSession(db, session.id)
        const serviceDescriptions = activeServices.map((s) => {
          const type = s.maxParticipants > 1 ? `group class, ${s.maxParticipants} spots` : 'private'
          const price = businessKnowledge?.services.find((ks) => ks.id === s.id)?.price
          const priceStr = price != null ? `, ${price} ${businessKnowledge?.services.find((ks) => ks.id === s.id)?.currency ?? ''}` : ''
          return `${s.name} (${s.durationMinutes} min, ${type}${priceStr})`
        }).join('; ')
        const situation = activeServices.length > 0
          ? `${firstMsgPrefix}Customer asked a question about the business or services. Services available: ${serviceDescriptions}. Answer their specific question using the FAQs and service info above if relevant, then invite them to book.`
          : `${firstMsgPrefix}Customer asked about the business. No services are configured yet. Direct them to contact the business directly.`
        const knowledgeFields = businessKnowledge ? {
          brandVoice: businessKnowledge.brandVoice,
          ...(businessKnowledge.communicationStyle ? { communicationStyle: businessKnowledge.communicationStyle } : {}),
          faqs: businessKnowledge.faqs,
        } : {}
        const inquiryReply = await generateCustomerReply({
          businessName,
          language: detectedLanguage,
          situation,
          transcript,
          customerMemory: extractMemory(updatedCtx),
          ...knowledgeFields,
        })
        return { reply: inquiryReply, sessionComplete: true }
      }

      default: {
        const unknownCount = ((updatedCtx.sessionUnknownCount as number | undefined) ?? 0) + 1
        const ctxWithCount: BookingFlowContext = { ...updatedCtx, sessionUnknownCount: unknownCount }

        if (unknownCount >= 2 && business) {
          await escalateToPlatform(db, business, identity.phoneNumber, messageText)
        }

        await updateSessionContext(db, session.id, ctxWithCount)

        const hasFaqs = (businessKnowledge?.faqs?.length ?? 0) > 0
        // First-message generic/ambiguous: welcome + introduce the PA
        const unknownSituation = isFirstMessage
          ? `This is the customer's first message and it is unclear or generic. Welcome them warmly, introduce yourself as the booking assistant for ${businessName}, briefly explain what you can help with (booking, cancellations, rescheduling${hasFaqs ? ', and questions about the business' : ''}), and ask how you can help.`
          : hasFaqs
            ? `Customer sent a message the system couldn't classify as booking, cancellation, or rescheduling. Their message: "${messageText}". Check the FAQs above — if one is relevant, answer it directly. If not, politely explain the assistant handles bookings and invite them to ask about that.`
            : 'Message intent is unknown. Explain the assistant handles booking, cancellation, rescheduling, and service inquiries only. They can also ask "what are my bookings?" to see upcoming appointments.'

        const unknownKnowledgeFields = businessKnowledge ? {
          brandVoice: businessKnowledge.brandVoice,
          ...(businessKnowledge.communicationStyle ? { communicationStyle: businessKnowledge.communicationStyle } : {}),
          faqs: businessKnowledge.faqs,
        } : {}
        const unknownReply = await generateCustomerReply({
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
      ? '\n\nWould you like me to continue in English? (YES / NO)'
      : '\n\nרוצה שאמשיך בעברית? (כן / לא)'
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
): Promise<FlowResult> {
  const lang = ctx.detectedLanguage ?? 'en'
  const slot = intent.slotRequest

  // Max clarification attempts guard — prevent infinite loops
  const attempts = (ctx.clarificationAttempts as number | undefined) ?? 0
  if (attempts >= 3 && (!slot || !slot.hasSpecificDate || !slot.hasSpecificTime || !slot.resolvedStart)) {
    await failSession(db, session.id)
    const reply = await generateCustomerReply({
      businessName,
      language: lang,
      situation: 'Customer has failed to provide a valid booking date/time after 3 attempts. Apologize, end the conversation gracefully, and ask them to call the business directly.',
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: true, sessionFailed: true }
  }

  // Vague slot — ask for clarification
  if (!slot || !slot.hasSpecificDate || !slot.hasSpecificTime || !slot.resolvedStart) {
    const missing = !slot?.hasSpecificDate ? 'date' : 'time'
    const newAttempts = attempts + 1
    await updateSessionContext(db, session.id, { ...ctx, clarificationAttempts: newAttempts }, 'waiting_clarification')
    const reply = await generateCustomerReply({
      businessName,
      language: lang,
      situation: `Booking intent detected but the ${missing} is missing or vague. Ask for a specific ${missing}.`,
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: false }
  }

  // Resolve service type
  const service = resolveService(intent.serviceTypeHint, activeServices)
  if (!service) {
    await updateSessionContext(db, session.id, { ...ctx, clarificationAttempts: attempts + 1 }, 'waiting_clarification')
    const list = activeServices.map((s) => s.name).join(', ')
    const reply = await generateCustomerReply({
      businessName,
      language: lang,
      situation: `Customer wants to book but did not specify a service. Available services: ${list}. Ask which one they want.`,
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: false }
  }

  const slotStart = new Date(slot.resolvedStart)
  const slotEnd = slot.resolvedEnd
    ? new Date(slot.resolvedEnd)
    : new Date(slotStart.getTime() + service.durationMinutes * 60 * 1000)

  if (isNaN(slotStart.getTime())) {
    await updateSessionContext(db, session.id, { ...ctx, clarificationAttempts: attempts + 1 }, 'waiting_clarification')
    const reply = await generateCustomerReply({
      businessName,
      language: lang,
      situation: "Could not parse the date or time the customer provided. Ask them to try again with a specific date and time, e.g. 'Tuesday 3 May at 3pm'.",
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: false }
  }

  // DST gap check — if stored UTC formats back to a different hour in business TZ, the slot fell in a DST gap
  if (checkDSTGap(slot.resolvedStart, businessTimezone)) {
    await updateSessionContext(db, session.id, { ...ctx, clarificationAttempts: attempts + 1 }, 'waiting_clarification')
    const reply = await generateCustomerReply({
      businessName,
      language: lang,
      situation: 'The requested time falls in a daylight saving time transition gap and does not exist on the clock. Ask the customer to choose a different time.',
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: false }
  }

  const displayDate = formatSlotDate(slotStart, businessTimezone)
  const displayTime = formatSlotTime(slotStart, businessTimezone)
  const summary = intent.summary ?? `${service.name} on ${displayDate} at ${displayTime}`

  const newCtx: BookingFlowContext = {
    ...ctx,
    clarificationAttempts: 0,
    pendingSlot: {
      start: slotStart.toISOString(),
      end: slotEnd.toISOString(),
      serviceTypeId: service.id,
      serviceName: service.name,
      providerHint: intent.providerHint ?? null,
    },
    awaitingConfirmationFor: 'hold',
  }

  await updateSessionContext(db, session.id, newCtx, 'waiting_confirmation')
  const reply = await generateCustomerReply({
    businessName,
    language: lang,
    situation: `${firstMsgPrefix}Customer wants to book: ${summary}. Ask them to confirm (YES) or decline (NO).`,
    transcript,
    customerMemory: extractMemory(ctx),
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
    return handleBookingIntent(db, calendar, identity, session, ctx, intent, activeServices, businessTimezone, businessName, transcript)
  }

  if (activeBookings.length > 1) {
    return enterCancellationSelection(db, session, ctx, activeBookings, businessTimezone, businessName, transcript, lang, true)
  }

  const existing = activeBookings[0]!
  const cancelResult = await cancelBooking(db, calendar, identity, existing.id, 'Rescheduled by customer via WhatsApp')
  if (!cancelResult.ok) {
    const reply = await generateCustomerReply({
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
  return handleBookingIntent(db, calendar, identity, session, newCtx, intent, activeServices, businessTimezone, businessName, transcript)
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
      businessName,
      language: lang,
      situation: 'Customer sent an unclear reply. Ask them again to reply YES to confirm the booking or NO to cancel.',
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: false }
  }

  if (confirmation === 'no') {
    await completeSession(db, session.id)
    const reply = await generateCustomerReply({
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
    const unavailSituation = [
      `The requested slot is unavailable because ${sanitiseReason(result.reason)}.`,
      hoursSummary ?? '',
      'Suggest the customer pick a different time that falls within business hours.',
    ].filter(Boolean).join(' ')
    const reply = await generateCustomerReply({
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
      businessName,
      language: lang,
      situation: `Spot confirmed in ${pendingSlot.serviceName} class on ${confirmedDate} at ${confirmedTime}. ${result.message}`,
      transcript,
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: true }
  }

  // Private session — hold placed, ask for final YES to confirm
  const newCtx: BookingFlowContext = {
    ...ctx,
    pendingBookingId: result.bookingId,
    awaitingConfirmationFor: 'hold',
  }
  await updateSessionContext(db, session.id, newCtx, 'waiting_confirmation')

  const heldDate = formatSlotDate(new Date(pendingSlot.start), businessTimezone)
  const heldTime = formatSlotTime(new Date(pendingSlot.start), businessTimezone)
  const reply = await generateCustomerReply({
    businessName,
    language: lang,
    situation: `Slot successfully held for ${pendingSlot.serviceName} on ${heldDate} at ${heldTime}. Ask customer to reply YES to finalize and confirm the booking.`,
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
    mergedCtx, intentResult.data, activeServices, businessTimezone, businessName, transcript,
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
      businessName,
      language: lang,
      situation: `Customer wants to cancel their booking on ${date}. Ask YES to confirm cancellation or NO to keep it.`,
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
    businessName,
    language: lang,
    situation: `Customer wants to ${action} but has ${activeBookings.length} active bookings. List them numbered and ask which number to ${action}: ${numberedList}`,
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
      businessName,
      language: lang,
      situation: `Customer sent an invalid selection. Ask them to reply with a number between 1 and ${candidates.length}.`,
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
    businessName,
    language: lang,
    situation: `Customer selected booking #${n} to cancel. Ask them to confirm (YES) to cancel it or NO to keep it.`,
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
  businessName: string,
  transcript: TranscriptTurn[],
): Promise<FlowResult> {
  const lang = ctx.detectedLanguage ?? 'en'
  const confirmation = parseConfirmation(messageText)

  if (confirmation === 'unclear') {
    const reply = await generateCustomerReply({
      businessName,
      language: lang,
      situation: 'Customer sent an unclear reply. Ask them again to reply YES to confirm cancellation or NO to keep the booking.',
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: false }
  }

  if (confirmation === 'no') {
    await completeSession(db, session.id)
    const reply = await generateCustomerReply({
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

  await completeSession(db, session.id)

  if (upcoming.length === 0) {
    const reply = await generateCustomerReply({
      businessName,
      language: lang,
      situation: 'Customer asked for their bookings. They have no upcoming confirmed or held bookings.',
      transcript,
      ...(ctx.botPersona ? { botPersona: ctx.botPersona } : {}),
      customerMemory: extractMemory(ctx),
    })
    return { reply, sessionComplete: true }
  }

  const list = upcoming
    .map((b, i) => `${i + 1}. ${formatSlotDate(b.slotStart, businessTimezone)} at ${formatSlotTime(b.slotStart, businessTimezone)} (${b.state})`)
    .join('; ')

  const reply = await generateCustomerReply({
    businessName,
    language: lang,
    situation: `Customer asked for their upcoming bookings. List them: ${list}`,
    transcript,
    customerMemory: extractMemory(ctx),
  })
  return { reply, sessionComplete: true }
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
