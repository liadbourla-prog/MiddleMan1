// Periodic-treatment nudge detector (Tier 2; template catalog #16). For businesses that opted in
// (businesses.periodicTreatmentEnabled) and services that declare a recommended cadence
// (service_types.recommended_interval_days), this daily scan finds customers whose last attended
// visit for that service is older than the cadence and who have no upcoming booking for it — then
// nudges them to book the next one. Promotional → the gate enforces opt-out + quiet hours +
// attention budget; out of window it falls back to the periodic_treatment_due template.
//
// The dedupKey buckets on the last-visit date, so a still-lapsed customer is nudged exactly once
// per lapse period (a fresh visit moves the bucket and re-arms a future nudge). Daily tick — a
// "you're overdue" signal moves slowly. Thin I/O around plain queries, mirroring winback.ts.

import { Worker, Queue } from 'bullmq'
import { and, eq, gt, inArray, isNotNull, max, sql } from 'drizzle-orm'
import { db } from '../db/client.js'
import { bookings, businesses, identities, serviceTypes } from '../db/schema.js'
import { redisConnection } from '../redis.js'
import { logAudit } from '../domain/audit/logger.js'
import { type Lang } from '../domain/i18n/t.js'
import { generateProactiveCustomerMessage } from '../adapters/llm/client.js'
import { sendTemplateMessage } from '../adapters/whatsapp/sender.js'
import { bodyComponents } from '../adapters/whatsapp/templates.js'
import { dispatchInitiation } from '../domain/initiations/dispatch.js'
import { getInitiator } from '../domain/initiations/registry.js'
import { enqueueMessage } from './message-retry.js'

const QUEUE_NAME = 'periodic-treatment'
const REPEAT_EVERY_MS = 24 * 60 * 60 * 1000 // daily — "overdue" is a slow signal

export const periodicTreatmentQueue = new Queue(QUEUE_NAME, { connection: redisConnection })

const ACTIVE_STATES = ['held', 'pending_payment', 'confirmed'] as const

interface DueCustomer {
  customerId: string
  phoneNumber: string
  lang: Lang | null
  lastVisit: Date
}

/** Customers overdue for a given service: last attended visit older than the cadence, no upcoming booking. */
async function dueForService(
  businessId: string,
  serviceTypeId: string,
  intervalDays: number,
  now: Date,
): Promise<DueCustomer[]> {
  const cutoff = new Date(now.getTime() - intervalDays * 24 * 60 * 60 * 1000)

  // Latest attended visit per customer for this service, where that latest visit is older than cutoff.
  const lastVisits = await db
    .select({ customerId: bookings.customerId, lastVisit: max(bookings.slotEnd) })
    .from(bookings)
    .where(and(eq(bookings.businessId, businessId), eq(bookings.serviceTypeId, serviceTypeId), eq(bookings.state, 'attended')))
    .groupBy(bookings.customerId)
    .having(sql`max(${bookings.slotEnd}) <= ${cutoff}`)

  if (lastVisits.length === 0) return []

  // Exclude anyone who already has an upcoming active booking for this service.
  const upcoming = await db
    .select({ customerId: bookings.customerId })
    .from(bookings)
    .where(and(
      eq(bookings.businessId, businessId),
      eq(bookings.serviceTypeId, serviceTypeId),
      inArray(bookings.state, [...ACTIVE_STATES]),
      gt(bookings.slotStart, now),
    ))
  const rebooked = new Set(upcoming.map((u) => u.customerId))

  const candidateIds = lastVisits.map((v) => v.customerId).filter((id) => !rebooked.has(id))
  if (candidateIds.length === 0) return []

  const people = await db
    .select({ id: identities.id, phoneNumber: identities.phoneNumber, lang: identities.preferredLanguage })
    .from(identities)
    .where(and(eq(identities.businessId, businessId), inArray(identities.id, candidateIds)))

  const byId = new Map(people.map((p) => [p.id, p]))
  const out: DueCustomer[] = []
  for (const v of lastVisits) {
    const p = byId.get(v.customerId)
    if (!p || !v.lastVisit) continue
    out.push({ customerId: v.customerId, phoneNumber: p.phoneNumber, lang: p.lang as Lang | null, lastVisit: v.lastVisit })
  }
  return out
}

