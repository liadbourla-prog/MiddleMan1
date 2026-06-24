// §10 verification — the centerpiece "no-owner-on-critical-path" integration test
// (design §10, requirement #1) plus the manual-edge counterpart.
//
// The autonomous loop must close with ZERO owner involvement: a post_payment booking sitting
// in `pending_payment` → createCharge mints a Grow link + ledger row → a simulated Grow success
// webhook drives reconcilePayment → finalizePaidBooking flips the booking to confirmed/paid →
// the invoice PDF is forwarded to the CUSTOMER → and the owner is never messaged (payment_received
// defaults to handle_silently). The existing service.test.ts only exercises the bookingId:null
// ad-hoc reconcile path; this file is the booking-attached path through finalizePaidBooking.
//
// finalizePaidBooking has real side effects (BullMQ enqueue, reminders, profile spend, the
// proactive-message LLM call). We stub those modules so the deterministic core runs without I/O
// while still exercising the genuine engine edge. The Grow client + calendar are injected.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Capture the engine's customer-confirmation enqueue (it goes through the real message-retry
// module, NOT deps.enqueue) so we can prove it targets the customer and never the owner.
const { enqueueMessageMock } = vi.hoisted(() => ({
  enqueueMessageMock: vi.fn(async (_phone: string, _body: string) => {}),
}))

vi.mock('../../src/workers/message-retry.js', () => ({
  enqueueMessage: enqueueMessageMock,
  messageRetryQueue: { add: async () => {} },
  startMessageRetryWorker: () => {},
}))
vi.mock('../../src/workers/reminder.js', () => ({
  scheduleReminders: async () => {},
  cancelReminders: async () => {},
}))
vi.mock('../../src/domain/customer/profile.js', () => ({
  recordCompletedBooking: async () => {},
}))
vi.mock('../../src/domain/calendar/booking-event.js', () => ({
  buildOneOnOneEventContent: async () => null,
  refreshGroupEventRoster: async () => {},
}))
vi.mock('../../src/adapters/llm/client.js', () => ({
  generateProactiveCustomerMessage: async (o: { fallback: string }) => o.fallback,
}))

import type { Db } from '../../src/db/client.js'
import {
  businessPaymentCredentials, paymentRequests, bookings, businesses, identities, serviceTypes, auditLog,
} from '../../src/db/schema.js'
import { createCharge, reconcilePayment } from '../../src/domain/payments/service.js'
import { confirmPaymentReceived } from '../../src/domain/booking/engine.js'
import { putSecret, __resetMemorySecretStore } from '../../src/adapters/secrets.js'
import type { GrowClient } from '../../src/adapters/grow/client.js'
import type { CalendarClient } from '../../src/adapters/calendar/client.js'

