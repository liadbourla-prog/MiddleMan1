import type { FastifyInstance } from 'fastify'
import { db } from '../db/client.js'
import { reconcilePayment, type GrowWebhookFields } from '../domain/payments/service.js'

// Grow (Meshulam) success-notify target — the notifyUrl set on every createPaymentProcess
// (design §5.4, §8). Path carries the per-business unguessable webhook token; the body
// carries the transaction. We acknowledge fast (200 regardless) so Grow doesn't hammer the
// endpoint, and run reconcilePayment which re-verifies server-side, approves the transaction
// back to Grow, confirms the booking, and forwards the invoice — all idempotent on
// transactionCode. Grow posts form-encoded (not JSON), so we scope a urlencoded parser here.
export async function paymentWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      try {
        done(null, Object.fromEntries(new URLSearchParams(body as string).entries()))
      } catch (err) {
        done(err as Error, undefined)
      }
    },
  )

  app.post<{ Params: { token: string }; Body: Record<string, string> | undefined }>(
    '/payment-webhook/grow/:token',
    async (request, reply) => {
      const { token } = request.params
      const fields = extractFields((request.body ?? {}) as Record<string, string>)

      // Process synchronously (the work is short and idempotent), but never surface an error
      // status to Grow — we log and 200 so a transient fault doesn't trigger a retry storm.
      try {
        const result = await reconcilePayment(db, token, fields)
        if (!result.ok) {
          request.log.warn({ token: redactToken(token), reason: result.reason }, '[payment-webhook] reconcile not applied')
        } else {
          request.log.info({ outcome: result.outcome }, '[payment-webhook] reconciled')
        }
      } catch (err) {
        request.log.error({ err: err instanceof Error ? err.message : String(err) }, '[payment-webhook] reconcile threw')
      }

      return reply.code(200).send({ ok: true })
    },
  )
}

// Map Grow's notify field names onto our reconcile contract. Grow's exact field naming is a
// §11 open question; accept the documented names plus common aliases so a confirmed schema
// drops in without a route change.
function extractFields(body: Record<string, string>): GrowWebhookFields {
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = body[k]
      if (v != null && String(v).trim() !== '') return String(v)
    }
    return undefined
  }
  const sumStr = pick('paymentSum', 'sum', 'amount')
  return {
    transactionCode: pick('transactionCode', 'transactionId', 'transaction_id') ?? '',
    processId: pick('processId', 'processToken', 'process_id'),
    paymentSum: sumStr != null && !Number.isNaN(Number(sumStr)) ? Number(sumStr) : undefined,
    invoiceNumber: pick('invoiceNumber', 'invoice_number'),
    invoiceUrl: pick('invoiceUrl', 'invoice_url'),
    payerPhone: pick('payerPhone', 'phone', 'payer_phone'),
  }
}

function redactToken(token: string): string {
  return token.length > 8 ? `${token.slice(0, 8)}…` : '…'
}
