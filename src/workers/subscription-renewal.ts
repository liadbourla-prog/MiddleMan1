// Subscription renewal-reminder initiator (Phase 4c): time-before reminders over the internal
// `subscriptions` table. There is NO external payment processor — "renewal" here is a reminder
// only (no auto-charge, no auto-advance): a subscription's `renewsAt` is just the scan anchor,
// and this worker reminds the customer 7 days and 1 day ahead. owner_configured + transactional:
// gated by the owner's `businesses.subscriptionRenewalEnabled` opt-in flag (default OFF, mirroring
// the Phase-4b proactiveWinbackEnabled precedent — a new boolean column rather than a new
// AutomatedMessagesConfig key, which would widen its keyof and break the skills config builder);
// the gate bypasses opt-out/quiet hours for the reminder family but still enforces
// in-window-only. Daily tick (renewal is a slow signal, like winback). Per subscription+cycle
// dedup via the initiation_log ledger makes re-ticks idempotent — the dedupKey carries the
// renews_at date so each renewal cycle gets a fresh reminder.

import { Worker, Queue } from 'bullmq'
import { eq, and, gte, lte } from 'drizzle-orm'
import { db } from '../db/client.js'
import { subscriptions, businesses, identities } from '../db/schema.js'
import { redisConnection } from '../redis.js'
import { enqueueMessage } from './message-retry.js'
import { logAudit } from '../domain/audit/logger.js'
import { type Lang } from '../domain/i18n/t.js'
import { generateProactiveCustomerMessage } from '../adapters/llm/client.js'
import { dispatchInitiation } from '../domain/initiations/dispatch.js'
import { getInitiator } from '../domain/initiations/registry.js'
import { renewalScanWindow, renewalTierForRenewsAt, initiatorIdForRenewalTier, type RenewalTier } from '../domain/crm/subscription-renewal.js'

const QUEUE_NAME = 'subscription-renewal'
const REPEAT_EVERY_MS = 24 * 60 * 60 * 1000 // daily — renewal is a slow signal

export const subscriptionRenewalQueue = new Queue(QUEUE_NAME, { connection: redisConnection })

interface RenewableSubscription {
  subscriptionId: string
  customerId: string
  customerPhone: string
  customerLang: Lang | null
  planName: string
  renewsAt: Date
  priceAmount: string | null
  priceCurrency: string | null
}

/** Send one renewal reminder through the gate (mirrors dunning.ts's free-form path). */
async function sendRenewal(
  tier: RenewalTier,
  s: RenewableSubscription,
  biz: { id: string; name: string; defaultLanguage: string | null },
): Promise<void> {
  const initiatorId = initiatorIdForRenewalTier(tier)
  const lang: Lang = s.customerLang ?? (biz.defaultLanguage as Lang | null | undefined) ?? 'he'
  const dateStr = s.renewsAt.toLocaleDateString(lang === 'he' ? 'he-IL' : 'en-GB')
  const priceStr = s.priceAmount ? `${s.priceAmount}${s.priceCurrency ? ` ${s.priceCurrency}` : ''}` : null

  let situation: string
  let fallback: string
  if (tier === 'renewal_7d') {
    situation = `The customer's "${s.planName}" subscription at ${biz.name} renews on ${dateStr}.${priceStr ? ` The renewal amount is ${priceStr}.` : ''} Send a warm, brief heads-up about the upcoming renewal and invite them to reply if they'd like to make any changes. Never pushy.`
    fallback = lang === 'he'
      ? `היי! רק תזכורת ידידותית שהמנוי "${s.planName}" שלך ב${biz.name} מתחדש בתאריך ${dateStr}.${priceStr ? ` הסכום: ${priceStr}.` : ''} אם תרצה/י לשנות משהו — פשוט כתבו לנו 🙂`
      : `Hi! Just a friendly heads-up that your "${s.planName}" subscription at ${biz.name} renews on ${dateStr}.${priceStr ? ` Amount: ${priceStr}.` : ''} If you'd like to make any changes, just reply 🙂`
  } else {
    situation = `The customer's "${s.planName}" subscription at ${biz.name} renews tomorrow (${dateStr}).${priceStr ? ` The renewal amount is ${priceStr}.` : ''} Send a warm, brief reminder that the renewal is tomorrow and invite them to reply if they'd like to make any changes. Never pushy.`
    fallback = lang === 'he'
      ? `היי! המנוי "${s.planName}" שלך ב${biz.name} מתחדש מחר (${dateStr}).${priceStr ? ` הסכום: ${priceStr}.` : ''} אם תרצה/י לשנות משהו — פשוט כתבו לנו 🙂`
      : `Hi! Your "${s.planName}" subscription at ${biz.name} renews tomorrow (${dateStr}).${priceStr ? ` Amount: ${priceStr}.` : ''} If you'd like to make any changes, just reply 🙂`
  }

  // Time-bucket the dedupKey on the renews_at date so each renewal cycle gets a fresh reminder.
  const renewsAtBucket = s.renewsAt.toISOString().slice(0, 10) // YYYY-MM-DD
  const dedupKey = `subscription.${tier}:${s.subscriptionId}:${renewsAtBucket}`

  await dispatchInitiation(db, getInitiator(initiatorId), {
    businessId: biz.id,
    recipientId: s.customerId,
    dedupKey,
  }, {
    sendFreeForm: async () => {
      const body = await generateProactiveCustomerMessage({ businessName: biz.name, language: lang, situation, fallback, timeoutMs: 2500 })
      await enqueueMessage(s.customerPhone, body)
    },
  })
}

