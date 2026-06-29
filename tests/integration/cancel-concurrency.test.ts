// Integration concurrency proof for T1.4: conditional CAS on cancelBooking (CX3, P1).
//
// Skips when DATABASE_URL is absent (no local Postgres in this repo's CI environment).
// Run with a real DB: DATABASE_URL=<dsn> npm run test:integration
//
// WHAT THIS PROVES:
//   Two concurrent cancelBooking calls for the same confirmed booking fire via
//   Promise.all. The CAS predicate (UPDATE … WHERE id=? AND state='confirmed')
//   forces exactly one to flip the row; the other sees 0 rows returned and takes
//   the idempotent path.
//
//   Observable invariants:
//     1. Both calls return ok:true (honest idempotent success).
//     2. Exactly one audit row 'booking.cancelled' exists for the booking
//        (side effects fired once — not twice).
//     3. handleFreedSlot (via triggerWaitlistForSlot spy) was called at most once
//        (no double waitlist offer).
//
// Without the CAS both calls would see state='confirmed', both would flip the row
// (last-write-wins), and both would fire side effects — violating invariants 2 and 3.

import { vi } from 'vitest'

vi.mock('../../src/redis.js', () => ({
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
vi.mock('../../src/workers/waitlist.js', () => ({
  triggerWaitlistForSlot: vi.fn().mockResolvedValue(undefined),
  startWaitlistWorker: vi.fn(),
}))
vi.mock('../../src/workers/queued-messages.js', () => ({
  queueMessageForLater: vi.fn().mockResolvedValue(undefined),
  startQueuedMessageWorker: vi.fn(),
}))

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq, and } from 'drizzle-orm'
import { db } from '../../src/db/client.js'
import { auditLog, identities } from '../../src/db/schema.js'
import { cancelBooking } from '../../src/domain/booking/engine.js'
import {
  seedBusiness, seedCustomer, seedConfirmedBooking,
  teardown, integrationEnabled, freshPhone,
} from './setup.js'
import { createCalendarClient } from '../../src/adapters/calendar/client.js'
import type { ResolvedIdentity } from '../../src/domain/identity/types.js'
import type { TestBusiness } from './setup.js'
import { triggerWaitlistForSlot } from '../../src/workers/waitlist.js'

function calendar(businessId: string) {
  return createCalendarClient({ calendarMode: 'internal', googleCalendarId: null, businessId, waNumber: 'stub', timezone: 'UTC' })
}

function makeManagerActor(managerId: string, businessId: string, phone: string): ResolvedIdentity {
  return {
    id: managerId,
    businessId,
    phoneNumber: phone,
    role: 'manager',
    displayName: null,
    delegatedPermissions: null,
  }
}

describe.skipIf(!integrationEnabled)('T1.4 — cancelBooking conditional CAS (CX3/P1)', () => {
  let biz: TestBusiness
  let customerId: string
  let managerId: string

  beforeEach(async () => {
    biz = await seedBusiness({ available247: true, calendarMode: 'internal' })
    customerId = await seedCustomer(biz.businessId, freshPhone())

    // Resolve the manager identity id seeded by seedBusiness
    const [mgr] = await db
      .select({ id: identities.id })
      .from(identities)
      .where(and(eq(identities.businessId, biz.businessId), eq(identities.role, 'manager')))
      .limit(1)
    if (!mgr) throw new Error('manager identity not found')
    managerId = mgr.id

    vi.clearAllMocks()
  })

  afterEach(async () => {
    await teardown(biz.businessId)
  })

  it('two concurrent cancels: both return ok:true but side effects fire exactly once', async () => {
    const bookingId = await seedConfirmedBooking(biz.businessId, customerId, biz.serviceId, 3)

    const actor = makeManagerActor(managerId, biz.businessId, biz.managerPhone)
    const cal = calendar(biz.businessId)

    // Fire both cancels concurrently. The CAS (WHERE state='confirmed') ensures
    // exactly one row flip. The other call sees 0 rows and returns idempotent ok.
    const [r1, r2] = await Promise.all([
      cancelBooking(db, cal, actor, bookingId, 'test-concurrent-cancel'),
      cancelBooking(db, cal, actor, bookingId, 'test-concurrent-cancel'),
    ])

    // Invariant 1: both callers receive honest ok:true
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)

    // Invariant 2: exactly one audit row was written (side effects fired once)
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityId, bookingId),
          eq(auditLog.action, 'booking.cancelled'),
        ),
      )
    expect(auditRows).toHaveLength(1)

    // Invariant 3: handleFreedSlot / waitlist triggered exactly once. The winner
    // always calls handleFreedSlot synchronously, so the freed-slot/waitlist trigger
    // must fire exactly once — never zero (winner skipped it) and never twice (loser
    // double-fired). toBe(1) catches both failure modes; toBeLessThanOrEqual would miss
    // a winner that skipped the offer entirely.
    const waitlistCalls = vi.mocked(triggerWaitlistForSlot).mock.calls.length
    expect(waitlistCalls).toBe(1)
  })
})
