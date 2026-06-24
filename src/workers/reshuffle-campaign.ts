// Proactive Reshuffle Engine — BullMQ worker.
//
// Drives a campaign over time: tries to assemble a proposal from what's been agreed so far,
// otherwise sends the next outreach wave (direct occupant → broadcast), schedules a TTL tick,
// and terminates per the G-6 predicate. All decision logic lives in the pure modules; this
// file is the I/O wrapper (WhatsApp + persistence + scheduling).

import { Worker, Queue } from 'bullmq'
import { and, eq, ne } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  bookings, businesses, identities,
  reshuffleCampaigns, reshuffleOffers,
} from '../db/schema.js'
import { redisConnection } from '../redis.js'
import { sendMessage } from '../adapters/whatsapp/sender.js'
import { generateProactiveCustomerMessage } from '../adapters/llm/client.js'
import { dispatchInitiation } from '../domain/initiations/dispatch.js'
import { getInitiator } from '../domain/initiations/registry.js'
import { logAudit } from '../domain/audit/logger.js'
import { type Lang } from '../domain/i18n/t.js'
import { resolveReshuffleConfig } from '../domain/reshuffle/config.js'
import { assembleProposal } from '../domain/reshuffle/campaign.js'
import { approveProposal } from '../domain/reshuffle/gate.js'
import { selectBroadcastTargets, evaluateTermination, type OutreachCandidate } from '../domain/reshuffle/worker-logic.js'

const QUEUE_NAME = 'reshuffle-campaign'

interface ReshuffleJob {
  type: 'tick'
  campaignId: string
}

export const reshuffleQueue = new Queue<ReshuffleJob>(QUEUE_NAME, { connection: redisConnection })

/** Kick (or re-kick) a campaign — enqueue an immediate tick. */
export async function triggerReshuffleCampaign(campaignId: string): Promise<void> {
  await reshuffleQueue.add('tick', { type: 'tick', campaignId }, { attempts: 2, backoff: { type: 'fixed', delay: 5_000 } })
}

async function waCredentialsFor(businessId: string) {
  const [biz] = await db
    .select({
      name: businesses.name,
      timezone: businesses.timezone,
      defaultLanguage: businesses.defaultLanguage,
      phoneNumberId: businesses.whatsappPhoneNumberId,
      accessToken: businesses.whatsappAccessToken,
    })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)
  return biz
}

/** Send a warm, LLM-phrased probe to one customer asking if they'll take `slotStart`. */
async function sendProbe(
  businessId: string,
  businessName: string,
  lang: Lang,
  customerId: string,
  phoneNumber: string,
  slotStart: Date,
  timezone: string,
  creds: { accessToken: string; phoneNumberId: string } | undefined,
): Promise<boolean> {
  const locale = lang === 'he' ? 'he-IL' : 'en-GB'
  const dateStr = new Intl.DateTimeFormat(locale, {
    timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(slotStart)
  const situation = `We're trying to free up the schedule at ${businessName}. Ask the customer, warmly, whether they'd be willing to move their appointment to ${dateStr}. Make clear it's optional and nothing changes unless they agree. Never say "reply YES/NO" — invite a natural reply.`
  const fallback = lang === 'he'
    ? `שלום! נשמח לדעת אם יתאים לך להעביר את התור ל-${dateStr}? רק אם נוח לך — כלום לא משתנה בלי אישורך.`
    : `Hi! Would it work for you to move your appointment to ${dateStr}? Totally optional — nothing changes without your OK.`
  const decision = await dispatchInitiation(db, getInitiator('reshuffle.probe'), {
    businessId,
    recipientId: customerId,
    dedupKey: `reshuffle.probe:${customerId}:${slotStart.toISOString()}`,
  }, {
    sendFreeForm: async () => {
      const body = await generateProactiveCustomerMessage({ businessName, language: lang, situation, fallback, timeoutMs: 2500 })
      await sendMessage({ toNumber: phoneNumber, body }, creds).catch(() => { /* retry queue handles transient failures */ })
    },
  })
  return decision.kind === 'send_free_form'
}

/** Notify the manager that a solution is ready for approval. */
async function notifyOwnerProposalReady(businessId: string, campaignId: string, touchedCount: number): Promise<void> {
  const biz = await waCredentialsFor(businessId)
  if (!biz) return
  const [manager] = await db
    .select({ phoneNumber: identities.phoneNumber })
    .from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.role, 'manager')))
    .limit(1)
  if (!manager) return
  const lang: Lang = (biz.defaultLanguage as Lang) ?? 'he'
  const creds = biz.phoneNumberId && biz.accessToken ? { accessToken: biz.accessToken, phoneNumberId: biz.phoneNumberId } : undefined
  const situation = `A reschedule swap is ready that keeps the calendar full and moves ${touchedCount} appointment(s). Everyone involved already agreed. Tell the owner a plan is ready and ask if they'd like to approve it. Keep it short.`
  const fallback = lang === 'he'
    ? `מצאתי פתרון להזזת התור ששומר על לוח מלא (${touchedCount} שינויים), וכולם כבר הסכימו. לאשר?`
    : `I found a swap that keeps the calendar full (${touchedCount} change(s)) and everyone already agreed. Approve it?`
  const body = await generateProactiveCustomerMessage({ businessName: biz.name, language: lang, situation, fallback, timeoutMs: 2500 })
  await sendMessage({ toNumber: manager.phoneNumber, body }, creds).catch(() => { /* non-fatal */ })
}

