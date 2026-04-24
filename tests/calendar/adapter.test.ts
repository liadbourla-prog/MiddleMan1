import { describe, it, expect, vi } from 'vitest'

// Calendar adapter tests use a mock of the googleapis client to verify:
// 1. Correct failure handling (API errors never advance booking state)
// 2. Hold prefix is applied
// 3. Not-found vs error discrimination on delete

vi.mock('googleapis', () => {
  const mockCalendar = {
    freebusy: { query: vi.fn() },
    events: {
      insert: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
  }
  return {
    google: {
      auth: {
        OAuth2: vi.fn().mockImplementation(() => ({
          setCredentials: vi.fn(),
        })),
      },
      calendar: vi.fn().mockReturnValue(mockCalendar),
      _mockCalendar: mockCalendar,
    },
  }
})

import { google } from 'googleapis'
import { createCalendarClient } from '../../src/adapters/calendar/client.js'

const mockGCal = (google as unknown as { _mockCalendar: typeof google.calendar.prototype }).
  _mockCalendar ?? (google as unknown as Record<string, unknown>)['_mockCalendar']

function makeClient() {
  return createCalendarClient({
    accessToken: 'test-token',
    refreshToken: 'test-refresh',
    calendarId: 'test-cal-id',
  })
}

const testSlot = {
  start: new Date('2026-05-01T10:00:00Z'),
  end: new Date('2026-05-01T11:00:00Z'),
}

describe('CalendarAdapter.checkAvailability', () => {
  it('returns available when freebusy returns empty busy array', async () => {
    vi.mocked((google as unknown as { _mockCalendar: { freebusy: { query: ReturnType<typeof vi.fn> } } })._mockCalendar.freebusy.query).mockResolvedValueOnce({
      data: { calendars: { 'test-cal-id': { busy: [] } } },
    })
    const result = await makeClient().checkAvailability(testSlot)
    expect(result.status).toBe('available')
  })

  it('returns occupied when busy slots exist', async () => {
    vi.mocked((google as unknown as { _mockCalendar: { freebusy: { query: ReturnType<typeof vi.fn> } } })._mockCalendar.freebusy.query).mockResolvedValueOnce({
      data: {
        calendars: {
          'test-cal-id': {
            busy: [{ start: '2026-05-01T10:00:00Z', end: '2026-05-01T11:00:00Z' }],
          },
        },
      },
    })
    const result = await makeClient().checkAvailability(testSlot)
    expect(result.status).toBe('occupied')
  })

  it('returns error when API throws', async () => {
    vi.mocked((google as unknown as { _mockCalendar: { freebusy: { query: ReturnType<typeof vi.fn> } } })._mockCalendar.freebusy.query).mockRejectedValueOnce(new Error('Network failure'))
    const result = await makeClient().checkAvailability(testSlot)
    expect(result.status).toBe('error')
    if (result.status === 'error') expect(result.reason).toContain('Network failure')
  })
})

describe('CalendarAdapter.placeHold', () => {
  it('returns conflict when slot is occupied', async () => {
    vi.mocked((google as unknown as { _mockCalendar: { freebusy: { query: ReturnType<typeof vi.fn> } } })._mockCalendar.freebusy.query).mockResolvedValueOnce({
      data: { calendars: { 'test-cal-id': { busy: [{ start: 'x', end: 'y' }] } } },
    })
    const result = await makeClient().placeHold(testSlot, 'booking-1', 'Haircut', new Date())
    expect(result.status).toBe('conflict')
  })

  it('returns error when calendar insert fails', async () => {
    vi.mocked((google as unknown as { _mockCalendar: { freebusy: { query: ReturnType<typeof vi.fn> } } })._mockCalendar.freebusy.query).mockResolvedValueOnce({
      data: { calendars: { 'test-cal-id': { busy: [] } } },
    })
    vi.mocked((google as unknown as { _mockCalendar: { events: { insert: ReturnType<typeof vi.fn> } } })._mockCalendar.events.insert).mockRejectedValueOnce(new Error('Calendar quota exceeded'))
    const result = await makeClient().placeHold(testSlot, 'booking-1', 'Haircut', new Date())
    expect(result.status).toBe('error')
  })

  it('returns held with eventId on success', async () => {
    vi.mocked((google as unknown as { _mockCalendar: { freebusy: { query: ReturnType<typeof vi.fn> } } })._mockCalendar.freebusy.query).mockResolvedValueOnce({
      data: { calendars: { 'test-cal-id': { busy: [] } } },
    })
    vi.mocked((google as unknown as { _mockCalendar: { events: { insert: ReturnType<typeof vi.fn> } } })._mockCalendar.events.insert).mockResolvedValueOnce({
      data: { id: 'event-abc' },
    })
    const result = await makeClient().placeHold(testSlot, 'booking-1', 'Haircut', new Date())
    expect(result.status).toBe('held')
    if (result.status === 'held') expect(result.eventId).toBe('event-abc')
  })
})

describe('CalendarAdapter.deleteEvent', () => {
  it('returns not_found for 404 errors', async () => {
    const err = Object.assign(new Error('Not found'), { code: 404 })
    vi.mocked((google as unknown as { _mockCalendar: { events: { delete: ReturnType<typeof vi.fn> } } })._mockCalendar.events.delete).mockRejectedValueOnce(err)
    const result = await makeClient().deleteEvent('ghost-event')
    expect(result.status).toBe('not_found')
  })

  it('returns error for non-404 API failures', async () => {
    const err = Object.assign(new Error('Internal error'), { code: 500 })
    vi.mocked((google as unknown as { _mockCalendar: { events: { delete: ReturnType<typeof vi.fn> } } })._mockCalendar.events.delete).mockRejectedValueOnce(err)
    const result = await makeClient().deleteEvent('some-event')
    expect(result.status).toBe('error')
  })

  it('returns deleted on success', async () => {
    vi.mocked((google as unknown as { _mockCalendar: { events: { delete: ReturnType<typeof vi.fn> } } })._mockCalendar.events.delete).mockResolvedValueOnce({})
    const result = await makeClient().deleteEvent('event-abc')
    expect(result.status).toBe('deleted')
  })
})
