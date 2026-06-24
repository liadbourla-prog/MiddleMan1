import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { businesses } from '../../db/schema.js'
import { sendMessage } from '../../adapters/whatsapp/sender.js'
import { type Lang } from '../../domain/i18n/t.js'
import {
  getValidConnectToken,
  consumeConnectToken,
  connectPaymentCredentials,
} from '../../domain/payments/credentials.js'

// Signed credential-capture web form for Grow payments onboarding (design §4.1).
// Mirrors the CSV-import page (routes/import.ts): a one-time signed link (payment_connect_tokens)
// opens a small TLS form where the owner pastes their Grow userId / pageCode / apiKey. Secrets
// NEVER travel through WhatsApp — only this form, over TLS, straight to the backend, which
// live-validates against Grow before accepting and stores the apiKey in Secret Manager.

export async function paymentConnectRoutes(app: FastifyInstance) {
  // Parse the form POST body. The app only registers a JSON parser globally; scope a
  // urlencoded parser to this plugin so request.body is populated for our handler.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        const params = new URLSearchParams(body as string)
        done(null, Object.fromEntries(params.entries()))
      } catch (err) {
        done(err as Error, undefined)
      }
    },
  )

  // Serve the form
  app.get<{ Params: { token: string } }>('/payment-connect/:token', async (request, reply) => {
    const status = await getValidConnectToken(db, request.params.token)
    if (!status.ok) {
      const msg = status.reason === 'used'
        ? 'This link has already been used.'
        : status.reason === 'expired'
          ? 'This link has expired. Ask your PA for a new one.'
          : 'Link not found or already expired.'
      return reply.status(status.reason === 'not_found' ? 404 : 410).type('text/html').send(errorPage(msg))
    }
    return reply.type('text/html').send(formPage(request.params.token))
  })

  // Handle the form submit
  app.post<{ Params: { token: string }; Body: Record<string, string> }>(
    '/payment-connect/:token',
    async (request, reply) => {
      const { token } = request.params

      const status = await getValidConnectToken(db, token)
      if (!status.ok) {
        const msg = status.reason === 'used' ? 'This link has already been used.' : 'This link has expired or is invalid.'
        return reply.status(410).type('text/html').send(errorPage(msg))
      }
      const record = status.record

      const body = request.body ?? {}
      const userId = (body['userId'] ?? '').trim()
      const pageCode = (body['pageCode'] ?? '').trim()
      const apiKey = (body['apiKey'] ?? '').trim()
      const environment = body['environment'] === 'sandbox' ? 'sandbox' : 'production'

      if (!userId || !pageCode || !apiKey) {
        // Don't consume the token — let them correct and resubmit the same link.
        return reply.status(400).type('text/html').send(formPage(token, 'Please fill in all three fields.', { userId, pageCode }))
      }

      const result = await connectPaymentCredentials(db, { businessId: record.businessId, userId, pageCode, apiKey, environment })

      if (!result.ok) {
        // Validation/transient failures keep the link alive so the owner can retry. We never
        // echo the apiKey back into the form (it would re-expose the secret in the HTML).
        const msg = result.reason === 'transient'
          ? "Couldn't reach Grow to validate just now — please try again in a moment."
          : result.reason === 'storage_failed'
            ? 'A configuration problem stopped us saving the credentials. Your PA has been alerted.'
            : 'Grow rejected these credentials. Double-check the userId, pageCode and API key, then try again.'
        return reply.status(result.reason === 'transient' ? 503 : 400).type('text/html').send(formPage(token, msg, { userId, pageCode }))
      }

      // Success — burn the single-use token and confirm in WhatsApp.
      await consumeConnectToken(db, token)

      const [business] = await db.select().from(businesses).where(eq(businesses.id, record.businessId)).limit(1)
      if (business) {
        const lang: Lang = (business.defaultLanguage as Lang | null | undefined) ?? 'he'
        const waCredentials = business.whatsappPhoneNumberId && business.whatsappAccessToken
          ? { accessToken: business.whatsappAccessToken, phoneNumberId: business.whatsappPhoneNumberId }
          : undefined
        const confirm = lang === 'he'
          ? '✅ התשלומים מחוברים — אני יכול עכשיו לשלוח קישורי תשלום ולהפיק חשבוניות אוטומטית.'
          : '✅ Payments are connected — I can now send pay-links and invoices automatically.'
        await sendMessage({ toNumber: record.managerPhone, body: confirm }, waCredentials).catch(() => { /* non-fatal */ })
      }

      app.log.info({ businessId: record.businessId, environment }, 'Payments connected via web form')
      return reply.type('text/html').send(successPage())
    },
  )
}

