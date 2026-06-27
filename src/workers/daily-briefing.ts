import { Worker, Queue } from 'bullmq'
import { eq, and, gt, gte, lt, count, inArray } from 'drizzle-orm'
import { db } from '../db/client.js'
import { businesses, identities, bookings, initiationLog } from '../db/schema.js'
import { sendMessage } from '../adapters/whatsapp/sender.js'
import { redisConnection } from '../redis.js'
import { type Lang } from '../domain/i18n/t.js'
import { northStarLines, ownerDigestLines } from '../domain/initiations/metrics.js'
import { countManagedOutcomes } from '../domain/initiations/resolution-autonomy.js'
import { resolveSlotStart, addDaysToDateStr } from '../domain/availability/resolve-slot.js'
import { localParts } from '../domain/availability/compute.js'
import { queryCustomerSegment } from '../domain/crm/segment-repository.js'
import { fetchUnflushedDigests, markDigestsFlushed, businessesWithPendingDigests } from '../domain/initiations/digest-queue.js'
import { buildDigestSection } from './digest-section.js'

// buildDigestSection lives in a side-effect-free module (this worker instantiates a BullMQ Queue at
// import time, which would connect to Redis in unit tests). Re-export so callers/tests can reach it here.
export { buildDigestSection } from './digest-section.js'

const QUEUE_NAME = 'daily-briefing'
const REPEAT_EVERY_MS = 15 * 60_000 // check every 15 minutes

export const dailyBriefingQueue = new Queue(QUEUE_NAME, { connection: redisConnection })

