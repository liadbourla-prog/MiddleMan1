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

import crypto from 'crypto'
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { providerOnboardingSessions, businesses, identities, serviceTypes } from '../../db/schema.js'
import type { ProviderOnboardingSession } from '../../db/schema.js'
import { handleOperatorMessage } from './operator.js'
import { i18n, detectLang, type Lang } from '../i18n/t.js'
import { sendMessage } from '../../adapters/whatsapp/sender.js'
import { explainOnboardingConcept, generateProviderOnboardingReply } from '../../adapters/llm/client.js'

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
  _signupState?: string
  phoneNumberId?: string
  accessToken?: string
  paPhoneNumber?: string
  language?: Lang
  _wabaType?: 'app' | 'meta'
  _wabaCase?: '1' | '2' | '3a' | '3b'
}

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
    const welcomeFallback = `${i18n.mm_welcome.he}\n\n${i18n.mm_welcome.en}`
    const welcomeReply = await generateProviderOnboardingReply({ step: 'welcome', lang: 'bilingual', fallback: welcomeFallback })
    return { reply: welcomeReply }
  }

  if (session.completedAt) {
    const data = session.collectedData as CollectedData
    const lang: Lang = data.language ?? 'he'

    // Case 1 completed — detect coexistence request after 7-day wait
    if (
      data._wabaCase === '1' &&
      /coexistence|coexist|שיתוף|לחבר|חיבור|ready|מוכן|מוכנה/i.test(body)
    ) {
      const signupState = crypto.randomUUID()
      await db
        .update(providerOnboardingSessions)
        .set({ collectedData: { ...data, _signupState: signupState } as Record<string, unknown>, updatedAt: new Date() })
        .where(eq(providerOnboardingSessions.managerPhone, fromNumber))
      return { reply: i18n.mm_coexistence_link[lang](buildSignupUrl(signupState)) }
    }

    const alreadyDoneFallback = i18n.mm_already_done[lang]
    const alreadyDoneReply = await generateProviderOnboardingReply({
      step: 'already_done',
      lang,
      collectedData: data.businessName ? { businessName: data.businessName } : {},
      fallback: alreadyDoneFallback,
    })
    return { reply: alreadyDoneReply }
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
        const greetFallback = `מה שם העסק שלכם? / What's the name of your business?`
        const greetReply = await generateProviderOnboardingReply({ step: 'ask_business_name', lang: 'bilingual', fallback: greetFallback })
        return { reply: greetReply }
      }
      const name = text.slice(0, 100)
      const detectedLang = detectLang(text)
      await advance(db, session.managerPhone, 'timezone', { ...data, businessName: name, language: detectedLang })
      const timezoneFallback = `${detectedLang === 'he' ? `מעולה, "${name}"!` : `Great, "${name}"!`}\n\n${i18n.mm_ask_timezone[detectedLang]}`
      const timezoneReply = await generateProviderOnboardingReply({
        step: 'ask_timezone',
        lang: detectedLang,
        collectedData: { businessName: name },
        justConfirmed: name,
        fallback: timezoneFallback,
      })
      return { reply: timezoneReply }
    }

    case 'timezone': {
      if (detectsQuestion(text)) {
        const explanation = await explainOnboardingConcept({ concept: 'timezone', userMessage: text, step: 'timezone', lang })
        if (explanation) return { reply: explanation }
      }
      const tz = resolveTimezone(text)
      if (!tz) {
        const badTzFallback = i18n.mm_bad_timezone[lang]
        const badTzReply = await generateProviderOnboardingReply({
          step: 'bad_timezone',
          lang,
          collectedData: data.businessName ? { businessName: data.businessName } : {},
          isRetry: true,
          fallback: badTzFallback,
        })
        return { reply: badTzReply }
      }
      await advance(db, session.managerPhone, 'calendar', { ...data, timezone: tz })
      const calendarModeFallback = i18n.mm_ask_calendar_mode[lang]
      const calendarModeReply = await generateProviderOnboardingReply({
        step: 'ask_calendar_mode',
        lang,
        collectedData: data.businessName ? { businessName: data.businessName } : {},
        justConfirmed: tz,
        fallback: calendarModeFallback,
      })
      return { reply: calendarModeReply }
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
          const calIdFallback = i18n.mm_ask_calendar[lang]
          const calIdReply = await generateProviderOnboardingReply({
            step: 'ask_calendar_id',
            lang,
            collectedData: data.businessName ? { businessName: data.businessName } : {},
            justConfirmed: 'Google Calendar',
            fallback: calIdFallback,
          })
          return { reply: calIdReply }
        }
        if (wantsInternal && !wantsGoogle) {
          await advance(db, session.managerPhone, 'services', { ...data, calendarMode: 'internal', calendarId: null })
          const servicesFallback1 = i18n.mm_ask_services[lang]
          const servicesReply1 = await generateProviderOnboardingReply({
            step: 'ask_services',
            lang,
            collectedData: data.businessName ? { businessName: data.businessName } : {},
            justConfirmed: lang === 'he' ? 'יומן פנימי' : 'internal calendar',
            fallback: servicesFallback1,
          })
          return { reply: servicesReply1 }
        }
        // Ambiguous — re-ask with clearer question
        const calendarModeFallback2 = i18n.mm_ask_calendar_mode[lang]
        const calendarModeReply2 = await generateProviderOnboardingReply({
          step: 'ask_calendar_mode',
          lang,
          collectedData: data.businessName ? { businessName: data.businessName } : {},
          isRetry: true,
          fallback: calendarModeFallback2,
        })
        return { reply: calendarModeReply2 }
      }

      // calendarMode is 'google' — next input is the Google Calendar ID
      const calendarId = text.trim()
      await advance(db, session.managerPhone, 'services', { ...data, calendarId })
      const servicesFallback2 = i18n.mm_ask_services[lang]
      const servicesReply2 = await generateProviderOnboardingReply({
        step: 'ask_services',
        lang,
        collectedData: data.businessName ? { businessName: data.businessName } : {},
        fallback: servicesFallback2,
      })
      return { reply: servicesReply2 }
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
          return { reply: i18n.mm_waba_check[lang] }
        }
        await db
          .update(providerOnboardingSessions)
          .set({
            collectedData: { ...data, _serviceFailCount: failCount + 1 } as Record<string, unknown>,
            updatedAt: new Date(),
          })
          .where(eq(providerOnboardingSessions.managerPhone, session.managerPhone))
        const badSvcFallback = i18n.mm_bad_services[lang]
        const badSvcReply = await generateProviderOnboardingReply({
          step: 'bad_services',
          lang,
          collectedData: data.businessName ? { businessName: data.businessName } : {},
          isRetry: true,
          fallback: badSvcFallback,
        })
        return { reply: badSvcReply }
      }

      const { _serviceFailCount: _, ...cleanData } = data
      await advance(db, session.managerPhone, 'waba_check', { ...cleanData, services: [parsed] })
      return { reply: i18n.mm_waba_check[lang] }
    }

    case 'waba_check': {
      const lower = text.toLowerCase()
      const hasNumber =
        lower.includes('yes') || lower.includes('כן') || lower.includes('יש') ||
        lower.includes('yeah') || lower.includes('yep') || lower.includes('כן,') ||
        lower.includes('have') || lower.includes('already')
      const noNumber =
        lower.includes('no') || lower.includes('לא') || lower.includes('אין') ||
        lower.includes('nope') || lower.includes('not yet') || lower.includes('עדיין לא') ||
        lower.includes('never') || lower.includes('fresh') || lower.includes('new number') ||
        lower.includes('חדש')

      if (noNumber && !hasNumber) {
        // Case 1: fresh number
        const signupState = crypto.randomUUID()
        await advance(db, session.managerPhone, 'credentials', {
          ...data, _wabaCase: '1', _signupState: signupState,
        })
        return { reply: i18n.mm_case1_link[lang](buildSignupUrl(signupState)) }
      }
      if (hasNumber && !noNumber) {
        await advance(db, session.managerPhone, 'waba_guide', { ...data })
        return { reply: i18n.mm_waba_guide_type[lang] }
      }
      // Ambiguous — re-ask
      return { reply: i18n.mm_waba_check[lang] }
    }

    case 'waba_guide': {
      const lower = text.toLowerCase()

      // ── Sub-state: waba type not yet known ────────────────────────────────
      if (!data._wabaType) {
        const isApp =
          lower.includes('app') || lower.includes('אפליקציה') || lower.includes('טלפון') ||
          lower.includes('phone') || lower.includes('mobile') || lower.includes('business app') ||
          lower.includes('ביזנס אפ') || lower.includes('whatsapp business') && !lower.includes('manager') && !lower.includes('מנג\'ר')
        const isMeta =
          lower.includes('meta') || lower.includes('business manager') || lower.includes('מנג\'ר') ||
          lower.includes('cloud') || lower.includes('api') || lower.includes('developer') ||
          lower.includes('מפתח')

        if (isApp && !isMeta) {
          const signupState = crypto.randomUUID()
          await advance(db, session.managerPhone, 'credentials', {
            ...data, _wabaType: 'app', _wabaCase: '2', _signupState: signupState,
          })
          return { reply: i18n.mm_coexistence_link[lang](buildSignupUrl(signupState)) }
        }
        if (isMeta && !isApp) {
          await db
            .update(providerOnboardingSessions)
            .set({ collectedData: { ...data, _wabaType: 'meta' } as Record<string, unknown>, updatedAt: new Date() })
            .where(eq(providerOnboardingSessions.managerPhone, session.managerPhone))
          return { reply: i18n.mm_waba_guide_bsp[lang] }
        }
        // Confused — explain
        if (detectsQuestion(text)) {
          const explanation = await explainOnboardingConcept({ concept: 'waba_type', userMessage: text, step: 'waba_guide', lang })
          if (explanation) return { reply: explanation }
        }
        return { reply: i18n.mm_waba_guide_type[lang] }
      }

      // ── Sub-state: meta confirmed — own setup or BSP ─────────────────────
      if (data._wabaType === 'meta') {
        const selfSetup =
          lower.includes('myself') || lower.includes('we did') || lower.includes('i did') ||
          lower.includes('בעצמי') || lower.includes('בעצמנו') || lower.includes('yes') ||
          lower.includes('כן') || lower.includes('own') || lower.includes('our')
        const bsp =
          lower.includes('agency') || lower.includes('company') || lower.includes('provider') ||
          lower.includes('חברה') || lower.includes('סוכנות') || lower.includes('someone else') ||
          lower.includes('external') || lower.includes('no') || lower.includes('לא')

        if (selfSetup && !bsp) {
          const signupState = crypto.randomUUID()
          await advance(db, session.managerPhone, 'credentials', {
            ...data, _wabaCase: '3a', _signupState: signupState,
          })
          return { reply: i18n.mm_case3a_link[lang](buildSignupUrl(signupState)) }
        }
        if (bsp && !selfSetup) {
          // Case 3b — out of scope, exit gracefully, leave session open
          await db
            .update(providerOnboardingSessions)
            .set({ collectedData: { ...data, _wabaCase: '3b' } as Record<string, unknown>, updatedAt: new Date() })
            .where(eq(providerOnboardingSessions.managerPhone, session.managerPhone))
          return { reply: i18n.mm_case3b_exit[lang] }
        }
        return { reply: i18n.mm_waba_guide_bsp[lang] }
      }

      return { reply: i18n.mm_embedded_signup_waiting[lang] }
    }

    case 'credentials': {
      // The signup link is always sent during the waba_check/waba_guide→credentials transition.
      // Any follow-up message here means the user is texting while waiting — reassure them.
      const waitingFallback = i18n.mm_embedded_signup_waiting[lang]
      const waitingReply = await generateProviderOnboardingReply({
        step: 'credentials_waiting',
        lang,
        collectedData: data.businessName ? { businessName: data.businessName } : {},
        fallback: waitingFallback,
      })
      return { reply: waitingReply }
    }

    default: {
      const waitingFallback2 = i18n.mm_embedded_signup_waiting[lang]
      const waitingReply2 = await generateProviderOnboardingReply({
        step: 'credentials_waiting',
        lang,
        collectedData: data.businessName ? { businessName: data.businessName } : {},
        fallback: waitingFallback2,
      })
      return { reply: waitingReply2 }
    }
  }
}

