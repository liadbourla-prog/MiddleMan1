import type { FastifyInstance } from 'fastify'
import { eq, and, isNull, desc } from 'drizzle-orm'
import {
  verifySignature,
  verifyWebhookChallenge,
  normalizeWebhookPayload,
} from '../adapters/whatsapp/webhook.js'
import { sendMessage } from '../adapters/whatsapp/sender.js'
import { downloadAndUploadMedia } from '../adapters/whatsapp/media.js'
import type { WhatsAppWebhookPayload, InboundMessage } from '../adapters/whatsapp/types.js'
import { db } from '../db/client.js'
import { processedMessages, businesses, identities, managerMemory } from '../db/schema.js'
import type { Business } from '../db/schema.js'
import { resolveIdentity, registerCustomer } from '../domain/identity/resolver.js'
import type { ResolvedIdentity } from '../domain/identity/types.js'
import {
  loadActiveSession,
  createSession,
  completeSession,
  updateSessionContext,
  SESSION_EXPIRY,
} from '../domain/session/manager.js'
import { handleBookingFlow } from '../domain/flows/customer-booking.js'
import { parseConfirmation, type ManagerFlowContext } from '../domain/flows/types.js'
import { handleOnboardingMessage } from '../domain/flows/manager-onboarding.js'
import { handleProviderOnboarding } from '../domain/flows/provider-onboarding.js'
import { runManagerOrchestratorLoop } from '../adapters/llm/orchestrator.js'
import { loadDelegatedPermissions } from '../domain/authorization/permissions.js'
import { logAudit } from '../domain/audit/logger.js'
import { createCalendarClient } from '../adapters/calendar/client.js'
import {
  buildStatusReport,
  pausePA,
  resumePA,
  buildUpcomingReport,
  markEscalationHandled,
} from '../domain/manager/apply.js'
import { confirmPaymentReceived } from '../domain/booking/engine.js'
import { enqueueMessage } from '../workers/message-retry.js'
import { enqueueCustomerSummary } from '../workers/generate-customer-summary.js'
import { loadCustomerMemory } from '../domain/customer/profile.js'
import { buildHydratedContext, loadSessionCarryover } from '../domain/session/hydration.js'
import { saveMessage, loadTranscript } from '../domain/messages/repository.js'
import { i18n, detectLang, managerSwitchOfferSuffix, type Lang } from '../domain/i18n/t.js'
import { generateProactiveCustomerMessage, generateManagerCommandReply, generateProviderOnboardingReply } from '../adapters/llm/client.js'
import { dispatchSkill } from '../skills/index.js'
import { loadBusinessKnowledge } from '../domain/skills/knowledge-resolver.js'
import { loadActiveWorkflow } from '../domain/skills/workflow-helpers.js'
import { buildSkillContext } from '../domain/skills/context-builder.js'
import { withBusinessLock } from '../domain/flows/concurrency-lock.js'

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

      // Resolve the app secret to use for signature verification.
      // Different Meta apps (e.g. MiddleMan vs per-business PA numbers) have different
      // App Secrets. Extract the phone_number_id from the payload to find the business's
      // secret first; fall back to the global WHATSAPP_APP_SECRET (used by the MiddleMan).
      const appSecret = await resolveAppSecret(request.body)
      if (!verifySignature(rawBody, signature, appSecret)) {
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

export async function processInboundMessage(msg: InboundMessage, app: FastifyInstance) {
  // Step 0 — provider onboarding (central number, no business context)
  if (PROVIDER_WA_NUMBER && msg.toNumber === PROVIDER_WA_NUMBER) {
    if (msg.imageMediaId) {
      const imgFallback = `${i18n.non_text_reply.he}\n\n${i18n.non_text_reply.en}`
      const imgReply = await generateProviderOnboardingReply({
        step: 'image_not_supported',
        lang: 'bilingual',
        fallback: imgFallback,
      })
      await sendMessage(
        { toNumber: msg.fromNumber, body: imgReply },
        {
          accessToken: process.env['PROVIDER_WA_ACCESS_TOKEN'] ?? '',
          phoneNumberId: process.env['PROVIDER_WA_PHONE_NUMBER_ID'] ?? '',
        },
      )
      return
    }
    const result = await handleProviderOnboarding(db, msg.fromNumber, msg.body)
    const providerSendResult = await sendMessage(
      { toNumber: msg.fromNumber, body: result.reply },
      {
        accessToken: process.env['PROVIDER_WA_ACCESS_TOKEN'] ?? '',
        phoneNumberId: process.env['PROVIDER_WA_PHONE_NUMBER_ID'] ?? '',
      },
    )
    if (!providerSendResult.ok) {
      app.log.error({ error: providerSendResult.error, toNumber: msg.fromNumber }, 'Provider/operator send failed')
    }
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
      const revokedCreds = business.whatsappPhoneNumberId && business.whatsappAccessToken
        ? { accessToken: business.whatsappAccessToken, phoneNumberId: business.whatsappPhoneNumberId }
        : undefined
      const revokedFallback = i18n.revoked_access[lang]
      const revokedReply = await generateProactiveCustomerMessage({
        businessName: business.name,
        language: lang,
        situation: 'This person\'s access has been revoked. Tell them politely to contact the business directly.',
        fallback: revokedFallback,
        timeoutMs: 3000,
      })
      await sendMessage({ toNumber: msg.fromNumber, body: revokedReply }, revokedCreds)
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

/**
 * Resolves the correct App Secret for signature verification.
 * Different Meta apps (MiddleMan vs per-business PA numbers) have different App Secrets.
 * We extract the phone_number_id from the raw payload to look up the business's secret.
 * Falls back to the global WHATSAPP_APP_SECRET when no per-business secret is stored.
 */
async function resolveAppSecret(payload: WhatsAppWebhookPayload): Promise<string | undefined> {
  const globalSecret = process.env['WHATSAPP_APP_SECRET']
  try {
    const phoneNumberId = payload?.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id
    if (!phoneNumberId) return globalSecret

    // Check if the MiddleMan owns this phone number ID (fast path — no DB call)
    const providerPhoneNumberId = process.env['PROVIDER_WA_PHONE_NUMBER_ID'] ?? ''
    if (phoneNumberId === providerPhoneNumberId) return globalSecret

    // Look up per-business app secret
    const [biz] = await db
      .select({ waAppSecret: businesses.whatsappAppSecret })
      .from(businesses)
      .where(eq(businesses.whatsappPhoneNumberId, phoneNumberId))
      .limit(1)

    return biz?.waAppSecret ?? globalSecret
  } catch {
    return globalSecret
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

  const lang: Lang = (business.defaultLanguage as Lang | null | undefined) ?? 'he'
  await sendMessage({
    toNumber: managerIdentity.phoneNumber,
    body: i18n.manager_process_error[lang](msg.fromNumber, errorMsg.slice(0, 200)),
  }, waCredentials)
}

async function routeCustomerMessage(
  msg: InboundMessage,
  identity: ResolvedIdentity,
  business: Business,
  app: FastifyInstance,
) {
  const lang: Lang = (identity.preferredLanguage ?? business.defaultLanguage as Lang | null | undefined) ?? 'he'
  const waCredentials = business.whatsappPhoneNumberId && business.whatsappAccessToken
    ? { accessToken: business.whatsappAccessToken, phoneNumberId: business.whatsappPhoneNumberId }
    : undefined

  // Paused gate — PA is silent when owner has manually paused it
  if (business.paused) {
    const pausedFallback = i18n.paused_msg[lang](business.name)
    const pausedReply = await generateProactiveCustomerMessage({
      businessName: business.name,
      language: lang,
      situation: 'The PA is currently paused — the business is handling bookings directly. Tell the customer to contact the business directly for availability.',
      fallback: pausedFallback,
      timeoutMs: 3000,
    })
    await sendMessage({ toNumber: msg.fromNumber, body: pausedReply }, waCredentials)
    return
  }

  // Load or create session — hydrate new sessions with customer memory
  let session = await loadActiveSession(db, identity.id)
  let isFirstMessage = false
  // Tail of the customer's most recent prior session, when recent enough — gives a
  // continuing conversation its thread back across a terminal action or short gap.
  let carriedTurns: Array<{ role: 'customer' | 'assistant'; text: string }> = []
  if (!session) {
    isFirstMessage = true
    const [memory, carryover] = await Promise.all([
      loadCustomerMemory(db, identity.id),
      loadSessionCarryover(db, identity.id),
    ])
    const hydratedContext = await buildHydratedContext(db, identity.id, business.id, memory)
    // Carry forward conversational flags only (never booking state) so the PA
    // doesn't re-greet and keeps the chosen language.
    const seededContext: Record<string, unknown> = {
      ...(hydratedContext as unknown as Record<string, unknown>),
      ...(carryover?.greeted ? { greeted: true } : {}),
      ...(carryover?.detectedLanguage ? { detectedLanguage: carryover.detectedLanguage } : {}),
      ...(carryover?.languageOverride ? { languageOverride: carryover.languageOverride } : {}),
    }
    carriedTurns = carryover?.priorTurns ?? []
    session = await createSession(db, business.id, identity.id, 'booking')
    // Seed context so the flow handler and LLM have full customer picture from message 1
    await import('../domain/session/manager.js').then(({ updateSessionContext }) =>
      updateSessionContext(db, session!.id, seededContext)
    )
    session = { ...session, context: seededContext }
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
    lang,
    ...(managerIdentity ? { managerPhoneNumber: managerIdentity.phoneNumber } : {}),
  })

  // Save inbound message then load transcript — strictly scoped to this session
  await saveMessage(db, session.id, 'customer', msg.body).catch((err) => {
    app.log.warn({ err }, 'Failed to save inbound message to transcript')
  })
  const sessionTranscript = await loadTranscript(db, session.id, 8).catch(() => [])
  // Prepend carried-over turns from the prior session (if any) so the PA's reply
  // has the recent thread. These are context only — not re-persisted as messages.
  const transcript = carriedTurns.length > 0 ? [...carriedTurns, ...sessionTranscript] : sessionTranscript

  // Skills dispatch — runs before booking engine; first matching skill short-circuits
  const [businessKnowledge, workflowState] = await Promise.all([
    loadBusinessKnowledge(db, business.id, business.currency),
    loadActiveWorkflow(db, identity.id),
  ])

  // Image handling — download only for skills that support photos; others get non-text reply
  let uploadedImageUrl: string | null = null
  let uploadedImageMediaType: string | null = null
  if (msg.imageMediaId) {
    const imageSkills = new Set(['website-builder', 'google-business-setup'])
    const shouldUpload = workflowState?.skillName && imageSkills.has(workflowState.skillName)
    if (shouldUpload && business.whatsappAccessToken) {
      const mediaResult = await downloadAndUploadMedia({
        mediaId: msg.imageMediaId,
        accessToken: business.whatsappAccessToken,
        businessId: business.id,
        ...(msg.imageMediaType ? { mediaType: msg.imageMediaType } : {}),
      })
      if (mediaResult.ok) {
        uploadedImageUrl = mediaResult.publicUrl
        uploadedImageMediaType = mediaResult.mediaType
      } else {
        app.log.warn({ error: mediaResult.error, mediaId: msg.imageMediaId }, 'Customer image upload failed — proceeding without image')
      }
    } else {
      const nonTextFallback = i18n.non_text_reply[lang]
      const nonTextReply = await generateProactiveCustomerMessage({
        businessName: business.name,
        language: lang,
        situation: 'Customer sent an image or non-text message. Let them know this assistant only understands text messages and ask them to describe what they need.',
        fallback: nonTextFallback,
        timeoutMs: 3000,
      })
      await sendMessage({ toNumber: msg.fromNumber, body: nonTextReply }, waCredentials)
      return
    }
  }

  const skillCtx = await buildSkillContext({
    db,
    business,
    identity,
    session,
    messageText: msg.body,
    conversationHistory: transcript,
    language: lang,
    workflowState,
    businessKnowledge,
    ...(managerIdentity?.phoneNumber ? { managerPhone: managerIdentity.phoneNumber } : {}),
    ...(business.whatsappPhoneNumberId && business.whatsappAccessToken
      ? { waCredentials: { accessToken: business.whatsappAccessToken, phoneNumberId: business.whatsappPhoneNumberId } }
      : {}),
    imageUrl: uploadedImageUrl,
    imageMediaType: uploadedImageMediaType,
  })
  const skillOutcome = await dispatchSkill(skillCtx)
  if (skillOutcome?.handled) {
    await saveMessage(db, session.id, 'assistant', skillOutcome.reply).catch((err) => {
      app.log.warn({ err }, 'Failed to save skill reply to transcript')
    })
    await sendMessage({ toNumber: msg.fromNumber, body: skillOutcome.reply }, waCredentials)
    if (skillOutcome.sessionComplete) await completeSession(db, session.id)
    return
  }

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
    businessKnowledge,
    isFirstMessage,
  )

  // Conversation paused — manager is handling it; do not send any reply
  if (result.paused) return

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

  const sendResult = await sendMessage({ toNumber: msg.fromNumber, body: result.reply }, waCredentials)

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

  if (result.sessionComplete && !result.sessionFailed) {
    await completeSession(db, session.id)
    // Summarize the just-ended conversation for cross-session memory (best-effort).
    // Customer sessions usually end via this terminal path (a booking/cancel), so
    // the idle-expiry sweep alone would miss them.
    enqueueCustomerSummary(session.id, business.id, identity.id).catch((err) =>
      app.log.warn({ err }, 'Failed to enqueue customer summary'),
    )
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
    const onboardingSendResult = await sendMessage({ toNumber: msg.fromNumber, body: result.reply }, waCredentials)
    if (!onboardingSendResult.ok) {
      app.log.error({ error: onboardingSendResult.error, toNumber: msg.fromNumber }, 'Manager onboarding send failed')
    }
    return
  }

  // Keyword commands — intercepted before LLM to ensure they always work
  const upper = msg.body.trim().toUpperCase()
  const raw = msg.body.trim()
  // Keyword-command language: honor a persisted preference, else the business default.
  // Keywords are ASCII (STATUS/PAUSE/…), so per-message script detection is meaningless
  // here — that lives on the conversational orchestrator path below (§3.4).
  const defaultLang: Lang = (business.defaultLanguage as Lang | null | undefined) ?? 'he'
  const lang: Lang = identity.preferredLanguage ?? defaultLang

  if (upper === 'STATUS') {
    const rawReport = await buildStatusReport(db, business.id, lang)
    const report = await generateManagerCommandReply({
      businessName: business.name,
      language: lang,
      situation: 'Manager requested the PA status report.',
      dataBlock: rawReport,
      fallback: rawReport,
    })
    await sendMessage({ toNumber: msg.fromNumber, body: report }, waCredentials)
    return
  }

  if (upper === 'PAUSE') {
    await pausePA(db, business.id, lang)
    const reply = await generateManagerCommandReply({
      businessName: business.name,
      language: lang,
      situation: 'Manager paused the PA. It will no longer respond to customer messages until resumed. Confirm this and tell them to send RESUME to reactivate.',
      fallback: i18n.pause_confirm[lang],
    })
    await sendMessage({ toNumber: msg.fromNumber, body: reply }, waCredentials)
    return
  }

  if (upper === 'RESUME') {
    await resumePA(db, business.id, lang)
    const reply = await generateManagerCommandReply({
      businessName: business.name,
      language: lang,
      situation: 'Manager reactivated the PA. It will now respond to customer messages normally again. Confirm this briefly.',
      fallback: i18n.resume_confirm[lang],
    })
    await sendMessage({ toNumber: msg.fromNumber, body: reply }, waCredentials)
    return
  }

  if (upper === 'UPCOMING') {
    const rawReport = await buildUpcomingReport(db, business.id, undefined, lang)
    const report = await generateManagerCommandReply({
      businessName: business.name,
      language: lang,
      situation: 'Manager requested the list of upcoming confirmed bookings.',
      dataBlock: rawReport,
      fallback: rawReport,
    })
    await sendMessage({ toNumber: msg.fromNumber, body: report }, waCredentials)
    return
  }

  if (upper.startsWith('BOOKINGS ')) {
    const datePart = raw.slice('BOOKINGS '.length).trim()
    const rawReport = await buildUpcomingReport(db, business.id, datePart, lang)
    const report = await generateManagerCommandReply({
      businessName: business.name,
      language: lang,
      situation: `Manager requested bookings for date: ${datePart}.`,
      dataBlock: rawReport,
      fallback: rawReport,
    })
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
    const paidFallback = payResult.ok
      ? (lang === 'he' ? `✅ תשלום אושר עבור ${customerPhone}. התור נעול.` : `✅ Payment confirmed for ${customerPhone}. Booking locked in.`)
      : (lang === 'he' ? `❌ לא ניתן לאשר תשלום: ${payResult.reason}` : `❌ Could not confirm payment: ${payResult.reason}`)
    const situation = payResult.ok
      ? `Payment was confirmed for customer ${customerPhone}. Their booking is now locked in. Confirm this to the manager briefly.`
      : `Could not confirm payment for customer ${customerPhone}: ${payResult.reason}. Let the manager know briefly.`
    const reply = await generateManagerCommandReply({
      businessName: business.name,
      language: lang,
      situation,
      fallback: paidFallback,
    })
    await sendMessage({ toNumber: msg.fromNumber, body: reply }, waCredentials)
    return
  }

  if (upper.startsWith('HANDLED ')) {
    const customerPhone = raw.slice('HANDLED '.length).trim()
    await markEscalationHandled(db, business.id, customerPhone, lang)
    const reply = await generateManagerCommandReply({
      businessName: business.name,
      language: lang,
      situation: `Manager marked the escalation from ${customerPhone} as handled/resolved. Confirm briefly.`,
      fallback: i18n.escalation_handled[lang](customerPhone),
    })
    await sendMessage({ toNumber: msg.fromNumber, body: reply }, waCredentials)
    return
  }

  // Load or create 4h manager session for transcript continuity
  let mgSession = await loadActiveSession(db, identity.id)
  if (!mgSession) {
    mgSession = await createSession(db, business.id, identity.id, 'manager_instruction', SESSION_EXPIRY.manager)
  }
  await saveMessage(db, mgSession.id, 'customer', msg.body).catch((err) => {
    app.log.warn({ err }, 'Failed to save manager inbound message to transcript')
  })
  const mgTranscript = await loadTranscript(db, mgSession.id, 20).catch(() => [])

  // Skills dispatch for manager — runs before LLM instruction classifier
  {
    const [mgBusinessKnowledge, mgWorkflowState, mgMemoryRows] = await Promise.all([
      loadBusinessKnowledge(db, business.id, business.currency),
      loadActiveWorkflow(db, identity.id),
      db.select({ summary: managerMemory.summary })
        .from(managerMemory)
        .where(eq(managerMemory.identityId, identity.id))
        .orderBy(desc(managerMemory.createdAt))
        .limit(3),
    ])
    const mgMemorySummaries = mgMemoryRows.map((r) => r.summary)

    // Managers can always send images (for website-builder and google-business-setup)
    let mgUploadedImageUrl: string | null = null
    let mgUploadedImageMediaType: string | null = null
    if (msg.imageMediaId && business.whatsappAccessToken) {
      const mediaResult = await downloadAndUploadMedia({
        mediaId: msg.imageMediaId,
        accessToken: business.whatsappAccessToken,
        businessId: business.id,
        ...(msg.imageMediaType ? { mediaType: msg.imageMediaType } : {}),
      })
      if (mediaResult.ok) {
        mgUploadedImageUrl = mediaResult.publicUrl
        mgUploadedImageMediaType = mediaResult.mediaType
      } else {
        app.log.warn({ error: mediaResult.error, mediaId: msg.imageMediaId }, 'Manager image upload failed — proceeding without image')
      }
    }

    const mgSkillCtx = await buildSkillContext({
      db,
      business,
      identity,
      session: mgSession,
      messageText: msg.body,
      conversationHistory: mgTranscript,
      language: lang,
      workflowState: mgWorkflowState,
      businessKnowledge: mgBusinessKnowledge,
      managerPhone: identity.phoneNumber,
      ...(business.whatsappPhoneNumberId && business.whatsappAccessToken
        ? { waCredentials: { accessToken: business.whatsappAccessToken, phoneNumberId: business.whatsappPhoneNumberId } }
        : {}),
      ...(mgMemorySummaries.length > 0 ? { managerMemorySummaries: mgMemorySummaries } : {}),
      imageUrl: mgUploadedImageUrl,
      imageMediaType: mgUploadedImageMediaType,
    })
    const mgSkillOutcome = await dispatchSkill(mgSkillCtx)
    if (mgSkillOutcome?.handled) {
      await saveMessage(db, mgSession.id, 'assistant', mgSkillOutcome.reply).catch((err) => {
        app.log.warn({ err }, 'Failed to save manager skill reply to transcript')
      })
      await sendMessage({ toNumber: msg.fromNumber, body: mgSkillOutcome.reply }, waCredentials)
      return
    }
  }

  // ── Language-switch protocol (§3.4, Branch 3) ─────────────────────────────
  // Per-message detection, reply in the detected language, one appended inline
  // switch offer, persisted preference on confirmation. Mirrors Branch 4
  // (customer-booking.ts). Runs only on the conversational orchestrator path —
  // keyword commands and skills above keep their own language handling.
  const mgCtx = (mgSession.context as ManagerFlowContext | undefined) ?? {}
  // A locked override (persisted identity preference, or a session-level decline) wins.
  let sessionOverride: Lang | undefined = mgCtx.languageOverride

  // Answer to a previously-appended switch offer, before any orchestration.
  if (mgCtx.languageSwitchOfferPending && !identity.preferredLanguage && !sessionOverride) {
    const answer = parseConfirmation(msg.body)
    if (answer === 'yes') {
      // Offer only fires when detected !== default, and there are two languages,
      // so the accepted language is the opposite of the business default.
      const chosen: Lang = defaultLang === 'he' ? 'en' : 'he'
      await db.update(identities).set({ preferredLanguage: chosen }).where(eq(identities.id, identity.id)).catch(() => { /* non-fatal */ })
      await updateSessionContext(db, mgSession.id, { ...mgCtx, languageOverride: chosen, languageSwitchOfferPending: false }, undefined, SESSION_EXPIRY.manager)
      const ack = await generateManagerCommandReply({
        businessName: business.name,
        language: chosen,
        situation: 'The manager confirmed switching the conversation language. Acknowledge briefly in the new language and ask how you can help — do not re-introduce yourself.',
        fallback: chosen === 'he' ? 'מעולה, ממשיכים בעברית. במה אפשר לעזור?' : 'Great, switching to English. How can I help?',
      })
      await saveMessage(db, mgSession.id, 'assistant', ack).catch((err) => {
        app.log.warn({ err }, 'Failed to save manager language-switch ack to transcript')
      })
      await sendMessage({ toNumber: msg.fromNumber, body: ack }, waCredentials)
      return
    }
    if (answer === 'no') {
      // Decline locks the session to the default and re-processes the message in it.
      sessionOverride = defaultLang
      await updateSessionContext(db, mgSession.id, { ...mgCtx, languageOverride: defaultLang, languageSwitchOfferPending: false }, undefined, SESSION_EXPIRY.manager)
    }
    // 'unclear' — fall through; the offer is recomputed below and may be re-appended.
  }

  const effectiveOverride: Lang | undefined = identity.preferredLanguage ?? sessionOverride
  const detected = detectLang(msg.body)
  const turnLang: Lang = effectiveOverride ?? detected
  // Offer a switch when this turn's language differs from the default and nothing is locked.
  const shouldOfferSwitch = !effectiveOverride && detected !== defaultLang

  // Load business knowledge for orchestrator system prompt injection
  const [mgBusinessKnowledgeForOrchestrator] = await Promise.all([
    loadBusinessKnowledge(db, business.id, business.currency),
  ])

  const calendar = createCalendarClient({
    accessToken: '',
    refreshToken: business.googleRefreshToken ?? process.env['GOOGLE_REFRESH_TOKEN'] ?? '',
    calendarId: business.googleCalendarId,
    businessId: business.id,
    calendarMode: business.calendarMode,
    lang: turnLang,
  })

  // For delegated staff, load the actions the owner granted so config changes are
  // gated to exactly those. Managers are unrestricted (empty set is ignored).
  const delegatedPermissions = identity.role === 'delegated_user'
    ? await loadDelegatedPermissions(db, identity.id)
    : undefined

  const lockResult = await withBusinessLock(business.id, msg.messageId, async () => {
    const reply = await runManagerOrchestratorLoop({
      messageId: msg.messageId,
      message: msg.body,
      sessionId: mgSession.id,
      businessId: business.id,
      identityId: identity.id,
      businessName: business.name,
      timezone: business.timezone,
      lang: turnLang,
      calendar,
      transcript: mgTranscript,
      businessKnowledge: mgBusinessKnowledgeForOrchestrator,
      role: identity.role,
      ...(delegatedPermissions ? { delegatedPermissions } : {}),
    }).catch((err) => {
      app.log.error({ err, businessId: business.id }, 'Orchestrator loop threw')
      return i18n.manager_classify_error[turnLang]
    })

    // Append a single inline switch offer (§3.4) in the detected language — never bilingual.
    const finalReply = shouldOfferSwitch ? reply + managerSwitchOfferSuffix(detected) : reply

    // Persist the resolved language state: offer-pending for next turn, plus any
    // session-level override from a decline. Keep the 4h manager session window.
    await updateSessionContext(db, mgSession.id, {
      ...mgCtx,
      languageSwitchOfferPending: shouldOfferSwitch,
      ...(sessionOverride ? { languageOverride: sessionOverride } : {}),
    }, undefined, SESSION_EXPIRY.manager)

    await saveMessage(db, mgSession.id, 'assistant', finalReply).catch((err) => {
      app.log.warn({ err }, 'Failed to save manager orchestrator reply to transcript')
    })
    await sendMessage({ toNumber: msg.fromNumber, body: finalReply }, waCredentials)
  })

  if (lockResult === null) {
    // Message was queued behind an in-flight request for this business — silently drop
    app.log.info({ businessId: business.id, messageId: msg.messageId }, 'Manager message queued by concurrency lock')
  }
}
