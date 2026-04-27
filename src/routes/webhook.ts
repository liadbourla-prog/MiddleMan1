import type { FastifyInstance } from 'fastify'
import { eq, and, isNull } from 'drizzle-orm'
import {
  verifySignature,
  verifyWebhookChallenge,
  normalizeWebhookPayload,
} from '../adapters/whatsapp/webhook.js'
import { sendMessage } from '../adapters/whatsapp/sender.js'
import type { WhatsAppWebhookPayload, InboundMessage } from '../adapters/whatsapp/types.js'
import { db } from '../db/client.js'
import { processedMessages, businesses, managerInstructions, identities } from '../db/schema.js'
import type { Business } from '../db/schema.js'
import { resolveIdentity, registerCustomer } from '../domain/identity/resolver.js'
import type { ResolvedIdentity } from '../domain/identity/types.js'
import {
  loadActiveSession,
  createSession,
  completeSession,
} from '../domain/session/manager.js'
import { handleBookingFlow } from '../domain/flows/customer-booking.js'
import { handleOnboardingMessage } from '../domain/flows/manager-onboarding.js'
import { handleProviderOnboarding } from '../domain/flows/provider-onboarding.js'
import { classifyManagerInstruction } from '../adapters/llm/client.js'
import { logAudit } from '../domain/audit/logger.js'
import { createCalendarClient } from '../adapters/calendar/client.js'
import {
  applyInstruction,
  buildStatusReport,
  pausePA,
  resumePA,
  buildUpcomingReport,
  markEscalationHandled,
  checkServiceDeactivationSafety,
} from '../domain/manager/apply.js'
import { confirmPaymentReceived } from '../domain/booking/engine.js'
import { enqueueMessage } from '../workers/message-retry.js'
import { loadCustomerMemory } from '../domain/customer/profile.js'
import { buildHydratedContext } from '../domain/session/hydration.js'
import { checkBusinessHours, computeNextOpenMs } from '../domain/hours/gate.js'
import { queueMessageForLater } from '../workers/queued-messages.js'
import { saveMessage, loadTranscript } from '../domain/messages/repository.js'
import { i18n, type Lang } from '../domain/i18n/t.js'

export async function webhookRoutes(app: FastifyInstance) {
  // Webhook verification handshake (GET)
  app.get('/webhook', async (request, reply) => {
    const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } =
      request.query as Record<string, string>

    const result = verifyWebhookChallenge(mode ?? '', token ?? '', challenge ?? '')
    if (result === null) return reply.status(403).send('Forbidden')
    return reply.status(200).send(result)
  })

  // Inbound messages (POST)
  app.post<{ Body: WhatsAppWebhookPayload }>(
    '/webhook',
    { config: { rawBody: true } },
    async (request, reply) => {
      // Always 200 first — WhatsApp retries on non-200
      reply.status(200).send('OK')

      const signature = (request.headers['x-hub-signature-256'] as string) ?? ''
      const rawBody = (request as unknown as { rawBody: string }).rawBody

      if (!verifySignature(rawBody, signature)) {
        app.log.warn('WhatsApp webhook: invalid signature — dropping')
        return
      }

      const { messages, nonTextReplies } = normalizeWebhookPayload(request.body)

      // Reply to non-text messages immediately (no DB work needed)
      for (const { toNumber, body } of nonTextReplies) {
        await sendMessage({ toNumber, body }).catch(() => { /* fire-and-forget */ })
      }

      for (const msg of messages) {
        await processInboundMessage(msg, app).catch(async (err) => {
          app.log.error({ err, messageId: msg.messageId }, 'Unhandled error processing message')
          await notifyManagerOfError(msg, err instanceof Error ? err.message : String(err), app).catch(() => {/* fire-and-forget */})
        })
      }
    },
  )
}

const PROVIDER_WA_NUMBER = process.env['PROVIDER_WA_NUMBER'] ?? ''

