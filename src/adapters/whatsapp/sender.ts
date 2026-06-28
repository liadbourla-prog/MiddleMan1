import { AsyncLocalStorage } from 'async_hooks'
import type { OutboundMessage, SendResult } from './types.js'
import { eq } from 'drizzle-orm'

// When set, sendMessage captures replies into the array instead of posting to WA.
// Used by the /simulate route and integration tests.
export const replyCapture = new AsyncLocalStorage<string[]>()

/**
 * Splits a WhatsApp message body into parts that each fit within `limit` chars (default 4096).
 *
 * Algorithm:
 *   1. If body.length <= limit, return [body] — no split needed.
 *   2. Greedily build a part by scanning forward up to `limit` chars:
 *      a. Look for the last paragraph boundary (\n\n) within the window.
 *      b. If none, look for the last newline (\n) within the window.
 *      c. If still none, hard-chunk at exactly `limit` chars.
 *   3. Emit the part (trimEnd to discard trailing whitespace from the consumed boundary).
 *   4. Advance past the boundary. Trim leading whitespace from what remains only when the
 *      boundary was a paragraph/newline split (not a hard-chunk).
 *   5. Repeat until nothing remains.
 *   Empty parts are never emitted.
 *
 * Contract: every emitted part has length <= limit; joining all parts recovers
 * all content (boundary whitespace consumed at split points is the only loss).
 *
 * T4.1 / F1 / P7 — prevents silent 4096-char API rejection.
 */
export function splitForWhatsApp(body: string, limit = 4096): string[] {
  if (body.length <= limit) return [body]

  const parts: string[] = []
  let remaining = body

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      parts.push(remaining)
      break
    }

    // Window we can consume (chars 0..limit-1)
    const window = remaining.slice(0, limit)

    // Prefer paragraph boundary (\n\n) — find the LAST one inside the window
    const paraIdx = window.lastIndexOf('\n\n')
    if (paraIdx > 0) {
      const part = window.slice(0, paraIdx).trimEnd()
      if (part.length > 0) parts.push(part)
      // Advance past the \n\n boundary and trim leading whitespace from remainder
      remaining = remaining.slice(paraIdx + 2).trimStart()
      continue
    }

    // Fall back to last single newline inside the window
    const nlIdx = window.lastIndexOf('\n')
    if (nlIdx > 0) {
      const part = window.slice(0, nlIdx).trimEnd()
      if (part.length > 0) parts.push(part)
      // Advance past the \n boundary and trim leading whitespace from remainder
      remaining = remaining.slice(nlIdx + 1).trimStart()
      continue
    }

    // No boundary found — hard-chunk at `limit`. `.slice` cuts at a UTF-16 code unit,
    // so if char `limit-1` is a HIGH surrogate (0xD800–0xDBFF) its low surrogate sits at
    // `limit`; cutting there would sever an astral char (e.g. an emoji) into lone
    // surrogates → a corrupt char on the WhatsApp wire. Back the cut off by one so the
    // pair stays together. (The \n / \n\n branches above are BMP-safe — '\n' is never a
    // surrogate, so a boundary index never lands mid-pair.)
    let cut = limit
    const lastCode = remaining.charCodeAt(cut - 1)
    if (cut > 1 && lastCode >= 0xd800 && lastCode <= 0xdbff) cut--
    parts.push(remaining.slice(0, cut))
    remaining = remaining.slice(cut)
  }

  return parts.filter(p => p.length > 0)
}

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
  // Split into <=4096-char parts before any send. A single short body yields exactly
  // one part (byte-identical), so existing callers are unaffected.
  const parts = splitForWhatsApp(message.body)

  const capture = replyCapture.getStore()
  if (capture !== undefined) {
    // Push each part to the capture store. Short bodies still yield one entry.
    for (const part of parts) {
      capture.push(part)
    }
    return { ok: true, whatsappMessageId: 'sim-captured' }
  }

  const { accessToken, phoneNumberId } = resolveCredentials(credentials)
  const apiUrl = `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`

  // Send each part sequentially. On the first failure, return that failure immediately.
  // On full success, return the whatsappMessageId of the FIRST part.
  // Partial-delivery tradeoff (intentional, per spec): if part N fails after parts 1..N-1
  // already POSTed, those earlier parts are already delivered — there is no idempotency
  // guard, so a whole-message retry by the caller would re-send them. Accepted: dropping a
  // long reply silently (F1) is worse than a rare duplicated prefix on retry.
  let firstMessageId: string | undefined

  for (const part of parts) {
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
          text: { preview_url: false, body: part },
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

      if (firstMessageId === undefined) firstMessageId = id
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  return { ok: true, whatsappMessageId: firstMessageId! }
}
