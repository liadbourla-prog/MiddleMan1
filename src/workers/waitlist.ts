import { Worker, Queue } from 'bullmq'
import { eq, and, asc, gte, lt, inArray, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { waitlist, identities, businesses, serviceTypes, bookings } from '../db/schema.js'
import { canSendFreeForm, sendTemplateMessage } from '../adapters/whatsapp/sender.js'
import { createCalendarClient } from '../adapters/calendar/client.js'
import { requestBooking } from '../domain/booking/engine.js'
import type { ResolvedIdentity } from '../domain/identity/types.js'
import { enqueueMessage } from './message-retry.js'
import { bodyComponents } from '../adapters/whatsapp/templates.js'
import { redisConnection } from '../redis.js'
import { logAudit } from '../domain/audit/logger.js'
import { i18n, type Lang } from '../domain/i18n/t.js'
import { generateProactiveCustomerMessage } from '../adapters/llm/client.js'
import { revalidateWaitlistSlotOpen } from './waitlist-revalidate.js'
import { rankWaitlistCandidates, waitlistTier } from '../domain/waitlist/priority.js'
import { releaseWaitlistHold } from '../domain/waitlist/accept.js'
import { queryCustomerSegment } from '../domain/crm/segment-repository.js'
import { selectColdFillCandidates } from '../domain/crm/cold-fill.js'
import { dispatchInitiation } from '../domain/initiations/dispatch.js'
import { getInitiator } from '../domain/initiations/registry.js'
import { evaluateBlastBreaker, resolveBlastBreaker } from '../domain/initiations/blast-breaker.js'
import type { BlastTally } from '../domain/initiations/blast-breaker.js'

const QUEUE_NAME = 'waitlist'
const OFFER_TTL_MINUTES = parseInt(process.env['WAITLIST_OFFER_TTL_MINUTES'] ?? '15', 10)
// Keep the cold-fill batch small: every invitee could accept, so a large batch raises
// double-book risk. The booking flow's availability check is the backstop if two accept.
const COLD_FILL_BATCH = 3

/** 14-day bucket index — a customer gets at most one cold-fill invite per bucket (design Q6). */
function biweekBucket(d: Date): number {
  return Math.floor(d.getTime() / (14 * 86_400_000))
}

/**
 * Cold-fill — the growth rung of the fill cascade (§7.5). Runs only when the waitlist FIFO
 * is exhausted AND the owner opted into auto-offering freed slots
 * (`freedSlotOfferPolicy === 'auto'`). Invites the best-fit lapsed customers for the
 * freed slot's service. All sends go through the initiation gate (opt-out + window).
 */
async function attemptColdFill(
  database: typeof db,
  { businessId, serviceTypeId, slotStart }: { businessId: string; serviceTypeId: string; slotStart: Date },
): Promise<void> {
  const [biz] = await database
    .select({
      name: businesses.name,
      timezone: businesses.timezone,
      defaultLanguage: businesses.defaultLanguage,
      freedSlotOfferPolicy: businesses.freedSlotOfferPolicy,
      whatsappPhoneNumberId: businesses.whatsappPhoneNumberId,
      whatsappAccessToken: businesses.whatsappAccessToken,
    })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)

  // Gate: cold-fill is off by default — only fires when the owner opted into auto-offering.
  if (!biz || biz.freedSlotOfferPolicy !== 'auto') return

  const candidates = await queryCustomerSegment(
    database,
    businessId,
    { serviceTypeId, lapsed: true, hasBooking: true },
    biz.timezone,
  )

  // Instructor-fit: who was due to take this slot? Customers loyal to that instructor are the
  // warmest invitees. Best-effort — null (solo operator / no scoped booking) falls back to recency.
  const [freed] = await database
    .select({ providerId: bookings.providerId })
    .from(bookings)
    .where(and(eq(bookings.businessId, businessId), eq(bookings.serviceTypeId, serviceTypeId), eq(bookings.slotStart, slotStart)))
    .limit(1)
  const picks = selectColdFillCandidates(candidates, { batchSize: COLD_FILL_BATCH, slotProviderId: freed?.providerId ?? null })

  const lang: Lang = (biz.defaultLanguage as Lang | null | undefined) ?? 'he'
  const locale = lang === 'he' ? 'he-IL' : 'en-GB'
  const localDateStr = new Intl.DateTimeFormat(locale, {
    timeZone: biz.timezone,
    weekday: 'long', day: 'numeric', month: 'long',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(slotStart)

  const [service] = await database
    .select({ name: serviceTypes.name })
    .from(serviceTypes)
    .where(eq(serviceTypes.id, serviceTypeId))
    .limit(1)
  const serviceName = service?.name ?? (lang === 'he' ? 'תור' : 'appointment')

  const creds = biz.whatsappPhoneNumberId && biz.whatsappAccessToken
    ? { accessToken: biz.whatsappAccessToken, phoneNumberId: biz.whatsappPhoneNumberId }
    : undefined

  // One bucket per ~now → at most one cold-fill invite per customer per 14 days.
  const bucket = biweekBucket(new Date())

  // Blast-radius breaker (Phase 5.4; design §4.6): a per-run ceiling plus abort-on-spike so a bad
  // template/segment can't hit the whole batch unnoticed. Cold-fill batches are small today, so it
  // rarely trips here — this establishes the primitive and the abort path.
  const breakerCfg = resolveBlastBreaker(getInitiator('coldfill.invite').blastBreaker)
  const tally: BlastTally = { sent: 0, optOuts: 0, errors: 0 }
  let aborted: string | null = null

  for (const pick of picks) {
    const verdict = evaluateBlastBreaker(tally, breakerCfg)
    if (verdict !== 'continue') { aborted = verdict; break }

    const name = pick.displayName ?? (lang === 'he' ? 'אורח/ת' : 'there')
    const situation = `A spot just opened for ${serviceName} at ${biz.name} on ${localDateStr} — we'd love to welcome ${name} back. Invite them naturally to take it; never say "reply YES".`
    const fallback = lang === 'he'
      ? `שלום! התפנה מקום ל${serviceName} ב${biz.name} ב-${localDateStr}. נשמח לראות אותך שוב — רוצה לקחת אותו?`
      : `Hi! A spot just opened for ${serviceName} at ${biz.name} on ${localDateStr}. We'd love to welcome you back — want to take it?`
    let dispatchError = false
    let decision
    try {
      decision = await dispatchInitiation(database, getInitiator('coldfill.invite'), {
        businessId,
        recipientId: pick.identityId,
        dedupKey: `coldfill.invite:${pick.identityId}:${bucket}`,
      }, {
        // Executors MUST throw on failure so dispatch.ts compensation can delete the
        // just-inserted ledger row and keep the dedup invariant: key only burns on
        // successful hand-off to the durable queue (E2/P7 fix).
        sendFreeForm: async () => {
          const body = await generateProactiveCustomerMessage({ businessName: biz.name, language: lang, situation, fallback, timeoutMs: 2500 })
          await enqueueMessage(businessId, pick.phoneNumber, body)
        },
        sendTemplate: async () => {
          // Out-of-window: coldfill_invite template — [business, service, date].
          // Template sends go through sendTemplateMessage directly; the throw propagates
          // to dispatch compensation on failure.
          await sendTemplateMessage({
            toNumber: pick.phoneNumber,
            templateName: 'coldfill_invite',
            languageCode: lang === 'he' ? 'he' : 'en',
            components: bodyComponents([biz.name, serviceName, localDateStr]),
            bodyText: fallback,
            ...(creds !== undefined && { credentials: creds }),
          })
        },
      })
    } catch {
      // Enqueue failed — dispatchInitiation already compensated the ledger row.
      // Count as error for the blast-breaker tally and continue the batch.
      dispatchError = true
    }
    // Tally outcomes for the breaker.
    if (decision?.kind === 'skip' && decision.reason === 'opted_out') tally.optOuts++
    else if (dispatchError) tally.errors++
    else if (decision?.kind !== 'skip') tally.sent++
  }

  await logAudit(database, {
    businessId,
    actorId: null,
    action: 'coldfill.attempted',
    entityType: 'initiation',
    metadata: { serviceTypeId, candidateCount: candidates.length, invited: picks.length, tally },
  })

  if (aborted) {
    await logAudit(database, {
      businessId,
      actorId: null,
      action: 'coldfill.aborted',
      entityType: 'initiation',
      metadata: { serviceTypeId, verdict: aborted, tally },
    })
  }
}

export const waitlistQueue = new Queue<WaitlistJob>(QUEUE_NAME, { connection: redisConnection })

interface WaitlistJob {
  type: 'offer_slot' | 'expire_offer'
  waitlistId?: string
  businessId: string
  serviceTypeId: string
  slotStart: string
  slotEnd: string
}

export async function triggerWaitlistForSlot(
  businessId: string,
  serviceTypeId: string,
  slotStart: Date,
  slotEnd: Date,
): Promise<void> {
  await waitlistQueue.add(
    'offer_slot',
    {
      type: 'offer_slot',
      businessId,
      serviceTypeId,
      slotStart: slotStart.toISOString(),
      slotEnd: slotEnd.toISOString(),
    },
    { attempts: 2, backoff: { type: 'fixed', delay: 5_000 } },
  )
}

/**
 * Build the calendar client the same way hold-expiry.ts / the offer_slot hold path do: empty access
 * token + the business's stored refresh token / calendar id, and the active manager's phone for any
 * manager-scoped calendar ops. Internal-mode businesses carry no google token and the client degrades
 * to internal mode (the booking row IS the hold). Used by the H1 single-releaser to clean up the
 * waitlist-created hold's calendar event on expiry.
 */
async function buildWaitlistCalendarClient(businessId: string) {
  const [biz] = await db
    .select({ googleRefreshToken: businesses.googleRefreshToken, googleCalendarId: businesses.googleCalendarId })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)

  const [holdManager] = await db
    .select({ phoneNumber: identities.phoneNumber })
    .from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.role, 'manager'), isNull(identities.revokedAt)))
    .limit(1)

  return createCalendarClient({
    accessToken: '',
    refreshToken: biz?.googleRefreshToken ?? '',
    calendarId: biz?.googleCalendarId ?? '',
    ...(holdManager ? { managerPhoneNumber: holdManager.phoneNumber } : {}),
  })
}

