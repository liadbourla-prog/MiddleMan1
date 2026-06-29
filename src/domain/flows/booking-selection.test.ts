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
import { matchBookingSelection, orderRowsByCandidates } from './customer-booking.js'
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

describe('orderRowsByCandidates — bind numbered pick to displayed (sorted) order', () => {
  // The DB returns rows in ARBITRARY order. The displayed list (and candidateIds) is
  // sorted by slotStart. A bare number must resolve against the DISPLAYED order, not the
  // raw DB row order — so reorder rows by candidateIds before matchBookingSelection.
  const sortedCandidateIds = ['b-pilates', 'b-massage', 'b-yoga'] // display positions 1,2,3

  // DB returns them shuffled: yoga first, pilates last.
  const shuffledRows: CancelBooking[] = [
    { id: 'b-yoga', slotStart: new Date(YOGA_FRI), serviceTypeId: 'svc-yoga', serviceName: 'Yoga' },
    { id: 'b-massage', slotStart: new Date(MASSAGE_WED), serviceTypeId: 'svc-massage', serviceName: 'Deep Massage' },
    { id: 'b-pilates', slotStart: new Date(PILATES_MON), serviceTypeId: 'svc-pilates', serviceName: 'Pilates' },
  ]

  it('reorders shuffled rows into candidateIds order', () => {
    const ordered = orderRowsByCandidates(shuffledRows, sortedCandidateIds)
    expect(ordered.map((r) => r.id)).toEqual(sortedCandidateIds)
  })

  it('bare "2" picks the booking at DISPLAY position 2, not shuffled rows[1]', () => {
    // Without reordering, matchBookingSelection('2', shuffledRows) would pick shuffledRows[1]
    // = b-massage — coincidentally right here, so prove it on "1" and "3" too where the
    // shuffle actively disagrees with the display order.
    const ordered = orderRowsByCandidates(shuffledRows, sortedCandidateIds)
    expect(matchBookingSelection('2', ordered, TZ)).toEqual({ id: 'b-massage' })
  })

  it('bare "1" picks display position 1 (b-pilates), NOT shuffled rows[0] (b-yoga)', () => {
    // The bug: matchBookingSelection('1', shuffledRows) would return b-yoga (wrong slot).
    expect(matchBookingSelection('1', shuffledRows, TZ)).toEqual({ id: 'b-yoga' }) // buggy behaviour
    const ordered = orderRowsByCandidates(shuffledRows, sortedCandidateIds)
    expect(matchBookingSelection('1', ordered, TZ)).toEqual({ id: 'b-pilates' }) // correct
  })

  it('bare "3" picks display position 3 (b-yoga), NOT shuffled rows[2] (b-pilates)', () => {
    const ordered = orderRowsByCandidates(shuffledRows, sortedCandidateIds)
    expect(matchBookingSelection('3', ordered, TZ)).toEqual({ id: 'b-yoga' })
  })

  it('drops candidateIds with no matching row (stale id) without throwing', () => {
    const ordered = orderRowsByCandidates(shuffledRows, [...sortedCandidateIds, 'b-gone'])
    expect(ordered.map((r) => r.id)).toEqual(sortedCandidateIds)
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
