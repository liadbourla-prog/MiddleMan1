// Mocks must be declared before any imports (vitest hoists these).
import { vi } from 'vitest'
vi.mock('../../src/redis.js', () => ({ redisConnection: { quit: vi.fn(), on: vi.fn(), disconnect: vi.fn() } }))
vi.mock('../../src/workers/calendar-mirror.js', () => ({
  enqueueBlockMirror: vi.fn().mockResolvedValue(undefined),
  enqueueBlockDeletion: vi.fn().mockResolvedValue(undefined),
  enqueueBookingDeletion: vi.fn().mockResolvedValue(undefined),
  startCalendarMirrorWorker: vi.fn(),
}))

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { db } from '../../src/db/client.js'
import { availability, businesses, calendarBlocks } from '../../src/db/schema.js'
import type { Business } from '../../src/db/schema.js'
import { seedBusiness, teardown, integrationEnabled } from './setup.js'
import type { TestBusiness } from './setup.js'
import { blockOpenTimeAroundClasses } from '../../src/domain/availability/block-around-classes.js'
import { createBlock } from '../../src/domain/availability/blocks.js'
import { isSlotBookable } from '../../src/domain/availability/service.js'
import { localTimeToUtc } from '../../src/domain/availability/compute.js'

const TZ = 'Asia/Jerusalem'

// Nearest future Sunday (weekday 0) as YYYY-MM-DD, so the date is unambiguous.
function nextSunday(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7 || 7))
  return d.toISOString().slice(0, 10)
}

describe.skipIf(!integrationEnabled)('blockOpenTimeAroundClasses (Issue 3 — end to end)', () => {
  let biz: TestBusiness
  let business: Business
  const sunday = nextSunday()

  beforeEach(async () => {
    // Bounded-hours business (NOT 24/7) so "open in-hours time" is well defined.
    biz = await seedBusiness({ language: 'en', calendarMode: 'internal', available247: false })
    const [row] = await db.update(businesses).set({ available247: false }).where(eq(businesses.id, biz.businessId)).returning()
    business = row!
    // Hours Sunday 09:00–20:00.
    await db.insert(availability).values({ businessId: biz.businessId, dayOfWeek: 0, openTime: '09:00', closeTime: '20:00', isBlocked: false })
    // One real class 11:00–12:00 (group, capacity 5) — the only thing customers may book.
    await createBlock(db, {
      businessId: biz.businessId,
      type: 'class',
      start: localTimeToUtc(sunday, '11:00', TZ),
      end: localTimeToUtc(sunday, '12:00', TZ),
      title: 'Yoga Class',
      serviceTypeId: biz.groupServiceId,
      maxParticipants: 5,
    })
  })

  afterEach(async () => { await teardown(biz.businessId) })

  it('materializes internal (soft) gap-blocks around the class, never over it', async () => {
    const summary = await blockOpenTimeAroundClasses(db, business, { from: sunday, to: sunday, weekdays: [0], mirror: false })

    expect(summary.classesPreserved).toBe(1)
    expect(summary.blocksCreated).toBe(2) // 09:00–11:00 and 12:00–20:00

    const created = await db.select().from(calendarBlocks)
      .where(and(eq(calendarBlocks.businessId, biz.businessId), eq(calendarBlocks.type, 'block')))
    expect(created.length).toBe(2)
    // Soft → invisible in Google.
    for (const b of created) expect(b.mirrorToGoogle).toBe(false)
    // Invariant #1: no gap-block overlaps the 11:00–12:00 class.
    const classStart = localTimeToUtc(sunday, '11:00', TZ).getTime()
    const classEnd = localTimeToUtc(sunday, '12:00', TZ).getTime()
    for (const b of created) {
      const overlaps = b.startTs.getTime() < classEnd && b.endTs.getTime() > classStart
      expect(overlaps).toBe(false)
    }
  })

  it('then Branch 4 refuses an off-schedule weekday time but still allows the real class', async () => {
    await blockOpenTimeAroundClasses(db, business, { from: sunday, to: sunday, weekdays: [0], mirror: false })

    // Off-class private time (17:00) — the exact bug. A customer must NOT be offered it.
    const offSchedule = { start: localTimeToUtc(sunday, '17:00', TZ), end: localTimeToUtc(sunday, '18:00', TZ) }
    const offResult = await isSlotBookable(db, business, offSchedule)
    expect(offResult.bookable).toBe(false)

    // The real class slot — a customer booking INTO the class excludes the 'class'
    // container from busy, exactly as the booking engine does. It must stay bookable.
    const classSlot = { start: localTimeToUtc(sunday, '11:00', TZ), end: localTimeToUtc(sunday, '12:00', TZ) }
    const classResult = await isSlotBookable(db, business, classSlot, { blockTypes: ['block', 'personal'] })
    expect(classResult.bookable).toBe(true)
  })

  it('is idempotent — a second run creates no new blocks', async () => {
    const first = await blockOpenTimeAroundClasses(db, business, { from: sunday, to: sunday, weekdays: [0], mirror: false })
    const second = await blockOpenTimeAroundClasses(db, business, { from: sunday, to: sunday, weekdays: [0], mirror: false })
    expect(first.blocksCreated).toBe(2)
    expect(second.blocksCreated).toBe(0)
  })

  it('mirror:true marks the blocks visible in Google', async () => {
    await blockOpenTimeAroundClasses(db, business, { from: sunday, to: sunday, weekdays: [0], mirror: true })
    const created = await db.select().from(calendarBlocks)
      .where(and(eq(calendarBlocks.businessId, biz.businessId), eq(calendarBlocks.type, 'block')))
    for (const b of created) expect(b.mirrorToGoogle).toBe(true)
  })
})
