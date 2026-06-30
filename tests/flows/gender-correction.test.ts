import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'

// ── T2.3 — Adversarial precedence, owner-override, and mid-session-flip goldens ──
// Builds on tests/flows/customer-gender-addressing.test.ts (T1.1 wiring). These cases stress
// the *precedence resolver* through the live Branch-4 path:
//   (a) a name that says male is OVERRIDDEN by the customer's own feminine Hebrew (self_morphology
//       rank 3 > name rank 2) — flips to female, persists source=self_morphology, reply is feminine.
//   (b) an owner's explicit setCustomerGender (rank 4) STICKS against a later name/morphology signal.
//   (c) a mid-session flip (unknown → female across two turns) is handled warmly — and the addressing
//       instruction reaching the model is split-gender-clean for BOTH the masculine floor and the
//       feminine form (the female path is never split-gender; the lawbook §3.5 bar).
// generateCustomerReply is mocked: the assertion is which gender reaches the reply and what persists.

const updateSessionContext = vi.fn(async () => {})
const completeSession = vi.fn(async () => {})
const failSession = vi.fn(async () => {})

vi.mock('../../src/domain/session/manager.js', () => ({
  updateSessionContext: (...a: unknown[]) => updateSessionContext(...(a as [])),
  completeSession: (...a: unknown[]) => completeSession(...(a as [])),
  failSession: (...a: unknown[]) => failSession(...(a as [])),
}))

const extractCustomerIntent = vi.fn()
const generateCustomerReply = vi.fn(async () => 'a human reply')

vi.mock('../../src/adapters/llm/client.js', () => ({
  extractCustomerIntent: (...a: unknown[]) => extractCustomerIntent(...(a as [])),
  generateCustomerReply: (...a: unknown[]) => generateCustomerReply(...(a as [])),
}))

import { handleBookingFlow } from '../../src/domain/flows/customer-booking.js'
import { serviceTypes, identities } from '../../src/db/schema.js'
import { buildVoiceCore, type VoiceChannel } from '../../src/adapters/llm/voice.js'
import { hasSplitGender } from '../../src/domain/flows/voice-guard.js'
import type { ResolvedIdentity } from '../../src/domain/identity/types.js'
import type { ActiveSession } from '../../src/domain/session/types.js'

// Table-aware Drizzle stub that records every `update(table).set(values)` so a test can assert
// what was persisted to `identities` (the addressee-gender write-back).
function fakeDb(
  rowsByTable: Map<unknown, unknown[]>,
  updates: Array<{ table: unknown; values: Record<string, unknown> }>,
): unknown {
  function makeChain() {
    let table: unknown
    const chain: Record<string, unknown> = {}
    for (const m of ['from', 'where', 'orderBy', 'limit', 'innerJoin', 'leftJoin']) {
      chain[m] = (arg: unknown) => {
        if (m === 'from') table = arg
        return chain
      }
    }
    ;(chain as { then: unknown }).then = (res: (v: unknown[]) => unknown) =>
      Promise.resolve(rowsByTable.get(table) ?? []).then(res)
    return chain
  }
  return {
    select: () => makeChain(),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => {
        updates.push({ table, values })
        return { where: () => Promise.resolve() }
      },
    }),
  }
}

function makeIdentity(over: Partial<ResolvedIdentity>): ResolvedIdentity {
  return {
    id: 'cust-1',
    businessId: 'biz-1',
    phoneNumber: '+972500000000',
    role: 'customer',
    displayName: null,
    messagingOptOut: false,
    preferredLanguage: null,
    conversationPausedUntil: null,
    ...over,
  }
}

const activeSession: ActiveSession = {
  id: 'sess-1', businessId: 'biz-1', identityId: 'cust-1',
  intent: 'unknown', state: 'active', context: {},
  expiresAt: new Date(Date.now() + 3_600_000),
}

const SERVICE_ROWS = new Map<unknown, unknown[]>([
  [serviceTypes, [{ id: 'svc-1', name: 'אימון', durationMinutes: 60, maxParticipants: 1, category: null }]],
])

beforeEach(() => {
  updateSessionContext.mockClear()
  completeSession.mockClear()
  ;(extractCustomerIntent as Mock).mockReset()
  generateCustomerReply.mockClear()
})

function lastReplyGender(): unknown {
  const call = (generateCustomerReply as Mock).mock.calls.at(-1)
  return (call?.[0] as { addresseeGender?: unknown } | undefined)?.addresseeGender
}

