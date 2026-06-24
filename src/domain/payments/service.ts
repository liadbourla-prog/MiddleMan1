// Payments service — the deterministic core of the money plane (design §5.2, §7).
// The ONLY thing the payment-request worker, the dunning worker, the Branch-3 requestPayment
// tool (Phase 4), and the webhook route call. It owns charge creation (→ Grow pay-link +
// ledger row) and webhook reconciliation (verify → approve → confirm booking → invoice).
//
// Honors CLAUDE.md Principle 1: the LLM never reaches here with money — callers pass a
// validated {amount, description, customer}; this module talks to Grow and writes state.

import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { bookings, businesses, identities, paymentRequests } from '../../db/schema.js'
import type { Booking } from '../../db/schema.js'
import { createGrowClient, type GrowClient } from '../../adapters/grow/client.js'
import { createCalendarClient, type CalendarClient } from '../../adapters/calendar/client.js'
import { getPaymentCredentials, getCredentialsByWebhookToken } from './credentials.js'
import { finalizePaidBooking } from '../booking/engine.js'
import { logAudit } from '../audit/logger.js'
import { enqueueMessage } from '../../workers/message-retry.js'
import { dispatchInitiation } from '../initiations/dispatch.js'
import { getInitiator } from '../initiations/registry.js'
import { resolveNotificationAction } from '../initiations/notification-rules.js'
import type { NotificationPreferences } from '../../shared/skill-types.js'
import type { NotificationRule } from '../initiations/notification-rules.js'
import type { Lang } from '../i18n/t.js'

function paymentBaseUrl(): string {
  return (process.env['PUBLIC_BASE_URL'] ?? '').replace(/\/+$/, '')
}

// ── createCharge ────────────────────────────────────────────────────────────

export interface CreateChargeInput {
  businessId: string
  bookingId?: string | null
  customerId?: string | null
  amount: number
  description: string
  source: 'booking' | 'owner_command' | 'dunning' | 'subscription'
  dedupKey: string
  customer?: { fullName?: string | undefined; phone?: string | undefined; email?: string | undefined }
}

export type CreateChargeResult =
  | { ok: true; paymentUrl: string; paymentRequestId: string; reused: boolean }
  | { ok: false; reason: 'not_connected' | 'already_paid' | 'grow_error' | 'no_base_url'; message?: string }

/**
 * Create a Grow pay-link for a charge and record it in the ledger. Idempotent per booking:
 * a booking that already has a live ('created') or settled ('paid') request is not charged
 * again at Grow — we return the existing link (or refuse, if already paid).
 */
export async function createCharge(
  db: Db,
  input: CreateChargeInput,
  deps?: { growClient?: GrowClient },
): Promise<CreateChargeResult> {
  const creds = await getPaymentCredentials(db, input.businessId)
  if (!creds) return { ok: false, reason: 'not_connected' }

  // Idempotency: don't double-create a Grow process for the same booking.
  if (input.bookingId) {
    const existing = await db
      .select()
      .from(paymentRequests)
      .where(and(eq(paymentRequests.bookingId, input.bookingId), inArray(paymentRequests.status, ['created', 'paid'])))
      .limit(1)
    const row = existing[0]
    if (row) {
      if (row.status === 'paid') return { ok: false, reason: 'already_paid' }
      if (row.paymentUrl) return { ok: true, paymentUrl: row.paymentUrl, paymentRequestId: row.id, reused: true }
    }
  }

  const base = paymentBaseUrl()
  if (!base) return { ok: false, reason: 'no_base_url' }
  const notifyUrl = `${base}/payment-webhook/grow/${creds.webhookToken}`

  const grow = deps?.growClient ?? createGrowClient(creds)
  const created = await grow.createPaymentProcess({
    sum: input.amount,
    description: input.description,
    fullName: input.customer?.fullName,
    phone: input.customer?.phone,
    email: input.customer?.email,
    notifyUrl,
  })
  if (!created.ok) {
    await logAudit(db, {
      businessId: input.businessId,
      actorId: null,
      action: 'payment.charge_failed',
      entityType: 'payment_request',
      ...(input.bookingId ? { entityId: input.bookingId } : {}),
      metadata: { reason: created.reason, source: input.source },
    }).catch(() => { /* best-effort */ })
    return { ok: false, reason: 'grow_error', message: created.message }
  }

  const [row] = await db
    .insert(paymentRequests)
    .values({
      businessId: input.businessId,
      bookingId: input.bookingId ?? null,
      customerId: input.customerId ?? null,
      amount: String(input.amount),
      currency: 'ILS',
      description: input.description,
      source: input.source,
      growProcessId: created.data.processId,
      paymentUrl: created.data.paymentUrl,
      status: 'created',
      dedupKey: input.dedupKey,
    })
    .returning({ id: paymentRequests.id })

  return { ok: true, paymentUrl: created.data.paymentUrl, paymentRequestId: row!.id, reused: false }
}

