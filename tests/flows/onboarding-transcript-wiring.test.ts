import { describe, it, expect, vi, beforeEach } from 'vitest'

// Proves handleOnboardingMessage forwards the session transcript down to
// generateOnboardingReply, so the anti-repetition context actually reaches the LLM.
const generateOnboardingReply = vi.fn(async () => 'next question')
const parseBusinessName = vi.fn(async () => ({ ok: true, data: { isBusinessName: true, name: 'סטודיוגה' } }))

vi.mock('../../src/adapters/llm/client.js', () => ({
  generateOnboardingReply: (...a: unknown[]) => generateOnboardingReply(...a),
  parseBusinessName: (...a: unknown[]) => parseBusinessName(...a),
  classifyManagerInstruction: vi.fn(),
  generateManagerCommandReply: vi.fn(),
  parseOnboardingServices: vi.fn(),
  parseOnboardingHours: vi.fn(),
  parseOnboardingAnswer: vi.fn(),
  parseCalendarChoice: vi.fn(),
  parseImportChoice: vi.fn(),
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
const business = { id: 'b1', name: 'סטודיוגה', defaultLanguage: 'he', onboardingStep: 'business_name' } as unknown as Business
const identity = { id: 'i1' } as unknown as ResolvedIdentity
const msg = { body: 'סטודיוגה', fromNumber: '+972500000000', timestamp: new Date() } as unknown as InboundMessage

beforeEach(() => { generateOnboardingReply.mockClear() })

it('forwards the transcript into generateOnboardingReply', async () => {
  const transcript: TranscriptTurn[] = [{ role: 'assistant', text: 'מה שם העסק?' }, { role: 'customer', text: 'סטודיוגה' }]
  await handleOnboardingMessage(fakeDb(), msg, identity, business, 'https://x', log, 'he', transcript)
  expect(generateOnboardingReply).toHaveBeenCalled()
  const passed = generateOnboardingReply.mock.calls.every((c) => (c[0] as { transcript?: unknown }).transcript === transcript)
  expect(passed).toBe(true)
})