/**
 * Window-passed confirmation (plan §2 / WL-7): the offer window elapsed without a reply, so the held
 * seat was released. Warm, one sentence, invites them to ask again — durable (enqueueMessage), in the
 * customer's language. Voice-compliant (no menu, no "reply YES/NO", no bot-tells).
 */
async function sendWindowPassedMessage(businessId: string, customerId: string, serviceTypeId: string): Promise<void> {
  const [customer] = await db
    .select({ phoneNumber: identities.phoneNumber, preferredLanguage: identities.preferredLanguage })
    .from(identities)
    .where(eq(identities.id, customerId))
    .limit(1)
  if (!customer) return

  const [biz] = await db
    .select({ name: businesses.name, defaultLanguage: businesses.defaultLanguage })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)

  const [service] = await db
    .select({ name: serviceTypes.name })
    .from(serviceTypes)
    .where(eq(serviceTypes.id, serviceTypeId))
    .limit(1)

  const lang: Lang = (customer.preferredLanguage as Lang | null | undefined)
    ?? (biz?.defaultLanguage as Lang | null | undefined)
    ?? 'he'
  const serviceName = service?.name ?? (lang === 'he' ? 'תור' : 'appointment')
  const fallback = i18n.waitlist_window_passed[lang](serviceName)

  const situation = `The customer's waitlist offer window for "${serviceName}"${biz ? ` at ${biz.name}` : ''} passed without a reply, so the seat we were holding for them has been released. Tell them warmly in ONE short sentence and invite them to ask again whenever they'd like — never say "reply YES/NO" and never use a menu.`
  const body = await generateProactiveCustomerMessage({ businessName: biz?.name ?? '', language: lang, situation, fallback, timeoutMs: 2500 })
  await enqueueMessage(businessId, customer.phoneNumber, body)
}

