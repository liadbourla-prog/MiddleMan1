import { describe, it, expect } from 'vitest'
import { mapMeetingReplyToIntent } from './interpret.js'

const tz = 'Asia/Jerusalem'
const now = new Date('2026-06-21T09:00:00Z')
const opts = { durationMinutes: 60, timezone: tz, now }

describe('mapMeetingReplyToIntent', () => {
  it('decline → decline', () => {
    expect(mapMeetingReplyToIntent({ intent: 'decline', relativeDay: null, weekday: null, explicitDate: null, startTime: null }, opts)).toEqual({ kind: 'decline' })
  })
  it('unclear → unclear', () => {
    expect(mapMeetingReplyToIntent({ intent: 'unclear', relativeDay: null, weekday: null, explicitDate: null, startTime: null }, opts)).toEqual({ kind: 'unclear' })
  })
  it('propose_time without a clock time → unclear', () => {
    expect(mapMeetingReplyToIntent({ intent: 'propose_time', relativeDay: 'tomorrow', weekday: null, explicitDate: null, startTime: null }, opts)).toEqual({ kind: 'unclear' })
  })
  it('propose_time tomorrow 15:00 → a time slot of the given duration', () => {
    const r = mapMeetingReplyToIntent({ intent: 'propose_time', relativeDay: 'tomorrow', weekday: null, explicitDate: null, startTime: { hour: 15, minute: 0 } }, opts)
    expect(r.kind).toBe('time')
    if (r.kind === 'time') {
      expect(r.slot.end.getTime() - r.slot.start.getTime()).toBe(60 * 60 * 1000)
    }
  })
})
