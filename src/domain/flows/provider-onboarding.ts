/**
 * Step 0 — Provider onboarding flow + operator admin routing.
 *
 * Runs exclusively on the central provider number (PROVIDER_WA_NUMBER).
 * - If sender is OPERATOR_PHONE → routes to operator admin handler.
 * - Otherwise → new business owner onboarding (5-step conversation).
 *
 * On onboarding completion, their WABA number is registered and they
 * are told to text their PA number directly — this number is never needed again.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { providerOnboardingSessions, businesses, identities, serviceTypes } from '../../db/schema.js'
import type { ProviderOnboardingSession } from '../../db/schema.js'
import { handleOperatorMessage } from './operator.js'
import { i18n, detectLang, type Lang } from '../i18n/t.js'
import { sendMessage } from '../../adapters/whatsapp/sender.js'
import { explainOnboardingConcept } from '../../adapters/llm/client.js'

export interface ProviderOnboardingResult {
  reply: string
}

type Step = ProviderOnboardingSession['step']

type CollectedData = {
  businessName?: string
  timezone?: string
  calendarMode?: 'internal' | 'google'
  calendarId?: string | null
  services?: Array<{ name: string; durationMinutes: number }>
  _serviceFailCount?: number
  _credentialHelpCount?: number
  _pendingPhoneNumberId?: string
  _pendingAccessToken?: string
  _wabaPath?: 'have_both' | 'partial' | 'full'
  _wabaGuideStep?: number
  _validatedPaNumber?: string   // stored after phone_number_id + token validate; awaiting WABA ID
  _pendingWabaId?: string
  phoneNumberId?: string
  accessToken?: string
  wabaId?: string
  paPhoneNumber?: string
  language?: Lang
}

const WABA_GUIDE_FULL: Record<Lang, string[]> = {
  he: [
    'לכו אל business.facebook.com וצרו חשבון Meta Business אם עדיין אין לכם.',
    'ב-Meta Business Manager, מלאו את שם העסק, המדינה והאזור הזמן כדי לאמת את החשבון.',
    'לכו ל-Business Settings, אחר כך WhatsApp Accounts, והוסיפו חשבון WhatsApp Business חדש עם מספר הטלפון שלכם.',
    'ב-Business Settings, לכו ל-System Users, הוסיפו משתמש מערכת חדש ותנו לו גישת Admin לחשבון ה-WhatsApp שלכם.',
    'פתחו את ה-System User, לחצו על Generate New Token, בחרו whatsapp_business_messaging, והעתיקו אותו. ה-Phone Number ID נמצא תחת WhatsApp ← Phone Numbers.',
  ],
  en: [
    'Go to business.facebook.com and create a Meta Business account if you don\'t have one yet.',
    'In Meta Business Manager, fill in your business name, country, and timezone to verify your account.',
    'Go to Business Settings, then WhatsApp Accounts, and add a new WhatsApp Business Account with your phone number.',
    'In Business Settings, go to System Users, add a new System User, and give it Admin access to your WhatsApp account.',
    'Open that System User, click Generate New Token, select whatsapp_business_messaging, and copy it. Your Phone Number ID is in WhatsApp → Phone Numbers.',
  ],
}

const WABA_GUIDE_PARTIAL: Record<Lang, string[]> = {
  he: [
    'ב-Meta Business Manager, לכו ל-System Users. אם אין לכם, הוסיפו אחד עם גישת Admin וחברו אליו את חשבון ה-WhatsApp.',
    'פתחו את ה-System User, לחצו על Generate New Token, בחרו whatsapp_business_messaging, והעתיקו אותו. ה-Phone Number ID נמצא תחת WhatsApp ← Phone Numbers.',
  ],
  en: [
    'In Meta Business Manager, go to System Users. If you don\'t have one, add it with Admin access and connect your WhatsApp account to it.',
    'Open the System User, click Generate New Token, select whatsapp_business_messaging, and copy it. Your Phone Number ID is in WhatsApp → Phone Numbers.',
  ],
}

const WABA_GUIDE_CONCEPTS: string[] = [
  'meta_account',
  'business_manager',
  'waba_setup',
  'system_user',
  'credentials_guide',
]

// ── Entry point ───────────────────────────────────────────────────────────────

export async function handleProviderOnboarding(
  db: Db,
  fromNumber: string,
  body: string,
): Promise<ProviderOnboardingResult> {
  // Operator admin channel — bypass onboarding entirely
  const operatorPhone = process.env['OPERATOR_PHONE']
  if (operatorPhone && fromNumber === operatorPhone) {
    return handleOperatorMessage(db, fromNumber, body)
  }

  let session = await loadSession(db, fromNumber)

  if (!session) {
    session = await createSession(db, fromNumber)
    // Welcome is bilingual — language not yet known
    return { reply: `${i18n.mm_welcome.he}\n\n${i18n.mm_welcome.en}` }
  }

  if (session.completedAt) {
    const data = session.collectedData as CollectedData
    const lang: Lang = data.language ?? 'he'
    return { reply: i18n.mm_already_done[lang] }
  }

  return handleStep(db, session, body.trim())
}

// ── Step handlers ─────────────────────────────────────────────────────────────

async function handleStep(
  db: Db,
  session: ProviderOnboardingSession,
  text: string,
): Promise<ProviderOnboardingResult> {
  const data = session.collectedData as CollectedData
  const lang: Lang = data.language ?? 'he'

  switch (session.step) {
    case 'business_name': {
      // Treat casual greetings as a re-ask rather than accepting as the business name
      if (/^(שלום|היי|הי|אהלן|hello|hi|hey)\b/i.test(text)) {
        return { reply: `מה שם העסק שלכם? / What's the name of your business?` }
      }
      const name = text.slice(0, 100)
      const detectedLang = detectLang(text)
      await advance(db, session.managerPhone, 'timezone', { ...data, businessName: name, language: detectedLang })
      const confirm = detectedLang === 'he' ? `מעולה, "${name}"!` : `Great, "${name}"!`
      return { reply: `${confirm}\n\n${i18n.mm_ask_timezone[detectedLang]}` }
    }

    case 'timezone': {
      if (detectsQuestion(text)) {
        const explanation = await explainOnboardingConcept({ concept: 'timezone', userMessage: text, step: 'timezone', lang })
        if (explanation) return { reply: explanation }
      }
      const tz = resolveTimezone(text)
      if (!tz) {
        return { reply: i18n.mm_bad_timezone[lang] }
      }
      await advance(db, session.managerPhone, 'calendar', { ...data, timezone: tz })
      return { reply: i18n.mm_ask_calendar_mode[lang] }
    }

    case 'calendar': {
      if (!data.calendarMode) {
        if (detectsQuestion(text)) {
          const explanation = await explainOnboardingConcept({ concept: 'calendar', userMessage: text, step: 'calendar', lang })
          if (explanation) return { reply: explanation }
        }
        // Parse natural language: does the user want Google or internal?
        const lower = text.toLowerCase()
        const wantsGoogle = lower.includes('google') || lower.includes('גוגל')
          || lower.includes('2') || lower.includes('calendar') || lower.includes('יומן')
        const wantsInternal = lower.includes('פנימי') || lower.includes('internal')
          || lower.includes('later') || lower.includes('מאוחר') || lower.includes('אחרי')
          || lower.includes('1') || lower.includes('לא') || lower.includes('no')
          || lower.includes('without') || lower.includes('בלי')

        if (wantsGoogle && !wantsInternal) {
          // Store mode choice but stay on this step to collect the Calendar ID next
          await db
            .update(providerOnboardingSessions)
            .set({ collectedData: { ...data, calendarMode: 'google' } as Record<string, unknown>, updatedAt: new Date() })
            .where(eq(providerOnboardingSessions.managerPhone, session.managerPhone))
          return { reply: i18n.mm_ask_calendar[lang] }
        }
        if (wantsInternal && !wantsGoogle) {
          await advance(db, session.managerPhone, 'services', { ...data, calendarMode: 'internal', calendarId: null })
          return { reply: i18n.mm_ask_services[lang] }
        }
        // Ambiguous — re-ask with clearer question
        return { reply: i18n.mm_ask_calendar_mode[lang] }
      }

      // calendarMode is 'google' — next input is the Google Calendar ID
      const calendarId = text.trim()
      await advance(db, session.managerPhone, 'services', { ...data, calendarId })
      return { reply: i18n.mm_ask_services[lang] }
    }

    case 'services': {
      if (detectsQuestion(text)) {
        const explanation = await explainOnboardingConcept({ concept: 'services', userMessage: text, step: 'services', lang })
        if (explanation) return { reply: explanation }
      }
      const parsed = parseService(text)
      const failCount = data._serviceFailCount ?? 0

      if (!parsed) {
        if (failCount >= 1) {
          // Second failure — accept as-is with 30-minute default
          const fallback = { name: text.trim().slice(0, 100), durationMinutes: 30 }
          const { _serviceFailCount: _, ...cleanData } = data
          await advance(db, session.managerPhone, 'waba_check', {
            ...cleanData,
            services: [fallback],
          })
          return { reply: i18n.mm_ask_waba_check[lang] }
        }
        await db
          .update(providerOnboardingSessions)
          .set({
            collectedData: { ...data, _serviceFailCount: failCount + 1 } as Record<string, unknown>,
            updatedAt: new Date(),
          })
          .where(eq(providerOnboardingSessions.managerPhone, session.managerPhone))
        return { reply: i18n.mm_bad_services[lang] }
      }

      const { _serviceFailCount: _, ...cleanData } = data
      await advance(db, session.managerPhone, 'waba_check', { ...cleanData, services: [parsed] })
      return { reply: i18n.mm_ask_waba_check[lang] }
    }

    case 'waba_check': {
      if (detectsQuestion(text)) {
        const explanation = await explainOnboardingConcept({ concept: 'waba_check', userMessage: text, step: 'waba_check', lang })
        if (explanation) return { reply: explanation }
      }

      const lower = text.toLowerCase()
      const hasBoth = /yes|yep|yeah|already|have|got|both|ready|כן|יש לי|יש לנו|מוכן|מוכנה|יש|כבר/.test(lower)
      const hasPartial = /partial|waba|number|phone|whatsapp.*account|no.*token|no.*access|no.*dev|חלקי|יש לי מספר|יש לנו מספר/.test(lower)
      const hasNothing = /no|nothing|none|haven'?t|didn'?t|new|from scratch|start|never|לא|אין|מאפס|לא יודע|לא יודעת/.test(lower)

      let wabaPath: 'have_both' | 'partial' | 'full' = 'full'

      if (hasBoth && !hasNothing) {
        wabaPath = 'have_both'
      } else if (hasPartial && !hasBoth && !hasNothing) {
        wabaPath = 'partial'
      }

      if (wabaPath === 'have_both') {
        await advance(db, session.managerPhone, 'credentials', data)
        return { reply: i18n.mm_ask_credentials[lang] }
      }

      await advance(db, session.managerPhone, 'waba_guide', { ...data, _wabaPath: wabaPath, _wabaGuideStep: 0 })
      const guide = wabaPath === 'full' ? WABA_GUIDE_FULL[lang] : WABA_GUIDE_PARTIAL[lang]
      return { reply: `${guide[0]}\n\n${i18n.mm_waba_guide_next_prompt[lang]}` }
    }

    case 'waba_guide': {
      const wabaPath = data._wabaPath ?? 'full'
      const currentStep = data._wabaGuideStep ?? 0
      const guide = wabaPath === 'full' ? WABA_GUIDE_FULL[lang] : WABA_GUIDE_PARTIAL[lang]
      const totalSteps = guide.length

      // Check if user is asking a question — explain, don't advance
      if (detectsQuestion(text) && !isAcknowledgment(text)) {
        const conceptKey = WABA_GUIDE_CONCEPTS[Math.min(currentStep, WABA_GUIDE_CONCEPTS.length - 1)] ?? 'credentials_guide'
        const explanation = await explainOnboardingConcept({ concept: conceptKey, userMessage: text, step: conceptKey, lang })
        if (explanation) return { reply: explanation }
      }

      if (!isAcknowledgment(text)) {
        // Not an acknowledgment and not a question — re-send current step
        return { reply: `${guide[currentStep]}\n\n${i18n.mm_waba_guide_next_prompt[lang]}` }
      }

      const nextStep = currentStep + 1

      if (nextStep >= totalSteps) {
        // Guide complete — advance to credentials
        await advance(db, session.managerPhone, 'credentials', { ...data, _wabaGuideStep: nextStep })
        return { reply: `${i18n.mm_waba_guide_done[lang]}\n\n${i18n.mm_ask_credentials[lang]}` }
      }

      // Send next guide step
      await db
        .update(providerOnboardingSessions)
        .set({ collectedData: { ...data, _wabaGuideStep: nextStep } as Record<string, unknown>, updatedAt: new Date() })
        .where(eq(providerOnboardingSessions.managerPhone, session.managerPhone))
      return { reply: `${guide[nextStep]}\n\n${i18n.mm_waba_guide_next_prompt[lang]}` }
    }

    case 'credentials': {
      const helpCount = data._credentialHelpCount ?? 0

      // Sub-step: phone_number_id + token already validated; waiting for WABA ID
      if (data._validatedPaNumber && data._pendingPhoneNumberId && data._pendingAccessToken) {
        const wabaIdMatch = text.match(/\d{10,20}/)?.[0] ?? null
        if (!wabaIdMatch) {
          return { reply: i18n.mm_credentials_ask_waba_id[lang] }
        }

        const fullData: CollectedData = {
          ...data,
          phoneNumberId: data._pendingPhoneNumberId,
          accessToken: data._pendingAccessToken,
          wabaId: wabaIdMatch,
          paPhoneNumber: data._validatedPaNumber,
        }
        const provisionResult = await provisionBusiness(db, session.managerPhone, fullData, wabaIdMatch)
        if (!provisionResult.ok) {
          return { reply: i18n.mm_setup_failed[lang](provisionResult.error) }
        }

        await db.update(providerOnboardingSessions)
          .set({ completedAt: new Date(), collectedData: fullData as Record<string, unknown>, updatedAt: new Date() })
          .where(eq(providerOnboardingSessions.managerPhone, session.managerPhone))

        const bkOpeningPrompt = lang === 'he'
          ? `לפני שהלקוחות מגיעים, בואנו נלמד על *${fullData.businessName}* כדי שאוכל לייצג אתכם הכי טוב.\n\nאיך היית מתאר/ת את *${fullData.businessName}*? מה הרגש שאתה/את רוצה שלקוחות יקבלו אחרי כל ביקור? מה מייחד אתכם?\n\n(ככל שתשתף/י יותר, כך אדבר טוב יותר בשמך)`
          : `Before customers arrive, let me get to know *${fullData.businessName}* so I can represent you well.\n\nHow would you describe *${fullData.businessName}*? What feeling do you want customers to walk away with? What makes you stand out?\n\n(The more detail you share, the better I'll speak in your voice)`

        await sendMessage(
          { toNumber: session.managerPhone, body: bkOpeningPrompt },
          { accessToken: fullData.accessToken!, phoneNumberId: fullData.phoneNumberId! },
        ).catch(() => { /* BK setup kickoff is best-effort */ })

        return { reply: i18n.mm_done[lang](fullData.paPhoneNumber!) }
      }

      // Extract whatever the user just sent
      const newId = text.match(/\d{10,20}/)?.[0] ?? null
      const newToken = text.match(/EAA[A-Za-z0-9]+/)?.[0] ?? null

      // Merge with anything stored from a previous partial message
      const resolvedId = newId ?? data._pendingPhoneNumberId ?? null
      const resolvedToken = newToken ?? data._pendingAccessToken ?? null

      // Both pieces present — validate then ask for WABA ID
      if (resolvedId && resolvedToken) {
        const metaResult = await fetchPhoneNumberFromMeta(resolvedId, resolvedToken)
        if (!metaResult.ok) {
          // Clear pending partials so user can retry fresh
          await db.update(providerOnboardingSessions)
            .set({ collectedData: { ...data, _pendingPhoneNumberId: undefined, _pendingAccessToken: undefined } as Record<string, unknown>, updatedAt: new Date() })
            .where(eq(providerOnboardingSessions.managerPhone, session.managerPhone))
          return { reply: `${i18n.mm_credentials_error[lang](metaResult.error)}\n\n${i18n.mm_retry_credentials[lang]}` }
        }

        // Credentials valid — save validated state and ask for WABA ID
        await db.update(providerOnboardingSessions)
          .set({
            collectedData: {
              ...data,
              _pendingPhoneNumberId: resolvedId,
              _pendingAccessToken: resolvedToken,
              _validatedPaNumber: metaResult.phoneNumber,
            } as Record<string, unknown>,
            updatedAt: new Date(),
          })
          .where(eq(providerOnboardingSessions.managerPhone, session.managerPhone))
        return { reply: i18n.mm_credentials_ask_waba_id[lang] }
      }

      // Only one piece — store it and ask for the missing one
      if (resolvedId && !resolvedToken) {
        await db.update(providerOnboardingSessions)
          .set({ collectedData: { ...data, _pendingPhoneNumberId: resolvedId } as Record<string, unknown>, updatedAt: new Date() })
          .where(eq(providerOnboardingSessions.managerPhone, session.managerPhone))
        return { reply: i18n.mm_credentials_partial_id[lang](resolvedId) }
      }
      if (resolvedToken && !resolvedId) {
        await db.update(providerOnboardingSessions)
          .set({ collectedData: { ...data, _pendingAccessToken: resolvedToken } as Record<string, unknown>, updatedAt: new Date() })
          .where(eq(providerOnboardingSessions.managerPhone, session.managerPhone))
        return { reply: i18n.mm_credentials_partial_token[lang] }
      }

      // No credential content at all — handle confusion/questions
      if (detectsQuestion(text) && !isExpressingNoAccess(text)) {
        const explanation = await explainOnboardingConcept({ concept: 'credentials', userMessage: text, step: 'credentials', lang })
        if (explanation) return { reply: explanation }
      }

      const newCount = helpCount + 1
      await db.update(providerOnboardingSessions)
        .set({ collectedData: { ...data, _credentialHelpCount: newCount } as Record<string, unknown>, updatedAt: new Date() })
        .where(eq(providerOnboardingSessions.managerPhone, session.managerPhone))
      if (newCount >= 3) return { reply: i18n.mm_credentials_stuck[lang] }
      return { reply: i18n.mm_credentials_help[lang] }
    }
  }
}

