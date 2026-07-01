/**
 * C0.2 — timeout on Google calls.
 *
 * There is no timeout anywhere in the calendar client. A hanging Google
 * `events.list` inside `incrementalSync` would stall any caller (a customer
 * reply, the reconcile tick) forever. This test simulates a Google call that
 * never resolves and asserts that `incrementalSync` aborts within a bounded
 * deadline and returns an error result (never throws, never hangs) so the
 * caller proceeds on the internal record.
 *
 * Red→Green: BEFORE the fix, incrementalSync passes no AbortSignal, so the
 * mocked hanging list never rejects and this test hangs → vitest times it out
 * (RED). AFTER the fix, the AbortController deadline fires and incrementalSync
 * resolves to { status: 'error' } well within the test's own timeout (GREEN).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('googleapis', () => {
  const mockCalendar = {
    events: { list: vi.fn() },
    freebusy: { query: vi.fn() },
  }
  return {
    google: {
      auth: {
        OAuth2: vi.fn().mockImplementation(() => ({
          setCredentials: vi.fn(),
          refreshAccessToken: vi.fn(),
        })),
      },
      calendar: vi.fn().mockReturnValue(mockCalendar),
      _mockCalendar: mockCalendar,
    },
  }
})

import { google } from 'googleapis'
import { createCalendarClient } from '../../src/adapters/calendar/client.js'

const mockCalendar = (google as unknown as { _mockCalendar: { events: { list: ReturnType<typeof vi.fn> } } })._mockCalendar

function makeGoogleClient() {
  return createCalendarClient({
    accessToken: 'test-token',
    refreshToken: 'test-refresh',
    calendarId: 'test-cal-id',
    calendarMode: 'google',
  })
}

describe('C0.2 — incrementalSync timeout (AbortController deadline)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env['GOOGLE_CALL_TIMEOUT_MS'] = '80'
  })
  afterEach(() => {
    delete process.env['GOOGLE_CALL_TIMEOUT_MS']
  })

  it('aborts a hanging Google call within the deadline and returns an error (never hangs, never throws)', async () => {
    // The list hangs forever UNLESS the passed AbortSignal fires.
    mockCalendar.events.list.mockImplementation((_params: unknown, options?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        const signal = options?.signal
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted') as Error & { name: string }
            err.name = 'AbortError'
            reject(err)
          })
        }
        // Otherwise never settles — a truly hanging Google call.
      })
    })

    const start = Date.now()
    const result = await makeGoogleClient().incrementalSync({
      timeMin: new Date('2026-07-01T00:00:00Z'),
      timeMax: new Date('2026-07-08T00:00:00Z'),
    })
    const elapsed = Date.now() - start

    // Resolved (not hung), and it resolved because the deadline aborted it.
    expect(result.status).toBe('error')
    // The deadline is 80ms; give generous slack but far below "forever".
    expect(elapsed).toBeLessThan(3000)
    // The signal was actually threaded to Google (proves the deadline is wired, not incidental).
    expect(mockCalendar.events.list).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it('a fast, healthy call still succeeds and drains pages (no false timeout)', async () => {
    mockCalendar.events.list.mockResolvedValueOnce({
      data: {
        items: [
          { id: 'ev-1', status: 'confirmed', summary: 'x', start: { dateTime: '2026-07-02T09:00:00Z' }, end: { dateTime: '2026-07-02T10:00:00Z' } },
        ],
        nextSyncToken: 'tok-next',
      },
    })
    const result = await makeGoogleClient().incrementalSync({
      timeMin: new Date('2026-07-01T00:00:00Z'),
      timeMax: new Date('2026-07-08T00:00:00Z'),
    })
    expect(result.status).toBe('ok')
    if (result.status === 'ok') {
      expect(result.events).toHaveLength(1)
      expect(result.nextSyncToken).toBe('tok-next')
    }
  })
})