/** Load active subscriptions whose renewsAt is inside the renewal scan window (joined to customer). */
async function renewableSubscriptions(
  businessId: string,
  window: { after: Date; before: Date },
): Promise<RenewableSubscription[]> {
  const rows = await db
    .select({
      subscriptionId: subscriptions.id,
      customerId: subscriptions.customerId,
      customerPhone: identities.phoneNumber,
      customerLang: identities.preferredLanguage,
      planName: subscriptions.planName,
      renewsAt: subscriptions.renewsAt,
      priceAmount: subscriptions.priceAmount,
      priceCurrency: subscriptions.priceCurrency,
    })
    .from(subscriptions)
    .innerJoin(identities, eq(subscriptions.customerId, identities.id))
    .where(and(
      eq(subscriptions.businessId, businessId),
      eq(subscriptions.status, 'active'),
      gte(subscriptions.renewsAt, window.after),
      lte(subscriptions.renewsAt, window.before),
    ))

  return rows.map((r) => ({
    subscriptionId: r.subscriptionId,
    customerId: r.customerId,
    customerPhone: r.customerPhone,
    customerLang: r.customerLang as Lang | null,
    planName: r.planName,
    renewsAt: r.renewsAt,
    priceAmount: r.priceAmount,
    priceCurrency: r.priceCurrency,
  }))
}

export async function runSubscriptionRenewalTick(now: Date = new Date()): Promise<void> {
  const bizRows = await db
    .select({ id: businesses.id, name: businesses.name, defaultLanguage: businesses.defaultLanguage, subscriptionRenewalEnabled: businesses.subscriptionRenewalEnabled })
    .from(businesses)
    .where(eq(businesses.subscriptionRenewalEnabled, true))

  const window = renewalScanWindow(now)

  for (const biz of bizRows) {
    try {
      const due = await renewableSubscriptions(biz.id, window)
      let sent = 0
      for (const s of due) {
        const tier = renewalTierForRenewsAt(now, s.renewsAt)
        if (tier === null) continue
        try {
          await sendRenewal(tier, s, biz)
          sent++
        } catch (err) {
          console.error('[subscription-renewal] send failed', { subscriptionId: s.subscriptionId, tier, err: (err as Error).message })
        }
      }
      if (sent > 0) {
        await logAudit(db, { businessId: biz.id, actorId: null, action: 'subscription_renewal.swept', entityType: 'initiation', metadata: { due: sent } })
      }
    } catch (err) {
      console.error('[subscription-renewal] business tick failed', { businessId: biz.id, err: (err as Error).message })
    }
  }
}

export function startSubscriptionRenewalWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async () => runSubscriptionRenewalTick(),
    { connection: redisConnection },
  )
  worker.on('failed', (job, err) => {
    console.error('[subscription-renewal] Job failed', { jobId: job?.id, err: err.message })
  })
  return worker
}

export async function scheduleSubscriptionRenewalJob() {
  await subscriptionRenewalQueue.add('tick', {}, { repeat: { every: REPEAT_EVERY_MS }, jobId: 'subscription-renewal-tick' })
}