// ── reconcilePayment (webhook) ────────────────────────────────────────────────

export interface GrowWebhookFields {
  transactionCode: string
  processId?: string | undefined
  paymentSum?: number | undefined
  invoiceNumber?: string | undefined
  invoiceUrl?: string | undefined
  payerPhone?: string | undefined
}

export type ReconcileResult =
  | { ok: true; outcome: 'confirmed' | 'recorded' | 'already_processed' }
  | { ok: false; reason: 'unknown_token' | 'no_matching_charge' | 'verify_failed' | 'missing_transaction' }

// Re-verification is on by default (design §8: never mark paid on an unverified signal).
// PAYMENT_WEBHOOK_REVERIFY=off disables it for environments where Grow's getPaymentInfo
// endpoint isn't wired yet (§11.2/§11.4) — the unguessable token + idempotency still hold.
function reverifyEnabled(): boolean {
  return (process.env['PAYMENT_WEBHOOK_REVERIFY'] ?? 'on') !== 'off'
}

/**
 * Process a Grow success notify: verify → approveTransaction → flip the booking to
 * confirmed/paid (replacing the manual owner command) → forward the invoice. Idempotent on
 * transactionCode. Fail-closed: an unverifiable signal never confirms a booking.
 */
export async function reconcilePayment(
  db: Db,
  webhookToken: string,
  fields: GrowWebhookFields,
  deps?: { growClient?: GrowClient; calendar?: CalendarClient; enqueue?: (phone: string, body: string) => Promise<void> },
): Promise<ReconcileResult> {
  if (!fields.transactionCode) return { ok: false, reason: 'missing_transaction' }

  const creds = await getCredentialsByWebhookToken(db, webhookToken)
  if (!creds) return { ok: false, reason: 'unknown_token' }
  const businessId = creds.businessId

  // Match the charge we created. Prefer processId; fall back to an already-recorded txn code.
  const [charge] = await db
    .select()
    .from(paymentRequests)
    .where(
      fields.processId
        ? and(eq(paymentRequests.businessId, businessId), eq(paymentRequests.growProcessId, fields.processId))
        : and(eq(paymentRequests.businessId, businessId), eq(paymentRequests.transactionCode, fields.transactionCode)),
    )
    .limit(1)

  if (!charge) {
    await logAudit(db, {
      businessId, actorId: null, action: 'payment.webhook_unmatched', entityType: 'payment_request',
      metadata: { processId: fields.processId, transactionCode: fields.transactionCode },
    }).catch(() => {})
    return { ok: false, reason: 'no_matching_charge' }
  }

  // Idempotency: this exact transaction already settled — no-op.
  if (charge.status === 'paid' && charge.transactionCode === fields.transactionCode) {
    return { ok: true, outcome: 'already_processed' }
  }

  const grow = deps?.growClient ?? createGrowClient(creds)

  // Re-verify server-side before trusting the webhook (defense in depth §8).
  if (reverifyEnabled() && charge.growProcessId) {
    const info = await grow.getPaymentInfo(charge.growProcessId)
    const sumMismatch = info.ok && fields.paymentSum != null && info.data.sum != null && Number(info.data.sum) !== Number(fields.paymentSum)
    if (!info.ok || sumMismatch) {
      await logAudit(db, {
        businessId, actorId: null, action: 'payment.verify_failed', entityType: 'payment_request', entityId: charge.id,
        metadata: { reason: info.ok ? 'sum_mismatch' : info.reason, transactionCode: fields.transactionCode },
      }).catch(() => {})
      return { ok: false, reason: 'verify_failed' }
    }
  }

  // Mandatory ack back to Grow (design §2) — unacked transactions stay unsettled. A failed
  // ack is logged but must NOT un-confirm a payment the customer already made.
  const ack = await grow.approveTransaction(fields.transactionCode)
  if (!ack.ok) {
    await logAudit(db, {
      businessId, actorId: null, action: 'payment.approve_failed', entityType: 'payment_request', entityId: charge.id,
      metadata: { reason: ack.reason, transactionCode: fields.transactionCode },
    }).catch(() => {})
  }

  // Settle the ledger row.
  await db
    .update(paymentRequests)
    .set({
      status: 'paid',
      transactionCode: fields.transactionCode,
      invoiceNumber: fields.invoiceNumber ?? null,
      invoiceUrl: fields.invoiceUrl ?? null,
      updatedAt: new Date(),
    })
    .where(eq(paymentRequests.id, charge.id))

  await logAudit(db, {
    businessId, actorId: null, action: 'payment.received', entityType: 'payment_request', entityId: charge.id,
    metadata: { source: charge.source, bookingId: charge.bookingId, transactionCode: fields.transactionCode },
  }).catch(() => {})

  // Confirm the booking (replaces the manual 'PAID' command). Flipping it out of
  // pending_payment also stops the dunning worker for it (cancel-on-pay is automatic).
  let outcome: 'confirmed' | 'recorded' = 'recorded'
  if (charge.bookingId) {
    const [booking] = await db.select().from(bookings).where(eq(bookings.id, charge.bookingId)).limit(1)
    if (booking && booking.state === 'pending_payment') {
      const [customer] = await db
        .select({ id: identities.id, phoneNumber: identities.phoneNumber, preferredLanguage: identities.preferredLanguage })
        .from(identities)
        .where(eq(identities.id, booking.customerId))
        .limit(1)
      if (customer) {
        const calendar = deps?.calendar ?? (await calendarForBusiness(db, businessId))
        const fin = await finalizePaidBooking(
          db, calendar, businessId, booking as Booking,
          { id: customer.id, preferredLanguage: customer.preferredLanguage, phoneNumber: customer.phoneNumber },
          { actorId: null, triggeredBy: 'grow_webhook' },
        )
        if (fin.ok) outcome = 'confirmed'
      }
    }
  }

  // Forward the invoice PDF link to the customer (design §7).
  if (fields.invoiceUrl) {
    const phone = await customerPhoneFor(db, charge.customerId, charge.bookingId)
    if (phone) {
      const enqueue = deps?.enqueue ?? enqueueMessage
      const lang = await businessLang(db, businessId)
      const msg = lang === 'he'
        ? `🧾 הנה החשבונית שלך: ${fields.invoiceUrl}`
        : `🧾 Here's your invoice: ${fields.invoiceUrl}`
      await enqueue(phone, msg).catch(() => { /* non-fatal */ })
    }
  }

  // Owner "payment received" notification (Phase 3, design §7) — voluntary OAU. Sent ONLY if
  // the owner's notification rules say so (defaults to silent: payments confirm themselves end
  // to end and the owner's involuntary attention is driven toward zero). Best-effort: a notify
  // hiccup must never un-settle a payment the customer already made.
  await notifyOwnerPaymentReceived(db, businessId, charge, deps?.enqueue).catch(() => { /* non-fatal */ })

  return { ok: true, outcome }
}