/** Build the broadcast candidate pool from the snapshot of confirmed bookings + offers. */
async function buildCandidates(businessId: string, campaignId: string, requesterBookingId: string): Promise<OutreachCandidate[]> {
  const rows = await db
    .select({
      bookingId: bookings.id,
      customerId: bookings.customerId,
      serviceTypeId: bookings.serviceTypeId,
      optedOut: identities.messagingOptOut,
      vip: identities.vip,
    })
    .from(bookings)
    .innerJoin(identities, eq(bookings.customerId, identities.id))
    .where(and(eq(bookings.businessId, businessId), eq(bookings.state, 'confirmed'), ne(bookings.id, requesterBookingId)))

  const contacted = await db
    .select({ bookingId: reshuffleOffers.bookingId })
    .from(reshuffleOffers)
    .where(eq(reshuffleOffers.campaignId, campaignId))
  const contactedIds = new Set(contacted.map((c) => c.bookingId))

  return rows.map((r) => ({
    bookingId: r.bookingId,
    customerId: r.customerId,
    optedOut: r.optedOut,
    protected: r.vip, // near-term/recently-rescheduled are filtered in the solver snapshot; VIP excluded from outreach here
    serviceTypeId: r.serviceTypeId,
    alreadyContacted: contactedIds.has(r.bookingId),
  }))
}

