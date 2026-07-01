/**
 * T1.2 (tightened) — the tightened certainty gate inside reconcileOwnerEvent.
 *
 * Auto-open (class_materialized) now requires ALL of:
 *   1. a certainty signal (existing series on weekday, OR a structured marker), AND
 *   2. duration match (template path): ev duration === service.durationMinutes, AND
 *   3. NO negative/closed marker in title/description (BOTH template & marker paths), AND
 *   4. NO phantom-occupancy prose in the description (N/M count or "booked"/HE equivalents).
 * Short of ALL of these → occupy-and-ASK (type='block' pending marker, weak_pending_confirm).
 *
 * Headline repros (plan §T1.2 tightened, orchestrator "Tightened template"):
 *  (1) "Private Pilates" / "פילאטיס פרטי" on a Pilates weekday, duration match → occupy-and-ask (decision-#10 leak)
 *  (2) "Pilates" duration ≠ class duration on a Pilates weekday → occupy-and-ask
 *  (3) "regular class, 2/8 booked" on a Pilates weekday, duration match, no negative marker → occupy-and-ask (phantom veto)
 *  (4) marker "class: Pilates; capacity: 8" with "private" in the description → occupy-and-ask (negative veto over marker)
 *  (5) REGRESSION: clean "Pilates", duration == class duration, on a Pilates weekday → class_materialized (G1 happy path)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getTableName } from 'drizzle-orm'

const h = vi.hoisted(() => ({
  services: [] as Array<Record<string, unknown>>,
  existingBlockLookup: [] as Array<Array<Record<string, unknown>>>,
  existingClassBlocks: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
  enqueued: [] as Array<{ to: string; body: string }>,
}))

vi.mock('../../db/client.js', () => {
  function tableName(t: unknown): string { try { return getTableName(t as never) } catch { return 'unknown' } }
  function makeSelectChain() {
    const state = { table: 'unknown' }
    const chain: Record<string, unknown> = {}
    chain['from'] = (t: unknown) => { state.table = tableName(t); return chain }
    for (const m of ['where', 'leftJoin', 'innerJoin', 'orderBy']) chain[m] = () => chain
    chain['limit'] = async () => {
      if (state.table === 'calendar_blocks') return h.existingBlockLookup.shift() ?? []
      return []
    }
    chain['then'] = (resolve: (v: unknown) => unknown) => {
      if (state.table === 'service_types') return resolve(h.services)
      if (state.table === 'calendar_blocks') return resolve(h.existingClassBlocks)
      return resolve([])
    }
    return chain
  }
  function makeInsert(t: unknown) {
    return {
      values: (vals: Record<string, unknown>) => {
        h.inserts.push({ table: tableName(t), values: vals })
        const row = { id: 'new-block-id', ...vals }
        const p = Promise.resolve([row])
        return { returning: async () => [row], then: p.then.bind(p) }
      },
    }
  }
  return {
    db: {
      select: () => makeSelectChain(),
      insert: (t: unknown) => makeInsert(t),
      update: (t: unknown) => { void t; return { set: () => ({ where: async () => undefined }) } },
      delete: () => ({ where: async () => undefined }),
    },
  }
})

vi.mock('../audit/logger.js', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('../../workers/message-retry.js', () => ({
  enqueueMessage: vi.fn(async (_biz: string, to: string, body: string) => { h.enqueued.push({ to, body }) }),
}))
vi.mock('../initiations/booking-notify.js', () => ({
  notifyBusinessBookingChange: vi.fn(async () => undefined),
  notifyOwnerBookingChange: vi.fn(async () => undefined),
}))

import { reconcileOwnerEvent, type SyncContext } from './inbound-sync.js'
import { INBOUND_DECISION_LOG_TYPE } from './inbound-telemetry.js'

// Pilates: 60-minute class of capacity 8.
const PILATES = { id: 'svc-pilates', name: 'Pilates', schedulingMode: 'class', maxParticipants: 8, durationMinutes: 60, isActive: true }
// Hebrew alias service so "פילאטיס פרטי" matches.
const PILATES_HE = { id: 'svc-pilates-he', name: 'פילאטיס', schedulingMode: 'class', maxParticipants: 8, durationMinutes: 60, isActive: true }

function ctx(): SyncContext {
  return {
    business: { id: 'biz-1', timezone: 'UTC', defaultLanguage: 'en' } as never,
    calendarId: 'cal-1',
    refreshToken: 'rt',
    managerPhone: '+972500000001',
    lang: 'en',
  }
}

function ownerEvent(over: Partial<Record<string, unknown>> = {}): never {
  return {
    eventId: 'g-new',
    status: 'confirmed',
    summary: 'Pilates',
    description: null,
    start: new Date('2026-07-05T19:00:00Z'), // Sunday 19:00
    end: new Date('2026-07-05T20:00:00Z'), // 60 min
    etag: 'etag-new',
    paManaged: false,
    paType: null,
    paId: null,
    ...over,
  } as never
}

let lines: Array<Record<string, unknown>>
let spy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.clearAllMocks()
  h.services = [PILATES, PILATES_HE]
  h.existingBlockLookup = [[]] // no existing block for the new event → insert path
  // Sunday already runs Pilates at 09:00 → template certainty present for every case below.
  h.existingClassBlocks = [{ startTs: new Date('2026-07-05T09:00:00Z'), googleEventId: null }]
  h.inserts = []
  h.enqueued = []
  lines = []
  spy = vi.spyOn(console, 'log').mockImplementation((arg: unknown) => {
    try { const p = JSON.parse(String(arg)); if (p?.logType === INBOUND_DECISION_LOG_TYPE) lines.push(p) } catch { /* not ours */ }
  })
})
afterEach(() => { spy.mockRestore() })

