/**
 * T1.4 — owner MOVES / DELETES an imported class or pending block in Google.
 *
 * The inbound translator must never silently orphan a materialized class that has
 * customer bookings when the owner later edits it directly in Google.
 *
 * MOVE (time change) — DECISION: relocate the co-bookings to the new slot + notify
 *   each customer (kind:'moved') and the owner. Rationale: a move is non-destructive —
 *   the class instance persists, only its clock time shifts — so the customer's seat
 *   follows the class (owner-wins). Cancelling would strand a customer whose class still
 *   exists. Notifying via the existing 'moved' spine keeps it honest (never silent). A
 *   passive READ never notifies (no side effect on reconcile-on-read) — the block time is
 *   patched, the booking relocation/notify rides the push/tick.
 *
 * DELETE — pending block / 0-booking class ⇒ clean removal (today's behavior). A
 *   materialized class WITH bookings ⇒ the owner-wins blast-radius gate
 *   (applyOwnerCancellations): >threshold ⇒ ask the manager and cancel NOTHING (block
 *   kept occupied so seats aren't orphaned); ≤threshold ⇒ cancel each + notify + delete
 *   the block. Emits booking_cancelled telemetry only where a cancel is applied.
 *
 * READ-path diff-delete — a materialized class with live bookings absent from Google is
 *   NEVER silently diff-deleted on a passive read (that would orphan the customers with no
 *   notification). It is skipped + audited; the gated push/tick path handles it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getTableName } from 'drizzle-orm'

const h = vi.hoisted(() => ({
  existingBlockLookup: [] as Array<Array<Record<string, unknown>>>, // FIFO: existing-by-googleEventId .limit(1)
  bookingsInSlot: [] as Array<Record<string, unknown>>, // class co-bookings (.then on bookings)
  blocksInWindow: [] as Array<Record<string, unknown>>, // reconcile-on-read window blocks (.then on calendar_blocks, no limit)
  businessRow: null as Record<string, unknown> | null,
  identityRow: null as Record<string, unknown> | null,
  incrementalResult: null as unknown,
  inserts: [] as Array<{ table: string; values: Record<string, unknown> }>,
  updates: [] as Array<{ table: string; values: Record<string, unknown> }>,
  deletes: [] as string[],
  enqueued: [] as Array<{ to: string; body: string }>,
  audits: [] as Array<{ action: string; entityId?: string | undefined; metadata?: Record<string, unknown> | undefined }>,
  notifiedCustomer: [] as Array<Record<string, unknown>>,
  notifiedOwner: [] as Array<Record<string, unknown>>,
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
      if (state.table === 'identities') return h.identityRow ? [h.identityRow] : []
      if (state.table === 'calendar_blocks') return h.existingBlockLookup.shift() ?? []
      return []
    }
    // Awaited-without-limit selects resolve here (in-window blocks, class co-bookings).
    chain['then'] = (resolve: (v: unknown) => unknown) => {
      if (state.table === 'bookings') return resolve(h.bookingsInSlot)
      if (state.table === 'calendar_blocks') return resolve(h.blocksInWindow)
      return resolve([])
    }
    return chain
  }
  return {
    db: {
      select: () => makeSelectChain(),
      insert: (t: unknown) => ({ values: (vals: Record<string, unknown>) => { h.inserts.push({ table: tableName(t), values: vals }); return { returning: async () => [{ id: 'new', ...vals }] } } }),
      update: (t: unknown) => ({ set: (vals: Record<string, unknown>) => { h.updates.push({ table: tableName(t), values: vals }); return { where: async () => undefined } } }),
      delete: (t: unknown) => { h.deletes.push(tableName(t)); return { where: async () => undefined } },
    },
  }
})

const incrementalSyncMock = vi.fn(async () => h.incrementalResult)
vi.mock('../../adapters/calendar/client.js', () => ({
  createCalendarClient: () => ({ incrementalSync: incrementalSyncMock }),
}))

vi.mock('../audit/logger.js', () => ({
  logAudit: async (_db: unknown, entry: { action: string; entityId?: string | undefined; metadata?: Record<string, unknown> | undefined }) => {
    h.audits.push({ action: entry.action, entityId: entry.entityId, metadata: entry.metadata })
  },
}))
vi.mock('../../workers/message-retry.js', () => ({
  enqueueMessage: vi.fn(async (_biz: string, to: string, body: string) => { h.enqueued.push({ to, body }) }),
}))
vi.mock('../initiations/booking-notify.js', () => ({
  notifyBusinessBookingChange: vi.fn(async (_db: unknown, _biz: string, change: Record<string, unknown>) => { h.notifiedCustomer.push(change) }),
  notifyOwnerBookingChange: vi.fn(async (_db: unknown, _biz: string, change: Record<string, unknown>) => { h.notifiedOwner.push(change) }),
}))

import { reconcileOwnerEvent, reconcileScheduleWindowOnRead, type SyncContext } from './inbound-sync.js'
import { INBOUND_DECISION_LOG_TYPE } from './inbound-telemetry.js'

function ctx(): SyncContext {
  return {
    business: { id: 'biz-1', timezone: 'UTC', defaultLanguage: 'en' } as never,
    calendarId: 'cal-1',
    refreshToken: 'rt',
    managerPhone: '+972500000001',
    lang: 'en',
  }
}

const OLD_START = new Date('2026-07-05T19:00:00Z')
const OLD_END = new Date('2026-07-05T20:00:00Z')
const NEW_START = new Date('2026-07-05T20:00:00Z')
const NEW_END = new Date('2026-07-05T21:00:00Z')

function classBlockRow(over: Partial<Record<string, unknown>> = {}) {
  return { id: 'blk-class', type: 'class', serviceTypeId: 'svc-pilates', startTs: OLD_START, endTs: OLD_END, ...over }
}
function movedEvent(over: Partial<Record<string, unknown>> = {}): never {
  return {
    eventId: 'g-class', status: 'confirmed', summary: 'Pilates', description: null,
    start: NEW_START, end: NEW_END, etag: 'etag-2', paManaged: false, paType: null, paId: null, ...over,
  } as never
}
function cancelledEvent(over: Partial<Record<string, unknown>> = {}): never {
  return {
    eventId: 'g-class', status: 'cancelled', summary: 'Pilates', description: null,
    start: OLD_START, end: OLD_END, etag: 'etag-x', paManaged: false, paType: null, paId: null, ...over,
  } as never
}
function seat(id: string, customerId: string) {
  return { id, customerId, serviceTypeId: 'svc-pilates', slotStart: OLD_START }
}

let lines: Array<Record<string, unknown>>
let spy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  vi.clearAllMocks()
  h.existingBlockLookup = []
  h.bookingsInSlot = []
  h.blocksInWindow = []
  h.businessRow = null
  h.identityRow = null
  h.incrementalResult = null
  h.inserts = []
  h.updates = []
  h.deletes = []
  h.enqueued = []
  h.audits = []
  h.notifiedCustomer = []
  h.notifiedOwner = []
  lines = []
  spy = vi.spyOn(console, 'log').mockImplementation((arg: unknown) => {
    try { const p = JSON.parse(String(arg)); if (p?.logType === INBOUND_DECISION_LOG_TYPE) lines.push(p) } catch { /* not ours */ }
  })
})
afterEach(() => { spy.mockRestore() })

