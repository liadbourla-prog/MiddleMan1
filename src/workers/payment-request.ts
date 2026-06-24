// Pay-link send worker (Grow Phase 2, design §3.1). Hourly tick: for every booking sitting in
// internal `pending_payment` that does not yet have a live/settled charge, create a Grow
// pay-link (PaymentService.createCharge) and send it to the customer through the initiations
// gate as the transactional `payment.request` initiator (one link per booking).
//
// Default `at_booking` policy: the booking is already in pending_payment from the moment the
// engine applied the post_payment gate, so the link goes out on the next scan. Owner-
// configurable offset timing (slot_start − offset) is Phase 3 — this worker is the mechanism
// it will extend, structurally identical to the reminder/dunning workers.
//
// Per-business switch: the owner's EXISTING automatedMessagesConfig.payment_request.enabled
// flag (this worker is its consumer, same as the dunning worker). When payments aren't
// connected, createCharge returns not_connected and we simply skip — the dunning nudges still
// run, graceful degradation.

import { Worker, Queue } from 'bullmq'
import { eq, and } from 'drizzle-orm'
import { db } from '../db/client.js'
import { bookings, businesses, identities, serviceTypes } from '../db/schema.js'
import type { AutomatedMessagesConfig } from '../shared/skill-types.js'
import { redisConnection } from '../redis.js'
import { enqueueMessage } from './message-retry.js'
import { logAudit } from '../domain/audit/logger.js'
import { type Lang } from '../domain/i18n/t.js'
import { generateProactiveCustomerMessage } from '../adapters/llm/client.js'
import { dispatchInitiation } from '../domain/initiations/dispatch.js'
import { getInitiator } from '../domain/initiations/registry.js'
import { createCharge } from '../domain/payments/service.js'

const QUEUE_NAME = 'payment-request'
const REPEAT_EVERY_MS = 60 * 60 * 1000 // hourly, like reminder/dunning

export const paymentRequestQueue = new Queue(QUEUE_NAME, { connection: redisConnection })

interface ChargeableBooking {
  bookingId: string
  customerId: string
  customerPhone: string
  customerName: string | null
  customerLang: Lang | null
  serviceName: string | null
  amount: string | null
}

/** Bookings awaiting payment that still need their first pay-link. */
async function chargeableBookings(businessId: string): Promise<ChargeableBooking[]> {
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
    })
    .from(bookings)
    .innerJoin(identities, eq(bookings.customerId, identities.id))
    .leftJoin(serviceTypes, eq(bookings.serviceTypeId, serviceTypes.id))
    .where(and(
      eq(bookings.businessId, businessId),
      eq(bookings.state, 'pending_payment'),
      eq(bookings.paymentStatus, 'pending'),
    ))

  return rows.map((r) => ({
    bookingId: r.bookingId,
    customerId: r.customerId,
    customerPhone: r.customerPhone,
    customerName: r.customerName,
    customerLang: r.customerLang as Lang | null,
    serviceName: r.serviceName,
    // Charge the per-booking price snapshot when present, else the service base price.
    amount: r.bookingAmount ?? r.serviceAmount,
  }))
}

async function sendPaymentLink(
  b: ChargeableBooking,
  biz: { id: string; name: string; defaultLanguage: string | null },
): Promise<void> {
  const lang: Lang = b.customerLang ?? (biz.defaultLanguage as Lang | null | undefined) ?? 'he'
  const serviceName = b.serviceName ?? (lang === 'he' ? 'התור שלך' : 'your appointment')

  // Amount unknown → cannot charge; leave it to the (linkless) dunning nudges.
  if (b.amount == null || Number.isNaN(Number(b.amount))) return

  const charge = await createCharge(db, {
    businessId: biz.id,
    bookingId: b.bookingId,
    customerId: b.customerId,
    amount: Number(b.amount),
    description: `${serviceName} — ${biz.name}`,
    source: 'booking',
    dedupKey: `payment.request:${b.bookingId}`,
    customer: { fullName: b.customerName ?? undefined, phone: b.customerPhone },
  })

  // not_connected / already_paid / grow_error → nothing to send this tick.
  if (!charge.ok) return

  const paymentUrl = charge.paymentUrl
  const situation = `The customer booked "${serviceName}" at ${biz.name}. To confirm the slot they need to pay via this secure link: ${paymentUrl}. Send a short, warm message inviting them to complete payment to lock in the booking. Include the link on its own line, exactly as given. Never invent a different link.`
  const fallback = lang === 'he'
    ? `כדי לאשר את ${serviceName} ב${biz.name}, אפשר להשלים את התשלום כאן:\n${paymentUrl}`
    : `To confirm your ${serviceName} at ${biz.name}, you can complete payment here:\n${paymentUrl}`

  await dispatchInitiation(db, getInitiator('payment.request'), {
    businessId: biz.id,
    recipientId: b.customerId,
    dedupKey: `payment.request:${b.bookingId}`,
  }, {
    sendFreeForm: async () => {
      let body = await generateProactiveCustomerMessage({ businessName: biz.name, language: lang, situation, fallback, timeoutMs: 2500 })
      // Guard: the link MUST be present — never send a pay request without the actual link.
      if (!body.includes(paymentUrl)) body = `${body}\n${paymentUrl}`
      await enqueueMessage(b.customerPhone, body)
    },
  })
}

export async function runPaymentRequestTick(): Promise<void> {
  const bizRows = await db
    .select({ id: businesses.id, name: businesses.name, defaultLanguage: businesses.defaultLanguage, automatedMessagesConfig: businesses.automatedMessagesConfig })
    .from(businesses)

  for (const biz of bizRows) {
    const cfg = biz.automatedMessagesConfig as AutomatedMessagesConfig | null
    try {
      if (cfg?.payment_request?.enabled !== true) continue

      const due = await chargeableBookings(biz.id)
      let sent = 0
      for (const b of due) {
        try {
          await sendPaymentLink(b, biz)
          sent++
        } catch (err) {
          console.error('[payment-request] send failed', { bookingId: b.bookingId, err: (err as Error).message })
        }
      }
      if (sent > 0) {
        await logAudit(db, { businessId: biz.id, actorId: null, action: 'payment_request.swept', entityType: 'initiation', metadata: { scanned: sent } }).catch(() => {})
      }
    } catch (err) {
      console.error('[payment-request] business tick failed', { businessId: biz.id, err: (err as Error).message })
    }
  }
}

export function startPaymentRequestWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async () => runPaymentRequestTick(),
    { connection: redisConnection },
  )
  worker.on('failed', (job, err) => {
    console.error('[payment-request] Job failed', { jobId: job?.id, err: err.message })
  })
  return worker
}

export async function schedulePaymentRequestJob() {
  await paymentRequestQueue.add('tick', {}, { repeat: { every: REPEAT_EVERY_MS }, jobId: 'payment-request-tick' })
}
