/**
 * WL-5 — Genuine hold at offer time (engine extension).
 *
 * Proves the new opt-in `waitlistHold` directive on `requestBooking`:
 *   1. Group hold OCCUPIES a class seat — a subsequent walk-in is blocked ("Class is full").
 *   2. Group hold does NOT confirm and fires NO owner new-booking notice; the row is `held`
 *      with holdExpiresAt set and calendarEventId null.
 *   3. Private (1-on-1) hold reserves the slot (overlapping walk-in rejected) and fires NO
 *      owner approval request.
 *   4. Regression: with NO directive, an ordinary group booking still direct-confirms and an
 *      ordinary private booking still places the interactive hold — byte-identical behavior.
 *
 * Harness: heavy collaborators are mocked; the db is a hand-rolled mock that records inserted
 * booking rows in an in-memory store so the capacity COUNT and conflict SELECT see prior holds
 * (this is what lets the "walk-in blocked" assertion be real rather than stubbed). The advisory
 * lock execute() is a no-op. vi.mock is hoisted — factories reference no top-level mutable state.
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
vi.mock('../calendar/booking-event.js', () => ({
  buildOneOnOneEventContent: vi.fn(async () => null),
  refreshGroupEventRoster: vi.fn(async () => {}),
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
// The store is the SoT for capacity/conflict queries so prior holds are visible.

interface Row { [k: string]: unknown }
const store: Row[] = []
let idSeq = 0
// Concrete customerId VALUES the tests use. The duplicate guard scopes by a customerId param;
// we detect that param by matching one of these known values in the serialized predicate. (The
// column NAME "customer_id" is embedded in every predicate via table metadata, so name-matching
// would false-positive — value-matching is the reliable discriminator.)
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

// A faithful-enough drizzle-ish select chain over the in-memory store + fixtures.
function makeDb(): Record<string, unknown> {
  function select(this: unknown, cols?: Record<string, unknown>) {
    // Track which table this select targets so we can answer count vs row queries.
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
    update: () => ({
      set: (vals: Row) => ({
        where: () => {
          // Mutate the matching booking row(s) by id when the predicate carried one.
          return {
            returning: async () => {
              applyUpdate(vals)
              return [{ id: 'updated' }]
            },
            then: (res: (v: unknown) => unknown) => { applyUpdate(vals); return res(undefined) },
          }
        },
      }),
    }),
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(makeTx()),
  }
}

// last booking id targeted by an update — captured from the most recent insert/returning.
let lastBookingId: string | null = null
function applyUpdate(vals: Row) {
  if (!lastBookingId) return
  const row = store.find((r) => r['id'] === lastBookingId)
  if (row) Object.assign(row, vals)
}

function makeTx(): Record<string, unknown> {
  const tx = makeDb()
  tx['execute'] = async () => [] // pg_advisory_xact_lock — no-op
  // Wrap insert so we remember the new booking id for the post-tx update.
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
  // drizzle pgTable carries a Symbol-keyed name; fall back to identity comparison via fixtures.
  if (tbl === bookingsTbl) return 'bookings'
  if (tbl === serviceTypesTbl) return 'serviceTypes'
  if (tbl === businessesTbl) return 'businesses'
  if (tbl === identitiesTbl) return 'identities'
  return 'unknown'
}

// Stringify a drizzle predicate so the mock can detect a customerId filter (duplicate guard)
// vs a slot/state-only filter (capacity count + private conflict check). All param values land
// in the serialized blob, so a customer id appears verbatim when the guard filters by customer.
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
    let active = store.filter(
      (r) => ['requested', 'confirmed', 'pending_payment', 'held'].includes(r['state'] as string),
    )
    const blob = state.predStr ?? ''
    // Duplicate guard / existing-participant lookup filters by a customerId VALUE param.
    // (Note: the serialized predicate also embeds the table's column metadata, so the column
    //  NAME "customer_id" appears for EVERY bookings query — we must NOT key on that. We key on
    //  whether a concrete customerId VALUE from the store appears as a quoted param, which only
    //  happens when the query actually filters by customer.) When it does, scope to that
    //  customer so a DIFFERENT customer's seat is never mistaken for a duplicate.
    const scopedCustomer = customerValueParams.find((cid) => blob.includes(`"${cid}"`))
    if (scopedCustomer) {
      active = active.filter((r) => r['customerId'] === scopedCustomer)
    }
    if (state.isCount) return [{ total: active.length }]
    return active
  }
  return []
}

vi.mock('../../db/client.js', () => ({ db: makeDb() }))

// ── Import module under test + schema refs AFTER mocks ────────────────────────
import { requestBooking } from './engine.js'
import { db as dbInstance } from '../../db/client.js'
import { bookings as _bookings, serviceTypes as _serviceTypes, businesses as _businesses, identities as _identities } from '../../db/schema.js'
// Schema table refs used by tableName() for identity comparison. Assigned once at import; the
// helpers that read them (tableName) only run during tests, well after this binding.
const bookingsTbl: unknown = _bookings
const serviceTypesTbl: unknown = _serviceTypes
const businessesTbl: unknown = _businesses
const identitiesTbl: unknown = _identities

// Minimal internal-mode calendar client.
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

describe('WL-5 — waitlistHold engine directive', () => {
  beforeEach(() => {
    store.length = 0
    idSeq = 0
    lastBookingId = null
    notifyOwnerNewBooking.mockClear()
    notifyOwnerApprovalRequest.mockClear()
  })

  it('group hold occupies a seat and blocks a subsequent walk-in', async () => {
    activeService = SERVICE_GROUP
    // Pre-seed capacity-1 occupancy: one confirmed booking already in the class (cap=2).
    store.push({ id: 'bk-existing', businessId: 'biz-1', serviceTypeId: 'svc-class', customerId: 'c0', slotStart: SLOT_START, slotEnd: SLOT_END, state: 'confirmed' })

    const holdExpiresAt = new Date(Date.now() + 15 * 60 * 1000)
    const held = await requestBooking(dbInstance as unknown as Parameters<typeof requestBooking>[0], calendar, customer('c1'),
      { serviceTypeId: 'svc-class', slotStart: SLOT_START, slotEnd: SLOT_END },
      { waitlistHold: { holdExpiresAt } })

    expect(held.ok).toBe(true)
    expect(held.ok && held.held).toBe(true)
    const heldRow = store.find((r) => r['customerId'] === 'c1')
    expect(heldRow?.['state']).toBe('held')
    expect(heldRow?.['holdExpiresAt']).toEqual(holdExpiresAt)
    expect(heldRow?.['calendarEventId']).toBeFalsy()

    // Walk-in now hits 2/2 (existing confirmed + the held seat) → blocked.
    const walkIn = await requestBooking(dbInstance as unknown as Parameters<typeof requestBooking>[0], calendar, customer('c2'),
      { serviceTypeId: 'svc-class', slotStart: SLOT_START, slotEnd: SLOT_END })
    expect(walkIn.ok).toBe(false)
    expect(!walkIn.ok && walkIn.reason).toMatch(/full/i)
  })

  it('group hold does not confirm and fires no owner new-booking notice', async () => {
    activeService = SERVICE_GROUP
    const holdExpiresAt = new Date(Date.now() + 15 * 60 * 1000)
    const held = await requestBooking(dbInstance as unknown as Parameters<typeof requestBooking>[0], calendar, customer('c1'),
      { serviceTypeId: 'svc-class', slotStart: SLOT_START, slotEnd: SLOT_END },
      { waitlistHold: { holdExpiresAt } })

    expect(held.ok && held.held).toBe(true)
    expect(held.ok && held.directlyConfirmed).toBeFalsy()
    const row = store.find((r) => r['customerId'] === 'c1')
    expect(row?.['state']).toBe('held')
    expect(row?.['calendarEventId']).toBeFalsy()
    expect(notifyOwnerNewBooking).not.toHaveBeenCalled()
  })

  it('private hold reserves the slot, blocks an overlapping walk-in, fires no approval request', async () => {
    activeService = SERVICE_PRIVATE
    const holdExpiresAt = new Date(Date.now() + 15 * 60 * 1000)
    const held = await requestBooking(dbInstance as unknown as Parameters<typeof requestBooking>[0], calendar, customer('c1'),
      { serviceTypeId: 'svc-1on1', slotStart: SLOT_START, slotEnd: SLOT_END },
      { waitlistHold: { holdExpiresAt } })

    expect(held.ok).toBe(true)
    expect(held.ok && held.held).toBe(true)
    const row = store.find((r) => r['customerId'] === 'c1')
    expect(row?.['state']).toBe('held')
    expect(row?.['holdExpiresAt']).toEqual(holdExpiresAt)
    expect(notifyOwnerApprovalRequest).not.toHaveBeenCalled()

    // Concurrent ordinary booking for the same slot sees the held conflict → rejected.
    const walkIn = await requestBooking(dbInstance as unknown as Parameters<typeof requestBooking>[0], calendar, customer('c2'),
      { serviceTypeId: 'svc-1on1', slotStart: SLOT_START, slotEnd: SLOT_END })
    expect(walkIn.ok).toBe(false)
  })

  it('regression: no directive → ordinary group booking still direct-confirms', async () => {
    activeService = SERVICE_GROUP
    const res = await requestBooking(dbInstance as unknown as Parameters<typeof requestBooking>[0], calendar, customer('c1'),
      { serviceTypeId: 'svc-class', slotStart: SLOT_START, slotEnd: SLOT_END })
    expect(res.ok).toBe(true)
    expect(res.ok && res.directlyConfirmed).toBe(true)
    const row = store.find((r) => r['customerId'] === 'c1')
    expect(row?.['state']).toBe('confirmed')
  })

  it('regression: no directive → ordinary private booking places an interactive hold (CONFIRM)', async () => {
    activeService = SERVICE_PRIVATE
    const res = await requestBooking(dbInstance as unknown as Parameters<typeof requestBooking>[0], calendar, customer('c1'),
      { serviceTypeId: 'svc-1on1', slotStart: SLOT_START, slotEnd: SLOT_END })
    expect(res.ok).toBe(true)
    expect(res.ok && res.held).toBeFalsy()
    expect(res.ok && res.message).toMatch(/CONFIRM/i)
    const row = store.find((r) => r['customerId'] === 'c1')
    expect(row?.['state']).toBe('held')
  })
})
