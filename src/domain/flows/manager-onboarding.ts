import { eq, and } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import type { Db } from '../../db/client.js'
import { businesses, importTokens, managerInstructions, serviceTypes, availability } from '../../db/schema.js'
import type { Business, OnboardingStep, EscalationRule } from '../../db/schema.js'
import type { InboundMessage } from '../../adapters/whatsapp/types.js'
import type { ResolvedIdentity } from '../identity/types.js'
import { classifyManagerInstruction } from '../../adapters/llm/client.js'
import { applyInstruction } from '../manager/apply.js'
import { getPrompt, getRetryPrompt, isAffirmative, isNegative } from '../onboarding/steps.js'
import { i18n, t, type Lang } from '../i18n/t.js'

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
      return handleEscalationPolicyStep(db, msg, business, lang, log)
    case 'calendar':
      return handleCalendarStepWithBody(db, business, baseUrl, msg.body, lang)
    case 'customer_import':
      return handleCustomerImportStep(db, msg, business, baseUrl, lang, log)
    case 'verify':
      return handleVerifyStep(db, msg, identity, business, lang, log)
  }
}

// ── Step handlers ─────────────────────────────────────────────────────────────

async function handleBusinessNameStep(
  db: Db,
  msg: InboundMessage,
  business: Business,
  lang: Lang,
  log: FastifyBaseLogger,
): Promise<OnboardingResult> {
  const displayName = msg.body.trim().slice(0, 100)
  await db
    .update(businesses)
    .set({ name: displayName, onboardingStep: 'services' })
    .where(eq(businesses.id, business.id))
  log.info({ businessId: business.id, displayName }, 'Onboarding: business name set')
  const confirm = lang === 'he' ? `מצוין — "${displayName}"! 🎉` : `Got it — "${displayName}"! 🎉`
  return { reply: `${confirm}\n\n${getPrompt('services', lang)}` }
}

async function handleServiceStep(
  db: Db,
  msg: InboundMessage,
  identity: ResolvedIdentity,
  business: Business,
  lang: Lang,
  log: FastifyBaseLogger,
): Promise<OnboardingResult> {
  return applyOnboardingInstruction(
    db, msg, identity, business,
    'service_change',
    getRetryPrompt('services', lang) ?? getPrompt('services', lang),
    async (confirmationMessage) => {
      await db.update(businesses).set({ onboardingStep: 'hours' }).where(eq(businesses.id, business.id))
      log.info({ businessId: business.id }, 'Onboarding: services step complete')
      return { reply: `${confirmationMessage}\n\n${getPrompt('hours', lang)}` }
    },
  )
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

  if (is247) {
    await db.update(businesses)
      .set({ onboardingStep: 'cancellation_policy', available247: true })
      .where(eq(businesses.id, business.id))
    log.info({ businessId: business.id }, 'Onboarding: hours step complete (24/7)')
    return { reply: `${i18n.ob_247[lang]}\n\n${getPrompt('cancellation_policy', lang)}` }
  }

  return applyOnboardingInstruction(
    db, msg, identity, business,
    'availability_change',
    getRetryPrompt('hours', lang) ?? getPrompt('hours', lang),
    async (confirmationMessage) => {
      await db.update(businesses)
        .set({ onboardingStep: 'cancellation_policy', available247: false })
        .where(eq(businesses.id, business.id))
      log.info({ businessId: business.id }, 'Onboarding: hours step complete')
      return { reply: `${confirmationMessage}\n\n${getPrompt('cancellation_policy', lang)}` }
    },
  )
}

