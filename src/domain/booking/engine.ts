import { eq, and, or, lt, lte, gt, gte, count, isNotNull, ne } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { bookings, serviceTypes, businesses, identities } from '../../db/schema.js'
import { enqueueMessage } from '../../workers/message-retry.js'
import { resolveProvider } from '../provider/resolver.js'
import { triggerWaitlistForSlot } from '../../workers/waitlist.js'
import type { ResolvedIdentity } from '../identity/types.js'
import { authorize } from '../authorization/check.js'
import { transition } from './state-machine.js'
import type { BookingSlotRequest } from './types.js'
import { logAudit } from '../audit/logger.js'
import type { CalendarClient } from '../../adapters/calendar/client.js'
import { recordCompletedBooking } from '../customer/profile.js'
import { scheduleReminders, cancelReminders } from '../../workers/reminder.js'
import { i18n, type Lang } from '../i18n/t.js'

const HOLD_EXPIRY_MINUTES = parseInt(process.env['HOLD_EXPIRY_MINUTES'] ?? '15', 10)

export type BookingEngineResult =
  | { ok: true; bookingId: string; message: string; directlyConfirmed?: boolean; pendingPayment?: boolean }
  | { ok: false; reason: string }

function validateSlotTiming(
  slotStart: Date,
  slotEnd: Date,
  bufferMinutes: number,
  maxDaysAhead: number,
): string | null {
  const now = new Date()

  if (slotStart <= now) return 'Cannot book a slot in the past'

  const minStart = new Date(now.getTime() + bufferMinutes * 60 * 1000)
  if (slotStart < minStart) {
    return `Bookings must be made at least ${bufferMinutes} minutes in advance`
  }

  const maxStart = new Date(now.getTime() + maxDaysAhead * 24 * 60 * 60 * 1000)
  if (slotStart > maxStart) {
    return `Bookings can only be made up to ${maxDaysAhead} days in advance`
  }

  if (slotEnd <= slotStart) return 'Slot end must be after slot start'

  return null
}

export async function requestBooking(
  db: Db,
  calendar: CalendarClient,
  actor: ResolvedIdentity,
  request: BookingSlotRequest,
): Promise<BookingEngineResult> {
  const auth = authorize({ role: actor.role }, 'booking.request')
  if (!auth.allowed) return { ok: false, reason: auth.reason }

  const [service] = await db
    .select()
    .from(serviceTypes)
    .where(and(eq(serviceTypes.id, request.serviceTypeId), eq(serviceTypes.businessId, actor.businessId)))
    .limit(1)

  if (!service) return { ok: false, reason: 'Service type not found' }
  if (!service.isActive) return { ok: false, reason: 'Service type is not currently available' }

  const [business] = await db
    .select({
      minBookingBufferMinutes: businesses.minBookingBufferMinutes,
      maxBookingDaysAhead: businesses.maxBookingDaysAhead,
      timezone: businesses.timezone,
      confirmationGate: businesses.confirmationGate,
      paymentMethod: businesses.paymentMethod,
    })
    .from(businesses)
    .where(eq(businesses.id, actor.businessId))
    .limit(1)

  const bufferMinutes = business?.minBookingBufferMinutes ?? 30
  const maxDaysAhead = business?.maxBookingDaysAhead ?? 365
  const businessTz = business?.timezone ?? 'UTC'
  const confirmationGate = business?.confirmationGate ?? 'immediate'
  const paymentMethod = business?.paymentMethod ?? null

  const timingError = validateSlotTiming(request.slotStart, request.slotEnd, bufferMinutes, maxDaysAhead)
  if (timingError) return { ok: false, reason: timingError }

  // Resolve provider — may override request.providerId
  const resolvedProvider = request.providerId
    ? { identityId: request.providerId, displayName: null, phoneNumber: '' }
    : await resolveProvider(db, actor.businessId, request.serviceTypeId, request.slotStart, request.slotEnd, request.providerHint)

  const effectiveProviderId = resolvedProvider?.identityId ?? null
  const effectiveRequest: typeof request = effectiveProviderId
    ? { ...request, providerId: effectiveProviderId }
    : { ...request }
  const providerDisplayName = resolvedProvider?.displayName ?? null

  const isGroupClass = (service.maxParticipants ?? 1) > 1

  if (isGroupClass) {
    return requestGroupClassBooking(db, calendar, actor, effectiveRequest, service, businessTz, confirmationGate, paymentMethod, providerDisplayName)
  }

  return requestPrivateBooking(db, calendar, actor, effectiveRequest, service, businessTz, confirmationGate, paymentMethod, providerDisplayName)
}

