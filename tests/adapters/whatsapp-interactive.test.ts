/**
 * T4.2 — Parse interactive/button/list replies (INJ4/P7)
 *
 * Contract: normalizeWebhookPayload must extract the customer-selected text from
 * interactive and button message types into `body`, routing them through the normal
 * InboundMessage path — NOT the non_text_reply dead-end.
 *
 * Covered cases:
 *   - button_reply (interactive quick-reply tap) → body === title, nonTextReplies empty
 *   - list_reply (interactive list selection) → body === title, nonTextReplies empty
 *   - button (template quick-reply) → body === button.text, nonTextReplies empty
 *   - malformed interactive (no title/text) → falls to non-text dead-end, no crash
 *   - regression: image, text, and true-non-text (sticker) still behave correctly
 */
import { describe, it, expect } from 'vitest'
import { normalizeWebhookPayload } from '../../src/adapters/whatsapp/webhook.js'
import type { WhatsAppWebhookPayload } from '../../src/adapters/whatsapp/types.js'

// ─── helpers ────────────────────────────────────────────────────────────────

function makePayload(msg: Record<string, unknown>): WhatsAppWebhookPayload {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: {
                display_phone_number: '+972501234567',
                phone_number_id: 'phone-id-1',
              },
              messages: [msg as WhatsAppWebhookPayload['entry'][0]['changes'][0]['value']['messages'][0]],
            },
          },
        ],
      },
    ],
  }
}

const BASE_MSG = {
  id: 'msg-id-1',
  from: '972509999999',
  timestamp: '1750000000',
}

// ─── interactive button_reply ────────────────────────────────────────────────

describe('normalizeWebhookPayload — interactive button_reply', () => {
  it('routes button_reply as a normal InboundMessage (body === title)', () => {
    const payload = makePayload({
      ...BASE_MSG,
      type: 'interactive',
      interactive: {
        type: 'button_reply',
        button_reply: { id: 'btn-1', title: 'Yes, confirm' },
      },
    })
    const { messages, nonTextReplies } = normalizeWebhookPayload(payload)
    expect(messages).toHaveLength(1)
    expect(messages[0].body).toBe('Yes, confirm')
    expect(messages[0].messageId).toBe('msg-id-1')
    expect(messages[0].fromNumber).toBe('+972509999999')
    expect(messages[0].toNumber).toBe('+972501234567')
    expect(nonTextReplies).toHaveLength(0)
  })

  it('handles multi-word title with special characters in button_reply', () => {
    const payload = makePayload({
      ...BASE_MSG,
      type: 'interactive',
      interactive: {
        type: 'button_reply',
        button_reply: { id: 'btn-2', title: 'Monday at 10:00 AM' },
      },
    })
    const { messages, nonTextReplies } = normalizeWebhookPayload(payload)
    expect(messages).toHaveLength(1)
    expect(messages[0].body).toBe('Monday at 10:00 AM')
    expect(nonTextReplies).toHaveLength(0)
  })
})

// ─── interactive list_reply ──────────────────────────────────────────────────

describe('normalizeWebhookPayload — interactive list_reply', () => {
  it('routes list_reply as a normal InboundMessage (body === title)', () => {
    const payload = makePayload({
      ...BASE_MSG,
      type: 'interactive',
      interactive: {
        type: 'list_reply',
        list_reply: { id: 'row-1', title: 'Tuesday 14:00' },
      },
    })
    const { messages, nonTextReplies } = normalizeWebhookPayload(payload)
    expect(messages).toHaveLength(1)
    expect(messages[0].body).toBe('Tuesday 14:00')
    expect(nonTextReplies).toHaveLength(0)
  })
})

// ─── button (template quick-reply) ──────────────────────────────────────────

describe('normalizeWebhookPayload — button (template quick-reply)', () => {
  it('routes a template quick-reply button as a normal InboundMessage (body === button.text)', () => {
    const payload = makePayload({
      ...BASE_MSG,
      type: 'button',
      button: { text: 'Cancel booking', payload: 'CANCEL_BOOKING' },
    })
    const { messages, nonTextReplies } = normalizeWebhookPayload(payload)
    expect(messages).toHaveLength(1)
    expect(messages[0].body).toBe('Cancel booking')
    expect(nonTextReplies).toHaveLength(0)
  })

  it('routes a button with no payload field (payload-less quick-reply)', () => {
    const payload = makePayload({
      ...BASE_MSG,
      type: 'button',
      button: { text: 'Confirm' },
    })
    const { messages, nonTextReplies } = normalizeWebhookPayload(payload)
    expect(messages).toHaveLength(1)
    expect(messages[0].body).toBe('Confirm')
    expect(nonTextReplies).toHaveLength(0)
  })
})

