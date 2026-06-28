import { describe, it, expect, vi, beforeEach } from 'vitest'

// P3 gating: maybeEscalateSpecial only escalates a GENUINE special-arrangement request
// (LLM flag set) once per session, and only when a business is present. Without the flag
// it returns null so the caller keeps today's clarification behaviour.

const escalateUnfulfillableRequest = vi.fn(async () => ({ customerReply: 'passed to the studio' }))
vi.mock('../../src/domain/escalation/engine.js', () => ({
  escalateUnfulfillableRequest: (...a: unknown[]) => escalateUnfulfillableRequest(...(a as [])),
  // other named exports imported by customer-booking.ts must still exist
  checkOwnerEscalationRules: vi.fn(async () => ({ escalated: false })),
  escalateToPlatform: vi.fn(async () => {}),
}))

const updateSessionContext = vi.fn(async () => {})
vi.mock('../../src/domain/session/manager.js', () => ({
  updateSessionContext: (...a: unknown[]) => updateSessionContext(...(a as [])),
  completeSession: vi.fn(async () => {}),
  failSession: vi.fn(async () => {}),
}))

import { maybeEscalateSpecial } from '../../src/domain/flows/customer-booking.js'
import type { Db } from '../../src/db/client.js'
import type { Business } from '../../src/db/schema.js'
import type { CustomerIntentOutput } from '../../src/adapters/llm/types.js'

const db = {} as unknown as Db
const business = { id: 'biz-1', name: 'Studio', defaultLanguage: 'he' } as unknown as Business
const session = { id: 'sess-1' } as never
const identity = { id: 'id-1', businessId: 'biz-1', phoneNumber: '+972546372400', role: 'customer' } as never
const transcript = [{ role: 'customer' as const, text: 'private session for 5 outside hours' }]

function intent(over: Partial<CustomerIntentOutput> = {}): CustomerIntentOutput {
  return {
    intent: 'booking', slotRequest: null, serviceTypeHint: null, providerHint: null,
    customerNameHint: null, participantsHint: 5, summary: 'private group of 5 out of hours',
    rawEntities: {}, detectedLanguage: 'he', specialArrangementRequest: true, ...over,
  } as CustomerIntentOutput
}

beforeEach(() => { escalateUnfulfillableRequest.mockClear(); updateSessionContext.mockClear() })

describe('maybeEscalateSpecial — gating', () => {
  it('escalates and sets the per-session guard when the flag is set', async () => {
    const res = await maybeEscalateSpecial(db, business, {}, session, identity, intent(), transcript, 'he')
    expect(escalateUnfulfillableRequest).toHaveBeenCalledTimes(1)
    expect(res).toEqual({ reply: 'passed to the studio', sessionComplete: false, escalated: true })
    // guard persisted
    const ctxArg = updateSessionContext.mock.calls[0]![2] as { specialRequestEscalated?: boolean }
    expect(ctxArg.specialRequestEscalated).toBe(true)
  })

  it('does NOT escalate without the flag (ordinary party-size mismatch)', async () => {
    const res = await maybeEscalateSpecial(db, business, {}, session, identity, intent({ specialArrangementRequest: false }), transcript, 'he')
    expect(escalateUnfulfillableRequest).not.toHaveBeenCalled()
    expect(res).toBeNull()
  })

  it('does NOT re-escalate when already escalated this session', async () => {
    const res = await maybeEscalateSpecial(db, business, { specialRequestEscalated: true }, session, identity, intent(), transcript, 'he')
    expect(escalateUnfulfillableRequest).not.toHaveBeenCalled()
    expect(res).toBeNull()
  })

  it('does NOT escalate when there is no business', async () => {
    const res = await maybeEscalateSpecial(db, undefined, {}, session, identity, intent(), transcript, 'he')
    expect(escalateUnfulfillableRequest).not.toHaveBeenCalled()
    expect(res).toBeNull()
  })
})
