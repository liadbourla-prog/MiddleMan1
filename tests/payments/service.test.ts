import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Db } from '../../src/db/client.js'
import { businessPaymentCredentials, paymentRequests, businesses, identities } from '../../src/db/schema.js'
import { createCharge, reconcilePayment, refundCharge } from '../../src/domain/payments/service.js'
import { putSecret, __resetMemorySecretStore } from '../../src/adapters/secrets.js'
import type { GrowClient } from '../../src/adapters/grow/client.js'

// ── Table-keyed fake DB ────────────────────────────────────────────────────────
// Each table has its own queue of canned select results, so interleaved reads stay
// deterministic. Captures inserts/updates for assertions.
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
          // dispatchInitiation's idempotency insert: returns a non-empty row → "first insert wins".
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

function growStub(overrides: Partial<GrowClient> = {}): { client: GrowClient; calls: string[]; createArgs: unknown[] } {
  const calls: string[] = []
  const createArgs: unknown[] = []
  const client: GrowClient = {
    getApiInfo: async () => { calls.push('getApiInfo'); return { ok: true, data: { authenticated: true } } },
    createPaymentProcess: async (a) => { calls.push('createPaymentProcess'); createArgs.push(a); return { ok: true, data: { paymentUrl: 'https://pay.grow/x', processId: 'PR1' } } },
    approveTransaction: async () => { calls.push('approveTransaction'); return { ok: true, data: { approved: true } } },
    getPaymentInfo: async () => { calls.push('getPaymentInfo'); return { ok: true, data: { status: 'paid', sum: 300 } } },
    refundTransaction: async () => { calls.push('refundTransaction'); return { ok: true, data: { refunded: true } } },
    ...overrides,
  }
  return { client, calls, createArgs }
}

const RAW_KEY = 'grow-raw-secret-key'
let apiKeyRef: string
function connectedCredsRow() {
  return {
    businessId: 'biz-1', provider: 'grow', userId: 'U1', pageCode: 'P1', apiKeyRef,
    environment: 'sandbox', webhookToken: 'wh-tok-123', webhookSecret: 'wh-sec', status: 'connected',
  }
}

