// Integration coverage for the conversational instructor-management write path
// (applyProviderChange). Exercises the DETERMINISTIC apply handler directly
// against a real DB — needs DATABASE_URL but NOT an LLM key.
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
import { eq, and, isNull } from 'drizzle-orm'
import { identities, providerAssignments, availability, serviceTypes } from '../../src/db/schema.js'
import { seedBusiness, teardown, integrationEnabled } from './setup.js'
import type { TestBusiness } from './setup.js'
import { applyProviderChange } from '../../src/domain/manager/apply.js'

// Instructors are created via the REAL applyProviderChange (role='provider'),
// not the legacy seedProvider helper (which uses role='delegated_user').

async function managerId(businessId: string): Promise<string> {
  const [mgr] = await db
    .select({ id: identities.id })
    .from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.role, 'manager')))
    .limit(1)
  if (!mgr) throw new Error('manager identity not found')
  return mgr.id
}

async function providerByName(businessId: string, name: string) {
  const [row] = await db
    .select()
    .from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.role, 'provider'), eq(identities.displayName, name)))
    .limit(1)
  return row
}

describe.skipIf(!integrationEnabled)('instructor management — applyProviderChange', () => {
  let biz: TestBusiness
  let actorId: string
  let secondServiceName: string

  beforeEach(async () => {
    biz = await seedBusiness({ timezone: 'Asia/Jerusalem' })
    actorId = await managerId(biz.businessId)
    const [grp] = await db
      .select({ name: serviceTypes.name })
      .from(serviceTypes)
      .where(eq(serviceTypes.id, biz.groupServiceId))
      .limit(1)
    secondServiceName = grp!.name
  })

  afterEach(async () => {
    await teardown(biz.businessId)
  })

  it('add: creates a provider identity (synthetic phone, opt-out), assignment, and weekly hours', async () => {
    const res = await applyProviderChange(db, biz.businessId, actorId, {
      action: 'add',
      instructorName: 'Dana',
      serviceNames: [biz.serviceName],
      weeklyHours: [
        { dayOfWeek: 1, startTime: '09:00', endTime: '13:00' },
        { dayOfWeek: 3, startTime: '09:00', endTime: '13:00' },
      ],
    }, 'en')
    expect(res.ok).toBe(true)

    const prov = await providerByName(biz.businessId, 'Dana')
    expect(prov).toBeTruthy()
    expect(prov!.phoneNumber).toMatch(/^provider:/)
    expect(prov!.messagingOptOut).toBe(true)

    const assigns = await db.select().from(providerAssignments)
      .where(and(eq(providerAssignments.businessId, biz.businessId), eq(providerAssignments.identityId, prov!.id)))
    expect(assigns).toHaveLength(1)
    expect(assigns[0]!.serviceTypeId).toBe(biz.serviceId)

    const hours = await db.select().from(availability)
      .where(and(eq(availability.providerId, prov!.id), isNull(availability.specificDate)))
    expect(hours.map((h) => h.dayOfWeek).sort()).toEqual([1, 3])
  })

  it('add: a real phone is stored verbatim and does NOT opt out of messaging', async () => {
    await applyProviderChange(db, biz.businessId, actorId, {
      action: 'add', instructorName: 'Noa', phone: '+972500000001', serviceNames: [biz.serviceName], weeklyHours: [],
    }, 'en')
    const prov = await providerByName(biz.businessId, 'Noa')
    expect(prov!.phoneNumber).toBe('+972500000001')
    expect(prov!.messagingOptOut).toBe(false)
  })

  it('add: idempotent — re-adding the same instructor does not duplicate', async () => {
    const params = { action: 'add' as const, instructorName: 'Dana', serviceNames: [biz.serviceName], weeklyHours: [{ dayOfWeek: 1, startTime: '09:00', endTime: '13:00' }] }
    await applyProviderChange(db, biz.businessId, actorId, params, 'en')
    await applyProviderChange(db, biz.businessId, actorId, params, 'en')
    const provs = await db.select().from(identities)
      .where(and(eq(identities.businessId, biz.businessId), eq(identities.role, 'provider')))
    expect(provs).toHaveLength(1)
    const assigns = await db.select().from(providerAssignments).where(eq(providerAssignments.identityId, provs[0]!.id))
    expect(assigns).toHaveLength(1)
  })

  it('add: unknown service name → clarify (not ok)', async () => {
    const res = await applyProviderChange(db, biz.businessId, actorId, {
      action: 'add', instructorName: 'Dana', serviceNames: ['no-such-service'], weeklyHours: [],
    }, 'en')
    expect(res.ok).toBe(false)
  })

  it('set_hours: replaces the weekly availability rows', async () => {
    await applyProviderChange(db, biz.businessId, actorId, {
      action: 'add', instructorName: 'Dana', serviceNames: [biz.serviceName], weeklyHours: [{ dayOfWeek: 1, startTime: '09:00', endTime: '13:00' }],
    }, 'en')
    await applyProviderChange(db, biz.businessId, actorId, {
      action: 'set_hours', instructorName: 'Dana', weeklyHours: [{ dayOfWeek: 2, startTime: '10:00', endTime: '14:00' }],
    }, 'en')
    const prov = await providerByName(biz.businessId, 'Dana')
    const hours = await db.select().from(availability)
      .where(and(eq(availability.providerId, prov!.id), isNull(availability.specificDate)))
    expect(hours).toHaveLength(1)
    expect(hours[0]!.dayOfWeek).toBe(2)
  })

  it('assign_service then unassign_service toggles isActive', async () => {
    await applyProviderChange(db, biz.businessId, actorId, {
      action: 'add', instructorName: 'Dana', serviceNames: [biz.serviceName], weeklyHours: [{ dayOfWeek: 1, startTime: '09:00', endTime: '13:00' }],
    }, 'en')
    const prov = await providerByName(biz.businessId, 'Dana')

    await applyProviderChange(db, biz.businessId, actorId, { action: 'assign_service', instructorName: 'Dana', serviceNames: [secondServiceName] }, 'en')
    let active = await db.select().from(providerAssignments)
      .where(and(eq(providerAssignments.identityId, prov!.id), eq(providerAssignments.isActive, true)))
    expect(active).toHaveLength(2)

    await applyProviderChange(db, biz.businessId, actorId, { action: 'unassign_service', instructorName: 'Dana', serviceNames: [secondServiceName] }, 'en')
    active = await db.select().from(providerAssignments)
      .where(and(eq(providerAssignments.identityId, prov!.id), eq(providerAssignments.isActive, true)))
    expect(active).toHaveLength(1)
  })

  it('remove: deactivates all assignments', async () => {
    await applyProviderChange(db, biz.businessId, actorId, {
      action: 'add', instructorName: 'Dana', serviceNames: [biz.serviceName], weeklyHours: [{ dayOfWeek: 1, startTime: '09:00', endTime: '13:00' }],
    }, 'en')
    await applyProviderChange(db, biz.businessId, actorId, { action: 'remove', instructorName: 'Dana' }, 'en')
    const prov = await providerByName(biz.businessId, 'Dana')
    const active = await db.select().from(providerAssignments)
      .where(and(eq(providerAssignments.identityId, prov!.id), eq(providerAssignments.isActive, true)))
    expect(active).toHaveLength(0)
  })

  it('set_hours on an unknown instructor → not found (not ok)', async () => {
    const res = await applyProviderChange(db, biz.businessId, actorId, { action: 'set_hours', instructorName: 'Nobody', weeklyHours: [] }, 'en')
    expect(res.ok).toBe(false)
  })
})
