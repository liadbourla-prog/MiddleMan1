import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the open-slots spine: next-classes is about CLASS instances, not gaps.
const getOpenSlots = vi.fn()
vi.mock('../availability/service.js', () => ({
  getOpenSlots: (...a: unknown[]) => getOpenSlots(...a),
  isSlotBookable: vi.fn(),
}))

import { suggestNextClassesText } from './customer-booking.js'
import { resolveSlotStart } from '../availability/resolve-slot.js'
import { serviceTypes, calendarBlocks, bookings } from '../../db/schema.js'

const TZ = 'Asia/Jerusalem'
const DAY = '2026-06-29' // a Monday
const at = (h: number, m = 0) => resolveSlotStart(DAY, { hour: h, minute: m }, TZ)
const YOGA = { id: 'yoga', name: 'Yoga', durationMinutes: 60, maxParticipants: 8 }

// Date-blind stub: returns the same rows every day. listDayOptions' own past-filter
// then means only the DAY (matching the block times) yields classes when now=DAY 00:00.
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
const biz = { id: 'biz-1', timezone: TZ } as never

describe('suggestNextClassesText — truthful class availability', () => {
  beforeEach(() => { getOpenSlots.mockReset(); getOpenSlots.mockResolvedValue([]) })

  it('lists real classes with spots left and never claims "nothing"', async () => {
    const db = makeDb({
      services: [YOGA],
      blocks: [
        { serviceTypeId: 'yoga', startTs: at(10), endTs: at(11), maxParticipants: 8 },
        { serviceTypeId: 'yoga', startTs: at(12), endTs: at(13), maxParticipants: 8 },
      ],
      seats: [{ serviceTypeId: 'yoga', slotStart: at(10) }], // 1 of 8 taken at 10:00
    })
    const r = await suggestNextClassesText(db as never, biz, 'yoga', TZ, undefined, null, at(0))
    expect(r.text).toContain('Yoga')
    expect(r.text).toContain('10:00')
    expect(r.text).toContain('7 spots left') // 8 - 1
    expect(r.text).toContain('12:00')
    expect(r.offered).toHaveLength(2)
  })

  it('excludes a full class (0 spots left)', async () => {
    const db = makeDb({
      services: [YOGA],
      blocks: [
        { serviceTypeId: 'yoga', startTs: at(10), endTs: at(11), maxParticipants: 2 },
        { serviceTypeId: 'yoga', startTs: at(12), endTs: at(13), maxParticipants: 8 },
      ],
      seats: [{ serviceTypeId: 'yoga', slotStart: at(10) }, { serviceTypeId: 'yoga', slotStart: at(10) }],
    })
    const r = await suggestNextClassesText(db as never, biz, 'yoga', TZ, undefined, null, at(0))
    expect(r.text).not.toContain('10:00') // full → dropped
    expect(r.text).toContain('12:00')
    expect(r.offered).toHaveLength(1)
  })

  it('honours an evening time-of-day filter (>=18:00 only)', async () => {
    const db = makeDb({
      services: [YOGA],
      blocks: [
        { serviceTypeId: 'yoga', startTs: at(10), endTs: at(11), maxParticipants: 8 },
        { serviceTypeId: 'yoga', startTs: at(18), endTs: at(19), maxParticipants: 8 },
      ],
      seats: [],
    })
    const r = await suggestNextClassesText(db as never, biz, 'yoga', TZ, undefined, 'evening', at(0))
    expect(r.text).toContain('18:00')
    expect(r.text).not.toContain('10:00')
  })
})