describe('PaymentService', () => {
  const saved = { project: process.env['GOOGLE_CLOUD_PROJECT'], base: process.env['PUBLIC_BASE_URL'], reverify: process.env['PAYMENT_WEBHOOK_REVERIFY'] }
  beforeEach(async () => {
    delete process.env['GOOGLE_CLOUD_PROJECT']
    process.env['PAYMENTS_SECRET_BACKEND'] = 'memory'
    process.env['PUBLIC_BASE_URL'] = 'https://pa.example'
    delete process.env['PAYMENT_WEBHOOK_REVERIFY']
    __resetMemorySecretStore()
    apiKeyRef = await putSecret('k', RAW_KEY)
  })
  afterEach(() => {
    for (const [k, v] of Object.entries({ GOOGLE_CLOUD_PROJECT: saved.project, PUBLIC_BASE_URL: saved.base, PAYMENT_WEBHOOK_REVERIFY: saved.reverify })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
  })

  // ── createCharge ──────────────────────────────────────────────────────────
  it('createCharge: not_connected when no credentials', async () => {
    const { db, queueSelect } = makeDb()
    queueSelect(businessPaymentCredentials, []) // getPaymentCredentials → null
    const res = await createCharge(db, { businessId: 'biz-1', amount: 300, description: 'x', source: 'booking', dedupKey: 'd' }, { growClient: growStub().client })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('not_connected')
  })

  it('createCharge: reuses an existing live link instead of charging twice', async () => {
    const { db, queueSelect, inserts } = makeDb()
    queueSelect(businessPaymentCredentials, [connectedCredsRow()])
    queueSelect(paymentRequests, [{ id: 'old', status: 'created', paymentUrl: 'https://pay.grow/old' }])
    const grow = growStub()
    const res = await createCharge(db, { businessId: 'biz-1', bookingId: 'bk-1', amount: 300, description: 'x', source: 'booking', dedupKey: 'd' }, { growClient: grow.client })
    expect(res.ok).toBe(true)
    if (res.ok) { expect(res.reused).toBe(true); expect(res.paymentUrl).toBe('https://pay.grow/old') }
    expect(grow.calls).not.toContain('createPaymentProcess') // no second Grow process
    expect(inserts).toHaveLength(0)
  })

  it('createCharge: already_paid blocks a re-charge', async () => {
    const { db, queueSelect } = makeDb()
    queueSelect(businessPaymentCredentials, [connectedCredsRow()])
    queueSelect(paymentRequests, [{ id: 'old', status: 'paid', paymentUrl: 'x' }])
    const res = await createCharge(db, { businessId: 'biz-1', bookingId: 'bk-1', amount: 300, description: 'x', source: 'booking', dedupKey: 'd' }, { growClient: growStub().client })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('already_paid')
  })

  it('createCharge: fresh booking → Grow link, ledger row, notifyUrl carries the webhook token; no raw key persisted', async () => {
    const { db, queueSelect, inserts } = makeDb()
    queueSelect(businessPaymentCredentials, [connectedCredsRow()])
    queueSelect(paymentRequests, []) // no existing charge
    const grow = growStub()
    const res = await createCharge(db, { businessId: 'biz-1', bookingId: 'bk-1', customerId: 'c1', amount: 300, description: 'Session', source: 'booking', dedupKey: 'payment.request:bk-1' }, { growClient: grow.client })
    expect(res.ok).toBe(true)
    expect(grow.calls).toContain('createPaymentProcess')
    expect((grow.createArgs[0] as { notifyUrl: string }).notifyUrl).toBe('https://pa.example/payment-webhook/grow/wh-tok-123')
    const led = inserts.find((i) => i.table === paymentRequests)
    expect(led).toBeDefined()
    expect(led!.vals['status']).toBe('created')
    expect(led!.vals['growProcessId']).toBe('PR1')
    for (const v of Object.values(led!.vals)) expect(String(v)).not.toContain(RAW_KEY)
  })

  // ── reconcilePayment truth table ────────────────────────────────────────────
  it('reconcile: missing transaction code is rejected', async () => {
    const { db } = makeDb()
    const res = await reconcilePayment(db, 'wh', { transactionCode: '' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('missing_transaction')
  })

  it('reconcile: unknown webhook token is rejected', async () => {
    const { db, queueSelect } = makeDb()
    queueSelect(businessPaymentCredentials, []) // getCredentialsByWebhookToken → null
    const res = await reconcilePayment(db, 'bad', { transactionCode: 'TX1' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('unknown_token')
  })

  it('reconcile: no matching charge is rejected (no fabrication)', async () => {
    const { db, queueSelect } = makeDb()
    queueSelect(businessPaymentCredentials, [connectedCredsRow()])
    queueSelect(paymentRequests, [])
    const res = await reconcilePayment(db, 'wh-tok-123', { transactionCode: 'TX1', processId: 'PR1' }, { growClient: growStub().client })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('no_matching_charge')
  })

  it('reconcile: duplicate transactionCode is a no-op (idempotent)', async () => {
    const { db, queueSelect, updates } = makeDb()
    queueSelect(businessPaymentCredentials, [connectedCredsRow()])
    queueSelect(paymentRequests, [{ id: 'pr-1', status: 'paid', transactionCode: 'TX1', growProcessId: 'PR1', bookingId: null, source: 'booking' }])
    const res = await reconcilePayment(db, 'wh-tok-123', { transactionCode: 'TX1', processId: 'PR1' }, { growClient: growStub().client })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.outcome).toBe('already_processed')
    expect(updates).toHaveLength(0) // nothing re-written
  })

  it('reconcile: unverifiable signal is rejected and the ledger is NOT marked paid (fail-closed)', async () => {
    const { db, queueSelect, updates } = makeDb()
    queueSelect(businessPaymentCredentials, [connectedCredsRow()])
    queueSelect(paymentRequests, [{ id: 'pr-1', status: 'created', transactionCode: null, growProcessId: 'PR1', bookingId: null, source: 'booking' }])
    const grow = growStub({ getPaymentInfo: async () => ({ ok: false, reason: 'auth_rejected', message: 'nope' }) })
    const res = await reconcilePayment(db, 'wh-tok-123', { transactionCode: 'TX1', processId: 'PR1' }, { growClient: grow.client })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('verify_failed')
    expect(grow.calls).not.toContain('approveTransaction')
    expect(updates.some((u) => u.set['status'] === 'paid')).toBe(false)
  })

  it('reconcile: a sum mismatch is rejected', async () => {
    const { db, queueSelect } = makeDb()
    queueSelect(businessPaymentCredentials, [connectedCredsRow()])
    queueSelect(paymentRequests, [{ id: 'pr-1', status: 'created', transactionCode: null, growProcessId: 'PR1', bookingId: null, source: 'booking' }])
    const grow = growStub({ getPaymentInfo: async () => ({ ok: true, data: { status: 'paid', sum: 999 } }) })
    const res = await reconcilePayment(db, 'wh-tok-123', { transactionCode: 'TX1', processId: 'PR1', paymentSum: 300 }, { growClient: grow.client })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('verify_failed')
  })

  it('reconcile: verified ad-hoc charge → approveTransaction, ledger paid, invoice forwarded', async () => {
    const { db, queueSelect, updates } = makeDb()
    queueSelect(businessPaymentCredentials, [connectedCredsRow()])
    queueSelect(paymentRequests, [{ id: 'pr-1', status: 'created', transactionCode: null, growProcessId: 'PR1', bookingId: null, customerId: 'c1', source: 'owner_command' }])
    queueSelect(identities, [{ phone: '+972500000000' }]) // customerPhoneFor
    queueSelect(businesses, [{ defaultLanguage: 'en' }]) // businessLang
    const grow = growStub()
    const enqueued: { phone: string; body: string }[] = []
    const res = await reconcilePayment(db, 'wh-tok-123',
      { transactionCode: 'TX1', processId: 'PR1', paymentSum: 300, invoiceUrl: 'https://grow/inv.pdf', invoiceNumber: 'INV-9' },
      { growClient: grow.client, enqueue: async (phone, body) => { enqueued.push({ phone, body }) } },
    )
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.outcome).toBe('recorded') // no booking attached
    expect(grow.calls).toEqual(expect.arrayContaining(['getPaymentInfo', 'approveTransaction']))
    expect(updates.some((u) => u.set['status'] === 'paid' && u.set['transactionCode'] === 'TX1')).toBe(true)
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]!.body).toContain('https://grow/inv.pdf')
  })

  it('reconcile: owner is NOT notified by default (payment_received is voluntary OAU)', async () => {
    const { db, queueSelect } = makeDb()
    queueSelect(businessPaymentCredentials, [connectedCredsRow()])
    queueSelect(paymentRequests, [{ id: 'pr-1', status: 'created', transactionCode: null, growProcessId: 'PR1', bookingId: null, customerId: null, amount: '300', description: 'Session', source: 'owner_command' }])
    // notify helper reads the business; no rule + no legacy pref → handle_silently.
    queueSelect(businesses, [{ name: 'Biz', defaultLanguage: 'en', notificationRules: null, notificationPreferences: null }])
    const grow = growStub()
    const enqueued: { phone: string; body: string }[] = []
    const res = await reconcilePayment(db, 'wh-tok-123', { transactionCode: 'TX1', processId: 'PR1' }, { growClient: grow.client, enqueue: async (phone, body) => { enqueued.push({ phone, body }) } })
    expect(res.ok).toBe(true)
    expect(enqueued).toHaveLength(0) // no invoice (none on this webhook) and silent owner notify
  })

  it('reconcile: owner IS notified when a payment_received rule says notify', async () => {
    const { db, queueSelect } = makeDb()
    queueSelect(businessPaymentCredentials, [connectedCredsRow()])
    queueSelect(paymentRequests, [{ id: 'pr-1', status: 'created', transactionCode: null, growProcessId: 'PR1', bookingId: null, customerId: null, amount: '300', description: 'Session', source: 'owner_command' }])
    queueSelect(businesses, [{ name: 'Biz', defaultLanguage: 'en', notificationRules: [{ event: 'payment_received', action: 'notify' }], notificationPreferences: null }])
    queueSelect(identities, [{ id: 'mgr-1', phoneNumber: '+972511111111' }]) // manager lookup
    const grow = growStub()
    const enqueued: { phone: string; body: string }[] = []
    const res = await reconcilePayment(db, 'wh-tok-123', { transactionCode: 'TX1', processId: 'PR1' }, { growClient: grow.client, enqueue: async (phone, body) => { enqueued.push({ phone, body }) } })
    expect(res.ok).toBe(true)
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]!.phone).toBe('+972511111111')
    expect(enqueued[0]!.body).toContain('300')
    expect(enqueued[0]!.body).toContain('🟢')
  })

  // ── refundCharge (owner-commanded) ──────────────────────────────────────────
  it('refund: not_found when the ledger row is missing', async () => {
    const { db, queueSelect } = makeDb()
    queueSelect(paymentRequests, [])
    const res = await refundCharge(db, { businessId: 'biz-1', paymentRequestId: 'pr-x' }, { growClient: growStub().client })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('not_found')
  })

  it('refund: not_refundable for a charge that never settled', async () => {
    const { db, queueSelect } = makeDb()
    queueSelect(paymentRequests, [{ id: 'pr-1', businessId: 'biz-1', status: 'created', transactionCode: null, amount: '300', description: 'Session' }])
    const grow = growStub()
    const res = await refundCharge(db, { businessId: 'biz-1', paymentRequestId: 'pr-1' }, { growClient: grow.client })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('not_refundable')
    expect(grow.calls).not.toContain('refundTransaction')
  })

  it('refund: not_connected when payments are no longer connected', async () => {
    const { db, queueSelect } = makeDb()
    queueSelect(paymentRequests, [{ id: 'pr-1', businessId: 'biz-1', status: 'paid', transactionCode: 'TX1', amount: '300', description: 'Session' }])
    queueSelect(businessPaymentCredentials, []) // getPaymentCredentials → null
    const res = await refundCharge(db, { businessId: 'biz-1', paymentRequestId: 'pr-1' }, { growClient: growStub().client })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('not_connected')
  })

  it('refund: paid charge → Grow refund, ledger flipped to refunded', async () => {
    const { db, queueSelect, updates } = makeDb()
    queueSelect(paymentRequests, [{ id: 'pr-1', businessId: 'biz-1', status: 'paid', transactionCode: 'TX1', amount: '300', description: 'Session' }])
    queueSelect(businessPaymentCredentials, [connectedCredsRow()])
    const grow = growStub()
    const res = await refundCharge(db, { businessId: 'biz-1', paymentRequestId: 'pr-1' }, { growClient: grow.client })
    expect(res.ok).toBe(true)
    if (res.ok) { expect(res.amount).toBe(300); expect(res.description).toBe('Session') }
    expect(grow.calls).toContain('refundTransaction')
    expect(updates.some((u) => u.set['status'] === 'refunded')).toBe(true)
  })

  it('refund: a Grow refund error is explicit and does NOT flip the ledger (fail-closed)', async () => {
    const { db, queueSelect, updates } = makeDb()
    queueSelect(paymentRequests, [{ id: 'pr-1', businessId: 'biz-1', status: 'paid', transactionCode: 'TX1', amount: '300', description: 'Session' }])
    queueSelect(businessPaymentCredentials, [connectedCredsRow()])
    const grow = growStub({ refundTransaction: async () => ({ ok: false, reason: 'invalid_request', message: 'nope' }) })
    const res = await refundCharge(db, { businessId: 'biz-1', paymentRequestId: 'pr-1' }, { growClient: grow.client })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('grow_error')
    expect(updates.some((u) => u.set['status'] === 'refunded')).toBe(false)
  })

  it('reconcile: PAYMENT_WEBHOOK_REVERIFY=off skips the probe but still approves + settles', async () => {
    process.env['PAYMENT_WEBHOOK_REVERIFY'] = 'off'
    const { db, queueSelect, updates } = makeDb()
    queueSelect(businessPaymentCredentials, [connectedCredsRow()])
    queueSelect(paymentRequests, [{ id: 'pr-1', status: 'created', transactionCode: null, growProcessId: 'PR1', bookingId: null, customerId: null, source: 'owner_command' }])
    const grow = growStub()
    const res = await reconcilePayment(db, 'wh-tok-123', { transactionCode: 'TX1', processId: 'PR1' }, { growClient: grow.client })
    expect(res.ok).toBe(true)
    expect(grow.calls).not.toContain('getPaymentInfo')
    expect(grow.calls).toContain('approveTransaction')
    expect(updates.some((u) => u.set['status'] === 'paid')).toBe(true)
  })
})
