// Payment-dunning autonomous initiator (Phase 4b): escalating nudges for bookings stuck in
// internal `pending_payment` state. No external payment processor — a booking sits in
// pending_payment from the moment payment becomes due (createdAt) and the hold-expiry worker
// never touches it, so it would otherwise persist indefinitely. This worker ticks hourly and
// sends one of three escalating rungs based on how long the booking has been awaiting payment.
// owner_configured + transactional: gated by the owner's EXISTING
// automatedMessagesConfig.payment_request.enabled flag (this worker is its consumer); the gate
// bypasses opt-out/quiet hours for "payment due" but still enforces in-window-only. Per
// booking+tier dedup via the initiation_log ledger makes re-ticks idempotent.

import { Worker, Queue } from 'bullmq'
import { eq, and, gte, lte } from 'drizzle-orm'
import { db } from '../db/client.js'
import { bookings, businesses, identities, serviceTypes } from '../db/schema.js'
import type { AutomatedMessagesConfig } from '../shared/skill-types.js'
import { redisConnection } from '../redis.js'
import { enqueueMessage } from './message-retry.js'
import { logAudit } from '../domain/audit/logger.js'
import { type Lang } from '../domain/i18n/t.js'
import { generateProactiveCustomerMessage } from '../adapters/llm/client.js'
import { sendTemplateMessage } from '../adapters/whatsapp/sender.js'
import { bodyComponents } from '../adapters/whatsapp/templates.js'
import { dispatchInitiation } from '../domain/initiations/dispatch.js'
import { getInitiator } from '../domain/initiations/registry.js'
import { dunningActiveWindow, dunningTierForAge, initiatorIdForTier, type DunningTier } from '../domain/crm/dunning.js'
import { createCharge } from '../domain/payments/service.js'

const QUEUE_NAME = 'dunning'
const REPEAT_EVERY_MS = 60 * 60 * 1000 // hourly

export const dunningQueue = new Queue(QUEUE_NAME, { connection: redisConnection })

interface DunnableBooking {
  bookingId: string
  customerId: string
  customerPhone: string
  customerName: string | null
  customerLang: Lang | null
  serviceName: string | null
  amount: string | null
  createdAt: Date
}

/**
 * Resolve the live Grow pay-link for this booking so the dunning nudge carries a real link
 * instead of a bare "please pay" (design §7). createCharge is idempotent per booking: it
 * reuses the link the payment.request initiator already created, or mints one now. Returns
 * null when payments aren't connected / the amount is unknown / Grow erred — the caller then
 * sends the linkless nudge (graceful degradation, the pre-Phase-3 behavior).
 */
async function livePayLink(
  b: DunnableBooking,
  biz: { id: string; name: string },
  serviceName: string,
): Promise<string | null> {
  if (b.amount == null || Number.isNaN(Number(b.amount))) return null
  const charge = await createCharge(db, {
    businessId: biz.id,
    bookingId: b.bookingId,
    customerId: b.customerId,
    amount: Number(b.amount),
    description: `${serviceName} — ${biz.name}`,
    source: 'dunning',
    dedupKey: `payment.request:${b.bookingId}`,
    customer: { fullName: b.customerName ?? undefined, phone: b.customerPhone },
  }).catch(() => null)
  return charge && charge.ok ? charge.paymentUrl : null
}

/** Send one dunning rung through the gate (mirrors post-appointment.ts's free-form path). */
async function sendDunning(
  tier: DunningTier,
  b: DunnableBooking,
  biz: { id: string; name: string; defaultLanguage: string | null; whatsappPhoneNumberId: string | null; whatsappAccessToken: string | null },
): Promise<void> {
  const initiatorId = initiatorIdForTier(tier)
  const lang: Lang = b.customerLang ?? (biz.defaultLanguage as Lang | null | undefined) ?? 'he'
  const serviceName = b.serviceName ?? (lang === 'he' ? 'התור שלך' : 'your appointment')

  // Each rung now carries the live pay-link when payments are connected (design §7).
  const payUrl = await livePayLink(b, biz, serviceName)
  const linkSituation = payUrl
    ? ` They can pay right now via this secure link: ${payUrl}. Include the link on its own line, exactly as given — never invent a different link.`
    : ''
  const linkFallback = payUrl ? `\n${payUrl}` : ''

  let situation: string
  let fallback: string
  if (tier === 'dunning_1') {
    situation = `The customer booked "${serviceName}" at ${biz.name} but payment is still pending, so the slot isn't confirmed yet. Send a gentle, friendly reminder to complete the payment to confirm the slot, and offer help if they ran into any trouble paying. Brief and warm, never pushy.${linkSituation}`
    fallback = (lang === 'he'
      ? `היי! נשאר רק להשלים את התשלום כדי לאשר את ${serviceName} ב${biz.name}. אם נתקלת בבעיה נשמח לעזור 🙂`
      : `Hi! Just need the payment completed to confirm your ${serviceName} at ${biz.name}. Happy to help if you ran into any trouble 🙂`) + linkFallback
  } else if (tier === 'dunning_2') {
    situation = `The customer booked "${serviceName}" at ${biz.name} and payment is still not completed, so the slot remains unconfirmed and will be released if payment isn't completed soon. Send a firmer but still friendly reminder to complete the payment to keep the slot. Polite, never threatening.${linkSituation}`
    fallback = (lang === 'he'
      ? `תזכורת ידידותית: ${serviceName} ב${biz.name} עדיין לא מאושר ועלול להשתחרר אם התשלום לא יושלם בקרוב. נשמח אם תוכל/י להשלים את התשלום 🙏`
      : `Friendly reminder: your ${serviceName} at ${biz.name} isn't confirmed yet and may be released if payment isn't completed soon. We'd appreciate it if you could complete the payment 🙏`) + linkFallback
  } else {
    situation = `This is the final reminder for the customer's "${serviceName}" at ${biz.name}: payment is still not completed and the slot may be released. Send a courteous, last-notice message that the slot may be released if payment isn't completed, and warmly invite them to reply if they need anything. Never threatening or guilt-inducing.${linkSituation}`
    fallback = (lang === 'he'
      ? `תזכורת אחרונה: ${serviceName} ב${biz.name} עלול להשתחרר אם התשלום לא יושלם. אם צריך עזרה בכל דבר — פשוט תכתבו לנו 💛`
      : `Final reminder: your ${serviceName} at ${biz.name} may be released if payment isn't completed. If you need anything at all, just reply 💛`) + linkFallback
  }

  // Out-of-window template fallback. Link-LESS by design: a Meta Utility template must not carry
  // a raw payment URL, so the template just nudges the customer to complete payment ([service,
  // business] — matches payment_dunning_{1,2,final}.params). The pay-link rides the free-form path;
  // once the customer replies (opening the window) the next nudge / their reply delivers the link.
  const templateName = `payment_${tier}` // dunning_1 → payment_dunning_1, etc.
  const waCredentials = biz.whatsappPhoneNumberId && biz.whatsappAccessToken
    ? { accessToken: biz.whatsappAccessToken, phoneNumberId: biz.whatsappPhoneNumberId }
    : undefined

  await dispatchInitiation(db, getInitiator(initiatorId), {
    businessId: biz.id,
    recipientId: b.customerId,
    dedupKey: `payment.dunning:${b.bookingId}:${tier}`,
  }, {
    sendFreeForm: async () => {
      let body = await generateProactiveCustomerMessage({ businessName: biz.name, language: lang, situation, fallback, timeoutMs: 2500 })
      // Guard: when we have a link it MUST appear — never send a dunning nudge that promises a
      // link the LLM dropped.
      if (payUrl && !body.includes(payUrl)) body = `${body}\n${payUrl}`
      await enqueueMessage(b.customerPhone, body)
    },
    sendTemplate: async () => {
      await sendTemplateMessage({
        toNumber: b.customerPhone,
        templateName,
        languageCode: lang === 'he' ? 'he' : 'en',
        components: bodyComponents([serviceName, biz.name]),
        bodyText: fallback,
        ...(waCredentials !== undefined && { credentials: waCredentials }),
      }).catch(() => { /* non-fatal — next tick / retry handles transient failures */ })
    },
  })
}

