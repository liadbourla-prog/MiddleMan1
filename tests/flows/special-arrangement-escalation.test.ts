import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

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

  // Symptom 3: an inquiry-shaped special request ("can I get a private version of
  // your group class?") carries the flag but no concrete date/time, so it never reaches
  // the post-slot branches. The escalator itself is intent-agnostic — it must still fire.
  it('escalates an inquiry-shaped special request (no concrete slot)', async () => {
    const res = await maybeEscalateSpecial(
      db, business, {}, session, identity,
      intent({ intent: 'inquiry', slotRequest: null, summary: 'private one-off version of the group class' }),
      transcript, 'he',
    )
    expect(escalateUnfulfillableRequest).toHaveBeenCalledTimes(1)
    expect(res).toEqual({ reply: 'passed to the studio', sessionComplete: false, escalated: true })
  })

  it('is a once-per-session no-op for an inquiry-shaped request already escalated', async () => {
    const res = await maybeEscalateSpecial(
      db, business, { specialRequestEscalated: true }, session, identity,
      intent({ intent: 'inquiry', slotRequest: null }),
      transcript, 'he',
    )
    expect(escalateUnfulfillableRequest).not.toHaveBeenCalled()
    expect(res).toBeNull()
  })
})

// Regression guard: the escalation hook must remain wired on the inquiry-shaped paths
// (inquiry / unknown switch branches + the waiting_clarification handler). These paths
// have no DB harness, so we assert the source still contains the early
// `specialArrangementRequest === true` → maybeEscalateSpecial(...) check at each site.
// If a refactor drops one, Symptom 3 (inquiry-shaped dead-end) silently regresses.
describe('inquiry-path escalation wiring (source guard)', () => {
  const srcPath = fileURLToPath(new URL('../../src/domain/flows/customer-booking.ts', import.meta.url))
  const src = readFileSync(srcPath, 'utf8')

  // Count of guarded early-escalation checks (the inline gate followed by the call).
  const guardedCalls = src.match(/specialArrangementRequest === true[\s\S]{0,200}?maybeEscalateSpecial/g) ?? []

  it('has the early specialArrangementRequest → maybeEscalateSpecial check on the inquiry-shaped paths', () => {
    // Three new sites: case 'inquiry', default (unknown), and handleClarification.
    expect(guardedCalls.length).toBeGreaterThanOrEqual(3)
  })

  it("guards the inquiry case branch", () => {
    const inquiryBlock = src.slice(src.indexOf("case 'inquiry'"), src.indexOf("case 'system_explanation'"))
    expect(inquiryBlock).toContain('intent.specialArrangementRequest === true')
    expect(inquiryBlock).toContain('maybeEscalateSpecial')
  })

  it('guards the default (unknown) branch', () => {
    const defaultStart = src.indexOf('default: {', src.indexOf("case 'system_explanation'"))
    const defaultBlock = src.slice(defaultStart, defaultStart + 1500)
    expect(defaultBlock).toContain('intent.specialArrangementRequest === true')
    expect(defaultBlock).toContain('maybeEscalateSpecial')
  })

  it('guards the handleClarification path', () => {
    const clarStart = src.indexOf('async function handleClarification')
    // Bound by the next top-level function so the window can't miss a later-placed check.
    const clarEnd = src.indexOf('\nfunction ', clarStart)
    const clarBlock = src.slice(clarStart, clarEnd > clarStart ? clarEnd : clarStart + 4000)
    expect(clarBlock).toContain('specialArrangementRequest === true')
    expect(clarBlock).toContain('maybeEscalateSpecial')
  })
})