/**
 * Notify the owner that a payment landed — but only as voluntary OAU, gated by the business's
 * notification rules (resolveNotificationAction for 'payment_received', which defaults to
 * handle_silently). Routed through the `payment.received` initiator so it is logged on the
 * spine and remains trust-ratchet-eligible. Owner-facing copy is in the business language.
 */
async function notifyOwnerPaymentReceived(
  db: Db,
  businessId: string,
  charge: { id: string; amount: string | null; description: string | null; source: string },
  enqueue?: (phone: string, body: string) => Promise<void>,
): Promise<void> {
  const [biz] = await db
    .select({
      name: businesses.name,
      defaultLanguage: businesses.defaultLanguage,
      notificationRules: businesses.notificationRules,
      notificationPreferences: businesses.notificationPreferences,
    })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)

  const action = resolveNotificationAction(
    (biz?.notificationRules as NotificationRule[] | null) ?? null,
    (biz?.notificationPreferences as NotificationPreferences | null) ?? null,
    'payment_received',
  )
  if (action === 'handle_silently') return

  // Owner notifications go to the business manager.
  const [manager] = await db
    .select({ id: identities.id, phoneNumber: identities.phoneNumber })
    .from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.role, 'manager'), isNull(identities.revokedAt)))
    .limit(1)
  if (!manager) return

  const lang: Lang = (biz?.defaultLanguage as Lang | null | undefined) ?? 'he'
  const amount = charge.amount != null && !Number.isNaN(Number(charge.amount)) ? `₪${Number(charge.amount)}` : null
  const what = charge.description ?? (lang === 'he' ? 'תשלום' : 'a payment')
  const body = lang === 'he'
    ? `🟢 התקבל תשלום${amount ? ` (${amount})` : ''} — ${what}.`
    : `🟢 Payment received${amount ? ` (${amount})` : ''} — ${what}.`

  const send = enqueue ?? enqueueMessage
  await dispatchInitiation(db, getInitiator('payment.received'), {
    businessId,
    recipientId: manager.id,
    dedupKey: `payment.received:${charge.id}`,
  }, {
    sendFreeForm: async () => { await send(manager.phoneNumber, body).catch(() => { /* non-fatal */ }) },
  }).catch(() => { /* non-fatal */ })
}

