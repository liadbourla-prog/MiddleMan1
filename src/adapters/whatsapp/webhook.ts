import crypto from 'crypto'
import type { InboundMessage, WhatsAppWebhookPayload } from './types.js'
import { i18n } from '../../domain/i18n/t.js'

const APP_SECRET = process.env['WHATSAPP_APP_SECRET'] ?? ''
const VERIFY_TOKEN = process.env['WHATSAPP_WEBHOOK_VERIFY_TOKEN'] ?? ''

export function verifySignature(rawBody: string, signature: string, appSecretOverride?: string): boolean {
  if (!signature.startsWith('sha256=')) return false
  const secret = appSecretOverride ?? APP_SECRET
  if (!secret) return false
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('hex')
  const received = signature.slice('sha256='.length)
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received))
}

export function verifyWebhookChallenge(
  mode: string,
  token: string,
  challenge: string,
): string | null {
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return challenge
  return null
}

export function normalizeWebhookPayload(payload: WhatsAppWebhookPayload): {
  messages: InboundMessage[]
  nonTextReplies: Array<{ toNumber: string; body: string }>
} {
  const messages: InboundMessage[] = []
  const nonTextReplies: Array<{ toNumber: string; body: string }> = []

  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      const value = change.value
      if (!value.messages) continue

      for (const msg of value.messages) {
        const fromNumber = msg.from.startsWith('+') ? msg.from : `+${msg.from}`
        // display_phone_number can come formatted e.g. "+1 555-631-3430" — normalise to E.164
        const rawDisplayNumber = value.metadata.display_phone_number.replace(/[\s()-]/g, '')
        const toNumber = rawDisplayNumber.startsWith('+') ? rawDisplayNumber : `+${rawDisplayNumber}`

        if (msg.type === 'image' && msg.image) {
          const body = msg.image.caption?.trim() ?? ''
          messages.push({
            messageId: msg.id,
            fromNumber,
            toNumber,
            body,
            timestamp: new Date(parseInt(msg.timestamp, 10) * 1000),
            rawPayload: payload,
            imageMediaId: msg.image.id,
            imageMediaType: msg.image.mime_type,
          })
          continue
        }

        // Interactive replies (quick-reply button tap or list selection) — extract the
        // customer-selected title and route as normal text so the downstream sanitize+fence
        // path (T4.3) covers it identically to a typed message.
        if (msg.type === 'interactive' && msg.interactive) {
          const title = msg.interactive.button_reply?.title ?? msg.interactive.list_reply?.title
          if (title?.trim()) {
            messages.push({
              messageId: msg.id,
              fromNumber,
              toNumber,
              body: title.trim(),
              timestamp: new Date(parseInt(msg.timestamp, 10) * 1000),
              rawPayload: payload,
            })
            continue
          }
          // Malformed / empty title — fall through to non-text dead-end below
        }

        // Template quick-reply button (msg.type === 'button') — extract the button text.
        if (msg.type === 'button' && msg.button) {
          const text = msg.button.text?.trim()
          if (text) {
            messages.push({
              messageId: msg.id,
              fromNumber,
              toNumber,
              body: text,
              timestamp: new Date(parseInt(msg.timestamp, 10) * 1000),
              rawPayload: payload,
            })
            continue
          }
          // Empty text — fall through to non-text dead-end below
        }

        if (msg.type !== 'text' || !msg.text) {
          // Sticker, voice note, video, etc. — reply with guidance
          if (fromNumber && toNumber) {
            nonTextReplies.push({ toNumber: fromNumber, body: i18n.non_text_reply.he })
          }
          continue
        }

        const body = msg.text.body?.trim()
        if (!body) {
          // Empty text body — skip silently (WhatsApp sometimes sends empty text events)
          continue
        }

        messages.push({
          messageId: msg.id,
          fromNumber,
          toNumber,
          body,
          timestamp: new Date(parseInt(msg.timestamp, 10) * 1000),
          rawPayload: payload,
        })
      }
    }
  }

  return { messages, nonTextReplies }
}