async function processInboundMessage(msg: InboundMessage, app: FastifyInstance) {
  // Step 0 — provider onboarding (central number, no business context)
  if (PROVIDER_WA_NUMBER && msg.toNumber === PROVIDER_WA_NUMBER) {
    const result = await handleProviderOnboarding(db, msg.fromNumber, msg.body)
    await sendMessage(
      { toNumber: msg.fromNumber, body: result.reply },
      {
        accessToken: process.env['PROVIDER_WA_ACCESS_TOKEN'] ?? '',
        phoneNumberId: process.env['PROVIDER_WA_PHONE_NUMBER_ID'] ?? '',
      },
    )
    return
  }

  // Deduplication
  const duplicate = await db
    .select({ messageId: processedMessages.messageId })
    .from(processedMessages)
    .where(eq(processedMessages.messageId, msg.messageId))
    .limit(1)

  if (duplicate.length > 0) return

  // Find business by inbound number
  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.whatsappNumber, msg.toNumber))
    .limit(1)

  if (!business) {
    app.log.warn({ toNumber: msg.toNumber }, 'No business found for inbound number')
    return
  }

  // Mark processed before any work — safe against crash-restart double-processing
  await db
    .insert(processedMessages)
    .values({ messageId: msg.messageId, businessId: business.id })
    .onConflictDoNothing()

  // Resolve identity — auto-register unknowns as customers
  let identityResult = await resolveIdentity(db, business.id, msg.fromNumber)

  if (!identityResult.found) {
    if (identityResult.reason === 'revoked') {
      const lang: Lang = (business.defaultLanguage as Lang | null | undefined) ?? 'he'
      await sendMessage({
        toNumber: msg.fromNumber,
        body: i18n.revoked_access[lang],
      })
      return
    }
    await registerCustomer(db, business.id, msg.fromNumber)
    identityResult = await resolveIdentity(db, business.id, msg.fromNumber)
  }

  if (!identityResult.found) return
  const identity = identityResult.identity

  if (identity.messagingOptOut) {
    app.log.info({ phoneNumber: msg.fromNumber }, 'Skipping message — user has opted out of messaging')
    return
  }

  await logAudit(db, {
    businessId: business.id,
    actorId: identity.id,
    action: 'message.received',
    entityType: 'message',
    metadata: { messageId: msg.messageId, role: identity.role },
  })

  if (identity.role === 'manager' || identity.role === 'delegated_user') {
    await routeManagerMessage(msg, identity, business, app)
  } else {
    await routeCustomerMessage(msg, identity, business, app)
  }
}

async function notifyManagerOfError(msg: InboundMessage, errorMsg: string, app: FastifyInstance) {
  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.whatsappNumber, msg.toNumber))
    .limit(1)

  if (!business) return

  const [managerIdentity] = await db
    .select({ phoneNumber: identities.phoneNumber })
    .from(identities)
    .where(and(eq(identities.businessId, business.id), eq(identities.role, 'manager'), isNull(identities.revokedAt)))
    .limit(1)

  if (!managerIdentity) return

  const waCredentials = business.whatsappPhoneNumberId && business.whatsappAccessToken
    ? { accessToken: business.whatsappAccessToken, phoneNumberId: business.whatsappPhoneNumberId }
    : undefined

  await sendMessage({
    toNumber: managerIdentity.phoneNumber,
    body: `⚠️ A message from ${msg.fromNumber} could not be processed.\nError: ${errorMsg.slice(0, 200)}\n\nPlease follow up with the customer directly.`,
  }, waCredentials)
}