// ── Private (1-on-1) booking — hold/confirm two-step flow ────────────────────

async function requestPrivateBooking(
  db: Db,
  calendar: CalendarClient,
  actor: ResolvedIdentity,
  request: BookingSlotRequest,
  service: { id: string; name: string; durationMinutes: number; maxParticipants: number },
  businessTz: string,
  confirmationGate: string,
  paymentMethod: string | null,
  providerDisplayName: string | null = null,
): Promise<BookingEngineResult> {
  const holdExpiresAt = new Date(Date.now() + HOLD_EXPIRY_MINUTES * 60 * 1000)

  // Wrap conflict check + insert in a transaction to prevent race conditions.
  // The SELECT uses FOR UPDATE on the bookings table to lock conflicting rows
  // before we insert, eliminating the TOCTOU window.
  const result = await (db as unknown as { transaction: <T>(fn: (tx: typeof db) => Promise<T>) => Promise<T> })
    .transaction(async (tx) => {
      const conflicts = await tx
        .select({ id: bookings.id })
        .from(bookings)
        .where(
          and(
            eq(bookings.businessId, actor.businessId),
            or(
              and(lte(bookings.slotStart, request.slotStart), gt(bookings.slotEnd, request.slotStart)),
              and(lt(bookings.slotStart, request.slotEnd), gte(bookings.slotEnd, request.slotEnd)),
              and(gte(bookings.slotStart, request.slotStart), lte(bookings.slotEnd, request.slotEnd)),
            ),
            or(
              eq(bookings.state, 'held'),
              eq(bookings.state, 'pending_payment'),
              eq(bookings.state, 'confirmed'),
            ),
          ),
        )
        .for('update')
        .limit(1)

      if (conflicts.length > 0) return { ok: false as const, reason: 'Slot is not available' }

      const [newBooking] = await tx
        .insert(bookings)
        .values({
          businessId: actor.businessId,
          serviceTypeId: request.serviceTypeId,
          customerId: actor.id,
          providerId: request.providerId ?? null,
          requestedAt: new Date(),
          slotStart: request.slotStart,
          slotEnd: request.slotEnd,
          slotTzAtCreation: businessTz,
          state: 'requested',
        })
        .returning()

      if (!newBooking) return { ok: false as const, reason: 'Failed to create booking record' }

      return { ok: true as const, bookingId: newBooking.id }
    })

  if (!result.ok) return result

  const eventTitle = providerDisplayName ? `${service.name} — ${providerDisplayName}` : service.name
  const holdResult = await calendar.placeHold(
    { start: request.slotStart, end: request.slotEnd },
    result.bookingId,
    eventTitle,
    holdExpiresAt,
  )

  if (holdResult.status === 'conflict') {
    await markFailed(db, result.bookingId, actor.id, 'Calendar slot became occupied')
    return { ok: false, reason: 'Slot is no longer available' }
  }

  if (holdResult.status === 'error') {
    await markFailed(db, result.bookingId, actor.id, holdResult.reason)
    return { ok: false, reason: 'Could not place hold — please try again' }
  }

  if (confirmationGate === 'post_payment') {
    // Payment-first flow: set state to pending_payment, notify customer to pay
    const toPayment = transition('requested', 'pending_payment')
    if (!toPayment.ok) {
      await markFailed(db, result.bookingId, actor.id, toPayment.reason)
      return { ok: false, reason: 'Internal state error' }
    }

    await db
      .update(bookings)
      .set({
        state: 'pending_payment',
        holdExpiresAt,
        calendarEventId: holdResult.eventId,
        paymentStatus: 'pending',
        updatedAt: new Date(),
      })
      .where(eq(bookings.id, result.bookingId))

    await logAudit(db, {
      businessId: actor.businessId,
      actorId: actor.id,
      action: 'booking.pending_payment',
      entityType: 'booking',
      entityId: result.bookingId,
      beforeState: { state: 'requested' },
      afterState: { state: 'pending_payment', holdExpiresAt },
    })

    const paymentNote = paymentMethod
      ? `Please send payment via ${paymentMethod} to confirm your slot.`
      : 'Please complete payment to confirm your slot.'

    return {
      ok: true,
      bookingId: result.bookingId,
      message: paymentNote,
      pendingPayment: true,
    }
  }

  // Immediate confirmation flow (default)
  const toHeld = transition('requested', 'held')
  if (!toHeld.ok) {
    await markFailed(db, result.bookingId, actor.id, toHeld.reason)
    return { ok: false, reason: 'Internal state error' }
  }

  await db
    .update(bookings)
    .set({
      state: 'held',
      holdExpiresAt,
      calendarEventId: holdResult.eventId,
      updatedAt: new Date(),
    })
    .where(eq(bookings.id, result.bookingId))

  await logAudit(db, {
    businessId: actor.businessId,
    actorId: actor.id,
    action: 'booking.held',
    entityType: 'booking',
    entityId: result.bookingId,
    beforeState: { state: 'requested' },
    afterState: { state: 'held', holdExpiresAt, calendarEventId: holdResult.eventId },
  })

  const displayTime = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: businessTz,
  }).format(holdExpiresAt)

  return {
    ok: true,
    bookingId: result.bookingId,
    message: `Slot held until ${displayTime}. Reply CONFIRM to book.`,
  }
}

