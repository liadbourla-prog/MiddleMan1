import { Worker, Queue } from 'bullmq'
import { eq, and } from 'drizzle-orm'
import { db } from '../db/client.js'
import { bookings, identities, serviceTypes, businesses } from '../db/schema.js'
import { enqueueMessage } from './message-retry.js'
import { redisConnection } from '../redis.js'
import { logAudit } from '../domain/audit/logger.js'
import { i18n, type Lang } from '../domain/i18n/t.js'

const QUEUE_NAME = 'reminders'

interface ReminderJob {
  type: '24h' | '1h'
  bookingId: string
  businessId: string
  customerId: string
  serviceTypeId: string
  slotStart: string
}

export const reminderQueue = new Queue<ReminderJob>(QUEUE_NAME, { connection: redisConnection })

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

  const delay24h = slotMs - now - 24 * 60 * 60 * 1_000
  if (delay24h > 0) {
    await reminderQueue.add('24h', { ...base, type: '24h' }, {
      delay: delay24h,
      jobId: `reminder-24h-${bookingId}`,
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
  const job24 = await reminderQueue.getJob(`reminder-24h-${bookingId}`)
  const job1h = await reminderQueue.getJob(`reminder-1h-${bookingId}`)
  await Promise.allSettled([
    job24?.remove(),
    job1h?.remove(),
  ])
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
    .select({ name: businesses.name, timezone: businesses.timezone, defaultLanguage: businesses.defaultLanguage })
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

  const body = type === '24h'
    ? i18n.reminder_24h[lang](serviceName, biz.name, dateStr, timeStr)
    : i18n.reminder_1h[lang](serviceName, biz.name, timeStr)

  await enqueueMessage(customer.phoneNumber, body)

  await logAudit(db, {
    businessId,
    actorId: null,
    action: `booking.reminder_sent.${type}`,
    entityType: 'booking',
    entityId: bookingId,
    metadata: { type, slotStart },
  })
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
