import { describe, it, expect } from 'vitest'
import {
  pruneConstraints,
  isSlotSuppressed,
  filterOpenSlots,
  addRejectedSlots,
  removeRejectedSlot,
  mergeAvoid,
  MAX_REJECTED_SLOTS,
  type NegotiationConstraints,
  type RejectedSlot,
} from './negotiation-constraints.js'

const TZ = 'Asia/Jerusalem'

// Build an ISO instant for a business-local wall-clock time. Jerusalem is UTC+3 in
// June (DST), so 15:00 local on 2026-06-25 (a Thursday) is 12:00Z.
const iso = (utcHour: number, day = 25, min = 0): string =>
  `2026-06-${String(day).padStart(2, '0')}T${String(utcHour).padStart(2, '0')}:${String(min).padStart(2, '0')}:00.000Z`
const at = (utcHour: number, day = 25, min = 0): Date => new Date(iso(utcHour, day, min))
const slot = (utcHour: number, day = 25): { start: Date; end: Date } => ({
  start: at(utcHour, day),
  end: at(utcHour + 1, day),
})
const rejected = (utcHour: number, day = 25, serviceTypeId?: string): RejectedSlot => ({
  start: iso(utcHour, day),
  end: iso(utcHour + 1, day),
  ...(serviceTypeId ? { serviceTypeId } : {}),
})

describe('pruneConstraints', () => {
  it('drops rejected slots whose start is at or before now', () => {
    const c: NegotiationConstraints = { rejectedSlots: [rejected(9), rejected(12), rejected(15)] }
    // now = 12:30Z → the 09:00 and 12:00 slots are past, 15:00 survives.
    const out = pruneConstraints(c, at(12, 25, 30))
    expect(out.rejectedSlots).toEqual([rejected(15)])
  })

  it('caps to the most recent MAX_REJECTED_SLOTS, keeping the newest', () => {
    const many = Array.from({ length: MAX_REJECTED_SLOTS + 5 }, (_, i) => rejected(0, 26, String(i))) // all future vs now
    const out = pruneConstraints({ rejectedSlots: many }, at(0, 25))
    expect(out.rejectedSlots).toHaveLength(MAX_REJECTED_SLOTS)
    // The last MAX kept (newest by insertion order).
    expect(out.rejectedSlots).toEqual(many.slice(-MAX_REJECTED_SLOTS))
  })

  it('preserves a non-empty avoid and omits empty fields', () => {
    expect(pruneConstraints({ avoid: { beforeHour: 12 } }, at(0)).avoid).toEqual({ beforeHour: 12 })
    expect(pruneConstraints({ avoid: { weekdays: [] } }, at(0)).avoid).toBeUndefined()
    expect(pruneConstraints({}, at(0))).toEqual({})
    expect(pruneConstraints(undefined, at(0))).toEqual({})
  })
})

describe('isSlotSuppressed — rejected slots (concrete instant, service-agnostic)', () => {
  it('suppresses a slot whose start instant equals a rejected start', () => {
    const c: NegotiationConstraints = { rejectedSlots: [rejected(12)] }
    expect(isSlotSuppressed(at(12), c, TZ)).toBe(true)
  })

  it('ignores serviceTypeId — a rejection suppresses that instant for any service', () => {
    const c: NegotiationConstraints = { rejectedSlots: [rejected(12, 25, 'yoga')] }
    // Same instant, different service intent — still suppressed (customer is busy then).
    expect(isSlotSuppressed(at(12), c, TZ)).toBe(true)
  })

  it('does not suppress a different instant (same wall-clock, different day)', () => {
    const c: NegotiationConstraints = { rejectedSlots: [rejected(12, 25)] }
    expect(isSlotSuppressed(at(12, 26), c, TZ)).toBe(false) // next day's 15:00 local is fine
  })

  it('returns false with no constraints', () => {
    expect(isSlotSuppressed(at(12), undefined, TZ)).toBe(false)
    expect(isSlotSuppressed(at(12), {}, TZ)).toBe(false)
  })
})