async function handleCancellationPolicyStep(
  db: Db,
  msg: InboundMessage,
  business: Business,
  lang: Lang,
  log: FastifyBaseLogger,
): Promise<OnboardingResult> {
  const body = msg.body.trim()
  const hours = parseInt(body.replace(/\D/g, ''), 10)

  if (isNaN(hours) || hours < 0) {
    return { reply: getRetryPrompt('cancellation_policy', lang) ?? getPrompt('cancellation_policy', lang) }
  }

  await db.update(businesses)
    .set({ onboardingStep: 'payment', cancellationCutoffMinutes: hours * 60 })
    .where(eq(businesses.id, business.id))
  log.info({ businessId: business.id, hours }, 'Onboarding: cancellation policy set')

  const confirmation = hours === 0
    ? i18n.ob_cancellation_confirm_none[lang]
    : i18n.ob_cancellation_confirm[lang](hours)

  return { reply: `✅ ${confirmation}\n\n${getPrompt('payment', lang)}` }
}

async function handlePaymentStep(
  db: Db,
  msg: InboundMessage,
  business: Business,
  lang: Lang,
  log: FastifyBaseLogger,
): Promise<OnboardingResult> {
  const body = msg.body.trim()

  // First message in this step: yes/no for payment required
  if (!business.paymentMethod && (isAffirmative(body) || isNegative(body))) {
    if (isNegative(body)) {
      await db.update(businesses)
        .set({ onboardingStep: 'escalation_policy', confirmationGate: 'immediate' })
        .where(eq(businesses.id, business.id))
      log.info({ businessId: business.id }, 'Onboarding: payment gate = immediate')
      return { reply: `${i18n.ob_payment_immediate[lang]}\n\n${getPrompt('escalation_policy', lang)}` }
    }

    // Yes — ask for payment method (store 'pending' as sentinel to know we're in sub-step)
    await db.update(businesses)
      .set({ confirmationGate: 'post_payment', paymentMethod: 'pending' })
      .where(eq(businesses.id, business.id))
    return { reply: i18n.ob_payment_method_ask[lang] }
  }

  // Second message in this step: the payment method string
  if (business.paymentMethod === 'pending' || (business.confirmationGate === 'post_payment' && !business.paymentMethod?.trim())) {
    const method = body.slice(0, 100)
    await db.update(businesses)
      .set({ onboardingStep: 'escalation_policy', paymentMethod: method })
      .where(eq(businesses.id, business.id))
    log.info({ businessId: business.id, method }, 'Onboarding: payment method set')
    return { reply: `${i18n.ob_payment_method_confirm[lang](method)}\n\n${getPrompt('escalation_policy', lang)}` }
  }

  return { reply: getRetryPrompt('payment', lang) ?? getPrompt('payment', lang) }
}

async function handleEscalationPolicyStep(
  db: Db,
  msg: InboundMessage,
  business: Business,
  lang: Lang,
  log: FastifyBaseLogger,
): Promise<OnboardingResult> {
  const body = msg.body.trim()

  // Parse what the manager said into escalation rules
  const rules = parseEscalationPolicy(body, business.name)

  await db.update(businesses)
    .set({ onboardingStep: 'calendar', escalationRules: rules as unknown as Record<string, unknown>[] })
    .where(eq(businesses.id, business.id))
  log.info({ businessId: business.id, ruleCount: rules.length }, 'Onboarding: escalation policy set')

  const triggerList = rules.filter((r) => r.trigger !== 'unknown_intent').map((r) => r.trigger === 'keyword' ? `"${r.value}"` : r.trigger).join(', ')
  const summary = triggerList.length === 0
    ? i18n.ob_escalation_confirm_none[lang]
    : i18n.ob_escalation_confirm[lang](triggerList)

  return { reply: `✅ ${summary}\n\n${getPrompt('calendar', lang)}` }
}

export async function handleCalendarStepWithBody(
  db: Db,
  business: Business,
  baseUrl: string,
  body: string,
  lang: Lang = 'he',
): Promise<OnboardingResult> {
  if (body.trim().toLowerCase() === 'internal') {
    await db.update(businesses)
      .set({ onboardingStep: 'customer_import', calendarMode: 'internal' })
      .where(eq(businesses.id, business.id))
    return { reply: `${i18n.ob_calendar_internal[lang]}\n\n${getPrompt('customer_import', lang)}` }
  }

  // Step advances via OAuth callback — just resend the link
  const calendarLink = buildCalendarLink(business)
  return { reply: i18n.ob_calendar_waiting[lang](getPrompt('calendar', lang).replace('{{OAUTH_LINK}}', calendarLink)) }
}

