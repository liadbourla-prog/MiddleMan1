import { describe, it, expect } from 'vitest'
import {
  runIntegrityChecks,
  type IntegritySnapshot,
  type BookingSnapshot,
} from './integrity.js'

const T0 = new Date('2026-06-22T08:00:00Z') // a Monday 08:00
const HOUR = 60 * 60 * 1000

function booking(over: Partial<BookingSnapshot> = {}): BookingSnapshot {
  return {
    id: over.id ?? 'b1',
    serviceTypeId: over.serviceTypeId ?? 'svc1',
    slotStart: over.slotStart ?? T0,
    slotEnd: over.slotEnd ?? new Date(T0.getTime() + HOUR),
    state: over.state ?? 'confirmed',
    calendarEventId: over.calendarEventId ?? null,
    rescheduledFrom: over.rescheduledFrom ?? null,
    holdExpiresAt: over.holdExpiresAt ?? null,
    isGroup: over.isGroup ?? false,
  }
}

function snapshot(over: Partial<IntegritySnapshot> = {}): IntegritySnapshot {
  return {
    now: over.now ?? new Date(T0.getTime() + 100 * HOUR),
    googleMode: over.googleMode ?? false,
    bookings: over.bookings ?? [],
    googleEvents: over.googleEvents ?? [],
    knownBlockEventIds: over.knownBlockEventIds ?? [],
    reminders: over.reminders ?? [],
    holdGraceMs: over.holdGraceMs ?? 60_000,
  }
}

const kinds = (s: IntegritySnapshot) => runIntegrityChecks(s).map((f) => f.kind)