/** Load pending_payment bookings whose createdAt is inside the dunning scan window. */
async function dunnableBookings(
  businessId: string,
  window: { after: Date; before: Date },
): Promise<DunnableBooking[]> {
  const rows = await db
    .select({
      bookingId: bookings.id,
      customerId: bookings.customerId,
      customerPhone: identities.phoneNumber,
      customerName: identities.displayName,
      customerLang: identities.preferredLanguage,
      serviceName: serviceTypes.name,
      bookingAmount: bookings.amount,
      serviceAmount: serviceTypes.paymentAmount,
      createdAt: bookings.createdAt,
    })
    .from(bookings)
    .innerJoin(identities, eq(bookings.customerId, identities.id))
    .leftJoin(serviceTypes, eq(bookings.serviceTypeId, serviceTypes.id))
    .where(and(
      eq(bookings.businessId, businessId),
      eq(bookings.state, 'pending_payment'),
      eq(bookings.paymentStatus, 'pending'),
      gte(bookings.createdAt, window.after),
      lte(bookings.createdAt, window.before),
    ))

  return rows.map((r) => ({
    bookingId: r.bookingId,
    customerId: r.customerId,
    customerPhone: r.customerPhone,
    customerName: r.customerName,
    customerLang: r.customerLang as Lang | null,
    serviceName: r.serviceName,
    // Per-booking price snapshot when present, else the service base price.
    amount: r.bookingAmount ?? r.serviceAmount,
    createdAt: r.createdAt,
  }))
}

export async function runDunningTick(now: Date = new Date()): Promise<void> {
  const bizRows = await db
    .select({ id: businesses.id, name: businesses.name, defaultLanguage: businesses.defaultLanguage, whatsappPhoneNumberId: businesses.whatsappPhoneNumberId, whatsappAccessToken: businesses.whatsappAccessToken, automatedMessagesConfig: businesses.automatedMessagesConfig })
    .from(businesses)

  const window = dunningActiveWindow(now)

  for (const biz of bizRows) {
    const cfg = biz.automatedMessagesConfig as AutomatedMessagesConfig | null

    try {
      if (cfg?.payment_request?.enabled !== true) continue

      const due = await dunnableBookings(biz.id, window)
      let sent = 0
      for (const b of due) {
        const tier = dunningTierForAge(now.getTime() - b.createdAt.getTime())
        if (tier === null) continue
        try {
          await sendDunning(tier, b, biz)
          sent++
        } catch (err) {
          console.error('[dunning] send failed', { bookingId: b.bookingId, tier, err: (err as Error).message })
        }
      }
      if (sent > 0) {
        await logAudit(db, { businessId: biz.id, actorId: null, action: 'dunning.swept', entityType: 'initiation', metadata: { due: sent } })
      }
    } catch (err) {
      console.error('[dunning] business tick failed', { businessId: biz.id, err: (err as Error).message })
    }
  }
}

export function startDunningWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async () => runDunningTick(),
    { connection: redisConnection },
  )
  worker.on('failed', (job, err) => {
    console.error('[dunning] Job failed', { jobId: job?.id, err: err.message })
  })
  return worker
}

export async function scheduleDunningJob() {
  await dunningQueue.add('tick', {}, { repeat: { every: REPEAT_EVERY_MS }, jobId: 'dunning-tick' })
}