async function processTick(): Promise<void> {
  const now = new Date()

  // Load all businesses with daily briefing enabled
  const enabledBizList = await db
    .select({
      id: businesses.id,
      name: businesses.name,
      timezone: businesses.timezone,
      defaultLanguage: businesses.defaultLanguage,
      dailyBriefingTime: businesses.dailyBriefingTime,
      whatsappPhoneNumberId: businesses.whatsappPhoneNumberId,
      whatsappAccessToken: businesses.whatsappAccessToken,
    })
    .from(businesses)
    .where(and(eq(businesses.dailyBriefingEnabled, true)))

  for (const biz of enabledBizList) {
    try {
      const briefingTime = biz.dailyBriefingTime ?? '09:00'

      // Convert briefing time from business timezone to UTC for comparison
      const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: biz.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
      const briefingLocal = new Date(`${todayLocal}T${briefingTime}:00`)
      const briefingUtc = new Date(briefingLocal.toLocaleString('en-US', { timeZone: 'UTC' }))

      // Fire if we are within the 15-minute window after the configured time
      const diffMs = now.getTime() - briefingUtc.getTime()
      if (diffMs < 0 || diffMs > REPEAT_EVERY_MS) continue

      // Find manager identity
      const [manager] = await db
        .select({ id: identities.id, phoneNumber: identities.phoneNumber, preferredLanguage: identities.preferredLanguage })
        .from(identities)
        .where(and(eq(identities.businessId, biz.id), eq(identities.role, 'manager')))
        .limit(1)

      if (!manager) continue

      const lang: Lang = (manager.preferredLanguage as Lang | null | undefined)
        ?? (biz.defaultLanguage as Lang | null | undefined)
        ?? 'he'

      // Fold any buffered digest items into the briefing so the owner gets one combined message.
      const digestRows = await fetchUnflushedDigests(db, biz.id)
      const { section: digestSection, ids: digestIds } = buildDigestSection(digestRows, lang)
      const body = await buildBriefing(biz.id, biz.name, biz.timezone, lang)
        + (digestSection ? `\n\n${digestSection}` : '')

      const waCredentials = biz.whatsappPhoneNumberId && biz.whatsappAccessToken
        ? { accessToken: biz.whatsappAccessToken, phoneNumberId: biz.whatsappPhoneNumberId }
        : undefined

      await sendMessage({ toNumber: manager.phoneNumber, body }, waCredentials)
        .catch((err) => console.warn('[daily-briefing] Send failed', { businessId: biz.id, err }))

      // Mark flushed only after the send is attempted; if this fails the rows retry next tick.
      if (digestIds.length > 0) await markDigestsFlushed(db, digestIds).catch(() => { /* retry next tick */ })

      console.info(JSON.stringify({ event: 'daily_briefing.sent', businessId: biz.id }))
    } catch (err) {
      console.error('[daily-briefing] Business briefing failed', { businessId: biz.id, err: err instanceof Error ? err.message : String(err) })
    }
  }

  // Digest-only sweep: businesses with buffered changes but daily briefing OFF still get their
  // digest once a day, so opting an event into 'digest' never silently swallows it.
  const enabledIds = new Set(enabledBizList.map((b) => b.id))
  const pendingIds = (await businessesWithPendingDigests(db)).filter((id) => !enabledIds.has(id))
  for (const businessId of pendingIds) {
    try {
      const [biz] = await db.select({
        name: businesses.name, timezone: businesses.timezone, defaultLanguage: businesses.defaultLanguage,
        dailyBriefingTime: businesses.dailyBriefingTime, whatsappPhoneNumberId: businesses.whatsappPhoneNumberId, whatsappAccessToken: businesses.whatsappAccessToken,
      }).from(businesses).where(eq(businesses.id, businessId)).limit(1)
      if (!biz) continue

      const briefingTime = biz.dailyBriefingTime ?? '09:00'
      const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: biz.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
      const briefingLocal = new Date(`${todayLocal}T${briefingTime}:00`)
      const briefingUtc = new Date(briefingLocal.toLocaleString('en-US', { timeZone: 'UTC' }))
      const diffMs = now.getTime() - briefingUtc.getTime()
      if (diffMs < 0 || diffMs > REPEAT_EVERY_MS) continue

      const [manager] = await db.select({ phoneNumber: identities.phoneNumber, preferredLanguage: identities.preferredLanguage })
        .from(identities).where(and(eq(identities.businessId, businessId), eq(identities.role, 'manager'))).limit(1)
      if (!manager) continue
      const lang: Lang = (manager.preferredLanguage as Lang | null | undefined) ?? (biz.defaultLanguage as Lang | null | undefined) ?? 'he'

      const rows = await fetchUnflushedDigests(db, businessId)
      const { section, ids } = buildDigestSection(rows, lang)
      if (ids.length === 0) continue
      const waCredentials = biz.whatsappPhoneNumberId && biz.whatsappAccessToken
        ? { accessToken: biz.whatsappAccessToken, phoneNumberId: biz.whatsappPhoneNumberId } : undefined
      await sendMessage({ toNumber: manager.phoneNumber, body: section }, waCredentials).catch((err) => console.warn('[daily-briefing] digest-only send failed', { businessId, err }))
      await markDigestsFlushed(db, ids).catch(() => { /* retry next tick */ })
    } catch (err) {
      console.error('[daily-briefing] digest-only sweep failed', { businessId, err: err instanceof Error ? err.message : String(err) })
    }
  }
}

