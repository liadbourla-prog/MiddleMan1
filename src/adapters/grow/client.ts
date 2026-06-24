// Grow (formerly Meshulam) Light API adapter — the ONLY code that talks to Grow.
// See docs/superpowers/specs/2026-06-24-grow-payments-integration-design.md §2, §5.1, §8.
//
// Hard constraints from the design (shape this file):
//   • Per-merchant static credentials: userId + pageCode + apiKey. No OAuth.
//   • Server-side only; requests are multipart/form-data, NOT JSON.
//   • Sandbox vs prod is a host switch.
//   • No documented webhook signature — verification lives in the webhook route (Phase 2),
//     not here.
//
// This file holds NO business logic and NEVER throws into the engine: every method returns a
// typed GrowResult. Transient drops (network / 5xx) are retried with backoff — the same idiom
// as oauth.ts `exchangeCodeForTokens` — while auth/4xx failures bail immediately.
//
// Phase 1 exercises only `getApiInfo` (the live-validation probe used at credential connect).
// `createPaymentProcess` / `approveTransaction` / `getPaymentInfo` / `refundTransaction` are
// part of the skeleton — wired by Phase 2 — and share the same request machinery.

import type {
  GrowCredentials,
  GrowResult,
  GrowFailureReason,
  CreatePaymentProcessParams,
  CreatedPaymentProcess,
  PaymentInfo,
  ApiInfo,
} from './types.js'

const HOSTS = {
  sandbox: 'https://sandbox.meshulam.co.il',
  production: 'https://api.meshulam.co.il',
} as const

// Meshulam Light API operation base path. The exact per-operation suffix for the validation
// probe is an open question with Grow support (design §11.4); the request machinery (auth
// fields, multipart, envelope parsing) is the load-bearing part and is confirmed.
const LIGHT_API_BASE = '/api/light/server/1.0'

const MAX_ATTEMPTS = 3

export interface GrowClientOptions extends GrowCredentials {
  // Injected for tests (and to swap transports). Defaults to global fetch.
  fetchImpl?: typeof fetch
  // Overrides the host (tests point this at a mock). Defaults to the env-based host.
  baseUrlOverride?: string
}

export interface GrowClient {
  /** Zero-effect probe used to live-validate credentials at connect time. */
  getApiInfo(): Promise<GrowResult<ApiInfo>>
  /** Create a hosted pay-link (Phase 2). */
  createPaymentProcess(params: CreatePaymentProcessParams): Promise<GrowResult<CreatedPaymentProcess>>
  /** Mandatory ack of a settled transaction back to Grow (Phase 2). */
  approveTransaction(transactionId: string): Promise<GrowResult<{ approved: true }>>
  /** Re-verify a transaction/process server-side before trusting a webhook (Phase 2). */
  getPaymentInfo(processId: string): Promise<GrowResult<PaymentInfo>>
  /** Owner-commanded refund (Phase 5). */
  refundTransaction(transactionId: string, sum?: number): Promise<GrowResult<{ refunded: true }>>
}