// ── MOVE ──────────────────────────────────────────────────────────────────────

describe('T1.4 MOVE — owner moves a booked imported class', () => {
  it('relocates each co-booking to the new slot and notifies customer + owner (no orphan)', async () => {
    h.existingBlockLookup = [[classBlockRow()]]
    h.bookingsInSlot = [seat('bk-1', 'cust-1'), seat('bk-2', 'cust-2')]

    await reconcileOwnerEvent(ctx(), movedEvent(), 'push')

    // The block row is patched to the new time.
    const blockUpdate = h.updates.find((u) => u.table === 'calendar_blocks')
    expect(blockUpdate?.values['startTs']).toEqual(NEW_START)
    expect(blockUpdate?.values['endTs']).toEqual(NEW_END)

    // Every co-booking's seat follows the class to the new slot — no orphan left at 19:00.
    const bookingUpdates = h.updates.filter((u) => u.table === 'bookings')
    expect(bookingUpdates).toHaveLength(2)
    for (const bu of bookingUpdates) {
      expect(bu.values['slotStart']).toEqual(NEW_START)
      expect(bu.values['slotEnd']).toEqual(NEW_END)
    }

    // Each affected customer is told (honest, never silent) with the moved kind + from/to.
    expect(h.notifiedCustomer).toHaveLength(2)
    expect(h.notifiedCustomer[0]).toMatchObject({ kind: 'moved', fromSlotStart: OLD_START, slotStart: NEW_START })
    // Owner is notified too (Google-originated move).
    expect(h.notifiedOwner).toHaveLength(2)
    expect(h.notifiedOwner[0]).toMatchObject({ kind: 'moved', origin: 'google', actorIsManager: false })
    // No block deletion on a move.
    expect(h.deletes).toHaveLength(0)
  })

  it('a move with NO bookings just patches the block time — no notifications', async () => {
    h.existingBlockLookup = [[classBlockRow()]]
    h.bookingsInSlot = []

    await reconcileOwnerEvent(ctx(), movedEvent(), 'push')

    expect(h.updates.find((u) => u.table === 'calendar_blocks')?.values['startTs']).toEqual(NEW_START)
    expect(h.updates.filter((u) => u.table === 'bookings')).toHaveLength(0)
    expect(h.notifiedCustomer).toHaveLength(0)
  })

  it('an opaque (non-class) block move just patches the time — never relocates bookings', async () => {
    h.existingBlockLookup = [[{ id: 'blk-opaque', type: 'block', serviceTypeId: null, startTs: OLD_START, endTs: OLD_END }]]
    h.bookingsInSlot = [seat('bk-1', 'cust-1')] // even if bookings somehow existed, an opaque block never moves them

    await reconcileOwnerEvent(ctx(), movedEvent(), 'push')

    expect(h.updates.filter((u) => u.table === 'bookings')).toHaveLength(0)
    expect(h.notifiedCustomer).toHaveLength(0)
    expect(lines[lines.length - 1]).toMatchObject({ decision: 'block_opaque' })
  })

  it('a booked-class move on the passive READ path is DEFERRED entirely — nothing mutated, no notify', async () => {
    h.existingBlockLookup = [[classBlockRow()]]
    h.bookingsInSlot = [seat('bk-1', 'cust-1')]

    await reconcileOwnerEvent(ctx(), movedEvent(), 'read')

    // Deferred to the notifying push/tick: the block is NOT patched on read (patching it while
    // leaving the seats behind would strand them — the later push would see no time change).
    expect(h.updates.find((u) => u.table === 'calendar_blocks')).toBeUndefined()
    // No customer notification and no booking relocation on a passive read.
    expect(h.notifiedCustomer).toHaveLength(0)
    expect(h.updates.filter((u) => u.table === 'bookings')).toHaveLength(0)
  })

  it('an UNBOOKED class move on the READ path still patches the block (no seats to strand)', async () => {
    h.existingBlockLookup = [[classBlockRow()]]
    h.bookingsInSlot = [] // no seats → safe to patch on read

    await reconcileOwnerEvent(ctx(), movedEvent(), 'read')

    expect(h.updates.find((u) => u.table === 'calendar_blocks')?.values['startTs']).toEqual(NEW_START)
    expect(h.notifiedCustomer).toHaveLength(0)
  })
})

