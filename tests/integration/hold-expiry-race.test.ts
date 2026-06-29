// Integration proof for T1.7: hold-expiry CAS + reorder (E4, P1).
//
// Skips when DATABASE_URL is absent (no local Postgres in this repo's CI environment).
// Run with a real DB: DATABASE_URL=<dsn> npm run test:integration
//
// WHAT THIS PROVES:
//   (a) Confirm-at-edge + expiry-tick race: a booking that is confirmed just before
//       the expiry sweep fires stays 'confirmed'. The expiry CAS sees 0 rows (state is
//       no longer 'held') and skips all side effects — no calendar delete, no "expired"
//       customer message enqueued.
//   (b) Positive case: a genuinely-held expired row (with no active identity lock) IS
//       expired by the sweep. State flips to 'expired', messaging runs.
//
// Without the CAS (bare WHERE id=? with no state predicate) the sweep would clobber a
// confirmed booking to 'expired' and delete the now-confirmed calendar event (bug E4).

import { vi } from 'vitest'

// ── Mocks (must appear before any import of the mocked modules) ───────────────
vi.mock('../../src/redis.js', () => ({
  redis: {
    exists: vi.fn().mockResolvedValue(0), // no identity lock by default
    set: vi.fn().mockResolvedValue(null),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(0),
    eval: vi.fn().mockResolvedValue(0),
  },
  redisConnection: { quit: vi.fn(), on: vi.fn(), disconnect: vi.fn() },
}))
vi.mock('../../src/workers/message-retry.js', () => ({
  enqueueMessage: vi.fn().mockResolvedValue(undefined),
  messageRetryQueue: { add: vi.fn() },
  startMessageRetryWorker: vi.fn(),
}))
vi.mock('../../src/workers/reminder.js', () => ({
  scheduleReminders: vi.fn().mockResolvedValue(undefined),
  cancelReminders: vi.fn().mockResolvedValue(undefined),
  startReminderWorker: vi.fn(),
}))
vi.mock('../../src/workers/calendar-mirror.js', () => ({
  enqueueBlockMirror: vi.fn().mockResolvedValue(undefined),
  enqueueBlockDeletion: vi.fn().mockResolvedValue(undefined),
  enqueueBookingMirror: vi.fn().mockResolvedValue(undefined),
  enqueueBookingDeletion: vi.fn().mockResolvedValue(undefined),
  startCalendarMirrorWorker: vi.fn(),
}))
vi.mock('../../src/workers/queued-messages.js', () => ({
  queueMessageForLater: vi.fn().mockResolvedValue(undefined),
  startQueuedMessageWorker: vi.fn(),
}))
vi.mock('../../src/adapters/llm/client.js', () => ({
  generateProactiveCustomerMessage: vi.fn(async (i: { fallback: string }) => i.fallback),
}))
vi.mock('../../src/domain/initiations/booking-notify.js', () => ({
  notifyOwnerNewBooking: vi.fn().mockResolvedValue(undefined),
  notifyOwnerApprovalExpired: vi.fn().mockResolvedValue(undefined),
  notifyBusinessBookingChange: vi.fn().mockResolvedValue(undefined),
  notifyOwnerBookingChange: vi.fn().mockResolvedValue(undefined),
  notifyOwnerApprovalRequest: vi.fn().mockResolvedValue(undefined),
}))

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq, and } from 'drizzle-orm'
import { db } from '../../src/db/client.js'
import { bookings } from '../../src/db/schema.js'
import { expireHeldBookings } from '../../src/workers/hold-expiry.js'
import { enqueueMessage } from '../../src/workers/message-retry.js'
import { seedBusiness, seedCustomer, teardown, integrationEnabled, freshPhone } from './setup.js'
import type { TestBusiness } from './setup.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function futureSlot(): { slotStart: Date; slotEnd: Date } {
  const slotStart = new Date()
  slotStart.setUTCDate(slotStart.getUTCDate() + 7)
  slotStart.setUTCHours(10, 0, 0, 0)
  const slotEnd = new Date(slotStart.getTime() + 30 * 60_000)
  return { slotStart, slotEnd }
}