// ── Group class booking — capacity check, direct confirm ──────────────────────

async function requestGroupClassBooking(
  db: Db,
  calendar: CalendarClient,
  actor: ResolvedIdentity,
  request: BookingSlotRequest,
  service: { id: string; name: string; durationMinutes: number; maxParticipants: number },
  businessTz: string,
  confirmationGate: string,
  paymentMethod: string | null,
  providerDisplayName: string | null = null,
): Promise<BookingEngineResult> {
  const maxParticipants = service.maxParticipants

  const txResult = await (db as unknown as { transaction: <T>(fn: (tx: typeof db) => Promise<T>) => Promise<T> })
    .transaction(async (tx) => {
      // Count active bookings for this exact class slot
      const [row] = await tx
        .select({ total: count() })
        .from(bookings)
        .where(
          and(
            eq(bookings.businessId, actor.businessId),
            eq(bookings.serviceTypeId, request.serviceTypeId),
            eq(bookings.slotStart, request.slotStart),
            or(
              eq(bookings.state, 'requested'),
              eq(bookings.state, 'confirmed'),
              eq(bookings.state, 'pending_payment'),
            ),
          ),
        )
        .for('update')

      const currentCount = Number(row?.total ?? 0)
      if (currentCount >= maxParticipants) {
        return { ok: false as const, reason: `Class is full (${currentCount}/${maxParticipants} spots taken)` }
      }

      // Also prevent the same customer from double-booking the same class
      const [duplicate] = await tx
        .select({ id: bookings.id })
        .from(bookings)
        .where(
          and(
            eq(bookings.businessId, actor.businessId),
            eq(bookings.serviceTypeId, request.serviceTypeId),
            eq(bookings.slotStart, request.slotStart),
            eq(bookings.customerId, actor.id),
            or(eq(bookings.state, 'requested'), eq(bookings.state, 'confirmed')),
          ),
        )
        .limit(1)

      if (duplicate) {
        return { ok: false as const, reason: "You're already booked into this class" }
      }

      const [newBooking] = await tx
        .insert(bookings)
        .values({
          businessId: actor.businessId,
          serviceTypeId: request.serviceTypeId,
          customerId: actor.id,
          providerId: request.providerId ?? null,
          requestedAt: new Date(),
          slotStart: request.slotStart,
          slotEnd: request.slotEnd,
          slotTzAtCreation: businessTz,
          state: 'requested',
        })
        .returning()

      if (!newBooking) return { ok: false as const, reason: 'Failed to create booking record' }

      return { ok: true as const, bookingId: newBooking.id, currentCount }
    })

  if (!txResult.ok) return txResult

  // Find if a calendar event already exists for this class slot (from another participant)
  const [existingParticipant] = await db
    .select({ calendarEventId: bookings.calendarEventId })
    .from(bookings)
    .where(
      and(
        eq(bookings.businessId, actor.businessId),
        eq(bookings.serviceTypeId, request.serviceTypeId),
        eq(bookings.slotStart, request.slotStart),
        eq(bookings.state, 'confirmed'),
        isNotNull(bookings.calendarEventId),
        ne(bookings.id, txResult.bookingId),
      ),
    )
    .limit(1)

  let calendarEventId: string | null = existingParticipant?.calendarEventId ?? null

  if (!calendarEventId) {
    // First participant — create the calendar event
    const groupEventTitle = providerDisplayName ? `${service.name} — ${providerDisplayName}` : service.name
    const holdResult = await calendar.placeHold(
      { start: request.slotStart, end: request.slotEnd },
      txResult.bookingId,
      groupEventTitle,
      new Date(Date.now() + 60 * 60 * 1000), // dummy expiry; we confirm immediately
    )

    if (holdResult.status !== 'held') {
      const reason = holdResult.status === 'error' ? holdResult.reason : 'Calendar slot conflict'
      await markFailed(db, txResult.bookingId, actor.id, reason)
      return { ok: false, reason: 'Could not create calendar event — please try again' }
    }

    const confirmResult = await calendar.confirmHold(holdResult.eventId, service.name, 'Group class')
    if (confirmResult.status === 'error') {
      await markFailed(db, txResult.bookingId, actor.id, 'Calendar confirm failed')
      return { ok: false, reason: 'Could not confirm calendar event — please try again' }
    }

    calendarEventId = confirmResult.eventId
  }

  // Transition to confirmed
  await db
    .update(bookings)
    .set({ state: 'confirmed', calendarEventId, updatedAt: new Date() })
    .where(eq(bookings.id, txResult.bookingId))

  await logAudit(db, {
    businessId: actor.businessId,
    actorId: actor.id,
    action: 'booking.confirmed',
    entityType: 'booking',
    entityId: txResult.bookingId,
    beforeState: { state: 'requested' },
    afterState: { state: 'confirmed', calendarEventId, groupClass: true },
  })

  await recordCompletedBooking(db, actor.businessId, actor.id, txResult.bookingId, request.serviceTypeId)
  await scheduleReminders(actor.businessId, actor.id, txResult.bookingId, request.serviceTypeId, request.slotStart).catch(() => { /* non-fatal */ })

  const spotsLeft = maxParticipants - txResult.currentCount - 1

  return {
    ok: true,
    bookingId: txResult.bookingId,
    message: `Spot reserved in class. ${spotsLeft} spot${spotsLeft !== 1 ? 's' : ''} remaining.`,
    directlyConfirmed: true,
  }
}

