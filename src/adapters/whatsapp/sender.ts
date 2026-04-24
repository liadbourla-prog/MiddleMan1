import type { OutboundMessage, SendResult } from './types.js'

const WA_USER_OPT_OUT_CODE = 131026

export interface WaCredentials {
  accessToken: string
  phoneNumberId: string
}

export type SendResultWithOptOut = SendResult & { userOptedOut?: boolean }

function resolveCredentials(override?: WaCredentials): WaCredentials {
  return {
    accessToken: override?.accessToken ?? process.env['WHATSAPP_ACCESS_TOKEN'] ?? '',
    phoneNumberId: override?.phoneNumberId ?? process.env['WHATSAPP_PHONE_NUMBER_ID'] ?? '',
  }
}

export async function sendMessage(
  message: OutboundMessage,
  credentials?: WaCredentials,
): Promise<SendResultWithOptOut> {
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
      try {
        const parsed = JSON.parse(text) as { error?: { code?: number } }
        if (parsed.error?.code === WA_USER_OPT_OUT_CODE) userOptedOut = true
      } catch { /* ignore */ }

      return { ok: false, error: `WA API ${response.status}: ${text}`, userOptedOut }
    }

    const data = (await response.json()) as { messages: Array<{ id: string }> }
    const id = data.messages[0]?.id
    if (!id) return { ok: false, error: 'WA API returned no message id' }

    return { ok: true, whatsappMessageId: id }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
