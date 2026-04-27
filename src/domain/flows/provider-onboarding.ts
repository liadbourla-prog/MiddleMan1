/**
 * Step 0 — Provider onboarding flow + operator admin routing.
 *
 * Runs exclusively on the central provider number (PROVIDER_WA_NUMBER).
 * - If sender is OPERATOR_PHONE → routes to operator admin handler.
 * - Otherwise → new business owner onboarding (4-step conversation).
 *
 * On onboarding completion, their WABA number is registered and they
 * are told to text their PA number directly — this number is never needed again.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { providerOnboardingSessions, businesses, identities } from '../../db/schema.js'
import type { ProviderOnboardingSession } from '../../db/schema.js'
import { handleOperatorMessage } from './operator.js'
import { i18n, detectLang, type Lang } from '../i18n/t.js'

export interface ProviderOnboardingResult {
  reply: string
}

type Step = ProviderOnboardingSession['step']

type CollectedData = {
  businessName?: string
  timezone?: string
  calendarId?: string | null
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
    return handleOperatorMessage(db, body)
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
      const name = text.slice(0, 100)
      const detectedLang = detectLang(text)
      await advance(db, session.managerPhone, 'timezone', { ...data, businessName: name, language: detectedLang })
      const confirm = detectedLang === 'he' ? `מעולה, "${name}"!` : `Great, "${name}"!`
      return { reply: `${confirm}\n\n${i18n.mm_ask_timezone[detectedLang]}` }
    }

    case 'timezone': {
      const tz = resolveTimezone(text)
      if (!tz) {
        return { reply: i18n.mm_bad_timezone[lang] }
      }
      await advance(db, session.managerPhone, 'calendar', { ...data, timezone: tz })
      return { reply: i18n.mm_ask_calendar[lang] }
    }

    case 'calendar': {
      const calendarId = text.toLowerCase() === 'skip' ? null : text.trim()
      await advance(db, session.managerPhone, 'credentials', { ...data, calendarId })
      return { reply: i18n.mm_ask_credentials[lang] }
    }

    case 'credentials': {
      const parsed = parseCredentials(text)
      if (!parsed) {
        return { reply: i18n.mm_retry_credentials[lang] }
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
  const { businessName, timezone, calendarId, phoneNumberId, accessToken, paPhoneNumber } = data

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

  const [business] = await db
    .insert(businesses)
    .values({
      name: businessName,
      whatsappNumber: paPhoneNumber,
      whatsappPhoneNumberId: phoneNumberId,
      whatsappAccessToken: accessToken,
      googleCalendarId: calendarId ?? paPhoneNumber,
      timezone,
      onboardingStep: 'business_name',
    })
    .returning({ id: businesses.id })

  if (!business) return { ok: false, error: 'Failed to create business record' }

  await db.insert(identities).values({
    businessId: business.id,
    phoneNumber: managerPhone,
    role: 'manager',
    displayName: 'Owner',
  })

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

function resolveTimezone(input: string): string | null {
  const cleaned = input.trim()
  // Try as-is first (IANA format)
  if (isValidIANA(cleaned)) return cleaned

  // Common shorthand map
  const shortcuts: Record<string, string> = {
    'tel aviv': 'Asia/Jerusalem',
    israel: 'Asia/Jerusalem',
    jerusalem: 'Asia/Jerusalem',
    'new york': 'America/New_York',
    'new york city': 'America/New_York',
    nyc: 'America/New_York',
    london: 'Europe/London',
    uk: 'Europe/London',
    paris: 'Europe/Paris',
    dubai: 'Asia/Dubai',
    utc: 'UTC',
  }

  const mapped = shortcuts[cleaned.toLowerCase()]
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