async function routeCustomerMessage(
  msg: InboundMessage,
  identity: ResolvedIdentity,
  business: Business,
  app: FastifyInstance,
) {
  const lang: Lang = (business.defaultLanguage as Lang | null | undefined) ?? 'he'

  // Business hours gate — queue messages when closed; managers always pass through
  if (!business.available247) {
    const hoursCheck = await checkBusinessHours(db, business)
    if (!hoursCheck.open) {
      const delayMs = await computeNextOpenMs(db, business)
      const opensAt = hoursCheck.opensAt ?? ''
      if (delayMs !== null && delayMs > 0) {
        await queueMessageForLater(business.id, msg.fromNumber, msg.toNumber, msg.body, delayMs)
        await sendMessage({
          toNumber: msg.fromNumber,
          body: i18n.closed_queued[lang](business.name, opensAt),
        })
      } else {
        await sendMessage({
          toNumber: msg.fromNumber,
          body: i18n.closed_drop[lang](business.name, opensAt),
        })
      }
      return
    }
  }

  // Paused gate — PA is silent when owner has manually paused it
  if (business.paused) {
    await sendMessage({
      toNumber: msg.fromNumber,
      body: i18n.paused_msg[lang](business.name),
    })
    return
  }

  // Load or create session — hydrate new sessions with customer memory
  let session = await loadActiveSession(db, identity.id)
  if (!session) {
    const memory = await loadCustomerMemory(db, identity.id)
    const hydratedContext = await buildHydratedContext(db, identity.id, business.id, memory)
    session = await createSession(db, business.id, identity.id, 'booking')
    // Seed context so the flow handler and LLM have full customer picture from message 1
    await import('../domain/session/manager.js').then(({ updateSessionContext }) =>
      updateSessionContext(db, session!.id, hydratedContext as unknown as Record<string, unknown>)
    )
    session = { ...session, context: hydratedContext as unknown as Record<string, unknown> }
  }

  const [managerIdentity] = await db
    .select({ phoneNumber: identities.phoneNumber })
    .from(identities)
    .where(and(eq(identities.businessId, business.id), eq(identities.role, 'manager'), isNull(identities.revokedAt)))
    .limit(1)

  const calendar = createCalendarClient({
    accessToken: '',
    refreshToken: business.googleRefreshToken ?? process.env['GOOGLE_REFRESH_TOKEN'] ?? '',
    calendarId: business.googleCalendarId,
    businessId: business.id,
    calendarMode: business.calendarMode,
    ...(managerIdentity ? { managerPhoneNumber: managerIdentity.phoneNumber } : {}),
  })

  // Save inbound message then load transcript — strictly scoped to this session
  await saveMessage(db, session.id, 'customer', msg.body).catch((err) => {
    app.log.warn({ err }, 'Failed to save inbound message to transcript')
  })
  const transcript = await loadTranscript(db, session.id, 8).catch(() => [])

  const result = await handleBookingFlow(
    db,
    calendar,
    identity,
    session,
    msg.body,
    business.timezone,
    business.name,
    transcript,
    business.botPersona,
    business,
    lang,
  )

  // Save outbound reply — failure must not kill the flow
  if (result.reply) {
    await saveMessage(db, session.id, 'assistant', result.reply).catch((err) => {
      app.log.warn({ err }, 'Failed to save outbound reply to transcript')
    })
  }

  // Silent escalation: owner configured zero customer reply — skip send entirely
  if (result.escalated && !result.reply) {
    if (result.sessionComplete) await completeSession(db, session.id)
    return
  }

  const sendResult = await sendMessage({ toNumber: msg.fromNumber, body: result.reply })

  if (!sendResult.ok) {
    if (sendResult.userOptedOut) {
      app.log.warn({ toNumber: msg.fromNumber }, 'User has opted out — marking messaging_opt_out')
      await db
        .update(identities)
        .set({ messagingOptOut: true })
        .where(and(eq(identities.businessId, business.id), eq(identities.phoneNumber, msg.fromNumber)))
        .catch((err) => app.log.error({ err }, 'Failed to mark opt-out'))
    } else {
      app.log.error({ error: sendResult.error, toNumber: msg.fromNumber }, 'Failed to send reply — enqueued for retry')
      await enqueueMessage(msg.fromNumber, result.reply).catch((err) => {
        app.log.error({ err }, 'Failed to enqueue message retry')
      })
    }
  }

  if (result.sessionComplete) {
    await completeSession(db, session.id)
  }
}

