import { describe, it, expect, vi, beforeEach } from 'vitest'

// Proves handleOnboardingMessage forwards the session transcript down to every
// generateOnboardingReply call, so the anti-repetition context actually reaches
// the LLM — across both the onboardingQuestion path and the direct-call path.
const generateOnboardingReply = vi.fn(async () => 'next question')
const parseBusinessName = vi.fn(async () => ({ ok: true, data: { isBusinessName: true, name: 'סטודיוגה' } }))
const parseImportChoice = vi.fn(async () => ({ ok: true, data: { choice: 'skip' } }))
const generateManagerCommandReply = vi.fn(async () => 'summary')

vi.mock('../../src/adapters/llm/client.js', () => ({
  generateOnboardingReply: (...a: unknown[]) => generateOnboardingReply(...a),
  parseBusinessName: (...a: unknown[]) => parseBusinessName(...a),
  parseImportChoice: (...a: unknown[]) => parseImportChoice(...a),
  generateManagerCommandReply: (...a: unknown[]) => generateManagerCommandReply(...a),
  classifyManagerInstruction: vi.fn(),
  parseOnboardingServices: vi.fn(),
  parseOnboardingHours: vi.fn(),
  parseOnboardingAnswer: vi.fn(),
  parseCalendarChoice: vi.fn(),
}))

import { handleOnboardingMessage } from '../../src/domain/flows/manager-onboarding.js'
import type { InboundMessage } from '../../src/adapters/whatsapp/types.js'
import type { ResolvedIdentity } from '../../src/domain/identity/types.js'
import type { Business } from '../../src/db/schema.js'
import type { TranscriptTurn } from '../../src/adapters/llm/types.js'

function fakeDb() {
  const chain: Record<string, unknown> = { then: (r: (v: unknown[]) => void) => r([]) }
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit']) chain[m] = () => chain
  return {
    select: () => chain,
    update: () => ({ set: () => ({ where: async () => {} }) }),
    insert: () => ({ values: () => ({ returning: async () => [{ id: 'x' }] }) }),
  } as unknown as Parameters<typeof handleOnboardingMessage>[0]
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Parameters<typeof handleOnboardingMessage>[5]
const identity = { id: 'i1' } as unknown as ResolvedIdentity
const transcript: TranscriptTurn[] = [{ role: 'assistant', text: 'מה שם העסק?' }, { role: 'customer', text: 'סטודיוגה' }]

const businessAt = (onboardingStep: string): Business =>
  ({ id: 'b1', name: 'סטודיוגה', defaultLanguage: 'he', onboardingStep, whatsappNumber: '+100', available247: false, cancellationCutoffMinutes: 0, confirmationGate: 'immediate', paymentMethod: null, escalationRules: [], calendarMode: 'internal' } as unknown as Business)
const msg = (body: string): InboundMessage =>
  ({ body, fromNumber: '+972500000000', timestamp: new Date() } as unknown as InboundMessage)

// Every generateOnboardingReply call this turn must carry the same transcript ref.
function assertAllCallsCarried(t: TranscriptTurn[]) {
  expect(generateOnboardingReply.mock.calls.length).toBeGreaterThan(0)
  generateOnboardingReply.mock.calls.forEach((c) => {
    expect((c[0] as { transcript?: unknown }).transcript).toBe(t)
  })
}

beforeEach(() => { generateOnboardingReply.mockClear() })

describe('onboarding threads transcript into every generateOnboardingReply call', () => {
  it('via the onboardingQuestion path (business_name → services question)', async () => {
    await handleOnboardingMessage(fakeDb(), msg('סטודיוגה'), identity, businessAt('business_name'), 'https://x', log, 'he', transcript)
    assertAllCallsCarried(transcript)
  })

  it('via a direct generateOnboardingReply call (customer_import skip → verify summary)', async () => {
    await handleOnboardingMessage(fakeDb(), msg('נדלג'), identity, businessAt('customer_import'), 'https://x', log, 'he', transcript)
    assertAllCallsCarried(transcript)
  })

  it('defaults to an empty transcript when the caller omits it (no crash, no leak)', async () => {
    await handleOnboardingMessage(fakeDb(), msg('סטודיוגה'), identity, businessAt('business_name'), 'https://x', log)
    generateOnboardingReply.mock.calls.forEach((c) => {
      const passed = (c[0] as { transcript?: unknown[] }).transcript
      expect(passed === undefined || (Array.isArray(passed) && passed.length === 0)).toBe(true)
    })
  })
})