// ── DELETE ──────────────────────────────────────────────────────────────────

describe('T1.4 DELETE — owner deletes an imported class / pending block', () => {
  it('pending / opaque block ⇒ clean removal (unchanged), no gate, no notify', async () => {
    h.existingBlockLookup = [[{ id: 'blk-opaque', type: 'block', serviceTypeId: null, startTs: OLD_START, endTs: OLD_END }]]

    await reconcileOwnerEvent(ctx(), cancelledEvent(), 'push')

    expect(h.deletes).toEqual(['calendar_blocks'])
    expect(h.notifiedCustomer).toHaveLength(0)
    expect(h.audits.some((a) => a.action === 'calendar.owner_deleted_block')).toBe(true)
  })

  it('materialized class with 0 bookings ⇒ clean removal, no gate', async () => {
    h.existingBlockLookup = [[classBlockRow()]]
    h.bookingsInSlot = []

    await reconcileOwnerEvent(ctx(), cancelledEvent(), 'push')

    expect(h.deletes).toEqual(['calendar_blocks'])
    expect(h.notifiedCustomer).toHaveLength(0)
  })

  it('class WITH bookings ≤ threshold ⇒ cancel each + notify + delete block + booking_cancelled telemetry', async () => {
    h.existingBlockLookup = [[classBlockRow()]]
    h.bookingsInSlot = [seat('bk-1', 'cust-1')] // 1 ≤ threshold(2)

    await reconcileOwnerEvent(ctx(), cancelledEvent(), 'push')

    // The booking is cancelled (owner-wins) ...
    const cancels = h.updates.filter((u) => u.table === 'bookings' && u.values['state'] === 'cancelled')
    expect(cancels).toHaveLength(1)
    // ... the customer is notified ...
    expect(h.notifiedCustomer[0]).toMatchObject({ kind: 'cancelled' })
    // ... the (now empty) class block is removed ...
    expect(h.deletes).toContain('calendar_blocks')
    // ... and telemetry records the applied cancellation.
    expect(lines.some((l) => l['decision'] === 'booking_cancelled')).toBe(true)
  })

  it('class WITH bookings > threshold ⇒ blast-radius gate asks the manager, cancels NOTHING, keeps the block', async () => {
    h.existingBlockLookup = [[classBlockRow()]]
    h.bookingsInSlot = [seat('bk-1', 'cust-1'), seat('bk-2', 'cust-2'), seat('bk-3', 'cust-3')] // 3 > threshold(2)

    await reconcileOwnerEvent(ctx(), cancelledEvent(), 'push')

    // Nothing cancelled, nobody notified of a cancellation.
    expect(h.updates.filter((u) => u.table === 'bookings' && u.values['state'] === 'cancelled')).toHaveLength(0)
    expect(h.notifiedCustomer).toHaveLength(0)
    // The block is NOT deleted — kept occupied so the seats aren't orphaned while the manager decides.
    expect(h.deletes).not.toContain('calendar_blocks')
    // The manager is asked (gate message enqueued) and it's audited.
    expect(h.enqueued.length).toBeGreaterThanOrEqual(1)
    expect(h.audits.some((a) => a.action === 'calendar.owner_reconcile_gated')).toBe(true)
    // No false booking_cancelled telemetry for a gated (unapplied) cancellation.
    expect(lines.some((l) => l['decision'] === 'booking_cancelled')).toBe(false)
  })
})

