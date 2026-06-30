import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'

// T1.7 — manager onboarding (Branch-3 PA setup) threads the owner's resolved addressee gender
// into generateOnboardingReply, so a female owner is addressed feminine. Unknown → masculine floor.
const generateOnboardingReply = vi.fn(async () => 'next question')
const generateManagerCommandReply = vi.fn(async () => 'summary')
const parseBusinessName = vi.fn(async () => ({ ok: true, data: { isBusinessName: true, name: 'הסטודיו' } }))

vi.mock('../../src/adapters/llm/client.js', () => ({
  generateOnboardingReply: (...a: unknown[]) => generateOnboardingReply(...a),
  generateManagerCommandReply: (...a: unknown[]) => generateManagerCommandReply(...a),
  parseBusinessName: (...a: unknown[]) => parseBusinessName(...a),
  classifyManagerInstruction: vi.fn(),
  parseOnboardingAnswer: vi.fn(),
  parseOnboardingServices: vi.fn(),
  parseOnboardingHours: vi.fn(),
  parseCalendarChoice: vi.fn(),
  parseImportChoice: vi.fn(),
  detectOnboardingAmendment: vi.fn(async () => ({ ok: true, data: { isAmendment: false, field: 'none' } })),
}))

import { handleOnboardingMessage } from '../../src/domain/flows/manager-onboarding.js'
import type { InboundMessage } from '../../src/adapters/whatsapp/types.js'
import type { ResolvedIdentity } from '../../src/domain/identity/types.js'
import type { Business } from '../../src/db/schema.js'

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

function identity(over: Partial<ResolvedIdentity>): ResolvedIdentity {
  return {
    id: 'i1', businessId: 'b1', phoneNumber: '+972500000000', role: 'manager',
    displayName: 'Owner', messagingOptOut: false, preferredLanguage: null, conversationPausedUntil: null,
    ...over,
  }
}

// business_name step: a fresh business has no name, so no amend triage — straight to the handler,
// which (on a valid parsed name) asks the next question via generateOnboardingReply.
const business = { id: 'b1', name: null, defaultLanguage: 'he', onboardingStep: 'business_name' } as unknown as Business
const msg = (body: string): InboundMessage => ({ body, fromNumber: '+972500000000', timestamp: new Date() } as unknown as InboundMessage)

function lastGender(): unknown {
  const c = (generateOnboardingReply as Mock).mock.calls.at(-1)
  return (c?.[0] as { addresseeGender?: unknown } | undefined)?.addresseeGender
}

beforeEach(() => {
  generateOnboardingReply.mockClear()
  generateManagerCommandReply.mockClear()
})

describe('manager onboarding threads owner addressee gender', () => {
  it('a stored-female owner reaches generateOnboardingReply with addresseeGender=female', async () => {
    await handleOnboardingMessage(
      fakeDb(), msg('הסטודיו'),
      identity({ addresseeGender: 'female', addresseeGenderSource: 'explicit' }),
      business, 'https://x', log, 'he', [],
    )
    expect(generateOnboardingReply).toHaveBeenCalled()
    expect(lastGender()).toBe('female')
  })

  it('a female-morphology message resolves feminine even without a stored value', async () => {
    await handleOnboardingMessage(
      fakeDb(), msg('אני מעוניינת, קוראים לעסק הסטודיו'),
      identity({}), business, 'https://x', log, 'he', [],
    )
    expect(lastGender()).toBe('female')
  })

  it('an unknown owner stays masculine floor (no gender threaded)', async () => {
    await handleOnboardingMessage(
      fakeDb(), msg('Studio One'),
      identity({}), business, 'https://x', log, 'he', [],
    )
    expect(lastGender()).toBeFalsy()
  })
})
