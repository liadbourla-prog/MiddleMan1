/**
 * T1.2 — certainty-gated classification inside the inbound translator
 * (reconcileOwnerEvent). Drives the classifier directly with a capturing db-mock so
 * we can assert the EXACT row written (type / source / serviceTypeId / capacity) and
 * the Phase-0 telemetry decision per branch.
 *
 * Repros encoded (plan §Phase 1 "Failing tests first"):
 *  (a) template match  → type='class' google_import block (bookable); class_materialized/template
 *  (b) bare class, no series → type='block' pending marker (occupies, NOT bookable); weak_pending_confirm + owner relay
 *  (c) "2/8 booked" prose → NOT trusted for occupancy → ask-owner (weak_pending_confirm), never auto-open
 *  (d) none-match "dentist" → opaque type='block', serviceTypeId null; block_opaque (today's behavior)
 *  (e) private "Pilates", no series → occupy-and-ask, NEVER auto-booked (the decision-#10 leak repro)
 *  (+) structured marker → class_materialized/marker with the marker capacity
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getTableName } from 'drizzle-orm'

const h = vi.hoisted(() => ({
  services: [] as Array<Record<string, unknown>>,
  existingBlockLookup: [] as Array<Array<Record<string, unknown>>>, // FIFO: existing-by-googleEventId .limit(1)
  existingClassBlocks: [] as Array<Record<string, unknown>>, // class-series list (.then)
  inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
  updates: [] as string[],
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
      update: (t: unknown) => { h.updates.push(tableName(t)); return { set: () => ({ where: async () => undefined }) } },
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

const PILATES = { id: 'svc-pilates', name: 'Pilates', schedulingMode: 'class', maxParticipants: 8, isActive: true }
const MASSAGE = { id: 'svc-massage', name: 'Massage', schedulingMode: 'appointment', maxParticipants: 1, isActive: true }

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
    end: new Date('2026-07-05T20:00:00Z'),
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
  h.services = [PILATES, MASSAGE]
  h.existingBlockLookup = [[]] // no existing block for the new event → insert path
  h.existingClassBlocks = []
  h.inserts = []
  h.updates = []
  h.enqueued = []
  lines = []
  spy = vi.spyOn(console, 'log').mockImplementation((arg: unknown) => {
    try { const p = JSON.parse(String(arg)); if (p?.logType === INBOUND_DECISION_LOG_TYPE) lines.push(p) } catch { /* not ours */ }
  })
})
afterEach(() => { spy.mockRestore() })

function lastDecision() { return lines[lines.length - 1] }

describe('T1.2 (a) certainty template-match → bookable class', () => {
  it('materializes a type=class google_import block when the weekday already runs the service', async () => {
    // Sunday already runs Pilates at 09:00 → the new Sunday 19:00 Pilates is CERTAIN.
    h.existingClassBlocks = [{ startTs: new Date('2026-07-05T09:00:00Z'), googleEventId: null }]

    await reconcileOwnerEvent(ctx(), ownerEvent(), 'push')

    const ins = h.inserts.find((i) => i.table === 'calendar_blocks')
    expect(ins).toBeDefined()
    expect(ins!.values['type']).toBe('class')
    expect(ins!.values['source']).toBe('google_import')
    expect(ins!.values['serviceTypeId']).toBe('svc-pilates')
    expect(ins!.values['maxParticipants']).toBe(8)
    expect(ins!.values['providerId']).toBeNull()
    expect(ins!.values['title']).toBeNull() // never leak the owner title
    expect(lastDecision()).toMatchObject({ decision: 'class_materialized', matchTier: 'template', matchedServiceTypeId: 'svc-pilates' })
    // Owner gets the informational note; NO customer/booking mirror job.
    expect(h.enqueued).toHaveLength(1)
  })
})