// ── Provisioning ──────────────────────────────────────────────────────────────

async function provisionBusiness(
  db: Db,
  managerPhone: string,
  data: CollectedData,
  wabaId: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { businessName, timezone, calendarMode, calendarId, services, phoneNumberId, accessToken, paPhoneNumber } = data

  if (!businessName || !timezone || !phoneNumberId || !accessToken || !paPhoneNumber) {
    return { ok: false, error: 'Missing required fields' }
  }

  // Idempotent — skip if already provisioned for this PA number
  const [existing] = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.whatsappNumber, paPhoneNumber))
    .limit(1)

  if (existing) return { ok: true }

  const resolvedCalendarMode = calendarMode ?? 'google'

  const [business] = await db
    .insert(businesses)
    .values({
      name: businessName,
      whatsappNumber: paPhoneNumber,
      whatsappPhoneNumberId: phoneNumberId,
      whatsappAccessToken: accessToken,
      // For internal mode, use the PA number as a placeholder; real Calendar ID only for google mode
      googleCalendarId: resolvedCalendarMode === 'google' && calendarId ? calendarId : paPhoneNumber,
      calendarMode: resolvedCalendarMode,
      timezone,
      onboardingStep: null,
    })
    .returning({ id: businesses.id })

  if (!business) return { ok: false, error: 'Failed to create business record' }

  await db.insert(identities).values({
    businessId: business.id,
    phoneNumber: managerPhone,
    role: 'manager',
    displayName: 'Owner',
  })

  if (services && services.length > 0) {
    await db.insert(serviceTypes).values(
      services.map((s) => ({
        businessId: business.id,
        name: s.name,
        durationMinutes: s.durationMinutes,
      })),
    )
  }

  // Subscribe our app to this WABA's webhook feed so inbound messages route to us.
  // Must use the business's own access token — the platform token only works for WABAs we own.
  // Best-effort — failure is logged but does not block provisioning.
  if (wabaId && accessToken) {
    await subscribeWabaWebhook(wabaId, accessToken).catch((err) =>
      console.error('[provisionBusiness] subscribeWabaWebhook threw:', err),
    )
  } else if (wabaId) {
    console.warn('[provisionBusiness] wabaId present but no accessToken — skipping webhook subscription')
  }

  return { ok: true }
}

