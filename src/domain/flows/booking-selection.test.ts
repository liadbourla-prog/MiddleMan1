/**
 * WS3-T3.2 — `matchBookingSelection` deterministic bind helper.
 *
 * This is the regression net for the verified-solid booking-selection bind path
 * (lifted VERBATIM out of the inline match inside handleBookingSelection). It must
 * stay confident and pivot-safe:
 *   • a bare number in range  → that candidate's id (by sorted position)
 *   • a bare number out of range → null (re-ask / pivot)
 *   • a unique free-text reference ("the yoga one", "Friday at 12") → that id
 *   • ambiguous / no usable criterion → null (so it can NEVER mis-bind a pivot)
 *
 * Pure + synchronous: no DB, no LLM. CancelBooking[] literals only.
 */
import { describe, it, expect } from 'vitest'
import { matchBookingSelection } from './customer-booking.js'
import type { CancelBooking } from './cancellation-match.js'

const TZ = 'Asia/Jerusalem'

// Candidates arrive ALREADY sorted by slotStart (the caller — enterCancellationSelection —
// sorts before building the id list / loading rows). The helper binds a bare number to the
// position IN THE PASSED ARRAY; it does not re-sort. 2026-06-29 is a Monday; 07-01 a
// Wednesday; 07-03 a Friday. Position: 1=Pilates(Mon), 2=Massage(Wed), 3=Yoga(Fri).
const PILATES_MON = '2026-06-29T07:00:00Z' // Mon 10:00 local (UTC+3)
const MASSAGE_WED = '2026-07-01T13:00:00Z' // Wed 16:00 local
const YOGA_FRI = '2026-07-03T09:00:00Z' // Fri 12:00 local

const candidates: CancelBooking[] = [
  { id: 'b-pilates', slotStart: new Date(PILATES_MON), serviceTypeId: 'svc-pilates', serviceName: 'Pilates' },
  { id: 'b-massage', slotStart: new Date(MASSAGE_WED), serviceTypeId: 'svc-massage', serviceName: 'Deep Massage' },
  { id: 'b-yoga', slotStart: new Date(YOGA_FRI), serviceTypeId: 'svc-yoga', serviceName: 'Yoga' },
]

describe('matchBookingSelection — bare-number-by-position', () => {
  it('binds a bare number in range to that sorted position', () => {
    expect(matchBookingSelection('1', candidates, TZ)).toEqual({ id: 'b-pilates' })
    expect(matchBookingSelection('2', candidates, TZ)).toEqual({ id: 'b-massage' })
    expect(matchBookingSelection('3', candidates, TZ)).toEqual({ id: 'b-yoga' })
  })

  it('trims whitespace around a bare number', () => {
    expect(matchBookingSelection('  2  ', candidates, TZ)).toEqual({ id: 'b-massage' })
  })

  it('returns null for a number out of range (0, >count)', () => {
    expect(matchBookingSelection('0', candidates, TZ)).toBeNull()
    expect(matchBookingSelection('4', candidates, TZ)).toBeNull()
  })
})

describe('matchBookingSelection — unique free-text reference', () => {
  it('binds a unique service reference', () => {
    expect(matchBookingSelection('the yoga one', candidates, TZ)).toEqual({ id: 'b-yoga' })
    expect(matchBookingSelection('cancel my pilates', candidates, TZ)).toEqual({ id: 'b-pilates' })
  })

  it('binds a unique weekday reference', () => {
    expect(matchBookingSelection('the Friday booking', candidates, TZ)).toEqual({ id: 'b-yoga' })
  })

  it('binds a unique clock-time reference', () => {
    // 16:00 → only the Wednesday massage
    expect(matchBookingSelection('the one at 16:00', candidates, TZ)).toEqual({ id: 'b-massage' })
  })

  it('returns null when free text matches NO booking', () => {
    expect(matchBookingSelection('the swimming lesson', candidates, TZ)).toBeNull()
  })

  it('returns null when free text states no usable criterion', () => {
    expect(matchBookingSelection('whatever you think', candidates, TZ)).toBeNull()
  })
})
