import { describe, it, expect } from 'vitest'
import { summarizeSessionCancellation, distinctSessions, type CancelledBookingRef } from '../../src/domain/scheduling/session-cancellation.js'

const t0 = new Date('2026-06-25T17:00:00Z')
const t1 = new Date('2026-06-25T18:00:00Z')
function ref(over: Partial<CancelledBookingRef> = {}): CancelledBookingRef {
  return { providerId: null, serviceTypeId: 'svc-1', slotStart: t0, ...over }
}

describe('distinctSessions', () => {
  it('collapses many cancelled seats of one session to a single ref', () => {
    const out = distinctSessions([ref(), ref(), ref()])
    expect(out).toHaveLength(1)
  })

  it('keeps distinct sessions separate (different slot or service)', () => {
    const out = distinctSessions([
      ref({ slotStart: t0 }),
      ref({ slotStart: t1 }),
      ref({ serviceTypeId: 'svc-2', slotStart: t0 }),
    ])
    expect(out).toHaveLength(3)
  })

  it('prefers the ref that already carries a providerId for the same session', () => {
    const out = distinctSessions([ref({ providerId: null }), ref({ providerId: 'prov-9' })])
    expect(out).toHaveLength(1)
    expect(out[0]!.providerId).toBe('prov-9')
  })
})

describe('summarizeSessionCancellation', () => {
  it('reports both cancelled customers and instructor when both happened', () => {
    const s = summarizeSessionCancellation(3, true)
    expect(s).toContain('3 booked customer(s)')
    expect(s).toContain('rebook them')
    expect(s).toContain('the instructor was notified')
  })

  it('omits the instructor clause when no instructor was notified', () => {
    const s = summarizeSessionCancellation(3, false)
    expect(s).toContain('3 booked customer(s)')
    expect(s).not.toContain('instructor was notified')
  })

  it('states no customers were booked when the roster was empty', () => {
    const s = summarizeSessionCancellation(0, true)
    expect(s).toContain('no customers were booked')
    expect(s).toContain('the instructor was notified')
  })

  it('never promises guaranteed delivery (24h-window honesty / §7.4)', () => {
    const s = summarizeSessionCancellation(2, true)
    expect(s).toMatch(/best-effort|do not promise guaranteed delivery/i)
    expect(s).toContain('24-hour window')
  })
})