/** @internal Exported for integration-test white-box access only. */
export async function processJob(job: { data: WaitlistJob }) {
  const { type, businessId, serviceTypeId, slotStart, slotEnd, waitlistId } = job.data

  if (type === 'expire_offer') {
    if (!waitlistId) return
    const [entry] = await db
      .select()
      .from(waitlist)
      .where(and(eq(waitlist.id, waitlistId), eq(waitlist.status, 'offered')))
      .limit(1)

    if (!entry) return

    // ── H1: expire_offer is the SINGLE authoritative releaser of the WL-5 hold ──────────
    // Order matters and is load-bearing (plan §3.3 / §8 H1):
    //   1. RELEASE the held booking FIRST (shared releaseWaitlistHold: CAS held→expired +
    //      calendar cleanup). The seat's active count drops to `cap` BEFORE the cascade places
    //      the next hold, so there is never a transient `cap+1` that would trip INV-11 / fail the
    //      next hold's capacity lock.
    //   2. Flip the waitlist row offered→expired.
    //   3. Tell the customer the window passed (durable, voice-compliant).
    //   4. Cascade to the next in line.
    //
    // hold-expiry.ts stays a NON-cascading, waitlist-unaware backstop. Its 60s grace
    // (HOLD_GRACE_PERIOD_SECONDS) means expire_offer (which fires exactly at holdExpiresAt) normally
    // wins this release CAS first; the backstop then sees a 0-row CAS and skips — so it never
    // double-messages and never cascades.
    const holdCalendar = await buildWaitlistCalendarClient(businessId)
    await releaseWaitlistHold(db, holdCalendar, businessId, entry.customerId, serviceTypeId, new Date(slotStart), 'waitlist-expire')

    await db.update(waitlist).set({ status: 'expired' }).where(eq(waitlist.id, waitlistId))

    await logAudit(db, {
      businessId,
      actorId: null,
      action: 'waitlist.offer_expired',
      entityType: 'waitlist',
      entityId: waitlistId,
      metadata: { slotStart, slotEnd },
    })

    // Window-passed confirmation (plan §2): warm, one sentence, invite them to ask again. Durable.
    await sendWindowPassedMessage(businessId, entry.customerId, serviceTypeId).catch(() => { /* best-effort */ })

    // Cascade to next in line
    await waitlistQueue.add('offer_slot', {
      type: 'offer_slot',
      businessId,
      serviceTypeId,
      slotStart,
      slotEnd,
    })
    return
  }

  // offer_slot: rank ALL pending entries by the fairness tier (WL-2a §3.2) then CAS-flip the
  // top survivor. Tier 1 (offered first) = no active booking in [now, now+7d]; tier 2 = has one.
  // FIFO within each tier. The single now anchors the 7-day commitment window for this run.
  const now = new Date()
  const windowEnd = new Date(now.getTime() + 7 * 86_400_000)

  const pending = await db
    .select()
    .from(waitlist)
    .where(
      and(
        eq(waitlist.businessId, businessId),
        eq(waitlist.serviceTypeId, serviceTypeId),
        eq(waitlist.slotStart, new Date(slotStart)),
        eq(waitlist.status, 'pending'),
      ),
    )
    .orderBy(asc(waitlist.createdAt))

  if (pending.length === 0) {
    // Waitlist FIFO exhausted → fall through to the cold-fill rung of the cascade.
    await attemptColdFill(db, { businessId, serviceTypeId, slotStart: new Date(slotStart) })
    return
  }

  // Per-candidate commitment flag: does this customer have an active booking (any service) at
  // this business within [now, now+7d]? Active states match ACTIVE_BOOKING_STATES (integrity.ts).
  const commitmentByEntryId = new Map<string, boolean>()
  for (const entry of pending) {
    const active = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.businessId, businessId),
          eq(bookings.customerId, entry.customerId),
          inArray(bookings.state, ['held', 'pending_payment', 'confirmed']),
          gte(bookings.slotStart, now),
          lt(bookings.slotStart, windowEnd),
        ),
      )
      .limit(1)
    commitmentByEntryId.set(entry.id, active.length > 0)
  }

  const ranked = rankWaitlistCandidates(pending, (entry) => commitmentByEntryId.get(entry.id) === true)

  const offerExpiresAt = new Date(Date.now() + OFFER_TTL_MINUTES * 60_000)

  // CAS promotion (E1/P1): include `status = 'pending'` in the WHERE so that two concurrent
  // offer_slot jobs racing on the same entry only ONE flips the row. Walk the ranked order:
  // a 0-row CAS means a concurrent job already took that entry — drop it and try the next.
  // CONTRACT: send the offer only for the entry whose CAS returned exactly 1 row.
  let next: (typeof ranked)[number] | undefined
  for (const candidate of ranked) {
    const flippedRows = await db
      .update(waitlist)
      .set({ status: 'offered', offeredAt: new Date(), offerExpiresAt })
      .where(and(eq(waitlist.id, candidate.id), eq(waitlist.status, 'pending')))
      .returning({ id: waitlist.id })
    if (flippedRows.length > 0) {
      next = candidate
      break
    }
  }

  if (!next) {
    // Every ranked entry was taken by a concurrent job — this job is the loser; do nothing.
    return
  }

  const winnerTier = waitlistTier(commitmentByEntryId.get(next.id) === true)

  // Fresh-spine re-validation (T2a.2 / H3/H18): between the freeing cancellation and now the
  // slot can be retaken. Never send a "spot opened" offer for a slot that is gone. Fail-open on
  // a read error (the booking-time check is the backstop). On a retaken slot, mark the entry
  // expired and stop — there is nothing to offer.
  const slotStillOpen = await revalidateWaitlistSlotOpen(db, businessId, serviceTypeId, new Date(slotStart)).catch(() => true)
  if (!slotStillOpen) {
    await db.update(waitlist).set({ status: 'expired' }).where(eq(waitlist.id, next.id))
    await logAudit(db, {
      businessId,
      actorId: null,
      action: 'waitlist.offer_slot_retaken',
      entityType: 'waitlist',
      entityId: next.id,
      metadata: { slotStart, slotEnd },
    })
    return
  }

  const [customer] = await db
    .select({ phoneNumber: identities.phoneNumber, preferredLanguage: identities.preferredLanguage, displayName: identities.displayName })
    .from(identities)
    .where(eq(identities.id, next.customerId))
    .limit(1)

  const [service] = await db
    .select({ name: serviceTypes.name })
    .from(serviceTypes)
    .where(eq(serviceTypes.id, serviceTypeId))
    .limit(1)

  const [biz] = await db
    .select({ name: businesses.name, timezone: businesses.timezone, defaultLanguage: businesses.defaultLanguage, whatsappPhoneNumberId: businesses.whatsappPhoneNumberId, whatsappAccessToken: businesses.whatsappAccessToken, googleRefreshToken: businesses.googleRefreshToken, googleCalendarId: businesses.googleCalendarId })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)

  // WL-5 (B2): place a GENUINE hold for the chosen winner BEFORE any offer goes out. Going
  // through the engine inherits the advisory-lock keying, the is_exclusive overlap constraint,
  // and correct `held`-state capacity semantics — never a hand-rolled insert. The hold expires
  // exactly at the offer window (offerExpiresAt). If the hold can't be placed (lost the capacity
  // race), NO offer is sent: revert this entry pending→pending and let the cascade pick it up.
  if (!customer || !biz) return

  // Build the calendar client the same way hold-expiry.ts does (lines ~94-112): empty access
  // token + the business's stored refresh token / calendar id, and the active manager's phone
  // for any manager-scoped calendar ops. Internal-mode businesses carry no google token and the
  // client degrades to internal mode (the booking row IS the hold).
  const [holdManager] = await db
    .select({ phoneNumber: identities.phoneNumber })
    .from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.role, 'manager'), isNull(identities.revokedAt)))
    .limit(1)

  const holdCalendar = createCalendarClient({
    accessToken: '',
    refreshToken: biz.googleRefreshToken ?? '',
    calendarId: biz.googleCalendarId,
    ...(holdManager ? { managerPhoneNumber: holdManager.phoneNumber } : {}),
  })

  // The waitlist customer as the booking actor (role:'customer' → the engine self-book path).
  const customerActor: ResolvedIdentity = {
    id: next.customerId,
    businessId,
    phoneNumber: customer.phoneNumber,
    role: 'customer',
    displayName: customer.displayName,
    messagingOptOut: false,
    preferredLanguage: (customer.preferredLanguage as 'he' | 'en' | null) ?? null,
    conversationPausedUntil: null,
  }

  const holdResult = await requestBooking(
    db,
    holdCalendar,
    customerActor,
    { serviceTypeId, slotStart: new Date(slotStart), slotEnd: new Date(slotEnd) },
    { waitlistHold: { holdExpiresAt: offerExpiresAt } },
  )

  if (!holdResult.ok) {
    // Lost the capacity race (or the seat was retaken). Revert the row offered→pending via a CAS
    // so it stays available for the cascade / next run, and do NOT send an offer (the plan: "if
    // the hold can't be placed, no offer goes out and the row stays pending").
    await db
      .update(waitlist)
      .set({ status: 'pending', offeredAt: null, offerExpiresAt: null })
      .where(and(eq(waitlist.id, next.id), eq(waitlist.status, 'offered')))
    await logAudit(db, {
      businessId,
      actorId: null,
      action: 'waitlist.hold_failed',
      entityType: 'waitlist',
      entityId: next.id,
      metadata: { slotStart, slotEnd, reason: holdResult.reason },
    })
    return
  }

  if (customer && biz) {
    const lang: Lang = (customer.preferredLanguage as Lang | null | undefined)
      ?? (biz.defaultLanguage as Lang | null | undefined)
      ?? 'he'
    const locale = lang === 'he' ? 'he-IL' : 'en-GB'
    const dateStr = new Intl.DateTimeFormat(locale, {
      timeZone: biz.timezone,
      weekday: 'long', day: 'numeric', month: 'long',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(slotStart))

    const waCredentials = biz.whatsappPhoneNumberId && biz.whatsappAccessToken
      ? { accessToken: biz.whatsappAccessToken, phoneNumberId: biz.whatsappPhoneNumberId }
      : undefined
    const serviceName = service?.name ?? (lang === 'he' ? 'תור' : 'appointment')
    const offerBody = i18n.waitlist_offer[lang](biz.name, serviceName, dateStr, OFFER_TTL_MINUTES)

    const freeFormAllowed = await canSendFreeForm(next.customerId)
    if (freeFormAllowed) {
      // Durable path: enqueueMessage hands off to the message-retry BullMQ queue so a
      // transient WA send failure is re-driven rather than silently lost (E2/P7 fix).
      // WL-5 (B2) framing: the seat is now GENUINELY held for THIS customer (a real `held`
      // booking placed above), so we tell them it's being kept for them for the offer window and
      // will be released if they don't reply in time. Voice-compliant: warm, ONE question, a
      // clear next step, never a "reply YES/NO" menu.
      const situation = `Great news for them: a spot just opened for "${serviceName}" at ${biz.name} on ${dateStr}, and you've placed a hold so it's being kept just for them for the next ${OFFER_TTL_MINUTES} minutes. Share it warmly, in ONE short message, and ask whether they'd like to take it. Make clear that if they don't reply within those ${OFFER_TTL_MINUTES} minutes the hold is released. Never say "reply YES/NO" and never use a menu.`
      const llmBody = await generateProactiveCustomerMessage({ businessName: biz.name, language: lang, situation, fallback: offerBody, timeoutMs: 2500 })
      await enqueueMessage(businessId, customer.phoneNumber, llmBody)
    } else {
      // Template path: sendTemplateMessage is NOT wrapped in catch — a failure propagates
      // to BullMQ's job-level retry (processJob runs with attempts: 2) rather than being
      // swallowed and lost (E2/P7 fix).
      await sendTemplateMessage({
        toNumber: customer.phoneNumber,
        templateName: 'waitlist_slot_offer',
        languageCode: lang === 'he' ? 'he' : 'en',
        components: [{
          type: 'body',
          parameters: [
            { type: 'text', text: biz.name },
            { type: 'text', text: serviceName },
            { type: 'text', text: dateStr },
            { type: 'text', text: String(OFFER_TTL_MINUTES) },
          ],
        }],
        bodyText: offerBody,
        ...(waCredentials !== undefined && { credentials: waCredentials }),
      })
    }
  }

  // Schedule expiry job
  await waitlistQueue.add(
    'expire_offer',
    { type: 'expire_offer', waitlistId: next.id, businessId, serviceTypeId, slotStart, slotEnd },
    { delay: OFFER_TTL_MINUTES * 60_000, attempts: 1 },
  )

  await logAudit(db, {
    businessId,
    actorId: null,
    action: 'waitlist.offer_sent',
    entityType: 'waitlist',
    entityId: next.id,
    metadata: { slotStart, offerExpiresAt, tier: winnerTier },
  })
}

export function startWaitlistWorker() {
  const worker = new Worker<WaitlistJob>(
    QUEUE_NAME,
    async (job) => processJob(job),
    { connection: redisConnection },
  )

  worker.on('failed', (job, err) => {
    console.error('[waitlist] Job failed', { jobId: job?.id, err: err.message })
  })

  return worker
}
