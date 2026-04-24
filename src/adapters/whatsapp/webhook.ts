import crypto from 'crypto'
import type { InboundMessage, WhatsAppWebhookPayload } from './types.js'

const APP_SECRET = process.env['WHATSAPP_APP_SECRET'] ?? ''
const VERIFY_TOKEN = process.env['WHATSAPP_WEBHOOK_VERIFY_TOKEN'] ?? ''

export function verifySignature(rawBody: string, signature: string): boolean {
  if (!signature.startsWith('sha256=')) return false
  const expected = crypto
    .createHmac('sha256', APP_SECRET)
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

const NON_TEXT_REPLY = "I can only understand text messages. Please send your request as a text message."
const NON_TEXT_REPLY_HE = "אני מבין רק הודעות טקסט. אנא שלח את בקשתך כהודעת טקסט."

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
        const fromNumber = msg.from
        const toNumber = value.metadata.display_phone_number

        if (msg.type !== 'text' || !msg.text) {
          // Sticker, image, voice note, video, etc. — reply with guidance
          if (fromNumber && toNumber) {
            nonTextReplies.push({ toNumber: fromNumber, body: NON_TEXT_REPLY })
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
