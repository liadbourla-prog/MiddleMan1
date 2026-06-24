// Post-appointment autonomous initiators (Phase 4a): review-request (~1 day after an
// attended appointment) and no-show follow-up (gentle nudge after a missed one). Both are
// owner_configured customer sends gated by the owner's EXISTING automatedMessagesConfig
// flags — this worker is the first consumer of those flags. Hourly tick; per-booking
// dedup via the initiation_log ledger makes re-ticks idempotent. All sends go through the
// initiation gate (opt-out + in-window-only), mirroring reminder.ts.

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
import { reviewDueWindow, noShowFollowupWindow, thankYouDueWindow } from '../domain/crm/post-appointment.js'

const QUEUE_NAME = 'post-appointment'
const REPEAT_EVERY_MS = 60 * 60 * 1000 // hourly

export const postAppointmentQueue = new Queue(QUEUE_NAME, { connection: redisConnection })

interface SendableBooking {
  bookingId: string
  customerId: string
  customerPhone: string
  customerLang: Lang | null
  serviceName: string | null
}

/** Send one post-appointment initiation through the gate (mirrors reminder.ts's free-form path). */
async function sendPostAppointment(
  initiatorId: 'review.request' | 'booking.no_show_followup',
  b: SendableBooking,
  biz: { id: string; name: string; defaultLanguage: string | null; whatsappPhoneNumberId: string | null; whatsappAccessToken: string | null },
): Promise<void> {
  const lang: Lang = b.customerLang ?? (biz.defaultLanguage as Lang | null | undefined) ?? 'he'
  const serviceName = b.serviceName ?? (lang === 'he' ? 'התור שלך' : 'your appointment')

  const situation = initiatorId === 'review.request'
    ? `The customer recently had "${serviceName}" at ${biz.name}. Warmly ask how it went and invite a quick review — brief, genuine, never pushy. No pressure if they're busy.`
    : `The customer missed their "${serviceName}" appointment at ${biz.name}. Send a gentle, non-judgemental note that you missed them and would be happy to help them rebook whenever suits — never blame or guilt them.`

  const fallback = initiatorId === 'review.request'
    ? (lang === 'he'
      ? `היי! איך היה ב${biz.name}? נשמח אם תוכל/י לשתף חוויה קצרה 🙏`
      : `Hi! How was your visit to ${biz.name}? We'd love a quick word on how it went 🙏`)
    : (lang === 'he'
      ? `היי, התגעגענו אליך ב${biz.name}. נשמח לעזור לקבוע תור חדש מתי שנוח לך 💛`
      : `Hi, we missed you at ${biz.name}. Happy to help you book a new time whenever suits you 💛`)

  // Out-of-window template fallback. Both review_request and no_show_followup take a single
  // positional variable: the business name (matches their .params in templates.ts).
  const templateName = initiatorId === 'review.request' ? 'review_request' : 'no_show_followup'
  const waCredentials = biz.whatsappPhoneNumberId && biz.whatsappAccessToken
    ? { accessToken: biz.whatsappAccessToken, phoneNumberId: biz.whatsappPhoneNumberId }
    : undefined

  await dispatchInitiation(db, getInitiator(initiatorId), {
    businessId: biz.id,
    recipientId: b.customerId,
    dedupKey: `${initiatorId}:${b.bookingId}`,
  }, {
    sendFreeForm: async () => {
      const body = await generateProactiveCustomerMessage({ businessName: biz.name, language: lang, situation, fallback, timeoutMs: 2500 })
      await enqueueMessage(b.customerPhone, body)
    },
    sendTemplate: async () => {
      await sendTemplateMessage({
        toNumber: b.customerPhone,
        templateName,
        languageCode: lang === 'he' ? 'he' : 'en',
        components: bodyComponents([biz.name]),
        bodyText: fallback,
        ...(waCredentials !== undefined && { credentials: waCredentials }),
      }).catch(() => { /* non-fatal — next tick / retry handles transient failures */ })
    },
  })
}

