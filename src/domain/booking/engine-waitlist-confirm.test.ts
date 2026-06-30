/**
 * WL-7 — Accept = confirm the held GROUP waitlist seat (engine extension).
 *
 * Proves `confirmBooking` is group-aware: a `held` GROUP-class booking placed by WL-5
 * (state='held', holdExpiresAt set, calendarEventId=null) can be confirmed on accept.
 *
 *   1. Confirm a held GROUP seat → ok:true, row flips to `confirmed`, a calendarEventId is
 *      now attached (shared class event found/created), roster refresh invoked. NO
 *      "Booking has no calendar event" bail.
 *   2. Group confirm is idempotent under race: a second confirm where the row is ALREADY
 *      `confirmed` (0-row CAS) → ok:true, no duplicate side-effects.
 *   3. Group confirm after expiry loses: the row is `expired` (not held) → ok:false.
 *   4. Regression: a 1-on-1 (private) held booking still confirms via the existing path
 *      (calendarEventId required, single hold confirmed) — byte-identical behavior.
 *
 * Harness mirrors engine-waitlist-hold.test.ts: heavy collaborators mocked; the db is a
 * hand-rolled mock over an in-memory store. The update mock is CAS-aware — it honors a
 * `state='held'` predicate and targets the row whose id appears in the predicate, so the
 * "already confirmed → 0 rows" and "expired → 0 rows" loser paths are REAL, not stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Collaborator mocks (declared before imports; hoisted) ─────────────────────

vi.mock('../provider/resolver.js', () => ({
  resolveProvider: vi.fn(async () => null),
}))
vi.mock('../provider/roster.js', () => ({
  getInstructorHours: vi.fn(async () => null),
}))
vi.mock('../availability/blocks.js', () => ({
  findClassBlockProviderForSlot: vi.fn(async () => ({ found: true, providerId: null, maxParticipants: 2 })),
}))
vi.mock('../availability/service.js', () => ({
  isSlotBookable: vi.fn(async () => ({ bookable: true, reason: 'ok' })),
}))
vi.mock('../waitlist/freed-slot.js', () => ({ handleFreedSlot: vi.fn(async () => {}) }))
vi.mock('../customer/profile.js', () => ({ recordCompletedBooking: vi.fn(async () => {}) }))
vi.mock('../../workers/reminder.js', () => ({
  scheduleReminders: vi.fn(async () => {}),
  cancelReminders: vi.fn(async () => {}),
}))

const refreshGroupEventRoster = vi.fn(async () => {})
vi.mock('../calendar/booking-event.js', () => ({
  buildOneOnOneEventContent: vi.fn(async () => null),
  refreshGroupEventRoster: (...a: unknown[]) => refreshGroupEventRoster(...(a as [])),
}))
vi.mock('../../workers/message-retry.js', () => ({ enqueueMessage: vi.fn(async () => {}) }))
vi.mock('../../adapters/llm/client.js', () => ({ generateProactiveCustomerMessage: vi.fn(async () => 'msg') }))

const notifyOwnerNewBooking = vi.fn(async () => {})
const notifyOwnerApprovalRequest = vi.fn(async () => {})
vi.mock('../initiations/booking-notify.js', () => ({
  notifyOwnerNewBooking: (...a: unknown[]) => notifyOwnerNewBooking(...(a as [])),
  notifyOwnerApprovalRequest: (...a: unknown[]) => notifyOwnerApprovalRequest(...(a as [])),
  notifyBusinessBookingChange: vi.fn(async () => {}),
  notifyOwnerBookingChange: vi.fn(async () => {}),
}))

vi.mock('../audit/logger.js', () => ({ logAudit: vi.fn(async () => {}) }))
vi.mock('./audit-meta.js', () => ({
  buildBookingAuditMeta: vi.fn(async () => ({})),
  initiatorFromActor: vi.fn(() => 'customer_self'),
}))

// ── In-memory bookings store + db mock ────────────────────────────────────────

interface Row { [k: string]: unknown }
const store: Row[] = []
let idSeq = 0
const customerValueParams = ['c0', 'c1', 'c2']

const SERVICE_GROUP = {
  id: 'svc-class', name: 'Pilates', durationMinutes: 60, maxParticipants: 2, paymentAmount: null,
  isActive: true, businessId: 'biz-1', requiresOwnerApproval: false, schedulingMode: 'class',
}
const SERVICE_PRIVATE = {
  id: 'svc-1on1', name: 'Haircut', durationMinutes: 30, maxParticipants: 1, paymentAmount: null,
  isActive: true, businessId: 'biz-1', requiresOwnerApproval: false, schedulingMode: 'appointment',
}
const BUSINESS = {
  id: 'biz-1', name: 'Test', timezone: 'UTC', minBookingBufferMinutes: 0, maxBookingDaysAhead: 365,
  confirmationGate: 'immediate', paymentMethod: null, calendarMode: 'internal', bookingApprovalWindowHours: 24,
}

let activeService: Row = SERVICE_GROUP
// One-shot: when set to a booking id, the NEXT up-front id read returns a `held` snapshot
// even though the real store row is `confirmed` — to deterministically drive the CAS-loser
// (idempotent) path. Cleared after it fires once.
let raceHeldSnapshotFor: string | null = null

function makeDb(): Record<string, unknown> {
  function select(this: unknown, cols?: Record<string, unknown>) {
    const state: { table?: string; isCount: boolean } = { isCount: false }
    if (cols && Object.prototype.hasOwnProperty.call(cols, 'total')) state.isCount = true
    const chain: Record<string, unknown> = {}
    chain['from'] = (tbl: { _tableName?: string } | unknown) => {
      state.table = tableName(tbl)
      return chain
    }
    for (const m of ['leftJoin', 'innerJoin', 'orderBy']) chain[m] = () => chain
    chain['where'] = (pred: unknown) => { (state as Row)['predStr'] = serializePred(pred); return chain }
    chain['for'] = () => chain
    chain['limit'] = async () => resolve(state)
    chain['then'] = (res: (v: unknown) => unknown) => res(resolve(state))
    return chain
  }
  return {
    select,
    insert: (tbl: unknown) => ({
      values: (vals: Row) => ({
        returning: async () => {
          if (tableName(tbl) === 'bookings') {
            const row: Row = { id: `bk-${++idSeq}`, ...vals }
            store.push(row)
            return [row]
          }
          return [{ id: `row-${++idSeq}`, ...vals }]
        },
      }),
    }),
    // CAS-aware update: the predicate string is captured so .returning() can honor a
    // `state='held'` requirement and target the row whose id is embedded in the predicate.
    update: () => ({
      set: (vals: Row) => ({
        where: (pred: unknown) => {
          const predStr = serializePred(pred)
          return {
            returning: async () => applyUpdate(vals, predStr),
            then: (res: (v: unknown) => unknown) => { applyUpdate(vals, predStr); return res(undefined) },
          }
        },
      }),
    }),
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(makeTx()),
  }
}

// last booking id targeted by an update — captured from the most recent insert/returning.
let lastBookingId: string | null = null

// A drizzle-serialized predicate embeds each BOUND param value as `{"value":"X"}`
// (distinct from column metadata like enumValues, which lists every state literal). So
// `{"value":"held"}` proves a `state='held'` filter; `{"value":"bk-7"}` proves an id filter.
function boundsValue(predStr: string, v: string): boolean {
  return predStr.includes(`{"value":"${v}"}`)
}
function boundBookingId(predStr: string): string | null {
  const m = /\{"value":"(bk-[^"]+)"\}/.exec(predStr)
  return m?.[1] ?? null
}

// Apply an update honoring the captured predicate.
//  - If the predicate binds a concrete booking id (bk-N), target that row.
//  - Else fall back to lastBookingId (group-tail post-insert update path).
//  - If the predicate requires state='held' (the CAS arbiter), only flip a row that is
//    CURRENTLY 'held'; a non-held row returns 0 rows (the loser path).
function applyUpdate(vals: Row, predStr: string): Row[] {
  const targetId = boundBookingId(predStr) ?? lastBookingId
  if (!targetId) return []
  const row = store.find((r) => r['id'] === targetId)
  if (!row) return []
  const requiresHeld = boundsValue(predStr, 'held')
  if (requiresHeld && row['state'] !== 'held') return []
  Object.assign(row, vals)
  return [{ id: row['id'] }]
}

function makeTx(): Record<string, unknown> {
  const tx = makeDb()
  tx['execute'] = async () => [] // pg_advisory_xact_lock — no-op
  const origInsert = tx['insert'] as (t: unknown) => { values: (v: Row) => { returning: () => Promise<Row[]> } }
  tx['insert'] = (t: unknown) => ({
    values: (vals: Row) => ({
      returning: async () => {
        const rows = await origInsert(t).values(vals).returning()
        if (tableName(t) === 'bookings' && rows[0]) lastBookingId = rows[0]['id'] as string
        return rows
      },
    }),
  })
  return tx
}

function tableName(tbl: unknown): string {
  if (tbl === bookingsTbl) return 'bookings'
  if (tbl === serviceTypesTbl) return 'serviceTypes'
  if (tbl === businessesTbl) return 'businesses'
  if (tbl === identitiesTbl) return 'identities'
  return 'unknown'
}

function serializePred(pred: unknown): string {
  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(pred, (_k, v) => {
      if (typeof v === 'bigint') return String(v)
      if (typeof v === 'object' && v) { if (seen.has(v)) return undefined; seen.add(v) }
      return v
    }) ?? ''
  } catch {
    return ''
  }
}

function resolve(state: { table?: string; isCount: boolean; predStr?: string }): Row[] {
  if (state.table === 'serviceTypes') return [activeService]
  if (state.table === 'businesses') return [BUSINESS]
  if (state.table === 'identities') return []
  if (state.table === 'bookings') {
    const blob = state.predStr ?? ''
    // Group existing-participant lookup: confirmed rows with a calendarEventId set (binds
    // state='confirmed'). The up-front confirm read binds only the id (no state filter).
    const filtersConfirmedEvent = boundsValue(blob, 'confirmed')
    const idBound = boundBookingId(blob)
    // A direct id lookup (confirmBooking's up-front read keys on the booking id) — return
    // that exact row regardless of state so the guards can inspect it.
    if (idBound && !filtersConfirmedEvent) {
      const row = store.find((r) => r['id'] === idBound)
      // Race injection: present a one-shot `held` snapshot to the up-front read while the
      // real store row is already `confirmed`, so the CAS (which reads the real row) returns
      // 0 rows — exercising the idempotent loser path deterministically.
      if (row && raceHeldSnapshotFor === idBound) {
        raceHeldSnapshotFor = null
        return [{ ...row, state: 'held' }]
      }
      return row ? [row] : []
    }
    let active = store.filter(
      (r) => ['requested', 'confirmed', 'pending_payment', 'held'].includes(r['state'] as string),
    )
    const scopedCustomer = customerValueParams.find((cid) => boundsValue(blob, cid))
    if (scopedCustomer) {
      active = active.filter((r) => r['customerId'] === scopedCustomer)
    }
    // Group existing-participant lookup: confirmed rows with a calendarEventId set, excluding
    // this booking (binds ne(id, …)). Return another participant's shared event.
    if (filtersConfirmedEvent) {
      active = active.filter((r) => r['state'] === 'confirmed' && r['calendarEventId'] && r['id'] !== idBound)
    }
    if (state.isCount) return [{ total: active.length }]
    return active
  }
  return []
}

vi.mock('../../db/client.js', () => ({ db: makeDb() }))

// ── Import module under test + schema refs AFTER mocks ────────────────────────
import { requestBooking, confirmBooking } from './engine.js'
import { db as dbInstance } from '../../db/client.js'
import { bookings as _bookings, serviceTypes as _serviceTypes, businesses as _businesses, identities as _identities } from '../../db/schema.js'
const bookingsTbl: unknown = _bookings
const serviceTypesTbl: unknown = _serviceTypes
const businessesTbl: unknown = _businesses
const identitiesTbl: unknown = _identities

const calendar = {
  checkAvailability: async () => ({ status: 'free' as const }),
  placeHold: async (_slot: unknown, bookingId: string) => ({ status: 'held' as const, eventId: `internal:${bookingId}`, etag: null }),
  confirmHold: async (eventId: string) => ({ status: 'confirmed' as const, eventId, etag: null }),
  deleteEvent: async () => ({ status: 'deleted' as const }),
} as unknown as Parameters<typeof requestBooking>[1]

const SLOT_START = new Date(Date.now() + 60 * 60 * 1000)
const SLOT_END = new Date(SLOT_START.getTime() + 60 * 60 * 1000)

function customer(id: string): Parameters<typeof requestBooking>[2] {
  return {
    id, businessId: 'biz-1', phoneNumber: `+9725${id}`, role: 'customer',
    displayName: id, messagingOptOut: false, preferredLanguage: 'en', conversationPausedUntil: null,
  }
}

type DbArg = Parameters<typeof confirmBooking>[0]
type CalArg = Parameters<typeof confirmBooking>[1]

describe('WL-7 — confirmBooking is group-aware (held group seat → confirmed)', () => {
  beforeEach(() => {
    store.length = 0
    idSeq = 0
    lastBookingId = null
    raceHeldSnapshotFor = null
    notifyOwnerNewBooking.mockClear()
    notifyOwnerApprovalRequest.mockClear()
    refreshGroupEventRoster.mockClear()
  })

  it('confirms a held GROUP seat: state→confirmed, calendarEventId attached, roster refreshed', async () => {
    activeService = SERVICE_GROUP
    const holdExpiresAt = new Date(Date.now() + 15 * 60 * 1000)
    // Place the group waitlist hold via the engine (held row, calendarEventId null).
    const held = await requestBooking(dbInstance as unknown as Parameters<typeof requestBooking>[0], calendar, customer('c1'),
      { serviceTypeId: 'svc-class', slotStart: SLOT_START, slotEnd: SLOT_END },
      { waitlistHold: { holdExpiresAt } })
    expect(held.ok && held.held).toBe(true)
    const heldRow = store.find((r) => r['customerId'] === 'c1')!
    expect(heldRow['state']).toBe('held')
    expect(heldRow['calendarEventId']).toBeFalsy()

    // Now ACCEPT — confirm the held group seat.
    const res = await confirmBooking(
      dbInstance as unknown as DbArg, calendar as unknown as CalArg,
      customer('c1'), heldRow['id'] as string, 'c1',
    )

    expect(res.ok).toBe(true) // NOT the "Booking has no calendar event" bail (group seat has none yet)
    expect(heldRow['state']).toBe('confirmed')
    expect(heldRow['calendarEventId']).toBeTruthy()
    expect(refreshGroupEventRoster).toHaveBeenCalledTimes(1)
  })

  it('reuses an existing shared class event from another confirmed participant', async () => {
    activeService = SERVICE_GROUP
    // Another participant already confirmed with a shared event.
    store.push({
      id: 'bk-existing', businessId: 'biz-1', serviceTypeId: 'svc-class', customerId: 'c0',
      slotStart: SLOT_START, slotEnd: SLOT_END, state: 'confirmed', calendarEventId: 'shared-evt-1',
    })
    const holdExpiresAt = new Date(Date.now() + 15 * 60 * 1000)
    const held = await requestBooking(dbInstance as unknown as Parameters<typeof requestBooking>[0], calendar, customer('c1'),
      { serviceTypeId: 'svc-class', slotStart: SLOT_START, slotEnd: SLOT_END },
      { waitlistHold: { holdExpiresAt } })
    expect(held.ok && held.held).toBe(true)
    const heldRow = store.find((r) => r['customerId'] === 'c1')!

    const res = await confirmBooking(
      dbInstance as unknown as DbArg, calendar as unknown as CalArg,
      customer('c1'), heldRow['id'] as string, 'c1',
    )
    expect(res.ok).toBe(true)
    expect(heldRow['state']).toBe('confirmed')
    expect(heldRow['calendarEventId']).toBe('shared-evt-1')
  })

  it('group confirm is idempotent under race: already-confirmed row → ok:true, no duplicate side-effects', async () => {
    activeService = SERVICE_GROUP
    const holdExpiresAt = new Date(Date.now() + 15 * 60 * 1000)
    await requestBooking(dbInstance as unknown as Parameters<typeof requestBooking>[0], calendar, customer('c1'),
      { serviceTypeId: 'svc-class', slotStart: SLOT_START, slotEnd: SLOT_END },
      { waitlistHold: { holdExpiresAt } })
    const heldRow = store.find((r) => r['customerId'] === 'c1')!

    // First confirm wins.
    const first = await confirmBooking(
      dbInstance as unknown as DbArg, calendar as unknown as CalArg,
      customer('c1'), heldRow['id'] as string, 'c1',
    )
    expect(first.ok).toBe(true)
    expect(heldRow['state']).toBe('confirmed')
    refreshGroupEventRoster.mockClear()
    notifyOwnerNewBooking.mockClear()

    // Second confirm loses the race: the up-front read is fed a one-shot `held` snapshot (so it
    // passes the state guard) while the real row is already `confirmed` — the CAS `WHERE state='held'`
    // returns 0 rows, the re-read says `confirmed`, so it returns idempotent ok:true with NO side-effects.
    raceHeldSnapshotFor = heldRow['id'] as string
    const second = await confirmBooking(
      dbInstance as unknown as DbArg, calendar as unknown as CalArg,
      customer('c1'), heldRow['id'] as string, 'c1',
    )
    expect(second.ok).toBe(true)
    // No duplicate side-effects on the idempotent loser path.
    expect(refreshGroupEventRoster).not.toHaveBeenCalled()
    expect(notifyOwnerNewBooking).not.toHaveBeenCalled()
  })

  it('group confirm after expiry loses: expired row → ok:false', async () => {
    activeService = SERVICE_GROUP
    const holdExpiresAt = new Date(Date.now() + 15 * 60 * 1000)
    await requestBooking(dbInstance as unknown as Parameters<typeof requestBooking>[0], calendar, customer('c1'),
      { serviceTypeId: 'svc-class', slotStart: SLOT_START, slotEnd: SLOT_END },
      { waitlistHold: { holdExpiresAt } })
    const heldRow = store.find((r) => r['customerId'] === 'c1')!
    // The expiry releaser already flipped this hold to expired.
    heldRow['state'] = 'expired'

    const res = await confirmBooking(
      dbInstance as unknown as DbArg, calendar as unknown as CalArg,
      customer('c1'), heldRow['id'] as string, 'c1',
    )
    expect(res.ok).toBe(false)
  })

  it('regression: a 1-on-1 (private) held booking still confirms via the existing path', async () => {
    activeService = SERVICE_PRIVATE
    // Place an ordinary private hold (interactive, CONFIRM) — produces a held row WITH a
    // calendarEventId (placeHold attaches one in the private path).
    const res = await requestBooking(dbInstance as unknown as Parameters<typeof requestBooking>[0], calendar, customer('c1'),
      { serviceTypeId: 'svc-1on1', slotStart: SLOT_START, slotEnd: SLOT_END })
    expect(res.ok && res.held).toBeFalsy() // private placeHold returns CONFIRM message, not .held
    const row = store.find((r) => r['customerId'] === 'c1')!
    expect(row['state']).toBe('held')
    expect(row['calendarEventId']).toBeTruthy()

    const confirmed = await confirmBooking(
      dbInstance as unknown as DbArg, calendar as unknown as CalArg,
      customer('c1'), row['id'] as string, 'c1',
    )
    expect(confirmed.ok).toBe(true)
    expect(row['state']).toBe('confirmed')
  })

  it('regression: a private held booking with NO calendar event still bails (existing guard preserved)', async () => {
    activeService = SERVICE_PRIVATE
    // Hand-place a private held row with calendarEventId null (an anomaly for the private path).
    store.push({
      id: 'bk-99', businessId: 'biz-1', serviceTypeId: 'svc-1on1', customerId: 'c1',
      slotStart: SLOT_START, slotEnd: SLOT_END, state: 'held', holdExpiresAt: new Date(Date.now() + 15 * 60 * 1000),
      calendarEventId: null,
    })
    const res = await confirmBooking(
      dbInstance as unknown as DbArg, calendar as unknown as CalArg,
      customer('c1'), 'bk-99', 'c1',
    )
    expect(res.ok).toBe(false)
    expect(!res.ok && res.reason).toMatch(/no calendar event/i)
  })
})