function genderUpdates(updates: Array<{ table: unknown; values: Record<string, unknown> }>) {
  return updates.filter((u) => u.table === identities && 'addresseeGender' in u.values)
}

// Drive one Branch-4 turn against a given identity (mutated in place across turns) + message.
async function runTurn(
  identity: ResolvedIdentity,
  message: string,
  updates: Array<{ table: unknown; values: Record<string, unknown> }>,
): Promise<void> {
  ;(extractCustomerIntent as Mock).mockResolvedValue({ ok: false, error: 'parse_error' })
  await handleBookingFlow(
    fakeDb(SERVICE_ROWS, updates) as never, {} as never,
    identity, activeSession,
    message, 'Asia/Jerusalem', 'הסטודיו', [],
    undefined, undefined, 'he', undefined, false,
  )
}

describe('T2.3(a) — self-morphology overrides a contradicting name guess', () => {
  it('a male NAME contradicted by feminine self-Hebrew flips to female and persists source=self_morphology', async () => {
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = []
    // דוד resolves male by name (rank 2); "אני מעוניינת" is feminine self-morphology (rank 3) → wins.
    await runTurn(makeIdentity({ displayName: 'דוד' }), 'אני מעוניינת לקבוע תור', updates)
    expect(lastReplyGender()).toBe('female')
    const gu = genderUpdates(updates)
    expect(gu.at(-1)?.values).toMatchObject({ addresseeGender: 'female', addresseeGenderSource: 'self_morphology' })
  })
})

describe('T2.3(b) — owner explicit override sticks against later signals', () => {
  it('a stored explicit MALE is not flipped by later feminine self-morphology, and nothing is written', async () => {
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = []
    // Owner pinned male (rank 4). Customer later writes feminine Hebrew (rank 3) → explicit still wins.
    await runTurn(
      makeIdentity({ displayName: 'גל', addresseeGender: 'male', addresseeGenderSource: 'explicit' }),
      'אני מעוניינת לקבוע',
      updates,
    )
    expect(lastReplyGender()).toBe('male')
    expect(genderUpdates(updates)).toHaveLength(0)
  })

  it('a stored explicit FEMALE is not flipped by a contradicting male name guess', async () => {
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = []
    await runTurn(
      makeIdentity({ displayName: 'דוד', addresseeGender: 'female', addresseeGenderSource: 'explicit' }),
      'שלום',
      updates,
    )
    expect(lastReplyGender()).toBe('female')
    expect(genderUpdates(updates)).toHaveLength(0)
  })
})

describe('T2.3(c) — mid-session flip handled warmly, never split-gender', () => {
  it('unknown on turn 1 (masculine floor) flips to female on turn 2 when feminine Hebrew appears, and persists', async () => {
    const identity = makeIdentity({ displayName: 'גל' }) // unisex → no name signal
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = []

    // Turn 1: neutral English message, no morphology → unknown → masculine floor (null), no write.
    await runTurn(identity, 'hi there', updates)
    expect(lastReplyGender()).toBeFalsy()
    expect(genderUpdates(updates)).toHaveLength(0)

    // Turn 2 (same session, same identity object): feminine self-morphology appears → flips female.
    await runTurn(identity, 'אני צריכה תור בבקשה', updates)
    expect(lastReplyGender()).toBe('female')
    expect(genderUpdates(updates).at(-1)?.values).toMatchObject({
      addresseeGender: 'female',
      addresseeGenderSource: 'self_morphology',
    })
  })

  it('the addressing instruction is split-gender-clean for BOTH the masculine floor and the feminine form', () => {
    // §3.5: the female path picks the SINGLE feminine form — it is held to the same anti-split-gender
    // bar as the masculine floor, so no reply built from either ever carries a live split-gender slash.
    const CHANNELS: readonly VoiceChannel[] = ['customer', 'manager', 'operator', 'onboarding', 'proactive']
    for (const ch of CHANNELS) {
      for (const g of [null, 'male', 'female'] as const) {
        // Strip QUOTED negative examples (…not "תרצה/תרצי"…) so only the live directive is checked.
        const liveCopy = buildVoiceCore(ch, g).replace(/"[^"]*"/g, '')
        expect(hasSplitGender(liveCopy), `${ch}/${g}`).toBe(false)
      }
    }
  })
})
