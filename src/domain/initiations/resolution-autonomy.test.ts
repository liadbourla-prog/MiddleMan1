import { describe, it, expect } from 'vitest'
import { classifyManagedOutcome, resolutionAutonomyRatio } from './resolution-autonomy.js'

describe('classifyManagedOutcome', () => {
  it('classifies resolved actions', () => {
    expect(classifyManagedOutcome('coordination.booked')).toBe('resolved')
    expect(classifyManagedOutcome('reshuffle.applied')).toBe('resolved')
  })

  it('classifies dead-letter actions', () => {
    expect(classifyManagedOutcome('coordination.book_conflict')).toBe('dead_letter')
    expect(classifyManagedOutcome('coordination.book_failed')).toBe('dead_letter')
    expect(classifyManagedOutcome('coordination.expired')).toBe('dead_letter')
    expect(classifyManagedOutcome('reshuffle.failed')).toBe('dead_letter')
  })

  it('classifies everything else as other', () => {
    expect(classifyManagedOutcome('coordination.started')).toBe('other')
    expect(classifyManagedOutcome('reshuffle.wave_sent')).toBe('other')
    expect(classifyManagedOutcome('coordination.contact_replied')).toBe('other')
    expect(classifyManagedOutcome('initiation.proposed')).toBe('other')
  })
})

describe('resolutionAutonomyRatio', () => {
  it('returns 1 when there were no negotiations', () => {
    expect(resolutionAutonomyRatio(0, 0)).toBe(1)
  })

  it('computes resolved / (resolved + dead-lettered)', () => {
    expect(resolutionAutonomyRatio(3, 1)).toBe(0.75)
    expect(resolutionAutonomyRatio(0, 2)).toBe(0)
    expect(resolutionAutonomyRatio(5, 0)).toBe(1)
  })
})
