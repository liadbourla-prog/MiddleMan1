// Integration tests for T1.2: canonical-keyed capacity lock + pending_payment dup guard
// (findings A2/A5, root P1).
//
// Skips when DATABASE_URL is absent (no local Postgres in this repo's CI environment).
// Run with a real DB: DATABASE_URL=<dsn> npm run test:integration
//
// WHAT THESE PROVE:
//   (a) Capacity lock: two concurrent requestBooking calls racing for the last seat of
//       an 8-cap group class at 7/8 → exactly one ok:true (advisory lock holds capacity).
//   (b) pending_payment dup guard (A5): a customer with a pending_payment booking in the
//       class cannot slip a second booking through.

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
import { bookings, serviceTypes } from '../../src/db/schema.js'
import { requestBooking } from '../../src/domain/booking/engine.js'
import { seedBusiness, seedCustomer, teardown, integrationEnabled } from './setup.js'
import { createCalendarClient } from '../../src/adapters/calendar/client.js'
import type { ResolvedIdentity } from '../../src/domain/identity/types.js'
import type { TestBusiness } from './setup.js'
import { freshPhone } from './setup.js'

// Internal-mode CalendarClient stub (no Google OAuth needed).
function calendar(businessId: string) {
  return createCalendarClient({
    calendarMode: 'internal',
    googleCalendarId: null,
    businessId,
    waNumber: 'stub',
    timezone: 'UTC',
  })
}

function makeActor(customerId: string, businessId: string): ResolvedIdentity {
  return {
    id: customerId,
    businessId,
    phoneNumber: freshPhone(),
    role: 'customer',
    displayName: null,
    delegatedPermissions: null,
  }
}

// A class slot 7 days from now at 14:00 UTC (well inside the 365-day window
// and 30-min buffer). Using the groupServiceId (maxParticipants=5 by default
// in seedBusiness, overridden to 8 in the capacity test via a fresh insert).
function futureClassSlot(durationMinutes = 60): { slotStart: Date; slotEnd: Date } {
  const slotStart = new Date()
  slotStart.setUTCDate(slotStart.getUTCDate() + 7)
  slotStart.setUTCHours(14, 0, 0, 0)
  const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60_000)
  return { slotStart, slotEnd }
}

describe.skipIf(!integrationEnabled)('T1.2 — group-class capacity lock + pending_payment dup guard', () => {
  let biz: TestBusiness

  beforeEach(async () => {
    biz = await seedBusiness({ available247: true, calendarMode: 'internal' })
  })

  afterEach(async () => {
    await teardown(biz.businessId)
  })

  // ── (a) Capacity lock: last-seat race ──────────────────────────────────────
  it('advisory lock allows exactly one winner when two concurrent requests race for the last seat', async () => {
    // Seed an 8-cap class service and pre-fill 7 confirmed bookings so one seat
    // remains. Then fire two concurrent requests — the advisory lock must ensure
    // only one succeeds.
    const [svc] = await db
      .insert(serviceTypes)
      .values({
        businessId: biz.businessId,
        name: 'Pilates 8-cap',
        durationMinutes: 60,
        maxParticipants: 8,
        isActive: true,
      })
      .returning()
    if (!svc) throw new Error('service insert failed')

    const { slotStart, slotEnd } = futureClassSlot()

    // Pre-fill 7 confirmed seats (leaving exactly 1 open).
    for (let i = 0; i < 7; i++) {
      const phone = freshPhone()
      const cid = await seedCustomer(biz.businessId, phone)
      await db.insert(bookings).values({
        businessId: biz.businessId,
        serviceTypeId: svc.id,
        customerId: cid,
        requestedAt: new Date(),
        slotStart,
        slotEnd,
        state: 'confirmed',
        slotTzAtCreation: 'UTC',
      })
    }

    const customer1 = await seedCustomer(biz.businessId, freshPhone())
    const customer2 = await seedCustomer(biz.businessId, freshPhone())
    const actor1 = makeActor(customer1, biz.businessId)
    const actor2 = makeActor(customer2, biz.businessId)
    const cal = calendar(biz.businessId)

    const [r1, r2] = await Promise.all([
      requestBooking(db, cal, actor1, { serviceTypeId: svc.id, slotStart, slotEnd }),
      requestBooking(db, cal, actor2, { serviceTypeId: svc.id, slotStart, slotEnd }),
    ])

    const successes = [r1, r2].filter((r) => r.ok)
    const failures = [r1, r2].filter((r) => !r.ok)

    // The advisory transaction lock forces the two requests to take turns.
    // One lands ok:true (the seat is theirs); the other sees count>=cap and fails.
    expect(successes).toHaveLength(1)
    expect(failures).toHaveLength(1)
  })

  // ── (b) pending_payment dup guard (A5) ────────────────────────────────────
  it('blocks a customer from double-booking the same class when their existing booking is pending_payment', async () => {
    // Use the groupServiceId seeded by seedBusiness (maxParticipants=5, plenty of
    // capacity — the failure must come exclusively from the dup guard, not from
    // capacity exhaustion).
    const { slotStart, slotEnd } = futureClassSlot()
    const customerId = await seedCustomer(biz.businessId, freshPhone())

    // Directly insert a pending_payment booking for this customer + slot.
    await db.insert(bookings).values({
      businessId: biz.businessId,
      serviceTypeId: biz.groupServiceId,
      customerId,
      requestedAt: new Date(),
      slotStart,
      slotEnd,
      state: 'pending_payment',
      slotTzAtCreation: 'UTC',
    })

    // Now the same customer tries to book again.
    const actor = makeActor(customerId, biz.businessId)
    const cal = calendar(biz.businessId)
    const result = await requestBooking(db, cal, actor, {
      serviceTypeId: biz.groupServiceId,
      slotStart,
      slotEnd,
    })

    // Must be blocked by the dup guard (A5 fix).
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/already booked/i)
    }
  })

  // ── (c) G1 sanity: first legitimate booking still goes through ─────────────
  it('a customer with no prior booking can book into an open class (G1 — no false rejection)', async () => {
    const { slotStart, slotEnd } = futureClassSlot()
    const customerId = await seedCustomer(biz.businessId, freshPhone())
    const actor = makeActor(customerId, biz.businessId)
    const cal = calendar(biz.businessId)

    const result = await requestBooking(db, cal, actor, {
      serviceTypeId: biz.groupServiceId,
      slotStart,
      slotEnd,
    })

    // A fresh booking with no conflicts must succeed.
    expect(result.ok).toBe(true)
  })
})