export function createGrowClient(options: GrowClientOptions): GrowClient {
  const fetchImpl = options.fetchImpl ?? fetch
  const baseUrl = (options.baseUrlOverride ?? HOSTS[options.environment]).replace(/\/+$/, '')

  // Every Grow Light API call carries the merchant's static credentials in the form body.
  function authFields(): Record<string, string> {
    return {
      userId: options.userId,
      pageCode: options.pageCode,
      apiKey: options.apiKey,
    }
  }

  async function request<T>(
    operation: string,
    fields: Record<string, string | number | undefined>,
    map: (data: Record<string, unknown>) => T | null,
  ): Promise<GrowResult<T>> {
    const url = `${baseUrl}${LIGHT_API_BASE}/${operation}`
    const form = new FormData()
    for (const [k, v] of Object.entries({ ...authFields(), ...fields })) {
      if (v !== undefined && v !== null) form.append(k, String(v))
    }

    let lastErr: { reason: GrowFailureReason; message: string; raw?: unknown } | undefined
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetchImpl(url, { method: 'POST', body: form })

        // 5xx → transient; retry. 4xx → our problem; do not retry.
        if (res.status >= 500) {
          lastErr = { reason: 'transient', message: `Grow HTTP ${res.status}` }
        } else if (res.status === 401 || res.status === 403) {
          return { ok: false, reason: 'auth_rejected', message: `Grow HTTP ${res.status}` }
        } else if (res.status >= 400) {
          return { ok: false, reason: 'invalid_request', message: `Grow HTTP ${res.status}` }
        } else {
          const raw = (await res.json().catch(() => null)) as GrowEnvelope | null
          return parseEnvelope(raw, map)
        }
      } catch (err) {
        // Network-level drop (the ERR_STREAM_PREMATURE_CLOSE class oauth.ts guards against).
        lastErr = { reason: 'transient', message: err instanceof Error ? err.message : String(err) }
      }
      if (attempt < MAX_ATTEMPTS) await delay(300 * attempt)
    }
    return { ok: false, reason: lastErr?.reason ?? 'transient', message: lastErr?.message ?? 'Grow unreachable' }
  }

  return {
    async getApiInfo() {
      return request('getApiInfo', {}, () => ({ authenticated: true }) as ApiInfo)
    },

    async createPaymentProcess(params) {
      return request(
        'createPaymentProcess',
        {
          sum: params.sum,
          description: params.description,
          'pageField[fullName]': params.fullName,
          'pageField[phone]': params.phone,
          'pageField[email]': params.email,
          successUrl: params.successUrl,
          cancelUrl: params.cancelUrl,
          notifyUrl: params.notifyUrl,
        },
        (data) => {
          const paymentUrl = strField(data, 'url') ?? strField(data, 'paymentUrl')
          const processId = strField(data, 'processId') ?? strField(data, 'processToken')
          if (!paymentUrl || !processId) return null
          return { paymentUrl, processId }
        },
      )
    },

    async approveTransaction(transactionId) {
      return request('approveTransaction', { transactionId }, () => ({ approved: true }) as const)
    },

    async getPaymentInfo(processId) {
      return request('getPaymentProcessInfo', { processId }, (data) => ({
        status: strField(data, 'status') ?? 'unknown',
        transactionId: strField(data, 'transactionId') ?? strField(data, 'transactionCode'),
        sum: numField(data, 'sum'),
        invoiceNumber: strField(data, 'invoiceNumber'),
        invoiceUrl: strField(data, 'invoiceUrl'),
      }))
    },

    async refundTransaction(transactionId, sum) {
      return request('refundTransaction', { transactionId, sum }, () => ({ refunded: true }) as const)
    },
  }
}

// ── Envelope parsing ──────────────────────────────────────────────────────────
// Grow Light API wraps every response: { status: 1, data: {...} } on success,
// { status: 0, err: {...} } on failure. `status` arrives as number or string across
// operations, so normalise both.

interface GrowEnvelope {
  status?: number | string
  data?: Record<string, unknown>
  err?: { message?: string } | string
}

function parseEnvelope<T>(
  raw: GrowEnvelope | null,
  map: (data: Record<string, unknown>) => T | null,
): GrowResult<T> {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, reason: 'unexpected_response', message: 'Empty or non-JSON Grow response', raw }
  }
  const ok = raw.status === 1 || raw.status === '1'
  if (!ok) {
    const msg = typeof raw.err === 'string' ? raw.err : (raw.err?.message ?? 'Grow returned a failure status')
    // A failure envelope on an authenticated probe means the credentials were rejected.
    return { ok: false, reason: 'auth_rejected', message: msg, raw }
  }
  const mapped = map(raw.data ?? {})
  if (mapped === null) {
    return { ok: false, reason: 'unexpected_response', message: 'Grow success envelope missing expected fields', raw }
  }
  return { ok: true, data: mapped }
}

function strField(data: Record<string, unknown>, key: string): string | undefined {
  const v = data[key]
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined
}

function numField(data: Record<string, unknown>, key: string): number | undefined {
  const v = data[key]
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v)
  return undefined
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
