import { describe, it, expect } from 'vitest'
import { renderDayOptions, dayStartFloor } from './customer-booking.js'
import type { DayOptions } from '../availability/day-options.js'

// Pure render tests — no DB. We construct DayOptions literals directly and assert
// the text + offered output of renderDayOptions in both `offerable` modes.

const TZ = 'Asia/Jerusalem'
// A fixed business-local day far enough in the future that nothing is past-filtered
// (renderDayOptions does NOT filter past — that is listDayOptions' job).
const DATE = '2030-09-02' // a Monday

// Build an instant at HH:MM local on DATE by relying on the offset; we only need
// distinct, ordered instants, so constructing via an ISO with +03:00 (IDT) is fine.
function at(hour: number, minute = 0): Date {
  return new Date(`${DATE}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+03:00`)
}

function dayWith(classes: DayOptions['classes'], privateOpenings: DayOptions['privateOpenings'] = []): DayOptions {
  return { dateStr: DATE, classes, privateOpenings }
}

const fullClass: DayOptions['classes'][number] = {
  serviceTypeId: 'svc-yoga',
  serviceName: 'Yoga',
  start: at(10, 0),
  end: at(11, 0),
  spotsTotal: 8,
  spotsLeft: 0,
}
const openClass: DayOptions['classes'][number] = {
  serviceTypeId: 'svc-pilates',
  serviceName: 'Pilates',
  start: at(14, 0),
  end: at(15, 0),
  spotsTotal: 8,
  spotsLeft: 2,
}

describe('renderDayOptions — offerable mode drops full classes', () => {
  it('DROPS a spotsLeft:0 class entirely (not in text, not in offered)', () => {
    const day = dayWith([fullClass, openClass])
    const res = renderDayOptions(day, DATE, TZ, { offerable: true })
    expect(res.text).not.toBeNull()
    expect(res.text).not.toContain('Yoga')
    expect(res.text).toContain('Pilates')
    expect(res.text).not.toContain('full')
    const offeredIds = res.offered.map((o) => o.serviceTypeId)
    expect(offeredIds).not.toContain('svc-yoga')
    expect(offeredIds).toContain('svc-pilates')
  })

  it('keeps a spotsLeft:2 class in text and offered', () => {
    const day = dayWith([openClass])
    const res = renderDayOptions(day, DATE, TZ, { offerable: true })
    expect(res.text).toContain('Pilates')
    expect(res.text).toContain('2 spots left')
    expect(res.offered.map((o) => o.serviceTypeId)).toContain('svc-pilates')
  })
})

describe('renderDayOptions — grounding mode (offerable:false) locks current behavior', () => {
  it('KEEPS the full class with a "(full)" label and in offered', () => {
    const day = dayWith([fullClass, openClass])
    const res = renderDayOptions(day, DATE, TZ, { offerable: false })
    expect(res.text).toContain('Yoga')
    expect(res.text).toContain('full')
    expect(res.text).toContain('Pilates')
    const offeredIds = res.offered.map((o) => o.serviceTypeId)
    expect(offeredIds).toContain('svc-yoga')
    expect(offeredIds).toContain('svc-pilates')
  })
})

describe('renderDayOptions — privateOpenings render unchanged in both modes', () => {
  const privateOpening: DayOptions['privateOpenings'][number] = {
    serviceTypeId: 'svc-massage',
    serviceName: 'Massage',
    durationMinutes: 60,
    slots: [at(9, 0), at(16, 0)],
  }

  for (const offerable of [true, false]) {
    it(`renders private openings (offerable:${offerable})`, () => {
      const day = dayWith([], [privateOpening])
      const res = renderDayOptions(day, DATE, TZ, { offerable })
      expect(res.text).toContain('Massage')
      expect(res.offered.map((o) => o.serviceTypeId)).toContain('svc-massage')
    })
  }
})

describe('renderDayOptions — timeOfDay bucket filtering', () => {
  it('keeps only afternoon classes when timeOfDay=afternoon', () => {
    // Yoga 10:00 (morning, full), Pilates 14:00 (afternoon, open)
    const day = dayWith([fullClass, openClass])
    const res = renderDayOptions(day, DATE, TZ, { offerable: false, timeOfDay: 'afternoon' })
    expect(res.text).toContain('Pilates')
    expect(res.text).not.toContain('Yoga')
  })

  // F2a / Symptom-2 — SAME-DAY-FIRST. When the asked part-of-day is empty but the day has
  // real options at OTHER times, offer those (with a part-scoped negative) instead of
  // dead-ending on "no <part>" — which the caller generalized into a false whole-day-empty
  // and a premature jump to OTHER days.
  it('offers same-day alternatives when the bucket is empty but the day has other-time options', () => {
    const day = dayWith([openClass]) // only 14:00 afternoon Pilates
    const res = renderDayOptions(day, DATE, TZ, { offerable: true, timeOfDay: 'morning' })
    expect(res.text).toContain('morning') // part-scoped negative retained
    expect(res.text).toContain('Pilates') // the same-day alternative IS offered
    expect(res.offered.map((o) => o.serviceTypeId)).toContain('svc-pilates')
  })

  it('returns a bare "No <bucket>" with no offers ONLY when the day is genuinely empty', () => {
    const day = dayWith([]) // nothing at all that day
    const res = renderDayOptions(day, DATE, TZ, { offerable: true, timeOfDay: 'morning' })
    expect(res.text).toContain('morning')
    expect(res.offered).toHaveLength(0)
  })

  it('drops a full class from the same-day alternative (offerable mode)', () => {
    // morning asked; the day has only a FULL morning-adjacent... use afternoon full + open
    const day = dayWith([{ ...fullClass, start: at(14, 0), end: at(15, 0) }]) // afternoon, full
    const res = renderDayOptions(day, DATE, TZ, { offerable: true, timeOfDay: 'morning' })
    // the only other-time option is full → not offerable → bare "No morning" + no offers
    expect(res.text).toContain('morning')
    expect(res.offered).toHaveLength(0)
  })
})

describe('dayStartFloor — H1 day-start floor', () => {
  it('returns start-of-day when requestedStart is later that same day', () => {
    const requested = at(14, 0) // 14:00 local
    const now = at(8, 0) // earlier same day, before midnight-of-day is moot
    const floor = dayStartFloor(requested, now, TZ)
    // floor should be 00:00 local on DATE, i.e. earlier than the requested clock time
    expect(floor.getTime()).toBeLessThan(requested.getTime())
    expect(floor.getTime()).toBeLessThanOrEqual(now.getTime())
  })

  it('returns now when the start-of-day is already in the past', () => {
    const requested = at(14, 0)
    const now = at(11, 0) // start-of-day (00:00) is before now
    const floor = dayStartFloor(requested, now, TZ)
    expect(floor.getTime()).toBe(now.getTime())
  })
})
