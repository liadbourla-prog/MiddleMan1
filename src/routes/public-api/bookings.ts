import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { businesses, bookings, serviceTypes } from '../../db/schema.js'
import { redis } from '../../redis.js'
import { requireAuth, apiError } from './auth.js'
import { isValidE164, registerCustomer, resolveIdentity } from '../../domain/identity/resolver.js'
import { requestBooking } from '../../domain/booking/engine.js'
import { createCalendarClient } from '../../adapters/calendar/client.js'
import { enqueueMessage } from '../../workers/message-retry.js'
import { i18n } from '../../domain/i18n/t.js'
import type { Business, BookingState } from '../../db/schema.js'
import { writeRateLimit } from './rate-limit.js'

const bookingBody = z.object({
  serviceTypeId: z.string().uuid(),
  slotStart: z.string(),
  slotEnd: z.string(),
  name: z.string().min(1),
  phone: z.string(),
  providerHint: z.string().nullable().optional(),
})

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60

export function registerBookingRoutes(app: FastifyInstance): void {
  app.post('/api/v1/bookings', { config: writeRateLimit }, async (request, reply) => {
    const auth = await requireAuth(db, request, reply, 'secret')
    if (!auth) return

    const parsed = bookingBody.safeParse(request.body)
    if (!parsed.success) return apiError(reply, 422, 'validation_error', parsed.error.issues[0]?.message ?? 'Invalid body')
    const { serviceTypeId, name, providerHint } = parsed.data
    const slotStart = new Date(parsed.data.slotStart)
    const slotEnd = new Date(parsed.data.slotEnd)
    if (isNaN(slotStart.getTime()) || isNaN(slotEnd.getTime())) return apiError(reply, 422, 'validation_error', 'Invalid slotStart/slotEnd')
    if (!isValidE164(parsed.data.phone)) return apiError(reply, 422, 'validation_error', 'phone must be E.164, e.g. +972501234567')
    const phone = parsed.data.phone

    // Idempotency: replay the stored booking id for a repeated key
    const idemKey = request.headers['idempotency-key']
    const idemRedisKey = typeof idemKey === 'string' ? `idem:booking:${auth.businessId}:${idemKey}` : null
    if (idemRedisKey) {
      const prior = await redis.get(idemRedisKey)
      if (prior) {
        const priorDetail = await loadBookingDetail(prior)
        if (priorDetail) return reply.status(201).send({ booking: shapeResponse(priorDetail) })
      }
    }

    const [biz] = await db.select().from(businesses).where(eq(businesses.id, auth.businessId)).limit(1)
    if (!biz) return apiError(reply, 404, 'not_found', 'Business not found')

    const customerId = await registerCustomer(db, auth.businessId, phone, name)
    const resolved = await resolveIdentity(db, auth.businessId, phone)
    if (!resolved.found) return apiError(reply, 500, 'internal', 'Failed to resolve customer identity')
    void customerId

    const calendar = createCalendarClient({
      accessToken: '',
      refreshToken: biz.googleRefreshToken ?? process.env['GOOGLE_REFRESH_TOKEN'] ?? '',
      calendarId: biz.googleCalendarId,
      businessId: biz.id,
      calendarMode: biz.calendarMode,
      lang: biz.defaultLanguage,
    })

    const result = await requestBooking(db, calendar, resolved.identity, {
      serviceTypeId,
      slotStart,
      slotEnd,
      ...(providerHint ? { providerHint } : {}),
    })

    if (!result.ok) {
      const full = /full/i.test(result.reason)
      return apiError(reply, 409, full ? 'class_full' : 'slot_unavailable', result.reason)
    }

    if (idemRedisKey) await redis.set(idemRedisKey, result.bookingId, 'EX', IDEMPOTENCY_TTL_SECONDS)

    const detail = await loadBookingDetail(result.bookingId)
    // WhatsApp confirmation to the customer — a website booking must NOT be silent.
    // This is the same confirmation channel a WhatsApp booking uses (CRM_STANDARD.md
    // §6.3). Templated + lawbook-governed (not LLM-phrased). Non-fatal: the booking
    // is already committed, so a send failure must not fail the API response.
    // A held-for-owner-approval booking is NOT confirmed — don't send a "confirmed" notice
    // (design 2026-06-25). The owner's approve/decline fires its own customer message later.
    if (detail && !result.pendingApproval) {
      const lang = resolved.identity.preferredLanguage ?? biz.defaultLanguage
      await sendBookingConfirmation(biz, lang, phone, detail).catch(() => { /* non-fatal */ })
    }

    return reply.status(201).send({ booking: detail ? shapeResponse(detail) : { id: result.bookingId } })
  })
}

interface BookingDetail {
  id: string
  state: BookingState
  slotStart: Date
  slotEnd: Date
  serviceName: string
}

async function loadBookingDetail(bookingId: string): Promise<BookingDetail | null> {
  const [row] = await db
    .select({
      id: bookings.id, state: bookings.state, slotStart: bookings.slotStart, slotEnd: bookings.slotEnd,
      serviceName: serviceTypes.name,
    })
    .from(bookings)
    .innerJoin(serviceTypes, eq(bookings.serviceTypeId, serviceTypes.id))
    .where(eq(bookings.id, bookingId))
    .limit(1)
  return row ?? null
}

function shapeResponse(d: BookingDetail): object {
  return { id: d.id, state: d.state, slotStart: d.slotStart.toISOString(), slotEnd: d.slotEnd.toISOString(), serviceName: d.serviceName }
}

async function sendBookingConfirmation(biz: Business, lang: 'he' | 'en', phone: string, d: BookingDetail): Promise<void> {
  const locale = lang === 'he' ? 'he-IL' : 'en-GB'
  const dateStr = new Intl.DateTimeFormat(locale, { timeZone: biz.timezone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(d.slotStart)
  const timeStr = new Intl.DateTimeFormat(locale, { timeZone: biz.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(d.slotStart)
  const body = d.state === 'pending_payment'
    ? i18n.booking_pending_payment[lang](d.serviceName, biz.name, dateStr, timeStr)
    : i18n.booking_confirmed[lang](d.serviceName, biz.name, dateStr, timeStr)
  await enqueueMessage(biz.id, phone, body, { bookingId: d.id })
}
