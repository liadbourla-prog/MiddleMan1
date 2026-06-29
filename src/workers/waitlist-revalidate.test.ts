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

// T2a.2 — the offer wording must never claim a hold/reservation (no hold exists; reword to
// honest "first to reply gets it"). A retaken slot is suppressed upstream; even when sent, the
// message never says "I'm holding it for you".
describe('waitlist_offer wording is honest — no fabricated hold (T2a.2)', () => {
  it('English offer says first-to-reply, never "holding it"', () => {
    const msg = i18n.waitlist_offer.en('Studio', 'Yoga', 'Mon 1 Jul, 10:00', 15)
    expect(msg).toMatch(/first/i)
    expect(msg).not.toMatch(/holding it|i'?m holding|reserv|held for you/i)
  })

  it('Hebrew offer makes no hold/reservation claim (no שמרתי/שריינתי/תופס)', () => {
    const msg = i18n.waitlist_offer.he('סטודיו', 'יוגה', 'שני 1 ביולי, 10:00', 15)
    expect(msg).not.toMatch(/שמרתי|שריינתי|שומר לך|תופס לכם|תופס לך/)
  })
})
