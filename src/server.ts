import 'dotenv/config'
import Fastify from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { webhookRoutes } from './routes/webhook.js'
import { oauthRoutes } from './routes/oauth.js'
import { importRoutes } from './routes/import.js'
import { startHoldExpiryWorker, scheduleHoldExpiryJob } from './workers/hold-expiry.js'
import { startMessageRetryWorker } from './workers/message-retry.js'
import { startSessionExpiryWorker } from './workers/session-expiry.js'
import { startWaitlistWorker } from './workers/waitlist.js'

const PORT = parseInt(process.env['PORT'] ?? '3000', 10)

const isDev = process.env['NODE_ENV'] !== 'production'

const app = Fastify({
  logger: isDev
    ? { level: 'debug', transport: { target: 'pino-pretty' } }
    : { level: 'info' },
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
await app.register(importRoutes)

app.get('/health', async () => ({ status: 'ok' }))

const address = await app.listen({ port: PORT, host: '0.0.0.0' })
app.log.info(`Server listening on ${address}`)

startHoldExpiryWorker()
startMessageRetryWorker()
startSessionExpiryWorker()
startWaitlistWorker()
await scheduleHoldExpiryJob()
app.log.info('Background workers started')
