import { describe, it, expect } from 'vitest'
import { isPaymentLinkDue, clampPaymentOffsetMinutes, PAYMENT_OFFSET_MIN_MINUTES, PAYMENT_OFFSET_MAX_MINUTES } from './timing.js'

const slot = new Date('2026-06-25T12:00:00Z')

describe('isPaymentLinkDue', () => {
  it('at_booking is always due (default reproduces send-on-booking)', () => {
    expect(isPaymentLinkDue('at_booking', null, slot, new Date('2026-06-20T00:00:00Z'))).toBe(true)
    expect(isPaymentLinkDue(null, null, slot, new Date('2026-06-20T00:00:00Z'))).toBe(true)
  })

  it('offset before the slot: not due until slot_start - offset arrives', () => {
    // 24h before → -1440. Send window opens at 2026-06-24T12:00Z.
    expect(isPaymentLinkDue('offset', -1440, slot, new Date('2026-06-24T11:59:00Z'))).toBe(false)
    expect(isPaymentLinkDue('offset', -1440, slot, new Date('2026-06-24T12:00:00Z'))).toBe(true)
    expect(isPaymentLinkDue('offset', -1440, slot, new Date('2026-06-24T13:00:00Z'))).toBe(true)
  })

  it('offset after the slot: due only once slot_start + offset passes', () => {
    // 1h after → +60. Opens at 2026-06-25T13:00Z.
    expect(isPaymentLinkDue('offset', 60, slot, new Date('2026-06-25T12:30:00Z'))).toBe(false)
    expect(isPaymentLinkDue('offset', 60, slot, new Date('2026-06-25T13:00:00Z'))).toBe(true)
  })

  it('offset policy with missing offset/slot degrades to due-now (never strands the booking)', () => {
    expect(isPaymentLinkDue('offset', null, slot, new Date('2026-06-20T00:00:00Z'))).toBe(true)
    expect(isPaymentLinkDue('offset', -1440, null, new Date('2026-06-20T00:00:00Z'))).toBe(true)
  })
})

describe('clampPaymentOffsetMinutes', () => {
  it('clamps to ±7 days and rounds', () => {
    expect(clampPaymentOffsetMinutes(-1440.4)).toBe(-1440)
    expect(clampPaymentOffsetMinutes(-99999)).toBe(PAYMENT_OFFSET_MIN_MINUTES)
    expect(clampPaymentOffsetMinutes(99999)).toBe(PAYMENT_OFFSET_MAX_MINUTES)
    expect(clampPaymentOffsetMinutes(NaN)).toBe(0)
  })
})
