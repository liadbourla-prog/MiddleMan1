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
    ...(over.createdAt !== undefined ? { createdAt: over.createdAt } : {}),
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
    ...(over.blocks !== undefined ? { blocks: over.blocks } : {}),
    ...(over.unmirrorGraceMs !== undefined ? { unmirrorGraceMs: over.unmirrorGraceMs } : {}),
    ...(over.requestedReaperMs !== undefined ? { requestedReaperMs: over.requestedReaperMs } : {}),
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

  // ── INV-9 unmirrored (F-c) ───────────────────────────────────────────────────
  const GRACE = 10 * 60_000 // 10 min
  const old = new Date(T0.getTime() + 100 * HOUR - GRACE - 60_000) // before now-grace
  const fresh = new Date(T0.getTime() + 100 * HOUR - 60_000) // within grace

  it('INV-9 flags a confirmed booking with no Google event id past the grace window', () => {
    const s = snapshot({
      googleMode: true,
      unmirrorGraceMs: GRACE,
      bookings: [booking({ id: 'b1', state: 'confirmed', calendarEventId: null, createdAt: old })],
    })
    const f = runIntegrityChecks(s).find((x) => x.kind === 'unmirrored')
    expect(f).toBeDefined()
    expect(f!.severity).toBe('warning')
    expect(f!.dedupKey).toBe('unmirrored:booking:b1')
    expect(f!.detail['entity']).toBe('booking')
  })

  it('INV-9 treats an internal: placeholder event id as unmirrored', () => {
    const s = snapshot({
      googleMode: true,
      unmirrorGraceMs: GRACE,
      bookings: [booking({ id: 'b1', state: 'confirmed', calendarEventId: 'internal:123', createdAt: old })],
    })
    expect(kinds(s)).toContain('unmirrored')
  })

  it('INV-9 does NOT flag a booking with a real Google event id', () => {
    const s = snapshot({
      googleMode: true,
      unmirrorGraceMs: GRACE,
      bookings: [booking({ id: 'b1', state: 'confirmed', calendarEventId: 'ev1', createdAt: old })],
      googleEvents: [{ id: 'ev1', start: T0, end: new Date(T0.getTime() + HOUR) }],
    })
    expect(kinds(s)).not.toContain('unmirrored')
  })

  it('INV-9 does NOT flag a record still inside the grace window', () => {
    const s = snapshot({
      googleMode: true,
      unmirrorGraceMs: GRACE,
      bookings: [booking({ id: 'b1', state: 'confirmed', calendarEventId: null, createdAt: fresh })],
    })
    expect(kinds(s)).not.toContain('unmirrored')
  })

  it('INV-9 does NOT flag held bookings (only confirmed are mirrored)', () => {
    const s = snapshot({
      googleMode: true,
      unmirrorGraceMs: GRACE,
      bookings: [booking({ id: 'b1', state: 'held', calendarEventId: null, createdAt: old })],
    })
    expect(kinds(s)).not.toContain('unmirrored')
  })

  it('INV-9 flags an internal-origin block with no Google event id past grace', () => {
    const s = snapshot({
      googleMode: true,
      unmirrorGraceMs: GRACE,
      blocks: [{ id: 'blk1', start: T0, end: new Date(T0.getTime() + HOUR), createdAt: old, googleEventId: null, source: 'internal' }],
    })
    const f = runIntegrityChecks(s).find((x) => x.kind === 'unmirrored')
    expect(f).toBeDefined()
    expect(f!.dedupKey).toBe('unmirrored:block:blk1')
  })

  it('INV-9 does NOT flag a google_import block (originates in Google)', () => {
    const s = snapshot({
      googleMode: true,
      unmirrorGraceMs: GRACE,
      blocks: [{ id: 'blk1', start: T0, end: new Date(T0.getTime() + HOUR), createdAt: old, googleEventId: null, source: 'google_import' }],
    })
    expect(kinds(s)).not.toContain('unmirrored')
  })

  it('INV-9 is disabled when unmirrorGraceMs is omitted', () => {
    const s = snapshot({
      googleMode: true,
      bookings: [booking({ id: 'b1', state: 'confirmed', calendarEventId: null, createdAt: old })],
    })
    expect(kinds(s)).not.toContain('unmirrored')
  })

  it('INV-9 does NOT fire outside google mode', () => {
    const s = snapshot({
      googleMode: false,
      unmirrorGraceMs: GRACE,
      bookings: [booking({ id: 'b1', state: 'confirmed', calendarEventId: null, createdAt: old })],
    })
    expect(kinds(s)).not.toContain('unmirrored')
  })

  // ── INV-10 stranded_requested ──────────────────────────────────────────────
  // A `requested` row that has aged past the reaper TTL means placeHold (or the
  // requested→held_for_approval flip) crashed and the seat is leaking. Key on
  // createdAt age (NOT holdExpiresAt — requested rows legitimately have null
  // holdExpiresAt mid-flip). The threshold (≥5 min default) is precisely what
  // excludes the sub-second transient requested→held_for_approval/held window.

  it('INV-10 flags a requested row older than requestedReaperMs as stranded_requested (warning, autoRemediable)', () => {
    const now = new Date(T0.getTime() + 100 * HOUR)
    const reaperMs = 5 * 60_000 // 5 min
    // createdAt is 10 min in the past — well past the reaper TTL
    const strandedCreatedAt = new Date(now.getTime() - 10 * 60_000)
    const s = snapshot({
      now,
      requestedReaperMs: reaperMs,
      bookings: [booking({ id: 'b1', state: 'requested', createdAt: strandedCreatedAt })],
    })
    const findings = runIntegrityChecks(s)
    const f = findings.find((x) => x.kind === 'stranded_requested')
    expect(f).toBeDefined()
    expect(f!.severity).toBe('warning')
    expect(f!.autoRemediable).toBe(true)
    expect(f!.bookingId).toBe('b1')
    expect(f!.dedupKey).toBe('stranded_requested:b1')
  })

  it('INV-10 does NOT flag a requested row younger than the TTL (transient approval-flip window)', () => {
    const now = new Date(T0.getTime() + 100 * HOUR)
    const reaperMs = 5 * 60_000
    // createdAt is only 30 seconds in the past — still inside the TTL
    const freshCreatedAt = new Date(now.getTime() - 30_000)
    const s = snapshot({
      now,
      requestedReaperMs: reaperMs,
      bookings: [booking({ id: 'b1', state: 'requested', createdAt: freshCreatedAt })],
    })
    expect(kinds(s)).not.toContain('stranded_requested')
  })

  it('INV-10 does NOT flag confirmed or held rows as stranded_requested', () => {
    const now = new Date(T0.getTime() + 100 * HOUR)
    const reaperMs = 5 * 60_000
    const oldCreatedAt = new Date(now.getTime() - 60 * 60_000) // 1h old
    const s = snapshot({
      now,
      requestedReaperMs: reaperMs,
      bookings: [
        booking({ id: 'b1', state: 'confirmed', createdAt: oldCreatedAt }),
        booking({ id: 'b2', state: 'held', createdAt: oldCreatedAt }),
      ],
    })
    expect(kinds(s)).not.toContain('stranded_requested')
  })

  it('INV-10 is disabled when requestedReaperMs is omitted', () => {
    const now = new Date(T0.getTime() + 100 * HOUR)
    const oldCreatedAt = new Date(now.getTime() - 60 * 60_000)
    const s = snapshot({
      now,
      bookings: [booking({ id: 'b1', state: 'requested', createdAt: oldCreatedAt })],
    })
    expect(kinds(s)).not.toContain('stranded_requested')
  })
})