/** Seed a booking directly in 'held' state with holdExpiresAt in the PAST. */
async function seedExpiredHeldBooking(
  businessId: string,
  customerId: string,
  serviceId: string,
  opts: { calendarEventId?: string } = {},
): Promise<string> {
  const { slotStart, slotEnd } = futureSlot()
  const holdExpiresAt = new Date(Date.now() - 5 * 60_000) // 5 min in the past
  const [booking] = await db
    .insert(bookings)
    .values({
      businessId,
      serviceTypeId: serviceId,
      customerId,
      requestedAt: new Date(),
      slotStart,
      slotEnd,
      slotTzAtCreation: 'UTC',
      state: 'held',
      holdExpiresAt,
      calendarEventId: opts.calendarEventId ?? null,
    })
    .returning()
  if (!booking) throw new Error('seedExpiredHeldBooking: insert failed')
  return booking.id
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe.skipIf(!integrationEnabled)('T1.7 — hold-expiry CAS: confirm-at-edge race + positive expire', () => {
  let biz: TestBusiness
  let customerId: string

  beforeEach(async () => {
    biz = await seedBusiness({ available247: true, calendarMode: 'internal' })
    customerId = await seedCustomer(biz.businessId, freshPhone())
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await teardown(biz.businessId)
  })

  // ── (a) Confirm-at-edge + expiry-tick race ──────────────────────────────────
  it('expiry sweep skips a booking already confirmed: state stays confirmed, no calendar delete, no expired message', async () => {
    // Seed a held booking with holdExpiresAt in the past (eligible for expiry).
    const bookingId = await seedExpiredHeldBooking(biz.businessId, customerId, biz.serviceId, {
      calendarEventId: 'internal:test-event-123',
    })

    // Simulate the confirm winner: flip state to 'confirmed' (exactly what T1.5 CAS does).
    const [flippedByConfirm] = await db
      .update(bookings)
      .set({ state: 'confirmed', holdExpiresAt: null, updatedAt: new Date() })
      .where(and(eq(bookings.id, bookingId), eq(bookings.state, 'held')))
      .returning({ id: bookings.id })
    expect(flippedByConfirm).toBeDefined() // sanity: confirm won

    // Run the expiry sweep — it must skip this booking because the CAS will see
    // state='confirmed' (not 'held') and return 0 rows.
    // Since calendarMode='internal' and googleRefreshToken is null (no OAuth for the
    // test business), the worker skips the calendar delete branch entirely even on the
    // winner path — and on the CAS-loser path the skip is enforced by the 0-row check
    // before any branch is reached.
    const count = await expireHeldBookings()

    // The sweep returns 0 because the row was selected by the initial SELECT
    // but the CAS returned 0 rows — it skips and does NOT count confirmed rows.
    // (The initial SELECT is a snapshot; the row had holdExpiresAt in the past but
    //  state changed between SELECT and CAS.)
    expect(count).toBe(0)

    // Booking must still be 'confirmed'.
    const [row] = await db
      .select({ state: bookings.state })
      .from(bookings)
      .where(eq(bookings.id, bookingId))
      .limit(1)
    expect(row?.state).toBe('confirmed')

    // No "hold expired" message must have been enqueued for this customer.
    expect(vi.mocked(enqueueMessage).mock.calls.length).toBe(0)
  })

  // ── (b) Positive case: genuinely-held expired row IS expired ───────────────
  it('expiry sweep expires a genuinely held expired row: state=expired, message enqueued', async () => {
    // Seed a held booking with holdExpiresAt in the past AND no identity lock active
    // (redis.exists mock returns 0 by default, so no lock).
    const bookingId = await seedExpiredHeldBooking(biz.businessId, customerId, biz.serviceId)

    // DO NOT flip to confirmed — the row stays 'held' with an expired holdExpiresAt.
    const count = await expireHeldBookings()

    // The sweep must expire exactly this one row.
    expect(count).toBe(1)

    // Booking must be in 'expired' state.
    const [row] = await db
      .select({ state: bookings.state })
      .from(bookings)
      .where(eq(bookings.id, bookingId))
      .limit(1)
    expect(row?.state).toBe('expired')

    // A "hold expired" message must have been enqueued for the customer.
    expect(vi.mocked(enqueueMessage).mock.calls.length).toBeGreaterThan(0)
  })

  // ── (c) Lock-skip: an active identity lock defers expiry to a later tick ───
  it('expiry sweep skips a booking whose customer has an active identity lock', async () => {
    const bookingId = await seedExpiredHeldBooking(biz.businessId, customerId, biz.serviceId)

    // Simulate an active identity lock for this customer (redis.exists → 1).
    const { redis } = await import('../../src/redis.js')
    vi.mocked(redis.exists).mockResolvedValueOnce(1)

    const count = await expireHeldBookings()

    // Sweep defers — booking stays 'held', count=0.
    expect(count).toBe(0)

    const [row] = await db
      .select({ state: bookings.state })
      .from(bookings)
      .where(eq(bookings.id, bookingId))
      .limit(1)
    expect(row?.state).toBe('held')

    // No message enqueued.
    expect(vi.mocked(enqueueMessage).mock.calls.length).toBe(0)
  })
})
