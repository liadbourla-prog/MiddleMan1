import { describe, it, expect } from 'vitest'
import { renderBookingEvent } from './event-content.js'

describe('renderBookingEvent — 1-on-1', () => {
  const base = {
    kind: 'one_on_one' as const,
    serviceName: 'Haircut',
    durationMinutes: 45,
    customer: { name: 'Dana Levi', phone: '+972501234567' },
    instructorName: 'Yossi',
  }

  it('renders title as "service — client"', () => {
    expect(renderBookingEvent(base, 'en').title).toBe('Haircut — Dana Levi')
  })

  it('puts client, phone, service+duration and staff in the description', () => {
    expect(renderBookingEvent(base, 'en').description).toBe(
      'Client: Dana Levi\nPhone: +972501234567\nService: Haircut (45 min)\nStaff: Yossi',
    )
  })

  it('omits the staff line when the owner runs it (no instructor)', () => {
    const { description } = renderBookingEvent({ ...base, instructorName: null }, 'en')
    expect(description).not.toContain('Staff')
    expect(description.split('\n')).toHaveLength(3)
  })

  it('omits the phone line when no phone is on file', () => {
    const { description } = renderBookingEvent(
      { ...base, customer: { name: 'Dana Levi', phone: null } },
      'en',
    )
    expect(description).not.toContain('Phone')
  })

  it('uses the no-name placeholder (not the phone) when no name is known — phone once', () => {
    const { title, description } = renderBookingEvent(
      { ...base, customer: { name: null, phone: '+972501234567' } },
      'en',
    )
    expect(title).toBe('Haircut — No name')
    expect(description).toContain('Client: No name')
    expect(description).toContain('Phone: +972501234567')
    expect(description.match(/\+972501234567/g)?.length).toBe(1)
  })

  it('uses the no-name placeholder (not the phone) when a 1-on-1 customer has no name — phone once (Hebrew)', () => {
    const { title, description } = renderBookingEvent({
      kind: 'one_on_one', serviceName: 'יוגה', durationMinutes: 60,
      customer: { name: null, phone: '+972522858870' }, instructorName: null,
    }, 'he')
    expect(title).toBe('יוגה — ללא שם')
    expect(description).toContain('לקוח: ללא שם')
    expect(description).toContain('טלפון: +972522858870')
    expect(description.match(/\+972522858870/g)?.length).toBe(1)
  })

  it('renders Hebrew with the right labels and digits', () => {
    const { title, description } = renderBookingEvent(
      { ...base, serviceName: 'תספורת', customer: { name: 'דנה לוי', phone: '+972501234567' }, instructorName: 'יוסי' },
      'he',
    )
    expect(title).toBe('תספורת — דנה לוי')
    expect(description).toBe(
      'לקוח: דנה לוי\nטלפון: +972501234567\nשירות: תספורת (45 דק׳)\nצוות: יוסי',
    )
  })
})

describe('renderBookingEvent — group', () => {
  const base = {
    kind: 'group' as const,
    serviceName: 'Vinyasa Flow',
    instructorName: 'Maya',
    maxParticipants: 12,
    attendees: [
      { name: 'Dana Levi', phone: '+972501234567' },
      { name: 'Avi Cohen', phone: '+972529876543' },
    ],
  }

  it('renders title as "service — booked/capacity"', () => {
    expect(renderBookingEvent(base, 'en').title).toBe('Vinyasa Flow — 2/12')
  })

  it('lists instructor, headcount and a numbered attendee roster', () => {
    expect(renderBookingEvent(base, 'en').description).toBe(
      [
        'Group session: Vinyasa Flow',
        'Instructor: Maya',
        'Booked: 2 of 12',
        '',
        'Attendees:',
        '1. Dana Levi — +972501234567',
        '2. Avi Cohen — +972529876543',
      ].join('\n'),
    )
  })

  it('shows a 0/n headcount and no roster block when empty', () => {
    const { title, description } = renderBookingEvent({ ...base, attendees: [] }, 'en')
    expect(title).toBe('Vinyasa Flow — 0/12')
    expect(description).toBe('Group session: Vinyasa Flow\nInstructor: Maya\nBooked: 0 of 12')
  })

  it('group attendee with no name renders "placeholder — phone", phone once', () => {
    const { description } = renderBookingEvent({
      kind: 'group', serviceName: 'יוגה', instructorName: null, maxParticipants: 8,
      attendees: [{ name: null, phone: '+972522858870' }],
    }, 'he')
    expect(description).toContain('1. ללא שם — +972522858870')
    expect(description.match(/\+972522858870/g)?.length).toBe(1)
  })

  it('drops a missing phone but keeps the attendee', () => {
    const { description } = renderBookingEvent(
      { ...base, attendees: [{ name: 'Dana Levi', phone: null }] },
      'en',
    )
    expect(description).toContain('1. Dana Levi')
    expect(description).not.toContain('—  ')
  })

  it('renders Hebrew group labels', () => {
    const { description } = renderBookingEvent(
      { ...base, serviceName: 'ויניאסה', instructorName: 'מאיה', attendees: [{ name: 'דנה לוי', phone: '+972501234567' }] },
      'he',
    )
    expect(description).toBe(
      ['שיעור קבוצתי: ויניאסה', 'מדריך: מאיה', 'נרשמו: 1 מתוך 12', '', 'משתתפים:', '1. דנה לוי — +972501234567'].join('\n'),
    )
  })
})

describe('renderBookingEvent — meeting', () => {
  const base = {
    kind: 'meeting' as const,
    title: 'Meeting with the accountant',
    contact: { name: 'Harel Cohen', phone: '+972521112233' },
  }
  it('title is "meeting title — contact"', () => {
    expect(renderBookingEvent(base, 'en').title).toBe('Meeting with the accountant — Harel Cohen')
  })
  it('description lists contact + phone', () => {
    expect(renderBookingEvent(base, 'en').description).toBe('With: Harel Cohen\nPhone: +972521112233')
  })
  it('renders Hebrew labels', () => {
    expect(renderBookingEvent({ ...base, contact: { name: 'הראל', phone: '+972521112233' } }, 'he').description)
      .toBe('עם: הראל\nטלפון: +972521112233')
  })
})