async function routeManagerMessage(
  msg: InboundMessage,
  identity: ResolvedIdentity,
  business: Business,
  app: FastifyInstance,
) {
  const waCredentials = business.whatsappPhoneNumberId && business.whatsappAccessToken
    ? { accessToken: business.whatsappAccessToken, phoneNumberId: business.whatsappPhoneNumberId }
    : undefined

  // Onboarding gate — intercept all messages until setup is complete
  if (!business.onboardingCompletedAt) {
    const baseUrl = process.env['PUBLIC_BASE_URL'] ?? 'https://your-domain.com'
    const result = await handleOnboardingMessage(db, msg, identity, business, baseUrl, app.log)
    await sendMessage({ toNumber: msg.fromNumber, body: result.reply }, waCredentials)
    return
  }

  // Keyword commands — intercepted before LLM to ensure they always work
  const upper = msg.body.trim().toUpperCase()
  const raw = msg.body.trim()
  const lang: Lang = (business.defaultLanguage as Lang | null | undefined) ?? 'he'

  if (upper === 'STATUS') {
    const report = await buildStatusReport(db, business.id, lang)
    await sendMessage({ toNumber: msg.fromNumber, body: report }, waCredentials)
    return
  }

  if (upper === 'PAUSE') {
    const reply = await pausePA(db, business.id, lang)
    await sendMessage({ toNumber: msg.fromNumber, body: reply }, waCredentials)
    return
  }

  if (upper === 'RESUME') {
    const reply = await resumePA(db, business.id, lang)
    await sendMessage({ toNumber: msg.fromNumber, body: reply }, waCredentials)
    return
  }

  if (upper === 'UPCOMING') {
    const report = await buildUpcomingReport(db, business.id, undefined, lang)
    await sendMessage({ toNumber: msg.fromNumber, body: report }, waCredentials)
    return
  }

  if (upper.startsWith('BOOKINGS ')) {
    const datePart = raw.slice('BOOKINGS '.length).trim()
    const report = await buildUpcomingReport(db, business.id, datePart, lang)
    await sendMessage({ toNumber: msg.fromNumber, body: report }, waCredentials)
    return
  }

  if (upper.startsWith('PAID ')) {
    const customerPhone = raw.slice('PAID '.length).trim()
    const calendar = createCalendarClient({
      accessToken: '',
      refreshToken: business.googleRefreshToken ?? process.env['GOOGLE_REFRESH_TOKEN'] ?? '',
      calendarId: business.googleCalendarId,
      businessId: business.id,
      calendarMode: business.calendarMode,
    })
    const payResult = await confirmPaymentReceived(db, calendar, business.id, customerPhone)
    const reply = payResult.ok
      ? (lang === 'he' ? `✅ תשלום אושר עבור ${customerPhone}. התור נעול.` : `✅ Payment confirmed for ${customerPhone}. Booking locked in.`)
      : (lang === 'he' ? `❌ לא ניתן לאשר תשלום: ${payResult.reason}` : `❌ Could not confirm payment: ${payResult.reason}`)
    await sendMessage({ toNumber: msg.fromNumber, body: reply }, waCredentials)
    return
  }

  if (upper.startsWith('HANDLED ')) {
    const customerPhone = raw.slice('HANDLED '.length).trim()
    const reply = await markEscalationHandled(db, business.id, customerPhone, lang)
    await sendMessage({ toNumber: msg.fromNumber, body: reply }, waCredentials)
    return
  }

  const classifyResult = await classifyManagerInstruction(msg.body, {
    businessId: business.id,
    timezone: business.timezone,
  })

  if (!classifyResult.ok) {
    app.log.error({ error: classifyResult.error }, 'LLM manager classification failed')
    await sendMessage({ toNumber: msg.fromNumber, body: i18n.manager_classify_error[lang] }, waCredentials)
    return
  }

  const instruction = classifyResult.data

  await db.insert(managerInstructions).values({
    businessId: business.id,
    identityId: identity.id,
    rawMessage: msg.body,
    receivedAt: msg.timestamp,
    classifiedAs: instruction.instructionType,
    structuredOutput: instruction as unknown as Record<string, unknown>,
    applyStatus: instruction.ambiguous ? 'requires_clarification' : 'pending',
    clarificationRequest: instruction.clarificationNeeded,
  })

  await logAudit(db, {
    businessId: business.id,
    actorId: identity.id,
    action: 'manager_instruction.received',
    entityType: 'manager_instruction',
    metadata: { type: instruction.instructionType, ambiguous: instruction.ambiguous },
  })

  if (instruction.ambiguous && instruction.clarificationNeeded) {
    await sendMessage({ toNumber: msg.fromNumber, body: instruction.clarificationNeeded }, waCredentials)
    return
  }

  const [savedInstruction] = await db
    .select({ id: managerInstructions.id })
    .from(managerInstructions)
    .where(
      and(
        eq(managerInstructions.businessId, business.id),
        eq(managerInstructions.identityId, identity.id),
        eq(managerInstructions.receivedAt, msg.timestamp),
      ),
    )
    .limit(1)

  if (!savedInstruction) {
    await sendMessage({ toNumber: msg.fromNumber, body: i18n.manager_save_error[lang] }, waCredentials)
    return
  }

  const applyResult = await applyInstruction(
    db,
    savedInstruction.id,
    business.id,
    identity.id,
    instruction.instructionType,
    instruction.structuredParams as Record<string, unknown>,
    lang,
  )

  const reply = applyResult.ok
    ? applyResult.confirmationMessage
    : i18n.manager_apply_error[lang](applyResult.reason)

  await sendMessage({ toNumber: msg.fromNumber, body: reply }, waCredentials)
}
