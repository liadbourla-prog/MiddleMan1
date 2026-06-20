import crypto from 'crypto'
import { sql, eq, and } from 'drizzle-orm'
import { db } from '../../src/db/client.js'
import { businesses, identities, serviceTypes, bookings, providerOnboardingSessions, providerAssignments, availability, classSeries } from '../../src/db/schema.js'

export const integrationEnabled = !!process.env['DATABASE_URL']
export const llmEnabled = integrationEnabled && !!process.env['LLM_API_KEY']

export interface TestBusiness {
  businessId: string
  waNumber: string
  managerPhone: string
  serviceId: string
  serviceName: string
  groupServiceId: string
}

function nextPhone(): string {
  const digits = crypto.randomUUID().replace(/[^0-9]/g, '').padEnd(7, '5')
  return `+9720${digits.slice(0, 7)}`
}

export async function seedBusiness(opts: {
  language?: 'he' | 'en'
  calendarMode?: 'internal' | 'google'
  available247?: boolean
  cancellationCutoffMinutes?: number
  paused?: boolean
  timezone?: string
} = {}): Promise<TestBusiness> {
  const lang = opts.language ?? 'he'
  const waNumber = nextPhone()
  const managerPhone = nextPhone()

  const [business] = await db
    .insert(businesses)
    .values({
      name: lang === 'en' ? 'Test Barbershop' : 'מספרת בדיקה',
      whatsappNumber: waNumber,
      googleCalendarId: `test-${crypto.randomUUID()}`,
      timezone: opts.timezone ?? 'Asia/Jerusalem',
      calendarMode: opts.calendarMode ?? 'internal',
      defaultLanguage: lang,
      available247: opts.available247 ?? true,
      cancellationCutoffMinutes: opts.cancellationCutoffMinutes ?? 0,
      onboardingCompletedAt: new Date(),
      paused: opts.paused ?? false,
    })
    .returning()

  if (!business) throw new Error('seedBusiness: insert failed')

  await db.insert(identities).values({
    businessId: business.id,
    phoneNumber: managerPhone,
    role: 'manager',
    displayName: 'Test Manager',
    grantedAt: new Date(),
  })

  const [service] = await db
    .insert(serviceTypes)
    .values({
      businessId: business.id,
      name: lang === 'en' ? 'Haircut' : 'תספורת',
      durationMinutes: 30,
      maxParticipants: 1,
      isActive: true,
    })
    .returning()

  if (!service) throw new Error('seedBusiness: service insert failed')

  const [groupService] = await db
    .insert(serviceTypes)
    .values({
      businessId: business.id,
      name: lang === 'en' ? 'Yoga Class' : 'שיעור יוגה',
      durationMinutes: 60,
      maxParticipants: 5,
      isActive: true,
    })
    .returning()

  if (!groupService) throw new Error('seedBusiness: group service insert failed')

  return {
    businessId: business.id,
    waNumber,
    managerPhone,
    serviceId: service.id,
    serviceName: service.name,
    groupServiceId: groupService.id,
  }
}

export function freshPhone(): string {
  return nextPhone()
}

// Insert a booking directly (skips the flow — for state-setup in multi-booking tests)
export async function seedConfirmedBooking(
  businessId: string,
  customerId: string,
  serviceId: string,
  daysAhead: number,
): Promise<string> {
  const slotStart = new Date()
  slotStart.setDate(slotStart.getDate() + daysAhead)
  slotStart.setHours(10, 0, 0, 0)
  slotStart.setMilliseconds(0)
  const slotEnd = new Date(slotStart.getTime() + 30 * 60 * 1_000)

  const [booking] = await db
    .insert(bookings)
    .values({
      businessId,
      serviceTypeId: serviceId,
      customerId,
      requestedAt: new Date(),
      slotStart,
      slotEnd,
      state: 'confirmed',
      slotTzAtCreation: 'Asia/Jerusalem',
    })
    .returning()

  if (!booking) throw new Error('seedConfirmedBooking: insert failed')
  return booking.id
}

// Insert a customer identity row and return its id
export async function seedCustomer(businessId: string, phone: string): Promise<string> {
  const [existing] = await db
    .select({ id: identities.id })
    .from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.phoneNumber, phone)))
    .limit(1)

  if (existing) return existing.id

  const [identity] = await db
    .insert(identities)
    .values({
      businessId,
      phoneNumber: phone,
      role: 'customer',
      grantedAt: new Date(),
    })
    .returning()

  if (!identity) throw new Error('seedCustomer: insert failed')
  return identity.id
}

