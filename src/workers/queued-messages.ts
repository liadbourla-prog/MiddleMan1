import { Worker, Queue } from 'bullmq'
import { eq, and, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { businesses, identities } from '../db/schema.js'
import { redisConnection } from '../redis.js'
import { resolveIdentity } from '../domain/identity/resolver.js'
import { loadActiveSession, createSession, completeSession } from '../domain/session/manager.js'
import { handleBookingFlow } from '../domain/flows/customer-booking.js'
import { createCalendarClient } from '../adapters/calendar/client.js'
import { loadCustomerMemory } from '../domain/customer/profile.js'
import { buildHydratedContext } from '../domain/session/hydration.js'
import { updateSessionContext } from '../domain/session/manager.js'
import { saveMessage, loadTranscript } from '../domain/messages/repository.js'
import { sendMessage } from '../adapters/whatsapp/sender.js'

const QUEUE_NAME = 'queued-messages'

export interface QueuedMessageJob {
  businessId: string
  fromNumber: string
  toNumber: string
  body: string
}

export const queuedMessageQueue = new Queue<QueuedMessageJob>(QUEUE_NAME, { connection: redisConnection })

export async function queueMessageForLater(
  businessId: string,
  fromNumber: string,
  toNumber: string,
  body: string,
  delayMs: number,
): Promise<void> {
  await queuedMessageQueue.add(
    'process',
    { businessId, fromNumber, toNumber, body },
    {
      delay: delayMs,
      attempts: 2,
      backoff: { type: 'fixed', delay: 60_000 },
      jobId: `queued-${businessId}-${fromNumber}-${Date.now()}`,
    },
  )
}

async function processJob(job: { data: QueuedMessageJob }) {
  const { businessId, fromNumber, body } = job.data

  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)

  if (!business || business.paused) return

  let identityResult = await resolveIdentity(db, businessId, fromNumber)
  if (!identityResult.found) return
  if ('reason' in identityResult && identityResult.reason === 'revoked') return
  const identity = identityResult.identity

  if (identity.messagingOptOut) return

  const waCredentials = business.whatsappPhoneNumberId && business.whatsappAccessToken
    ? { accessToken: business.whatsappAccessToken, phoneNumberId: business.whatsappPhoneNumberId }
    : undefined

  let session = await loadActiveSession(db, identity.id)
  if (!session) {
    const memory = await loadCustomerMemory(db, identity.id)
    const hydratedContext = await buildHydratedContext(db, identity.id, businessId, memory)
    session = await createSession(db, businessId, identity.id, 'booking')
    await updateSessionContext(db, session.id, hydratedContext as unknown as Record<string, unknown>)
    session = { ...session, context: hydratedContext as unknown as Record<string, unknown> }
  }

  const [managerIdentity] = await db
    .select({ phoneNumber: identities.phoneNumber })
    .from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.role, 'manager'), isNull(identities.revokedAt)))
    .limit(1)

  const calendar = createCalendarClient({
    accessToken: '',
    refreshToken: business.googleRefreshToken ?? process.env['GOOGLE_REFRESH_TOKEN'] ?? '',
    calendarId: business.googleCalendarId,
    businessId,
    calendarMode: business.calendarMode,
    ...(managerIdentity ? { managerPhoneNumber: managerIdentity.phoneNumber } : {}),
  })

  await saveMessage(db, session.id, 'customer', body).catch(() => {})
  const transcript = await loadTranscript(db, session.id, 8).catch(() => [])

  const result = await handleBookingFlow(
    db, calendar, identity, session, body,
    business.timezone, business.name, transcript,
    business.botPersona, business, business.defaultLanguage,
  )

  await saveMessage(db, session.id, 'assistant', result.reply).catch(() => {})

  if (result.reply) {
    await sendMessage({ toNumber: fromNumber, body: result.reply }, waCredentials).catch(() => {})
  }

  if (result.sessionComplete) {
    await completeSession(db, session.id)
  }
}

export function startQueuedMessageWorker() {
  const worker = new Worker<QueuedMessageJob>(
    QUEUE_NAME,
    async (job) => processJob(job),
    { connection: redisConnection },
  )

  worker.on('failed', (job, err) => {
    console.error('[queued-messages] Job failed', { jobId: job?.id, err: err.message })
  })

  return worker
}
