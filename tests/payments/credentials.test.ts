import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Db } from '../../src/db/client.js'
import { businessPaymentCredentials, auditLog } from '../../src/db/schema.js'
import {
  connectPaymentCredentials,
  getValidConnectToken,
} from '../../src/domain/payments/credentials.js'
import { __resetMemorySecretStore } from '../../src/adapters/secrets.js'
import type { GrowClient } from '../../src/adapters/grow/client.js'

// ── Fake DB ──────────────────────────────────────────────────────────────────
// Captures inserts and serves canned selects, enough to exercise the credential module
// without a real Postgres (mirrors how the domain test suite fakes db access).
interface InsertRec { table: unknown; vals: Record<string, unknown>; conflict?: unknown }
function makeFakeDb(selectResults: unknown[][]) {
  const inserts: InsertRec[] = []
  const queue = [...selectResults]
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => queue.shift() ?? [],
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (vals: Record<string, unknown>) => {
        const rec: InsertRec = { table, vals }
        inserts.push(rec)
        return {
          onConflictDoUpdate: async (conflict: unknown) => { rec.conflict = conflict },
          then: (resolve: (v: undefined) => unknown) => resolve(undefined),
        }
      },
    }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  }
  return { db: db as unknown as Db, inserts }
}

function growClientStub(probeOk: boolean, reason: 'auth_rejected' | 'transient' = 'auth_rejected'): GrowClient {
  return {
    getApiInfo: async () =>
      probeOk
        ? { ok: true, data: { authenticated: true } }
        : { ok: false, reason, message: 'nope' },
    createPaymentProcess: async () => ({ ok: false, reason: 'invalid_request', message: 'n/a' }),
    approveTransaction: async () => ({ ok: false, reason: 'invalid_request', message: 'n/a' }),
    getPaymentInfo: async () => ({ ok: false, reason: 'invalid_request', message: 'n/a' }),
    refundTransaction: async () => ({ ok: false, reason: 'invalid_request', message: 'n/a' }),
  }
}

const RAW_API_KEY = 'grow-raw-secret-key-XYZ'
const input = { businessId: 'biz-1', userId: 'U1', pageCode: 'P1', apiKey: RAW_API_KEY, environment: 'sandbox' as const }

describe('connectPaymentCredentials', () => {
  const savedProject = process.env['GOOGLE_CLOUD_PROJECT']
  beforeEach(() => {
    delete process.env['GOOGLE_CLOUD_PROJECT']
    process.env['PAYMENTS_SECRET_BACKEND'] = 'memory'
    __resetMemorySecretStore()
  })
  afterEach(() => {
    if (savedProject === undefined) delete process.env['GOOGLE_CLOUD_PROJECT']
    else process.env['GOOGLE_CLOUD_PROJECT'] = savedProject
  })

  it('rejects (and stores nothing) when Grow fails to validate', async () => {
    const { db, inserts } = makeFakeDb([[]]) // no existing creds
    const res = await connectPaymentCredentials(db, input, { growClient: growClientStub(false) })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('validation_failed')
    expect(inserts).toHaveLength(0) // fail-closed: no secret, no row, no audit
  })

  it('reports transient (not validation_failed) when Grow is unreachable', async () => {
    const { db } = makeFakeDb([[]])
    const res = await connectPaymentCredentials(db, input, { growClient: growClientStub(false, 'transient') })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('transient')
  })

  it('on success stores only a secret REF — never the raw apiKey — and writes a payment.connected audit', async () => {
    const { db, inserts } = makeFakeDb([[]]) // no existing creds → fresh webhook token
    const res = await connectPaymentCredentials(db, input, { growClient: growClientStub(true) })
    expect(res.ok).toBe(true)

    const credRow = inserts.find((i) => i.table === businessPaymentCredentials)
    expect(credRow).toBeDefined()
    // The stored ref is a Secret Manager / memory reference, NOT the raw key.
    expect(credRow!.vals['apiKeyRef']).toMatch(/^memory:\/\//)
    expect(credRow!.vals['status']).toBe('connected')
    expect(credRow!.vals['webhookToken']).toBeTruthy()
    // The raw apiKey must appear in NO column of the persisted row (design §10).
    for (const v of Object.values(credRow!.vals)) {
      expect(String(v)).not.toContain(RAW_API_KEY)
    }

    // payment.connected audit, with no secret material in metadata.
    const auditRow = inserts.find((i) => i.table === auditLog)
    expect(auditRow).toBeDefined()
    expect(auditRow!.vals['action']).toBe('payment.connected')
    expect(JSON.stringify(auditRow!.vals['metadata'] ?? {})).not.toContain(RAW_API_KEY)
  })
})

describe('payment connect token validation', () => {
  it('not_found when the token does not exist', async () => {
    const { db } = makeFakeDb([[]])
    const res = await getValidConnectToken(db, 'tok')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('not_found')
  })

  it('used when the token was already consumed (single-use)', async () => {
    const row = { token: 'tok', businessId: 'biz-1', managerPhone: '+972', expiresAt: new Date(Date.now() + 60_000), usedAt: new Date() }
    const { db } = makeFakeDb([[row]])
    const res = await getValidConnectToken(db, 'tok')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('used')
  })

  it('expired when past its 30-minute window', async () => {
    const row = { token: 'tok', businessId: 'biz-1', managerPhone: '+972', expiresAt: new Date(Date.now() - 1000), usedAt: null }
    const { db } = makeFakeDb([[row]])
    const res = await getValidConnectToken(db, 'tok')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('expired')
  })

  it('ok for a fresh, unused token', async () => {
    const row = { token: 'tok', businessId: 'biz-1', managerPhone: '+972', expiresAt: new Date(Date.now() + 60_000), usedAt: null }
    const { db } = makeFakeDb([[row]])
    const res = await getValidConnectToken(db, 'tok')
    expect(res.ok).toBe(true)
  })
})