export async function confirmBooking(
  db: Db,
  calendar: CalendarClient,
  actor: ResolvedIdentity,
  bookingId: string,
  customerName: string,
): Promise<BookingEngineResult> {
  const [booking] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.businessId, actor.businessId)))
    .limit(1)

  if (!booking) return { ok: false, reason: 'Booking not found' }

  if (actor.role === 'customer' && booking.customerId !== actor.id) {
    return { ok: false, reason: 'Not authorized to confirm this booking' }
  }

  if (booking.state !== 'held') {
    return { ok: false, reason: `Cannot confirm booking in state '${booking.state}'` }
  }

  if (booking.holdExpiresAt && booking.holdExpiresAt < new Date()) {
    return { ok: false, reason: 'Hold has expired — please start a new booking' }
  }

  const [service] = await db
    .select({ name: serviceTypes.name })
    .from(serviceTypes)
    .where(eq(serviceTypes.id, booking.serviceTypeId))
    .limit(1)

  const eventId = booking.calendarEventId
  if (!eventId) return { ok: false, reason: 'Booking has no calendar event' }

  const confirmResult = await calendar.confirmHold(
    eventId,
    service?.name ?? 'Appointment',
    customerName,
  )

  if (confirmResult.status === 'error') {
    return { ok: false, reason: 'Could not confirm calendar event — please try again' }
  }

  await db
    .update(bookings)
    .set({ state: 'confirmed', holdExpiresAt: null, updatedAt: new Date() })
    .where(eq(bookings.id, bookingId))

  await logAudit(db, {
    businessId: actor.businessId,
    actorId: actor.id,
    action: 'booking.confirmed',
    entityType: 'booking',
    entityId: bookingId,
    beforeState: { state: 'held' },
    afterState: { state: 'confirmed' },
  })

  await recordCompletedBooking(db, actor.businessId, actor.id, bookingId, booking.serviceTypeId)
  await scheduleReminders(actor.businessId, actor.id, bookingId, booking.serviceTypeId, booking.slotStart).catch(() => { /* non-fatal */ })

  return { ok: true, bookingId, message: 'Booking confirmed.' }
}

