import { describe, it, expect } from 'vitest'
import { reviewDueWindow, noShowFollowupWindow, thankYouDueWindow } from './post-appointment.js'

const HOUR = 60 * 60 * 1000
const NOW = new Date('2026-06-22T12:00:00Z')

describe('reviewDueWindow', () => {
  it('opens 48h back and closes 24h back', () => {
    const w = reviewDueWindow(NOW)
    expect(w.after).toEqual(new Date(NOW.getTime() - 48 * HOUR))
    expect(w.before).toEqual(new Date(NOW.getTime() - 24 * HOUR))
  })

  it('after is always strictly earlier than before (non-empty band)', () => {
    const w = reviewDueWindow(NOW)
    expect(w.after.getTime()).toBeLessThan(w.before.getTime())
  })

  // Truth table: a slotEnd is "due" iff it lands in [after, before].
  const cases: Array<{ name: string; hoursAgo: number; due: boolean }> = [
    { name: 'just ended (1h ago) — too fresh', hoursAgo: 1, due: false },
    { name: '23h ago — still too fresh (before upper bound)', hoursAgo: 23, due: false },
    { name: '24h ago — exactly the upper bound, due', hoursAgo: 24, due: true },
    { name: '36h ago — squarely in band', hoursAgo: 36, due: true },
    { name: '48h ago — exactly the lower bound, due', hoursAgo: 48, due: true },
    { name: '49h ago — past the band, missed', hoursAgo: 49, due: false },
  ]
  for (const c of cases) {
    it(`slotEnd ${c.name} → due=${c.due}`, () => {
      const slotEnd = new Date(NOW.getTime() - c.hoursAgo * HOUR)
      const w = reviewDueWindow(NOW)
      const inBand = slotEnd.getTime() >= w.after.getTime() && slotEnd.getTime() <= w.before.getTime()
      expect(inBand).toBe(c.due)
    })
  }
})

describe('noShowFollowupWindow', () => {
  it('opens 48h back', () => {
    const w = noShowFollowupWindow(NOW)
    expect(w.after).toEqual(new Date(NOW.getTime() - 48 * HOUR))
  })

  // Truth table: a slotStart is "due" iff slotStart >= after.
  const cases: Array<{ name: string; hoursAgo: number; due: boolean }> = [
    { name: '1h ago — recent, due', hoursAgo: 1, due: true },
    { name: '47h ago — still inside lookback', hoursAgo: 47, due: true },
    { name: '48h ago — exactly the bound, due', hoursAgo: 48, due: true },
    { name: '49h ago — older than lookback, missed', hoursAgo: 49, due: false },
  ]
  for (const c of cases) {
    it(`slotStart ${c.name} → due=${c.due}`, () => {
      const slotStart = new Date(NOW.getTime() - c.hoursAgo * HOUR)
      const w = noShowFollowupWindow(NOW)
      expect(slotStart.getTime() >= w.after.getTime()).toBe(c.due)
    })
  }
})

describe('thankYouDueWindow', () => {
  it('opens 4h back and closes 1h back (earlier than the review window)', () => {
    const w = thankYouDueWindow(NOW)
    expect(w.after).toEqual(new Date(NOW.getTime() - 4 * HOUR))
    expect(w.before).toEqual(new Date(NOW.getTime() - 1 * HOUR))
    // The thank-you fires before the next-day review request.
    expect(w.before.getTime()).toBeGreaterThan(reviewDueWindow(NOW).before.getTime())
  })

  // Truth table: a slotEnd is "due" iff it lands in [after, before].
  const cases: Array<{ name: string; hoursAgo: number; due: boolean }> = [
    { name: 'just ended (0.5h ago) — too fresh', hoursAgo: 0.5, due: false },
    { name: '1h ago — exactly the upper bound, due', hoursAgo: 1, due: true },
    { name: '2h ago — squarely in band', hoursAgo: 2, due: true },
    { name: '4h ago — exactly the lower bound, due', hoursAgo: 4, due: true },
    { name: '5h ago — past the band, missed', hoursAgo: 5, due: false },
  ]
  for (const c of cases) {
    it(`slotEnd ${c.name} → due=${c.due}`, () => {
      const slotEnd = new Date(NOW.getTime() - c.hoursAgo * HOUR)
      const w = thankYouDueWindow(NOW)
      const inBand = slotEnd.getTime() >= w.after.getTime() && slotEnd.getTime() <= w.before.getTime()
      expect(inBand).toBe(c.due)
    })
  }
})