// ─── malformed / edge cases ──────────────────────────────────────────────────

describe('normalizeWebhookPayload — malformed interactive (no crash, dead-end)', () => {
  it('interactive with no button_reply or list_reply falls to non-text dead-end', () => {
    // interactive.type exists but neither sub-object is present
    const payload = makePayload({
      ...BASE_MSG,
      type: 'interactive',
      interactive: { type: 'unknown_subtype' },
    })
    const { messages, nonTextReplies } = normalizeWebhookPayload(payload)
    expect(messages).toHaveLength(0)
    expect(nonTextReplies).toHaveLength(1)
  })

  it('interactive with button_reply.title empty string falls to non-text dead-end', () => {
    const payload = makePayload({
      ...BASE_MSG,
      type: 'interactive',
      interactive: {
        type: 'button_reply',
        button_reply: { id: 'btn-empty', title: '' },
      },
    })
    const { messages, nonTextReplies } = normalizeWebhookPayload(payload)
    expect(messages).toHaveLength(0)
    expect(nonTextReplies).toHaveLength(1)
  })

  it('button with empty text falls to non-text dead-end', () => {
    const payload = makePayload({
      ...BASE_MSG,
      type: 'button',
      button: { text: '', payload: 'SOME_PAYLOAD' },
    })
    const { messages, nonTextReplies } = normalizeWebhookPayload(payload)
    expect(messages).toHaveLength(0)
    expect(nonTextReplies).toHaveLength(1)
  })
})

// ─── regression: existing types still work ──────────────────────────────────

describe('normalizeWebhookPayload — regression: existing message types', () => {
  it('plain text message still produces an InboundMessage', () => {
    const payload = makePayload({
      ...BASE_MSG,
      type: 'text',
      text: { body: 'Hello there' },
    })
    const { messages, nonTextReplies } = normalizeWebhookPayload(payload)
    expect(messages).toHaveLength(1)
    expect(messages[0].body).toBe('Hello there')
    expect(nonTextReplies).toHaveLength(0)
  })

  it('image with caption still produces an InboundMessage with imageMediaId', () => {
    const payload = makePayload({
      ...BASE_MSG,
      type: 'image',
      image: { id: 'media-1', mime_type: 'image/jpeg', caption: 'Check this out' },
    })
    const { messages, nonTextReplies } = normalizeWebhookPayload(payload)
    expect(messages).toHaveLength(1)
    expect(messages[0].body).toBe('Check this out')
    expect(messages[0].imageMediaId).toBe('media-1')
    expect(nonTextReplies).toHaveLength(0)
  })

  it('image without caption produces an InboundMessage with empty body', () => {
    const payload = makePayload({
      ...BASE_MSG,
      type: 'image',
      image: { id: 'media-2', mime_type: 'image/png' },
    })
    const { messages, nonTextReplies } = normalizeWebhookPayload(payload)
    expect(messages).toHaveLength(1)
    expect(messages[0].body).toBe('')
    expect(messages[0].imageMediaId).toBe('media-2')
    expect(nonTextReplies).toHaveLength(0)
  })

  it('sticker (true non-text) falls to non-text dead-end', () => {
    const payload = makePayload({
      ...BASE_MSG,
      type: 'sticker',
      sticker: { id: 'sticker-1', mime_type: 'image/webp' },
    })
    const { messages, nonTextReplies } = normalizeWebhookPayload(payload)
    expect(messages).toHaveLength(0)
    expect(nonTextReplies).toHaveLength(1)
  })

  it('voice note (true non-text) falls to non-text dead-end', () => {
    const payload = makePayload({
      ...BASE_MSG,
      type: 'audio',
      audio: { id: 'audio-1', mime_type: 'audio/ogg' },
    })
    const { messages, nonTextReplies } = normalizeWebhookPayload(payload)
    expect(messages).toHaveLength(0)
    expect(nonTextReplies).toHaveLength(1)
  })
})
