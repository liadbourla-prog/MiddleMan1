import { describe, it, expect } from 'vitest'
import { extractAllowedTimesFromToolResult } from '../../src/adapters/llm/orchestrator.js'

// T1.1 — Branch-3 per-turn allowlist accumulator.
// The orchestrator must seed its time allowlist from the AVAILABILITY tool RESULTS
// (system-authored, en-GB/he-IL 24h strings), so a manager reply that states one of
// those real times is never mistaken for a fabrication. Capture is via extractClockTimes
// over the result strings; non-availability tools (e.g. searchWeb) are NOT scanned so a
// stray "14:00" in a web snippet can't launder a fabricated availability claim.

describe('extractAllowedTimesFromToolResult (T1.1)', () => {
  it('captures the 24h times from a check_free_slots result (freeSlots start/end)', () => {
    const result = {
      freeSlots: [
        { start: 'Tue, 3 Jun, 14:00', end: '14:30' },
        { start: 'Wed, 4 Jun, 09:00', end: '09:30' },
      ],
      durationMinutes: 30,
      count: 2,
    }
    const times = extractAllowedTimesFromToolResult('listCalendarEvents', result)
    expect(times).toEqual(expect.arrayContaining(['14:00', '14:30', '09:00', '09:30']))
  })

  it('captures the times from a list_today/list_range result (buildScheduleView events)', () => {
    const result = {
      events: [
        { eventId: 'a', title: 'Yoga', start: 'Tue, 3 Jun, 10:00', end: '11:00', isBooking: true, kind: 'booking' },
        { eventId: 'b', title: 'Block', start: 'Tue, 3 Jun, 17:00', end: '18:00', isBooking: false, kind: 'block' },
      ],
      count: 2,
    }
    const times = extractAllowedTimesFromToolResult('listCalendarEvents', result)
    expect(times).toEqual(expect.arrayContaining(['10:00', '11:00', '17:00', '18:00']))
  })

  it('captures the Hebrew (he-IL) 24h slot strings too', () => {
    const result = { freeSlots: [{ start: 'יום ג׳, 3 ביוני, 14:00', end: '14:30' }], count: 1 }
    const times = extractAllowedTimesFromToolResult('listCalendarEvents', result)
    expect(times).toEqual(expect.arrayContaining(['14:00', '14:30']))
  })

  it('does NOT scan non-availability tool results (a searchWeb snippet time stays out)', () => {
    const result = { results: [{ snippet: 'Event starts at 14:00 sharp' }] }
    expect(extractAllowedTimesFromToolResult('searchWeb', result)).toEqual([])
  })

  it('returns [] for a failed/empty availability result', () => {
    expect(extractAllowedTimesFromToolResult('listCalendarEvents', { error: 'boom' })).toEqual([])
    expect(extractAllowedTimesFromToolResult('listCalendarEvents', { freeSlots: [], count: 0 })).toEqual([])
    expect(extractAllowedTimesFromToolResult('listCalendarEvents', null)).toEqual([])
  })

  it('dedupes repeated times', () => {
    const result = {
      events: [
        { start: 'Tue, 3 Jun, 10:00', end: '11:00' },
        { start: 'Wed, 4 Jun, 10:00', end: '11:00' },
      ],
      count: 2,
    }
    const times = extractAllowedTimesFromToolResult('listCalendarEvents', result)
    expect(times.filter((t) => t === '10:00')).toHaveLength(1)
  })
})
