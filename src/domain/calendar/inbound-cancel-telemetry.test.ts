/**
 * Folded Phase-0 review nits, exercised through runInboundSync:
 *  (a) booking_cancelled telemetry is emitted where the cancellation is APPLIED
 *      (post-blast-radius-gate), never at detection. When the gate blocks the change
 *      (> threshold), it is NOT logged as cancelled.
 *  (b) the real trigger threads through: a renewal full-reconcile is labelled 'cron',
 *      not mislabelled 'push'.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getTableName } from 'drizzle-orm'

const h = vi.hoisted(() => ({
  businessRow: null as Record<string, unknown> | null,
  managerRow: null as Record<string, unknown> | null,
  channelRow: null as Record<string, unknown> | null,
  bookingRows: [] as Array<Array<Record<string, unknown>>>, // FIFO per bookings .limit lookup
  incrementalResult: null as unknown,
  bookingUpdates: 0,
}))

vi.mock('../../db/client.js', () => {
  function tableName(t: unknown): string { try { return getTableName(t as never) } catch { return 'unknown' } }
  function makeSelectChain() {
    const state = { table: 'unknown' }
    const chain: Record<string, unknown> = {}
    chain['from'] = (t: unknown) => { state.table = tableName(t); return chain }
    for (const m of ['where', 'leftJoin', 'innerJoin', 'orderBy']) chain[m] = () => chain
    chain['limit'] = async () => {
      if (state.table === 'businesses') return h.businessRow ? [h.businessRow] : []
      if (state.table === 'identities') return h.managerRow ? [h.managerRow] : []
      if (state.table === 'calendar_sync_channels') return h.channelRow ? [h.channelRow] : []
      if (state.table === 'bookings') return h.bookingRows.shift() ?? []
      if (state.table === 'calendar_blocks') return [] // owner-event existing-block lookup → new (insert path)
      return []
    }
    chain['then'] = (resolve: (v: unknown) => unknown) => resolve([])
    return chain
  }
  return {
    db: {
      select: () => makeSelectChain(),
      insert: () => ({ values: async () => undefined }),
      update: (t: unknown) => {
        if (tableName(t) === 'bookings') h.bookingUpdates += 1
        return { set: () => ({ where: async () => undefined }) }
      },
      delete: () => ({ where: async () => undefined }),
    },
  }
})

const incrementalSyncMock = vi.fn(async () => h.incrementalResult)
vi.mock('../../adapters/calendar/client.js', () => ({
  createCalendarClient: () => ({ incrementalSync: incrementalSyncMock }),
}))
vi.mock('../audit/logger.js', () => ({ logAudit: vi.fn(async () => undefined) }))
vi.mock('../../workers/message-retry.js', () => ({ enqueueMessage: vi.fn(async () => undefined) }))
vi.mock('../initiations/booking-notify.js', () => ({
  notifyBusinessBookingChange: vi.fn(async () => undefined),
  notifyOwnerBookingChange: vi.fn(async () => undefined),
}))

import { runInboundSync } from './inbound-sync.js'
import { INBOUND_DECISION_LOG_TYPE } from './inbound-telemetry.js'

function seed() {
  h.businessRow = { id: 'biz-1', calendarMode: 'google', googleRefreshToken: 'rt', googleCalendarId: 'cal-1', defaultLanguage: 'en', timezone: 'UTC' }
  h.managerRow = { phoneNumber: '+972500000001' }
  h.channelRow = { businessId: 'biz-1', syncToken: 'tok-1' }
}

function cancelledBookingEvent(id: string): Record<string, unknown> {
  return { eventId: `g-${id}`, status: 'cancelled', summary: null, description: null, start: null, end: null, etag: 'e', paManaged: true, paType: 'booking', paId: id }
}
function confirmedBookingRow(id: string): Record<string, unknown> {
  return { id, customerId: `cust-${id}`, serviceTypeId: 'svc-1', slotStart: new Date('2026-07-05T10:00:00Z'), state: 'confirmed', googleEtag: 'old' }
}

let lines: Array<Record<string, unknown>>
let spy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.clearAllMocks()
  process.env['CALENDAR_INBOUND_SYNC_ENABLED'] = '1'
  h.businessRow = null; h.managerRow = null; h.channelRow = null
  h.bookingRows = []; h.incrementalResult = null; h.bookingUpdates = 0
  lines = []
  spy = vi.spyOn(console, 'log').mockImplementation((arg: unknown) => {
    try { const p = JSON.parse(String(arg)); if (p?.logType === INBOUND_DECISION_LOG_TYPE) lines.push(p) } catch { /* not ours */ }
  })
})
afterEach(() => { spy.mockRestore(); delete process.env['CALENDAR_INBOUND_SYNC_ENABLED'] })

describe('(a) booking_cancelled telemetry is emitted at APPLICATION, not detection', () => {
  it('under the blast-radius threshold → cancel applied AND logged booking_cancelled', async () => {
    seed()
    h.incrementalResult = { status: 'ok', nextSyncToken: 'tok-2', events: [cancelledBookingEvent('bk-1')] }
    h.bookingRows = [[confirmedBookingRow('bk-1')]]

    await runInboundSync('biz-1', {}, 'push')

    expect(h.bookingUpdates).toBe(1) // the cancel was applied
    const cancelLines = lines.filter((l) => l['decision'] === 'booking_cancelled')
    expect(cancelLines).toHaveLength(1)
    expect(cancelLines[0]).toMatchObject({ googleEventId: 'g-bk-1', viaTrigger: 'push', matchedServiceTypeId: 'svc-1' })
  })

  it('OVER the blast-radius threshold (gated) → nothing cancelled, NOTHING logged booking_cancelled', async () => {
    seed()
    // 3 cancellations > BLAST_RADIUS_THRESHOLD (2) ⇒ the gate blocks the auto-cancel.
    h.incrementalResult = { status: 'ok', nextSyncToken: 'tok-2', events: [cancelledBookingEvent('bk-1'), cancelledBookingEvent('bk-2'), cancelledBookingEvent('bk-3')] }
    h.bookingRows = [[confirmedBookingRow('bk-1')], [confirmedBookingRow('bk-2')], [confirmedBookingRow('bk-3')]]

    await runInboundSync('biz-1', {}, 'push')

    expect(h.bookingUpdates).toBe(0) // gate blocked every cancel
    expect(lines.filter((l) => l['decision'] === 'booking_cancelled')).toHaveLength(0) // not logged when gated
  })
})

describe('(b) the renewal full-reconcile is labelled cron, not push', () => {
  it('runInboundSync(..., "cron") stamps viaTrigger:cron on the decision line', async () => {
    seed()
    h.incrementalResult = {
      status: 'ok',
      nextSyncToken: 'tok-2',
      events: [{ eventId: 'g-owner', status: 'confirmed', summary: 'Dentist', description: null, start: new Date('2026-07-05T14:00:00Z'), end: new Date('2026-07-05T15:00:00Z'), etag: 'e', paManaged: false, paType: null, paId: null }],
    }
    await runInboundSync('biz-1', { full: true }, 'cron')

    const owner = lines.find((l) => l['googleEventId'] === 'g-owner')
    expect(owner).toMatchObject({ decision: 'block_opaque', viaTrigger: 'cron' })
  })
})
