// Owner-facing Google Calendar event text for confirmed bookings.
//
// Rendered deterministically from structured booking data — never by the LLM
// (CLAUDE.md principle #1). The owner opens their calendar and sees at a glance
// who they are meeting, how to reach them, the service, and who is running the
// session (a staff member / instructor, or — when no one is named — themselves).
//
// Linkage (bookingId, etc.) is deliberately NOT placed here: it lives in
// extendedProperties.private per CALENDAR_UX_DESIGN.md decision #9, so the owner
// can read or edit this text without breaking sync.
//
// Formatting follows CHAT_LEVEL_LAWBOOK.md §3.2 — one language per render, phone
// numbers verbatim, numbers as digits, no emojis. Clean label: value lines only.

import type { Lang } from '../i18n/t.js'

export interface EventPerson {
  name: string | null
  phone: string | null
}

export interface OneOnOneEventContent {
  kind: 'one_on_one'
  serviceName: string
  durationMinutes: number
  customer: EventPerson
  // null ⇒ the owner runs it themselves; the staff line is omitted.
  instructorName: string | null
}

export interface GroupEventContent {
  kind: 'group'
  serviceName: string
  instructorName: string | null
  maxParticipants: number
  // Active participants in booking order.
  attendees: EventPerson[]
}

export interface MeetingEventContent {
  kind: 'meeting'
  title: string
  contact: EventPerson
}

export type BookingEventContent = OneOnOneEventContent | GroupEventContent | MeetingEventContent

export interface RenderedEvent {
  title: string
  description: string
}

const LABELS = {
  he: {
    client: 'לקוח',
    phone: 'טלפון',
    service: 'שירות',
    staff: 'צוות',
    minutes: 'דק׳',
    groupSession: 'שיעור קבוצתי',
    instructor: 'מדריך',
    booked: 'נרשמו',
    of: 'מתוך',
    attendees: 'משתתפים',
    noName: 'ללא שם',
    with: 'עם',
  },
  en: {
    client: 'Client',
    phone: 'Phone',
    service: 'Service',
    staff: 'Staff',
    minutes: 'min',
    groupSession: 'Group session',
    instructor: 'Instructor',
    booked: 'Booked',
    of: 'of',
    attendees: 'Attendees',
    noName: 'No name',
    with: 'With',
  },
} as const

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function personLabel(p: EventPerson, noName: string): string {
  return clean(p.name) ?? clean(p.phone) ?? noName
}

export function renderBookingEvent(content: BookingEventContent, lang: Lang): RenderedEvent {
  const L = LABELS[lang]

  if (content.kind === 'one_on_one') {
    const who = personLabel(content.customer, L.noName)
    const lines: string[] = [`${L.client}: ${who}`]

    const phone = clean(content.customer.phone)
    if (phone) lines.push(`${L.phone}: ${phone}`)

    lines.push(`${L.service}: ${content.serviceName} (${content.durationMinutes} ${L.minutes})`)

    const instructor = clean(content.instructorName)
    if (instructor) lines.push(`${L.staff}: ${instructor}`)

    return { title: `${content.serviceName} — ${who}`, description: lines.join('\n') }
  }

  if (content.kind === 'meeting') {
    const who = personLabel(content.contact, L.noName)
    const lines: string[] = [`${L.with}: ${who}`]
    const phone = clean(content.contact.phone)
    if (phone) lines.push(`${L.phone}: ${phone}`)
    return { title: `${content.title} — ${who}`, description: lines.join('\n') }
  }

  const n = content.attendees.length
  const lines: string[] = [`${L.groupSession}: ${content.serviceName}`]

  const instructor = clean(content.instructorName)
  if (instructor) lines.push(`${L.instructor}: ${instructor}`)

  lines.push(`${L.booked}: ${n} ${L.of} ${content.maxParticipants}`)

  if (n > 0) {
    lines.push('')
    lines.push(`${L.attendees}:`)
    content.attendees.forEach((a, i) => {
      const who = personLabel(a, L.noName)
      const phone = clean(a.phone)
      lines.push(phone ? `${i + 1}. ${who} — ${phone}` : `${i + 1}. ${who}`)
    })
  }

  return { title: `${content.serviceName} — ${n}/${content.maxParticipants}`, description: lines.join('\n') }
}