// ── Meta API ──────────────────────────────────────────────────────────────────

async function fetchPhoneNumberFromMeta(
  phoneNumberId: string,
  accessToken: string,
  wabaId?: string | null,
): Promise<{ ok: true; phoneNumber: string; wabaId: string | null } | { ok: false; error: string }> {
  try {
    // Note: whatsapp_business_account field only works with system user tokens, not user tokens.
    // WABA ID is collected separately during credentials step.
    const url = `https://graph.facebook.com/v21.0/${phoneNumberId}?fields=display_phone_number,verified_name`
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    const json = (await res.json()) as {
      display_phone_number?: string
      verified_name?: string
      error?: { message?: string }
    }

    if (!res.ok || json.error) {
      return { ok: false, error: json.error?.message ?? `HTTP ${res.status}` }
    }

    const raw = json.display_phone_number
    if (!raw) return { ok: false, error: 'Could not retrieve phone number from Meta' }

    // Normalise to E.164 (Meta returns formatted like "+1 555-000-1234")
    const e164 = '+' + raw.replace(/\D/g, '')
    return { ok: true, phoneNumber: e164, wabaId: wabaId ?? null }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function subscribeWabaWebhook(wabaId: string, accessToken: string): Promise<void> {
  // Use the business owner's token — they must be an admin of the WABA.
  // The platform (app) token only works for WABAs the app directly owns.
  const res = await fetch(`https://graph.facebook.com/v21.0/${wabaId}/subscribed_apps`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const body = await res.text()
    console.error(`[provisionBusiness] Webhook subscription failed for WABA ${wabaId}: ${body}`)
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function loadSession(db: Db, managerPhone: string) {
  const [session] = await db
    .select()
    .from(providerOnboardingSessions)
    .where(eq(providerOnboardingSessions.managerPhone, managerPhone))
    .limit(1)
  return session ?? null
}

async function createSession(db: Db, managerPhone: string) {
  const [session] = await db
    .insert(providerOnboardingSessions)
    .values({ managerPhone })
    .returning()
  return session!
}

async function advance(db: Db, managerPhone: string, nextStep: Step, data: CollectedData) {
  await db
    .update(providerOnboardingSessions)
    .set({ step: nextStep, collectedData: data as Record<string, unknown>, updatedAt: new Date() })
    .where(eq(providerOnboardingSessions.managerPhone, managerPhone))
}

// ── Parsing helpers ───────────────────────────────────────────────────────────

function isAcknowledgment(text: string): boolean {
  return /^(ok|okay|done|ready|got it|next|continue|sure|yes|great|perfect|understood|finished|complete|אוקיי|סיימתי|הבנתי|בוצע|המשך|כן|מוכן|מוכנה|נהדר|סיים|גמרתי)\b/i.test(text.trim())
}

function detectsQuestion(text: string): boolean {
  const t = text.trim()
  return (
    t.includes('?') ||
    /^(what|how|why|where|when|who|can you|could you|please explain|מה|איך|למה|איפה|מתי|מי|תסביר|הסבר|לא מבין|לא מבינה)/i.test(t)
  )
}

function isExpressingNoAccess(text: string): boolean {
  return /(אין לי|אין לנו|don'?t have|do not have|i have no|no token|no id|no access|לא קיבלתי|לא מצאתי|לא יודע|לא יודעת|עדיין לא|haven'?t got|didn'?t get)/i.test(text)
}

function isAskingForHelp(text: string): boolean {
  return /^(help|עזרה|מה זה|מה ה|what is|what'?s a|what are|how do|how to|איך|where|where do|איפה|explain|הסבר|לא מבין|לא מבינה|don'?t understand)/i.test(text.trim())
}

function looksLikeCredentialAttempt(text: string): boolean {
  // Must contain a long numeric ID or an EAA token — anything else is confusion, not an attempt
  return /\d{10,20}/.test(text) || /EAA[A-Za-z0-9]{5,}/.test(text)
}

function parseCredentials(text: string): { phoneNumberId: string; accessToken: string } | null {
  // Accept flexible formats:
  //   ID: 1234567890\nTOKEN: EAAxxxxx
  //   phone_number_id: 1234567890, access_token: EAAxxxxx
  //   1234567890 EAAxxxxx (space separated)
  const idMatch = text.match(/(?:ID|phone_number_id)[:\s]+([0-9]{10,20})/i)
  const tokenMatch = text.match(/(?:TOKEN|access_token)[:\s]+(EAA[A-Za-z0-9]+)/i)

  if (idMatch && tokenMatch) {
    return { phoneNumberId: idMatch[1]!, accessToken: tokenMatch[1]! }
  }

  // Fallback: two whitespace-separated tokens (number + EAA...)
  const parts = text.split(/\s+/)
  const numPart = parts.find((p) => /^\d{10,20}$/.test(p))
  const tokenPart = parts.find((p) => p.startsWith('EAA'))
  if (numPart && tokenPart) {
    return { phoneNumberId: numPart, accessToken: tokenPart }
  }

  return null
}

function parseService(text: string): { name: string; durationMinutes: number } | null {
  const durationMatch = text.match(/(\d+)\s*(?:דקות?|min(?:utes?)?)/i)
  if (!durationMatch) return null
  const durationMinutes = parseInt(durationMatch[1]!, 10)
  if (isNaN(durationMinutes) || durationMinutes <= 0) return null

  const name = text.replace(/[,،\s]*\d+\s*(?:דקות?|min(?:utes?)?)/i, '').trim()
  if (!name) return null

  return { name: name.slice(0, 100), durationMinutes }
}

function resolveTimezone(input: string): string | null {
  const cleaned = input.trim()
  // Try as-is first (IANA format)
  if (isValidIANA(cleaned)) return cleaned

  // Common shorthand map — English and Hebrew city/country names
  const shortcuts: Record<string, string> = {
    // Hebrew
    'ישראל': 'Asia/Jerusalem',
    'תל אביב': 'Asia/Jerusalem',
    'ירושלים': 'Asia/Jerusalem',
    'חיפה': 'Asia/Jerusalem',
    'לונדון': 'Europe/London',
    'פריז': 'Europe/Paris',
    'דובאי': 'Asia/Dubai',
    'ניו יורק': 'America/New_York',
    // English
    'tel aviv': 'Asia/Jerusalem',
    'israel': 'Asia/Jerusalem',
    'il': 'Asia/Jerusalem',
    'jerusalem': 'Asia/Jerusalem',
    'haifa': 'Asia/Jerusalem',
    'new york': 'America/New_York',
    'new york city': 'America/New_York',
    'nyc': 'America/New_York',
    'us': 'America/New_York',
    'london': 'Europe/London',
    'uk': 'Europe/London',
    'paris': 'Europe/Paris',
    'fr': 'Europe/Paris',
    'dubai': 'Asia/Dubai',
    'ae': 'Asia/Dubai',
    'utc': 'UTC',
  }

  const mapped = shortcuts[cleaned.toLowerCase()] ?? shortcuts[cleaned]
  if (mapped) return mapped

  // Try capitalising as continent/city (e.g. "america/new_york" → "America/New_York")
  const titleCased = cleaned
    .split('/')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('/')
  if (isValidIANA(titleCased)) return titleCased

  return null
}

function isValidIANA(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}
