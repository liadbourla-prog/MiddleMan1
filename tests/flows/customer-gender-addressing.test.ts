import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Mock } from 'vitest'

// ── T1.1 — Branch 4 gender-correct customer addressing ────────────────────────
// handleBookingFlow resolves the customer's Hebrew addressee gender (stored ▸ name ▸
// self-morphology), persists it on a rank gain, and threads the resolved value into
// every customer reply (generateCustomerReply receives `addresseeGender`). Unknown
// stays masculine (null) — the floor. We mock the LLM + session seams so this is a
// pure wiring assertion: which gender reaches the reply, and what gets persisted.

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
import type { ResolvedIdentity } from '../../src/domain/identity/types.js'
import type { ActiveSession } from '../../src/domain/session/types.js'

// Table-aware Drizzle stub that ALSO records every `update(table).set(values)` call so a
// test can assert what was persisted to `identities` (the addressee-gender write-back).
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

const FULL_INQUIRY_INTENT = {
  intent: 'inquiry',
  slotRequest: null,
  serviceTypeHint: null,
  providerHint: null,
  participantsHint: null,
  summary: null,
  customerNameHint: null,
  avoidConstraints: null,
  specialArrangementRequest: false,
  restorePrevious: false,
  joinWaitlist: false,
  rawEntities: {},
  detectedLanguage: 'he',
  selfGenderEvidence: 'none',
} as const

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

describe('T1.1 — Branch 4 resolves and threads addressee gender', () => {
  it('a known-female NAME addresses feminine and persists source=name (intent-failure path)', async () => {
    ;(extractCustomerIntent as Mock).mockResolvedValue({ ok: false, error: 'parse_error' })
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = []
    await handleBookingFlow(
      fakeDb(SERVICE_ROWS, updates) as never, {} as never,
      makeIdentity({ displayName: 'שירה' }), activeSession,
      'שלום', 'Asia/Jerusalem', 'הסטודיו', [],
      undefined, undefined, 'he', undefined, false,
    )
    expect(generateCustomerReply).toHaveBeenCalled()
    expect(lastReplyGender()).toBe('female')
    const gu = genderUpdates(updates)
    expect(gu.length).toBeGreaterThan(0)
    expect(gu.at(-1)?.values).toMatchObject({ addresseeGender: 'female', addresseeGenderSource: 'name' })
  })

  it('a unisex name with feminine SELF-MORPHOLOGY in the message addresses feminine, persists source=self_morphology', async () => {
    ;(extractCustomerIntent as Mock).mockResolvedValue({ ok: false, error: 'parse_error' })
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = []
    await handleBookingFlow(
      fakeDb(SERVICE_ROWS, updates) as never, {} as never,
      makeIdentity({ displayName: 'גל' }), activeSession,
      'אני מעוניינת לקבוע תור', 'Asia/Jerusalem', 'הסטודיו', [],
      undefined, undefined, 'he', undefined, false,
    )
    expect(lastReplyGender()).toBe('female')
    const gu = genderUpdates(updates)
    expect(gu.at(-1)?.values).toMatchObject({ addresseeGender: 'female', addresseeGenderSource: 'self_morphology' })
  })

  it('an unknown-gender customer stays masculine (null) and persists nothing', async () => {
    ;(extractCustomerIntent as Mock).mockResolvedValue({ ok: false, error: 'parse_error' })
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = []
    await handleBookingFlow(
      fakeDb(SERVICE_ROWS, updates) as never, {} as never,
      makeIdentity({ displayName: null }), activeSession,
      'hello there', 'Asia/Jerusalem', 'הסטודיו', [],
      undefined, undefined, 'he', undefined, false,
    )
    expect(lastReplyGender()).toBeFalsy()
    expect(genderUpdates(updates)).toHaveLength(0)
  })

  it('the LLM selfGenderEvidence signal drives gender on a successful intent (inquiry path)', async () => {
    ;(extractCustomerIntent as Mock).mockResolvedValue({
      ok: true,
      data: { ...FULL_INQUIRY_INTENT, selfGenderEvidence: 'female' },
    })
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = []
    await handleBookingFlow(
      fakeDb(SERVICE_ROWS, updates) as never, {} as never,
      makeIdentity({ displayName: 'גל' }), activeSession,
      'מה השעות שלכם?', 'Asia/Jerusalem', 'הסטודיו', [],
      undefined, undefined, 'he', undefined, false,
    )
    expect(lastReplyGender()).toBe('female')
    const gu = genderUpdates(updates)
    expect(gu.at(-1)?.values).toMatchObject({ addresseeGender: 'female', addresseeGenderSource: 'self_morphology' })
  })

  it('a stored EXPLICIT female is not downgraded by an absent signal and reply stays feminine', async () => {
    ;(extractCustomerIntent as Mock).mockResolvedValue({ ok: false, error: 'parse_error' })
    const updates: Array<{ table: unknown; values: Record<string, unknown> }> = []
    await handleBookingFlow(
      fakeDb(SERVICE_ROWS, updates) as never, {} as never,
      makeIdentity({ displayName: 'דוד', addresseeGender: 'female', addresseeGenderSource: 'explicit' }),
      activeSession,
      'hi', 'Asia/Jerusalem', 'הסטודיו', [],
      undefined, undefined, 'he', undefined, false,
    )
    // Stored explicit (rank 4) beats the masculine name guess (rank 2) → still feminine, no write.
    expect(lastReplyGender()).toBe('female')
    expect(genderUpdates(updates)).toHaveLength(0)
  })
})