// ── HTML pages ──────────────────────────────────────────────────────────────
// Deliberately a "machine API credentials" form, not a sign-in (design §4.2): we never take
// the owner's Grow dashboard password and there is no OAuth.

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

function formPage(token: string, error?: string, prefill?: { userId?: string; pageCode?: string }): string {
  const errBanner = error ? `<div class="err">${esc(error)}</div>` : ''
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Connect Payments — PA Setup</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 520px; margin: 48px auto; padding: 0 24px; color: #111; }
    h1 { font-size: 1.4rem; margin-bottom: 4px; }
    p { color: #555; line-height: 1.5; }
    label { display: block; font-weight: 600; margin: 18px 0 6px; }
    input[type=text], input[type=password] { width: 100%; box-sizing: border-box; padding: 12px; font-size: 1rem; border: 1px solid #ccc; border-radius: 8px; }
    .radio { margin-top: 10px; color: #555; }
    button { background: #6C2BD9; color: #fff; border: none; border-radius: 8px; padding: 14px 32px; font-size: 1rem; cursor: pointer; margin-top: 24px; width: 100%; }
    .hint { font-size: .82rem; color: #888; margin-top: 6px; }
    .err { background: #fdecea; color: #b3261e; border-radius: 8px; padding: 12px; margin-top: 12px; font-size: .9rem; }
    .note { background: #f4f0fb; border-radius: 8px; padding: 14px 16px; margin-top: 16px; font-size: .9rem; color: #444; }
  </style>
</head>
<body>
  <h1>Connect your Grow payments</h1>
  <p>This securely links your <b>Grow (Meshulam)</b> merchant account so your PA can send pay-links and invoices automatically.</p>
  <div class="note">
    These are your <b>API credentials</b> — not your Grow login. Find them in your Grow dashboard under
    <b>Settings → API / Developers</b>. If the API isn't enabled yet, ask Grow support to
    <b>enable the API and webhooks</b> for your account, then come back to this link.
  </div>
  ${errBanner}
  <form action="/payment-connect/${token}" method="POST">
    <label for="userId">User ID</label>
    <input type="text" id="userId" name="userId" autocomplete="off" value="${esc(prefill?.userId ?? '')}" required>
    <label for="pageCode">Page Code</label>
    <input type="text" id="pageCode" name="pageCode" autocomplete="off" value="${esc(prefill?.pageCode ?? '')}" required>
    <label for="apiKey">API Key</label>
    <input type="password" id="apiKey" name="apiKey" autocomplete="off" required>
    <div class="hint">Your API key is sent over a secure connection, stored encrypted, and never shown in chat.</div>
    <div class="radio">
      <label style="display:inline;font-weight:600">Environment:</label>
      <label style="display:inline;font-weight:400"><input type="radio" name="environment" value="production" checked> Production</label>
      <label style="display:inline;font-weight:400"><input type="radio" name="environment" value="sandbox"> Sandbox</label>
    </div>
    <button type="submit">Connect payments</button>
  </form>
  <p class="hint">This link expires in 30 minutes and can only be used once.</p>
</body>
</html>`
}

function successPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payments Connected</title>
  <style>body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 24px; text-align: center; color: #111; }</style>
</head>
<body>
  <div style="font-size:3rem">✅</div>
  <h1>Payments connected!</h1>
  <p style="color:#555">Your PA can now send pay-links and invoices automatically. You can close this tab and return to WhatsApp.</p>
</body>
</html>`
}

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error</title>
  <style>body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 24px; text-align: center; color: #111; }</style>
</head>
<body>
  <div style="font-size:3rem">⚠️</div>
  <h1>Something went wrong</h1>
  <p style="color:#555">${esc(message)}</p>
</body>
</html>`
}