// ── Table-keyed fake DB (mirrors tests/payments/service.test.ts) ────────────────
function makeDb() {
  const selectQueues = new Map<unknown, unknown[][]>()
  const inserts: { table: unknown; vals: Record<string, unknown> }[] = []
  const updates: { table: unknown; set: Record<string, unknown> }[] = []
  function queueSelect(table: unknown, rows: unknown[]) {
    if (!selectQueues.has(table)) selectQueues.set(table, [])
    selectQueues.get(table)!.push(rows)
  }
  const db = {
    select: () => ({
      from: (table: unknown) => {
        const next = () => selectQueues.get(table)?.shift() ?? []
        const chain: Record<string, unknown> = {
          where: () => chain,
          innerJoin: () => chain,
          leftJoin: () => chain,
          orderBy: () => chain,
          limit: async () => next(),
          then: (res: (v: unknown) => unknown) => res(next()),
        }
        return chain
      },
    }),
    insert: (table: unknown) => ({
      values: (vals: Record<string, unknown>) => {
        inserts.push({ table, vals })
        return {
          returning: async () => [{ id: 'pr-1' }],
          onConflictDoUpdate: async () => {},
          onConflictDoNothing: () => ({ returning: async () => [{ id: 'il-1' }] }),
          then: (res: (v: undefined) => unknown) => res(undefined),
        }
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => {
        updates.push({ table, set })
        return { where: async () => {} }
      },
    }),
  }
  return { db: db as unknown as Db, queueSelect, inserts, updates }
}

function growStub(overrides: Partial<GrowClient> = {}): { client: GrowClient; calls: string[] } {
  const calls: string[] = []
  const client: GrowClient = {
    getApiInfo: async () => { calls.push('getApiInfo'); return { ok: true, data: { authenticated: true } } },
    createPaymentProcess: async () => { calls.push('createPaymentProcess'); return { ok: true, data: { paymentUrl: 'https://pay.grow/x', processId: 'PR1' } } },
    approveTransaction: async () => { calls.push('approveTransaction'); return { ok: true, data: { approved: true } } },
    getPaymentInfo: async () => { calls.push('getPaymentInfo'); return { ok: true, data: { status: 'paid', sum: 300 } } },
    refundTransaction: async () => { calls.push('refundTransaction'); return { ok: true, data: { refunded: true } } },
    ...overrides,
  }
  return { client, calls }
}

// confirmHold is the only calendar method finalizePaidBooking touches; the rest are unused.
function calendarStub(): CalendarClient {
  return {
    confirmHold: async (eventId: string) => ({ status: 'confirmed', eventId, etag: 'etag-1' }),
  } as unknown as CalendarClient
}

const RAW_KEY = 'grow-raw-secret-key'
const CUSTOMER_PHONE = '+972500000000'
const MANAGER_PHONE = '+972511111111'
let apiKeyRef: string

function connectedCredsRow() {
  return {
    businessId: 'biz-1', provider: 'grow', userId: 'U1', pageCode: 'P1', apiKeyRef,
    environment: 'sandbox', webhookToken: 'wh-tok-123', webhookSecret: 'wh-sec', status: 'connected',
  }
}

function pendingBookingRow() {
  return {
    id: 'bk-1', businessId: 'biz-1', customerId: 'c1', serviceTypeId: 'svc-1', providerId: 'prov-1',
    state: 'pending_payment', paymentStatus: 'unpaid', calendarEventId: 'evt-1',
    slotStart: new Date('2026-07-01T09:00:00Z'), createdAt: new Date('2026-06-24T00:00:00Z'),
  }
}

describe('§10 — autonomous payment loop with zero owner involvement', () => {
  const saved = { project: process.env['GOOGLE_CLOUD_PROJECT'], base: process.env['PUBLIC_BASE_URL'], reverify: process.env['PAYMENT_WEBHOOK_REVERIFY'] }
  beforeEach(async () => {
    delete process.env['GOOGLE_CLOUD_PROJECT']
    process.env['PAYMENTS_SECRET_BACKEND'] = 'memory'
    process.env['PUBLIC_BASE_URL'] = 'https://pa.example'
    delete process.env['PAYMENT_WEBHOOK_REVERIFY']
    __resetMemorySecretStore()
    apiKeyRef = await putSecret('k', RAW_KEY)
    enqueueMessageMock.mockClear()
  })
  afterEach(() => {
    for (const [k, v] of Object.entries({ GOOGLE_CLOUD_PROJECT: saved.project, PUBLIC_BASE_URL: saved.base, PAYMENT_WEBHOOK_REVERIFY: saved.reverify })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  })

  it('booking → Grow link → simulated webhook → confirmed + invoice to CUSTOMER, owner never messaged', async () => {
    const { db, queueSelect, inserts, updates } = makeDb()
    const grow = growStub()

    // ── Step 1: createCharge mints the Grow link + ledger row (no existing charge). ──
    queueSelect(businessPaymentCredentials, [connectedCredsRow()]) // getPaymentCredentials
    queueSelect(paymentRequests, []) // idempotency check → no existing charge
    const charge = await createCharge(
      db,
      { businessId: 'biz-1', bookingId: 'bk-1', customerId: 'c1', amount: 300, description: 'Reformer session', source: 'booking', dedupKey: 'payment.request:bk-1' },
      { growClient: grow.client },
    )
    expect(charge.ok).toBe(true)
    if (charge.ok) expect(charge.reused).toBe(false)
    const ledger = inserts.find((i) => i.table === paymentRequests)
    expect(ledger).toBeDefined()
    expect(ledger!.vals['status']).toBe('created')
    expect(ledger!.vals['growProcessId']).toBe('PR1')
    for (const v of Object.values(ledger!.vals)) expect(String(v)).not.toContain(RAW_KEY)

    // ── Step 2: a Grow success notify drives reconcile through finalizePaidBooking. ──
    // (The created charge is represented as the row reconcile matches by processId.)
    queueSelect(businessPaymentCredentials, [connectedCredsRow()]) // getCredentialsByWebhookToken
    queueSelect(paymentRequests, [{ id: 'pr-1', status: 'created', transactionCode: null, growProcessId: 'PR1', bookingId: 'bk-1', customerId: 'c1', amount: '300', description: 'Reformer session', source: 'booking' }])
    queueSelect(bookings, [pendingBookingRow()]) // reconcile booking lookup
    queueSelect(identities, [{ id: 'c1', phoneNumber: CUSTOMER_PHONE, preferredLanguage: 'en' }]) // reconcile customer lookup
    queueSelect(serviceTypes, [{ name: 'Reformer session' }]) // finalize service name
    queueSelect(businesses, [{ name: 'Biz', timezone: 'Asia/Jerusalem', defaultLanguage: 'en' }]) // finalize confirmation copy
    queueSelect(identities, [{ phone: CUSTOMER_PHONE }]) // invoice customerPhoneFor
    // notifyOwnerPaymentReceived reads the business: no rule + no legacy pref → handle_silently.
    queueSelect(businesses, [{ name: 'Biz', defaultLanguage: 'en', notificationRules: null, notificationPreferences: null }])

    const enqueued: { phone: string; body: string }[] = []
    const res = await reconcilePayment(
      db,
      'wh-tok-123',
      { transactionCode: 'TX1', processId: 'PR1', paymentSum: 300, invoiceUrl: 'https://grow/inv.pdf', invoiceNumber: 'INV-9' },
      { growClient: grow.client, calendar: calendarStub(), enqueue: async (phone, body) => { enqueued.push({ phone, body }) } },
    )

    // The booking transition happened end to end.
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.outcome).toBe('confirmed')
    expect(updates.some((u) => u.table === bookings && u.set['state'] === 'confirmed' && u.set['paymentStatus'] === 'paid')).toBe(true)
    expect(updates.some((u) => u.table === paymentRequests && u.set['status'] === 'paid' && u.set['transactionCode'] === 'TX1')).toBe(true)

    // The customer got EXACTLY the invoice message on deps.enqueue (owner-notify stayed silent).
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]!.phone).toBe(CUSTOMER_PHONE)
    expect(enqueued[0]!.body).toContain('https://grow/inv.pdf')

    // The engine's booking confirmation went to the CUSTOMER too — never the owner.
    expect(enqueueMessageMock).toHaveBeenCalled()
    for (const call of enqueueMessageMock.mock.calls) expect(call[0]).toBe(CUSTOMER_PHONE)

    // The single critical assertion: NO enqueue on ANY channel targeted the manager/owner phone.
    const allPhones = [...enqueued.map((e) => e.phone), ...enqueueMessageMock.mock.calls.map((c) => c[0])]
    expect(allPhones).not.toContain(MANAGER_PHONE)
  })

  it('reconcile fires finalizePaidBooking with triggeredBy:"grow_webhook" (replaces the manual edge)', async () => {
    const { db, queueSelect, inserts } = makeDb()
    queueSelect(businessPaymentCredentials, [connectedCredsRow()])
    queueSelect(paymentRequests, [{ id: 'pr-1', status: 'created', transactionCode: null, growProcessId: 'PR1', bookingId: 'bk-1', customerId: 'c1', amount: '300', description: 'Reformer session', source: 'booking' }])
    queueSelect(bookings, [pendingBookingRow()])
    queueSelect(identities, [{ id: 'c1', phoneNumber: CUSTOMER_PHONE, preferredLanguage: 'en' }])
    queueSelect(serviceTypes, [{ name: 'Reformer session' }])
    queueSelect(businesses, [{ name: 'Biz', timezone: 'Asia/Jerusalem', defaultLanguage: 'en' }])
    queueSelect(businesses, [{ name: 'Biz', defaultLanguage: 'en', notificationRules: null, notificationPreferences: null }])

    const res = await reconcilePayment(
      db, 'wh-tok-123', { transactionCode: 'TX1', processId: 'PR1', paymentSum: 300 },
      { growClient: growStub().client, calendar: calendarStub() },
    )
    expect(res.ok).toBe(true)
    const confirmed = inserts.find((i) => i.table === auditLog && (i.vals['action'] === 'booking.confirmed'))
    expect(confirmed).toBeDefined()
    expect((confirmed!.vals['metadata'] as { triggeredBy?: string }).triggeredBy).toBe('grow_webhook')
  })

  it('the manual manager_paid_command path still works (same finalize edge, owner-driven fallback)', async () => {
    const { db, queueSelect, inserts, updates } = makeDb()
    queueSelect(identities, [{ id: 'mgr-1', role: 'manager', businessId: 'biz-1', phoneNumber: MANAGER_PHONE }]) // manager actor
    queueSelect(identities, [{ id: 'c1', preferredLanguage: 'en' }]) // customer by phone
    queueSelect(bookings, [pendingBookingRow()]) // pending_payment booking
    queueSelect(serviceTypes, [{ name: 'Reformer session' }]) // finalize service name
    queueSelect(businesses, [{ name: 'Biz', timezone: 'Asia/Jerusalem', defaultLanguage: 'en' }]) // finalize copy

    const res = await confirmPaymentReceived(db, calendarStub(), 'biz-1', CUSTOMER_PHONE)
    expect(res.ok).toBe(true)
    expect(updates.some((u) => u.table === bookings && u.set['state'] === 'confirmed' && u.set['paymentStatus'] === 'paid')).toBe(true)
    const confirmed = inserts.find((i) => i.table === auditLog && (i.vals['action'] === 'booking.confirmed'))
    expect(confirmed).toBeDefined()
    expect((confirmed!.vals['metadata'] as { triggeredBy?: string }).triggeredBy).toBe('manager_paid_command')
    // The confirmation message reaches the customer (via the engine's enqueue), proving the edge fired.
    expect(enqueueMessageMock).toHaveBeenCalledWith(CUSTOMER_PHONE, expect.any(String))
  })
})
