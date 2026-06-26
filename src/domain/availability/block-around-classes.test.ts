import { describe, it, expect } from 'vitest'
import {
  complementaryIntervals,
  blockAroundClassesReplyGuidance,
  type NumInterval,
  type BlockAroundClassesSummary,
} from './block-around-classes.js'

// Work in minutes-since-midnight for readability: 9:00 → 540, 20:00 → 1200.
const hm = (h: number, m = 0): number => h * 60 + m
const slot = (startH: number, endH: number): NumInterval => ({ start: hm(startH), end: hm(endH) })

describe('complementaryIntervals — gap computation around classes (Issue 3 §7)', () => {
  it('returns the exact complementary intervals around hourly classes', () => {
    // Hours 09:00–20:00; classes at 09,10,11,12 (block 09–13), 14 (14–15), 16 (16–17), 18 (18–19).
    const hours = [slot(9, 20)]
    const classes = [slot(9, 13), slot(14, 15), slot(16, 17), slot(18, 19)]
    const gaps = complementaryIntervals(hours, classes)
    // Complement = 13–14, 15–16, 17–18, 19–20. Critically 17:00 (the bug slot) is blocked.
    expect(gaps).toEqual([slot(13, 14), slot(15, 16), slot(17, 18), slot(19, 20)])
  })

  it('NEVER overlaps a class interval (invariant #1 — must not re-break Issue 2)', () => {
    const hours = [slot(9, 20)]
    const classes = [slot(9, 13), slot(14, 15), slot(16, 17), slot(18, 19)]
    const gaps = complementaryIntervals(hours, classes)
    for (const g of gaps) {
      for (const c of classes) {
        const overlaps = g.start < c.end && g.end > c.start
        expect(overlaps).toBe(false)
      }
    }
  })

  it('is idempotent: subtracting already-blocked time yields no new gaps', () => {
    const hours = [slot(9, 20)]
    const classes = [slot(9, 13), slot(14, 15), slot(16, 17), slot(18, 19)]
    const firstGaps = complementaryIntervals(hours, classes)
    // Second run treats prior gaps as already-occupied alongside the classes.
    const secondGaps = complementaryIntervals(hours, [...classes, ...firstGaps])
    expect(secondGaps).toEqual([])
  })

  it('blocks the whole day when there are no classes', () => {
    expect(complementaryIntervals([slot(9, 20)], [])).toEqual([slot(9, 20)])
  })

  it('returns nothing when classes cover the whole day', () => {
    expect(complementaryIntervals([slot(9, 20)], [slot(8, 21)])).toEqual([])
  })

  it('merges overlapping and adjacent occupied intervals', () => {
    const gaps = complementaryIntervals([slot(9, 20)], [slot(10, 12), slot(11, 13), slot(13, 14)])
    // 10–14 is one continuous occupied block → gaps are 9–10 and 14–20.
    expect(gaps).toEqual([slot(9, 10), slot(14, 20)])
  })

  it('clips occupied intervals that extend past the window edges', () => {
    const gaps = complementaryIntervals([slot(9, 20)], [slot(6, 10), slot(19, 23)])
    expect(gaps).toEqual([slot(10, 19)])
  })

  it('handles a class exactly at the close edge', () => {
    const gaps = complementaryIntervals([slot(9, 20)], [slot(19, 20)])
    expect(gaps).toEqual([slot(9, 19)])
  })
})

describe('blockAroundClassesReplyGuidance — honesty contract (Issue 3 §5)', () => {
  // Phrases the orchestrator must NEVER use after a single-call bulk block: there is
  // no background job, so promising to continue is always a false claim.
  const FORBIDDEN = ['go through', 'few moments', 'update you when', 'keep working', 'continue', 'finish later']
  const summary = (over: Partial<BlockAroundClassesSummary>): BlockAroundClassesSummary => ({
    daysProcessed: 5, blocksCreated: 23, classesPreserved: 35, createdBlockIds: [], ...over,
  })

  it('reports the REAL totals and forbids any promise to continue (internal)', () => {
    const g = blockAroundClassesReplyGuidance(summary({}), false).toLowerCase()
    expect(g).toContain('23') // the concrete blocked-slot count
    expect(g).toContain('35') // classes preserved
    for (const phrase of FORBIDDEN) expect(g).not.toContain(phrase)
  })

  it('mentions Google visibility when mirror is true', () => {
    const g = blockAroundClassesReplyGuidance(summary({}), true)
    expect(g.toLowerCase()).toContain('google')
  })

  it('the zero case states it is already done without promising to continue', () => {
    const g = blockAroundClassesReplyGuidance(summary({ blocksCreated: 0 }), false).toLowerCase()
    for (const phrase of FORBIDDEN) expect(g).not.toContain(phrase)
    expect(g).toContain('already')
  })
})