// ── refundCharge (owner-commanded) ───────────────────────────────────────────

export type RefundResult =
  | { ok: true; amount: number; description: string }
  | { ok: false; reason: 'not_connected' | 'not_found' | 'not_refundable' | 'grow_error'; message?: string }

/**
 * Refund a settled charge at Grow on the owner's command (design §9.5, out-of-scope for
 * automation — owner-driven only). Deterministic core: loads the ledger row, refuses anything
 * that isn't a paid charge with a transactionCode, calls grow.refundTransaction, flips the row
 * to 'refunded', and audits. The Branch-3 refundTransaction tool resolves WHICH charge; this
 * owns the money side. Fail-explicit: a Grow refund error never marks the row refunded.
 */
export async function refundCharge(
  db: Db,
  input: { businessId: string; paymentRequestId: string; actorId?: string | null },
  deps?: { growClient?: GrowClient },
): Promise<RefundResult> {
  const [charge] = await db
    .select()
    .from(paymentRequests)
    .where(and(eq(paymentRequests.id, input.paymentRequestId), eq(paymentRequests.businessId, input.businessId)))
    .limit(1)
  if (!charge) return { ok: false, reason: 'not_found' }
  if (charge.status !== 'paid' || !charge.transactionCode) return { ok: false, reason: 'not_refundable' }

  const creds = await getPaymentCredentials(db, input.businessId)
  if (!creds) return { ok: false, reason: 'not_connected' }

  const grow = deps?.growClient ?? createGrowClient(creds)
  const amount = Number(charge.amount)
  const refunded = await grow.refundTransaction(charge.transactionCode, Number.isFinite(amount) ? amount : undefined)
  if (!refunded.ok) {
    await logAudit(db, {
      businessId: input.businessId, actorId: input.actorId ?? null, action: 'payment.refund_failed',
      entityType: 'payment_request', entityId: charge.id,
      metadata: { reason: refunded.reason, transactionCode: charge.transactionCode },
    }).catch(() => {})
    return { ok: false, reason: 'grow_error', message: refunded.message }
  }

  await db.update(paymentRequests).set({ status: 'refunded', updatedAt: new Date() }).where(eq(paymentRequests.id, charge.id))
  await logAudit(db, {
    businessId: input.businessId, actorId: input.actorId ?? null, action: 'payment.refunded',
    entityType: 'payment_request', entityId: charge.id,
    metadata: { amount: charge.amount, transactionCode: charge.transactionCode },
  }).catch(() => {})

  return { ok: true, amount: Number.isFinite(amount) ? amount : 0, description: charge.description }
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function calendarForBusiness(db: Db, businessId: string): Promise<CalendarClient> {
  const [biz] = await db
    .select({ googleRefreshToken: businesses.googleRefreshToken, googleCalendarId: businesses.googleCalendarId, calendarMode: businesses.calendarMode })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)
  return createCalendarClient({
    accessToken: '',
    refreshToken: biz?.googleRefreshToken ?? '',
    calendarId: biz?.googleCalendarId ?? 'primary',
    businessId,
    calendarMode: biz?.calendarMode ?? 'internal',
  })
}

async function customerPhoneFor(db: Db, customerId: string | null, bookingId: string | null): Promise<string | null> {
  if (customerId) {
    const [c] = await db.select({ phone: identities.phoneNumber }).from(identities).where(eq(identities.id, customerId)).limit(1)
    if (c?.phone) return c.phone
  }
  if (bookingId) {
    const [b] = await db.select({ customerId: bookings.customerId }).from(bookings).where(eq(bookings.id, bookingId)).limit(1)
    if (b?.customerId) {
      const [c] = await db.select({ phone: identities.phoneNumber }).from(identities).where(eq(identities.id, b.customerId)).limit(1)
      return c?.phone ?? null
    }
  }
  return null
}

async function businessLang(db: Db, businessId: string): Promise<Lang> {
  const [biz] = await db.select({ defaultLanguage: businesses.defaultLanguage }).from(businesses).where(eq(businesses.id, businessId)).limit(1)
  return (biz?.defaultLanguage as Lang | null | undefined) ?? 'he'
}
