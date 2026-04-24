import { eq } from 'drizzle-orm'
import type { FastifyBaseLogger } from 'fastify'
import type { Db } from '../../db/client.js'
import { businesses, importTokens, managerInstructions } from '../../db/schema.js'
import type { Business, OnboardingStep } from '../../db/schema.js'
import type { InboundMessage } from '../../adapters/whatsapp/types.js'
import type { ResolvedIdentity } from '../identity/types.js'
import { classifyManagerInstruction } from '../../adapters/llm/client.js'
import { applyInstruction } from '../manager/apply.js'
import { ONBOARDING_PROMPTS, isAffirmative } from '../onboarding/steps.js'

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

  switch (step) {
    case 'business_name':
      return handleBusinessNameStep(db, msg, business, log)

    case 'services':
      return handleServiceStep(db, msg, identity, business, log)

    case 'hours':
      return handleHoursStep(db, msg, identity, business, log)

    case 'calendar':
      return handleCalendarStep(db, business, baseUrl)

    case 'customer_import':
      return handleCustomerImportStep(db, msg, business, baseUrl, log)

    case 'verify':
      return handleVerifyStep(db, business)
  }
}

async function handleBusinessNameStep(
  db: Db,
  msg: InboundMessage,
  business: Business,
  log: FastifyBaseLogger,
): Promise<OnboardingResult> {
  const displayName = msg.body.trim().slice(0, 100)
  await db
    .update(businesses)
    .set({ name: displayName, onboardingStep: 'services' })
    .where(eq(businesses.id, business.id))

  log.info({ businessId: business.id, displayName }, 'Onboarding: business name set')

  return { reply: `Got it — "${displayName}"!\n\n${ONBOARDING_PROMPTS.services.prompt}` }
}

async function handleServiceStep(
  db: Db,
  msg: InboundMessage,
  identity: ResolvedIdentity,
  business: Business,
  log: FastifyBaseLogger,
): Promise<OnboardingResult> {
  return applyOnboardingInstruction(
    db, msg, identity, business,
    'service_change',
    ONBOARDING_PROMPTS.services.retryPrompt!,
    async (confirmationMessage) => {
      await db.update(businesses).set({ onboardingStep: 'hours' }).where(eq(businesses.id, business.id))
      log.info({ businessId: business.id }, 'Onboarding: services step complete')
      return { reply: `${confirmationMessage}\n\n${ONBOARDING_PROMPTS.hours.prompt}` }
    },
  )
}

async function handleHoursStep(
  db: Db,
  msg: InboundMessage,
  identity: ResolvedIdentity,
  business: Business,
  log: FastifyBaseLogger,
): Promise<OnboardingResult> {
  return applyOnboardingInstruction(
    db, msg, identity, business,
    'availability_change',
    ONBOARDING_PROMPTS.hours.retryPrompt!,
    async (confirmationMessage) => {
      await db.update(businesses).set({ onboardingStep: 'calendar' }).where(eq(businesses.id, business.id))
      log.info({ businessId: business.id }, 'Onboarding: hours step complete')
      const calendarLink = buildCalendarLink(business)
      const calendarPrompt = ONBOARDING_PROMPTS.calendar.prompt.replace('{{OAUTH_LINK}}', calendarLink)
      return { reply: `${confirmationMessage}\n\n${calendarPrompt}` }
    },
  )
}

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

  // Insert a proper instruction record so applyInstruction can track status
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

async function handleCalendarStep(
  db: Db,
  business: Business,
  baseUrl: string,
): Promise<OnboardingResult> {
  // Step only advances when the OAuth callback fires — just resend the link
  const calendarLink = buildCalendarLink(business)
  const prompt = ONBOARDING_PROMPTS.calendar.prompt.replace('{{OAUTH_LINK}}', calendarLink)
  return { reply: `Waiting for calendar connection...\n\n${prompt}` }
}

async function handleCustomerImportStep(
  db: Db,
  msg: InboundMessage,
  business: Business,
  baseUrl: string,
  log: FastifyBaseLogger,
): Promise<OnboardingResult> {
  if (isAffirmative(msg.body)) {
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000)
    const [token] = await db
      .insert(importTokens)
      .values({
        businessId: business.id,
        managerPhone: msg.fromNumber,
        expiresAt,
      })
      .returning({ token: importTokens.token })

    log.info({ businessId: business.id }, 'Onboarding: import token generated')
    const uploadUrl = `${baseUrl}/import/${token!.token}`

    return {
      reply: `Here's your secure upload link (valid for 30 minutes):\n${uploadUrl}\n\nAccepted files:\n• Contacts CSV (name, phone)\n• Booking history CSV (name, phone, date, service)\n• Service catalog CSV (name, duration_minutes, price)\n\nUpload one or more, then come back here.`,
    }
  }

  // Skip — advance to verify
  await db.update(businesses).set({ onboardingStep: 'verify' }).where(eq(businesses.id, business.id))
  log.info({ businessId: business.id }, 'Onboarding: customer import skipped')

  return { reply: `No problem! You can always import data later.\n\n${ONBOARDING_PROMPTS.verify.prompt}` }
}

async function handleVerifyStep(db: Db, business: Business): Promise<OnboardingResult> {
  await db
    .update(businesses)
    .set({ onboardingCompletedAt: new Date(), onboardingStep: null })
    .where(eq(businesses.id, business.id))

  return {
    reply: `✅ Your PA is live!\n\nCustomers can now message ${business.whatsappNumber} to book appointments. You can manage everything by messaging me from this number.\n\nTry "STATUS" at any time to check your PA's health.`,
  }
}

function buildCalendarLink(business: Business): string {
  const base = process.env['PUBLIC_BASE_URL'] ?? `https://your-domain.com`
  return `${base}/oauth/google?businessId=${business.id}`
}
