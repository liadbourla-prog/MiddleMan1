import { google } from 'googleapis'
import { and, eq, gt, lte, lt, gte, or } from 'drizzle-orm'
import type {
  CalendarSlot,
  AvailabilityResult,
  HoldResult,
  ConfirmResult,
  DeleteResult,
} from './types.js'
import { sendMessage } from '../whatsapp/sender.js'

const HOLD_PREFIX = '[HOLD]'
const HOLD_COLOR_ID = '5' // banana — visually distinct in Google Calendar

function buildOAuth2Client() {
  const client = new google.auth.OAuth2(
    process.env['GOOGLE_CLIENT_ID'],
    process.env['GOOGLE_CLIENT_SECRET'],
    process.env['GOOGLE_REDIRECT_URI'],
  )
  return client
}

interface CalendarClientOptions {
  accessToken: string
  refreshToken: string
  calendarId: string
  businessId?: string
  calendarMode?: 'google' | 'internal'
  colorId?: number | null
  managerPhoneNumber?: string | undefined
}

// ── Internal DB calendar (no Google) ─────────────────────────────────────────

function createInternalCalendarClient(options: CalendarClientOptions) {
  const businessId = options.businessId ?? options.calendarId

  async function checkAvailability(slot: CalendarSlot): Promise<AvailabilityResult> {
    try {
      const { db } = await import('../../db/client.js')
      const { bookings } = await import('../../db/schema.js')
      const conflicts = await db
        .select({ id: bookings.id })
        .from(bookings)
        .where(
          and(
            eq(bookings.businessId, businessId),
            or(
              and(lte(bookings.slotStart, slot.start), gt(bookings.slotEnd, slot.start)),
              and(lt(bookings.slotStart, slot.end), gte(bookings.slotEnd, slot.end)),
              and(gte(bookings.slotStart, slot.start), lte(bookings.slotEnd, slot.end)),
            ),
            or(
              eq(bookings.state, 'held'),
              eq(bookings.state, 'pending_payment'),
              eq(bookings.state, 'confirmed'),
            ),
          ),
        )
        .limit(1)

      return conflicts.length > 0 ? { status: 'occupied' } : { status: 'available' }
    } catch (err) {
      return { status: 'error', reason: extractErrorMessage(err) }
    }
  }

  async function placeHold(
    slot: CalendarSlot,
    bookingId: string,
    _serviceName: string,
    _expiresAt: Date,
  ): Promise<HoldResult> {
    const availability = await checkAvailability(slot)
    if (availability.status === 'occupied') return { status: 'conflict' }
    if (availability.status === 'error') return { status: 'error', reason: availability.reason }
    // For internal mode the booking row IS the hold — use bookingId as the event id
    return { status: 'held', eventId: `internal:${bookingId}` }
  }

  async function confirmHold(
    eventId: string,
    _summary: string,
    _customerName: string,
  ): Promise<ConfirmResult> {
    // Nothing to do — DB booking row state is managed by booking engine
    return { status: 'confirmed', eventId }
  }

  async function deleteEvent(_eventId: string): Promise<DeleteResult> {
    // Deletion is handled by the booking engine (state → cancelled/expired)
    return { status: 'deleted' }
  }

  async function createConfirmedEvent(
    _slot: CalendarSlot,
    _summary: string,
    _description: string,
  ): Promise<ConfirmResult> {
    const eventId = `internal:${Date.now()}`
    return { status: 'confirmed', eventId }
  }

  return { checkAvailability, placeHold, confirmHold, deleteEvent, createConfirmedEvent }
}

// ── Google Calendar ───────────────────────────────────────────────────────────

