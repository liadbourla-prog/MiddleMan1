// Integrity Sentinel — pure invariant engine (WS-B).
//
// The independent auditor that proves no calendar mistake exists. It is deliberately a
// PURE function over a snapshot: the worker loads internal records + Google events and
// calls runIntegrityChecks(); persistence, alerting, quarantine, and auto-remediation
// live in the worker. Keeping the logic pure makes every invariant unit-testable in
// isolation — which, for the thing whose entire job is correctness, is the point.
//
// Each invariant maps to a failure mode in CALENDAR_BULLETPROOFING_PLAN.md §2.
// Note: INV-4 (out-of-hours / break) is computed in the worker via the availability
// service (it needs the DB-backed hours compute) and is not part of this pure engine.

export type IntegrityKind =
  | 'double_book' // INV-1 / F1
  | 'ghost' // INV-2 / F3
  | 'orphan' // INV-3 / F2,F4
  | 'time_mismatch' // INV-5 / F5
  | 'reminder_orphan' // INV-6 / F7
  | 'stuck_hold' // INV-7 / F8
  | 'reschedule_residue' // INV-8 / F9
  | 'out_of_hours' // INV-4 / F6 — emitted by the worker (needs DB-backed hours), not this pure engine

export type Severity = 'critical' | 'warning'

const ACTIVE_BOOKING_STATES = new Set(['held', 'pending_payment', 'confirmed'])

export interface BookingSnapshot {
  id: string
  serviceTypeId: string
  slotStart: Date
  slotEnd: Date
  state: string
  calendarEventId: string | null
  rescheduledFrom: string | null
  holdExpiresAt: Date | null
  /** True when the service is a group class (legitimate to share a slot). */
  isGroup: boolean
}

export interface GoogleEventSnapshot {
  id: string
  start: Date
  end: Date
}

export interface ReminderSnapshot {
  id: string
  bookingId: string
  /** Pending reminders only matter — a sent reminder is history. */
  sentAt: Date | null
}

export interface IntegritySnapshot {
  now: Date
  /** Set when the business mirrors to Google — enables ghost/orphan/time invariants. */
  googleMode: boolean
  bookings: BookingSnapshot[]
  googleEvents: GoogleEventSnapshot[]
  /** googleEventIds of internal calendar_blocks — "known" Google events, not orphans. */
  knownBlockEventIds: string[]
  reminders: ReminderSnapshot[]
  /** Holds are only "stuck" once expired by at least this many ms (matches hold-expiry grace). */
  holdGraceMs: number
}

export interface IntegrityFinding {
  kind: IntegrityKind
  severity: Severity
  /** Stable across runs for the same underlying problem, so the worker can dedup. */
  dedupKey: string
  bookingId?: string
  slotStart?: Date
  detail: Record<string, unknown>
  /** The worker may safely fix these without a human (expire hold, cancel reminder). */
  autoRemediable: boolean
  /** Present for live collisions: the worker blocks new bookings into this exact slot. */
  quarantineSlot?: { start: Date; end: Date }
}

/** Two [start,end) intervals overlap. */
function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd
}

/**
 * Run all relational invariants over the snapshot and return every violation found.
 * Order is stable (by invariant, then by booking) so test assertions are deterministic.
 */
