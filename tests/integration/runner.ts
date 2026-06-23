// Integration tests capture replies synchronously via AsyncLocalStorage (replyCapture.run),
// so the debounce timer must be off — coalescing is unit-tested separately.
process.env['MESSAGE_COALESCING'] = 'off'

import crypto from 'crypto'
import type { FastifyInstance } from 'fastify'
import { eq, and, desc } from 'drizzle-orm'
import { db } from '../../src/db/client.js'
import { conversationSessions, bookings, identities, providerOnboardingSessions } from '../../src/db/schema.js'
import { replyCapture } from '../../src/adapters/whatsapp/sender.js'
import { processInboundMessage } from '../../src/routes/webhook.js'
import type { InboundMessage } from '../../src/adapters/whatsapp/types.js'

export interface SimContext {
  fromNumber: string
  toNumber: string
  businessId: string
}

export interface SimResponse {
  replies: string[]
  sessionState: string | null
  sessionContext: Record<string, unknown>
  bookingState: string | null
  bookingId: string | null
}

// ── Mock Fastify app ──────────────────────────────────────────────────────────

export interface MockApp {
  instance: FastifyInstance
  warns: string[]
  errors: string[]
  infos: string[]
  reset(): void
}

export function createMockApp(): MockApp {
  const warns: string[] = []
  const errors: string[] = []
  const infos: string[] = []

  const instance = {
    log: {
      info: (_obj: unknown, msg?: string) => infos.push(msg ?? String(_obj)),
      debug: () => {},
      warn: (_obj: unknown, msg?: string) => warns.push(msg ?? JSON.stringify(_obj)),
      error: (_obj: unknown, msg?: string) => errors.push(msg ?? JSON.stringify(_obj)),
    },
  } as unknown as FastifyInstance

  return {
    instance,
    warns,
    errors,
    infos,
    reset() {
      warns.length = 0
      errors.length = 0
      infos.length = 0
    },
  }
}

// Singleton mock app used by sim(); replace per-test with createMockApp() when you need log spying
let _mockApp = createMockApp()
export function getMockApp(): MockApp { return _mockApp }
export function replaceMockApp(app: MockApp): void { _mockApp = app }
export function resetMockApp(): void { _mockApp = createMockApp() }

// ── Core simulate function ────────────────────────────────────────────────────

export async function sim(ctx: SimContext, body: string, appOverride?: MockApp): Promise<SimResponse> {
  const app = appOverride ?? _mockApp

  const msg: InboundMessage = {
    messageId: `sim-${crypto.randomUUID()}`,
    fromNumber: ctx.fromNumber,
    toNumber: ctx.toNumber,
    body,
    timestamp: new Date(),
    rawPayload: null,
  }

  const captured: string[] = []
  await replyCapture.run(captured, () => processInboundMessage(msg, app.instance))

  const [identity] = await db
    .select({ id: identities.id })
    .from(identities)
    .where(and(eq(identities.businessId, ctx.businessId), eq(identities.phoneNumber, ctx.fromNumber)))
    .limit(1)

  let sessionState: string | null = null
  let sessionContext: Record<string, unknown> = {}
  let bookingState: string | null = null
  let bookingId: string | null = null

  if (identity) {
    const [session] = await db
      .select({ state: conversationSessions.state, context: conversationSessions.context })
      .from(conversationSessions)
      .where(eq(conversationSessions.identityId, identity.id))
      .orderBy(desc(conversationSessions.createdAt))
      .limit(1)

    if (session) {
      sessionState = session.state
      sessionContext = (session.context as Record<string, unknown>) ?? {}
    }

    const [booking] = await db
      .select({ id: bookings.id, state: bookings.state })
      .from(bookings)
      .where(and(eq(bookings.businessId, ctx.businessId), eq(bookings.customerId, identity.id)))
      .orderBy(desc(bookings.updatedAt))
      .limit(1)

    if (booking) {
      bookingState = booking.state
      bookingId = booking.id
    }
  }

  return { replies: captured, sessionState, sessionContext, bookingState, bookingId }
}

// ── Language leak detector ────────────────────────────────────────────────────

// Unicode ranges for Hebrew characters (main block + presentational forms)
const HEBREW_RE = /[א-תװ-״יִ-פֿ]/g
const LATIN_RE = /[a-zA-Z]/g

export function hasLanguageLeak(reply: string, expectedLang: 'he' | 'en'): boolean {
  const heCount = (reply.match(HEBREW_RE) ?? []).length
  const latCount = (reply.match(LATIN_RE) ?? []).length
  const total = heCount + latCount
  if (total === 0) return false

  if (expectedLang === 'he') {
    // Flag if reply has no Hebrew at all but has substantial Latin
    if (heCount === 0 && latCount > 10) return true
    // Flag if Latin exceeds 65% of alphabetic chars (excessive English in Hebrew reply)
    if (heCount > 0 && latCount / total > 0.65) return true
    return false
  }

  // English reply: flag if Hebrew exceeds 30% of alphabetic chars
  return heCount / total > 0.30
}

export function assertNoLanguageLeak(reply: string, expectedLang: 'he' | 'en'): void {
  if (hasLanguageLeak(reply, expectedLang)) {
    throw new Error(
      `Language leak in ${expectedLang} session.\nReply: "${reply.slice(0, 150)}"`,
    )
  }
}

// Check all replies in a SimResponse for language leaks
export function assertAllRepliesInLanguage(res: SimResponse, lang: 'he' | 'en'): void {
  for (const reply of res.replies) {
    assertNoLanguageLeak(reply, lang)
  }
}

// ── Provider / MiddleMan simulate function ────────────────────────────────────

export interface SimProviderResponse {
  replies: string[]
  sessionStep: string | null
  sessionData: Record<string, unknown> | null
  sessionCompleted: boolean
}

export async function simProvider(fromNumber: string, body: string, appOverride?: MockApp): Promise<SimProviderResponse> {
  const app = appOverride ?? _mockApp
  const providerNumber = process.env['PROVIDER_WA_NUMBER'] ?? ''

  const msg: InboundMessage = {
    messageId: `sim-${crypto.randomUUID()}`,
    fromNumber,
    toNumber: providerNumber,
    body,
    timestamp: new Date(),
    rawPayload: null,
  }

  const captured: string[] = []
  await replyCapture.run(captured, () => processInboundMessage(msg, app.instance))

  const [session] = await db
    .select()
    .from(providerOnboardingSessions)
    .where(eq(providerOnboardingSessions.managerPhone, fromNumber))
    .limit(1)

  return {
    replies: captured,
    sessionStep: session?.step ?? null,
    sessionData: (session?.collectedData as Record<string, unknown> | null) ?? null,
    sessionCompleted: !!session?.completedAt,
  }
}
