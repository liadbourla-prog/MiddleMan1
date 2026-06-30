import { describe, it, expect } from 'vitest'
import { isSlotStillOpenInDay } from './waitlist-revalidate.js'
import type { DayOptions } from '../domain/availability/day-options.js'
import { i18n } from '../domain/i18n/t.js'

const SLOT = new Date('2026-07-01T08:00:00Z')

function day(over: Partial<DayOptions>): DayOptions {
  return { dateStr: '2026-07-01', classes: [], privateOpenings: [], ...over }
}

// T2a.2 — the freed slot is re-validated fresh-spine before the "spot opened" offer goes out.
describe('isSlotStillOpenInDay (T2a.2 — H3/H18)', () => {
  it('open when the class session at that time still has a free seat', () => {
    const d = day({ classes: [{ serviceTypeId: 's1', serviceName: 'Yoga', start: SLOT, end: SLOT, spotsTotal: 10, spotsLeft: 1 }] })
    expect(isSlotStillOpenInDay(d, SLOT)).toBe(true)
  })

  it('NOT open when the class session at that time was retaken (spotsLeft 0)', () => {
    const d = day({ classes: [{ serviceTypeId: 's1', serviceName: 'Yoga', start: SLOT, end: SLOT, spotsTotal: 10, spotsLeft: 0 }] })
    expect(isSlotStillOpenInDay(d, SLOT)).toBe(false)
  })

  it('open when a private/1-on-1 slot at that exact time is still enumerated', () => {
    const d = day({ privateOpenings: [{ serviceTypeId: 's1', serviceName: 'Massage', durationMinutes: 60, slots: [SLOT] }] })
    expect(isSlotStillOpenInDay(d, SLOT)).toBe(true)
  })

  it('NOT open when nothing in the day matches the slot (it is gone)', () => {
    const d = day({ classes: [{ serviceTypeId: 's1', serviceName: 'Yoga', start: new Date('2026-07-01T09:00:00Z'), end: SLOT, spotsTotal: 10, spotsLeft: 3 }] })
    expect(isSlotStillOpenInDay(d, SLOT)).toBe(false)
  })
})

// WL-5 (B2): the contract REVERSED. The seat is now genuinely held for this customer for the
// offer window (a real `held` booking placed via the engine before the offer is sent), so the
// wording SHOULD reflect a hold and a release-on-timeout — no longer "first to reply gets it".
describe('waitlist_offer wording reflects a genuine hold (WL-5)', () => {
  it('English offer says it is being held for them, with a release-on-timeout, and no first-come framing', () => {
    const msg = i18n.waitlist_offer.en('Studio', 'Yoga', 'Mon 1 Jul, 10:00', 15)
    expect(msg).toMatch(/holding it for you/i)
    expect(msg).toMatch(/release/i)
    // No longer a first-come scramble.
    expect(msg).not.toMatch(/first to reply|first come/i)
  })

  it('Hebrew offer says the spot is kept for them and will be released if no reply', () => {
    const msg = i18n.waitlist_offer.he('סטודיו', 'יוגה', 'שני 1 ביולי, 10:00', 15)
    expect(msg).toMatch(/שמרתי/)
    expect(msg).toMatch(/אשחרר/)
  })
})
