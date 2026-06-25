import { AsyncLocalStorage } from 'async_hooks'
import type { OutboundMessage, SendResult } from './types.js'
import { eq } from 'drizzle-orm'

// When set, sendMessage captures replies into the array instead of posting to WA.
// Used by the /simulate route and integration tests.
export const replyCapture = new AsyncLocalStorage<string[]>()

const WA_USER_OPT_OUT_CODE = 131026
// Meta rejects a free-form send when >24h have passed since the customer last messaged
// this number ("re-engagement" error). This — not our local session table — is the
// authority on the 24h window. We surface it so callers can fall back to a template or
// report honestly, instead of pre-blocking sends our DB merely *thinks* are out of window.
const WA_REENGAGEMENT_CODE = 131047

export interface WaCredentials {
  accessToken: string
  phoneNumberId: string
}

export type SendResultWithOptOut = SendResult & { userOptedOut?: boolean; outsideWindow?: boolean }

function resolveCredentials(override?: WaCredentials): WaCredentials {
  return {
    accessToken: override?.accessToken ?? process.env['WHATSAPP_ACCESS_TOKEN'] ?? '',
    phoneNumberId: override?.phoneNumberId ?? process.env['WHATSAPP_PHONE_NUMBER_ID'] ?? '',
  }
}

/**
 * Returns true when we are inside WhatsApp's 24-hour customer service window for this identity.
 * Outside the window, only Meta-approved template messages may be sent (use sendTemplateMessage).
 *
 * Source of truth is identities.lastInboundAt — the timestamp of the person's last INBOUND message,
 * written by the webhook on every inbound before any early return. This matches Meta's real window.
 * (It was previously inferred from conversation_sessions.last_message_at, a session-lifecycle field
 * that diverged from the true last inbound and produced false "24h limit" claims — 2026-06-25 fix.)
 * null lastInboundAt = we've never received a message from them → window closed (template-only).
 */
export async function canSendFreeForm(identityId: string): Promise<boolean> {
  const { db } = await import('../../db/client.js')
  const { identities } = await import('../../db/schema.js')
  const cutoff = new Date(Date.now() - 24 * 60 * 60_000)
  const [row] = await db
    .select({ lastInboundAt: identities.lastInboundAt })
    .from(identities)
    .where(eq(identities.id, identityId))
    .limit(1)
  return !!row?.lastInboundAt && row.lastInboundAt >= cutoff
}

/**
 * Sends a pre-approved Meta template message.
 * Template names must be approved in Meta Business Manager before use.
 * Falls back to free-form text in the replyCapture (simulate) context.
 */
export async function sendTemplateMessage(params: {
  toNumber: string
  templateName: string
  languageCode: string
  components?: Array<{ type: string; parameters: Array<{ type: string; text: string }> }>
  bodyText?: string
  credentials?: WaCredentials
}): Promise<SendResultWithOptOut> {
  const capture = replyCapture.getStore()
  if (capture !== undefined) {
    capture.push(params.bodyText ?? `[template:${params.templateName}]`)
    return { ok: true, whatsappMessageId: 'sim-captured' }
  }

  const { accessToken, phoneNumberId } = resolveCredentials(params.credentials)
  const apiUrl = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: params.toNumber,
        type: 'template',
        template: {
          name: params.templateName,
          language: { code: params.languageCode },
          ...(params.components ? { components: params.components } : {}),
        },
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      let userOptedOut = false
      try {
        const parsed = JSON.parse(text) as { error?: { code?: number } }
        if (parsed.error?.code === WA_USER_OPT_OUT_CODE) userOptedOut = true
      } catch { /* ignore */ }
      return { ok: false, error: `WA template API ${response.status}: ${text}`, userOptedOut }
    }

    const data = (await response.json()) as { messages: Array<{ id: string }> }
    const id = data.messages[0]?.id
    if (!id) return { ok: false, error: 'WA template API returned no message id' }
    return { ok: true, whatsappMessageId: id }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function sendMessage(
  message: OutboundMessage,
  credentials?: WaCredentials,
): Promise<SendResultWithOptOut> {
  const capture = replyCapture.getStore()
  if (capture !== undefined) {
    capture.push(message.body)
    return { ok: true, whatsappMessageId: 'sim-captured' }
  }

  const { accessToken, phoneNumberId } = resolveCredentials(credentials)
  const apiUrl = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: message.toNumber,
        type: 'text',
        text: { preview_url: false, body: message.body },
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      let userOptedOut = false
      let outsideWindow = false
      try {
        const parsed = JSON.parse(text) as { error?: { code?: number } }
        if (parsed.error?.code === WA_USER_OPT_OUT_CODE) userOptedOut = true
        if (parsed.error?.code === WA_REENGAGEMENT_CODE) outsideWindow = true
      } catch { /* ignore */ }

      return { ok: false, error: `WA API ${response.status}: ${text}`, userOptedOut, outsideWindow }
    }

    const data = (await response.json()) as { messages: Array<{ id: string }> }
    const id = data.messages[0]?.id
    if (!id) return { ok: false, error: 'WA API returned no message id' }

    return { ok: true, whatsappMessageId: id }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