export function runIntegrityChecks(snap: IntegritySnapshot): IntegrityFinding[] {
  const findings: IntegrityFinding[] = []
  const active = snap.bookings.filter((b) => ACTIVE_BOOKING_STATES.has(b.state))

  // ── INV-1 double_book (F1) ──────────────────────────────────────────────────
  // Any two active bookings that overlap, UNLESS they are the same group-class
  // instance (same service + identical slot) — those legitimately share the slot.
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]!
      const b = active[j]!
      if (!overlaps(a.slotStart, a.slotEnd, b.slotStart, b.slotEnd)) continue
      const sameClassInstance =
        a.isGroup && b.isGroup &&
        a.serviceTypeId === b.serviceTypeId &&
        a.slotStart.getTime() === b.slotStart.getTime()
      if (sameClassInstance) continue
      const pair = [a.id, b.id].sort()
      findings.push({
        kind: 'double_book',
        severity: 'critical',
        dedupKey: `double_book:${pair[0]}:${pair[1]}`,
        slotStart: a.slotStart,
        detail: { bookingA: pair[0], bookingB: pair[1] },
        autoRemediable: false,
        quarantineSlot: {
          start: new Date(Math.min(a.slotStart.getTime(), b.slotStart.getTime())),
          end: new Date(Math.max(a.slotEnd.getTime(), b.slotEnd.getTime())),
        },
      })
    }
  }

  // ── Google-dependent invariants (only meaningful in mirror mode) ─────────────
  if (snap.googleMode) {
    const eventsById = new Map(snap.googleEvents.map((e) => [e.id, e]))
    const knownEventIds = new Set<string>([
      ...snap.bookings.map((b) => b.calendarEventId).filter((x): x is string => !!x),
      ...snap.knownBlockEventIds,
    ])

    // ── INV-2 ghost (F3) + INV-5 time_mismatch (F5) ──────────────────────────
    for (const b of active) {
      if (b.state !== 'confirmed' || !b.calendarEventId) continue
      const ev = eventsById.get(b.calendarEventId)
      if (!ev) {
        findings.push({
          kind: 'ghost',
          severity: 'critical',
          dedupKey: `ghost:${b.id}`,
          bookingId: b.id,
          slotStart: b.slotStart,
          detail: { calendarEventId: b.calendarEventId },
          autoRemediable: false,
        })
        continue
      }
      if (ev.start.getTime() !== b.slotStart.getTime() || ev.end.getTime() !== b.slotEnd.getTime()) {
        findings.push({
          kind: 'time_mismatch',
          severity: 'critical',
          dedupKey: `time_mismatch:${b.id}`,
          bookingId: b.id,
          slotStart: b.slotStart,
          detail: {
            internalStart: b.slotStart.toISOString(),
            internalEnd: b.slotEnd.toISOString(),
            googleStart: ev.start.toISOString(),
            googleEnd: ev.end.toISOString(),
          },
          autoRemediable: false,
        })
      }
    }

    // ── INV-3 orphan (F2,F4) ─────────────────────────────────────────────────
    // A Google event linked to no PA booking and no known block. If it overlaps an
    // active booking it is a live collision (critical, quarantine); otherwise it is a
    // sync gap worth flagging (warning) — inbound sync should have imported it.
    for (const ev of snap.googleEvents) {
      if (knownEventIds.has(ev.id)) continue
      const collides = active.find((b) => overlaps(ev.start, ev.end, b.slotStart, b.slotEnd))
      if (collides) {
        findings.push({
          kind: 'orphan',
          severity: 'critical',
          dedupKey: `orphan:${ev.id}`,
          slotStart: ev.start,
          detail: { googleEventId: ev.id, collidesWithBooking: collides.id },
          autoRemediable: false,
          quarantineSlot: { start: ev.start, end: ev.end },
        })
      } else {
        findings.push({
          kind: 'orphan',
          severity: 'warning',
          dedupKey: `orphan:${ev.id}`,
          slotStart: ev.start,
          detail: { googleEventId: ev.id, collidesWithBooking: null },
          autoRemediable: false,
        })
      }
    }
  }

  // ── INV-6 reminder_orphan (F7) ──────────────────────────────────────────────
  // A pending reminder whose booking is no longer active → it would fire for a
  // cancelled/expired slot. Safe to auto-cancel.
  const bookingState = new Map(snap.bookings.map((b) => [b.id, b.state]))
  for (const r of snap.reminders) {
    if (r.sentAt) continue
    const st = bookingState.get(r.bookingId)
    if (st === undefined || !ACTIVE_BOOKING_STATES.has(st)) {
      findings.push({
        kind: 'reminder_orphan',
        severity: 'warning',
        dedupKey: `reminder_orphan:${r.id}`,
        detail: { reminderId: r.id, bookingId: r.bookingId, bookingState: st ?? 'missing' },
        autoRemediable: true,
      })
    }
  }

  // ── INV-7 stuck_hold (F8) ───────────────────────────────────────────────────
  const stuckCutoff = new Date(snap.now.getTime() - snap.holdGraceMs)
  for (const b of snap.bookings) {
    if (b.state !== 'held' && b.state !== 'pending_payment') continue
    if (b.holdExpiresAt && b.holdExpiresAt < stuckCutoff) {
      findings.push({
        kind: 'stuck_hold',
        severity: 'warning',
        dedupKey: `stuck_hold:${b.id}`,
        bookingId: b.id,
        slotStart: b.slotStart,
        detail: { holdExpiresAt: b.holdExpiresAt.toISOString(), state: b.state },
        autoRemediable: true,
      })
    }
  }

  // ── INV-8 reschedule_residue (F9) ───────────────────────────────────────────
  // A reschedule that left BOTH the new and the superseded booking active.
  const activeIds = new Set(active.map((b) => b.id))
  for (const b of active) {
    if (b.rescheduledFrom && activeIds.has(b.rescheduledFrom)) {
      findings.push({
        kind: 'reschedule_residue',
        severity: 'critical',
        dedupKey: `reschedule_residue:${b.rescheduledFrom}:${b.id}`,
        bookingId: b.id,
        slotStart: b.slotStart,
        detail: { newBooking: b.id, supersededStillActive: b.rescheduledFrom },
        autoRemediable: false,
      })
    }
  }

  return findings
}
