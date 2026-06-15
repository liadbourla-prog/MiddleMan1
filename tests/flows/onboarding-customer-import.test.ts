import { describe, it, expect, vi, beforeEach } from 'vitest'

// Branch-3 onboarding regression: the customer_import step must ADVANCE on any
// natural "skip/move-on/no list" phrasing and must NOT advance on a question
// (unclear). The old isNegative() keyword gate looped on "נדלג"/"בוא נמשיך"/
// "אין רשימה". We mock the LLM client + a fake DB and assert control flow.

const parseImportChoice = vi.fn()
const generateOnboardingReply = vi.fn(async () => 'a human onboarding line')
const generateManagerCommandReply = vi.fn(async () => 'a summary')

vi.mock('../../src/adapters/llm/client.js', () => ({
  parseImportChoice: (...a: unknown[]) => parseImportChoice(...a),
  generateOnboardingReply: (...a: unknown[]) => generateOnboardingReply(...a),
  generateManagerCommandReply: (...a: unknown[]) => generateManagerCommandReply(...a),
  // Unused on this path but imported by the module under test:
  classifyManagerInstruction: vi.fn(),
  parseBusinessName: vi.fn(),
  parseOnboardingServices: vi.fn(),
  parseOnboardingHours: vi.fn(),
  parseOnboardingAnswer: vi.fn(),
  parseCalendarChoice: vi.fn(),
}))

import { handleOnboardingMessage } from '../../src/domain/flows/manager-onboarding.js'
import type { InboundMessage } from '../../src/adapters/whatsapp/types.js'
import type { ResolvedIdentity } from '../../src/domain/identity/types.js'
import type { Business } from '../../src/db/schema.js'

// Records every .set() payload so we can assert whether the step advanced.
// The select chain is a thenable that resolves to [] so `await db.select()...`
// (used by buildVerifySummary on the skip path) yields an empty array.
function makeFakeDb(updates: Record<string, unknown>[]) {
  const selectChain: Record<string, unknown> = {
    then: (resolve: (v: unknown[]) => void) => resolve([]),
  }
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit']) {
    selectChain[m] = () => selectChain
  }
  return {
    select: () => selectChain,
    update: () => ({
      set: (payload: Record<string, unknown>) => ({
        where: async () => { updates.push(payload) },
      }),
    }),
    insert: () => ({
      values: () => ({ returning: async () => [{ token: 'TKN123' }] }),
    }),
  } as unknown as Parameters<typeof handleOnboardingMessage>[0]
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Parameters<typeof handleOnboardingMessage>[5]

const business = {
  id: 'biz-1', name: 'סטודיוגה', defaultLanguage: 'he', onboardingStep: 'customer_import',
  whatsappNumber: '+100', available247: false, cancellationCutoffMinutes: 0,
  confirmationGate: 'immediate', paymentMethod: null, escalationRules: [], calendarMode: 'internal',
} as unknown as Business
const identity = { id: 'id-1' } as unknown as ResolvedIdentity
const msg = (body: string): InboundMessage =>
  ({ body, fromNumber: '+972500000000', timestamp: new Date() } as unknown as InboundMessage)

beforeEach(() => { parseImportChoice.mockReset(); generateOnboardingReply.mockClear(); generateManagerCommandReply.mockClear() })

describe('customer_import gate — no more loop', () => {
  it('advances to verify when the manager skips ("נדלג"-style)', async () => {
    parseImportChoice.mockResolvedValue({ ok: true, data: { choice: 'skip' } })
    const updates: Record<string, unknown>[] = []
    await handleOnboardingMessage(makeFakeDb(updates), msg('נדלג'), identity, business, 'https://x', log)
    expect(updates.some((u) => u['onboardingStep'] === 'verify')).toBe(true)
  })

  it('does NOT advance when the reply is a question (unclear) — explains instead', async () => {
    parseImportChoice.mockResolvedValue({ ok: true, data: { choice: 'unclear' } })
    const updates: Record<string, unknown>[] = []
    await handleOnboardingMessage(makeFakeDb(updates), msg('באיזה פורמט?'), identity, business, 'https://x', log)
    expect(updates.some((u) => u['onboardingStep'] === 'verify')).toBe(false)
  })

  it('returns an upload link when the manager wants to import', async () => {
    parseImportChoice.mockResolvedValue({ ok: true, data: { choice: 'import' } })
    const updates: Record<string, unknown>[] = []
    const res = await handleOnboardingMessage(makeFakeDb(updates), msg('יש לי קובץ אקסל'), identity, business, 'https://x', log)
    expect(res.reply).toContain('https://x/import/TKN123')
  })

  // Loop-safety: if the intent parser fails (LLM down, after its internal
  // retries), the step must re-ask — never silently advance and never trap.
  it('does NOT advance when the parser fails — falls back to a re-ask, not a skip', async () => {
    parseImportChoice.mockResolvedValue({ ok: false, error: 'quota_exceeded' })
    const updates: Record<string, unknown>[] = []
    await handleOnboardingMessage(makeFakeDb(updates), msg('יש לי קובץ אקסל'), identity, business, 'https://x', log)
    expect(updates.some((u) => u['onboardingStep'] === 'verify')).toBe(false)
  })
})
