export interface InboundMessage {
  messageId: string
  fromNumber: string
  toNumber: string
  body: string
  timestamp: Date
  rawPayload: unknown
}

export interface OutboundMessage {
  toNumber: string
  body: string
}

export type SendResult =
  | { ok: true; whatsappMessageId: string }
  | { ok: false; error: string }

// WhatsApp Cloud API webhook payload shape (relevant fields only)
export interface WhatsAppWebhookPayload {
  object: string
  entry: Array<{
    id: string
    changes: Array<{
      value: {
        messaging_product: string
        metadata: { display_phone_number: string; phone_number_id: string }
        messages?: Array<{
          id: string
          from: string
          timestamp: string
          type: string
          text?: { body: string }
        }>
      }
      field: string
    }>
  }>
}
