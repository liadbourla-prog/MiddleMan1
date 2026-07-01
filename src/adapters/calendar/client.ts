import { google } from 'googleapis'
import { useNativeFetch } from '../google/native-fetch.js'
import { and, eq, gt, lte, lt, gte, or } from 'drizzle-orm'
import type {
  CalendarSlot,
  AvailabilityResult,
  HoldResult,
  PlaceHoldOptions,
  ConfirmResult,
  DeleteResult,
  ListedEvent,
  MirrorEventInput,
  MirrorResult,
  WatchResult,
  StopChannelResult,
  IncrementalSyncResult,
  IncrementalSyncOptions,
  RawCalendarEvent,
} from './types.js'
import { sendMessage } from '../whatsapp/sender.js'
import { i18n, type Lang } from '../../domain/i18n/t.js'
import type { CalendarListEntry } from '../../domain/calendar/calendar-id.js'

const HOLD_PREFIX = '[HOLD]'
const HOLD_COLOR_ID = '5' // banana — visually distinct in Google Calendar

// C0.2 — hard deadline on Google calls. There is otherwise NO timeout anywhere in
// this client, so a hanging Google response (a customer reply, the reconcile tick)
// would stall the caller indefinitely. An AbortController deadline caps every
// incrementalSync so the caller always falls back to the internal record. Tunable
// via GOOGLE_CALL_TIMEOUT_MS (evaluated per-call so ops/tests can override).
const DEFAULT_GOOGLE_CALL_TIMEOUT_MS = 15_000
function googleCallTimeoutMs(): number {
  const raw = Number(process.env['GOOGLE_CALL_TIMEOUT_MS'])
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GOOGLE_CALL_TIMEOUT_MS
}