export async function cancelBooking(
  db: Db,
  calendar: CalendarClient,
  actor: ResolvedIdentity,
  bookingId: string,
  reason?: string,
): Promise<BookingEngineResult> {
  const [booking] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.id, bookingId), eq(bookings.businessId, actor.businessId)))
    .limit(1)

  if (!booking) return { ok: false, reason: 'Booking not found' }

  const isOwn = booking.customerId === actor.id
  const action = isOwn ? 'booking.cancel_own' : 'booking.cancel_any'
  const auth = authorize({ role: actor.role }, action)
  if (!auth.allowed) return { ok: false, reason: auth.reason }

  // Enforce cancellation cutoff policy for customers
  if (actor.role === 'customer') {
    const [biz] = await db
      .select({ cancellationCutoffMinutes: businesses.cancellationCutoffMinutes })
      .from(businesses)
      .where(eq(businesses.id, actor.businessId))
      .limit(1)

    const cutoff = biz?.cancellationCutoffMinutes ?? 0
    if (cutoff > 0 && booking.state === 'confirmed') {
      const minutesUntilSlot = (booking.slotStart.getTime() - Date.now()) / 60_000
      if (minutesUntilSlot < cutoff) {
        return {
          ok: false,
          reason: `Cancellations must be made at least ${cutoff} minutes before the appointment. Please contact the business directly.`,
        }
      }
    }
  }

  const t = transition(booking.state, 'cancelled')
  if (!t.ok) return { ok: false, reason: t.reason }

  if (booking.calendarEventId) {
    // For group classes, only delete the calendar event when the last participant cancels
    const [service] = await db
      .select({ maxParticipants: serviceTypes.maxParticipants })
      .from(serviceTypes)
      .where(eq(serviceTypes.id, booking.serviceTypeId))
      .limit(1)

    const isGroupClass = (service?.maxParticipants ?? 1) > 1

    const shouldDeleteEvent = !isGroupClass || await (async () => {
      const [row] = await db
        .select({ total: count() })
        .from(bookings)
        .where(
          and(
            eq(bookings.businessId, actor.businessId),
            eq(bookings.serviceTypeId, booking.serviceTypeId),
            eq(bookings.slotStart, booking.slotStart),
            or(eq(bookings.state, 'confirmed'), eq(bookings.state, 'requested')),
            ne(bookings.id, bookingId),
          ),
        )
      return Number(row?.total ?? 0) === 0
    })()

    if (shouldDeleteEvent) {
      const deleteResult = await calendar.deleteEvent(booking.calendarEventId)
      if (deleteResult.status === 'error') {
        return { ok: false, reason: 'Could not remove calendar event — please try again' }
      }
    }
  }

  const cancelledByRole =
    actor.role === 'manager' ? 'manager' : actor.role === 'customer' ? 'customer' : 'system'

  await db
    .update(bookings)
    .set({
      state: 'cancelled',
      cancellationReason: reason ?? null,
      cancelledByRole,
      holdExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(eq(bookings.id, bookingId))

  await logAudit(db, {
    businessId: actor.businessId,
    actorId: actor.id,
    action: 'booking.cancelled',
    entityType: 'booking',
    entityId: bookingId,
    beforeState: { state: booking.state },
    afterState: { state: 'cancelled', reason, cancelledByRole },
  })

  // Cancel any pending reminders for this booking
  cancelReminders(bookingId).catch(() => { /* non-fatal */ })

  // Trigger waitlist cascade so the freed slot can be offered to waiting customers
  triggerWaitlistForSlot(
    actor.businessId,
    booking.serviceTypeId,
    booking.slotStart,
    booking.slotEnd,
  ).catch(() => { /* non-fatal — waitlist is best-effort */ })

  return { ok: true, bookingId, message: 'Booking cancelled.' }
}

// ── Manager confirms payment received ─────────────────────────────────────────

export async function confirmPaymentReceived(
  db: Db,
  calendar: CalendarClient,
  businessId: string,
  customerPhone: string,
): Promise<BookingEngineResult> {
  // Find the manager identity to use as actor
  const [manager] = await db
    .select({ id: identities.id, role: identities.role, businessId: identities.businessId, phoneNumber: identities.phoneNumber })
    .from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.role, 'manager')))
    .limit(1)

  if (!manager) return { ok: false, reason: 'Manager identity not found' }

  // Find the customer identity
  const [customer] = await db
    .select({ id: identities.id, preferredLanguage: identities.preferredLanguage })
    .from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.phoneNumber, customerPhone)))
    .limit(1)

  if (!customer) return { ok: false, reason: `No customer found for ${customerPhone}` }

  // Find their pending_payment booking
  const [booking] = await db
    .select()
    .from(bookings)
    .where(
      and(
        eq(bookings.businessId, businessId),
        eq(bookings.customerId, customer.id),
        eq(bookings.state, 'pending_payment'),
      ),
    )
    .orderBy(bookings.createdAt)
    .limit(1)

  if (!booking) return { ok: false, reason: `No pending-payment booking found for ${customerPhone}` }

  const [service] = await db
    .select({ name: serviceTypes.name })
    .from(serviceTypes)
    .where(eq(serviceTypes.id, booking.serviceTypeId))
    .limit(1)

  const eventId = booking.calendarEventId
  if (!eventId) return { ok: false, reason: 'Booking has no calendar event' }

  const confirmResult = await calendar.confirmHold(eventId, service?.name ?? 'Appointment', customerPhone)
  if (confirmResult.status === 'error') {
    return { ok: false, reason: 'Could not confirm calendar event' }
  }

  await db
    .update(bookings)
    .set({ state: 'confirmed', paymentStatus: 'paid', holdExpiresAt: null, updatedAt: new Date() })
    .where(eq(bookings.id, booking.id))

  await logAudit(db, {
    businessId,
    actorId: manager.id,
    action: 'booking.confirmed',
    entityType: 'booking',
    entityId: booking.id,
    beforeState: { state: 'pending_payment' },
    afterState: { state: 'confirmed', paymentStatus: 'paid' },
    metadata: { triggeredBy: 'manager_paid_command' },
  })

  await recordCompletedBooking(db, businessId, customer.id, booking.id, booking.serviceTypeId)
  await scheduleReminders(businessId, customer.id, booking.id, booking.serviceTypeId, booking.slotStart).catch(() => { /* non-fatal */ })

  // Send confirmation to the customer
  const [biz] = await db
    .select({ name: businesses.name, timezone: businesses.timezone, defaultLanguage: businesses.defaultLanguage })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)

  if (biz && service) {
    const lang: Lang = (customer.preferredLanguage as Lang | null | undefined)
      ?? (biz.defaultLanguage as Lang | null | undefined)
      ?? 'he'
    const locale = lang === 'he' ? 'he-IL' : 'en-GB'
    const tz = biz.timezone
    const dateStr = new Intl.DateTimeFormat(locale, {
      timeZone: tz, weekday: 'long', day: 'numeric', month: 'long',
    }).format(booking.slotStart)
    const timeStr = new Intl.DateTimeFormat(locale, {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(booking.slotStart)
    await enqueueMessage(
      customerPhone,
      i18n.payment_confirmed[lang](service.name, biz.name, dateStr, timeStr),
    ).catch(() => { /* non-fatal */ })
  }

  return { ok: true, bookingId: booking.id, message: `Booking confirmed for ${customerPhone}.` }
}

async function markFailed(db: Db, bookingId: string, actorId: string, reason: string) {
  await db
    .update(bookings)
    .set({ state: 'failed', updatedAt: new Date() })
    .where(eq(bookings.id, bookingId))

  await logAudit(db, {
    businessId: '',
    actorId,
    action: 'booking.failed',
    entityType: 'booking',
    entityId: bookingId,
    afterState: { state: 'failed', reason },
  })
}
