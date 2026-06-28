export interface InboundMessage {
  messageId: string
  fromNumber: string
  toNumber: string
  body: string
  timestamp: Date
  rawPayload: unknown
  imageMediaId?: string
  imageMediaType?: string
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
          image?: { id: string; mime_type: string; caption?: string }
          interactive?: {
            type: string
            button_reply?: { id: string; title: string }
            list_reply?: { id: string; title: string }
          }
          button?: { text: string; payload?: string }
        }>
        // Delivery-status callbacks (sent/delivered/read/failed). A `failed` status is how Meta
        // reports an ASYNCHRONOUS delivery failure — e.g. re-engagement (code 131047) when a
        // free-form message was accepted (HTTP 200) but the recipient is outside the 24h window.
        statuses?: Array<{
          id: string // the outbound message's wamid
          status: 'sent' | 'delivered' | 'read' | 'failed'
          timestamp: string
          recipient_id: string // E.164 without leading '+'
          errors?: Array<{ code: number; title?: string; message?: string }>
        }>
      }
      field: string
    }>
  }>
}