describe('isSlotSuppressed — categorical avoid (business-local wall clock)', () => {
  // 09:00Z = 12:00 local, 06:00Z = 09:00 local, 16:00Z = 19:00 local.
  it('"no mornings" (beforeHour 12) suppresses a 09:00-local slot but not a noon slot', () => {
    const c: NegotiationConstraints = { avoid: { beforeHour: 12 } }
    expect(isSlotSuppressed(at(6), c, TZ)).toBe(true) // 09:00 local
    expect(isSlotSuppressed(at(9), c, TZ)).toBe(false) // 12:00 local
  })

  it('afterHour suppresses evening slots', () => {
    const c: NegotiationConstraints = { avoid: { afterHour: 17 } }
    expect(isSlotSuppressed(at(16), c, TZ)).toBe(true) // 19:00 local >= 17
    expect(isSlotSuppressed(at(9), c, TZ)).toBe(false) // 12:00 local
  })

  it('weekdays suppresses the named business-local day', () => {
    // 2026-06-25 is a Thursday (4); 2026-06-26 is a Friday (5).
    const c: NegotiationConstraints = { avoid: { weekdays: [4] } }
    expect(isSlotSuppressed(at(9, 25), c, TZ)).toBe(true)
    expect(isSlotSuppressed(at(9, 26), c, TZ)).toBe(false)
  })
})

describe('filterOpenSlots', () => {
  it('removes suppressed slots and keeps the rest', () => {
    const c: NegotiationConstraints = { rejectedSlots: [rejected(12)], avoid: { afterHour: 17 } }
    const slots = [slot(9), slot(12), slot(16)] // 12:00, 15:00, 19:00 local
    const out = filterOpenSlots(slots, c, TZ)
    expect(out).toEqual([slot(9)]) // 15:00 rejected, 19:00 avoided
  })

  it('returns the input untouched when there are no constraints', () => {
    const slots = [slot(9), slot(12)]
    expect(filterOpenSlots(slots, {}, TZ)).toBe(slots)
    expect(filterOpenSlots(slots, undefined, TZ)).toBe(slots)
  })
})

describe('addRejectedSlots', () => {
  it('appends and dedupes by start instant', () => {
    const c = addRejectedSlots({ rejectedSlots: [rejected(12)] }, [rejected(12), rejected(15)])
    expect(c.rejectedSlots).toEqual([rejected(12), rejected(15)])
  })

  it('caps the merged list to MAX_REJECTED_SLOTS (newest kept)', () => {
    const start: NegotiationConstraints = {
      rejectedSlots: Array.from({ length: MAX_REJECTED_SLOTS }, (_, i) => rejected(0, 26, String(i))),
    }
    const out = addRejectedSlots(start, [rejected(1, 26, '99')])
    expect(out.rejectedSlots).toHaveLength(MAX_REJECTED_SLOTS)
    expect(out.rejectedSlots!.at(-1)).toEqual(rejected(1, 26, '99'))
  })

  it('preserves an existing avoid block', () => {
    const out = addRejectedSlots({ avoid: { beforeHour: 12 } }, [rejected(12)])
    expect(out.avoid).toEqual({ beforeHour: 12 })
  })
})

describe('removeRejectedSlot', () => {
  it('removes the matching instant and leaves others', () => {
    const c: NegotiationConstraints = { rejectedSlots: [rejected(12), rejected(15)] }
    expect(removeRejectedSlot(c, iso(12)).rejectedSlots).toEqual([rejected(15)])
  })

  it('drops the rejectedSlots key entirely when the last entry is removed', () => {
    const c: NegotiationConstraints = { rejectedSlots: [rejected(12)], avoid: { beforeHour: 12 } }
    const out = removeRejectedSlot(c, iso(12))
    expect(out.rejectedSlots).toBeUndefined()
    expect(out.avoid).toEqual({ beforeHour: 12 })
  })

  it('is a no-op when nothing matches', () => {
    const c: NegotiationConstraints = { rejectedSlots: [rejected(12)] }
    expect(removeRejectedSlot(c, iso(15)).rejectedSlots).toEqual([rejected(12)])
  })
})

describe('mergeAvoid', () => {
  it('overwrites hour bounds and unions weekdays', () => {
    const a = mergeAvoid({ avoid: { beforeHour: 10, weekdays: [4] } }, { beforeHour: 12, weekdays: [2] })
    expect(a.avoid).toEqual({ beforeHour: 12, weekdays: [2, 4] })
  })

  it('seeds avoid from empty constraints', () => {
    expect(mergeAvoid(undefined, { afterHour: 18 }).avoid).toEqual({ afterHour: 18 })
  })

  it('keeps existing rejectedSlots intact', () => {
    const out = mergeAvoid({ rejectedSlots: [rejected(12)] }, { beforeHour: 12 })
    expect(out.rejectedSlots).toEqual([rejected(12)])
  })
})
