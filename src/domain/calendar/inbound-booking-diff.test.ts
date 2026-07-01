/**
 * T2.2 — booking-diff deletion detection on the WINDOWED path (closes PRE-EXISTING BUG A),
 * with the C0.1 completeness guard. Exercised through runInboundSync with a table-name-aware
 * db mock + a scripted incrementalSync (same harness spirit as inbound-cancel-telemetry.test).
 *
 * The catastrophe repro (c) is the linchpin and is written FIRST: a successful-but-empty
 * Google response over a window holding N live bookings must fire ZERO cancellations and
 * ZERO notifications. A bug here spams real paying customers with false cancellation
 * WhatsApps — the completeness guard is the whole point.
 *
 * Repros:
 *   (a) freed booking, push dropped, token VALID → tick incremental tombstone → cancelled
 *       (booking-diff does NOT run on the incremental path).
 *   (b) freed booking, token EXPIRED → windowed pull + booking-diff → gated cancel + notify.
 *   (c) empty-but-200 over N live bookings → ZERO cancellations, ZERO notifications (C0.1).
 *   (d) > blast-radius threshold freed → gate asks the manager, cancels nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getTableName } from 'drizzle-orm'

const h = vi.hoisted(() => ({
  businessRow: null as Record<string, unknown> | null,
  managerRow: null as Record<string, unknown> | null,
  channelRow: null as Record<string, unknown> | null,
  bookingRows: [] as Array<Array<Record<string, unknown>>>, // FIFO per bookings .limit lookup
  bookingsInWindow: [] as Array<Record<string, unknown>>, // the booking-diff's awaited (no-limit) query
  incrementalSeq: [] as unknown[], // FIFO; the last element repeats
  getEventResults: {} as Record<string, unknown>, // per-eventId getEvent(confirm-before-cancel) result
  bookingUpdates: 0,
  audits: [] as Array<{ action: string; metadata?: Record<string, unknown> | undefined }>,
  notifyCustomer: 0,
  notifyOwner: 0,
  enqueued: [] as Array<string>, // manager phone per enqueueMessage (blast-radius/summary notes)
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
      if (state.table === 'calendar_blocks') return [] // owner-event existing-block lookup → insert path
      return []
    }
    // Awaited-without-limit selects: the booking-diff's in-window bookings query resolves here.
    chain['then'] = (resolve: (v: unknown) => unknown) => {
      if (state.table === 'bookings') return resolve(h.bookingsInWindow)
      return resolve([])
    }
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

const incrementalSyncMock = vi.fn(async () => (h.incrementalSeq.length > 1 ? h.incrementalSeq.shift() : h.incrementalSeq[0]))
// Confirm-before-cancel (orchestrator review): the booking-diff authoritatively re-fetches each
// diff candidate before cancelling. Default → not_found (genuinely gone), so pre-existing repros
// where an absent mirror IS a real deletion stay green; a test scripts getEventResults to make an
// event "still exist" (stale-list omission) or "error" (absence unconfirmed).
const getEventMock = vi.fn(async (eventId: string) => h.getEventResults[eventId] ?? { status: 'not_found' })
vi.mock('../../adapters/calendar/client.js', () => ({
  createCalendarClient: () => ({ incrementalSync: incrementalSyncMock, getEvent: getEventMock }),
}))
vi.mock('../audit/logger.js', () => ({
  logAudit: async (_db: unknown, entry: { action: string; metadata?: Record<string, unknown> | undefined }) => {
    h.audits.push({ action: entry.action, metadata: entry.metadata })
  },
}))
vi.mock('../../workers/message-retry.js', () => ({ enqueueMessage: async (_b: string, phone: string) => { h.enqueued.push(phone) } }))
vi.mock('../initiations/booking-notify.js', () => ({
  notifyBusinessBookingChange: async () => { h.notifyCustomer += 1 },
  notifyOwnerBookingChange: async () => { h.notifyOwner += 1 },
}))

import { runInboundSync } from './inbound-sync.js'
import { INBOUND_DECISION_LOG_TYPE } from './inbound-telemetry.js'

function seed(channel: Record<string, unknown> | null) {
  h.businessRow = { id: 'biz-1', calendarMode: 'google', googleRefreshToken: 'rt', googleCalendarId: 'cal-1', defaultLanguage: 'en', timezone: 'UTC' }
  h.managerRow = { phoneNumber: '+972500000001' }
  h.channelRow = channel
}

// A live PA-managed booking we hold internally, mirrored to a Google event (calendarEventId).
function mirroredBooking(id: string): Record<string, unknown> {
  return { id, customerId: `cust-${id}`, serviceTypeId: 'svc-1', slotStart: new Date('2026-07-05T10:00:00Z'), calendarEventId: `g-${id}`, state: 'confirmed' }
}
// A present (still-there) owner event so the returned set is non-empty (guard passes).
function presentOwnerEvent(id: string): Record<string, unknown> {
  return { eventId: id, status: 'confirmed', summary: null, description: null, start: new Date('2026-07-05T08:00:00Z'), end: new Date('2026-07-05T09:00:00Z'), etag: 'e', paManaged: false, paType: null, paId: null }
}
function cancelledBookingTombstone(id: string): Record<string, unknown> {
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
  h.bookingRows = []; h.bookingsInWindow = []; h.incrementalSeq = []; h.getEventResults = {}
  h.bookingUpdates = 0; h.audits = []; h.notifyCustomer = 0; h.notifyOwner = 0; h.enqueued = []
  lines = []
  spy = vi.spyOn(console, 'log').mockImplementation((arg: unknown) => {
    try { const p = JSON.parse(String(arg)); if (p?.logType === INBOUND_DECISION_LOG_TYPE) lines.push(p) } catch { /* not ours */ }
  })
})
afterEach(() => { spy.mockRestore(); delete process.env['CALENDAR_INBOUND_SYNC_ENABLED'] })