export async function teardown(businessId: string): Promise<void> {
  await db.execute(sql`DELETE FROM escalated_tasks WHERE business_id = ${businessId}`)
  await db.execute(sql`DELETE FROM audit_log WHERE business_id = ${businessId}`)
  await db.execute(
    sql`DELETE FROM conversation_messages
        WHERE session_id IN (SELECT id FROM conversation_sessions WHERE business_id = ${businessId})`,
  )
  await db.execute(sql`DELETE FROM conversation_sessions WHERE business_id = ${businessId}`)
  await db.execute(
    sql`DELETE FROM reminders
        WHERE booking_id IN (SELECT id FROM bookings WHERE business_id = ${businessId})`,
  )
  // Reshuffle engine rows reference bookings/identities — clear before them.
  await db.execute(
    sql`DELETE FROM reshuffle_proposals
        WHERE campaign_id IN (SELECT id FROM reshuffle_campaigns WHERE business_id = ${businessId})`,
  )
  await db.execute(
    sql`DELETE FROM reshuffle_offers
        WHERE campaign_id IN (SELECT id FROM reshuffle_campaigns WHERE business_id = ${businessId})`,
  )
  await db.execute(sql`DELETE FROM reshuffle_campaigns WHERE business_id = ${businessId}`)
  await db.execute(sql`DELETE FROM bookings WHERE business_id = ${businessId}`)
  await db.execute(sql`DELETE FROM customer_profiles WHERE business_id = ${businessId}`)
  // Recurring class series + their materialized instances and exceptions
  await db.execute(sql`DELETE FROM calendar_blocks WHERE business_id = ${businessId}`)
  await db.execute(
    sql`DELETE FROM class_series_exceptions
        WHERE series_id IN (SELECT id FROM class_series WHERE business_id = ${businessId})`,
  )
  await db.execute(sql`DELETE FROM class_series WHERE business_id = ${businessId}`)
  // Delegated staff permissions + assignments
  await db.execute(sql`DELETE FROM delegated_permissions WHERE business_id = ${businessId}`)
  await db.execute(sql`DELETE FROM provider_assignments WHERE business_id = ${businessId}`)
  // Per-service price tiers reference service_types — clear before it (CRM Tier-A)
  await db.execute(sql`DELETE FROM service_price_tiers WHERE business_id = ${businessId}`)
  await db.execute(sql`DELETE FROM service_types WHERE business_id = ${businessId}`)
  await db.execute(sql`DELETE FROM availability WHERE business_id = ${businessId}`)
  await db.execute(sql`DELETE FROM manager_instructions WHERE business_id = ${businessId}`)
  await db.execute(sql`DELETE FROM processed_messages WHERE business_id = ${businessId}`)
  await db.execute(sql`DELETE FROM waitlist WHERE business_id = ${businessId}`)
  // V2 skills layer
  await db.execute(
    sql`DELETE FROM workflow_step_logs
        WHERE workflow_id IN (SELECT id FROM skill_workflows WHERE business_id = ${businessId})`,
  )
  await db.execute(sql`DELETE FROM skill_workflows WHERE business_id = ${businessId}`)
  await db.execute(sql`DELETE FROM business_faqs WHERE business_id = ${businessId}`)
  await db.execute(sql`DELETE FROM deferred_feature_requests WHERE business_id = ${businessId}`)
  await db.execute(sql`DELETE FROM identities WHERE business_id = ${businessId}`)
  await db.execute(sql`DELETE FROM businesses WHERE id = ${businessId}`)
}

export async function teardownProviderSession(managerPhone: string): Promise<void> {
  await db.delete(providerOnboardingSessions).where(eq(providerOnboardingSessions.managerPhone, managerPhone))
}

// Seed an instructor: a staff identity, assignment to a service, and (optionally)
// provider-specific weekly hours. Used by multi-instructor / timezone tests.
export async function seedProvider(opts: {
  businessId: string
  serviceTypeId: string
  displayName?: string
  phone?: string
  weeklyHours?: { dayOfWeek: number; openTime: string; closeTime: string }[]
}): Promise<{ identityId: string; phone: string }> {
  const phone = opts.phone ?? nextPhone()
  const [identity] = await db
    .insert(identities)
    .values({
      businessId: opts.businessId,
      phoneNumber: phone,
      role: 'delegated_user',
      displayName: opts.displayName ?? 'Test Instructor',
      grantedAt: new Date(),
    })
    .returning()
  if (!identity) throw new Error('seedProvider: identity insert failed')

  await db.insert(providerAssignments).values({
    businessId: opts.businessId,
    identityId: identity.id,
    serviceTypeId: opts.serviceTypeId,
    isActive: true,
  })

  for (const h of opts.weeklyHours ?? []) {
    await db.insert(availability).values({
      businessId: opts.businessId,
      providerId: identity.id,
      dayOfWeek: h.dayOfWeek,
      openTime: h.openTime,
      closeTime: h.closeTime,
      isBlocked: false,
    })
  }

  return { identityId: identity.id, phone }
}

// Seed a recurring weekly class series row (does NOT materialize — call
// materializeSeries in the test to exercise the rolling-horizon expansion).
export async function seedClassSeries(opts: {
  businessId: string
  serviceTypeId: string
  dayOfWeek: number
  startTime: string
  durationMinutes?: number
  maxParticipants?: number
  startDate: string
  endDate?: string | null
  timezone: string
  title?: string
}): Promise<string> {
  const [row] = await db
    .insert(classSeries)
    .values({
      businessId: opts.businessId,
      serviceTypeId: opts.serviceTypeId,
      dayOfWeek: opts.dayOfWeek,
      startTime: opts.startTime,
      durationMinutes: opts.durationMinutes ?? 60,
      maxParticipants: opts.maxParticipants ?? 10,
      startDate: opts.startDate,
      endDate: opts.endDate ?? null,
      timezone: opts.timezone,
      title: opts.title ?? null,
    })
    .returning({ id: classSeries.id })
  if (!row) throw new Error('seedClassSeries: insert failed')
  return row.id
}

// Returns a date string suitable for LLM slot requests, N days from now
export function futureDateStr(lang: 'he' | 'en', daysAhead = 3, hour = 10): string {
  const d = new Date()
  d.setDate(d.getDate() + daysAhead)
  const day = d.getDate()
  const monthEn = d.toLocaleString('en-US', { month: 'long' })
  const monthHe: Record<number, string> = {
    0: 'ינואר', 1: 'פברואר', 2: 'מרץ', 3: 'אפריל', 4: 'מאי', 5: 'יוני',
    6: 'יולי', 7: 'אוגוסט', 8: 'ספטמבר', 9: 'אוקטובר', 10: 'נובמבר', 11: 'דצמבר',
  }
  const timeEn = `${hour}:00`
  const timeHe = `${hour}:00`
  if (lang === 'he') return `ב-${day} ל${monthHe[d.getMonth()]} בשעה ${timeHe}`
  return `${monthEn} ${day} at ${timeEn}`
}