// ── READ-path diff-delete guard ───────────────────────────────────────────────

describe('T1.4 reconcileScheduleWindowOnRead diff-delete — never orphan a booked class', () => {
  function seedConnected() {
    h.businessRow = { id: 'biz-1', calendarMode: 'google', googleRefreshToken: 'rt', googleCalendarId: 'cal-1', defaultLanguage: 'en' }
    h.identityRow = { phoneNumber: '+972500000001' }
  }

  it('a booked class absent from Google is NOT diff-deleted on a passive read (skipped + audited)', async () => {
    seedConnected()
    // Google returns one still-present owner event; the booked class (g-class) is absent.
    h.incrementalResult = {
      status: 'ok', nextSyncToken: null,
      events: [{ eventId: 'g-present', status: 'confirmed', summary: 'x', start: OLD_START, end: OLD_END, etag: 'e', paManaged: false, paType: null, paId: null }],
    }
    // reconcileOwnerEvent(g-present) existing lookup → update path (opaque).
    h.existingBlockLookup = [[{ id: 'blk-present', type: 'block', serviceTypeId: null, startTs: OLD_START, endTs: OLD_END }]]
    // Window holds: the present opaque block AND a booked class whose Google event vanished.
    h.blocksInWindow = [
      { id: 'blk-present', googleEventId: 'g-present', type: 'block', serviceTypeId: null, startTs: OLD_START },
      { id: 'blk-class', googleEventId: 'g-class', type: 'class', serviceTypeId: 'svc-pilates', startTs: OLD_START },
    ]
    // The booked class has 1 live booking → must NOT be silently deleted on read.
    h.bookingsInSlot = [seat('bk-1', 'cust-1')]

    const res = await reconcileScheduleWindowOnRead('biz-1', { from: OLD_START, to: NEW_END })

    expect(res.ok).toBe(true)
    // The booked class was NOT deleted; no customer notified from a passive read.
    expect(h.deletes).toHaveLength(0)
    expect(h.notifiedCustomer).toHaveLength(0)
    // The deferral is observable.
    expect(h.audits.some((a) => a.action === 'calendar.reconcile_booked_class_delete_deferred')).toBe(true)
  })

  it('an unbooked block absent from Google is still diff-deleted (today\'s behavior preserved)', async () => {
    seedConnected()
    h.incrementalResult = {
      status: 'ok', nextSyncToken: null,
      events: [{ eventId: 'g-present', status: 'confirmed', summary: 'x', start: OLD_START, end: OLD_END, etag: 'e', paManaged: false, paType: null, paId: null }],
    }
    h.existingBlockLookup = [[{ id: 'blk-present', type: 'block', serviceTypeId: null, startTs: OLD_START, endTs: OLD_END }]]
    h.blocksInWindow = [
      { id: 'blk-present', googleEventId: 'g-present', type: 'block', serviceTypeId: null, startTs: OLD_START },
      { id: 'blk-gone', googleEventId: 'g-gone', type: 'block', serviceTypeId: null, startTs: OLD_START }, // absent → delete
    ]

    const res = await reconcileScheduleWindowOnRead('biz-1', { from: OLD_START, to: NEW_END })

    expect(res.ok).toBe(true)
    expect(h.deletes).toEqual(['calendar_blocks'])
    expect(h.audits.find((a) => a.action === 'calendar.owner_deleted_block')?.entityId).toBe('blk-gone')
  })
})
