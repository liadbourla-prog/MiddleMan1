/**
 * DO-NOT-REGRESS guard net (plan task T0.1).
 *
 * These four guarantees were verified SOLID during the 2026-06-28 hardening review
 * (see docs/superpowers/reviews/2026-06-28-branch34-calendar-bughunt.md §G/§H). They
 * MUST stay green through the hardening work — especially the WS2/WS3/WS-VOICE churn on
 * customer-booking.ts. Each block guards the PURE core underpinning one guarantee:
 *
 *   G1      — an available slot is never wrongly suppressed/rejected (suggestion filter)
 *   G4      — day/time resolution is deterministic, tz-anchored, label == date
 *   G5      — the fabrication gate only ever tightens (no invented time slips, real ones pass)
 *   C-PIVOT — a mid-booking REVISION never parses as a plain confirmation
 *
 * Pure-function level on purpose: stable, fast, no DB/LLM. The integration faces of
 * these guarantees (e.g. the booking-request path never consulting rejectedSlots) are
 * covered by customer-booking.test.ts; this file is the fast tripwire.
 */
import { describe, it, expect, vi } from 'vitest'
import { resolveRequestedDate, resolveSlotStart } from '../availability/resolve-slot.js'
import { findUnbackedTimes, assertsNoAvailability, extractClockTimes } from './slot-fabrication-guard.js'
import { parseConfirmation } from './types.js'
import { isSlotSuppressed, filterOpenSlots } from './negotiation-constraints.js'

// classInstanceMissing's only DB dependency. Mocked so this fast tripwire stays pure —
// the mock affects ONLY the blocks import; the 14 pure guards above never touch it.
vi.mock('../availability/blocks.js', () => ({
  findClassBlockProviderForSlot: vi.fn(),
}))
import { findClassBlockProviderForSlot } from '../availability/blocks.js'
import { classInstanceMissing } from './customer-booking.js'

const TZ = 'Asia/Jerusalem'
// 2026-06-28 12:00 local (UTC+3 in summer) — a SUNDAY. Fixed so tests are deterministic.
const NOW = new Date('2026-06-28T09:00:00Z')
const utcDow = (dateStr: string): number => new Date(`${dateStr}T00:00:00Z`).getUTCDay()

describe('DO-NOT-REGRESS · G4 — day/time resolution (deterministic, tz-anchored, label==date)', () => {
  it('resolves relative days correctly from business-local today', () => {
    expect(resolveRequestedDate({ relativeDay: 'today', weekday: null, explicitDate: null }, TZ, NOW))
      .toEqual({ ok: true, dateStr: '2026-06-28' })
    expect(resolveRequestedDate({ relativeDay: 'tomorrow', weekday: null, explicitDate: null }, TZ, NOW))
      .toEqual({ ok: true, dateStr: '2026-06-29' })
    expect(resolveRequestedDate({ relativeDay: 'day_after_tomorrow', weekday: null, explicitDate: null }, TZ, NOW))
      .toEqual({ ok: true, dateStr: '2026-06-30' })
  })

  it('weekday resolves to the next occurrence and the LABEL matches the DATE (no off-by-one)', () => {
    // today is Sunday(0); Tuesday(2) is the 30th
    const tue = resolveRequestedDate({ relativeDay: null, weekday: 2, explicitDate: null }, TZ, NOW)
    expect(tue).toEqual({ ok: true, dateStr: '2026-06-30' })
    expect(tue.ok && utcDow(tue.dateStr)).toBe(2) // the resolved date IS a Tuesday

    // next_week shifts by exactly 7 and keeps the weekday
    const nextTue = resolveRequestedDate({ relativeDay: 'next_week', weekday: 2, explicitDate: null }, TZ, NOW)
    expect(nextTue).toEqual({ ok: true, dateStr: '2026-07-07' })
    expect(nextTue.ok && utcDow(nextTue.dateStr)).toBe(2)
  })

  it('rejects past years and impossible dates (the 2016 / 30-Feb bugs)', () => {
    expect(resolveRequestedDate({ relativeDay: null, weekday: null, explicitDate: { year: 2016, month: 1, day: 10 } }, TZ, NOW))
      .toEqual({ ok: false, reason: 'past_year' })
    expect(resolveRequestedDate({ relativeDay: null, weekday: null, explicitDate: { year: 2026, month: 2, day: 30 } }, TZ, NOW))
      .toEqual({ ok: false, reason: 'impossible_date' })
  })

  it('a bare relative week with no weekday is ambiguous, never a silent guess', () => {
    expect(resolveRequestedDate({ relativeDay: 'this_week', weekday: null, explicitDate: null }, TZ, NOW))
      .toEqual({ ok: false, reason: 'ambiguous_date' })
  })

  it('resolveSlotStart yields a real UTC instant for the resolved date+time', () => {
    const d = resolveSlotStart('2026-06-29', { hour: 18, minute: 0 }, TZ)
    expect(d).toBeInstanceOf(Date)
    expect(Number.isNaN(d.getTime())).toBe(false)
  })
})

