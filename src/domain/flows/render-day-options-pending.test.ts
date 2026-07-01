/**
 * Finding 3 — renderDayOptions surfaces a pending imported class on a day/any-time inquiry as
 * TENTATIVE (confirming with the studio), NEVER as a bookable slot. The pending class must:
 *   - be mentioned in the grounding text (so a vague "any Pilates Sunday?" doesn't read as empty),
 *   - NEVER be pushed to `offered` (it is not bookable — it stays an occupy-and-ask block).
 */
import { describe, it, expect } from 'vitest'
import { renderDayOptions } from './customer-booking.js'
import type { DayOptions } from '../availability/day-options.js'

const TZ = 'UTC'
const DATE = '2026-07-05' // Sunday

function dayWith(pending: DayOptions['pendingClasses']): DayOptions {
  return { dateStr: DATE, classes: [], privateOpenings: [], ...(pending ? { pendingClasses: pending } : {}) }
}

const pendingPilates = {
  serviceTypeId: 'svc-pilates',
  serviceName: 'Pilates',
  start: new Date('2026-07-05T19:00:00Z'),
  end: new Date('2026-07-05T20:00:00Z'),
}

describe('Finding 3 — renderDayOptions surfaces a pending class as tentative, never bookable', () => {
  it('mentions the pending class as tentative/confirming, and offers NOTHING for it', () => {
    const res = renderDayOptions(dayWith([pendingPilates]), DATE, TZ, { offerable: true })
    expect((res.text ?? '').toLowerCase()).toContain('tentative')
    expect((res.text ?? '').toLowerCase()).toContain('studio')
    expect(res.text ?? '').toContain('Pilates')
    // Never bookable — no offered slot for the pending class.
    expect(res.offered).toHaveLength(0)
  })

  it('surfaces it in grounding mode too (day no longer reads as empty)', () => {
    const res = renderDayOptions(dayWith([pendingPilates]), DATE, TZ, { offerable: false })
    expect((res.text ?? '').toLowerCase()).toContain('tentative')
    expect(res.offered).toHaveLength(0)
  })

  it('no pending classes → unchanged (no tentative line)', () => {
    const res = renderDayOptions(dayWith(undefined), DATE, TZ, { offerable: true })
    expect((res.text ?? '').toLowerCase()).not.toContain('tentative')
  })
})
