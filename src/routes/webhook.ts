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
import { handleReshuffleReply } from '../domain/reshuffle/inbound.js'
import { parseConfirmation, type ManagerFlowContext } from '../domain/flows/types.js'
import { resolveTurnLanguage } from '../domain/flows/language-switch.js'
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
import { findPendingOutreachForCustomer, enqueueOutreachReplyNotify, enqueueOutreachReplyFlush } from '../workers/outreach-reply-notify.js'
import { loadCustomerMemory } from '../domain/customer/profile.js'
import { buildHydratedContext, loadSessionCarryover } from '../domain/session/hydration.js'
import { saveMessage, loadTranscript } from '../domain/messages/repository.js'
import { i18n, managerSwitchOfferSuffix, type Lang } from '../domain/i18n/t.js'
import { generateProactiveCustomerMessage, generateManagerCommandReply, generateProviderOnboardingReply, generateOnboardingReply } from '../adapters/llm/client.js'
import { dispatchSkill } from '../skills/index.js'
import { loadBusinessKnowledge } from '../domain/skills/knowledge-resolver.js'
import { loadInstructorRoster, loadTeachingSchedule } from '../domain/provider/roster.js'
import { loadActiveWorkflow } from '../domain/skills/workflow-helpers.js'
import { buildSkillContext } from '../domain/skills/context-builder.js'
import { withBusinessLock, withIdentityLock } from '../domain/flows/concurrency-lock.js'
import { bufferInbound, flushBurst, combineInbound, shouldBypassCoalescing, debounceMsForRole, coalescingEnabled } from '../domain/flows/message-coalescer.js'
import { findActiveByContact } from '../domain/coordination/repository.js'
import { advanceFromContact, type BusinessCtx } from '../domain/coordination/handler.js'
import { resolveOutreachIntroducer } from '../domain/coordination/introducer.js'
import { isInboundBlocked } from './contact-gate.js'
import type { AllowedContact } from '../domain/manager/allowed-contacts.js'
import { notifyOwnerUnlistedContact } from '../domain/initiations/booking-notify.js'

// Re-export so callers/tests importing the gate from the webhook surface still resolve it.
export { isInboundBlocked } from './contact-gate.js'

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

      // Delivery-status callbacks (esp. `failed`): Meta accepts an out-of-window free-form send
      // synchronously (HTTP 200) then fails delivery asynchronously here. Reconcile so an
      // optimistic "sent" is corrected and the owner is told honestly. Best-effort, never blocks.
      await handleDeliveryStatuses(request.body, app).catch((err) => app.log.warn({ err }, 'Delivery-status handling failed'))

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

const WA_REENGAGEMENT_CODE = 131047 // Meta: free-form message outside the 24h window

/**
 * Reconcile Meta delivery-status callbacks. A `failed` status is the only signal that a message
 * Meta accepted synchronously (HTTP 200) was NOT actually delivered — most importantly the
 * re-engagement failure (131047) for a free-form send to an out-of-window customer. Without this,
 * an optimistic `outreach.message_sent` stands uncorrected and the owner is told a message went
 * out when it didn't. We log the failure to the ledger and tell the owner honestly.
 */
async function handleDeliveryStatuses(payload: WhatsAppWebhookPayload, app: FastifyInstance): Promise<void> {
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value
      const statuses = value?.statuses
      if (!statuses?.length) continue
      const phoneNumberId = value.metadata?.phone_number_id
      for (const st of statuses) {
        if (st.status !== 'failed') continue
        await handleFailedDelivery(phoneNumberId, st, app).catch((err) =>
          app.log.warn({ err, wamid: st.id }, 'Failed-delivery handling error'))
      }
    }
  }
}

