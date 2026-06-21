import { describe, it, expect } from 'vitest'
import {
  isPhoneNumberLike,
  isPlausibleCalendarId,
  chooseCalendarId,
  resolveCalendarSwitch,
  type CalendarListEntry,
} from './calendar-id.js'

describe('isPhoneNumberLike', () => {
  it('flags an E.164 number (the exact production bug)', () => {
    expect(isPhoneNumberLike('+17541234567')).toBe(true)
  })
  it('flags numbers with separators', () => {
    expect(isPhoneNumberLike('+1 (754) 123-4567')).toBe(true)
    expect(isPhoneNumberLike('054-123-4567')).toBe(true)
  })
  it('does not flag primary', () => {
    expect(isPhoneNumberLike('primary')).toBe(false)
  })
  it('does not flag an email-style calendar id', () => {
    expect(isPhoneNumberLike('abc123@group.calendar.google.com')).toBe(false)
    expect(isPhoneNumberLike('owner@gmail.com')).toBe(false)
  })
})

describe('isPlausibleCalendarId', () => {
  it('accepts primary', () => {
    expect(isPlausibleCalendarId('primary')).toBe(true)
  })
  it('accepts email-style ids (primary email + secondary group calendars)', () => {
    expect(isPlausibleCalendarId('owner@gmail.com')).toBe(true)
    expect(isPlausibleCalendarId('abc123@group.calendar.google.com')).toBe(true)
  })
  it('rejects a phone number', () => {
    expect(isPlausibleCalendarId('+17541234567')).toBe(false)
  })
  it('rejects empty / whitespace', () => {
    expect(isPlausibleCalendarId('')).toBe(false)
    expect(isPlausibleCalendarId('   ')).toBe(false)
  })
  it('rejects arbitrary non-email, non-primary text', () => {
    expect(isPlausibleCalendarId('My Calendar')).toBe(false)
  })
})

describe('chooseCalendarId', () => {
  const primary: CalendarListEntry = { id: 'owner@gmail.com', summary: 'Owner', accessRole: 'owner', primary: true }
  const testing: CalendarListEntry = { id: 'testing@group.calendar.google.com', summary: 'Testing', accessRole: 'owner', primary: false }
  const readonly: CalendarListEntry = { id: 'holidays@group.calendar.google.com', summary: 'Holidays', accessRole: 'reader', primary: false }

  it('keeps a valid existing preference when it is still a writable calendar', () => {
    const r = chooseCalendarId([primary, testing], 'testing@group.calendar.google.com')
    expect(r.calendarId).toBe('testing@group.calendar.google.com')
    expect(r.source).toBe('preserved')
  })

  it('ignores a phone-number preference and falls back to primary', () => {
    const r = chooseCalendarId([primary, testing], '+17541234567')
    expect(r.calendarId).toBe('owner@gmail.com')
    expect(r.source).toBe('primary')
  })

  it("ignores a preference that the owner no longer has access to", () => {
    const r = chooseCalendarId([primary, testing], 'gone@group.calendar.google.com')
    expect(r.calendarId).toBe('owner@gmail.com')
    expect(r.source).toBe('primary')
  })

  it('falls back to the literal "primary" when the list has no primary flagged', () => {
    const r = chooseCalendarId([testing], null)
    // testing is the only writable calendar — pick it deterministically
    expect(r.calendarId).toBe('testing@group.calendar.google.com')
  })

  it('returns "primary" literal when the list is empty (calendarList read failed)', () => {
    const r = chooseCalendarId([], null)
    expect(r.calendarId).toBe('primary')
    expect(r.source).toBe('default')
  })

  it('never selects a read-only calendar as the default', () => {
    const r = chooseCalendarId([readonly, primary], null)
    expect(r.calendarId).toBe('owner@gmail.com')
  })

  it('exposes only writable calendars as switch candidates', () => {
    const r = chooseCalendarId([primary, testing, readonly], null)
    const ids = r.candidates.map((c) => c.id)
    expect(ids).toContain('owner@gmail.com')
    expect(ids).toContain('testing@group.calendar.google.com')
    expect(ids).not.toContain('holidays@group.calendar.google.com')
  })
})

describe('resolveCalendarSwitch', () => {
  const primary: CalendarListEntry = { id: 'owner@gmail.com', summary: 'Owner', accessRole: 'owner', primary: true }
  const testing: CalendarListEntry = { id: 'testing@group.calendar.google.com', summary: 'Testing', accessRole: 'writer', primary: false }
  const work: CalendarListEntry = { id: 'work@group.calendar.google.com', summary: 'Work Testing', accessRole: 'owner', primary: false }
  const readonly: CalendarListEntry = { id: 'holidays@group.calendar.google.com', summary: 'Holidays', accessRole: 'reader', primary: false }

  it('matches an exact name case-insensitively', () => {
    const r = resolveCalendarSwitch([primary, testing], 'testing')
    expect(r.status).toBe('ok')
    if (r.status === 'ok') expect(r.calendar.id).toBe('testing@group.calendar.google.com')
  })

  it('matches a unique substring', () => {
    const r = resolveCalendarSwitch([primary, testing], 'test')
    expect(r.status).toBe('ok')
    if (r.status === 'ok') expect(r.calendar.id).toBe('testing@group.calendar.google.com')
  })

  it('prefers an exact match over substring matches', () => {
    const r = resolveCalendarSwitch([testing, work], 'testing')
    expect(r.status).toBe('ok')
    if (r.status === 'ok') expect(r.calendar.id).toBe('testing@group.calendar.google.com')
  })

  it('returns ambiguous when a substring matches multiple', () => {
    const r = resolveCalendarSwitch([testing, work], 'test')
    expect(r.status).toBe('ambiguous')
    if (r.status === 'ambiguous') expect(r.matches).toHaveLength(2)
  })

  it('never resolves to a read-only calendar', () => {
    const r = resolveCalendarSwitch([readonly], 'holidays')
    expect(r.status).toBe('not_found')
  })

  it('returns not_found for an unknown name', () => {
    expect(resolveCalendarSwitch([primary, testing], 'nope').status).toBe('not_found')
  })

  it('returns not_found for empty input', () => {
    expect(resolveCalendarSwitch([primary], '   ').status).toBe('not_found')
  })
})
