// Typed surface for the Grow (formerly Meshulam) Light API adapter.
// See docs/superpowers/specs/2026-06-24-grow-payments-integration-design.md §2, §5.1.
//
// The adapter NEVER throws into the engine — every operation returns one of these typed
// results. `reason` is a short machine code the domain layer can branch on; `raw` carries
// the unparsed Grow envelope for logging/debugging (never surfaced to chat).

export type GrowEnvironment = 'sandbox' | 'production'

export interface GrowCredentials {
  userId: string
  pageCode: string
  apiKey: string
  environment: GrowEnvironment
}

export type GrowResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: GrowFailureReason; message: string; raw?: unknown }

// Distinguishes "your credentials are wrong" (no retry; surface to owner) from "Grow is
// momentarily unreachable" (retried by the adapter, then reported as transient).
export type GrowFailureReason =
  | 'auth_rejected' // Grow rejected userId/pageCode/apiKey
  | 'invalid_request' // 4xx other than auth — our request was malformed
  | 'transient' // network drop / 5xx, exhausted retries
  | 'unexpected_response' // 2xx but envelope we couldn't parse

export interface CreatePaymentProcessParams {
  sum: number
  description: string
  // Explicit `| undefined` so callers may pass optional customer fields straight through
  // under exactOptionalPropertyTypes; the adapter drops undefined when building the form.
  fullName?: string | undefined
  phone?: string | undefined
  email?: string | undefined
  successUrl?: string | undefined
  cancelUrl?: string | undefined
  notifyUrl?: string | undefined
}

export interface CreatedPaymentProcess {
  paymentUrl: string
  processId: string
}

export interface PaymentInfo {
  status: string
  // Explicit `| undefined` so the adapter's optional-field mapping satisfies
  // exactOptionalPropertyTypes (the fields may genuinely be absent in a Grow response).
  transactionId?: string | undefined
  sum?: number | undefined
  invoiceNumber?: string | undefined
  invoiceUrl?: string | undefined
}

export interface ApiInfo {
  // Grow's getApiInfo returns merchant metadata; we only need "the call authenticated".
  authenticated: true
}
