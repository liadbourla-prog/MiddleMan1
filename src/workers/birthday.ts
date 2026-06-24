// Birthday-greeting detector (Tier 2; template catalog #17). For businesses that opted in
// (businesses.birthdayGreetingsEnabled), this daily scan finds customers whose stored birthday
// (identities.birthday — added in commit 3476923) falls on today's month-and-day, and sends a
// warm greeting. Promotional → the gate enforces opt-out + quiet hours + attention budget; out of
// window it falls back to the birthday_greeting template ([name, business]).
//
// The dedupKey buckets on the calendar year, so a customer is greeted at most once per birthday.
// Birthdays are stored as a full date but the YEAR is not meaningful (often a placeholder), so we
// match on month+day only, evaluated in JS against the business-local "today".

import { Worker, Queue } from 'bullmq'
import { and, eq, isNotNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { businesses, identities } from '../db/schema.js'
import { redisConnection } from '../redis.js'
import { logAudit } from '../domain/audit/logger.js'
import { type Lang } from '../domain/i18n/t.js'
import { generateProactiveCustomerMessage } from '../adapters/llm/client.js'
import { sendTemplateMessage } from '../adapters/whatsapp/sender.js'
import { bodyComponents } from '../adapters/whatsapp/templates.js'
import { dispatchInitiation } from '../domain/initiations/dispatch.js'
import { getInitiator } from '../domain/initiations/registry.js'
import { enqueueMessage } from './message-retry.js'

const QUEUE_NAME = 'birthday-greeting'
const REPEAT_EVERY_MS = 24 * 60 * 60 * 1000 // daily

export const birthdayQueue = new Queue(QUEUE_NAME, { connection: redisConnection })

/** Business-local month+day ("MM-DD") and year for "now" in the given IANA timezone. */
export function localMonthDay(now: Date, timezone: string): { monthDay: string; year: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return { monthDay: `${get('month')}-${get('day')}`, year: get('year') }
}

export async function runBirthdayTick(now: Date = new Date()): Promise<void> {
  const bizRows = await db
    .select({
      id: businesses.id,
      name: businesses.name,
      timezone: businesses.timezone,
      defaultLanguage: businesses.defaultLanguage,
      whatsappPhoneNumberId: businesses.whatsappPhoneNumberId,
      whatsappAccessToken: businesses.whatsappAccessToken,
    })
    .from(businesses)
    .where(and(eq(businesses.birthdayGreetingsEnabled, true), isNotNull(businesses.onboardingCompletedAt)))

  for (const biz of bizRows) {
    try {
      const { monthDay, year } = localMonthDay(now, biz.timezone)

      const customers = await db
        .select({ id: identities.id, phoneNumber: identities.phoneNumber, displayName: identities.displayName, lang: identities.preferredLanguage, birthday: identities.birthday })
        .from(identities)
        .where(and(eq(identities.businessId, biz.id), eq(identities.role, 'customer'), isNotNull(identities.birthday)))

      const waCredentials = biz.whatsappPhoneNumberId && biz.whatsappAccessToken
        ? { accessToken: biz.whatsappAccessToken, phoneNumberId: biz.whatsappPhoneNumberId }
        : undefined

      let sent = 0
      for (const c of customers) {
        // identities.birthday is a date column → 'YYYY-MM-DD' string. Match month+day only.
        if (!c.birthday || c.birthday.slice(5) !== monthDay) continue

        const lang: Lang = (c.lang as Lang | null | undefined) ?? (biz.defaultLanguage as Lang | null | undefined) ?? 'he'
        const name = c.displayName ?? (lang === 'he' ? 'חבר/ה יקר/ה' : 'friend')
        const situation = `Today is the customer's birthday. Send a short, warm birthday greeting from ${biz.name} — genuine and celebratory, no sales pitch, no ask.`
        const fallback = lang === 'he'
          ? `יום הולדת שמח ${name}! 🎉 מכל הצוות ב${biz.name} — שתהיה לך שנה נהדרת.`
          : `Happy birthday ${name}! 🎉 From all of us at ${biz.name} — have a wonderful year.`
        try {
          const decision = await dispatchInitiation(db, getInitiator('birthday.greeting'), {
            businessId: biz.id,
            recipientId: c.id,
            dedupKey: `birthday.greeting:${c.id}:${year}`,
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
                components: bodyComponents([name, biz.name]),
                bodyText: fallback,
                ...(waCredentials !== undefined && { credentials: waCredentials }),
              }).catch(() => { /* retry queue handles transient failures */ })
            },
          })
          if (decision.kind !== 'skip') sent++
        } catch (err) {
          console.error('[birthday] send failed', { businessId: biz.id, customerId: c.id, err: (err as Error).message })
        }
      }
      if (sent > 0) {
        await logAudit(db, { businessId: biz.id, actorId: null, action: 'birthday_greeting.swept', entityType: 'initiation', metadata: { due: sent } })
      }
    } catch (err) {
      console.error('[birthday] business tick failed', { businessId: biz.id, err: (err as Error).message })
    }
  }
}

export function startBirthdayWorker() {
  const worker = new Worker(QUEUE_NAME, async () => runBirthdayTick(), { connection: redisConnection })
  worker.on('failed', (job, err) => {
    console.error('[birthday] Job failed', { jobId: job?.id, err: err.message })
  })
  return worker
}

export async function scheduleBirthdayJob() {
  await birthdayQueue.add('tick', {}, { repeat: { every: REPEAT_EVERY_MS }, jobId: 'birthday-tick' })
}