function buildOAuth2Client() {
  const client = useNativeFetch(new google.auth.OAuth2(
    process.env['GOOGLE_CLIENT_ID'],
    process.env['GOOGLE_CLIENT_SECRET'],
    process.env['GOOGLE_REDIRECT_URI'],
  ))
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
  lang?: Lang
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
    opts?: PlaceHoldOptions,
  ): Promise<HoldResult> {
    // Group-class bookings skip the conflict probe: capacity for the instance is the
    // authority (enforced by the engine's advisory-lock + count), and many bookings
    // legitimately share one class slot. See PlaceHoldOptions for the rationale.
    if (!opts?.skipConflictCheck) {
      const availability = await checkAvailability(slot)
      if (availability.status === 'occupied') return { status: 'conflict' }
      if (availability.status === 'error') return { status: 'error', reason: availability.reason }
    }
    // For internal mode the booking row IS the hold — use bookingId as the event id
    return { status: 'held', eventId: `internal:${bookingId}` }
  }

  async function confirmHold(
    eventId: string,
    _summary: string,
    _description: string,
  ): Promise<ConfirmResult> {
    // Nothing to do — DB booking row state is managed by booking engine
    return { status: 'confirmed', eventId }
  }

  async function updateEventDetails(
    _eventId: string,
    _summary: string,
    _description: string,
  ): Promise<void> {
    // No Google calendar to patch in internal mode.
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

  async function listEvents(from: Date, to: Date): Promise<ListedEvent[]> {
    const { db } = await import('../../db/client.js')
    const { bookings: bookingsTable, identities: identitiesTable } = await import('../../db/schema.js')
    const rows = await db
      .select({
        id: bookingsTable.id,
        slotStart: bookingsTable.slotStart,
        slotEnd: bookingsTable.slotEnd,
        state: bookingsTable.state,
        customerName: identitiesTable.displayName,
      })
      .from(bookingsTable)
      .leftJoin(identitiesTable, eq(bookingsTable.customerId, identitiesTable.id))
      .where(and(
        eq(bookingsTable.businessId, businessId),
        gte(bookingsTable.slotStart, from),
        lte(bookingsTable.slotStart, to),
        or(eq(bookingsTable.state, 'confirmed'), eq(bookingsTable.state, 'held')),
      ))
    return rows.map((r) => ({
      eventId: r.id,
      title: r.customerName ? `Booking — ${r.customerName}` : 'Booking',
      start: r.slotStart,
      end: r.slotEnd,
      isBooking: true,
    }))
  }

  async function createPersonalEvent(slot: CalendarSlot, summary: string, description?: string): Promise<ConfirmResult> {
    return createConfirmedEvent(slot, summary, description ?? '')
  }

  // Internal mode has no Google calendar — the outbound mirror is a no-op.
  // Return a stable internal id so callers can store linkage uniformly.
  async function upsertMirrorEvent(input: MirrorEventInput): Promise<MirrorResult> {
    return { status: 'ok', eventId: input.googleEventId ?? `internal:${Date.now()}`, etag: null }
  }

  // Inbound sync is a Google-only concern — internal mode has no push channels.
  async function watchEvents(): Promise<WatchResult> {
    return { status: 'error', reason: 'internal mode has no watch channels' }
  }
  async function stopChannel(): Promise<StopChannelResult> {
    return { status: 'ok' }
  }
  async function incrementalSync(): Promise<IncrementalSyncResult> {
    return { status: 'ok', events: [], nextSyncToken: null }
  }

  // Internal mode has no Google account — there are no selectable calendars.
  async function listCalendars(): Promise<CalendarListEntry[]> {
    return []
  }

  return { checkAvailability, placeHold, confirmHold, updateEventDetails, deleteEvent, createConfirmedEvent, listEvents, createPersonalEvent, upsertMirrorEvent, watchEvents, stopChannel, incrementalSync, listCalendars }
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
          const lang: Lang = options.lang ?? 'he'
          await sendMessage({
            toNumber: options.managerPhoneNumber,
            body: i18n.calendar_auth_expired[lang],
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
    opts?: PlaceHoldOptions,
  ): Promise<HoldResult> {
    // Group-class bookings skip the freebusy probe. A class instance is itself a
    // mirrored Google event, so freebusy.query reports its own hour as busy and would
    // mark the FIRST booking into every class a false 'conflict' (the live "session
    // fully booked" bug). Capacity is enforced authoritatively by the engine's
    // advisory-lock + count, not here. See PlaceHoldOptions.
    if (!opts?.skipConflictCheck) {
      const availability = await checkAvailability(slot)
      if (availability.status === 'occupied') return { status: 'conflict' }
      if (availability.status === 'error') return { status: 'error', reason: availability.reason }
    }

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
            // Linkage for inbound loop prevention (Phase 3): mark this as a
            // PA-managed booking event so owner-edit sync can tell it apart from
            // the owner's own calendar entries.
            extendedProperties: { private: { paManaged: '1', paType: 'booking', paId: bookingId } },
          },
        }),
      )

      const eventId = response.data.id
      if (!eventId) return { status: 'error', reason: 'Calendar returned no event id' }
      return { status: 'held', eventId, etag: response.data.etag ?? null }
    } catch (err) {
      return { status: 'error', reason: extractErrorMessage(err) }
    }
  }

  async function confirmHold(
    eventId: string,
    summary: string,
    description: string,
  ): Promise<ConfirmResult> {
    try {
      const response = await withTokenRefresh(() =>
        calendar.events.patch({
          calendarId,
          eventId,
          requestBody: {
            summary,
            description,
            colorId: confirmedColorId,
            status: 'confirmed',
          },
        }),
      )

      const id = response.data.id
      if (!id) return { status: 'error', reason: 'Calendar returned no event id on confirm' }
      return { status: 'confirmed', eventId: id, etag: response.data.etag ?? null }
    } catch (err) {
      return { status: 'error', reason: extractErrorMessage(err) }
    }
  }

  // Patches only the owner-facing title + description of an existing event (used to
  // keep a group class's live roster current). Leaves status/color/timing untouched.
  // Best-effort: logs and swallows errors so calendar UI never breaks a booking.
  async function updateEventDetails(
    eventId: string,
    summary: string,
    description: string,
  ): Promise<void> {
    if (eventId.startsWith('internal:')) return
    try {
      await withTokenRefresh(() =>
        calendar.events.patch({ calendarId, eventId, requestBody: { summary, description } }),
      )
    } catch (err) {
      console.error('[calendar] updateEventDetails failed:', extractErrorMessage(err))
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

  async function listEvents(from: Date, to: Date): Promise<ListedEvent[]> {
    try {
      const response = await withTokenRefresh(() =>
        calendar.events.list({
          calendarId,
          timeMin: from.toISOString(),
          timeMax: to.toISOString(),
          singleEvents: true,
          orderBy: 'startTime',
          maxResults: 50,
          fields: 'items(id,summary,start,end)',
        }),
      )
      return (response.data.items ?? []).map((ev) => ({
        eventId: ev.id ?? '',
        title: ev.summary ?? '(no title)',
        start: new Date(ev.start?.dateTime ?? ev.start?.date ?? ''),
        end: new Date(ev.end?.dateTime ?? ev.end?.date ?? ''),
        isBooking: (ev.summary ?? '').includes(HOLD_PREFIX) || false,
      }))
    } catch (err) {
      throw new Error(`Calendar listEvents failed: ${extractErrorMessage(err)}`)
    }
  }

  async function createPersonalEvent(slot: CalendarSlot, summary: string, description?: string): Promise<ConfirmResult> {
    return createConfirmedEvent(slot, summary, description ?? '')
  }

  // Outbound mirror write (Phase 2). Inserts or patches a PA-managed event,
  // stamping linkage into extendedProperties.private (decision 9) and returning
  // the Google etag so the caller can record it for inbound loop prevention.
  async function upsertMirrorEvent(input: MirrorEventInput): Promise<MirrorResult> {
    const privateProps: Record<string, string> = { paManaged: '1', ...input.privateProps }
    const requestBody = {
      summary: input.summary,
      ...(input.description !== undefined ? { description: input.description } : {}),
      start: { dateTime: input.start.toISOString() },
      end: { dateTime: input.end.toISOString() },
      ...(input.colorId != null ? { colorId: String(input.colorId) } : {}),
      status: 'confirmed',
      extendedProperties: { private: privateProps },
    }
    try {
      if (input.googleEventId && !input.googleEventId.startsWith('internal:')) {
        const response = await withTokenRefresh(() =>
          calendar.events.patch({ calendarId, eventId: input.googleEventId as string, requestBody }),
        )
        const id = response.data.id
        if (!id) return { status: 'error', reason: 'Calendar returned no event id on mirror patch' }
        return { status: 'ok', eventId: id, etag: response.data.etag ?? null }
      }
      const response = await withTokenRefresh(() =>
        calendar.events.insert({ calendarId, requestBody }),
      )
      const id = response.data.id
      if (!id) return { status: 'error', reason: 'Calendar returned no event id on mirror insert' }
      return { status: 'ok', eventId: id, etag: response.data.etag ?? null }
    } catch (err: unknown) {
      // A patch against a since-deleted event (404/410) is recoverable: fall back
      // to an insert so the mirror self-heals instead of getting stuck.
      if (input.googleEventId && isGoogleApiError(err) && (err.code === 404 || err.code === 410)) {
        try {
          const response = await withTokenRefresh(() =>
            calendar.events.insert({ calendarId, requestBody }),
          )
          const id = response.data.id
          if (!id) return { status: 'error', reason: 'Calendar returned no event id on mirror re-insert' }
          return { status: 'ok', eventId: id, etag: response.data.etag ?? null }
        } catch (reErr) {
          return { status: 'error', reason: extractErrorMessage(reErr) }
        }
      }
      return { status: 'error', reason: extractErrorMessage(err) }
    }
  }

  // ── Inbound sync (Phase 3) ────────────────────────────────────────────────

  // Register a push (watch) channel on the events resource. Google delivers a
  // POST to `address` whenever the calendar changes; we then pull incrementally.
  async function watchEvents(
    channelId: string,
    address: string,
    channelToken: string,
    ttlMs: number,
  ): Promise<WatchResult> {
    try {
      const response = await withTokenRefresh(() =>
        calendar.events.watch({
          calendarId,
          requestBody: {
            id: channelId,
            type: 'web_hook',
            address,
            token: channelToken,
            params: { ttl: String(Math.floor(ttlMs / 1000)) },
          },
        }),
      )
      const expMs = response.data.expiration ? Number(response.data.expiration) : null
      return {
        status: 'ok',
        resourceId: response.data.resourceId ?? null,
        expiration: expMs ? new Date(expMs) : null,
      }
    } catch (err) {
      return { status: 'error', reason: extractErrorMessage(err) }
    }
  }

  async function stopChannel(channelId: string, resourceId: string): Promise<StopChannelResult> {
    try {
      await withTokenRefresh(() => calendar.channels.stop({ requestBody: { id: channelId, resourceId } }))
      return { status: 'ok' }
    } catch (err: unknown) {
      // Already-stopped / unknown channel is fine — the end state is what we want.
      if (isGoogleApiError(err) && (err.code === 404 || err.code === 410)) return { status: 'ok' }
      return { status: 'error', reason: extractErrorMessage(err) }
    }
  }

  // Pull events. With a syncToken we get only what changed since last sync; without
  // one we do a windowed full reconcile. A 410 means the token expired ⇒ caller must
  // re-seed with a full reconcile. Paginates internally and returns nextSyncToken.
  async function incrementalSync(opts: IncrementalSyncOptions): Promise<IncrementalSyncResult> {
    // C0.2 — one deadline covering the whole (possibly multi-page) sync, so a hang
    // on ANY page can never stall the caller. On abort the signalled events.list
    // rejects; we translate that into a plain error result (never a throw).
    const timeoutMs = googleCallTimeoutMs()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const events: RawCalendarEvent[] = []
      let pageToken: string | undefined
      let nextSyncToken: string | null = null
      do {
        const response = await withTokenRefresh(() =>
          calendar.events.list(
            {
              calendarId,
              singleEvents: true,
              showDeleted: true,
              maxResults: 250,
              ...(opts.syncToken
                ? { syncToken: opts.syncToken }
                : {
                    timeMin: (opts.timeMin ?? new Date()).toISOString(),
                    ...(opts.timeMax ? { timeMax: opts.timeMax.toISOString() } : {}),
                  }),
              ...(pageToken ? { pageToken } : {}),
            },
            { signal: controller.signal },
          ),
        )
        for (const ev of response.data.items ?? []) events.push(mapRawEvent(ev))
        pageToken = response.data.nextPageToken ?? undefined
        if (response.data.nextSyncToken) nextSyncToken = response.data.nextSyncToken
      } while (pageToken)
      return { status: 'ok', events, nextSyncToken }
    } catch (err: unknown) {
      if (isGoogleApiError(err) && err.code === 410) return { status: 'expired' }
      if (controller.signal.aborted) {
        return { status: 'error', reason: `Google incrementalSync timed out after ${timeoutMs}ms` }
      }
      return { status: 'error', reason: extractErrorMessage(err) }
    } finally {
      clearTimeout(timer)
    }
  }

  // List the calendars the connected account can see, so the OAuth callback can
  // pick a VALID googleCalendarId and the owner can later switch to a secondary
  // calendar. Only owner/writer calendars are usable as write targets; the caller
  // (chooseCalendarId) filters by accessRole.
  async function listCalendars(): Promise<CalendarListEntry[]> {
    const response = await withTokenRefresh(() =>
      calendar.calendarList.list({ fields: 'items(id,summary,accessRole,primary)', maxResults: 250 }),
    )
    return (response.data.items ?? []).map((c) => ({
      id: c.id ?? '',
      summary: c.summary ?? '(untitled)',
      accessRole: c.accessRole ?? 'reader',
      primary: c.primary ?? false,
    })).filter((c) => c.id !== '')
  }

  return { checkAvailability, placeHold, confirmHold, updateEventDetails, deleteEvent, createConfirmedEvent, listEvents, createPersonalEvent, upsertMirrorEvent, watchEvents, stopChannel, incrementalSync, listCalendars }
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

// Normalize a Google Calendar API event into the inbound-sync shape. Pulls PA
// linkage from extendedProperties.private and tolerates all-day (date) vs timed
// (dateTime) events. Owner titles are carried in `summary` but callers treat
// owner-originated events as opaque (never surfaced).
type GoogleApiEvent = {
  id?: string | null
  status?: string | null
  summary?: string | null
  description?: string | null
  etag?: string | null
  start?: { dateTime?: string | null; date?: string | null } | null
  end?: { dateTime?: string | null; date?: string | null } | null
  extendedProperties?: { private?: Record<string, string> | null } | null
}

function mapRawEvent(ev: GoogleApiEvent): RawCalendarEvent {
  const priv = ev.extendedProperties?.private ?? {}
  const startRaw = ev.start?.dateTime ?? ev.start?.date ?? null
  const endRaw = ev.end?.dateTime ?? ev.end?.date ?? null
  return {
    eventId: ev.id ?? '',
    status: ev.status ?? null,
    summary: ev.summary ?? null,
    description: ev.description ?? null,
    start: startRaw ? new Date(startRaw) : null,
    end: endRaw ? new Date(endRaw) : null,
    etag: ev.etag ?? null,
    paManaged: priv['paManaged'] === '1',
    paType: priv['paType'] ?? null,
    paId: priv['paId'] ?? null,
  }
}