export async function processCampaignTick(campaignId: string): Promise<void> {
  const [campaign] = await db.select().from(reshuffleCampaigns).where(eq(reshuffleCampaigns.id, campaignId)).limit(1)
  if (!campaign || campaign.status !== 'searching') return

  const config = resolveReshuffleConfig(campaign.configSnapshot)
  const now = new Date()

  // 1. Try to assemble a proposal from whatever has been agreed so far.
  const assembled = await assembleProposal(db, campaignId, now)
  if (assembled.ok) {
    if (config.approvalMode === 'auto_apply') {
      await approveProposal(db, assembled.proposalId, now).catch(() => { /* re-validation will guard */ })
    } else {
      await notifyOwnerProposalReady(campaign.businessId, campaignId, assembled.movedCount)
    }
    return
  }

  // 2. No solution yet → outreach. Direct rung first: offer the target occupant the freed slot.
  const [requesterBooking] = await db.select().from(bookings).where(eq(bookings.id, campaign.requesterBookingId)).limit(1)
  const biz = await waCredentialsFor(campaign.businessId)
  if (!requesterBooking || !biz) return
  const lang: Lang = (biz.defaultLanguage as Lang) ?? 'he'
  const creds = biz.phoneNumberId && biz.accessToken ? { accessToken: biz.accessToken, phoneNumberId: biz.phoneNumberId } : undefined
  const sA = requesterBooking.slotStart
  const sAEnd = requesterBooking.slotEnd
  const offerExpiresAt = new Date(now.getTime() + config.offerTtlMinutes * 60_000)

  let sentThisWave = 0

  const ladderHasDirect = config.escalationLadder.includes('direct')
  const ladderHasBroadcast = config.escalationLadder.includes('broadcast')

  // Direct rung: occupant of the target slot.
  const [occupant] = await db
    .select({ bookingId: bookings.id, customerId: bookings.customerId, phoneNumber: identities.phoneNumber })
    .from(bookings)
    .innerJoin(identities, eq(bookings.customerId, identities.id))
    .where(and(eq(bookings.businessId, campaign.businessId), eq(bookings.state, 'confirmed'), eq(bookings.slotStart, campaign.targetSlotStart)))
    .limit(1)

  if (ladderHasDirect && occupant) {
    const existing = await db
      .select({ id: reshuffleOffers.id })
      .from(reshuffleOffers)
      .where(and(eq(reshuffleOffers.campaignId, campaignId), eq(reshuffleOffers.bookingId, occupant.bookingId)))
      .limit(1)
    if (existing.length === 0) {
      await db.insert(reshuffleOffers).values({
        campaignId, customerId: occupant.customerId, bookingId: occupant.bookingId,
        proposedSlotStart: sA, proposedSlotEnd: sAEnd, status: 'probing', offerExpiresAt,
      })
      const sent = await sendProbe(campaign.businessId, biz.name, lang, occupant.customerId, occupant.phoneNumber, sA, biz.timezone, creds)
      if (sent) sentThisWave++
    }
  }

  // Broadcast rung: widen to the eligible pool in batches.
  if (ladderHasBroadcast && sentThisWave === 0) {
    const candidates = await buildCandidates(campaign.businessId, campaignId, campaign.requesterBookingId)
    const targets = selectBroadcastTargets(candidates, config, campaign.serviceTypeId, campaign.outreachCount)
    for (const target of targets) {
      const [who] = await db.select({ phoneNumber: identities.phoneNumber }).from(identities).where(eq(identities.id, target.customerId)).limit(1)
      if (!who) continue
      await db.insert(reshuffleOffers).values({
        campaignId, customerId: target.customerId, bookingId: target.bookingId,
        proposedSlotStart: sA, proposedSlotEnd: sAEnd, status: 'probing', offerExpiresAt,
      })
      const sent = await sendProbe(campaign.businessId, biz.name, lang, target.customerId, who.phoneNumber, sA, biz.timezone, creds)
      if (sent) sentThisWave++
    }
  }

  if (sentThisWave > 0) {
    await db
      .update(reshuffleCampaigns)
      .set({ outreachCount: campaign.outreachCount + sentThisWave, strategy: ladderHasDirect && occupant ? 'direct' : 'broadcast' })
      .where(eq(reshuffleCampaigns.id, campaignId))
    await logAudit(db, { businessId: campaign.businessId, actorId: null, action: 'reshuffle.wave_sent', entityType: 'reshuffle_campaign', entityId: campaignId, metadata: { sentThisWave } })
  }

  // 3. Termination check (G-6).
  const openOffers = await db
    .select({ id: reshuffleOffers.id })
    .from(reshuffleOffers)
    .where(and(eq(reshuffleOffers.campaignId, campaignId), eq(reshuffleOffers.status, 'probing')))
  const allCandidates = await buildCandidates(campaign.businessId, campaignId, campaign.requesterBookingId)
  const eligibleRemaining = allCandidates.filter((c) => !c.alreadyContacted && !c.protected && !(config.respectMessagingOptOut && c.optedOut)).length

  const verdict = evaluateTermination({
    hasSolution: false,
    laddersRemaining: 0, // single-pass ladder per tick; broadcast widens across ticks
    openOffers: openOffers.length,
    eligibleRemaining,
    contactedSoFar: campaign.outreachCount + sentThisWave,
    maxOutreach: config.maxOutreachPerCampaign,
  })

  if (verdict === 'exhausted') {
    await db.update(reshuffleCampaigns).set({ status: 'failed', resolvedAt: now }).where(eq(reshuffleCampaigns.id, campaignId))
    await logAudit(db, { businessId: campaign.businessId, actorId: null, action: 'reshuffle.failed', entityType: 'reshuffle_campaign', entityId: campaignId, metadata: { reason: 'no_solution' } })
    await notifyRequesterFailed(campaign.businessId, campaign.requesterId)
    return
  }

  // 4. Schedule the next tick after the offer TTL (re-checks replies, cascades, widens).
  // A scheduling hiccup must not crash the tick — the campaign simply won't re-tick until
  // the next inbound reply re-kicks it.
  await reshuffleQueue.add('tick', { type: 'tick', campaignId }, { delay: config.offerTtlMinutes * 60_000, attempts: 1 }).catch(() => { /* non-fatal */ })
}

async function notifyRequesterFailed(businessId: string, requesterId: string): Promise<void> {
  const biz = await waCredentialsFor(businessId)
  if (!biz) return
  const [who] = await db.select({ phoneNumber: identities.phoneNumber, lang: identities.preferredLanguage }).from(identities).where(eq(identities.id, requesterId)).limit(1)
  if (!who) return
  const lang: Lang = (who.lang as Lang) ?? (biz.defaultLanguage as Lang) ?? 'he'
  const creds = biz.phoneNumberId && biz.accessToken ? { accessToken: biz.accessToken, phoneNumberId: biz.phoneNumberId } : undefined
  const situation = `We tried but couldn't arrange the time swap they asked for. Reassure them their current appointment is unchanged and still booked. Keep it warm and brief.`
  const fallback = lang === 'he'
    ? 'לא הצלחנו לארגן את ההחלפה הפעם — אבל אל דאגה, התור הקיים שלך נשאר על כנו.'
    : "I couldn't arrange that swap this time — but no worries, your existing appointment is unchanged."
  const body = await generateProactiveCustomerMessage({ businessName: biz.name, language: lang, situation, fallback, timeoutMs: 2500 })
  await sendMessage({ toNumber: who.phoneNumber, body }, creds).catch(() => { /* non-fatal */ })
}

export function startReshuffleCampaignWorker() {
  const worker = new Worker<ReshuffleJob>(QUEUE_NAME, async (job) => processCampaignTick(job.data.campaignId), { connection: redisConnection })
  worker.on('failed', (job, err) => {
    console.error('[reshuffle] Job failed', { jobId: job?.id, err: err.message })
  })
  return worker
}
