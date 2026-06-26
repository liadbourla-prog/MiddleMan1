import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'

// Flow-level wiring for negotiation memory (Phase 2): the categorical-avoid extraction
// and the batch-rejection promotion are control-flow over the session context. We mock
// the LLM + session-manager seams (as in customer-session-churn.test.ts) and assert what
// gets persisted. The deterministic filtering/matching itself is unit-tested in
// src/domain/flows/negotiation-constraints.test.ts.

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
import type { BookingFlowContext } from '../../src/domain/flows/types.js'

function fakeDb(): unknown {
  const chain: Record<string, unknown> = {}
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit']) chain[m] = () => chain
  ;(chain as { then: unknown }).then = (res: (v: unknown[]) => unknown) => Promise.resolve([]).then(res)
  return { select: () => chain }
}

const identity: ResolvedIdentity = {
  id: 'id-1', businessId: 'biz-1', phoneNumber: '+972500000000', role: 'customer',
  displayName: null, messagingOptOut: false, preferredLanguage: null, conversationPausedUntil: null,
}

// A future ISO instant (year 2099) so entry-pruning never drops the fixtures.
const slot = (h: number) => ({ start: `2099-03-04T${String(h).padStart(2, '0')}:00:00.000Z`, end: `2099-03-04T${String(h + 1).padStart(2, '0')}:00:00.000Z`, serviceTypeId: 'svc-1' })

function sessionWith(context: BookingFlowContext): ActiveSession {
  return {
    id: 'sess-1', businessId: 'biz-1', identityId: 'id-1', intent: 'unknown',
    state: 'active', context, expiresAt: new Date(Date.now() + 3_600_000),
  }
}

function intentData(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    data: {
      intent: 'system_explanation', // a path that persists updatedCtx('active'), business-free
      slotRequest: null, serviceTypeHint: null, providerHint: null, customerNameHint: null,
      participantsHint: null, summary: null, rawEntities: {}, detectedLanguage: 'he',
      avoidConstraints: null,
      ...over,
    },
  }
}

// The context handed to the LAST updateSessionContext call.
function persistedCtx(): BookingFlowContext {
  return updateSessionContext.mock.calls.at(-1)![2] as BookingFlowContext
}

async function run(context: BookingFlowContext, intentOver: Record<string, unknown> = {}) {
  ;(extractCustomerIntent as Mock).mockResolvedValue(intentData(intentOver))
  return handleBookingFlow(
    fakeDb() as never, {} as never, identity, sessionWith(context), 'some message',
    'Asia/Jerusalem', 'Studiyoga', [], undefined, undefined, 'he', undefined, false,
  )
}

beforeEach(() => {
  updateSessionContext.mockClear()
  completeSession.mockClear()
  failSession.mockClear()
  generateCustomerReply.mockClear()
})

describe('batch rejection — lastOfferedSlots promoted to rejectedSlots at turn start', () => {
  it('promotes the previously-offered slots and clears lastOfferedSlots', async () => {
    await run({ lastOfferedSlots: [slot(10), slot(12)] })
    const ctx = persistedCtx()
    expect(ctx.negotiationConstraints?.rejectedSlots).toEqual([slot(10), slot(12)])
    expect(ctx.lastOfferedSlots).toBeUndefined()
  })

  it('merges promoted slots with already-rejected ones (deduped)', async () => {
    await run({
      lastOfferedSlots: [slot(12), slot(14)],
      negotiationConstraints: { rejectedSlots: [slot(12)] },
    })
    expect(persistedCtx().negotiationConstraints?.rejectedSlots).toEqual([slot(12), slot(14)])
  })

  it('is a no-op when there were no offered slots', async () => {
    await run({})
    expect(persistedCtx().negotiationConstraints).toBeUndefined()
  })
})

describe('categorical avoid — extracted exclusions fold into constraints', () => {
  it('"no mornings" → avoid.beforeHour persisted', async () => {
    await run({}, { avoidConstraints: { beforeHour: 12, afterHour: null, weekdays: null } })
    expect(persistedCtx().negotiationConstraints?.avoid).toEqual({ beforeHour: 12 })
  })

  it('unions weekday exclusions with any existing avoid', async () => {
    await run(
      { negotiationConstraints: { avoid: { weekdays: [4] } } },
      { avoidConstraints: { beforeHour: null, afterHour: 18, weekdays: [2] } },
    )
    expect(persistedCtx().negotiationConstraints?.avoid).toEqual({ afterHour: 18, weekdays: [2, 4] })
  })

  it('null avoidConstraints leaves constraints untouched', async () => {
    await run({}, { avoidConstraints: null })
    expect(persistedCtx().negotiationConstraints).toBeUndefined()
  })
})