function lastDecision() { return lines[lines.length - 1]! }
function insertedBlock() { return h.inserts.find((i) => i.table === 'calendar_blocks')! }

describe('(1) negative marker vetoes the template path → occupy-and-ask (decision-#10 leak)', () => {
  it('"Private Pilates" with matching duration on a Pilates weekday is NOT auto-opened', async () => {
    await reconcileOwnerEvent(ctx(), ownerEvent({ summary: 'Private Pilates' }), 'push')
    expect(insertedBlock().values['type']).toBe('block')
    expect(lastDecision()['decision']).toBe('weak_pending_confirm')
    expect(h.enqueued).toHaveLength(1) // owner relayed to confirm
  })

  it('"פילאטיס פרטי" (Hebrew private) is NOT auto-opened', async () => {
    await reconcileOwnerEvent(ctx(), ownerEvent({ summary: 'פילאטיס פרטי' }), 'push')
    expect(insertedBlock().values['type']).toBe('block')
    expect(lastDecision()['decision']).toBe('weak_pending_confirm')
  })
})

describe('(2) duration mismatch vetoes the template path → occupy-and-ask', () => {
  it('a "Pilates" event whose duration ≠ the service class duration is NOT auto-opened', async () => {
    // 19:00 → 20:30 = 90 min, but the Pilates class is 60 min.
    await reconcileOwnerEvent(ctx(), ownerEvent({ end: new Date('2026-07-05T20:30:00Z') }), 'push')
    expect(insertedBlock().values['type']).toBe('block')
    expect(insertedBlock().values['serviceTypeId']).toBe('svc-pilates') // still carries the pending-class marker
    expect(lastDecision()['decision']).toBe('weak_pending_confirm')
  })
})

describe('(3) phantom-occupancy prose vetoes → occupy-and-ask, count never trusted', () => {
  it('"regular class, 2/8 booked" with matching duration is NOT auto-opened; capacity stays service default', async () => {
    await reconcileOwnerEvent(ctx(), ownerEvent({ description: 'regular class, 2/8 booked' }), 'push')
    expect(insertedBlock().values['type']).toBe('block')
    expect(insertedBlock().values['maxParticipants']).toBe(8) // SERVICE default, never parsed from "2/8"
    expect(lastDecision()['decision']).toBe('weak_pending_confirm')
  })
})

describe('(4) negative marker vetoes the MARKER path too → occupy-and-ask', () => {
  it('marker "class: Pilates; capacity: 8" with "private" in the description is NOT auto-opened', async () => {
    h.existingClassBlocks = [] // no template certainty — the marker would otherwise carry it
    await reconcileOwnerEvent(
      ctx(),
      ownerEvent({ summary: 'Evening session', description: 'class: Pilates; capacity: 8 — private group' }),
      'push',
    )
    expect(insertedBlock().values['type']).toBe('block')
    expect(lastDecision()['decision']).toBe('weak_pending_confirm')
  })
})

describe('(5) REGRESSION: a clean, duration-matched class stays auto-open (G1 happy path)', () => {
  it('clean "Pilates", duration == class duration, on a Pilates weekday → class_materialized/template, bookable', async () => {
    await reconcileOwnerEvent(ctx(), ownerEvent(), 'push')
    const ins = insertedBlock()
    expect(ins.values['type']).toBe('class')
    expect(ins.values['source']).toBe('google_import')
    expect(ins.values['serviceTypeId']).toBe('svc-pilates')
    expect(ins.values['maxParticipants']).toBe(8)
    expect(lastDecision()).toMatchObject({ decision: 'class_materialized', matchTier: 'template' })
  })
})
