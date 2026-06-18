import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { businesses, serviceTypes } from '../../db/schema.js'
import type { Business } from '../../db/schema.js'
import { requireAuth, apiError } from './auth.js'
import { resolveServicePrice } from '../../domain/pricing/resolver.js'
import { loadInstructorRoster } from '../../domain/provider/roster.js'
import { getOpenSlots } from '../../domain/availability/service.js'
import { listBlocksInRange } from '../../domain/availability/blocks.js'
import { loadSessionRoster } from '../../domain/booking/roster.js'

async function loadBusiness(businessId: string): Promise<Business | null> {
  const [b] = await db.select().from(businesses).where(eq(businesses.id, businessId)).limit(1)
  return b ?? null
}

export function registerReadRoutes(app: FastifyInstance): void {
  // Services + resolved price (default tier — no membership eligibility)
  app.get('/api/v1/services', async (request, reply) => {
    const auth = await requireAuth(db, request, reply, 'public')
    if (!auth) return
    const biz = await loadBusiness(auth.businessId)
    if (!biz) return apiError(reply, 404, 'not_found', 'Business not found')
    const rows = await db.select().from(serviceTypes)
      .where(and(eq(serviceTypes.businessId, auth.businessId), eq(serviceTypes.isActive, true)))
    const services = await Promise.all(rows.map(async (s) => ({
      id: s.id,
      name: s.name,
      durationMinutes: s.durationMinutes,
      maxParticipants: s.maxParticipants,
      type: s.maxParticipants > 1 ? 'class' : 'session',
      price: (await resolveServicePrice(db, auth.businessId, { serviceTypeId: s.id, currency: biz.currency })).amount,
      currency: biz.currency,
    })))
    return reply.send({ services })
  })

  // Instructors (who teaches what + weekly hours)
  app.get('/api/v1/instructors', async (request, reply) => {
    const auth = await requireAuth(db, request, reply, 'public')
    if (!auth) return
    const roster = await loadInstructorRoster(db, auth.businessId)
    return reply.send({ instructors: roster.map((r) => ({ name: r.name, services: r.services, weeklyHours: r.weeklyHours })) })
  })

  // Upcoming class instances with spotsLeft COUNT (no participant names)
  app.get<{ Querystring: { from?: string; to?: string } }>('/api/v1/schedule', async (request, reply) => {
    const auth = await requireAuth(db, request, reply, 'public')
    if (!auth) return
    const biz = await loadBusiness(auth.businessId)
    if (!biz) return apiError(reply, 404, 'not_found', 'Business not found')
    const from = request.query.from ? new Date(request.query.from) : new Date()
    const to = request.query.to ? new Date(request.query.to) : new Date(Date.now() + 14 * 86_400_000)
    if (isNaN(from.getTime()) || isNaN(to.getTime())) return apiError(reply, 422, 'validation_error', 'Invalid from/to')

    const blocks = (await listBlocksInRange(db, auth.businessId, from, to)).filter((b) => b.type === 'class' && b.serviceTypeId)
    const classes = []
    for (const b of blocks) {
      const roster = await loadSessionRoster(db, auth.businessId, { serviceTypeId: b.serviceTypeId!, slotStart: b.startTs })
      const price = await resolveServicePrice(db, auth.businessId, { serviceTypeId: b.serviceTypeId!, currency: biz.currency })
      classes.push({
        serviceTypeId: b.serviceTypeId,
        serviceName: roster?.instance.serviceName ?? b.title ?? null,
        instructorName: roster?.instance.instructorName ?? null,
        start: b.startTs.toISOString(),
        end: b.endTs.toISOString(),
        capacity: roster?.instance.capacity ?? b.maxParticipants ?? null,
        spotsLeft: roster?.spotsLeft ?? b.maxParticipants ?? null,
        price: price.amount,
        currency: biz.currency,
      })
    }
    return reply.send({ timezone: biz.timezone, classes })
  })

  // Open bookable slots for one service
  app.get<{ Querystring: { serviceTypeId?: string; from?: string; to?: string } }>('/api/v1/availability', async (request, reply) => {
    const auth = await requireAuth(db, request, reply, 'public')
    if (!auth) return
    const biz = await loadBusiness(auth.businessId)
    if (!biz) return apiError(reply, 404, 'not_found', 'Business not found')
    const { serviceTypeId } = request.query
    if (!serviceTypeId) return apiError(reply, 422, 'validation_error', 'serviceTypeId is required')
    const [svc] = await db.select().from(serviceTypes)
      .where(and(eq(serviceTypes.id, serviceTypeId), eq(serviceTypes.businessId, auth.businessId))).limit(1)
    if (!svc) return apiError(reply, 404, 'not_found', 'Service not found')
    const from = request.query.from ? new Date(request.query.from) : new Date()
    const to = request.query.to ? new Date(request.query.to) : new Date(Date.now() + 7 * 86_400_000)
    if (isNaN(from.getTime()) || isNaN(to.getTime())) return apiError(reply, 422, 'validation_error', 'Invalid from/to')
    const slots = await getOpenSlots(db, biz, { start: from, end: to }, svc.durationMinutes)
    return reply.send({ timezone: biz.timezone, slots: slots.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })) })
  })
}
