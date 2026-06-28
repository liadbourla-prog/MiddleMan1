// Integration concurrency proof for T1.1a: pg_advisory_xact_lock on the private
// booking path (finding A1, root P1).
//
// Skips when DATABASE_URL is absent (no local Postgres in this repo's CI environment).
// Run with a real DB: DATABASE_URL=<dsn> npm run test:integration
//
// WHAT THIS PROVES:
//   Two concurrent requestBooking calls for the same free private slot fire via
//   Promise.all. The advisory transaction lock (acquired at the top of the private
//   path's transaction) forces them to take turns through conflict-check → insert.
//   Exactly one must return ok:true (slot secured); the other must return ok:false
//   (conflict detected by the serialized SELECT that now sees the first insert).
//
// Without the lock both requests see zero conflicts (TOCTOU), both insert, and the
// assertion "exactly one ok:true" fails — confirming that the lock is load-bearing.

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
import { db } from '../../src/db/client.js'
import { requestBooking } from '../../src/domain/booking/engine.js'
import { seedBusiness, seedCustomer, teardown, integrationEnabled } from './setup.js'
import { createCalendarClient } from '../../src/adapters/calendar/client.js'
import type { ResolvedIdentity } from '../../src/domain/identity/types.js'
import type { TestBusiness } from './setup.js'
import { freshPhone } from './setup.js'

// A no-op CalendarClient stub (internal mode — calendar calls short-circuit in engine
// before reaching the adapter when `placeHold` is stubbed to return success).
function calendar(businessId: string) {
  return createCalendarClient({ calendarMode: 'internal', googleCalendarId: null, businessId, waNumber: 'stub', timezone: 'UTC' })
}

function makeActor(customerId: string, businessId: string, phoneNumber: string): ResolvedIdentity {
  return {
    id: customerId,
    businessId,
    phoneNumber,
    role: 'customer',
    displayName: null,
    delegatedPermissions: null,
  }
}

// Slot 7 days from now at 10:00 UTC (well within the default 365-day window and 30-min buffer).
function futureSlot(): { slotStart: Date; slotEnd: Date } {
  const slotStart = new Date()
  slotStart.setUTCDate(slotStart.getUTCDate() + 7)
  slotStart.setUTCHours(10, 0, 0, 0)
  const slotEnd = new Date(slotStart.getTime() + 30 * 60_000)
  return { slotStart, slotEnd }
}

describe.skipIf(!integrationEnabled)('T1.1a — private booking advisory lock (concurrency)', () => {
  let biz: TestBusiness
  let customerId1: string
  let customerId2: string

  beforeEach(async () => {
    biz = await seedBusiness({ available247: true, calendarMode: 'internal' })
    customerId1 = await seedCustomer(biz.businessId, freshPhone())
    customerId2 = await seedCustomer(biz.businessId, freshPhone())
  })

  afterEach(async () => {
    await teardown(biz.businessId)
  })

  it('exactly one of two concurrent requestBooking calls wins the same free private slot', async () => {
    const { slotStart, slotEnd } = futureSlot()

    const actor1 = makeActor(customerId1, biz.businessId, freshPhone())
    const actor2 = makeActor(customerId2, biz.businessId, freshPhone())

    // Fire both requests concurrently. The pg_advisory_xact_lock acquired at the
    // top of each transaction serializes the conflict-check → insert window so that
    // the second transaction to acquire the lock sees the first insert as a conflict.
    const [result1, result2] = await Promise.all([
      requestBooking(db, calendar(biz.businessId), actor1, { serviceTypeId: biz.serviceId, slotStart, slotEnd }),
      requestBooking(db, calendar(biz.businessId), actor2, { serviceTypeId: biz.serviceId, slotStart, slotEnd }),
    ])

    const successes = [result1, result2].filter((r) => r.ok)
    const failures = [result1, result2].filter((r) => !r.ok)

    // The advisory lock guarantees exactly one winner and one loser.
    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)
  })
})