async function handleFailedDelivery(
  phoneNumberId: string | undefined,
  st: { id: string; recipient_id: string; errors?: Array<{ code: number; title?: string; message?: string }> },
  app: FastifyInstance,
): Promise<void> {
  if (!phoneNumberId) return

  // Resolve the business that sent this. The MiddleMan/provider number isn't a business → skip.
  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.whatsappPhoneNumberId, phoneNumberId))
    .limit(1)
  if (!business) return

  // Dedup: one reconciliation per failed wamid (Meta may re-deliver the status).
  const inserted = await db
    .insert(processedMessages)
    .values({ messageId: `status:${st.id}`, businessId: business.id })
    .onConflictDoNothing()
    .returning({ messageId: processedMessages.messageId })
  if (inserted.length === 0) return

  const recipientPhone = st.recipient_id.startsWith('+') ? st.recipient_id : `+${st.recipient_id}`
  const errCode = st.errors?.[0]?.code
  const errTitle = st.errors?.[0]?.title ?? st.errors?.[0]?.message

  await logAudit(db, {
    businessId: business.id,
    actorId: null,
    action: 'whatsapp.delivery_failed',
    entityType: 'identity',
    metadata: { to: recipientPhone, wamid: st.id, code: errCode ?? null, title: errTitle ?? null },
  }).catch(() => { /* ledger write is best-effort */ })

  // Tell the owner honestly — but never about a failed send to the owner's own number (would loop).
  const [manager] = await db
    .select({ phoneNumber: identities.phoneNumber })
    .from(identities)
    .where(and(eq(identities.businessId, business.id), eq(identities.role, 'manager'), isNull(identities.revokedAt)))
    .limit(1)
  if (!manager?.phoneNumber || manager.phoneNumber === recipientPhone) return

  const [cust] = await db
    .select({ displayName: identities.displayName })
    .from(identities)
    .where(and(eq(identities.businessId, business.id), eq(identities.phoneNumber, recipientPhone)))
    .limit(1)

  const lang: Lang = (business.defaultLanguage as Lang | null | undefined) ?? 'he'
  const who = cust?.displayName ?? recipientPhone
  const reason = errCode === WA_REENGAGEMENT_CODE
    ? (lang === 'he'
      ? 'הם לא כתבו לנו ב-24 השעות האחרונות, אז וואטסאפ לא מאפשר לשלוח להם הודעה חופשית. אפשר לנסות שוב אחרי שהם יכתבו.'
      : "they haven't messaged us in the last 24 hours, so WhatsApp won't deliver a free-form message. We can try again once they write.")
    : (errTitle ?? (lang === 'he' ? 'המסירה נכשלה.' : 'delivery failed.'))
  const body = lang === 'he'
    ? `⚠️ שים לב: ההודעה ל${who} לא נמסרה בפועל — ${reason}`
    : `⚠️ Heads up: the message to ${who} wasn't actually delivered — ${reason}`

  const creds = business.whatsappPhoneNumberId && business.whatsappAccessToken
    ? { accessToken: business.whatsappAccessToken, phoneNumberId: business.whatsappPhoneNumberId }
    : undefined
  await sendMessage({ toNumber: manager.phoneNumber, body }, creds).catch(() => { /* best-effort */ })
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
    // Contact restriction: an unknown number is blocked unless on the allowlist. Silent to the
    // sender; forward the attempt to the owner. Evaluated before auto-registration so a blocked
    // number never becomes a customer identity.
    if (isInboundBlocked(business.contactRestrictionEnabled, business.allowedContacts as AllowedContact[] | null, msg.fromNumber, null)) {
      void notifyOwnerUnlistedContact(db, business.id, { fromNumber: msg.fromNumber, messageText: msg.body ?? '' })
      return
    }
    await registerCustomer(db, business.id, msg.fromNumber)
    identityResult = await resolveIdentity(db, business.id, msg.fromNumber)
  }

  if (!identityResult.found) return
  const identity = identityResult.identity

  // Contact restriction for an EXISTING identity (strict list — customers are not grandfathered).
  if (isInboundBlocked(business.contactRestrictionEnabled, business.allowedContacts as AllowedContact[] | null, msg.fromNumber, identity.role)) {
    void notifyOwnerUnlistedContact(db, business.id, { fromNumber: msg.fromNumber, messageText: msg.body ?? '' })
    return
  }

  // Record the inbound timestamp NOW — before any early return below (opt-out, coordination,
  // paused business) and before burst buffering. identities.lastInboundAt is the source of truth
  // for Meta's 24h customer-service window (canSendFreeForm); writing it here, unconditionally,
  // keeps it from going stale relative to Meta's real window and prevents false "24h limit" claims.
  await db
    .update(identities)
    .set({ lastInboundAt: new Date() })
    .where(eq(identities.id, identity.id))
    .catch((err) => app.log.warn({ err }, 'Failed to update lastInboundAt'))

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

  // Routing-first: an active coordination owns its counterparty's inbound (fixes the
  // customer-as-counterparty hijack). Falls through for everyone else.
  if (await tryAdvanceActiveCoordination(msg, identity, business)) return

  // Coalesce rapid bursts (Branch 3 & 4): a person sending one thought over several quick
  // messages must get one reply, not one per message. Buffer, wait for a short silence, then
  // process the whole burst as a single turn. Contacts and bypass cases (images, manager
  // keyword commands) route immediately. See message-coalescer.ts.
  if (!coalescingEnabled() || identity.role === 'contact' || shouldBypassCoalescing(msg, identity.role)) {
    await dispatchToRole(msg, identity, business, app)
    return
  }

  const seq = await bufferInbound(business.id, identity.id, msg)
  setTimeout(() => {
    void (async () => {
      try {
        const burst = await flushBurst(business.id, identity.id, seq)
        if (!burst) return // a newer message arrived during the window — it owns the flush
        await dispatchToRole(combineInbound(burst), identity, business, app)
      } catch (err) {
        app.log.error({ err, messageId: msg.messageId }, 'Coalesced burst flush failed')
        await notifyManagerOfError(msg, err instanceof Error ? err.message : String(err), app).catch(() => { /* fire-and-forget */ })
      }
    })()
  }, debounceMsForRole(identity.role))
}

