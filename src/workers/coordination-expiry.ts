import { Worker, Queue } from 'bullmq'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { businesses } from '../db/schema.js'
import { redisConnection } from '../redis.js'
import { createCalendarClient, type CalendarClient } from '../adapters/calendar/client.js'
import { expireStaleCoordinations, type BusinessCtx } from '../domain/coordination/handler.js'
import type { Lang } from '../domain/i18n/t.js'

const QUEUE_NAME = 'coordination-expiry'
const REPEAT_EVERY_MS = 30 * 60_000 // every 30 minutes

export const coordinationExpiryQueue = new Queue(QUEUE_NAME, { connection: redisConnection })

async function loadBusiness(businessId: string) {
  const [biz] = await db.select({
    id: businesses.id, name: businesses.name, timezone: businesses.timezone,
    defaultLanguage: businesses.defaultLanguage, calendarMode: businesses.calendarMode,
    googleRefreshToken: businesses.googleRefreshToken, googleCalendarId: businesses.googleCalendarId,
    whatsappPhoneNumberId: businesses.whatsappPhoneNumberId, whatsappAccessToken: businesses.whatsappAccessToken,
  }).from(businesses).where(eq(businesses.id, businessId)).limit(1)
  return biz ?? null
}

async function processTick(): Promise<void> {
  await expireStaleCoordinations(
    db,
    async (businessId): Promise<CalendarClient | null> => {
      const biz = await loadBusiness(businessId)
      if (!biz) return null
      return createCalendarClient({
        accessToken: '',
        refreshToken: biz.googleRefreshToken ?? process.env['GOOGLE_REFRESH_TOKEN'] ?? '',
        calendarId: biz.googleCalendarId,
        businessId: biz.id,
        calendarMode: biz.calendarMode,
      })
    },
    async (businessId): Promise<BusinessCtx | null> => {
      const biz = await loadBusiness(businessId)
      if (!biz) return null
      const lang = (biz.defaultLanguage as Lang | null) ?? 'he'
      return {
        businessId: biz.id,
        businessName: biz.name,
        lang,
        timezone: biz.timezone,
        waCredentials: biz.whatsappPhoneNumberId && biz.whatsappAccessToken
          ? { accessToken: biz.whatsappAccessToken, phoneNumberId: biz.whatsappPhoneNumberId }
          : undefined,
      }
    },
  )
}

export function startCoordinationExpiryWorker() {
  const worker = new Worker(QUEUE_NAME, async () => processTick(), { connection: redisConnection })
  worker.on('failed', (job, err) => {
    console.error('[coordination-expiry] Job failed', { jobId: job?.id, err: err.message })
  })
  coordinationExpiryQueue
    .add('tick', {}, { repeat: { every: REPEAT_EVERY_MS }, jobId: 'coordination-expiry-tick' })
    .catch((err) => console.error('[coordination-expiry] Failed to schedule job', err))
  return worker
}
