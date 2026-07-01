/**
 * C0.1 — completeness guard on diff-based deletion, and Phase 0 — inbound-decision
 * telemetry on the read path, exercised through `reconcileScheduleWindowOnRead`.
 *
 * No DB here (DATABASE_URL unset); we drive the reconcile with a table-name-aware
 * `db` mock (same spirit as src/domain/waitlist/accept.test.ts) plus a mocked
 * calendar client whose `incrementalSync` returns a scripted response.
 *
 * C0.1 proves:
 *   - a successful-but-stale/empty (HTTP 200, zero events) response over a window
 *     holding N mirrored blocks deletes NOTHING (the R2 / PRE-EXISTING-BUG-B
 *     data-loss repro) — the completeness guard aborts the diff.
 *   - a genuinely-present full response still deletes a truly-removed block.
 *
 * Phase 0 proves:
 *   - reconciling an owner event emits one `inbound_decision` line with the right
 *     shape (businessId, googleEventId, decision, viaTrigger:'read') and NO title/PII.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getTableName } from 'drizzle-orm'

// ── Shared, hoist-safe mock state ─────────────────────────────────────────────
const h = vi.hoisted(() => {
  return {
    businessRow: null as Record<string, unknown> | null,
    identityRow: null as Record<string, unknown> | null,
    blocksByEventId: [] as Array<Array<Record<string, unknown>>>, // FIFO queue, one per lookup
    blocksInWindow: [] as Array<Record<string, unknown>>,
    incrementalResult: null as unknown,
    deletes: [] as string[], // table names of every db.delete(...)
    audits: [] as Array<{ action: string; entityId?: string | undefined; metadata?: Record<string, unknown> | undefined }>,
  }
})

vi.mock('../../db/client.js', () => {
  function tableName(t: unknown): string {
    try { return getTableName(t as never) } catch { return 'unknown' }
  }
  function makeSelectChain() {
    const state = { table: 'unknown' }
    const chain: Record<string, unknown> = {}
    chain['from'] = (t: unknown) => { state.table = tableName(t); return chain }
    for (const m of ['where', 'leftJoin', 'innerJoin', 'orderBy']) chain[m] = () => chain
    chain['limit'] = async () => {
      if (state.table === 'businesses') return h.businessRow ? [h.businessRow] : []
      if (state.table === 'identities') return h.identityRow ? [h.identityRow] : []
      if (state.table === 'calendar_blocks') return h.blocksByEventId.shift() ?? []
      return []
    }
    // Awaited-without-limit selects (the in-window blocks query) resolve here.
    chain['then'] = (resolve: (v: unknown) => unknown) => {
      if (state.table === 'calendar_blocks') return resolve(h.blocksInWindow)
      return resolve([])
    }
    return chain
  }
  return {
    db: {
      select: () => makeSelectChain(),
      insert: () => ({ values: async () => undefined }),
      update: () => ({ set: () => ({ where: async () => undefined }) }),
      delete: (t: unknown) => {
        h.deletes.push(tableName(t))
        return { where: async () => undefined }
      },
    },
  }
})

const incrementalSyncMock = vi.fn(async () => h.incrementalResult)
vi.mock('../../adapters/calendar/client.js', () => ({
  createCalendarClient: () => ({
    incrementalSync: incrementalSyncMock,
  }),
}))

vi.mock('../audit/logger.js', () => ({
  logAudit: async (_db: unknown, entry: { action: string; entityId?: string | undefined; metadata?: Record<string, unknown> | undefined }) => {
    h.audits.push({ action: entry.action, entityId: entry.entityId, metadata: entry.metadata })
  },
}))

vi.mock('../../workers/message-retry.js', () => ({ enqueueMessage: vi.fn(async () => undefined) }))
vi.mock('../initiations/booking-notify.js', () => ({
  notifyBusinessBookingChange: vi.fn(async () => undefined),
  notifyOwnerBookingChange: vi.fn(async () => undefined),
}))

import { reconcileScheduleWindowOnRead } from './inbound-sync.js'
import { INBOUND_DECISION_LOG_TYPE } from './inbound-telemetry.js'

const WINDOW = { from: new Date('2026-07-05T00:00:00Z'), to: new Date('2026-07-06T00:00:00Z') }

function seedConnectedBusiness() {
  h.businessRow = {
    id: 'biz-1',
    calendarMode: 'google',
    googleRefreshToken: 'rt',
    googleCalendarId: 'cal-1',
    defaultLanguage: 'he',
  }
  h.identityRow = { phoneNumber: '+972500000001' }
}

beforeEach(() => {
  vi.clearAllMocks()
  h.businessRow = null
  h.identityRow = null
  h.blocksByEventId = []
  h.blocksInWindow = []
  h.incrementalResult = null
  h.deletes = []
  h.audits = []
})

describe('C0.1 — completeness guard on reconcileScheduleWindowOnRead diff-deletion', () => {
  it('stale/empty-but-200 response over a window holding N mirrored blocks deletes NOTHING', async () => {
    seedConnectedBusiness()
    // Google returned zero live events (eventually-consistent / stale-OK).
    h.incrementalResult = { status: 'ok', events: [], nextSyncToken: null }
    // We hold 3 mirrored blocks that all START inside the window.
    h.blocksInWindow = [
      { id: 'b1', googleEventId: 'g1' },
      { id: 'b2', googleEventId: 'g2' },
      { id: 'b3', googleEventId: 'g3' },
    ]

    const res = await reconcileScheduleWindowOnRead('biz-1', WINDOW)

    expect(res.ok).toBe(true)
    // The whole point: not one deletion fired on an implausibly-empty response.
    expect(h.deletes).toHaveLength(0)
    // The guard is observable (logged), not silent.
    expect(h.audits.some((a) => a.action === 'calendar.reconcile_completeness_guard')).toBe(true)
  })

  it('a genuinely-present full response still deletes a truly-removed block', async () => {
    seedConnectedBusiness()
    // Google returns g1 (still present); g2 is genuinely gone from the returned set.
    h.incrementalResult = {
      status: 'ok',
      nextSyncToken: null,
      events: [
        {
          eventId: 'g1',
          status: 'confirmed',
          summary: 'Owner private note',
          start: new Date('2026-07-05T09:00:00Z'),
          end: new Date('2026-07-05T10:00:00Z'),
          etag: 'etag-g1',
          paManaged: false,
          paType: null,
          paId: null,
        },
      ],
    }
    // reconcileOwnerEvent(g1) looks up its existing block → update (no insert).
    h.blocksByEventId = [[{ id: 'b1' }]]
    h.blocksInWindow = [
      { id: 'b1', googleEventId: 'g1' }, // present → kept
      { id: 'b2', googleEventId: 'g2' }, // absent → deleted
    ]

    const res = await reconcileScheduleWindowOnRead('biz-1', WINDOW)

    expect(res.ok).toBe(true)
    expect(h.deletes).toEqual(['calendar_blocks']) // exactly one delete
    const del = h.audits.find((a) => a.action === 'calendar.owner_deleted_block')
    expect(del?.entityId).toBe('b2')
    expect(del?.metadata?.['googleEventId']).toBe('g2')
    // The guard did NOT trip on a plausible response.
    expect(h.audits.some((a) => a.action === 'calendar.reconcile_completeness_guard')).toBe(false)
  })
})

describe('Phase 0 — inbound-decision telemetry on the read path', () => {
  let lines: Array<Record<string, unknown>>
  let spy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    lines = []
    spy = vi.spyOn(console, 'log').mockImplementation((arg: unknown) => {
      try {
        const parsed = JSON.parse(String(arg))
        if (parsed && parsed.logType === INBOUND_DECISION_LOG_TYPE) lines.push(parsed)
      } catch { /* not our line */ }
    })
  })
  afterEach(() => { spy.mockRestore() })

  it('emits one decision line for a reconciled owner event, shape correct, no title/PII', async () => {
    seedConnectedBusiness()
    const SECRET_TITLE = 'Dentist appointment — very private'
    h.incrementalResult = {
      status: 'ok',
      nextSyncToken: null,
      events: [
        {
          eventId: 'gev-77',
          status: 'confirmed',
          summary: SECRET_TITLE,
          start: new Date('2026-07-05T14:00:00Z'),
          end: new Date('2026-07-05T15:00:00Z'),
          etag: 'etag-77',
          paManaged: false,
          paType: null,
          paId: null,
        },
      ],
    }
    h.blocksByEventId = [[{ id: 'blk-77' }]] // existing → update
    h.blocksInWindow = [{ id: 'blk-77', googleEventId: 'gev-77' }]

    await reconcileScheduleWindowOnRead('biz-1', WINDOW)

    expect(lines).toHaveLength(1)
    const line = lines[0]!
    expect(line).toMatchObject({
      businessId: 'biz-1',
      googleEventId: 'gev-77',
      decision: 'block_opaque',
      matchedServiceTypeId: null,
      matchTier: null,
      viaTrigger: 'read',
    })
    // Privacy: the owner's event title is NEVER in the telemetry.
    expect(JSON.stringify(line)).not.toContain(SECRET_TITLE)
    expect(JSON.stringify(line).toLowerCase()).not.toContain('dentist')
  })
})