// ── (c) CATASTROPHE REPRO — written first, made airtight ──────────────────────
describe('(c) C0.1 completeness guard — empty-but-200 over N live bookings mass-cancels NOTHING', () => {
  it('windowed pull returns ZERO events while we hold 5 mirrored bookings → 0 cancellations, 0 notifications', async () => {
    seed(null) // no channel/token → windowed path
    h.incrementalSeq = [{ status: 'ok', nextSyncToken: 'tok', events: [] }] // successful, but empty
    h.bookingsInWindow = [
      mirroredBooking('b1'), mirroredBooking('b2'), mirroredBooking('b3'),
      mirroredBooking('b4'), mirroredBooking('b5'),
    ]

    await runInboundSync('biz-1', { full: true }, 'tick')

    // The whole point: not one booking cancelled, not one WhatsApp sent.
    expect(h.bookingUpdates).toBe(0)
    expect(h.notifyCustomer).toBe(0)
    expect(h.notifyOwner).toBe(0)
    expect(h.enqueued).toHaveLength(0) // no blast-radius/summary manager note either
    expect(lines.filter((l) => l['decision'] === 'booking_cancelled')).toHaveLength(0)
    // The guard is observable, not silent-in-the-dark.
    const guard = h.audits.find((a) => a.action === 'calendar.reconcile_completeness_guard')
    expect(guard?.metadata).toMatchObject({ via: 'booking_diff', reason: 'empty_response_over_nonempty_window', mirroredInWindow: 5 })
  })
})