async function handleCustomerImportStep(
  db: Db,
  msg: InboundMessage,
  business: Business,
  baseUrl: string,
  lang: Lang,
  log: FastifyBaseLogger,
): Promise<OnboardingResult> {
  if (isAffirmative(msg.body)) {
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000)
    const [token] = await db
      .insert(importTokens)
      .values({ businessId: business.id, managerPhone: msg.fromNumber, expiresAt })
      .returning({ token: importTokens.token })

    log.info({ businessId: business.id }, 'Onboarding: import token generated')
    const uploadUrl = `${baseUrl}/import/${token!.token}`
    return { reply: i18n.ob_import_link[lang](uploadUrl) }
  }

  await db.update(businesses).set({ onboardingStep: 'verify' }).where(eq(businesses.id, business.id))
  log.info({ businessId: business.id }, 'Onboarding: customer import skipped')
  const summary = await buildVerifySummary(db, business, lang)
  return { reply: `${i18n.ob_import_skip[lang]}\n\n${summary}` }
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

  // GO (any case) → launch
  if (body.toUpperCase() === 'GO') {
    await db
      .update(businesses)
      .set({ onboardingCompletedAt: new Date(), onboardingStep: null })
      .where(eq(businesses.id, business.id))
    log.info({ businessId: business.id }, 'Onboarding: complete via GO')
    return { reply: i18n.ob_complete[lang](business.whatsappNumber) }
  }

  // Not GO — treat as a correction to apply
  const classifyResult = await classifyManagerInstruction(body, {
    businessId: business.id,
    timezone: business.timezone,
  })

  if (!classifyResult.ok || classifyResult.data.ambiguous) {
    const clarification = classifyResult.ok ? classifyResult.data.clarificationNeeded : null
    return { reply: clarification ?? t('ob_verify_go_prompt', lang) }
  }

  const instruction = classifyResult.data

  const [saved] = await db
    .insert(managerInstructions)
    .values({
      businessId: business.id,
      identityId: identity.id,
      rawMessage: body,
      receivedAt: msg.timestamp,
      classifiedAs: instruction.instructionType as 'availability_change' | 'policy_change' | 'service_change' | 'permission_change' | 'unknown',
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
  return { reply: `${applyResult.confirmationMessage}\n\n${t('ob_verify_correction_done', lang)}` }
}

// ── Verify summary builder (exported for import.ts and oauth.ts) ──────────────

export async function buildVerifySummary(db: Db, business: Business, lang: Lang): Promise<string> {
  // Services
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

  // Working hours
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

  // Cancellation
  const cutoffH = business.cancellationCutoffMinutes ? Math.round(business.cancellationCutoffMinutes / 60) : 0
  const cancellationStr = cutoffH === 0
    ? t('ob_verify_cancellation_none', lang)
    : i18n.ob_verify_cancellation_hours[lang](cutoffH)

  // Payment
  const paymentStr = business.confirmationGate === 'post_payment' && business.paymentMethod
    ? i18n.ob_verify_payment_method[lang](business.paymentMethod)
    : t('ob_verify_payment_immediate', lang)

  // Escalation
  const rules = (business.escalationRules ?? []) as EscalationRule[]
  const keywordTriggers = rules.filter((r) => r.trigger === 'keyword' && r.value).map((r) => `"${r.value}"`)
  const escalationStr = keywordTriggers.length > 0
    ? keywordTriggers.join(', ')
    : t('ob_verify_escalation_none', lang)

  // Calendar
  const calStr = business.calendarMode === 'internal'
    ? t('ob_verify_calendar_internal', lang)
    : t('ob_verify_calendar_google', lang)

  return [
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
}

// ── Shared helper for LLM-classified onboarding steps ────────────────────────

async function applyOnboardingInstruction(
  db: Db,
  msg: InboundMessage,
  identity: ResolvedIdentity,
  business: Business,
  expectedType: string,
  retryPrompt: string,
  onSuccess: (confirmationMessage: string) => Promise<OnboardingResult>,
): Promise<OnboardingResult> {
  const classifyResult = await classifyManagerInstruction(msg.body, {
    businessId: business.id,
    timezone: business.timezone,
  })

  if (!classifyResult.ok || classifyResult.data.instructionType !== expectedType) {
    return { reply: retryPrompt }
  }

  const instruction = classifyResult.data
  if (instruction.ambiguous) {
    return { reply: instruction.clarificationNeeded ?? retryPrompt }
  }

  const [saved] = await db
    .insert(managerInstructions)
    .values({
      businessId: business.id,
      identityId: identity.id,
      rawMessage: msg.body,
      receivedAt: msg.timestamp,
      classifiedAs: instruction.instructionType as 'availability_change' | 'policy_change' | 'service_change' | 'permission_change' | 'unknown',
      structuredOutput: instruction as unknown as Record<string, unknown>,
      applyStatus: 'pending',
    })
    .returning({ id: managerInstructions.id })

  if (!saved) return { reply: retryPrompt }

  const applyResult = await applyInstruction(
    db,
    saved.id,
    business.id,
    identity.id,
    instruction.instructionType,
    instruction.structuredParams as Record<string, unknown>,
  )

  if (!applyResult.ok) {
    return { reply: `${retryPrompt}\n(${applyResult.reason})` }
  }

  return onSuccess(applyResult.confirmationMessage)
}

// ── Escalation policy parser ──────────────────────────────────────────────────

function parseEscalationPolicy(body: string, businessName: string): EscalationRule[] {
  const lower = body.toLowerCase()
  const rules: EscalationRule[] = []

  // Detect customerMessage preference from the numbered options
  let customerMessage: EscalationRule['customerMessage'] = 'passed_to_owner'
  let customText: string | undefined

  if (lower.includes('nothing') || lower.includes('silent') || lower.match(/\b1\b/)) {
    customerMessage = 'silent'
  } else if (lower.includes('call') || lower.match(/\b3\b/)) {
    customerMessage = 'owner_callback'
  } else if (lower.match(/\b4\b/) || lower.includes('custom')) {
    customerMessage = 'custom'
    // Try to extract quoted custom text
    const quoted = body.match(/"([^"]+)"/)
    customText = quoted?.[1]
  }

  // "only unknown requests" — minimal escalation
  if (lower.includes('only unknown') || lower.includes('minimal') || lower.includes('unrecogniz')) {
    rules.push({ trigger: 'unknown_intent', threshold: 2, customerMessage, ...(customText ? { customText } : {}) })
    return rules
  }

  // Extract keyword triggers from the text (words after "complaint", "refund", etc.)
  const keywordMatches = body.match(/["']([^"']+)["']|complaints?|refunds?|pricing|price|payment|angry|upset|cancel.*policy|discount|urgent|emergency/gi)
  if (keywordMatches) {
    for (const kw of keywordMatches) {
      const clean = kw.replace(/['"]/g, '').toLowerCase().trim()
      if (clean.length > 1) {
        rules.push({ trigger: 'keyword', value: clean, customerMessage, ...(customText ? { customText } : {}) })
      }
    }
  }

  // Always add unknown_intent as a backstop
  rules.push({ trigger: 'unknown_intent', threshold: 2, customerMessage, ...(customText ? { customText } : {}) })

  return rules
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildCalendarLink(business: Business): string {
  const base = process.env['PUBLIC_BASE_URL'] ?? 'https://your-domain.com'
  return `${base}/oauth/google?businessId=${business.id}`
}
