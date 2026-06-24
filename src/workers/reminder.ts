import { Worker, Queue } from 'bullmq'
import { eq, and } from 'drizzle-orm'
import { db } from '../db/client.js'
import { bookings, identities, serviceTypes, businesses } from '../db/schema.js'
import { enqueueMessage } from './message-retry.js'
import { sendTemplateMessage } from '../adapters/whatsapp/sender.js'
import { bodyComponents } from '../adapters/whatsapp/templates.js'
import { redisConnection } from '../redis.js'
import { logAudit } from '../domain/audit/logger.js'
import { i18n, type Lang } from '../domain/i18n/t.js'
import { generateProactiveCustomerMessage } from '../adapters/llm/client.js'
import { getInitiator } from '../domain/initiations/registry.js'
import { dispatchInitiation } from '../domain/initiations/dispatch.js'

const QUEUE_NAME = 'reminders'

// The "primary" (further-out) reminder is configurable per business/service (template catalog
// #15). When the effective offset is the historical 24h default it stays type '24h' with the
// appointment_reminder_24h template; any other offset becomes type 'custom' with the
// neutral-worded appointment_reminder_custom template (no "tomorrow", so any offset reads right).
// The 1h reminder is always scheduled as before.
interface ReminderJob {
  type: '24h' | '1h' | 'custom'
  bookingId: string
  businessId: string
  customerId: string
  serviceTypeId: string
  slotStart: string
}

export const reminderQueue = new Queue<ReminderJob>(QUEUE_NAME, { connection: redisConnection })

/** Effective reminder offset in hours: per-service override → business default → 24. */
async function resolveReminderOffsetHours(businessId: string, serviceTypeId: string): Promise<number> {
  const [svc] = await db
    .select({ off: serviceTypes.reminderOffsetHours })
    .from(serviceTypes)
    .where(eq(serviceTypes.id, serviceTypeId))
    .limit(1)
  if (svc?.off != null) return svc.off
  const [biz] = await db
    .select({ off: businesses.reminderOffsetHours })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)
  return biz?.off ?? 24
}

export async function scheduleReminders(
  businessId: string,
  customerId: string,
  bookingId: string,
  serviceTypeId: string,
  slotStart: Date,
): Promise<void> {
  const now = Date.now()
  const slotMs = slotStart.getTime()

  const base: Omit<ReminderJob, 'type'> = {
    bookingId,
    businessId,
    customerId,
    serviceTypeId,
    slotStart: slotStart.toISOString(),
  }

  // Primary reminder at slotStart − effectiveOffset. offset 24 → the canonical '24h' reminder;
  // any other value → the neutral 'custom' reminder. One job per booking either way.
  const offsetHours = await resolveReminderOffsetHours(businessId, serviceTypeId)
  const primaryType: ReminderJob['type'] = offsetHours === 24 ? '24h' : 'custom'
  const delayPrimary = slotMs - now - offsetHours * 60 * 60 * 1_000
  if (delayPrimary > 0) {
    await reminderQueue.add(primaryType, { ...base, type: primaryType }, {
      delay: delayPrimary,
      jobId: `reminder-${primaryType}-${bookingId}`,
      attempts: 2,
      backoff: { type: 'fixed', delay: 60_000 },
    })
  }

  const delay1h = slotMs - now - 60 * 60 * 1_000
  if (delay1h > 0) {
    await reminderQueue.add('1h', { ...base, type: '1h' }, {
      delay: delay1h,
      jobId: `reminder-1h-${bookingId}`,
      attempts: 2,
      backoff: { type: 'fixed', delay: 30_000 },
    })
  }
}

export async function cancelReminders(bookingId: string): Promise<void> {
  const jobs = await Promise.all([
    reminderQueue.getJob(`reminder-24h-${bookingId}`),
    reminderQueue.getJob(`reminder-custom-${bookingId}`),
    reminderQueue.getJob(`reminder-1h-${bookingId}`),
  ])
  await Promise.allSettled(jobs.map((j) => j?.remove()))
}