describe('DO-NOT-REGRESS · G5 — fabrication gate only ever tightens', () => {
  it('flags a clock time the spine never offered, passes a backed one', () => {
    expect(findUnbackedTimes('how about 17:00?', ['10:00', '12:00'])).toEqual(['17:00'])
    expect(findUnbackedTimes('we have 10:00', ['10:00', '12:00'])).toEqual([])
  })

  it('detects blanket-unavailability phrasing (he + en), ignores neutral text', () => {
    expect(assertsNoAvailability('that day is fully booked')).toBe(true)
    expect(assertsNoAvailability('אין מקום ביום ראשון')).toBe(true)
    expect(assertsNoAvailability('we have 10:00 and 12:00 open')).toBe(false)
  })

  it('extractClockTimes finds HH:MM and ignores non-times', () => {
    expect(extractClockTimes('10:00 and 12:00')).toEqual(['10:00', '12:00'])
    expect(extractClockTimes('that costs 150 for 60 minutes')).toEqual([])
  })
})

describe('DO-NOT-REGRESS · C-PIVOT — a revision never parses as a plain confirm', () => {
  it('plain affirmatives confirm', () => {
    expect(parseConfirmation('yes')).toBe('yes')
    expect(parseConfirmation('כן')).toBe('yes')
    expect(parseConfirmation('yes book me please')).toBe('yes')
  })

  it('explicit negatives are no', () => {
    expect(parseConfirmation('no')).toBe('no')
    expect(parseConfirmation('לא')).toBe('no')
  })

  it('a slot revision is NEVER a plain yes', () => {
    for (const revision of [
      'yes but make it Tuesday',
      'כן אבל ביום שלישי',
      'yes 16:00',
      'כן אבל ב-16:00',
      'yes but no, maybe Thursday',
    ]) {
      expect(parseConfirmation(revision)).not.toBe('yes')
    }
  })
})

describe('DO-NOT-REGRESS · G1 — an available slot is never wrongly suppressed', () => {
  const slot = (iso: string) => ({ start: new Date(iso), end: new Date(new Date(iso).getTime() + 3_600_000) })
  const open = new Date('2026-06-29T09:00:00Z')

  it('no constraints => nothing is ever suppressed', () => {
    expect(isSlotSuppressed(open, undefined, TZ)).toBe(false)
    expect(isSlotSuppressed(open, {}, TZ)).toBe(false)
  })

  it('filterOpenSlots drops nothing when there are no constraints', () => {
    const slots = [slot('2026-06-29T07:00:00Z'), slot('2026-06-29T09:00:00Z')]
    expect(filterOpenSlots(slots, undefined, TZ)).toHaveLength(2)
    expect(filterOpenSlots(slots, {}, TZ)).toHaveLength(2)
  })

  it('a slot NOT in the rejected set is still offered even when another was rejected', () => {
    const constraints = { rejectedSlots: [{ start: '2026-06-29T07:00:00Z', end: '2026-06-29T08:00:00Z' }] }
    const slots = [slot('2026-06-29T07:00:00Z'), slot('2026-06-29T09:00:00Z')]
    const kept = filterOpenSlots(slots, constraints, TZ)
    expect(kept).toHaveLength(1)
    expect(kept[0]!.start.toISOString()).toBe('2026-06-29T09:00:00.000Z')
  })
})

describe('DO-NOT-REGRESS · class studio refuses between-session times (owner invariant; extends G5)', () => {
  // OWNER CARDINAL GUARANTEE (P4): a class-mode service can NEVER be booked at a time with no
  // scheduled class instance — the empty gaps between owner-set class sessions are never bookable.
  // classInstanceMissing is the chokepoint that enforces it. This locks the chokepoint at the
  // pure-function level: refuse the gap, allow the real instance, skip the DB for appointments.
  //
  // KNOWN GAP (deferred): the SPINE-level half of this guarantee — that getOpenSlots / isSlotBookable
  // exclude calendar_blocks (block/personal) times so a blocked 15:00 is never offered as a private
  // gap — has NO unit harness today (no service.test.ts / DB fixture exists). A "blocked 15:00 never
  // offered" assertion is deferred to a future availability DB-harness task; NOT built here.
  const db = {} as never
  const slot = new Date('2026-06-29T14:00:00.000Z') // a between-session time — no class scheduled here

  it('class-mode + NO class block at the slot → refused (the between-session gap is never bookable)', async () => {
    vi.mocked(findClassBlockProviderForSlot).mockResolvedValue({ found: false })
    const svc = { id: 'svc-yoga', schedulingMode: 'class' as const }
    expect(await classInstanceMissing(db, 'biz1', svc, slot)).toBe(true)
  })

  it('class-mode + a real class block at the slot → allowed (a real instance IS bookable; protects G1)', async () => {
    vi.mocked(findClassBlockProviderForSlot).mockResolvedValue({ found: true, providerId: null, maxParticipants: 8 })
    const svc = { id: 'svc-yoga', schedulingMode: 'class' as const }
    expect(await classInstanceMissing(db, 'biz1', svc, slot)).toBe(false)
  })

  it('appointment-mode → never refused and never hits the DB (early return)', async () => {
    vi.mocked(findClassBlockProviderForSlot).mockClear()
    const svc = { id: 'svc-appt', schedulingMode: 'appointment' as const }
    expect(await classInstanceMissing(db, 'biz1', svc, slot)).toBe(false)
    expect(findClassBlockProviderForSlot).not.toHaveBeenCalled()
  })
})
