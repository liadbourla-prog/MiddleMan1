import { describe, it, expect } from 'vitest'
import { createGrowClient } from '../../../src/adapters/grow/client.js'

// A fetch stub that records every call and returns canned responses in sequence.
function stubFetch(responses: Array<{ status?: number; body?: unknown; throwErr?: string }>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  let i = 0
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const r = responses[Math.min(i, responses.length - 1)]
    i++
    if (r?.throwErr) throw new Error(r.throwErr)
    return {
      status: r?.status ?? 200,
      json: async () => r?.body ?? null,
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

const creds = { userId: 'U1', pageCode: 'P1', apiKey: 'secret-key', environment: 'sandbox' as const }

describe('Grow adapter — getApiInfo (live-validation probe)', () => {
  it('returns ok on a success envelope (status: 1)', async () => {
    const { fetchImpl, calls } = stubFetch([{ body: { status: 1, data: {} } }])
    const client = createGrowClient({ ...creds, fetchImpl })
    const res = await client.getApiInfo()
    expect(res.ok).toBe(true)
    expect(calls).toHaveLength(1)
  })

  it('maps a failure envelope (status: 0) to auth_rejected without retrying', async () => {
    const { fetchImpl, calls } = stubFetch([{ body: { status: 0, err: { message: 'bad key' } } }])
    const client = createGrowClient({ ...creds, fetchImpl })
    const res = await client.getApiInfo()
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('auth_rejected')
    expect(calls).toHaveLength(1) // auth failures are terminal, not retried
  })

  it('maps a 401 to auth_rejected without retrying', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 401 }])
    const client = createGrowClient({ ...creds, fetchImpl })
    const res = await client.getApiInfo()
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('auth_rejected')
    expect(calls).toHaveLength(1)
  })
})

describe('Grow adapter — transient retry', () => {
  it('retries 5xx up to 3 attempts then reports transient', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 503 }, { status: 503 }, { status: 503 }])
    const client = createGrowClient({ ...creds, fetchImpl })
    const res = await client.getApiInfo()
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('transient')
    expect(calls).toHaveLength(3)
  })

  it('retries a network throw, then succeeds on a later attempt', async () => {
    const { fetchImpl, calls } = stubFetch([{ throwErr: 'ECONNRESET' }, { body: { status: 1, data: {} } }])
    const client = createGrowClient({ ...creds, fetchImpl })
    const res = await client.getApiInfo()
    expect(res.ok).toBe(true)
    expect(calls).toHaveLength(2)
  })
})

describe('Grow adapter — request encoding & host switch', () => {
  it('encodes a multipart/form-data body carrying the auth fields', async () => {
    const { fetchImpl, calls } = stubFetch([{ body: { status: 1, data: {} } }])
    const client = createGrowClient({ ...creds, fetchImpl })
    await client.getApiInfo()
    const body = calls[0]!.init.body
    expect(body).toBeInstanceOf(FormData)
    const form = body as unknown as FormData
    expect(form.get('userId')).toBe('U1')
    expect(form.get('pageCode')).toBe('P1')
    expect(form.get('apiKey')).toBe('secret-key')
  })

  it('switches host between sandbox and production', async () => {
    const sandbox = stubFetch([{ body: { status: 1, data: {} } }])
    await createGrowClient({ ...creds, environment: 'sandbox', fetchImpl: sandbox.fetchImpl }).getApiInfo()
    expect(sandbox.calls[0]!.url).toContain('sandbox.meshulam.co.il')

    const prod = stubFetch([{ body: { status: 1, data: {} } }])
    await createGrowClient({ ...creds, environment: 'production', fetchImpl: prod.fetchImpl }).getApiInfo()
    expect(prod.calls[0]!.url).toContain('api.meshulam.co.il')
  })

  it('honours a baseUrlOverride (mock host)', async () => {
    const { fetchImpl, calls } = stubFetch([{ body: { status: 1, data: {} } }])
    await createGrowClient({ ...creds, baseUrlOverride: 'http://localhost:9999', fetchImpl }).getApiInfo()
    expect(calls[0]!.url).toBe('http://localhost:9999/api/light/server/1.0/getApiInfo')
  })
})

describe('Grow adapter — createPaymentProcess mapping (Phase 2 surface)', () => {
  it('maps url + processId from a success envelope', async () => {
    const { fetchImpl } = stubFetch([
      { body: { status: 1, data: { url: 'https://pay.grow/abc', processId: 'PR123' } } },
    ])
    const client = createGrowClient({ ...creds, fetchImpl })
    const res = await client.createPaymentProcess({ sum: 300, description: 'Session' })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data.paymentUrl).toBe('https://pay.grow/abc')
      expect(res.data.processId).toBe('PR123')
    }
  })

  it('reports unexpected_response when expected fields are missing', async () => {
    const { fetchImpl } = stubFetch([{ body: { status: 1, data: {} } }])
    const client = createGrowClient({ ...creds, fetchImpl })
    const res = await client.createPaymentProcess({ sum: 300, description: 'Session' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('unexpected_response')
  })
})