// Run the per-role handler for a (possibly coalesced) message.
async function dispatchToRole(
  msg: InboundMessage,
  identity: ResolvedIdentity,
  business: Business,
  app: FastifyInstance,
) {
  if (identity.role === 'manager' || identity.role === 'delegated_user') {
    await routeManagerMessage(msg, identity, business, app)
  } else if (identity.role === 'contact') {
    await routeContactMessage(msg, identity, business, app)
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

// Routing-first interception: while a coordination is active, the counterparty's inbound
// belongs to that coordination — regardless of their role (customer or contact). Returns
// true if the message was handled (caller must then return). Gated to non-owner senders so
// the manager/delegated path is never touched. One indexed read; null for ~all customers.
export async function tryAdvanceActiveCoordination(
  msg: InboundMessage,
  identity: ResolvedIdentity,
  business: Business,
): Promise<boolean> {
  if (identity.role === 'manager' || identity.role === 'delegated_user') return false
  const active = await findActiveByContact(db, business.id, identity.id)
  if (!active) return false

  const lang: Lang = (identity.preferredLanguage ?? (business.defaultLanguage as Lang | null | undefined)) ?? 'he'
  const waCredentials = business.whatsappPhoneNumberId && business.whatsappAccessToken
    ? { accessToken: business.whatsappAccessToken, phoneNumberId: business.whatsappPhoneNumberId }
    : undefined
  const [mgr] = await db
    .select({ name: identities.displayName })
    .from(identities)
    .where(and(eq(identities.businessId, business.id), eq(identities.role, 'manager'), isNull(identities.revokedAt)))
    .limit(1)
  const introducer = resolveOutreachIntroducer({
    mode: (business.outreachIdentityMode as 'business' | 'owner_name' | null) ?? null,
    businessName: business.name,
    ownerName: mgr?.name ?? null,
    lang,
  })
  const calendar = createCalendarClient({
    accessToken: '',
    refreshToken: business.googleRefreshToken ?? process.env['GOOGLE_REFRESH_TOKEN'] ?? '',
    calendarId: business.googleCalendarId,
    businessId: business.id,
    calendarMode: business.calendarMode,
    lang,
  })
  const ctx: BusinessCtx = { businessId: business.id, businessName: business.name, lang, timezone: business.timezone, waCredentials, introducer }
  await advanceFromContact(db, calendar, active, msg.body, ctx)
  return true
}

export async function routeContactMessage(
  msg: InboundMessage,
  identity: ResolvedIdentity,
  business: Business,
  _app: FastifyInstance,
) {
  const lang: Lang = (identity.preferredLanguage ?? (business.defaultLanguage as Lang | null | undefined)) ?? 'he'
  const waCredentials = business.whatsappPhoneNumberId && business.whatsappAccessToken
    ? { accessToken: business.whatsappAccessToken, phoneNumberId: business.whatsappPhoneNumberId }
    : undefined

  const row = await findActiveByContact(db, business.id, identity.id)

  // No active coordination — relay the stray message to the owner so it's never dropped.
  if (!row) {
    const [manager] = await db
      .select({ phoneNumber: identities.phoneNumber })
      .from(identities)
      .where(and(eq(identities.businessId, business.id), eq(identities.role, 'manager'), isNull(identities.revokedAt)))
      .limit(1)
    if (manager?.phoneNumber) {
      const who = identity.displayName ?? msg.fromNumber
      const body = await generateProactiveCustomerMessage({
        businessName: business.name,
        language: lang,
        situation: `${who} (a contact you have no open meeting coordination with) messaged: "${msg.body}". Relay this to the owner briefly and ask if they want to do anything about it.`,
        fallback: i18n.outreach_reply_notify[lang](who, msg.body),
        timeoutMs: 2500,
      })
      await sendMessage({ toNumber: manager.phoneNumber, body }, waCredentials)
    }
    return
  }

  const calendar = createCalendarClient({
    accessToken: '',
    refreshToken: business.googleRefreshToken ?? process.env['GOOGLE_REFRESH_TOKEN'] ?? '',
    calendarId: business.googleCalendarId,
    businessId: business.id,
    calendarMode: business.calendarMode,
    lang,
  })
  const ctx: BusinessCtx = {
    businessId: business.id,
    businessName: business.name,
    lang,
    timezone: business.timezone,
    waCredentials,
  }
  await advanceFromContact(db, calendar, row, msg.body, ctx)
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

  // Serialize concurrent turns from the same customer. Two messages arriving close
  // together (past the burst-coalescer's debounce) would otherwise process in parallel
  // and race on the session row. The session load/create MUST be inside the lock so a
  // queued (serialized) turn re-reads the prior turn's committed session state.
  await withIdentityLock(identity.id, async () => {
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
    // Carry forward conversational flags + (Root C) a recent in-progress booking
    // draft so a flow that fragmented across a session boundary isn't restarted from
    // scratch. Still never carries live holds or reschedule targets — only data the
    // booking gates re-validate.
    const seededContext: Record<string, unknown> = {
      ...(hydratedContext as unknown as Record<string, unknown>),
      ...(carryover?.greeted ? { greeted: true } : {}),
      ...(carryover?.detectedLanguage ? { detectedLanguage: carryover.detectedLanguage } : {}),
      ...(carryover?.languageOverride ? { languageOverride: carryover.languageOverride } : {}),
      ...(carryover?.carriedDraft ? { slotDraft: carryover.carriedDraft } : {}),
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

  // Proactive outreach-reply notification: if this customer is one the PA recently reached
  // out to on a requester's behalf and that reply hasn't been relayed yet, treat this
  // inbound as the reply and ping the requester (off the hot path via a worker). Cheap
  // indexed check here; all send/dedupe work happens in the worker.
  findPendingOutreachForCustomer(business.id, identity.id)
    .then((pending) => {
      if (!pending) return
      return enqueueOutreachReplyNotify({ businessId: business.id, customerId: identity.id, outreachRowId: pending.id, replyText: msg.body })
    })
    .catch((err) => app.log.warn({ err }, 'Failed to enqueue outreach-reply notification'))
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

  // Reshuffle engine: if this customer has a live swap offer, their reply is an answer to
  // it — interpret and route it before the normal booking flow runs.
  const reshuffleReply = await handleReshuffleReply(db, identity.id, msg.body, lang)
  if (reshuffleReply.handled) {
    if (reshuffleReply.ack) {
      await saveMessage(db, session.id, 'assistant', reshuffleReply.ack).catch(() => { /* non-fatal */ })
      await sendMessage({ toNumber: msg.fromNumber, body: reshuffleReply.ack }, waCredentials)
    }
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
      await enqueueMessage(business.id, msg.fromNumber, result.reply).catch((err) => {
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
  })
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

  // Onboarding gate — intercept all messages until setup is complete. Plugged into
  // the same chat machinery the live manager path uses: a manager session for
  // transcript continuity (so replies vary — no repeated openers) + the §3.4
  // language switch. Reuses loadActiveSession/createSession/saveMessage/
  // loadTranscript/resolveTurnLanguage — nothing rebuilt.
  if (!business.onboardingCompletedAt) {
    const baseUrl = process.env['PUBLIC_BASE_URL'] ?? 'https://your-domain.com'
    const defaultLang: Lang = (business.defaultLanguage as Lang | null | undefined) ?? 'he'

    let obSession = await loadActiveSession(db, identity.id)
    if (!obSession) {
      obSession = await createSession(db, business.id, identity.id, 'manager_instruction', SESSION_EXPIRY.manager)
    }
    const obCtx = (obSession.context as ManagerFlowContext | undefined) ?? {}
    let sessionOverride: Lang | undefined = obCtx.languageOverride

    // Answer to a previously-appended switch offer, before any step processing.
    if (obCtx.languageSwitchOfferPending && !identity.preferredLanguage && !sessionOverride) {
      const answer = parseConfirmation(msg.body)
      if (answer === 'yes') {
        const chosen: Lang = defaultLang === 'he' ? 'en' : 'he'
        await db.update(identities).set({ preferredLanguage: chosen }).where(eq(identities.id, identity.id)).catch(() => { /* non-fatal */ })
        await updateSessionContext(db, obSession.id, { ...obCtx, languageOverride: chosen, languageSwitchOfferPending: false }, undefined, SESSION_EXPIRY.manager)
        const ack = await generateOnboardingReply({
          step: business.onboardingStep ?? 'business_name',
          businessName: business.name,
          lang: chosen,
          isRetry: false,
          extraContext: 'The owner just confirmed continuing in this language. Acknowledge in one short phrase, then re-ask the current setup question.',
        })
        // generateOnboardingReply returns '' on LLM failure; WhatsApp rejects an
        // empty body, so fall back to a non-empty line (mirrors the live path).
        const ackBody = ack || (chosen === 'he'
          ? 'מעולה, ממשיכים בעברית. בוא נמשיך מאיפה שהפסקנו.'
          : "Great, switching to English. Let's pick up where we left off.")
        await saveMessage(db, obSession.id, 'assistant', ackBody).catch(() => { /* non-fatal */ })
        const ackSendResult = await sendMessage({ toNumber: msg.fromNumber, body: ackBody }, waCredentials)
        if (!ackSendResult.ok) {
          app.log.error({ error: ackSendResult.error, toNumber: msg.fromNumber }, 'Manager onboarding language-switch ack send failed')
        }
        return
      }
      if (answer === 'no') {
        sessionOverride = defaultLang
        await updateSessionContext(db, obSession.id, { ...obCtx, languageOverride: defaultLang, languageSwitchOfferPending: false }, undefined, SESSION_EXPIRY.manager)
      }
      // 'unclear' — fall through; offer may be re-appended below.
    }

    const { turnLang, detected, shouldOfferSwitch } = resolveTurnLanguage({
      body: msg.body,
      defaultLang,
      preferredLanguage: identity.preferredLanguage,
      sessionOverride,
    })

    await saveMessage(db, obSession.id, 'customer', msg.body).catch((err) => {
      app.log.warn({ err }, 'Failed to save onboarding inbound message to transcript')
    })
    const obTranscript = await loadTranscript(db, obSession.id, 10).catch(() => [])

    const result = await handleOnboardingMessage(db, msg, identity, business, baseUrl, app.log, turnLang, obTranscript)
    const reply = shouldOfferSwitch ? result.reply + managerSwitchOfferSuffix(detected) : result.reply

    await updateSessionContext(db, obSession.id, {
      ...obCtx,
      languageSwitchOfferPending: shouldOfferSwitch,
      ...(sessionOverride ? { languageOverride: sessionOverride } : {}),
    }, undefined, SESSION_EXPIRY.manager).catch(() => { /* non-fatal */ })

    await saveMessage(db, obSession.id, 'assistant', reply).catch((err) => {
      app.log.warn({ err }, 'Failed to save onboarding outbound message to transcript')
    })

    const onboardingSendResult = await sendMessage({ toNumber: msg.fromNumber, body: reply }, waCredentials)
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

  // The requester just messaged us — their WhatsApp window is open. Flush any outreach-reply
  // notifications that were deferred because the window was previously closed (worker no-ops
  // when there are none). Fire-and-forget; never blocks the manager's own message.
  enqueueOutreachReplyFlush(business.id, identity.id)
    .catch((err) => app.log.warn({ err }, 'Failed to enqueue outreach-reply flush'))

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

  const { turnLang, detected, shouldOfferSwitch } = resolveTurnLanguage({
    body: msg.body,
    defaultLang,
    preferredLanguage: identity.preferredLanguage,
    sessionOverride,
  })

  // Load business knowledge + instructor roster for orchestrator system prompt injection
  const [mgBusinessKnowledgeForOrchestrator, mgInstructorRoster, mgTeachingSchedule] = await Promise.all([
    loadBusinessKnowledge(db, business.id, business.currency),
    loadInstructorRoster(db, business.id),
    loadTeachingSchedule(db, business.id, business.timezone),
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
      calendarMode: business.calendarMode,
      transcript: mgTranscript,
      businessKnowledge: mgBusinessKnowledgeForOrchestrator,
      instructorRoster: mgInstructorRoster,
      teachingSchedule: mgTeachingSchedule,
      role: identity.role,
      ...(delegatedPermissions ? { delegatedPermissions } : {}),
      ...(mgCtx.negotiationConstraints ? { negotiationConstraints: mgCtx.negotiationConstraints } : {}),
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
