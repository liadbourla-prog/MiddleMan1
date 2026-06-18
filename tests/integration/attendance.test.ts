import { vi } from 'vitest'
vi.mock('../../src/redis.js', () => ({ redisConnection: { quit: vi.fn(), on: vi.fn(), disconnect: vi.fn() } }))
vi.mock('../../src/workers/message-retry.js', () => ({
  enqueueMessage: vi.fn().mockResolvedValue(undefined), messageRetryQueue: { add: vi.fn() }, startMessageRetryWorker: vi.fn(),
}))
vi.mock('../../src/workers/calendar-mirror.js', () => ({
  enqueueBlockMirror: vi.fn().mockResolvedValue(undefined), enqueueBlockDeletion: vi.fn().mockResolvedValue(undefined),
  enqueueBookingDeletion: vi.fn().mockResolvedValue(undefined), startCalendarMirrorWorker: vi.fn(),
}))

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../../src/db/client.js'
import { bookings } from '../../src/db/schema.js'
import { eq } from 'drizzle-orm'
import { seedBusiness, seedCustomer, teardown, integrationEnabled } from './setup.js'
import type { TestBusiness } from './setup.js'
import { markAttendance } from '../../src/domain/booking/attendance.js'

describe.skipIf(!integrationEnabled)('markAttendance', () => {
  let biz: TestBusiness
  beforeEach(async () => { biz = await seedBusiness({ language: 'en' }) })
  afterEach(async () => { await teardown(biz.businessId) })

  async function makeBooking(state: 'confirmed' | 'requested', slotEnd: Date): Promise<string> {
    const customerId = await seedCustomer(biz.businessId, '+972500000301')
    const [b] = await db.insert(bookings).values({
      businessId: biz.businessId, serviceTypeId: biz.serviceId, customerId,
      requestedAt: new Date(), slotStart: new Date(slotEnd.getTime() - 3_600_000), slotEnd, state,
    }).returning()
    return b!.id
  }

  it('marks a past confirmed booking as attended', async () => {
    const id = await makeBooking('confirmed', new Date(Date.now() - 3_600_000))
    const res = await markAttendance(db, biz.businessId, id, 'attended', new Date())
    expect(res.ok).toBe(true)
    const [row] = await db.select({ state: bookings.state }).from(bookings).where(eq(bookings.id, id))
    expect(row!.state).toBe('attended')
  })

  it('refuses to mark a booking whose slot has not ended', async () => {
    const id = await makeBooking('confirmed', new Date(Date.now() + 3_600_000))
    const res = await markAttendance(db, biz.businessId, id, 'no_show', new Date())
    expect(res.ok).toBe(false)
  })

  it('refuses to mark a non-confirmed booking', async () => {
    const id = await makeBooking('requested', new Date(Date.now() - 3_600_000))
    const res = await markAttendance(db, biz.businessId, id, 'attended', new Date())
    expect(res.ok).toBe(false)
  })
})
