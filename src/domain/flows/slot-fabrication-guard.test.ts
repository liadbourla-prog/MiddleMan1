import { describe, it, expect } from 'vitest'
import {
  canonicalTime,
  extractClockTimes,
  extractMentionedTimes,
  findUnbackedTimes,
  extractFullTimes,
  assertsNoAvailability,
} from './slot-fabrication-guard.js'

describe('canonicalTime', () => {
  it('zero-pads valid times', () => {
    expect(canonicalTime(9, 0)).toBe('09:00')
    expect(canonicalTime(17, 30)).toBe('17:30')
  })
  it('rejects out-of-range', () => {
    expect(canonicalTime(24, 0)).toBeNull()
    expect(canonicalTime(10, 60)).toBeNull()
    expect(canonicalTime(-1, 0)).toBeNull()
  })
})

describe('extractClockTimes', () => {
  it('pulls HH:MM from Hebrew reply text', () => {
    expect(extractClockTimes('יש לנו מקומות פנויים ביום שני ב-17:00 או ב-19:00')).toEqual(['17:00', '19:00'])
  })
  it('handles a range and dedupes', () => {
    expect(extractClockTimes('שעות פעילות 09:00–20:00, ושוב 09:00')).toEqual(['09:00', '20:00'])
  })
  it('ignores prices, dates, and durations (no colon)', () => {
    expect(extractClockTimes('עלות השיעור 80 ש״ח, ביום 28 ביוני, 60 דקות')).toEqual([])
  })
  it('does not half-match seconds or long digit runs', () => {
    expect(extractClockTimes('17:00:00')).toEqual([]) // DB-shaped, not a reply token
  })
})

describe('extractMentionedTimes', () => {
  it('captures HH:MM and bare in-context hours', () => {
    expect(extractMentionedTimes('אפשר לקבוע יוגה ביום שני ב17?')).toContain('17:00')
    expect(extractMentionedTimes('אפשר לקבוע ל10 יוגה')).toContain('10:00')
    expect(extractMentionedTimes('אפשר ב-19:30?')).toContain('19:30')
  })
  it('does not treat a day-of-month as an hour', () => {
    expect(extractMentionedTimes('ביום 28 ביוני')).not.toContain('28:00') // 28 is out of range anyway
    expect(extractMentionedTimes('28 ביוני')).toEqual([])
  })
})

describe('findUnbackedTimes — the production bug', () => {
  // Failing chat (+972 54-637-2400): customer asked an OPEN-ENDED evening inquiry;
  // the studio's whole week is fully tiled by classes + internal blocks, so the
  // spine offered nothing. The PA nonetheless fabricated two blocked gap times.
  it('flags fabricated 17:00 / 19:00 that were never offered', () => {
    const reply = 'הכל כבר מלא ליום ראשון בערב. יש לנו מקומות פנויים ביום שני ב-17:00 או ב-19:00. יתאים לך?'
    const allowed = new Set(['09:00', '20:00']) // only the business-hour boundaries are backed
    expect(findUnbackedTimes(reply, allowed)).toEqual(['17:00', '19:00'])
  })

  // Working chat (+972 52-285-8870): customer asked specifically about 17:00; the PA
  // correctly refused it and offered the real yoga classes 10/12/16. The refusal
  // echoes the customer-raised 17:00 — it must NOT be flagged.
  it('does not flag a refusal that echoes a customer-raised time + offered classes', () => {
    const reply = 'ב-17:00 אין לנו שיעור יוגה. ביום שני יש לנו שיעורים ב-10:00, 12:00, או 16:00.'
    const allowed = new Set<string>([
      ...extractMentionedTimes('אפשר לקבוע יוגה שבוע הבא ביום שני ב17?'), // 17:00
      '10:00', '12:00', '16:00', // real offered class instances
    ])
    expect(findUnbackedTimes(reply, allowed)).toEqual([])
  })

  it('passes a reply that only states offered times', () => {
    const reply = 'יש לנו מקומות פנויים מחר ב-14:00 או ב-15:00.'
    expect(findUnbackedTimes(reply, new Set(['14:00', '15:00']))).toEqual([])
  })
})

describe('extractFullTimes — occupancy signal (exclude full slots)', () => {
  it('captures times marked (full) in en and (מלא) in he', () => {
    const situation = 'Classes on Monday: Pilates at 11:00 (5 spots left); Pilates at 14:00 (full); יוגה at 18:00 (מלא).'
    expect(extractFullTimes(situation).sort()).toEqual(['14:00', '18:00'])
  })
  it('returns nothing when no full markers', () => {
    expect(extractFullTimes('Pilates at 11:00 (5 spots left); 14:00 (3 spots left)')).toEqual([])
  })
})

describe('assertsNoAvailability — blanket fullness claim', () => {
  it('flags the observed Hebrew "Monday is completely full"', () => {
    expect(assertsNoAvailability('בעצם אני רואה שיום שני כבר התמלא לגמרי. יש יום אחר?')).toBe(true)
  })
  it('flags "no room for pilates on Sunday"', () => {
    expect(assertsNoAvailability('אין מקום פנוי לפילאטיס ביום ראשון')).toBe(true)
  })
  it('flags English fully-booked phrasings', () => {
    expect(assertsNoAvailability('That day is fully booked, sorry.')).toBe(true)
    expect(assertsNoAvailability('No availability on Monday.')).toBe(true)
  })
  it('does NOT flag a reply that simply offers open times', () => {
    expect(assertsNoAvailability('ביום שני יש פילאטיס ב-11:00, 14:00, ו-18:00. איזו שעה?')).toBe(false)
    expect(assertsNoAvailability('We have spots at 14:00 and 15:00.')).toBe(false)
  })
  it('does NOT flag a specific-time negative', () => {
    expect(assertsNoAvailability('ב-19:00 אין לנו שיעור, אבל יש ב-18:00.')).toBe(false)
  })
})
