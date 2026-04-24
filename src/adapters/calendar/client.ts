import { google } from 'googleapis'
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
  managerPhoneNumber?: string | undefined
}

export function createCalendarClient(options: CalendarClientOptions) {
  const auth = buildOAuth2Client()
  auth.setCredentials({
    access_token: options.accessToken || null,
    refresh_token: options.refreshToken,
  })
  const calendar = google.calendar({ version: 'v3', auth })
  const calendarId = options.calendarId

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
            colorId: '2',
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
            colorId: '2',
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

export type CalendarClient = ReturnType<typeof createCalendarClient>

function extractErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function isGoogleApiError(err: unknown): err is { code: number } {
  return typeof err === 'object' && err !== null && 'code' in err
}
