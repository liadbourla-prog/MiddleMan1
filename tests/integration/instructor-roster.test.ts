// Integration coverage for the instructor roster read model (loadInstructorRoster,
// getInstructorHours). Needs DATABASE_URL but NOT an LLM key.
// Run: npm run test:integration

import { vi } from 'vitest'

vi.mock('../../src/redis.js', () => ({
  redisConnection: { quit: vi.fn(), on: vi.fn(), disconnect: vi.fn() },
}))
vi.mock('../../src/workers/message-retry.js', () => ({
  enqueueMessage: vi.fn().mockResolvedValue(undefined),
  messageRetryQueue: { add: vi.fn() },
  startMessageRetryWorker: vi.fn(),
}))
vi.mock('../../src/workers/calendar-mirror.js', () => ({
  enqueueBlockMirror: vi.fn().mockResolvedValue(undefined),
  enqueueBlockDeletion: vi.fn().mockResolvedValue(undefined),
  enqueueBookingDeletion: vi.fn().mockResolvedValue(undefined),
  startCalendarMirrorWorker: vi.fn(),
}))

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../../src/db/client.js'
import { eq, and } from 'drizzle-orm'
import { identities } from '../../src/db/schema.js'
import { seedBusiness, teardown, integrationEnabled } from './setup.js'
import type { TestBusiness } from './setup.js'
import { applyProviderChange } from '../../src/domain/manager/apply.js'
import { loadInstructorRoster, getInstructorHours } from '../../src/domain/provider/roster.js'

async function managerId(businessId: string): Promise<string> {
  const [mgr] = await db.select({ id: identities.id }).from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.role, 'manager'))).limit(1)
  if (!mgr) throw new Error('manager identity not found')
  return mgr.id
}

describe.skipIf(!integrationEnabled)('instructor roster — read model', () => {
  let biz: TestBusiness
  let actorId: string

  beforeEach(async () => {
    biz = await seedBusiness({ timezone: 'Asia/Jerusalem' })
    actorId = await managerId(biz.businessId)
    await applyProviderChange(db, biz.businessId, actorId, {
      action: 'add', instructorName: 'Dana', serviceNames: [biz.serviceName],
      weeklyHours: [{ dayOfWeek: 1, startTime: '09:00', endTime: '13:00' }],
    }, 'en')
  })

  afterEach(async () => { await teardown(biz.businessId) })

  it('loadInstructorRoster returns the instructor with services and weekly hours', async () => {
    const roster = await loadInstructorRoster(db, biz.businessId)
    expect(roster).toHaveLength(1)
    expect(roster[0]!.name).toBe('Dana')
    expect(roster[0]!.services).toContain(biz.serviceName)
    expect(roster[0]!.weeklyHours).toEqual([{ dayOfWeek: 1, startTime: '09:00', endTime: '13:00' }])
  })

  it('getInstructorHours resolves an assigned instructor by name hint', async () => {
    const res = await getInstructorHours(db, biz.businessId, biz.serviceId, 'Dana')
    expect(res?.name).toBe('Dana')
    expect(res?.weeklyHours).toEqual([{ dayOfWeek: 1, startTime: '09:00', endTime: '13:00' }])
  })

  it('getInstructorHours returns null when no assigned instructor matches the hint', async () => {
    const res = await getInstructorHours(db, biz.businessId, biz.serviceId, 'Nobody')
    expect(res).toBeNull()
  })

  it('a removed instructor drops out of the roster', async () => {
    await applyProviderChange(db, biz.businessId, actorId, { action: 'remove', instructorName: 'Dana' }, 'en')
    const roster = await loadInstructorRoster(db, biz.businessId)
    // identity still exists but has no active assignments → empty services
    expect(roster[0]?.services ?? []).toHaveLength(0)
  })
})
