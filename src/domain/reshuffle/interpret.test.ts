import { describe, it, expect } from 'vitest'
import { mapReplyToCounter } from './interpret.js'
import type { MeetingReplyOutput } from '../../adapters/llm/client.js'

// A fixed reference "now" (a Sunday) + timezone so date resolution is deterministic.
const NOW = new Date('2026-06-21T09:00:00Z')
const TZ = 'UTC'
const OPTS = { durationMin: 60, timezone: TZ, now: NOW }

function reply(over: Partial<MeetingReplyOutput>): MeetingReplyOutput {
  return { intent: 'unclear', relativeDay: null, weekday: null, explicitDate: null, startTime: null, ...over }
}

describe('mapReplyToCounter', () => {
  it('maps decline → decline', () => {
    expect(mapReplyToCounter(reply({ intent: 'decline' }), OPTS)).toEqual({ intent: 'decline' })
  })

  it('maps a resolvable propose_time → counter with an ISO slot of the offered duration', () => {
    const out = mapReplyToCounter(reply({ intent: 'propose_time', relativeDay: 'tomorrow', startTime: { hour: 15, minute: 0 } }), OPTS)
    expect(out.intent).toBe('counter')
    expect(out.counterSlot?.durationMin).toBe(60)
    expect(typeof out.counterSlot?.start).toBe('string')
    // Tomorrow (Mon 2026-06-22) 15:00 UTC.
    expect(out.counterSlot?.start).toBe(new Date('2026-06-22T15:00:00Z').toISOString())
  })

  it('maps propose_time WITHOUT a startTime → unclear (no usable time)', () => {
    expect(mapReplyToCounter(reply({ intent: 'propose_time', relativeDay: 'tomorrow', startTime: null }), OPTS)).toEqual({ intent: 'unclear' })
  })

  it('maps an unresolvable propose_time (impossible date) → unclear', () => {
    const out = mapReplyToCounter(reply({ intent: 'propose_time', explicitDate: { year: null, month: 2, day: 31 }, startTime: { hour: 10, minute: 0 } }), OPTS)
    expect(out).toEqual({ intent: 'unclear' })
  })

  it('maps unclear intent → unclear', () => {
    expect(mapReplyToCounter(reply({ intent: 'unclear' }), OPTS)).toEqual({ intent: 'unclear' })
  })
})