export async function runPeriodicTreatmentTick(now: Date = new Date()): Promise<void> {
  const bizRows = await db
    .select({
      id: businesses.id,
      name: businesses.name,
      defaultLanguage: businesses.defaultLanguage,
      whatsappPhoneNumberId: businesses.whatsappPhoneNumberId,
      whatsappAccessToken: businesses.whatsappAccessToken,
    })
    .from(businesses)
    .where(and(eq(businesses.periodicTreatmentEnabled, true), isNotNull(businesses.onboardingCompletedAt)))

  for (const biz of bizRows) {
    try {
      const services = await db
        .select({ id: serviceTypes.id, name: serviceTypes.name, interval: serviceTypes.recommendedIntervalDays })
        .from(serviceTypes)
        .where(and(eq(serviceTypes.businessId, biz.id), eq(serviceTypes.isActive, true), isNotNull(serviceTypes.recommendedIntervalDays)))

      const waCredentials = biz.whatsappPhoneNumberId && biz.whatsappAccessToken
        ? { accessToken: biz.whatsappAccessToken, phoneNumberId: biz.whatsappPhoneNumberId }
        : undefined

      let sent = 0
      for (const svc of services) {
        if (svc.interval == null || svc.interval <= 0) continue
        const due = await dueForService(biz.id, svc.id, svc.interval, now)
        for (const c of due) {
          const lang: Lang = c.lang ?? (biz.defaultLanguage as Lang | null | undefined) ?? 'he'
          const serviceName = svc.name
          const situation = `It has been a while since the customer's last "${serviceName}" at ${biz.name} (their recommended interval has passed). Send a warm, brief nudge inviting them to book the next one — never pushy, no pressure.`
          const fallback = lang === 'he'
            ? `היי! עבר זמן מאז ${serviceName} האחרון ב${biz.name}. רוצה שנקבע את הבא? 🙂`
            : `Hi! It's been a while since your last ${serviceName} at ${biz.name}. Want to book the next one? 🙂`
          const lastVisitBucket = c.lastVisit.toISOString().slice(0, 10)
          try {
            const decision = await dispatchInitiation(db, getInitiator('periodic.treatment_due'), {
              businessId: biz.id,
              recipientId: c.customerId,
              dedupKey: `periodic.treatment_due:${c.customerId}:${svc.id}:${lastVisitBucket}`,
            }, {
              sendFreeForm: async () => {
                const body = await generateProactiveCustomerMessage({ businessName: biz.name, language: lang, situation, fallback, timeoutMs: 2500 })
                await enqueueMessage(c.phoneNumber, body)
              },
              sendTemplate: async (templateName) => {
                await sendTemplateMessage({
                  toNumber: c.phoneNumber,
                  templateName,
                  languageCode: lang === 'he' ? 'he' : 'en',
                  components: bodyComponents([serviceName, biz.name]),
                  bodyText: fallback,
                  ...(waCredentials !== undefined && { credentials: waCredentials }),
                }).catch(() => { /* retry queue handles transient failures */ })
              },
            })
            if (decision.kind !== 'skip') sent++
          } catch (err) {
            console.error('[periodic-treatment] send failed', { businessId: biz.id, serviceTypeId: svc.id, customerId: c.customerId, err: (err as Error).message })
          }
        }
      }
      if (sent > 0) {
        await logAudit(db, { businessId: biz.id, actorId: null, action: 'periodic_treatment.swept', entityType: 'initiation', metadata: { due: sent } })
      }
    } catch (err) {
      console.error('[periodic-treatment] business tick failed', { businessId: biz.id, err: (err as Error).message })
    }
  }
}

export function startPeriodicTreatmentWorker() {
  const worker = new Worker(QUEUE_NAME, async () => runPeriodicTreatmentTick(), { connection: redisConnection })
  worker.on('failed', (job, err) => {
    console.error('[periodic-treatment] Job failed', { jobId: job?.id, err: err.message })
  })
  return worker
}

export async function schedulePeriodicTreatmentJob() {
  await periodicTreatmentQueue.add('tick', {}, { repeat: { every: REPEAT_EVERY_MS }, jobId: 'periodic-treatment-tick' })
}
