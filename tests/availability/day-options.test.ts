import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the open-slots spine so these tests focus on day-options' own logic
// (class enumeration, capacity, service filtering, past-filtering). Private
// openings are driven by the mock.
const getOpenSlots = vi.fn()
vi.mock('../../src/domain/availability/service.js', () => ({
  getOpenSlots: (...a: unknown[]) => getOpenSlots(...a),
}))

import { listDayOptions } from '../../src/domain/availability/day-options.js'
import { resolveSlotStart } from '../../src/domain/availability/resolve-slot.js'
import { serviceTypes, calendarBlocks, bookings } from '../../src/db/schema.js'

const TZ = 'Asia/Jerusalem'
const DAY = '2026-06-15' // a Monday

const at = (h: number, m = 0) => resolveSlotStart(DAY, { hour: h, minute: m }, TZ)

const YOGA = { id: 'yoga', name: 'Vinyasa Flow', durationMinutes: 60, maxParticipants: 10 }
const MASSAGE = { id: 'massage', name: 'Massage', durationMinutes: 30, maxParticipants: 1 }

// Minimal chainable Drizzle stub that routes resolved rows by the queried table.
// where()/orderBy() are ignored — the helper's in-memory logic is what's tested;
// the DB predicates are exercised in integration.
function makeDb(data: { services?: unknown[]; blocks?: unknown[]; seats?: unknown[] }) {
  return {
    select() {
      const state: { tbl?: unknown } = {}
      const chain: Record<string, unknown> = {
        from(tbl: unknown) { state.tbl = tbl; return chain },
        where() { return chain },
        orderBy() { return chain },
        then(res: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) {
          let rows: unknown[] = []
          if (state.tbl === serviceTypes) rows = data.services ?? []
          else if (state.tbl === calendarBlocks) rows = data.blocks ?? []
          else if (state.tbl === bookings) rows = data.seats ?? []
          return Promise.resolve(rows).then(res, rej)
        },
      }
      return chain
    },
  }
}

const biz = { id: 'biz-1' } as never

describe('listDayOptions', () => {
  beforeEach(() => {
    getOpenSlots.mockReset()
    getOpenSlots.mockResolvedValue([])
  })

  it('lists the day classes with correct spots left and includes private openings', async () => {
    getOpenSlots.mockResolvedValue([{ start: at(11), end: at(11, 30) }, { start: at(14, 30), end: at(15) }])
    const db = makeDb({
      services: [YOGA, MASSAGE],
      blocks: [
        { serviceTypeId: 'yoga', startTs: at(9), endTs: at(10), maxParticipants: 10 },
        { serviceTypeId: 'yoga', startTs: at(18), endTs: at(19), maxParticipants: 10 },
      ],
      // 3 booked into the 09:00 class, none into 18:00
      seats: [
        { serviceTypeId: 'yoga', slotStart: at(9) },
        { serviceTypeId: 'yoga', slotStart: at(9) },
        { serviceTypeId: 'yoga', slotStart: at(9) },
      ],
    })

    const out = await listDayOptions(db as never, biz, DAY, TZ, { now: at(0) })

    expect(out.classes).toHaveLength(2)
    expect(out.classes[0]).toMatchObject({ serviceName: 'Vinyasa Flow', spotsTotal: 10, spotsLeft: 7 })
    expect(out.classes[1]).toMatchObject({ spotsLeft: 10 })
    // ordered by start
    expect(out.classes[0]!.start.getTime()).toBeLessThan(out.classes[1]!.start.getTime())

    expect(out.privateOpenings).toHaveLength(1)
    expect(out.privateOpenings[0]).toMatchObject({ serviceName: 'Massage' })
    expect(out.privateOpenings[0]!.slots).toHaveLength(2)
  })

  it('narrows to a named service only (class type → no private openings)', async () => {
    getOpenSlots.mockResolvedValue([{ start: at(11), end: at(11, 30) }])
    const db = makeDb({
      services: [YOGA], // DB would narrow; mirror that here
      blocks: [{ serviceTypeId: 'yoga', startTs: at(9), endTs: at(10), maxParticipants: 10 }],
      seats: [],
    })

    const out = await listDayOptions(db as never, biz, DAY, TZ, { serviceTypeId: 'yoga', now: at(0) })

    expect(out.classes).toHaveLength(1)
    expect(out.classes[0]!.serviceName).toBe('Vinyasa Flow')
    expect(out.privateOpenings).toHaveLength(0)
  })

  it('narrows to a named private service (no classes, just open slots)', async () => {
    getOpenSlots.mockResolvedValue([{ start: at(11), end: at(11, 30) }, { start: at(13), end: at(13, 30) }])
    const db = makeDb({
      services: [MASSAGE],
      blocks: [{ serviceTypeId: 'yoga', startTs: at(9), endTs: at(10), maxParticipants: 10 }], // wrong service — must be skipped
      seats: [],
    })

    const out = await listDayOptions(db as never, biz, DAY, TZ, { serviceTypeId: 'massage', now: at(0) })

    expect(out.classes).toHaveLength(0)
    expect(out.privateOpenings).toHaveLength(1)
    expect(out.privateOpenings[0]!.slots).toHaveLength(2)
  })

  it('never lists a class that has already started today', async () => {
    const db = makeDb({
      services: [YOGA],
      blocks: [
        { serviceTypeId: 'yoga', startTs: at(9), endTs: at(10), maxParticipants: 10 },
        { serviceTypeId: 'yoga', startTs: at(18), endTs: at(19), maxParticipants: 10 },
      ],
      seats: [],
    })

    // "now" is 12:00 local — the 09:00 class is in the past, the 18:00 is not.
    const out = await listDayOptions(db as never, biz, DAY, TZ, { now: at(12) })

    expect(out.classes).toHaveLength(1)
    expect(out.classes[0]!.start.getTime()).toBe(at(18).getTime())
  })

  it('clamps spots left to zero for a full class', async () => {
    const db = makeDb({
      services: [YOGA],
      blocks: [{ serviceTypeId: 'yoga', startTs: at(9), endTs: at(10), maxParticipants: 2 }],
      seats: [
        { serviceTypeId: 'yoga', slotStart: at(9) },
        { serviceTypeId: 'yoga', slotStart: at(9) },
        { serviceTypeId: 'yoga', slotStart: at(9) }, // oversold edge — still clamps to 0
      ],
    })

    const out = await listDayOptions(db as never, biz, DAY, TZ, { now: at(0) })
    expect(out.classes[0]!.spotsLeft).toBe(0)
  })
})
