import { describe, it, expect } from 'vitest'

// The unit-test runner (tests/setup-env.ts) injects a dummy DATABASE_URL so
// modules load, but no real Postgres is available. Only skip to integration when
// the URL is not the placeholder value.
const dbUrl = process.env['DATABASE_URL']
const integrationEnabled = !!dbUrl && !dbUrl.includes('@localhost:5432/test')

describe.skipIf(!integrationEnabled)('findClassBlockProviderForSlot', () => {
  it('returns the providerId of the class block at the slot', async () => {
    const { db } = await import('../../db/client.js')
    const { businesses, identities, serviceTypes } = await import('../../db/schema.js')
    const { findClassBlockProviderForSlot, createBlock } = await import('./blocks.js')
    const { sql } = await import('drizzle-orm')
    const crypto = await import('node:crypto')

    const businessId = crypto.randomUUID()
    const managerId = crypto.randomUUID()
    const providerId = crypto.randomUUID()
    const serviceId = crypto.randomUUID()
    const groupServiceId = crypto.randomUUID()
    const nextPhone = () => `+97250${crypto.randomUUID().replace(/[^0-9]/g, '').slice(0, 7)}`

    await db.insert(businesses).values({
      id: businessId,
      name: 'Test Studio',
      whatsappNumber: nextPhone(),
      googleCalendarId: `test-${businessId}`,
      timezone: 'Asia/Jerusalem',
      calendarMode: 'internal',
      defaultLanguage: 'en',
      available247: true,
      cancellationCutoffMinutes: 0,
      onboardingCompletedAt: new Date(),
      paused: false,
    })
    await db.insert(identities).values([
      {
        id: managerId,
        businessId,
        phoneNumber: nextPhone(),
        role: 'manager',
        displayName: 'Test Manager',
        grantedAt: new Date(),
      },
      {
        id: providerId,
        businessId,
        phoneNumber: nextPhone(),
        role: 'provider',
        displayName: 'Dana',
        grantedAt: new Date(),
      },
    ])
    await db.insert(serviceTypes).values([
      {
        id: serviceId,
        businessId,
        name: 'Haircut',
        durationMinutes: 30,
        maxParticipants: 1,
        isActive: true,
      },
      {
        id: groupServiceId,
        businessId,
        name: 'Yoga Class',
        durationMinutes: 60,
        maxParticipants: 5,
        isActive: true,
      },
    ])

    try {
      const slotStart = new Date('2026-06-15T07:00:00.000Z')
      await createBlock(db, {
        businessId, type: 'class', start: slotStart,
        end: new Date(slotStart.getTime() + 3_600_000), serviceTypeId: groupServiceId,
        maxParticipants: 12, providerId,
      })

      const hit = await findClassBlockProviderForSlot(db, businessId, groupServiceId, slotStart)
      expect(hit.found).toBe(true)
      if (hit.found) expect(hit.providerId).toBe(providerId)

      const miss = await findClassBlockProviderForSlot(db, businessId, groupServiceId, new Date('2026-06-16T07:00:00.000Z'))
      expect(miss.found).toBe(false)
    } finally {
      await db.execute(sql`DELETE FROM calendar_blocks WHERE business_id = ${businessId}`)
      await db.execute(sql`DELETE FROM service_types WHERE business_id = ${businessId}`)
      await db.execute(sql`DELETE FROM identities WHERE business_id = ${businessId}`)
      await db.execute(sql`DELETE FROM businesses WHERE id = ${businessId}`)
    }
  })
})