async function processReminder(job: { data: ReminderJob }) {
  const { type, bookingId, businessId, customerId, slotStart } = job.data

  // Verify booking is still confirmed before sending
  const [booking] = await db
    .select({ state: bookings.state, serviceTypeId: bookings.serviceTypeId })
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.businessId, businessId)))
    .limit(1)

  if (!booking || booking.state !== 'confirmed') return

  const [customer] = await db
    .select({ phoneNumber: identities.phoneNumber, displayName: identities.displayName, preferredLanguage: identities.preferredLanguage })
    .from(identities)
    .where(eq(identities.id, customerId))
    .limit(1)

  if (!customer) return

  const [service] = await db
    .select({ name: serviceTypes.name })
    .from(serviceTypes)
    .where(eq(serviceTypes.id, booking.serviceTypeId))
    .limit(1)

  const [biz] = await db
    .select({ name: businesses.name, timezone: businesses.timezone, defaultLanguage: businesses.defaultLanguage, whatsappPhoneNumberId: businesses.whatsappPhoneNumberId, whatsappAccessToken: businesses.whatsappAccessToken })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)

  if (!biz) return

  const lang: Lang = (customer.preferredLanguage as Lang | null | undefined)
    ?? (biz.defaultLanguage as Lang | null | undefined)
    ?? 'he'

  const slot = new Date(slotStart)
  const locale = lang === 'he' ? 'he-IL' : 'en-GB'
  const timeStr = new Intl.DateTimeFormat(locale, {
    timeZone: biz.timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(slot)

  const dateStr = new Intl.DateTimeFormat(locale, {
    timeZone: biz.timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(slot)

  const serviceName = service?.name ?? (lang === 'he' ? 'התור שלך' : 'your appointment')

  // Per-type wording, initiator, template, and positional template variables. The 'custom'
  // reminder is neutral (no "tomorrow") so any owner-configured offset reads correctly; it
  // shares the date+time variable shape with the 24h reminder. The 1h reminder carries time only.
  const customFallback = lang === 'he'
    ? `תזכורת — ${serviceName} ב${biz.name} בתאריך ${dateStr} בשעה ${timeStr}. אם משהו השתנה, רק תכתבו לי ונסדר 🙂`
    : `Reminder — ${serviceName} at ${biz.name} on ${dateStr} at ${timeStr}. If anything changed, just message me and we'll sort it 🙂`

  const body = type === '24h'
    ? i18n.reminder_24h[lang](serviceName, biz.name, dateStr, timeStr)
    : type === '1h'
      ? i18n.reminder_1h[lang](serviceName, biz.name, timeStr)
      : customFallback

  const situation = type === '24h'
    ? `Send a friendly 24-hour reminder: the customer has "${serviceName}" at ${biz.name} tomorrow, ${dateStr} at ${timeStr}. If they need to change or cancel, invite them to just tell you in their own words — never tell them to "reply CANCEL".`
    : type === '1h'
      ? `Send a friendly 1-hour reminder: the customer has "${serviceName}" at ${biz.name} in 1 hour at ${timeStr}. Warm and brief.`
      : `Send a friendly reminder: the customer has "${serviceName}" at ${biz.name} on ${dateStr} at ${timeStr}. Do NOT say "tomorrow" (the timing varies). If they need to change or cancel, invite them to just tell you in their own words.`

  // Out-of-window template fallback details — used by the sendTemplate executor below.
  const waCredentials = biz.whatsappPhoneNumberId && biz.whatsappAccessToken
    ? { accessToken: biz.whatsappAccessToken, phoneNumberId: biz.whatsappPhoneNumberId }
    : undefined
  const initiatorId = type === '24h' ? 'reminder.24h' : type === '1h' ? 'reminder.1h' : 'reminder.custom'
  // Positional template variables match each template's params in templates.ts: 1h → [service,
  // business, time]; 24h/custom → [service, business, date, time].
  const templateValues = type === '1h'
    ? [serviceName, biz.name, timeStr]
    : [serviceName, biz.name, dateStr, timeStr]

  const decision = await dispatchInitiation(
    db,
    getInitiator(initiatorId),
    { businessId, recipientId: customerId, dedupKey: `reminder.${type}:${bookingId}` },
    {
      sendFreeForm: async () => {
        const llmBody = await generateProactiveCustomerMessage({ businessName: biz.name, language: lang, situation, fallback: body, timeoutMs: 2500 })
        await enqueueMessage(customer.phoneNumber, llmBody)
      },
      sendTemplate: async (templateName) => {
        await sendTemplateMessage({
          toNumber: customer.phoneNumber,
          templateName,
          languageCode: lang === 'he' ? 'he' : 'en',
          components: bodyComponents(templateValues),
          bodyText: body,
          ...(waCredentials !== undefined && { credentials: waCredentials }),
        }).catch(() => { /* non-fatal — log below */ })
      },
    },
  )

  if (decision.kind === 'send_free_form' || decision.kind === 'send_template') {
    await logAudit(db, {
      businessId,
      actorId: null,
      action: `booking.reminder_sent.${type}`,
      entityType: 'booking',
      entityId: bookingId,
      metadata: { type, slotStart },
    })
  }
}

export function startReminderWorker() {
  const worker = new Worker<ReminderJob>(
    QUEUE_NAME,
    async (job) => processReminder(job),
    { connection: redisConnection },
  )

  worker.on('failed', (job, err) => {
    console.error('[reminder] Job failed', { jobId: job?.id, err: err.message })
  })

  return worker
}
