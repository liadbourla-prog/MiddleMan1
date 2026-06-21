// Bridges the booking record to the owner-facing calendar event text.
//
// Pure rendering lives in event-content.ts; this module gathers the structured
// facts from the DB (service, customer, instructor, group roster), resolves the
// OWNER's language (the calendar is read by the owner, so we use the business
// default language — never the customer's preference), and renders.
//
// Group descriptions are a live roster: refreshGroupEventRoster re-renders and
// patches the shared event whenever a participant joins or leaves, so the owner
// always sees the current headcount and attendee list.

import { and, eq, or, asc } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { bookings, businesses, identities, serviceTypes } from '../../db/schema.js'
import type { CalendarClient } from '../../adapters/calendar/client.js'
import type { Lang } from '../i18n/t.js'
import { renderBookingEvent, type EventPerson, type RenderedEvent } from './event-content.js'

// States that occupy a seat in a class (mirrors the capacity count in engine.ts).
const ACTIVE_STATES = ['requested', 'confirmed', 'pending_payment'] as const

async function resolveOwnerLang(db: Db, businessId: string): Promise<Lang> {
  const [biz] = await db
    .select({ defaultLanguage: businesses.defaultLanguage })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)
  return (biz?.defaultLanguage as Lang | null | undefined) ?? 'he'
}

async function resolvePerson(db: Db, identityId: string | null): Promise<EventPerson> {
  if (!identityId) return { name: null, phone: null }
  const [row] = await db
    .select({ name: identities.displayName, phone: identities.phoneNumber })
    .from(identities)
    .where(eq(identities.id, identityId))
    .limit(1)
  return { name: row?.name ?? null, phone: row?.phone ?? null }
}

// Renders the title + description for a confirmed 1-on-1 booking. Returns null if
// the service can't be found (caller falls back to a plain title).
export async function buildOneOnOneEventContent(
  db: Db,
  businessId: string,
  opts: { serviceTypeId: string; customerId: string; providerId: string | null },
): Promise<RenderedEvent | null> {
  const [service] = await db
    .select({ name: serviceTypes.name, durationMinutes: serviceTypes.durationMinutes })
    .from(serviceTypes)
    .where(eq(serviceTypes.id, opts.serviceTypeId))
    .limit(1)
  if (!service) return null

  const [lang, customer, instructor] = await Promise.all([
    resolveOwnerLang(db, businessId),
    resolvePerson(db, opts.customerId),
    resolvePerson(db, opts.providerId),
  ])

  return renderBookingEvent(
    {
      kind: 'one_on_one',
      serviceName: service.name,
      durationMinutes: service.durationMinutes,
      customer,
      instructorName: instructor.name,
    },
    lang,
  )
}

// Re-renders and patches the shared group-class event for a slot from its current
// roster. Best-effort: never throws (calendar UI must not break a booking).
export async function refreshGroupEventRoster(
  db: Db,
  calendar: CalendarClient,
  businessId: string,
  serviceTypeId: string,
  slotStart: Date,
): Promise<void> {
  try {
    const [service] = await db
      .select({ name: serviceTypes.name, maxParticipants: serviceTypes.maxParticipants })
      .from(serviceTypes)
      .where(eq(serviceTypes.id, serviceTypeId))
      .limit(1)
    if (!service) return

    const rows = await db
      .select({
        calendarEventId: bookings.calendarEventId,
        providerId: bookings.providerId,
        name: identities.displayName,
        phone: identities.phoneNumber,
      })
      .from(bookings)
      .leftJoin(identities, eq(bookings.customerId, identities.id))
      .where(
        and(
          eq(bookings.businessId, businessId),
          eq(bookings.serviceTypeId, serviceTypeId),
          eq(bookings.slotStart, slotStart),
          or(...ACTIVE_STATES.map((s) => eq(bookings.state, s))),
        ),
      )
      .orderBy(asc(bookings.createdAt))

    const eventId = rows.find((r) => r.calendarEventId)?.calendarEventId
    if (!eventId) return // no calendar event for this slot (e.g. last seat just freed)

    const instructorId = rows.find((r) => r.providerId)?.providerId ?? null
    const [lang, instructor] = await Promise.all([
      resolveOwnerLang(db, businessId),
      resolvePerson(db, instructorId),
    ])

    const attendees: EventPerson[] = rows.map((r) => ({ name: r.name ?? null, phone: r.phone ?? null }))

    const rendered = renderBookingEvent(
      {
        kind: 'group',
        serviceName: service.name,
        instructorName: instructor.name,
        maxParticipants: service.maxParticipants,
        attendees,
      },
      lang,
    )

    await calendar.updateEventDetails(eventId, rendered.title, rendered.description)
  } catch (err) {
    console.error('[booking-event] refreshGroupEventRoster failed:', err)
  }
}
