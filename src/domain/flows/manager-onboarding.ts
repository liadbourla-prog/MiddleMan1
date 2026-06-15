import { eq, and } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import type { Db } from '../../db/client.js'
import { businesses, importTokens, managerInstructions, serviceTypes, availability } from '../../db/schema.js'
import type { Business, OnboardingStep, EscalationRule } from '../../db/schema.js'
import type { InboundMessage } from '../../adapters/whatsapp/types.js'
import type { ResolvedIdentity } from '../identity/types.js'
import { classifyManagerInstruction, generateOnboardingReply, generateManagerCommandReply, parseOnboardingAnswer, parseBusinessName, parseOnboardingServices, parseOnboardingHours, parseCalendarChoice, parseImportChoice, type OnboardingHourEntry } from '../../adapters/llm/client.js'
import { applyInstruction } from '../manager/apply.js'
import { getPrompt, getRetryPrompt, isAffirmative, isNegative } from '../onboarding/steps.js'
import { i18n, t, type Lang } from '../i18n/t.js'
import { createWorkflow } from '../skills/workflow-helpers.js'

export interface OnboardingResult {
  reply: string
}

export async function handleOnboardingMessage(
  db: Db,
  msg: InboundMessage,
  identity: ResolvedIdentity,
  business: Business,
  baseUrl: string,
  log: FastifyBaseLogger,
): Promise<OnboardingResult> {
  const step = (business.onboardingStep ?? 'business_name') as OnboardingStep
  const lang: Lang = (business.defaultLanguage as Lang | null | undefined) ?? 'he'

  switch (step) {
    case 'business_name':
      return handleBusinessNameStep(db, msg, business, lang, log)
    case 'services':
      return handleServiceStep(db, msg, identity, business, lang, log)
    case 'hours':
      return handleHoursStep(db, msg, identity, business, lang, log)
    case 'cancellation_policy':
      return handleCancellationPolicyStep(db, msg, business, lang, log)
    case 'payment':
      return handlePaymentStep(db, msg, business, lang, log)
    case 'escalation_policy':
      return handleEscalationPolicyStep(db, msg, business, baseUrl, lang, log)
    case 'calendar':
      return handleCalendarStepWithBody(db, business, baseUrl, msg.body, lang)
    case 'customer_import':
      return handleCustomerImportStep(db, msg, business, baseUrl, lang, log)
    case 'verify':
      return handleVerifyStep(db, msg, identity, business, lang, log)
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildCalendarLink(business: Business, baseUrl: string): string {
  const base = baseUrl || process.env['PUBLIC_BASE_URL'] || 'https://your-domain.com'
  return `${base}/oauth/google?businessId=${business.id}`
}

async function onboardingQuestion(
  step: string,
  businessName: string,
  lang: Lang,
  opts: { justConfirmed?: string; collectedSummary?: string; isRetry?: boolean; extraContext?: string } = {},
): Promise<string> {
  const q = await generateOnboardingReply({
    step,
    businessName,
    lang,
    isRetry: opts.isRetry ?? false,
    ...(opts.justConfirmed !== undefined ? { justConfirmed: opts.justConfirmed } : {}),
    ...(opts.collectedSummary !== undefined ? { collectedSummary: opts.collectedSummary } : {}),
    ...(opts.extraContext !== undefined ? { extraContext: opts.extraContext } : {}),
  })
  return q || getPrompt(step as OnboardingStep, lang)
}

// The manager replied with something that is NOT an answer to the current step —
// a counter-question, a refusal/deferral, or confusion. Acknowledge it and re-ask
// in plain language instead of either silently advancing with a fabricated value
// or repeating the identical prompt verbatim.
async function notAnswerReply(
  step: string,
  businessName: string,
  lang: Lang,
  guidance: string,
): Promise<OnboardingResult> {
  return { reply: await onboardingQuestion(step, businessName, lang, { isRetry: true, extraContext: guidance }) }
}

// ── Step handlers ─────────────────────────────────────────────────────────────

async function handleBusinessNameStep(
  db: Db,
  msg: InboundMessage,
  business: Business,
  lang: Lang,
  log: FastifyBaseLogger,
): Promise<OnboardingResult> {
  const parsed = await parseBusinessName(msg.body, lang)
  const displayName = parsed.ok && parsed.data.isBusinessName && parsed.data.name?.trim()
    ? parsed.data.name.trim().slice(0, 100)
    : null

  if (!displayName) {
    // Not a name — a greeting, question, or confusion. Re-ask instead of storing it.
    log.info({ businessId: business.id }, 'Onboarding: business_name input was not a name, re-prompting')
    const retryQ = await onboardingQuestion('business_name', business.name ?? '', lang, {
      isRetry: true,
      extraContext: 'The manager replied with a greeting or question instead of a business name. Briefly reassure them (yes, you are set up and listening), then ask again for the name customers should see.',
    })
    return { reply: retryQ }
  }

  await db
    .update(businesses)
    .set({ name: displayName, onboardingStep: 'services' })
    .where(eq(businesses.id, business.id))
  log.info({ businessId: business.id, displayName }, 'Onboarding: business name set')

  const nextQ = await onboardingQuestion('services', displayName, lang, {
    justConfirmed: displayName,
  })
  return { reply: nextQ }
}

async function handleServiceStep(
  db: Db,
  msg: InboundMessage,
  identity: ResolvedIdentity,
  business: Business,
  lang: Lang,
  log: FastifyBaseLogger,
): Promise<OnboardingResult> {
  const retryPrompt = await onboardingQuestion('services', business.name, lang, { isRetry: true })

  // The manager may list several services in one message. Parse them all, then
  // apply each through the deterministic core (applyInstruction → applyServiceChange).
  const parsed = await parseOnboardingServices(msg.body, lang)
  if (parsed.ok && parsed.data.understood === false) {
    // A counter-question or confusion rather than a service list. Explain instead
    // of repeating the same prompt.
    return notAnswerReply('services', business.name, lang,
      'The manager did not list any services — they asked a question or seem unsure what counts. In one or two sentences explain that a service is anything a customer can book (e.g. a haircut, a 60-minute yoga class, a consultation), that they can list several at once with rough durations, then ask again what they offer.')
  }
  if (!parsed.ok || !parsed.data.understood || parsed.data.services.length === 0) {
    return { reply: retryPrompt }
  }

  const created: string[] = []
  for (const svc of parsed.data.services) {
    const params = {
      action: 'create' as const,
      name: svc.name,
      durationMinutes: svc.durationMinutes,
      maxParticipants: svc.maxParticipants ?? 1,
      paymentAmount: svc.paymentAmount,
      requiresPayment: svc.paymentAmount != null && svc.paymentAmount > 0,
      category: svc.category,
    }

    const [saved] = await db
      .insert(managerInstructions)
      .values({
        businessId: business.id,
        identityId: identity.id,
        rawMessage: msg.body,
        receivedAt: msg.timestamp,
        classifiedAs: 'service_change',
        structuredOutput: { instructionType: 'service_change', structuredParams: params } as unknown as Record<string, unknown>,
        applyStatus: 'pending',
      })
      .returning({ id: managerInstructions.id })

    if (!saved) continue

    const applyResult = await applyInstruction(
      db, saved.id, business.id, identity.id, 'service_change', params, lang,
    )
    if (applyResult.ok) created.push(svc.name)
    else log.warn({ businessId: business.id, service: svc.name, reason: applyResult.reason }, 'Onboarding: service create failed')
  }

  if (created.length === 0) {
    return { reply: retryPrompt }
  }

  await db.update(businesses).set({ onboardingStep: 'hours' }).where(eq(businesses.id, business.id))
  log.info({ businessId: business.id, count: created.length }, 'Onboarding: services step complete')

  const confirmation = lang === 'he'
    ? `נוספו השירותים: ${created.join(', ')}`
    : `Added: ${created.join(', ')}`
  const nextQ = await onboardingQuestion('hours', business.name, lang, {
    justConfirmed: confirmation,
  })
  return { reply: nextQ }
}

async function handleHoursStep(
  db: Db,
  msg: InboundMessage,
  identity: ResolvedIdentity,
  business: Business,
  lang: Lang,
  log: FastifyBaseLogger,
): Promise<OnboardingResult> {
  const body = msg.body.trim().toLowerCase()
  const is247 = body === '24/7' || body === 'always open' || body === 'always' || body.includes('24/7')
    || body.includes('תמיד פתוח') || body.includes('פתוח כל הזמן') || body === 'תמיד'
    || body.includes('24 שעות') || body.includes('פתוח 24')

  if (is247) {
    await db.update(businesses)
      .set({ onboardingStep: 'cancellation_policy', available247: true })
      .where(eq(businesses.id, business.id))
    log.info({ businessId: business.id }, 'Onboarding: hours step complete (24/7)')
    const nextQ = await onboardingQuestion('cancellation_policy', business.name, lang, {
      justConfirmed: lang === 'he' ? '24/7' : '24/7',
    })
    return { reply: nextQ }
  }

  const retryPrompt = await onboardingQuestion('hours', business.name, lang, { isRetry: true })

  // A weekly schedule spans several days; the single-day availability_change
  // schema can't hold it. Parse the whole week, then apply set_hours per day.
  const parsed = await parseOnboardingHours(msg.body, lang)

  if (parsed.ok && parsed.data.understood && parsed.data.always247) {
    await db.update(businesses)
      .set({ onboardingStep: 'cancellation_policy', available247: true })
      .where(eq(businesses.id, business.id))
    log.info({ businessId: business.id }, 'Onboarding: hours step complete (24/7 via parser)')
    const nextQ = await onboardingQuestion('cancellation_policy', business.name, lang, { justConfirmed: '24/7' })
    return { reply: nextQ }
  }

  if (parsed.ok && parsed.data.understood === false) {
    // Comprehension miss — a counter-question, confusion, or "by appointment only"
    // with no concrete hours. Explain rather than repeating the same prompt.
    return notAnswerReply('hours', business.name, lang,
      'The manager did not give usable opening hours — they asked a question, expressed confusion, or said something like "by appointment only" / "flexible". In one or two sentences explain that the PA needs general weekly hours to know when customers may book (e.g. "Sun–Thu 9:00–18:00"), and that they can simply say "24/7" if always available, then ask again. If they work strictly by appointment with no fixed hours, ask for the broad window they are typically reachable.')
  }

  if (!parsed.ok || !parsed.data.understood || parsed.data.days.length === 0) {
    return { reply: retryPrompt }
  }

  const appliedDays: OnboardingHourEntry[] = []
  for (const day of parsed.data.days) {
    const params = {
      action: 'set_hours' as const,
      dayOfWeek: day.dayOfWeek,
      openTime: day.openTime,
      closeTime: day.closeTime,
    }

    const [saved] = await db
      .insert(managerInstructions)
      .values({
        businessId: business.id,
        identityId: identity.id,
        rawMessage: msg.body,
        receivedAt: msg.timestamp,
        classifiedAs: 'availability_change',
        structuredOutput: { instructionType: 'availability_change', structuredParams: params } as unknown as Record<string, unknown>,
        applyStatus: 'pending',
      })
      .returning({ id: managerInstructions.id })

    if (!saved) continue

    const applyResult = await applyInstruction(
      db, saved.id, business.id, identity.id, 'availability_change', params, lang,
    )
    if (applyResult.ok) appliedDays.push(day)
    else log.warn({ businessId: business.id, dayOfWeek: day.dayOfWeek, reason: applyResult.reason }, 'Onboarding: set_hours failed')
  }

  if (appliedDays.length === 0) {
    return { reply: retryPrompt }
  }

  await db.update(businesses)
    .set({ onboardingStep: 'cancellation_policy', available247: false })
    .where(eq(businesses.id, business.id))
  log.info({ businessId: business.id, days: appliedDays.length }, 'Onboarding: hours step complete')

  const dayNames = lang === 'he'
    ? ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']
    : ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const hoursSummary = appliedDays
    .sort((a, b) => a.dayOfWeek - b.dayOfWeek)
    .map((d) => `${dayNames[d.dayOfWeek]} ${d.openTime}–${d.closeTime}`)
    .join(', ')
  const confirmation = lang === 'he' ? `שעות הפעילות נשמרו: ${hoursSummary}` : `Hours saved: ${hoursSummary}`
  const nextQ = await onboardingQuestion('cancellation_policy', business.name, lang, {
    justConfirmed: confirmation,
  })
  return { reply: nextQ }
}

async function handleCancellationPolicyStep(
  db: Db,
  msg: InboundMessage,
  business: Business,
  lang: Lang,
  log: FastifyBaseLogger,
): Promise<OnboardingResult> {
  const body = msg.body.trim()

  // Try LLM extraction first, fall back to plain integer parse
  let hours: number | null = null
  const parsed = await parseOnboardingAnswer('cancellation_policy', body, lang)
  if (parsed.ok && parsed.data.step === 'cancellation_policy') {
    if (!parsed.data.isAnswer) {
      // Counter-question / confusion / deferral — don't fabricate a cutoff.
      return notAnswerReply('cancellation_policy', business.name, lang,
        'The manager did not answer the cancellation-cutoff question — they asked what it means, expressed confusion, or deferred. In one or two sentences explain plainly that this is the latest a customer can cancel before their appointment without penalty (e.g. "up to 2 hours before"), then ask again. Note they can say "any time" if they allow cancellations with no restriction.')
    }
    hours = parsed.data.hours
  } else {
    const n = parseInt(body.replace(/\D/g, ''), 10)
    if (!isNaN(n) && n >= 0) hours = n
  }

  if (hours === null) {
    const retryQ = await onboardingQuestion('cancellation_policy', business.name, lang, { isRetry: true })
    return { reply: retryQ }
  }

  await db.update(businesses)
    .set({ onboardingStep: 'payment', cancellationCutoffMinutes: hours * 60 })
    .where(eq(businesses.id, business.id))
  log.info({ businessId: business.id, hours }, 'Onboarding: cancellation policy set')

  const confirmation = hours === 0
    ? i18n.ob_cancellation_confirm_none[lang]
    : i18n.ob_cancellation_confirm[lang](hours)

  const nextQ = await onboardingQuestion('payment', business.name, lang, {
    justConfirmed: confirmation,
  })
  return { reply: nextQ }
}

async function handlePaymentStep(
  db: Db,
  msg: InboundMessage,
  business: Business,
  lang: Lang,
  log: FastifyBaseLogger,
): Promise<OnboardingResult> {
  const body = msg.body.trim()

  // Sub-step: waiting for payment method after "yes" without method
  if (business.paymentMethod === 'pending' || (business.confirmationGate === 'post_payment' && !business.paymentMethod?.trim())) {
    const parsedMethod = await parseOnboardingAnswer('payment', body, lang)
    const p = parsedMethod.ok && parsedMethod.data.step === 'payment' ? parsedMethod.data : null

    // Reversal: "actually, no prepayment needed" — switch to immediate gate.
    if (p?.isAnswer && p.requiresPayment === false) {
      await db.update(businesses)
        .set({ onboardingStep: 'escalation_policy', confirmationGate: 'immediate', paymentMethod: null })
        .where(eq(businesses.id, business.id))
      log.info({ businessId: business.id }, 'Onboarding: payment gate reversed to immediate at method sub-step')
      const nextQ = await onboardingQuestion('escalation_policy', business.name, lang, {
        justConfirmed: i18n.ob_payment_immediate[lang],
      })
      return { reply: nextQ }
    }

    // A counter-question / confusion with no extractable method — re-ask instead
    // of storing the question text verbatim as the payment method.
    if (p && !p.isAnswer && !p.paymentMethod) {
      return notAnswerReply('payment_method', business.name, lang,
        'The manager was asked which payment method they accept but replied with a question or unclear text rather than a method. Briefly answer or clarify, then ask again which method they accept, listing examples (bank transfer, Bit, credit card, cash).')
    }

    const method = (p?.paymentMethod ?? body.trim()).slice(0, 100)
    await db.update(businesses)
      .set({ onboardingStep: 'escalation_policy', paymentMethod: method })
      .where(eq(businesses.id, business.id))
    log.info({ businessId: business.id, method }, 'Onboarding: payment method set (sub-step)')
    const nextQ = await onboardingQuestion('escalation_policy', business.name, lang, {
      justConfirmed: i18n.ob_payment_method_confirm[lang](method),
    })
    return { reply: nextQ }
  }

  // First message: try LLM to extract both requiresPayment + method in one shot
  let requiresPayment: boolean | null = null
  let paymentMethod: string | null = null

  const parsed = await parseOnboardingAnswer('payment', body, lang)
  if (parsed.ok && parsed.data.step === 'payment') {
    if (!parsed.data.isAnswer) {
      // Counter-question / confusion / deferral — don't fabricate a payment gate.
      return notAnswerReply('payment', business.name, lang,
        'The manager did not answer the prepayment question — they asked a question back, expressed confusion, or deferred. In one or two sentences explain plainly that this is about whether a customer must pay before their booking is confirmed (vs. confirming immediately and paying later/in person), then ask again. If they ask which method to use, briefly mention common options (Bit, bank transfer, credit card, cash) but still ask whether prepayment is required.')
    }
    requiresPayment = parsed.data.requiresPayment
    paymentMethod = parsed.data.paymentMethod
  } else {
    // Fallback: simple keyword detection
    if (isNegative(body)) requiresPayment = false
    else if (isAffirmative(body)) requiresPayment = true
  }

  if (requiresPayment === null) {
    const retryQ = await onboardingQuestion('payment', business.name, lang, { isRetry: true })
    return { reply: retryQ }
  }

  if (!requiresPayment) {
    await db.update(businesses)
      .set({ onboardingStep: 'escalation_policy', confirmationGate: 'immediate' })
      .where(eq(businesses.id, business.id))
    log.info({ businessId: business.id }, 'Onboarding: payment gate = immediate')
    const nextQ = await onboardingQuestion('escalation_policy', business.name, lang, {
      justConfirmed: i18n.ob_payment_immediate[lang],
    })
    return { reply: nextQ }
  }

  // Requires payment — did they also give us the method in one shot?
  if (paymentMethod) {
    await db.update(businesses)
      .set({ onboardingStep: 'escalation_policy', confirmationGate: 'post_payment', paymentMethod })
      .where(eq(businesses.id, business.id))
    log.info({ businessId: business.id, paymentMethod }, 'Onboarding: payment step complete (one shot)')
    const nextQ = await onboardingQuestion('escalation_policy', business.name, lang, {
      justConfirmed: i18n.ob_payment_method_confirm[lang](paymentMethod),
    })
    return { reply: nextQ }
  }

  // Yes but no method — store sentinel and ask for method
  await db.update(businesses)
    .set({ confirmationGate: 'post_payment', paymentMethod: 'pending' })
    .where(eq(businesses.id, business.id))
  const methodFallback = lang === 'he'
    ? 'מעולה! איזו שיטת תשלום אתם מקבלים? (לדוגמה: העברה בנקאית, ביט, פייבוקס, מזומן)'
    : 'Great! What payment method do you accept? (e.g. bank transfer, PayPal, credit card, cash)'
  const methodQ = await onboardingQuestion('payment_method', business.name, lang)
  return { reply: methodQ || methodFallback }
}

async function handleEscalationPolicyStep(
  db: Db,
  msg: InboundMessage,
  business: Business,
  baseUrl: string,
  lang: Lang,
  log: FastifyBaseLogger,
): Promise<OnboardingResult> {
  const body = msg.body.trim()

  // Try LLM extraction, fall back to regex
  let rules: EscalationRule[]
  const parsed = await parseOnboardingAnswer('escalation_policy', body, lang)

  if (parsed.ok && parsed.data.step === 'escalation_policy' && !parsed.data.isAnswer) {
    // Not an answer (a counter-question / confusion / deferral) — don't fabricate
    // escalation rules and silently advance. Explain and re-ask.
    return notAnswerReply('escalation_policy', business.name, lang,
      'The manager did not answer the escalation question — they asked what it means, expressed confusion, or deferred. In one or two sentences explain plainly that escalation means handing the conversation to the owner for things the PA should not handle (e.g. complaints, refunds, or anything it does not understand), give a concrete example, then ask again what should trigger a hand-off. You may note they can simply say "only things you don\'t understand" for a minimal setup.')
  }

  if (parsed.ok && parsed.data.step === 'escalation_policy') {
    const d = parsed.data
    const customerMsg = d.customerMessage as EscalationRule['customerMessage']
    const extra = d.customText ? { customText: d.customText } : {}

    rules = d.minimalEscalation
      ? [{ trigger: 'unknown_intent', threshold: 2, customerMessage: customerMsg, ...extra }]
      : [
          ...d.triggers.map((kw) => ({
            trigger: 'keyword' as const,
            value: kw,
            customerMessage: customerMsg,
            ...extra,
          })),
          { trigger: 'unknown_intent' as const, threshold: 2, customerMessage: customerMsg, ...extra },
        ]
  } else {
    rules = parseEscalationPolicyFallback(body)
  }

  await db.update(businesses)
    .set({ onboardingStep: 'calendar', escalationRules: rules as unknown as Record<string, unknown>[] })
    .where(eq(businesses.id, business.id))
  log.info({ businessId: business.id, ruleCount: rules.length }, 'Onboarding: escalation policy set')

  const triggerList = rules
    .filter((r) => r.trigger !== 'unknown_intent')
    .map((r) => r.trigger === 'keyword' ? `"${r.value}"` : r.trigger)
    .join(', ')
  const summary = triggerList.length === 0
    ? i18n.ob_escalation_confirm_none[lang]
    : i18n.ob_escalation_confirm[lang](triggerList)

  // Build real OAuth link for the calendar step question
  const calendarLink = buildCalendarLink(business, baseUrl)
  const calendarTemplate = getPrompt('calendar', lang).replace('{{OAUTH_LINK}}', calendarLink)

  const nextQ = await onboardingQuestion('calendar', business.name, lang, {
    justConfirmed: summary,
    extraContext: `OAuth link for Google Calendar: ${calendarLink}`,
  })

  // Calendar step must include the actual clickable link — append it if LLM didn't include it
  const reply = nextQ.includes(calendarLink)
    ? nextQ
    : `${nextQ}\n\n${calendarLink}`

  return { reply }
}

export async function handleCalendarStepWithBody(
  db: Db,
  business: Business,
  baseUrl: string,
  body: string,
  lang: Lang = 'he',
): Promise<OnboardingResult> {
  const lower = body.trim().toLowerCase()
  let wantsInternal = lower === 'internal' || body.trim() === 'פנימי'

  // The manager replies in free text — detect a "skip Google / work without
  // calendar" intent so we don't loop re-sending the OAuth link forever.
  let choiceKind: 'skip' | 'connect' | 'unclear' | null = null
  if (!wantsInternal) {
    const choice = await parseCalendarChoice(body, lang)
    if (choice.ok) {
      choiceKind = choice.data.choice
      if (choiceKind === 'skip') wantsInternal = true
    }
  }

  if (wantsInternal) {
    await db.update(businesses)
      .set({ onboardingStep: 'customer_import', calendarMode: 'internal' })
      .where(eq(businesses.id, business.id))
    const nextQ = await onboardingQuestion('customer_import', business.name, lang, {
      justConfirmed: i18n.ob_calendar_internal[lang],
    })
    return { reply: nextQ }
  }

  // Step advances via OAuth callback — resend the link with real URL.
  // When the reply was a question/confusion (unclear), address it instead of
  // re-pushing a bare "click the link".
  const calendarLink = buildCalendarLink(business, baseUrl)
  const calWaitFallback = i18n.ob_calendar_waiting[lang](calendarLink)
  const calWaitContext = choiceKind === 'unclear'
    ? `The manager replied with a question or confusion about connecting Google Calendar rather than connecting or declining. In one or two sentences reassure them: the link is a standard Google sign-in that lets the PA read and sync their calendar so bookings never clash, it is safe and they can disconnect any time, and they can instead choose to work without Google on the internal calendar if they prefer (they can just say so). Then share the link on its own line. The OAuth link is: ${calendarLink}`
    : `The business has not connected Google Calendar yet. Remind them the link is waiting and they need to click it. The OAuth link is: ${calendarLink}`
  const calWaitQ = await generateOnboardingReply({
    step: 'calendar',
    businessName: business.name,
    lang,
    isRetry: false,
    extraContext: calWaitContext,
  })
  const calWaitReply = calWaitQ || calWaitFallback
  const calWaitWithUrl = calWaitReply.includes(calendarLink) ? calWaitReply : `${calWaitReply}\n${calendarLink}`
  return { reply: calWaitWithUrl }
}

async function handleCustomerImportStep(
  db: Db,
  msg: InboundMessage,
  business: Business,
  baseUrl: string,
  lang: Lang,
  log: FastifyBaseLogger,
): Promise<OnboardingResult> {
  const choiceResult = await parseImportChoice(msg.body, lang)
  const choice = choiceResult.ok ? choiceResult.data.choice : 'unclear'

  if (choice === 'import') {
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000)
    const [token] = await db
      .insert(importTokens)
      .values({ businessId: business.id, managerPhone: msg.fromNumber, expiresAt })
      .returning({ token: importTokens.token })

    log.info({ businessId: business.id }, 'Onboarding: import token generated')
    const uploadUrl = `${baseUrl}/import/${token!.token}`
    const importLinkFallback = i18n.ob_import_link[lang](uploadUrl)
    const importLinkQ = await generateOnboardingReply({
      step: 'customer_import',
      businessName: business.name,
      lang,
      isRetry: false,
      extraContext: `Manager agreed to import. The secure upload link (valid 30 min) is: ${uploadUrl}. It MUST appear on its own line in the reply. Accepted formats: CSV of contacts (name, phone), booking history (name, phone, date, service), or service catalog (name, duration_minutes, price).`,
    })
    const importLinkReply = importLinkQ || importLinkFallback
    const importLinkWithUrl = importLinkReply.includes(uploadUrl) ? importLinkReply : `${importLinkReply}\n${uploadUrl}`
    return { reply: importLinkWithUrl }
  }

  // A question or confusion ("what format?") — explain and re-ask, stay on this
  // step. Never read as a decline (the old isNegative gate trapped the manager
  // here on any natural phrasing).
  if (choice === 'unclear') {
    return notAnswerReply('customer_import', business.name, lang,
      'The manager neither clearly accepted nor declined importing their existing customers — they asked a question or seem unsure. In one or two sentences explain that you can bulk-import their existing customer list or booking history from a CSV/Excel file so people are recognized from day one, that it is optional, then ask again whether they want to import now or skip. If they asked about the file format, mention it accepts a contacts CSV (name, phone) or booking history (name, phone, date, service).')
  }

  // choice === 'skip' — they have no list or want to move on.
  await db.update(businesses).set({ onboardingStep: 'verify' }).where(eq(businesses.id, business.id))
  log.info({ businessId: business.id }, 'Onboarding: customer import skipped')
  const summary = await buildVerifySummary(db, business, lang)
  const importSkipFallback = `${i18n.ob_import_skip[lang]}\n\n${summary}`
  const importSkipQ = await generateOnboardingReply({
    step: 'verify',
    businessName: business.name,
    lang,
    isRetry: false,
    justConfirmed: lang === 'he' ? 'דילגו על הייבוא' : 'Skipped import',
    extraContext: `Here is the full setup summary to show the manager:\n${summary}`,
  })
  const importSkipReply = importSkipQ || importSkipFallback
  return { reply: importSkipReply }
}

async function handleVerifyStep(
  db: Db,
  msg: InboundMessage,
  identity: ResolvedIdentity,
  business: Business,
  lang: Lang,
  log: FastifyBaseLogger,
): Promise<OnboardingResult> {
  const body = msg.body.trim()

  if (body.toUpperCase() === 'GO') {
    await db
      .update(businesses)
      .set({ onboardingCompletedAt: new Date(), onboardingStep: null })
      .where(eq(businesses.id, business.id))
    log.info({ businessId: business.id }, 'Onboarding: complete via GO')

    await createWorkflow(db, business.id, identity.id, 'business-knowledge-setup', 'brand-voice').catch((err) => {
      log.warn({ err, businessId: business.id }, 'Failed to create business-knowledge-setup workflow after onboarding')
    })

    const completionFallback = i18n.ob_complete[lang](business.whatsappNumber) + (lang === 'he'
      ? `\n\nלפני שהלקוחות מגיעים, בוא נלמד קצת על העסק שלך. איך היית מתאר את *${business.name}* — מה הרגש שאתה רוצה שלקוחות יקבלו?`
      : `\n\nBefore customers arrive, let me learn about your business. How would you describe *${business.name}* — what feeling do you want customers to have?`)
    const completionQ = await generateOnboardingReply({
      step: 'verify',
      businessName: business.name,
      lang,
      isRetry: false,
      justConfirmed: lang === 'he' ? `ה-PA שלכם פעיל! מספר ה-PA: ${business.whatsappNumber}` : `Your PA is now live! PA number: ${business.whatsappNumber}`,
      extraContext: `Setup is complete. Congratulate them warmly, mention their customers can now text ${business.whatsappNumber}, briefly mention STATUS/UPCOMING/PAUSE commands, then transition to asking about their business brand and voice for the knowledge setup.`,
    })
    return { reply: completionQ || completionFallback }
  }

  // Not GO — treat as a correction
  const classifyResult = await classifyManagerInstruction(body, {
    businessId: business.id,
    timezone: business.timezone,
  }, lang)

  if (!classifyResult.ok || classifyResult.data.ambiguous || classifyResult.data.instructionType === 'unknown') {
    // Not a clear change instruction — most often a review/meta question
    // ("did everything save?", "what does GO do?", "is the calendar connected?").
    // Answer it by re-showing the saved setup instead of trying to apply it as a
    // correction (or silently dropping an "unknown" instruction).
    const clarification = classifyResult.ok ? classifyResult.data.clarificationNeeded : null
    const summary = await buildVerifySummary(db, business, lang)
    const reply = await generateOnboardingReply({
      step: 'verify',
      businessName: business.name,
      lang,
      isRetry: false,
      extraContext: `The manager replied with something that is not a clear change instruction — most likely a question about their setup or about what happens next, not a correction. ${clarification ? `If relevant, address this: ${clarification}. ` : ''}Briefly reassure them their setup is saved, then show this summary and ask them to reply GO to launch, or tell you what to change:\n${summary}`,
    })
    return { reply: reply || `${summary}\n\n${t('ob_verify_go_prompt', lang)}` }
  }

  const instruction = classifyResult.data

  const [saved] = await db
    .insert(managerInstructions)
    .values({
      businessId: business.id,
      identityId: identity.id,
      rawMessage: body,
      receivedAt: msg.timestamp,
      classifiedAs: instruction.instructionType as 'availability_change' | 'policy_change' | 'service_change' | 'permission_change' | 'booking_cancellation' | 'unknown',
      structuredOutput: instruction as unknown as Record<string, unknown>,
      applyStatus: 'pending',
    })
    .returning({ id: managerInstructions.id })

  if (!saved) {
    return { reply: t('manager_save_error', lang) }
  }

  const applyResult = await applyInstruction(
    db, saved.id, business.id, identity.id,
    instruction.instructionType,
    instruction.structuredParams as Record<string, unknown>,
    lang,
  )

  if (!applyResult.ok) {
    return { reply: `${applyResult.reason}\n\n${t('ob_verify_go_prompt', lang)}` }
  }

  log.info({ businessId: business.id, type: instruction.instructionType }, 'Onboarding: verify-step correction applied')
  const correctionFallback = `${applyResult.confirmationMessage}\n\n${t('ob_verify_correction_done', lang)}`
  const correctionQ = await generateOnboardingReply({
    step: 'verify',
    businessName: business.name,
    lang,
    isRetry: false,
    justConfirmed: applyResult.confirmationMessage,
    extraContext: 'A correction was applied. Acknowledge it briefly and tell them to reply GO when they are ready to launch, or send another correction.',
  })
  return { reply: correctionQ || correctionFallback }
}

// ── Verify summary builder (exported for import.ts and oauth.ts) ──────────────

export async function buildVerifySummary(db: Db, business: Business, lang: Lang): Promise<string> {
  const services = await db
    .select({ name: serviceTypes.name, durationMinutes: serviceTypes.durationMinutes, maxParticipants: serviceTypes.maxParticipants })
    .from(serviceTypes)
    .where(and(eq(serviceTypes.businessId, business.id), eq(serviceTypes.isActive, true)))

  const minLabel = lang === 'he' ? 'ד׳' : 'min'
  const servicesStr = services.length > 0
    ? services.map((s) => {
        const group = s.maxParticipants > 1 ? ` (×${s.maxParticipants})` : ''
        return `${s.name} ${s.durationMinutes}${minLabel}${group}`
      }).join(', ')
    : (lang === 'he' ? 'לא הוגדרו' : 'None set')

  let hoursStr: string
  if (business.available247) {
    hoursStr = t('ob_verify_hours_247', lang)
  } else {
    const daysHe = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳']
    const daysEn = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const names = lang === 'he' ? daysHe : daysEn
    const regularHours = await db
      .select({ dayOfWeek: availability.dayOfWeek, openTime: availability.openTime, closeTime: availability.closeTime })
      .from(availability)
      .where(and(eq(availability.businessId, business.id), eq(availability.isBlocked, false)))
    const formatted = regularHours
      .filter((r) => r.dayOfWeek !== null && r.openTime && r.closeTime)
      .sort((a, b) => (a.dayOfWeek ?? 0) - (b.dayOfWeek ?? 0))
      .map((r) => `${names[r.dayOfWeek!]} ${r.openTime}–${r.closeTime}`)
    hoursStr = formatted.length > 0 ? formatted.join(', ') : (lang === 'he' ? 'לא הוגדרו' : 'Not configured')
  }

  const cutoffH = business.cancellationCutoffMinutes ? Math.round(business.cancellationCutoffMinutes / 60) : 0
  const cancellationStr = cutoffH === 0
    ? t('ob_verify_cancellation_none', lang)
    : i18n.ob_verify_cancellation_hours[lang](cutoffH)

  const paymentStr = business.confirmationGate === 'post_payment' && business.paymentMethod
    ? i18n.ob_verify_payment_method[lang](business.paymentMethod)
    : t('ob_verify_payment_immediate', lang)

  const rules = (business.escalationRules ?? []) as EscalationRule[]
  const keywordTriggers = rules.filter((r) => r.trigger === 'keyword' && r.value).map((r) => `"${r.value}"`)
  const escalationStr = keywordTriggers.length > 0
    ? keywordTriggers.join(', ')
    : t('ob_verify_escalation_none', lang)

  const calStr = business.calendarMode === 'internal'
    ? t('ob_verify_calendar_internal', lang)
    : t('ob_verify_calendar_google', lang)

  const rawSummary = [
    t('ob_verify_header', lang),
    '',
    `${t('ob_verify_services_label', lang)}: ${servicesStr}`,
    `${t('ob_verify_hours_label', lang)}: ${hoursStr}`,
    `${t('ob_verify_cancellation_label', lang)}: ${cancellationStr}`,
    `${t('ob_verify_payment_label', lang)}: ${paymentStr}`,
    `${t('ob_verify_escalation_label', lang)}: ${escalationStr}`,
    `${t('ob_verify_calendar_label', lang)}: ${calStr}`,
    '',
    t('ob_verify_go_prompt', lang),
  ].join('\n')

  const formattedSummary = await generateManagerCommandReply({
    businessName: business.name,
    language: lang,
    situation: 'Show the manager a summary of their PA setup for review. Ask them to reply GO to launch or tell you what to change.',
    dataBlock: rawSummary,
    fallback: rawSummary,
  })
  return formattedSummary
}

// ── Escalation policy fallback (regex) ────────────────────────────────────────

function parseEscalationPolicyFallback(body: string): EscalationRule[] {
  const lower = body.toLowerCase()
  const rules: EscalationRule[] = []

  let customerMessage: EscalationRule['customerMessage'] = 'passed_to_owner'
  let customText: string | undefined

  if (lower.includes('nothing') || lower.includes('silent') || lower.includes('שקט') || lower.match(/\b1\b/)) {
    customerMessage = 'silent'
  } else if (lower.includes('call') || lower.includes('callback') || lower.includes('יחזור') || lower.match(/\b3\b/)) {
    customerMessage = 'owner_callback'
  } else if (lower.match(/\b4\b/) || lower.includes('custom')) {
    customerMessage = 'custom'
    const quoted = body.match(/"([^"]+)"/)
    customText = quoted?.[1]
  }

  if (lower.includes('only unknown') || lower.includes('minimal') || lower.includes('unrecogniz') || lower.includes('רק בקשות')) {
    rules.push({ trigger: 'unknown_intent', threshold: 2, customerMessage, ...(customText ? { customText } : {}) })
    return rules
  }

  const keywordMatches = body.match(/["']([^"']+)["']|complaints?|refunds?|pricing|price|payment|angry|upset|cancel.*policy|discount|urgent|emergency|תלונות?|החזר|תמחור|כועס/gi)
  if (keywordMatches) {
    for (const kw of keywordMatches) {
      const clean = kw.replace(/['"]/g, '').toLowerCase().trim()
      if (clean.length > 1) {
        rules.push({ trigger: 'keyword', value: clean, customerMessage, ...(customText ? { customText } : {}) })
      }
    }
  }

  rules.push({ trigger: 'unknown_intent', threshold: 2, customerMessage, ...(customText ? { customText } : {}) })
  return rules
}