describe('(a) freed booking, push dropped, token VALID → incremental tombstone cancels it', () => {
  it('tick with a live syncToken pulls the cancellation tombstone → booking cancelled (booking-diff not involved)', async () => {
    seed({ businessId: 'biz-1', syncToken: 'tok-1' }) // valid token → incremental path
    h.incrementalSeq = [{ status: 'ok', nextSyncToken: 'tok-2', events: [cancelledBookingTombstone('b1')] }]
    h.bookingRows = [[confirmedBookingRow('b1')]] // reconcileManagedEvent lookup

    await runInboundSync('biz-1', {}, 'tick')

    expect(h.bookingUpdates).toBe(1)
    expect(h.notifyCustomer).toBe(1)
    const cancel = lines.filter((l) => l['decision'] === 'booking_cancelled')
    expect(cancel).toHaveLength(1)
    expect(cancel[0]).toMatchObject({ viaTrigger: 'tick', googleEventId: 'g-b1' })
    expect(h.audits.some((a) => a.action === 'calendar.reconcile_completeness_guard')).toBe(false)
  })
})

describe('(b) freed booking, token EXPIRED → windowed + booking-diff → gated cancel + notify (Bug A)', () => {
  it('expired token re-runs windowed; the mirror absent from the returned set is owner-deleted → cancelled', async () => {
    seed({ businessId: 'biz-1', syncToken: 'stale-tok' })
    // 1st call (with token) → expired; 2nd call (windowed) → ok, returns ONE other present event
    // (so the returned set is non-empty ⇒ guard passes) but NOT b1's mirror event.
    h.incrementalSeq = [
      { status: 'expired' },
      { status: 'ok', nextSyncToken: 'tok-new', events: [presentOwnerEvent('g-other')] },
    ]
    h.bookingsInWindow = [mirroredBooking('b1')] // b1's mirror (g-b1) is absent from the returned set

    await runInboundSync('biz-1', {}, 'tick')

    expect(incrementalSyncMock).toHaveBeenCalledTimes(2) // token attempt + windowed re-run
    expect(h.bookingUpdates).toBe(1) // b1 cancelled via the gated path
    expect(h.notifyCustomer).toBe(1) // customer notified
    const cancel = lines.filter((l) => l['decision'] === 'booking_cancelled')
    expect(cancel).toHaveLength(1)
    expect(cancel[0]).toMatchObject({ viaTrigger: 'tick', googleEventId: 'g-b1' })
    expect(h.audits.some((a) => a.action === 'calendar.reconcile_completeness_guard')).toBe(false)
  })

  it('a mirror STILL present in the returned set is kept (not a false deletion)', async () => {
    seed(null) // windowed via full
    h.incrementalSeq = [{ status: 'ok', nextSyncToken: 'tok', events: [presentOwnerEvent('g-b1')] }] // b1 present
    h.bookingsInWindow = [mirroredBooking('b1')]

    await runInboundSync('biz-1', { full: true }, 'tick')

    expect(h.bookingUpdates).toBe(0) // present → kept
    expect(lines.filter((l) => l['decision'] === 'booking_cancelled')).toHaveLength(0)
  })
})

describe('(d) > blast-radius threshold freed bookings → gate asks the manager, cancels nothing', () => {
  it('3 mirrored bookings absent from a non-empty returned set → gated: 0 cancels, manager asked', async () => {
    seed(null) // windowed via full
    // Returned set is non-empty (a present owner event) so the C0.1 guard passes; but all three
    // booking mirrors are absent ⇒ 3 detected deletions > BLAST_RADIUS_THRESHOLD (2).
    h.incrementalSeq = [{ status: 'ok', nextSyncToken: 'tok', events: [presentOwnerEvent('g-present')] }]
    h.bookingsInWindow = [mirroredBooking('b1'), mirroredBooking('b2'), mirroredBooking('b3')]

    await runInboundSync('biz-1', { full: true }, 'tick')

    expect(h.bookingUpdates).toBe(0) // gate blocked every cancel
    expect(h.notifyCustomer).toBe(0) // no customer cancellation WhatsApps
    expect(lines.filter((l) => l['decision'] === 'booking_cancelled')).toHaveLength(0)
    expect(h.enqueued).toHaveLength(1) // exactly the manager blast-radius ask
    expect(h.audits.some((a) => a.action === 'calendar.owner_reconcile_gated')).toBe(true)
    // Guard did NOT trip — this is a genuine gate case, not an empty response.
    expect(h.audits.some((a) => a.action === 'calendar.reconcile_completeness_guard')).toBe(false)
  })
})

