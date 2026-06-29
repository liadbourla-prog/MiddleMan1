import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { removeRejectedSlot } from '../../src/domain/flows/negotiation-constraints.js'

// WS3-T3.7 (C2): the just-confirmed slot must never be left in rejectedSlots. The
// top-of-turn promotion folds lastOfferedSlots into rejectedSlots; even though the
// hold-placement path already un-suppresses the pending slot and drops lastOfferedSlots,
// the successful hold-confirm yes-path adds a belt-and-suspenders removeRejectedSlot for
// the pending slot so a future re-suggest can never shadow-suppress what was just booked.

describe('WS3-T3.7 C2 — removeRejectedSlot drops the just-booked slot', () => {
  const PENDING = '2026-06-29T09:00:00.000Z'

  it('removes the pending slot from a rejected set', () => {
    const c = {
      rejectedSlots: [
        { start: PENDING, end: '2026-06-29T10:00:00.000Z' },
        { start: '2026-06-29T11:00:00.000Z', end: '2026-06-29T12:00:00.000Z' },
      ],
    }
    const out = removeRejectedSlot(c, PENDING)
    const starts = (out.rejectedSlots ?? []).map((r) => r.start)
    expect(starts).not.toContain(PENDING)
    expect(starts).toContain('2026-06-29T11:00:00.000Z')
  })

  it('is a no-op (never throws) when the slot is not rejected', () => {
    const c = { rejectedSlots: [{ start: '2026-06-29T11:00:00.000Z', end: '2026-06-29T12:00:00.000Z' }] }
    expect(() => removeRejectedSlot(c, PENDING)).not.toThrow()
    expect(removeRejectedSlot(c, PENDING).rejectedSlots).toHaveLength(1)
  })
})

// Source guard: the successful hold-confirm yes-path must call removeRejectedSlot for the
// pending slot (belt-and-suspenders). If a refactor drops it, this trips.
describe('WS3-T3.7 C2 — yes-path un-suppresses the confirmed slot (source guard)', () => {
  const srcPath = fileURLToPath(new URL('../../src/domain/flows/customer-booking.ts', import.meta.url))
  const src = readFileSync(srcPath, 'utf8')

  it('removeRejectedSlot is applied to the pendingSlot on the successful hold-confirm path', () => {
    // The confirmBooking ok-branch builds confirmedDate/confirmedTime from pendingSlot; the
    // C2 guard sits in that same block and references the pending slot's start instant.
    const okIdx = src.indexOf('New booking is committed — now (and only now) release')
    expect(okIdx).toBeGreaterThan(-1)
    const block = src.slice(okIdx, okIdx + 1500)
    expect(block).toContain('removeRejectedSlot')
    expect(block).toContain('pendingSlot.start')
  })
})