// ── Embedded Signup URL builder ───────────────────────────────────────────────

export function buildSignupUrl(state: string): string {
  const appId = process.env['META_APP_ID'] ?? ''
  const configId = process.env['META_EMBEDDED_SIGNUP_CONFIG_ID'] ?? ''
  const publicBaseUrl = process.env['PUBLIC_BASE_URL'] ?? ''
  const redirectUri = encodeURIComponent(`${publicBaseUrl}/oauth/meta/callback`)
  const scope = encodeURIComponent('whatsapp_business_management,whatsapp_business_messaging')
  const extras = encodeURIComponent(
    JSON.stringify({ setup: {}, featureType: 'whatsapp_embedded_signup', sessionInfoVersion: '3' }),
  )
  return `https://www.facebook.com/dialog/oauth?client_id=${appId}&config_id=${configId}&redirect_uri=${redirectUri}&scope=${scope}&state=${state}&display=page&response_type=code&extras=${extras}`
}

// ── Provisioning ──────────────────────────────────────────────────────────────

export async function provisionBusiness(
  db: Db,
  managerPhone: string,
  data: CollectedData,
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

  return { ok: true }
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

function detectsQuestion(text: string): boolean {
  const t = text.trim()
  return (
    t.includes('?') ||
    /^(what|how|why|where|when|who|can you|could you|please explain|מה|איך|למה|איפה|מתי|מי|תסביר|הסבר|לא מבין|לא מבינה)/i.test(t)
  )
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
