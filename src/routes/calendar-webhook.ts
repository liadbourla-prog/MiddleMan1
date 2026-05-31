import type { FastifyInstance } from 'fastify'
import { handleWatchNotification, isInboundSyncEnabled } from '../domain/calendar/inbound-sync.js'

// Google Calendar push notifications (Phase 3 inbound sync). Google POSTs here
// with no useful body — all signal is in X-Goog-* headers. We acknowledge fast
// (Google needs a quick 2xx and retries on its own) and pull the actual changes
// asynchronously via the incremental sync engine. The whole subsystem is gated
// behind CALENDAR_INBOUND_SYNC_ENABLED until ops provisions the public callback.
export async function calendarWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post('/calendar/webhook', async (request, reply) => {
    // Always 200 — even when disabled — so Google doesn't back off the channel.
    if (!isInboundSyncEnabled()) return reply.code(200).send()

    const headers = request.headers
    const channelId = headerValue(headers['x-goog-channel-id'])
    const resourceId = headerValue(headers['x-goog-resource-id'])
    const channelToken = headerValue(headers['x-goog-channel-token'])
    const resourceState = headerValue(headers['x-goog-resource-state'])

    // Fire-and-forget: never block Google's POST on our reconcile work.
    void handleWatchNotification({ channelId, resourceId, channelToken, resourceState }).catch(
      (err: unknown) => {
        request.log.error({ err }, '[calendar-webhook] notification handling failed')
      },
    )

    return reply.code(200).send()
  })
}

function headerValue(h: string | string[] | undefined): string | undefined {
  if (Array.isArray(h)) return h[0]
  return h
}
