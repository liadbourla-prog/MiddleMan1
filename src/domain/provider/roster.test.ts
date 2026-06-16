import { describe, it, expect } from 'vitest'
import { buildTeachingScheduleBlock, type TeachingSlot } from './roster.js'

describe('buildTeachingScheduleBlock', () => {
  it('groups slots by instructor and renders weekday + time', () => {
    const slots: TeachingSlot[] = [
      { providerId: 'p1', instructor: 'Dana', service: 'Yoga', dayOfWeek: 1, startTime: '10:00' },
      { providerId: 'p1', instructor: 'Dana', service: 'Yoga', dayOfWeek: 3, startTime: '18:00' },
      { providerId: 'p2', instructor: 'Noa', service: 'Pilates', dayOfWeek: 2, startTime: '09:00' },
    ]
    const block = buildTeachingScheduleBlock(slots, 'en')
    expect(block).toContain('Dana: Yoga Mon 10:00, Yoga Wed 18:00')
    expect(block).toContain('Noa: Pilates Tue 09:00')
  })

  it('returns empty string for no slots', () => {
    expect(buildTeachingScheduleBlock([], 'en')).toBe('')
  })
})