/** Send one post-appointment thank-you (template catalog #14). Template vars: [service, business]. */
async function sendThankYou(
  b: SendableBooking,
  biz: { id: string; name: string; defaultLanguage: string | null; whatsappPhoneNumberId: string | null; whatsappAccessToken: string | null },
): Promise<void> {
  const lang: Lang = b.customerLang ?? (biz.defaultLanguage as Lang | null | undefined) ?? 'he'
  const serviceName = b.serviceName ?? (lang === 'he' ? 'הביקור שלך' : 'your visit')

  const situation = `The customer just had "${serviceName}" at ${biz.name}. Send a short, warm thank-you for choosing the business and a hope they enjoyed it — genuine, never salesy, no ask.`
  const fallback = lang === 'he'
    ? `תודה שבחרת ב${biz.name}! מקווים שנהנית מ${serviceName}. נשמח לראות אותך שוב 💛`
    : `Thank you for choosing ${biz.name}! We hope you enjoyed ${serviceName}. We'd love to see you again 💛`

  const waCredentials = biz.whatsappPhoneNumberId && biz.whatsappAccessToken
    ? { accessToken: biz.whatsappAccessToken, phoneNumberId: biz.whatsappPhoneNumberId }
    : undefined

  await dispatchInitiation(db, getInitiator('post.thank_you'), {
    businessId: biz.id,
    recipientId: b.customerId,
    dedupKey: `post.thank_you:${b.bookingId}`,
  }, {
    sendFreeForm: async () => {
      const body = await generateProactiveCustomerMessage({ businessName: biz.name, language: lang, situation, fallback, timeoutMs: 2500 })
      await enqueueMessage(b.customerPhone, body)
    },
    sendTemplate: async (templateName) => {
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

/** Load the sendable rows for a state + slot-time window (joined to customer + service). */
async function dueBookings(
  businessId: string,
  state: 'attended' | 'no_show',
  timeCol: 'slotStart' | 'slotEnd',
  range: { after: Date; before?: Date },
): Promise<SendableBooking[]> {
  const col = timeCol === 'slotStart' ? bookings.slotStart : bookings.slotEnd
  const conds = [eq(bookings.businessId, businessId), eq(bookings.state, state), gte(col, range.after)]
  if (range.before) conds.push(lte(col, range.before))

  const rows = await db
    .select({
      bookingId: bookings.id,
      customerId: bookings.customerId,
      customerPhone: identities.phoneNumber,
      customerLang: identities.preferredLanguage,
      serviceName: serviceTypes.name,
    })
    .from(bookings)
    .innerJoin(identities, eq(bookings.customerId, identities.id))
    .leftJoin(serviceTypes, eq(bookings.serviceTypeId, serviceTypes.id))
    .where(and(...conds))

  return rows.map((r) => ({
    bookingId: r.bookingId,
    customerId: r.customerId,
    customerPhone: r.customerPhone,
    customerLang: r.customerLang as Lang | null,
    serviceName: r.serviceName,
  }))
}

export async function runPostAppointmentTick(now: Date = new Date()): Promise<void> {
  const bizRows = await db
    .select({ id: businesses.id, name: businesses.name, defaultLanguage: businesses.defaultLanguage, whatsappPhoneNumberId: businesses.whatsappPhoneNumberId, whatsappAccessToken: businesses.whatsappAccessToken, automatedMessagesConfig: businesses.automatedMessagesConfig, postAppointmentThankyouEnabled: businesses.postAppointmentThankyouEnabled })
    .from(businesses)

  for (const biz of bizRows) {
    const cfg = biz.automatedMessagesConfig as AutomatedMessagesConfig | null

    try {
      // Thank-you (#14): opt-in via the dedicated postAppointmentThankyouEnabled flag (not an
      // automatedMessagesConfig key). Fires ~1–4h after an attended appointment ended.
      if (biz.postAppointmentThankyouEnabled === true) {
        const due = await dueBookings(biz.id, 'attended', 'slotEnd', thankYouDueWindow(now))
        for (const b of due) {
          try { await sendThankYou(b, biz) }
          catch (err) { console.error('[post-appointment] thank-you send failed', { bookingId: b.bookingId, err: (err as Error).message }) }
        }
        if (due.length > 0) {
          await logAudit(db, { businessId: biz.id, actorId: null, action: 'post_thank_you.swept', entityType: 'initiation', metadata: { due: due.length } })
        }
      }

      if (cfg?.review_request?.enabled === true) {
        const due = await dueBookings(biz.id, 'attended', 'slotEnd', reviewDueWindow(now))
        for (const b of due) {
          try { await sendPostAppointment('review.request', b, biz) }
          catch (err) { console.error('[post-appointment] review send failed', { bookingId: b.bookingId, err: (err as Error).message }) }
        }
        if (due.length > 0) {
          await logAudit(db, { businessId: biz.id, actorId: null, action: 'review_request.swept', entityType: 'initiation', metadata: { due: due.length } })
        }
      }

      if (cfg?.no_show?.enabled === true) {
        const due = await dueBookings(biz.id, 'no_show', 'slotStart', noShowFollowupWindow(now))
        for (const b of due) {
          try { await sendPostAppointment('booking.no_show_followup', b, biz) }
          catch (err) { console.error('[post-appointment] no-show send failed', { bookingId: b.bookingId, err: (err as Error).message }) }
        }
        if (due.length > 0) {
          await logAudit(db, { businessId: biz.id, actorId: null, action: 'no_show_followup.swept', entityType: 'initiation', metadata: { due: due.length } })
        }
      }
    } catch (err) {
      console.error('[post-appointment] business tick failed', { businessId: biz.id, err: (err as Error).message })
    }
  }
}

export function startPostAppointmentWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async () => runPostAppointmentTick(),
    { connection: redisConnection },
  )
  worker.on('failed', (job, err) => {
    console.error('[post-appointment] Job failed', { jobId: job?.id, err: err.message })
  })
  return worker
}

export async function schedulePostAppointmentJob() {
  await postAppointmentQueue.add('tick', {}, { repeat: { every: REPEAT_EVERY_MS }, jobId: 'post-appointment-tick' })
}
