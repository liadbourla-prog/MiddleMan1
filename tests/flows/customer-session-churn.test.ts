import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'

// ── Bug 1 regression: read-only customer intents must NOT end the session ──────
// inquiry / system_explanation / list_bookings used to call completeSession AND
// return sessionComplete:true. That spawned a fresh session on the next turn →
// isFirstMessage=true → the PA re-greeted itself every few messages. The fix keeps
// these paths ACTIVE (updateSessionContext(..., 'active')) and returns
// sessionComplete:false; idle sessions still expire via the 30-min customer TTL.
//
// We mock the LLM + session-manager seams so this is a pure control-flow assertion.

const updateSessionContext = vi.fn(async () => {})
const completeSession = vi.fn(async () => {})
const failSession = vi.fn(async () => {})

vi.mock('../../src/domain/session/manager.js', () => ({
  updateSessionContext: (...a: unknown[]) => updateSessionContext(...a),
  completeSession: (...a: unknown[]) => completeSession(...a),
  failSession: (...a: unknown[]) => failSession(...a),
}))

const extractCustomerIntent = vi.fn()
const generateCustomerReply = vi.fn(async () => 'a human reply')

vi.mock('../../src/adapters/llm/client.js', () => ({
  extractCustomerIntent: (...a: unknown[]) => extractCustomerIntent(...a),
  generateCustomerReply: (...a: unknown[]) => generateCustomerReply(...a),
}))

import { handleBookingFlow } from '../../src/domain/flows/customer-booking.js'
import type { ResolvedIdentity } from '../../src/domain/identity/types.js'
import type { ActiveSession } from '../../src/domain/session/types.js'

// Minimal chainable Drizzle stub: every query resolves to an empty array, which is
// enough for the read-only branches (no services, no bookings) under test.
function fakeDb(): unknown {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit']) {
    chain[m] = () => chain
  }
  ;(chain as { then: unknown }).then = (res: (v: unknown[]) => unknown) => Promise.resolve([]).then(res)
  return { select: () => chain }
}

const identity: ResolvedIdentity = {
  id: 'id-1',
  businessId: 'biz-1',
  phoneNumber: '+972500000000',
  role: 'customer',
  displayName: null,
  messagingOptOut: false,
  preferredLanguage: null,
  conversationPausedUntil: null,
}

const session: ActiveSession = {
  id: 'sess-1',
  businessId: 'biz-1',
  identityId: 'id-1',
  intent: 'unknown',
  state: 'active',
  context: {},
  expiresAt: new Date(Date.now() + 3_600_000),
}

function intentResult(intent: string) {
  return {
    ok: true,
    data: {
      intent,
      slotRequest: null,
      serviceTypeHint: null,
      providerHint: null,
      participantsHint: null,
      summary: null,
      rawEntities: {},
      detectedLanguage: 'he',
    },
  }
}

async function runWith(intent: string) {
  return handleBookingFlow(
    fakeDb() as never,
    {} as never, // calendar — unused on read-only paths
    identity,
    session,
    'some message',
    'Asia/Jerusalem',
    'Studiyoga',
    [],
    undefined,
    undefined, // business undefined → skip pause/escalation/availability DB work
    'he',
    undefined,
    true, // isFirstMessage — even on the first turn the session must stay alive
  )
}

describe('read-only intents keep the session active (Bug 1)', () => {
  beforeEach(() => {
    updateSessionContext.mockClear()
    completeSession.mockClear()
    failSession.mockClear()
    generateCustomerReply.mockClear()
  })

  for (const intent of ['inquiry', 'system_explanation', 'list_bookings']) {
    it(`${intent} returns sessionComplete:false and never completes the session`, async () => {
      ;(extractCustomerIntent as Mock).mockResolvedValue(intentResult(intent))

      const result = await runWith(intent)

      expect(result.sessionComplete).toBe(false)
      expect(completeSession).not.toHaveBeenCalled()
      // The session is persisted ACTIVE so the next turn is isFirstMessage=false.
      expect(updateSessionContext).toHaveBeenCalled()
      const lastCall = updateSessionContext.mock.calls.at(-1)!
      expect(lastCall[3]).toBe('active')
    })
  }
})