describe('runIntegrityChecks', () => {
  it('a clean snapshot produces no findings', () => {
    const s = snapshot({
      bookings: [
        booking({ id: 'b1', slotStart: T0, slotEnd: new Date(T0.getTime() + HOUR) }),
        booking({ id: 'b2', slotStart: new Date(T0.getTime() + HOUR), slotEnd: new Date(T0.getTime() + 2 * HOUR) }),
      ],
    })
    expect(runIntegrityChecks(s)).toEqual([])
  })

  // ── INV-1 double_book ──────────────────────────────────────────────────────
  it('INV-1 flags two overlapping active bookings as a critical double_book with quarantine', () => {
    const s = snapshot({
      bookings: [
        booking({ id: 'b1', slotStart: T0, slotEnd: new Date(T0.getTime() + HOUR) }),
        booking({ id: 'b2', slotStart: new Date(T0.getTime() + 30 * 60_000), slotEnd: new Date(T0.getTime() + 90 * 60_000) }),
      ],
    })
    const findings = runIntegrityChecks(s)
    expect(findings).toHaveLength(1)
    expect(findings[0]!.kind).toBe('double_book')
    expect(findings[0]!.severity).toBe('critical')
    expect(findings[0]!.quarantineSlot).toBeDefined()
    expect(findings[0]!.dedupKey).toBe('double_book:b1:b2')
  })

  it('INV-1 does NOT flag two participants in the same group-class instance', () => {
    const s = snapshot({
      bookings: [
        booking({ id: 'b1', isGroup: true, serviceTypeId: 'yoga', slotStart: T0 }),
        booking({ id: 'b2', isGroup: true, serviceTypeId: 'yoga', slotStart: T0 }),
      ],
    })
    expect(kinds(s)).not.toContain('double_book')
  })

  it('INV-1 ignores cancelled bookings (only active overlap counts)', () => {
    const s = snapshot({
      bookings: [
        booking({ id: 'b1', slotStart: T0 }),
        booking({ id: 'b2', slotStart: T0, state: 'cancelled' }),
      ],
    })
    expect(kinds(s)).not.toContain('double_book')
  })

  // ── INV-2 ghost ────────────────────────────────────────────────────────────
  it('INV-2 flags a confirmed booking whose Google event has vanished', () => {
    const s = snapshot({
      googleMode: true,
      bookings: [booking({ id: 'b1', state: 'confirmed', calendarEventId: 'ev1' })],
      googleEvents: [], // ev1 gone
    })
    expect(kinds(s)).toContain('ghost')
  })

  it('INV-2 does not fire when not in google mode', () => {
    const s = snapshot({
      googleMode: false,
      bookings: [booking({ id: 'b1', state: 'confirmed', calendarEventId: 'ev1' })],
      googleEvents: [],
    })
    expect(kinds(s)).not.toContain('ghost')
  })

  // ── INV-5 time_mismatch ────────────────────────────────────────────────────
  it('INV-5 flags a booking whose Google event was dragged to a different time', () => {
    const s = snapshot({
      googleMode: true,
      bookings: [booking({ id: 'b1', state: 'confirmed', calendarEventId: 'ev1', slotStart: T0, slotEnd: new Date(T0.getTime() + HOUR) })],
      googleEvents: [{ id: 'ev1', start: new Date(T0.getTime() + 2 * HOUR), end: new Date(T0.getTime() + 3 * HOUR) }],
    })
    const f = runIntegrityChecks(s).find((x) => x.kind === 'time_mismatch')
    expect(f).toBeDefined()
    expect(f!.severity).toBe('critical')
  })

  it('a booking matching its Google event exactly produces neither ghost nor time_mismatch', () => {
    const s = snapshot({
      googleMode: true,
      bookings: [booking({ id: 'b1', state: 'confirmed', calendarEventId: 'ev1', slotStart: T0, slotEnd: new Date(T0.getTime() + HOUR) })],
      googleEvents: [{ id: 'ev1', start: T0, end: new Date(T0.getTime() + HOUR) }],
    })
    expect(runIntegrityChecks(s)).toEqual([])
  })

  // ── INV-3 orphan ───────────────────────────────────────────────────────────
  it('INV-3 flags an unknown Google event overlapping a booking as a critical collision with quarantine', () => {
    const s = snapshot({
      googleMode: true,
      bookings: [booking({ id: 'b1', state: 'confirmed', calendarEventId: 'ev1', slotStart: T0, slotEnd: new Date(T0.getTime() + HOUR) })],
      googleEvents: [
        { id: 'ev1', start: T0, end: new Date(T0.getTime() + HOUR) }, // the known one
        { id: 'evX', start: T0, end: new Date(T0.getTime() + HOUR) }, // unknown, overlaps
      ],
    })
    const f = runIntegrityChecks(s).find((x) => x.kind === 'orphan')
    expect(f).toBeDefined()
    expect(f!.severity).toBe('critical')
    expect(f!.quarantineSlot).toBeDefined()
  })

  it('INV-3 flags a non-overlapping unknown Google event as a warning (sync gap), no quarantine', () => {
    const s = snapshot({
      googleMode: true,
      bookings: [],
      googleEvents: [{ id: 'evX', start: new Date(T0.getTime() + 10 * HOUR), end: new Date(T0.getTime() + 11 * HOUR) }],
    })
    const f = runIntegrityChecks(s).find((x) => x.kind === 'orphan')
    expect(f).toBeDefined()
    expect(f!.severity).toBe('warning')
    expect(f!.quarantineSlot).toBeUndefined()
  })

  it('INV-3 treats a Google event linked to a known block as NOT an orphan', () => {
    const s = snapshot({
      googleMode: true,
      bookings: [],
      googleEvents: [{ id: 'blk1', start: T0, end: new Date(T0.getTime() + HOUR) }],
      knownBlockEventIds: ['blk1'],
    })
    expect(kinds(s)).not.toContain('orphan')
  })

  // ── INV-6 reminder_orphan ──────────────────────────────────────────────────
  it('INV-6 flags a pending reminder for a cancelled booking, auto-remediable', () => {
    const s = snapshot({
      bookings: [booking({ id: 'b1', state: 'cancelled' })],
      reminders: [{ id: 'r1', bookingId: 'b1', sentAt: null }],
    })
    const f = runIntegrityChecks(s).find((x) => x.kind === 'reminder_orphan')
    expect(f).toBeDefined()
    expect(f!.autoRemediable).toBe(true)
  })

  it('INV-6 ignores already-sent reminders and reminders for active bookings', () => {
    const s = snapshot({
      bookings: [booking({ id: 'b1', state: 'confirmed' })],
      reminders: [
        { id: 'r1', bookingId: 'b1', sentAt: null }, // active booking → fine
        { id: 'r2', bookingId: 'gone', sentAt: T0 }, // already sent → history
      ],
    })
    expect(kinds(s)).not.toContain('reminder_orphan')
  })

  // ── INV-7 stuck_hold ───────────────────────────────────────────────────────
  it('INV-7 flags a hold expired beyond the grace window, auto-remediable', () => {
    const now = new Date(T0.getTime() + 100 * HOUR)
    const s = snapshot({
      now,
      bookings: [booking({ id: 'b1', state: 'held', holdExpiresAt: new Date(now.getTime() - 10 * 60_000) })],
    })
    const f = runIntegrityChecks(s).find((x) => x.kind === 'stuck_hold')
    expect(f).toBeDefined()
    expect(f!.autoRemediable).toBe(true)
  })

  it('INV-7 does not flag a hold still within its grace window', () => {
    const now = new Date(T0.getTime() + 100 * HOUR)
    const s = snapshot({
      now,
      holdGraceMs: 60_000,
      bookings: [booking({ id: 'b1', state: 'held', holdExpiresAt: new Date(now.getTime() - 10_000) })],
    })
    expect(kinds(s)).not.toContain('stuck_hold')
  })

  // ── INV-8 reschedule_residue ───────────────────────────────────────────────
  it('INV-8 flags a reschedule that left both old and new bookings active', () => {
    const s = snapshot({
      bookings: [
        booking({ id: 'old', state: 'confirmed', slotStart: T0 }),
        booking({ id: 'new', state: 'confirmed', rescheduledFrom: 'old', slotStart: new Date(T0.getTime() + 5 * HOUR) }),
      ],
    })
    const f = runIntegrityChecks(s).find((x) => x.kind === 'reschedule_residue')
    expect(f).toBeDefined()
    expect(f!.severity).toBe('critical')
  })

  it('INV-8 is clean when the superseded booking was properly cancelled', () => {
    const s = snapshot({
      bookings: [
        booking({ id: 'old', state: 'cancelled', slotStart: T0 }),
        booking({ id: 'new', state: 'confirmed', rescheduledFrom: 'old', slotStart: new Date(T0.getTime() + 5 * HOUR) }),
      ],
    })
    expect(kinds(s)).not.toContain('reschedule_residue')
  })
})