// ── (e) CONFIRM-BEFORE-CANCEL (orchestrator review) — the stale-single-omission fix ─────────────
// A booking mirror absent from a NON-EMPTY returned set is only a candidate; before cancelling we
// authoritatively re-fetch it via getEvent. The linchpin repro: the event STILL EXISTS (Google
// merely omitted it from a stale list page) → keep the booking, cancel NOTHING, zero notifications.
describe('(e) confirm-before-cancel — a mirror absent-but-still-existing (stale-list omission) is NOT cancelled', () => {
  it('one mirror absent from a non-empty set, getEvent says it exists → 0 cancels, 0 notifications', async () => {
    seed(null) // windowed via full
    h.incrementalSeq = [{ status: 'ok', nextSyncToken: 'tok', events: [presentOwnerEvent('g-present')] }]
    h.bookingsInWindow = [mirroredBooking('b1')] // g-b1 absent from the returned set…
    h.getEventResults = { 'g-b1': { status: 'ok', cancelled: false } } // …but the event still exists → stale omission

    await runInboundSync('biz-1', { full: true }, 'tick')

    expect(getEventMock).toHaveBeenCalledWith('g-b1') // it was confirmed, not trusted-by-absence
    expect(h.bookingUpdates).toBe(0) // kept
    expect(h.notifyCustomer).toBe(0)
    expect(h.notifyOwner).toBe(0)
    expect(h.enqueued).toHaveLength(0)
    expect(lines.filter((l) => l['decision'] === 'booking_cancelled')).toHaveLength(0)
  })

  it('getEvent confirms the event is genuinely gone (not_found) → cancelled + notified', async () => {
    seed(null) // windowed via full
    h.incrementalSeq = [{ status: 'ok', nextSyncToken: 'tok', events: [presentOwnerEvent('g-present')] }]
    h.bookingsInWindow = [mirroredBooking('b1')]
    h.getEventResults = { 'g-b1': { status: 'not_found' } } // authoritatively gone

    await runInboundSync('biz-1', { full: true }, 'tick')

    expect(getEventMock).toHaveBeenCalledWith('g-b1')
    expect(h.bookingUpdates).toBe(1) // real deletion still cancels
    expect(h.notifyCustomer).toBe(1)
    const cancel = lines.filter((l) => l['decision'] === 'booking_cancelled')
    expect(cancel).toHaveLength(1)
    expect(cancel[0]).toMatchObject({ viaTrigger: 'tick', googleEventId: 'g-b1' })
  })

  it('getEvent errors/times out on the candidate → absence UNCONFIRMED → booking kept (fail-safe)', async () => {
    seed(null) // windowed via full
    h.incrementalSeq = [{ status: 'ok', nextSyncToken: 'tok', events: [presentOwnerEvent('g-present')] }]
    h.bookingsInWindow = [mirroredBooking('b1')]
    h.getEventResults = { 'g-b1': { status: 'error', reason: 'Google getEvent timed out after 15000ms' } }

    await runInboundSync('biz-1', { full: true }, 'tick')

    expect(getEventMock).toHaveBeenCalledWith('g-b1')
    expect(h.bookingUpdates).toBe(0) // never false-cancel on unconfirmed absence
    expect(h.notifyCustomer).toBe(0)
    expect(lines.filter((l) => l['decision'] === 'booking_cancelled')).toHaveLength(0)
    // Observable: the unconfirmed absence is audited (the next reconcile retries).
    expect(h.audits.some((a) => a.action === 'calendar.reconcile_absence_unconfirmed')).toBe(true)
  })
})
