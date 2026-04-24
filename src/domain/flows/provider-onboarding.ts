/**
 * Step 0 — Provider onboarding flow.
 *
 * Runs exclusively on the central provider number (PROVIDER_WA_NUMBER).
 * A business owner texts this number once to set up their PA.
 * On completion, their WABA number is registered in our system and they
 * are told to text their PA number directly — this number is never needed again.
 */

import { eq } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { providerOnboardingSessions, businesses, identities } from '../../db/schema.js'
import type { ProviderOnboardingSession } from '../../db/schema.js'

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
}

// ── Entry point ───────────────────────────────────────────────────────────────

export async function handleProviderOnboarding(
  db: Db,
  fromNumber: string,
  body: string,
): Promise<ProviderOnboardingResult> {
  let session = await loadSession(db, fromNumber)

  if (!session) {
    session = await createSession(db, fromNumber)
    return { reply: PROMPTS.business_name }
  }

  if (session.completedAt) {
    return { reply: 'Your PA is already set up! If you need help, contact support.' }
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

  switch (session.step) {
    case 'business_name': {
      const name = text.slice(0, 100)
      await advance(db, session.managerPhone, 'timezone', { ...data, businessName: name })
      return { reply: `Great, "${name}"!\n\n${PROMPTS.timezone}` }
    }

    case 'timezone': {
      const tz = resolveTimezone(text)
      if (!tz) {
        return { reply: `I didn't recognise that timezone. Please use an IANA name, for example:\n"Asia/Jerusalem", "America/New_York", "Europe/London"` }
      }
      await advance(db, session.managerPhone, 'calendar', { ...data, timezone: tz })
      return { reply: PROMPTS.calendar }
    }

    case 'calendar': {
      const calendarId = text.toLowerCase() === 'skip' ? null : text.trim()
      await advance(db, session.managerPhone, 'credentials', {
        ...data,
        calendarId,
      })
      return { reply: PROMPTS.credentials }
    }

    case 'credentials': {
      const parsed = parseCredentials(text)
      if (!parsed) {
        return { reply: RETRY_PROMPTS.credentials }
      }

      // Validate credentials + fetch the actual phone number from Meta
      const metaResult = await fetchPhoneNumberFromMeta(parsed.phoneNumberId, parsed.accessToken)
      if (!metaResult.ok) {
        return {
          reply: `I couldn't validate those credentials (${metaResult.error}).\n\nDouble-check your Phone Number ID and Access Token in Meta Business Manager, then try again.\n\n${RETRY_PROMPTS.credentials}`,
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
        return { reply: `Setup failed: ${provisionResult.error}. Please try again or contact support.` }
      }

      // Mark session complete
      await db
        .update(providerOnboardingSessions)
        .set({ completedAt: new Date(), collectedData: fullData as Record<string, unknown>, updatedAt: new Date() })
        .where(eq(providerOnboardingSessions.managerPhone, session.managerPhone))

      return {
        reply: `✅ Your PA is ready!\n\nPA number: *${paPhoneNumber}*\n\nNow text that number from your personal WhatsApp to complete setup (services, hours, calendar connection).\n\nYou won't need this number again — everything from here is managed through your PA number.`,
      }
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

// ── Prompts ───────────────────────────────────────────────────────────────────

const PROMPTS: Record<Step, string> = {
  business_name: `Welcome! 👋 I'll help you set up your WhatsApp PA in just a few steps.\n\nWhat's the name of your business?`,
  timezone: `What timezone is your business in?\n\nExamples: "Tel Aviv", "New York", "London", or an IANA name like "Asia/Jerusalem".`,
  calendar: `What's your Google Calendar ID? (Find it in Google Calendar → Settings → your calendar → Calendar ID — it usually looks like your email address.)\n\nSay "skip" to connect it later.`,
  credentials: `Last step! Share your WhatsApp Business API credentials from Meta Business Manager:\n\n• *Phone Number ID* — found under WhatsApp → Phone Numbers\n• *Access Token* — your System User permanent token\n\nSend them like this:\n\`ID: 123456789012345\nTOKEN: EAAxxxxxxxxx\``,
}

const RETRY_PROMPTS = {
  credentials: `Please send your credentials in this format:\n\`ID: 123456789012345\nTOKEN: EAAxxxxxxxxx\``,
}
