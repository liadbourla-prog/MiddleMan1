// Payments credential lifecycle — load / validate / store per-business Grow credentials.
// See docs/superpowers/specs/2026-06-24-grow-payments-integration-design.md §4, §5.3, §8.
//
// Deterministic core: the only place that decides whether a business's payments are live.
// The raw apiKey is handed to the Grow adapter for a live probe and to the secret store for
// safekeeping — it is NEVER written to a DB row, a log line, or a chat transcript.

import { and, eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import type { Db } from '../../db/client.js'
import { businessPaymentCredentials, paymentConnectTokens } from '../../db/schema.js'
import { putSecret, getSecret } from '../../adapters/secrets.js'
import { createGrowClient, type GrowClient } from '../../adapters/grow/client.js'
import type { GrowCredentials, GrowEnvironment } from '../../adapters/grow/types.js'
import { logAudit } from '../audit/logger.js'

const CONNECT_TOKEN_TTL_MS = 30 * 60 * 1000 // 30 minutes, like import_tokens

export interface ConnectTokenRecord {
  token: string
  businessId: string
  managerPhone: string
  expiresAt: Date
  usedAt: Date | null
}

/**
 * Mint a one-time signed token for the credential-capture web form. Mirrors how the CSV
 * import flow issues import_tokens. The caller builds the URL as `${baseUrl}/payment-connect/${token}`.
 */
export async function createPaymentConnectToken(
  db: Db,
  businessId: string,
  managerPhone: string,
): Promise<string> {
  const expiresAt = new Date(Date.now() + CONNECT_TOKEN_TTL_MS)
  const [row] = await db
    .insert(paymentConnectTokens)
    .values({ businessId, managerPhone, expiresAt })
    .returning({ token: paymentConnectTokens.token })
  return row!.token
}

export function buildPaymentConnectUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/payment-connect/${token}`
}

export type ConnectTokenStatus =
  | { ok: true; record: ConnectTokenRecord }
  | { ok: false; reason: 'not_found' | 'used' | 'expired' }

/** Validate a connect token without consuming it (GET form load + pre-submit check). */
export async function getValidConnectToken(db: Db, token: string): Promise<ConnectTokenStatus> {
  const [record] = await db
    .select()
    .from(paymentConnectTokens)
    .where(eq(paymentConnectTokens.token, token))
    .limit(1)
  if (!record) return { ok: false, reason: 'not_found' }
  if (record.usedAt) return { ok: false, reason: 'used' }
  if (record.expiresAt < new Date()) return { ok: false, reason: 'expired' }
  return { ok: true, record }
}

/** Mark a connect token consumed (single-use). Call only after a successful connect. */
export async function consumeConnectToken(db: Db, token: string): Promise<void> {
  await db
    .update(paymentConnectTokens)
    .set({ usedAt: new Date() })
    .where(eq(paymentConnectTokens.token, token))
}

export interface ConnectCredentialsInput {
  businessId: string
  userId: string
  pageCode: string
  apiKey: string
  environment?: GrowEnvironment
}

export type ConnectCredentialsResult =
  | { ok: true; webhookToken: string }
  | { ok: false; reason: 'validation_failed' | 'transient' | 'storage_failed'; message: string }

/**
 * Live-validate credentials against Grow, then store them. Order matters (design §4.1 step 4):
 * we never accept credentials we couldn't authenticate. On success the apiKey goes to the
 * secret store (only its ref is persisted), a stable per-business webhook token/secret is
 * minted (preserved across re-connects so the notifyUrl never changes), the row is upserted
 * to `connected`, and a `payment.connected` audit row is written (L1 grounding).
 */
export async function connectPaymentCredentials(
  db: Db,
  input: ConnectCredentialsInput,
  // Test seam: inject a Grow client. Production always builds the real adapter.
  deps?: { growClient?: GrowClient },
): Promise<ConnectCredentialsResult> {
  const environment: GrowEnvironment = input.environment ?? 'production'

  // 1. Live probe — fail-closed: a non-validating credential is rejected, never stored.
  const grow = deps?.growClient ?? createGrowClient({
    userId: input.userId,
    pageCode: input.pageCode,
    apiKey: input.apiKey,
    environment,
  })
  const probe = await grow.getApiInfo()
  if (!probe.ok) {
    if (probe.reason === 'transient') {
      return { ok: false, reason: 'transient', message: 'Could not reach Grow to validate — try again in a moment.' }
    }
    return { ok: false, reason: 'validation_failed', message: 'Grow rejected these credentials. Double-check the userId, pageCode and API key.' }
  }

  // 2. Stash the apiKey out of band; keep only the ref. Never log the key.
  let apiKeyRef: string
  try {
    apiKeyRef = await putSecret(`payments-grow-apikey-${input.businessId}`, input.apiKey)
  } catch (err) {
    return { ok: false, reason: 'storage_failed', message: err instanceof Error ? err.message : String(err) }
  }

  // 3. Preserve an existing webhook token/secret on re-connect so Grow's notifyUrl stays valid.
  const [existing] = await db
    .select({ webhookToken: businessPaymentCredentials.webhookToken, webhookSecret: businessPaymentCredentials.webhookSecret })
    .from(businessPaymentCredentials)
    .where(and(eq(businessPaymentCredentials.businessId, input.businessId), eq(businessPaymentCredentials.provider, 'grow')))
    .limit(1)
  const webhookToken = existing?.webhookToken ?? randomUUID()
  const webhookSecret = existing?.webhookSecret ?? randomUUID()

  const now = new Date()
  // 4. Upsert on (businessId, provider). Connecting again replaces creds in place.
  await db
    .insert(businessPaymentCredentials)
    .values({
      businessId: input.businessId,
      provider: 'grow',
      userId: input.userId,
      pageCode: input.pageCode,
      apiKeyRef,
      environment,
      webhookToken,
      webhookSecret,
      status: 'connected',
      connectedAt: now,
      lastValidatedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [businessPaymentCredentials.businessId, businessPaymentCredentials.provider],
      set: {
        userId: input.userId,
        pageCode: input.pageCode,
        apiKeyRef,
        environment,
        status: 'connected',
        connectedAt: now,
        lastValidatedAt: now,
        updatedAt: now,
      },
    })

  // 5. L1 grounding — record the real connect (metadata carries NO secret material).
  await logAudit(db, {
    businessId: input.businessId,
    actorId: null,
    action: 'payment.connected',
    entityType: 'business',
    entityId: input.businessId,
    metadata: { provider: 'grow', environment },
  }).catch(() => { /* best-effort, mirrors oauth.ts calendar.connected */ })

  return { ok: true, webhookToken }
}

/**
 * Resolve a business + its decrypted Grow credentials from the unguessable webhook path
 * token. Used by the payment webhook route to identify which business a Grow notify belongs
 * to (and to re-verify / approve the transaction). Returns null for an unknown token.
 */
export async function getCredentialsByWebhookToken(
  db: Db,
  webhookToken: string,
): Promise<(GrowCredentials & { businessId: string; webhookToken: string; webhookSecret: string }) | null> {
  const [row] = await db
    .select()
    .from(businessPaymentCredentials)
    .where(eq(businessPaymentCredentials.webhookToken, webhookToken))
    .limit(1)
  if (!row || row.status !== 'connected') return null
  const apiKey = await getSecret(row.apiKeyRef)
  return {
    businessId: row.businessId,
    userId: row.userId,
    pageCode: row.pageCode,
    apiKey,
    environment: row.environment,
    webhookToken: row.webhookToken,
    webhookSecret: row.webhookSecret,
  }
}

/** True iff this business has a connected Grow account. */
export async function isPaymentsConnected(db: Db, businessId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: businessPaymentCredentials.status })
    .from(businessPaymentCredentials)
    .where(and(eq(businessPaymentCredentials.businessId, businessId), eq(businessPaymentCredentials.provider, 'grow')))
    .limit(1)
  return row?.status === 'connected'
}

/**
 * Load decrypted Grow credentials for a connected business (apiKey fetched from the secret
 * store). Returns null when payments are not connected. Consumed by Phase 2 (charge/webhook).
 */
export async function getPaymentCredentials(
  db: Db,
  businessId: string,
): Promise<(GrowCredentials & { webhookToken: string; webhookSecret: string }) | null> {
  const [row] = await db
    .select()
    .from(businessPaymentCredentials)
    .where(and(eq(businessPaymentCredentials.businessId, businessId), eq(businessPaymentCredentials.provider, 'grow')))
    .limit(1)
  if (!row || row.status !== 'connected') return null
  const apiKey = await getSecret(row.apiKeyRef)
  return {
    userId: row.userId,
    pageCode: row.pageCode,
    apiKey,
    environment: row.environment,
    webhookToken: row.webhookToken,
    webhookSecret: row.webhookSecret,
  }
}