describe('T1.2 (b)/(e) uncertain class → occupy-and-ASK (pending marker, not bookable)', () => {
  it('bare "Pilates class" with no existing series → type=block pending marker + owner relay', async () => {
    h.existingClassBlocks = [] // no series on this weekday → NOT certain
    await reconcileOwnerEvent(ctx(), ownerEvent({ summary: 'Pilates class' }), 'push')

    const ins = h.inserts.find((i) => i.table === 'calendar_blocks')!
    expect(ins.values['type']).toBe('block') // opaque → occupies the slot, NEVER bookable (findClassBlock needs type=class)
    expect(ins.values['source']).toBe('google_import')
    expect(ins.values['serviceTypeId']).toBe('svc-pilates') // pending-class marker
    expect(ins.values['title']).toBeNull()
    expect(lastDecision()).toMatchObject({ decision: 'weak_pending_confirm', matchedServiceTypeId: 'svc-pilates' })
    expect(h.enqueued).toHaveLength(1) // owner relayed (confirm question)
  })

  it('(e) private class titled "Pilates" with no series → occupy-and-ask, never auto-booked', async () => {
    h.existingClassBlocks = []
    await reconcileOwnerEvent(ctx(), ownerEvent({ summary: 'Pilates' }), 'push')
    const ins = h.inserts.find((i) => i.table === 'calendar_blocks')!
    expect(ins.values['type']).toBe('block') // the R1 leak repro: a bare-title Pilates is NOT auto-opened
    expect(lastDecision()!['decision']).toBe('weak_pending_confirm')
  })
})

describe('T1.2 (c) free-text "2/8 booked" is NOT trusted for occupancy', () => {
  it('a description implying external head-count → ask-owner path, never auto-open', async () => {
    h.existingClassBlocks = [] // no template certainty
    await reconcileOwnerEvent(ctx(), ownerEvent({ summary: 'Pilates', description: 'evening — 2/8 booked, walk-ins ok' }), 'push')
    const ins = h.inserts.find((i) => i.table === 'calendar_blocks')!
    expect(ins.values['type']).toBe('block') // NOT materialized off a prose head-count
    expect(ins.values['maxParticipants']).toBe(8) // capacity = SERVICE DEFAULT, never parsed from "2/8"
    expect(lastDecision()!['decision']).toBe('weak_pending_confirm')
  })
})

describe('T1.2 (d) none-match → opaque block (today\'s behavior, decision #10)', () => {
  it('"dentist" matches no service → type=block, serviceTypeId null, block_opaque', async () => {
    await reconcileOwnerEvent(ctx(), ownerEvent({ summary: 'Dentist' }), 'push')
    const ins = h.inserts.find((i) => i.table === 'calendar_blocks')!
    expect(ins.values['type']).toBe('block')
    expect(ins.values['serviceTypeId']).toBeNull()
    expect(ins.values['title']).toBeNull()
    expect(lastDecision()).toMatchObject({ decision: 'block_opaque', matchedServiceTypeId: null, matchTier: null })
    expect(h.enqueued).toHaveLength(0) // no owner ping for a personal event
  })
})

describe('T1.2 (+) structured marker → certain via marker tier', () => {
  it('description "class: Pilates; capacity: 5" → materialized class with marker capacity', async () => {
    h.existingClassBlocks = [] // no template certainty — the MARKER carries it
    await reconcileOwnerEvent(ctx(), ownerEvent({ summary: 'Evening session', description: 'class: Pilates; capacity: 5' }), 'push')
    const ins = h.inserts.find((i) => i.table === 'calendar_blocks')!
    expect(ins.values['type']).toBe('class')
    expect(ins.values['serviceTypeId']).toBe('svc-pilates')
    expect(ins.values['maxParticipants']).toBe(5) // marker capacity wins
    expect(lastDecision()).toMatchObject({ decision: 'class_materialized', matchTier: 'marker' })
  })
})

describe('T1.2 appointment-mode match → occupy + relay (never a class)', () => {
  it('"Massage" (appointment mode) → opaque block, weak_pending_confirm, no serviceTypeId marker', async () => {
    await reconcileOwnerEvent(ctx(), ownerEvent({ summary: 'Massage' }), 'push')
    const ins = h.inserts.find((i) => i.table === 'calendar_blocks')!
    expect(ins.values['type']).toBe('block')
    expect(ins.values['serviceTypeId']).toBeNull() // appointment mode never becomes a pending CLASS
    expect(lastDecision()!['decision']).toBe('weak_pending_confirm')
  })
})
