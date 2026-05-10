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
  phoneNumberId?: string
  accessToken?: string
  paPhoneNumber?: string
  language?: Lang
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
          await advance(db, session.managerPhone, 'credentials', {
            ...cleanData,
            services: [fallback],
          })
          return { reply: i18n.mm_ask_credentials[lang] }
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
      await advance(db, session.managerPhone, 'credentials', { ...cleanData, services: [parsed] })
      return { reply: i18n.mm_ask_credentials[lang] }
    }

    case 'credentials': {
      const helpCount = data._credentialHelpCount ?? 0

      // Partial credential detection: got one piece but not the other — be specific
      const hasId = /\d{10,20}/.test(text)
      const hasToken = /EAA[A-Za-z0-9]{5,}/.test(text)
      if (hasId && !hasToken) {
        const idMatch = text.match(/\d{10,20}/)!
        await db.update(providerOnboardingSessions)
          .set({ collectedData: { ...data, _credentialHelpCount: helpCount + 1 } as Record<string, unknown>, updatedAt: new Date() })
          .where(eq(providerOnboardingSessions.managerPhone, session.managerPhone))
        return { reply: i18n.mm_credentials_partial_id[lang](idMatch[0]) }
      }
      if (hasToken && !hasId) {
        await db.update(providerOnboardingSessions)
          .set({ collectedData: { ...data, _credentialHelpCount: helpCount + 1 } as Record<string, unknown>, updatedAt: new Date() })
          .where(eq(providerOnboardingSessions.managerPhone, session.managerPhone))
        return { reply: i18n.mm_credentials_partial_token[lang] }
      }

      if (detectsQuestion(text) && !isExpressingNoAccess(text)) {
        const explanation = await explainOnboardingConcept({ concept: 'credentials', userMessage: text, step: 'credentials', lang })
        if (explanation) return { reply: explanation }
      }

      // Confusion, help requests, or non-credential text — track repetitions
      if (isExpressingNoAccess(text) || isAskingForHelp(text) || !looksLikeCredentialAttempt(text)) {
        const newCount = helpCount + 1
        await db.update(providerOnboardingSessions)
          .set({ collectedData: { ...data, _credentialHelpCount: newCount } as Record<string, unknown>, updatedAt: new Date() })
          .where(eq(providerOnboardingSessions.managerPhone, session.managerPhone))
        // After 3 non-productive exchanges, switch to the empathetic stuck message
        if (newCount >= 3) return { reply: i18n.mm_credentials_stuck[lang] }
        return { reply: i18n.mm_credentials_help[lang] }
      }

      const parsed = parseCredentials(text)
      if (!parsed) {
        const newCount = helpCount + 1
        await db.update(providerOnboardingSessions)
          .set({ collectedData: { ...data, _credentialHelpCount: newCount } as Record<string, unknown>, updatedAt: new Date() })
          .where(eq(providerOnboardingSessions.managerPhone, session.managerPhone))
        if (newCount >= 3) return { reply: i18n.mm_credentials_stuck[lang] }
        return { reply: i18n.mm_credentials_help[lang] }
      }

      // Validate credentials + fetch the actual phone number from Meta
      const metaResult = await fetchPhoneNumberFromMeta(parsed.phoneNumberId, parsed.accessToken)
      if (!metaResult.ok) {
        return {
          reply: `${i18n.mm_credentials_error[lang](metaResult.error)}\n\n${i18n.mm_retry_credentials[lang]}`,
        }
      }

      const paPhoneNumber = metaResult.phoneNumber
      const fullData: CollectedData = {
        ...data,
        phoneNumberId: parsed.phoneNumberId,
        accessToken: parsed.accessToken,
        paPhoneNumber,
      }

      // Provision the business
      const provisionResult = await provisionBusiness(db, session.managerPhone, fullData)
      if (!provisionResult.ok) {
        return { reply: i18n.mm_setup_failed[lang](provisionResult.error) }
      }

      // Mark session complete
      await db
        .update(providerOnboardingSessions)
        .set({ completedAt: new Date(), collectedData: fullData as Record<string, unknown>, updatedAt: new Date() })
        .where(eq(providerOnboardingSessions.managerPhone, session.managerPhone))

      // Kick off BK Setup on the PA — send the opening prompt from the manager's PA to themselves
      // TODO: when BK setup skill exposes a constant, replace the string below with that import
      //       see src/skills/business-knowledge-setup/index.ts — 'brand-voice' step Q function
      const bkOpeningPrompt = lang === 'he'
        ? `לפני שהלקוחות מגיעים, בואנו נלמד על *${fullData.businessName}* כדי שאוכל לייצג אתכם הכי טוב.\n\nאיך היית מתאר/ת את *${fullData.businessName}*? מה הרגש שאתה/את רוצה שלקוחות יקבלו אחרי כל ביקור? מה מייחד אתכם?\n\n(ככל שתשתף/י יותר, כך אדבר טוב יותר בשמך)`
        : `Before customers arrive, let me get to know *${fullData.businessName}* so I can represent you well.\n\nHow would you describe *${fullData.businessName}*? What feeling do you want customers to walk away with? What makes you stand out?\n\n(The more detail you share, the better I'll speak in your voice)`

      await sendMessage(
        { toNumber: session.managerPhone, body: bkOpeningPrompt },
        { accessToken: fullData.accessToken!, phoneNumberId: fullData.phoneNumberId! },
      ).catch(() => {
        // BK setup kickoff is best-effort — provisioning already succeeded
      })

      return { reply: i18n.mm_done[lang](paPhoneNumber) }
    }
  }
}

// ── Provisioning ──────────────────────────────────────────────────────────────

async function provisionBusiness(
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

// ── Meta API ──────────────────────────────────────────────────────────────────

async function fetchPhoneNumberFromMeta(
  phoneNumberId: string,
  accessToken: string,
): Promise<{ ok: true; phoneNumber: string } | { ok: false; error: string }> {
  try {
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
    return { ok: true, phoneNumber: e164 }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
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