async function buildBriefing(businessId: string, businessName: string, timezone: string, lang: Lang): Promise<string> {
  const now = new Date()
  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  const todayEnd = new Date(now)
  todayEnd.setHours(23, 59, 59, 999)

  // Today's bookings
  const todayBookings = await db
    .select({ id: bookings.id, slotStart: bookings.slotStart, customerId: bookings.customerId })
    .from(bookings)
    .where(and(
      eq(bookings.businessId, businessId),
      eq(bookings.state, 'confirmed'),
      and(
        eq(bookings.slotStart, todayStart),
        eq(bookings.slotStart, todayEnd),
      ),
    ))
    .orderBy(bookings.slotStart)
    .limit(20)

  // Upcoming confirmed bookings total
  const [upcomingCount] = await db
    .select({ total: count() })
    .from(bookings)
    .where(and(eq(bookings.businessId, businessId), eq(bookings.state, 'confirmed'), gt(bookings.slotStart, now)))

  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60_000)

  // North-star metric 1: bookings made this week (margin proxy). Count bookings CREATED in the last
  // 7 days that became real (confirmed or attended).
  const [bookingsWeek] = await db
    .select({ total: count() })
    .from(bookings)
    .where(and(
      eq(bookings.businessId, businessId),
      gte(bookings.createdAt, weekAgo),
      inArray(bookings.state, ['confirmed', 'attended']),
    ))

  // North-star metric 2: involuntary OAU this week — times the PA had to pull the owner in. Proxy =
  // escalation initiations logged in the last 7 days (design §0.2; refined in Phase 6/7).
  const [oauWeek] = await db
    .select({ total: count() })
    .from(initiationLog)
    .where(and(
      eq(initiationLog.businessId, businessId),
      gte(initiationLog.createdAt, weekAgo),
      inArray(initiationLog.initiatorId, ['escalation.owner_rule', 'escalation.platform']),
    ))

  // Managed dead-letters (reshuffle/coordination negotiations that couldn't resolve and handed back
  // to the owner) are real involuntary OAU — add them to the escalation proxy above (design §6).
  const managed = await countManagedOutcomes(db, businessId, weekAgo)

  const metricLines = northStarLines(bookingsWeek?.total ?? 0, (oauWeek?.total ?? 0) + managed.deadLettered, lang)

  // Owner-only autonomous digest (Phase 6.4; design §8.3): tomorrow's load + likely churns.
  // Tomorrow's business-local day, resolved to UTC via the canonical slot primitives.
  const todayStr = localParts(now, timezone).dateStr
  const tomorrowStart = resolveSlotStart(addDaysToDateStr(todayStr, 1), { hour: 0, minute: 0 }, timezone)
  const tomorrowEnd = resolveSlotStart(addDaysToDateStr(todayStr, 2), { hour: 0, minute: 0 }, timezone)
  const [tomorrowCount] = await db
    .select({ total: count() })
    .from(bookings)
    .where(and(
      eq(bookings.businessId, businessId),
      eq(bookings.state, 'confirmed'),
      gte(bookings.slotStart, tomorrowStart),
      lt(bookings.slotStart, tomorrowEnd),
    ))
  const lapsed = await queryCustomerSegment(db, businessId, { lapsed: true, hasBooking: true }, timezone)
  const digestLines = ownerDigestLines(tomorrowCount?.total ?? 0, lapsed.length, lang)

  const locale = lang === 'he' ? 'he-IL' : 'en-GB'
  const dateStr = now.toLocaleDateString(locale, { timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long' })
  const todayCount = todayBookings.length
  const total = upcomingCount?.total ?? 0

  if (lang === 'he') {
    const todayLine = todayCount === 0
      ? 'אין תורים היום.'
      : `יש לך *${todayCount}* תורים היום.`
    const firstAppt = todayBookings[0]
      ? `\nהתור הראשון: ${todayBookings[0].slotStart.toLocaleTimeString('he-IL', { timeZone: timezone, hour: '2-digit', minute: '2-digit' })}.`
      : ''
    return `📅 *בוקר טוב! ${dateStr}*\n\n${todayLine}${firstAppt}\n\nסה"כ ${total} תורים מאושרים קדימה.\n\n${digestLines}\n\n${metricLines}`
  } else {
    const todayLine = todayCount === 0
      ? 'No bookings today.'
      : `You have *${todayCount}* booking(s) today.`
    const firstAppt = todayBookings[0]
      ? `\nFirst appointment: ${todayBookings[0].slotStart.toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit' })}.`
      : ''
    return `📅 *Good morning! ${dateStr}*\n\n${todayLine}${firstAppt}\n\n${total} confirmed upcoming booking(s) in total.\n\n${digestLines}\n\n${metricLines}`
  }
}

export function startDailyBriefingWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async () => processTick(),
    { connection: redisConnection },
  )

  worker.on('failed', (job, err) => {
    console.error('[daily-briefing] Job failed', { jobId: job?.id, err: err.message })
  })

  dailyBriefingQueue
    .add('tick', {}, { repeat: { every: REPEAT_EVERY_MS }, jobId: 'daily-briefing-tick' })
    .catch((err) => console.error('[daily-briefing] Failed to schedule job', err))

  return worker
}