function createGoogleCalendarClient(options: CalendarClientOptions) {
  const auth = buildOAuth2Client()
  auth.setCredentials({
    access_token: options.accessToken || null,
    refresh_token: options.refreshToken,
  })
  const calendar = google.calendar({ version: 'v3', auth })
  const calendarId = options.calendarId
  // colorId for confirmed events: per-service setting or default green (2)
  const confirmedColorId = options.colorId != null ? String(options.colorId) : '2'

  async function withTokenRefresh<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err: unknown) {
      const isAuthError =
        isGoogleApiError(err) && (err.code === 401 || err.code === 403)
      if (!isAuthError) throw err

      try {
        const { credentials } = await auth.refreshAccessToken()
        auth.setCredentials(credentials)
        return await fn()
      } catch (refreshErr) {
        if (options.managerPhoneNumber) {
          await sendMessage({
            toNumber: options.managerPhoneNumber,
            body: 'Your Google Calendar connection has expired and could not be refreshed automatically. Please reconnect your calendar.',
          }).catch(() => { /* non-fatal */ })
        }
        throw refreshErr
      }
    }
  }

  async function checkAvailability(slot: CalendarSlot): Promise<AvailabilityResult> {
    try {
      const response = await withTokenRefresh(() =>
        calendar.freebusy.query({
          requestBody: {
            timeMin: slot.start.toISOString(),
            timeMax: slot.end.toISOString(),
            items: [{ id: calendarId }],
          },
        }),
      )

      const busySlots = response.data.calendars?.[calendarId]?.busy ?? []
      if (busySlots.length > 0) return { status: 'occupied' }
      return { status: 'available' }
    } catch (err) {
      return { status: 'error', reason: extractErrorMessage(err) }
    }
  }

  async function placeHold(
    slot: CalendarSlot,
    bookingId: string,
    serviceName: string,
    expiresAt: Date,
  ): Promise<HoldResult> {
    const availability = await checkAvailability(slot)
    if (availability.status === 'occupied') return { status: 'conflict' }
    if (availability.status === 'error') return { status: 'error', reason: availability.reason }

    try {
      const response = await withTokenRefresh(() =>
        calendar.events.insert({
          calendarId,
          requestBody: {
            summary: `${HOLD_PREFIX} ${serviceName}`,
            description: JSON.stringify({ bookingId, expiresAt: expiresAt.toISOString() }),
            start: { dateTime: slot.start.toISOString() },
            end: { dateTime: slot.end.toISOString() },
            colorId: HOLD_COLOR_ID,
            status: 'tentative',
          },
        }),
      )

      const eventId = response.data.id
      if (!eventId) return { status: 'error', reason: 'Calendar returned no event id' }
      return { status: 'held', eventId }
    } catch (err) {
      return { status: 'error', reason: extractErrorMessage(err) }
    }
  }

  async function confirmHold(
    eventId: string,
    summary: string,
    customerName: string,
  ): Promise<ConfirmResult> {
    try {
      const response = await withTokenRefresh(() =>
        calendar.events.patch({
          calendarId,
          eventId,
          requestBody: {
            summary,
            description: `Confirmed booking for ${customerName}`,
            colorId: confirmedColorId,
            status: 'confirmed',
          },
        }),
      )

      const id = response.data.id
      if (!id) return { status: 'error', reason: 'Calendar returned no event id on confirm' }
      return { status: 'confirmed', eventId: id }
    } catch (err) {
      return { status: 'error', reason: extractErrorMessage(err) }
    }
  }

  async function deleteEvent(eventId: string): Promise<DeleteResult> {
    // Internal-mode events don't touch Google Calendar
    if (eventId.startsWith('internal:')) return { status: 'deleted' }
    try {
      await withTokenRefresh(() => calendar.events.delete({ calendarId, eventId }))
      return { status: 'deleted' }
    } catch (err: unknown) {
      if (isGoogleApiError(err) && err.code === 404) return { status: 'not_found' }
      return { status: 'error', reason: extractErrorMessage(err) }
    }
  }

  async function createConfirmedEvent(
    slot: CalendarSlot,
    summary: string,
    description: string,
  ): Promise<ConfirmResult> {
    try {
      const response = await withTokenRefresh(() =>
        calendar.events.insert({
          calendarId,
          requestBody: {
            summary,
            description,
            start: { dateTime: slot.start.toISOString() },
            end: { dateTime: slot.end.toISOString() },
            colorId: confirmedColorId,
            status: 'confirmed',
          },
        }),
      )

      const eventId = response.data.id
      if (!eventId) return { status: 'error', reason: 'Calendar returned no event id' }
      return { status: 'confirmed', eventId }
    } catch (err) {
      return { status: 'error', reason: extractErrorMessage(err) }
    }
  }

  return { checkAvailability, placeHold, confirmHold, deleteEvent, createConfirmedEvent }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createCalendarClient(options: CalendarClientOptions) {
  if (options.calendarMode === 'internal') {
    return createInternalCalendarClient(options)
  }
  return createGoogleCalendarClient(options)
}

export type CalendarClient = ReturnType<typeof createCalendarClient>

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function isGoogleApiError(err: unknown): err is { code: number } {
  return typeof err === 'object' && err !== null && 'code' in err
}
