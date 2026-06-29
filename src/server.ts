import 'dotenv/config'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { webhookRoutes } from './routes/webhook.js'
import { oauthRoutes } from './routes/oauth.js'
import { calendarWebhookRoutes } from './routes/calendar-webhook.js'
import { importRoutes } from './routes/import.js'
import { paymentConnectRoutes } from './routes/payment-connect/index.js'
import { paymentWebhookRoutes } from './routes/payment-webhook.js'
import { buildSiteRoutes } from './routes/build-site/index.js'
import { publicApiRoutes } from './routes/public-api/index.js'
import { startHoldExpiryWorker, scheduleHoldExpiryJob } from './workers/hold-expiry.js'
import { startMessageRetryWorker } from './workers/message-retry.js'
import { startSessionExpiryWorker } from './workers/session-expiry.js'
import { startWaitlistWorker } from './workers/waitlist.js'
import { startReminderWorker } from './workers/reminder.js'
import { startQueuedMessageWorker } from './workers/queued-messages.js'
import { startManagerSummaryWorker } from './workers/generate-manager-summary.js'
import { startOperatorSummaryWorker } from './workers/generate-operator-summary.js'
import { startCustomerSummaryWorker } from './workers/generate-customer-summary.js'
import { startDailyBriefingWorker } from './workers/daily-briefing.js'
import { startCalendarMirrorWorker } from './workers/calendar-mirror.js'
import { startReshuffleCampaignWorker } from './workers/reshuffle-campaign.js'
import { startCalendarSyncRenewalWorker, scheduleCalendarSyncRenewalJob } from './workers/calendar-sync-renewal.js'
import { startSeriesMaterializerWorker } from './workers/series-materializer.js'
import { startIntegritySentinelWorker, scheduleIntegritySentinelJob } from './workers/integrity-sentinel.js'
import { startOutreachReplyNotifyWorker } from './workers/outreach-reply-notify.js'
import { startCoordinationExpiryWorker } from './workers/coordination-expiry.js'
import { startOwnerQuestionExpiryWorker } from './workers/owner-question-expiry.js'
import { startWinbackWorker, scheduleWinbackJob } from './workers/winback.js'
import { startPostAppointmentWorker, schedulePostAppointmentJob } from './workers/post-appointment.js'
import { startDunningWorker, scheduleDunningJob } from './workers/dunning.js'
import { startPaymentRequestWorker, schedulePaymentRequestJob } from './workers/payment-request.js'
import { startSubscriptionRenewalWorker, scheduleSubscriptionRenewalJob } from './workers/subscription-renewal.js'
import { startPeriodicTreatmentWorker, schedulePeriodicTreatmentJob } from './workers/periodic-treatment.js'
import { startBirthdayWorker, scheduleBirthdayJob } from './workers/birthday.js'

const PORT = parseInt(process.env['PORT'] ?? '3000', 10)

const isDev = process.env['NODE_ENV'] !== 'production'

// Defense-in-depth (Grow design §8): even though the payment adapter never logs the raw
// apiKey, redact it at the logger so a stray object spread can't leak it into Cloud Run logs.
const REDACT_PATHS = ['apiKey', 'api_key', '*.apiKey', '*.api_key', 'payload.apiKey', 'fields.apiKey']

const app = Fastify({
  logger: isDev
    ? { level: 'debug', redact: REDACT_PATHS, transport: { target: 'pino-pretty' } }
    : { level: 'info', redact: REDACT_PATHS },
})

// Rate limit inbound webhook by sender phone number (extracted from body)
// WhatsApp re-sends on non-200, so we still return 200 but drop the message
await app.register(rateLimit, {
  max: 20,
  timeWindow: '1 minute',
  keyGenerator: (request) => {
    try {
      const body = request.body as { entry?: Array<{ changes?: Array<{ value?: { messages?: Array<{ from?: string }> } }> }> }
      const from = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from
      return from ?? (request.ip ?? 'unknown')
    } catch {
      return request.ip ?? 'unknown'
    }
  },
  errorResponseBuilder: () => ({ statusCode: 200, message: 'OK' }), // still 200 to avoid WA retries
})

// Store raw body for WhatsApp signature verification
app.addContentTypeParser(
  'application/json',
  { parseAs: 'string' },
  function (req, body, done) {
    try {
      ;(req as unknown as Record<string, unknown>)['rawBody'] = body
      done(null, JSON.parse(body as string))
    } catch (err) {
      done(err as Error, undefined)
    }
  },
)

await app.register(webhookRoutes)
await app.register(oauthRoutes)
await app.register(calendarWebhookRoutes)
await app.register(importRoutes)
await app.register(paymentConnectRoutes)
await app.register(paymentWebhookRoutes)
await app.register(buildSiteRoutes)
await app.register(publicApiRoutes)

if (isDev) {
  const { simulateRoutes } = await import('./routes/simulate.js')
  await app.register(simulateRoutes)
}

app.get('/health', async () => ({ status: 'ok' }))

const address = await app.listen({ port: PORT, host: '0.0.0.0' })
app.log.info(`Server listening on ${address}`)

startHoldExpiryWorker()
startMessageRetryWorker()
startSessionExpiryWorker()
startWaitlistWorker()
startReminderWorker()
startQueuedMessageWorker()
startManagerSummaryWorker()
startOperatorSummaryWorker()
startCustomerSummaryWorker()
startDailyBriefingWorker()
startCalendarMirrorWorker()
startCalendarSyncRenewalWorker()
startSeriesMaterializerWorker()
startReshuffleCampaignWorker()
startIntegritySentinelWorker()
startOutreachReplyNotifyWorker()
startCoordinationExpiryWorker()
startOwnerQuestionExpiryWorker()
startWinbackWorker()
startPostAppointmentWorker()
startDunningWorker()
startPaymentRequestWorker()
startSubscriptionRenewalWorker()
startPeriodicTreatmentWorker()
startBirthdayWorker()
await scheduleHoldExpiryJob()
await scheduleCalendarSyncRenewalJob()
await scheduleIntegritySentinelJob()
await scheduleWinbackJob()
await schedulePostAppointmentJob()
await scheduleDunningJob()
await schedulePaymentRequestJob()
await scheduleSubscriptionRenewalJob()
await schedulePeriodicTreatmentJob()
await scheduleBirthdayJob()
app.log.info('Background workers started')
