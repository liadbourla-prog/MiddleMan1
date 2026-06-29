// ============================================================================
// WS1 merge-gate concurrency harness — P1 atomicity cases (C1–C7).
//
// These run against a REAL ephemeral Postgres booted by run-concurrency-harness.sh, with
// DATABASE_URL already in the process env. Each case seeds fresh state, runs its race
// ~30× via raceN (each racer on its OWN postgres backend so advisory locks / CAS genuinely
// contend at the DB layer), and asserts the atomicity invariant EVERY round.
//
// EXPECTED RESULT MAP:
//   C1 GREEN  C2 GREEN (closed by T1.1b)  C3 GREEN  C4 GREEN  C5 GREEN  C6 GREEN  C7 GREEN
//
// C2 was the proven partial-overlap private double-book; it is now CLOSED for real by the
// T1.1b GiST EXCLUDE constraint (migration 0049). Any of C1–C7 going RED is a REAL atomicity
// bug surfaced by a real DB, not a harness defect.
// ============================================================================

import { vi } from 'vitest'

// ── Mocks (must precede any import of the mocked modules) ────────────────────
// Mirror the existing integration tests: stub redis, all worker side-channels, calendar
// mirror, and external sends so no network / BullMQ is touched. The engine + workers
// operate purely on the DB under test.
vi.mock('../../src/redis.js', () => ({
  redis: {
    exists: vi.fn().mockResolvedValue(0),
    set: vi.fn().mockResolvedValue(null),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(0),
    eval: vi.fn().mockResolvedValue(0),
  },
  redisConnection: { quit: vi.fn(), on: vi.fn(), disconnect: vi.fn() },
}))
vi.mock('../../src/workers/message-retry.js', () => ({
  enqueueMessage: vi.fn().mockResolvedValue(undefined),
  messageRetryQueue: { add: vi.fn() },
  startMessageRetryWorker: vi.fn(),
}))
vi.mock('../../src/workers/reminder.js', () => ({
  scheduleReminders: vi.fn().mockResolvedValue(undefined),
  cancelReminders: vi.fn().mockResolvedValue(undefined),
  startReminderWorker: vi.fn(),
}))
vi.mock('../../src/workers/calendar-mirror.js', () => ({
  enqueueBlockMirror: vi.fn().mockResolvedValue(undefined),
  enqueueBlockDeletion: vi.fn().mockResolvedValue(undefined),
  enqueueBookingMirror: vi.fn().mockResolvedValue(undefined),
  enqueueBookingDeletion: vi.fn().mockResolvedValue(undefined),
  startCalendarMirrorWorker: vi.fn(),
}))
vi.mock('../../src/workers/queued-messages.js', () => ({
  queueMessageForLater: vi.fn().mockResolvedValue(undefined),
  startQueuedMessageWorker: vi.fn(),
}))
vi.mock('../../src/domain/initiations/booking-notify.js', () => ({
  notifyOwnerNewBooking: vi.fn().mockResolvedValue(undefined),
  notifyOwnerApprovalExpired: vi.fn().mockResolvedValue(undefined),
  notifyBusinessBookingChange: vi.fn().mockResolvedValue(undefined),
  notifyOwnerBookingChange: vi.fn().mockResolvedValue(undefined),
  notifyOwnerApprovalRequest: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/adapters/llm/client.js', () => ({
  generateProactiveCustomerMessage: vi.fn(async (i: { fallback: string }) => i.fallback),
}))

// Capture send calls for waitlist (C5). canSendFreeForm false → template path (no LLM).
const sendMessage = vi.fn().mockResolvedValue({ ok: true })
const sendTemplateMessage = vi.fn().mockResolvedValue({ ok: true })
const canSendFreeForm = vi.fn().mockResolvedValue(false)
vi.mock('../../src/adapters/whatsapp/sender.js', () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...a),
  sendTemplateMessage: (...a: unknown[]) => sendTemplateMessage(...a),
  canSendFreeForm: (...a: unknown[]) => canSendFreeForm(...a),
}))
// Stub the waitlist expiry-job enqueue so offer_slot doesn't need a live BullMQ queue.
vi.mock('../../src/workers/waitlist.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/workers/waitlist.js')>()
  return {
    ...actual,
    waitlistQueue: { add: vi.fn().mockResolvedValue(undefined) },
    // triggerWaitlistForSlot is fired from cancel side-effects (C4) — stub so we can count.
    triggerWaitlistForSlot: vi.fn().mockResolvedValue(undefined),
  }
})

import { describe, it, expect, beforeAll } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../../src/db/client.js'
import {
  bookings, serviceTypes, auditLog, identities, waitlist, initiationLog,
} from '../../src/db/schema.js'
import { requestBooking, cancelBooking, confirmBooking } from '../../src/domain/booking/engine.js'
import { expireHeldBookings } from '../../src/workers/hold-expiry.js'
import { dispatchInitiation } from '../../src/domain/initiations/dispatch.js'
import { INITIATORS } from '../../src/domain/initiations/registry.js'
import { createCalendarClient } from '../../src/adapters/calendar/client.js'
import type { ResolvedIdentity } from '../../src/domain/identity/types.js'
import type { Db } from '../../src/db/client.js'
import {
  seedBusiness, seedCustomer, teardown, freshPhone,
} from '../integration/setup.js'
import type { TestBusiness } from '../integration/setup.js'
import { raceN, raceNSettled, countOk, repeat } from './race.js'

// Number of flakiness rounds per case. A race that passes once may still be flaky; we
// re-seed and re-race this many times and assert the invariant every round.
const ROUNDS = 30

function calendar(businessId: string) {
  return createCalendarClient({
    calendarMode: 'internal', googleCalendarId: null, businessId, waNumber: 'stub', timezone: 'UTC',
  })
}

function customerActor(customerId: string, businessId: string): ResolvedIdentity {
  return { id: customerId, businessId, phoneNumber: freshPhone(), role: 'customer', displayName: null, delegatedPermissions: null }
}
function managerActor(managerId: string, businessId: string, phone: string): ResolvedIdentity {
  return { id: managerId, businessId, phoneNumber: phone, role: 'manager', displayName: null, delegatedPermissions: null }
}

// A private slot 7 days out at 14:00 UTC (inside window + buffer).
function privateSlot(startHour = 14, durationMin = 60): { slotStart: Date; slotEnd: Date } {
  const slotStart = new Date()
  slotStart.setUTCDate(slotStart.getUTCDate() + 7)
  slotStart.setUTCHours(startHour, 0, 0, 0)
  const slotEnd = new Date(slotStart.getTime() + durationMin * 60_000)
  return { slotStart, slotEnd }
}
function offsetSlot(startHour: number, startMin: number, durationMin: number): { slotStart: Date; slotEnd: Date } {
  const slotStart = new Date()
  slotStart.setUTCDate(slotStart.getUTCDate() + 7)
  slotStart.setUTCHours(startHour, startMin, 0, 0)
  const slotEnd = new Date(slotStart.getTime() + durationMin * 60_000)
  return { slotStart, slotEnd }
}

// Insert a confirmed booking directly on a given slot (helper for cancel/confirm cases).
async function insertBooking(
  d: Db,
  businessId: string, customerId: string, serviceId: string,
  slotStart: Date, slotEnd: Date,
  state: 'confirmed' | 'held' | 'pending_payment',
  extra: { holdExpiresAt?: Date | null; calendarEventId?: string | null; isExclusive?: boolean } = {},
): Promise<string> {
  const [row] = await d.insert(bookings).values({
    businessId, serviceTypeId: serviceId, customerId,
    requestedAt: new Date(), slotStart, slotEnd, state, slotTzAtCreation: 'UTC',
    holdExpiresAt: extra.holdExpiresAt ?? null,
    calendarEventId: extra.calendarEventId ?? null,
    // T1.1b: class prefill rows are non-exclusive (many co-bookings share a slot); private
    // rows default to exclusive. The column default is true, so class callers MUST pass false
    // or the overlap-exclusion constraint rejects the second prefill row.
    isExclusive: extra.isExclusive ?? true,
  }).returning({ id: bookings.id })
  if (!row) throw new Error('insertBooking failed')
  return row.id
}

// Wipe all bookings/audit/waitlist/initiation rows for a business between rounds (cheaper
// than full teardown + re-seed; keeps the business/service/identity rows stable).
async function resetRows(businessId: string): Promise<void> {
  await db.execute(sql`DELETE FROM audit_log WHERE business_id = ${businessId}`)
  await db.execute(sql`DELETE FROM initiation_log WHERE business_id = ${businessId}`)
  await db.execute(sql`DELETE FROM waitlist WHERE business_id = ${businessId}`)
  await db.execute(sql`DELETE FROM bookings WHERE business_id = ${businessId}`)
}

// ─────────────────────────────────────────────────────────────────────────────
describe('WS1 P1-atomicity merge-gate (real ephemeral Postgres)', () => {
  // ───────────────────────────── C1 (A1, GREEN) ─────────────────────────────
  // Two concurrent requestBooking for the SAME free private slot → exactly 1 winner.
  describe('C1 — same-slot private double-book (advisory lock, expect GREEN)', () => {
    let biz: TestBusiness
    beforeAll(async () => { biz = await seedBusiness({ available247: true, calendarMode: 'internal' }) })

    it('exactly one of two concurrent same-slot requests wins, across 30 rounds', async () => {
      await repeat(ROUNDS, async () => {
        const c1 = await seedCustomer(biz.businessId, freshPhone())
        const c2 = await seedCustomer(biz.businessId, freshPhone())
        const { slotStart, slotEnd } = privateSlot()
        const actors = [customerActor(c1, biz.businessId), customerActor(c2, biz.businessId)]

        const results = await raceN(
          (d) => requestBooking(d, calendar(biz.businessId), actors.shift()!, { serviceTypeId: biz.serviceId, slotStart, slotEnd }),
          2,
        )
        const winners = countOk(results, (r) => r.ok)
        expect(winners).toBe(1)
        await resetRows(biz.businessId)
      })
      await teardown(biz.businessId)
    })
  })

  // ───────────────────────────── C2 (A1, GREEN — closed by T1.1b) ────────────
  // T1.1a's advisory lock is keyed on slotStart.toISOString(), so two OVERLAPPING-but-
  // different-start private slots (14:00–15:00 vs 14:30–15:30) take DIFFERENT locks and both
  // pass the advisory gate. The DB-level `bookings_exclusive_no_overlap` GiST EXCLUDE
  // constraint (T1.1b, migration 0049) is the backstop: both racers insert a `requested` row
  // (NOT in the constraint's state set), but the loser's requested→held transition raises a
  // 23P01 exclusion_violation, which the engine maps to a clean ok:false (markFailed). Exactly
  // ONE winner — the correct invariant for a mutually-exclusive overlap on one business.
  describe('C2 — partial-overlap private double-book (GREEN; closed by T1.1b)', () => {
    let biz: TestBusiness
    beforeAll(async () => { biz = await seedBusiness({ available247: true, calendarMode: 'internal' }) })

    it('overlapping different-start slots yield exactly one winner (closed by T1.1b)', async () => {
      let observedTwoWinnersAtLeastOnce = false
      await repeat(ROUNDS, async () => {
        const c1 = await seedCustomer(biz.businessId, freshPhone())
        const c2 = await seedCustomer(biz.businessId, freshPhone())
        const slotA = offsetSlot(14, 0, 60)   // 14:00–15:00
        const slotB = offsetSlot(14, 30, 60)  // 14:30–15:30 (overlaps A, different start)
        const reqs = [
          { actor: customerActor(c1, biz.businessId), slot: slotA },
          { actor: customerActor(c2, biz.businessId), slot: slotB },
        ]
        const results = await raceN(
          (d) => {
            const r = reqs.shift()!
            return requestBooking(d, calendar(biz.businessId), r.actor, { serviceTypeId: biz.serviceId, slotStart: r.slot.slotStart, slotEnd: r.slot.slotEnd })
          },
          2,
        )
        const winners = countOk(results, (r) => r.ok)
        if (winners === 2) observedTwoWinnersAtLeastOnce = true
        // The CORRECT invariant for an exclusive overlap — now enforced by T1.1b.
        expect(winners).toBe(1)
        await resetRows(biz.businessId)
      })
      // T1.1b closes the double-book: a second winner must NEVER be observed.
      expect(observedTwoWinnersAtLeastOnce).toBe(false)
      await teardown(biz.businessId)
    })
  })

  // ───────────────────────────── C3 (A2/A5, GREEN) ──────────────────────────
  // (a) Concurrent bookings into a class at capacity-minus-one → exactly 1 succeeds.
  // (b) A pending_payment booking for a customer blocks that same customer's second booking.
  describe('C3 — class last-seat race + pending_payment dup guard (expect GREEN)', () => {
    let biz: TestBusiness
    let classServiceId: string
    beforeAll(async () => {
      biz = await seedBusiness({ available247: true, calendarMode: 'internal' })
      const [svc] = await db.insert(serviceTypes).values({
        businessId: biz.businessId, name: 'Pilates 8-cap', durationMinutes: 60, maxParticipants: 8, isActive: true,
      }).returning({ id: serviceTypes.id })
      classServiceId = svc!.id
    })

    it('last-seat: exactly one of two concurrent bookings wins, across 30 rounds', async () => {
      await repeat(ROUNDS, async () => {
        const { slotStart, slotEnd } = privateSlot()
        // Pre-fill 7 of 8 seats so exactly one remains. Class rows are non-exclusive.
        for (let i = 0; i < 7; i++) {
          const cid = await seedCustomer(biz.businessId, freshPhone())
          await insertBooking(db, biz.businessId, cid, classServiceId, slotStart, slotEnd, 'confirmed', { isExclusive: false })
        }
        const a1 = customerActor(await seedCustomer(biz.businessId, freshPhone()), biz.businessId)
        const a2 = customerActor(await seedCustomer(biz.businessId, freshPhone()), biz.businessId)
        const actors = [a1, a2]
        const results = await raceN(
          (d) => requestBooking(d, calendar(biz.businessId), actors.shift()!, { serviceTypeId: classServiceId, slotStart, slotEnd }),
          2,
        )
        expect(countOk(results, (r) => r.ok)).toBe(1)
        await resetRows(biz.businessId)
      })
    })

    // G1 trap (§v2-B): the T1.1b EXCLUDE constraint MUST NOT reject legitimate class
    // co-bookings. Class rows are is_exclusive=false, so multiple DIFFERENT customers booking
    // the SAME class slot concurrently must ALL succeed (up to capacity). If the constraint
    // were mis-scoped (applied to all bookings), this would collapse to one winner → outage.
    it('G1: concurrent class co-bookings at the same slot all succeed (constraint not mis-scoped)', async () => {
      await repeat(ROUNDS, async () => {
        // Distinct hour from the last-seat case so the two never share a slot across rounds.
        const { slotStart, slotEnd } = offsetSlot(16, 0, 60)
        // Three distinct customers race into the same empty 8-cap class slot.
        const actors = [
          customerActor(await seedCustomer(biz.businessId, freshPhone()), biz.businessId),
          customerActor(await seedCustomer(biz.businessId, freshPhone()), biz.businessId),
          customerActor(await seedCustomer(biz.businessId, freshPhone()), biz.businessId),
        ]
        const results = await raceN(
          (d) => requestBooking(d, calendar(biz.businessId), actors.shift()!, { serviceTypeId: classServiceId, slotStart, slotEnd }),
          3,
        )
        // All three are legitimate class co-bookings — none rejected by the overlap constraint.
        expect(countOk(results, (r) => r.ok)).toBe(3)
        // And exactly three active rows occupy the slot (no overlap rejection silently dropped one).
        const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(bookings)
          .where(and(eq(bookings.serviceTypeId, classServiceId), eq(bookings.slotStart, slotStart),
            sql`${bookings.state} in ('requested','held','pending_payment','confirmed')`))
        expect(Number(total)).toBe(3)
        await resetRows(biz.businessId)
      })
    })

    it('pending_payment dup guard: same customer cannot slip a second booking', async () => {
      const { slotStart, slotEnd } = privateSlot()
      const cid = await seedCustomer(biz.businessId, freshPhone())
      await insertBooking(db, biz.businessId, cid, classServiceId, slotStart, slotEnd, 'pending_payment', { isExclusive: false })
      const result = await requestBooking(db, calendar(biz.businessId), customerActor(cid, biz.businessId), { serviceTypeId: classServiceId, slotStart, slotEnd })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toMatch(/already booked/i)
      await resetRows(biz.businessId)
      await teardown(biz.businessId)
    })
  })

  // ───────────────────────────── C4 (CX3, GREEN) ────────────────────────────
  // Two concurrent cancelBooking on one confirmed booking → both ok, side effects once:
  // exactly ONE 'booking.cancelled' audit row.
  describe('C4 — concurrent cancel: side effects fire exactly once (expect GREEN)', () => {
    let biz: TestBusiness
    let managerId: string
    beforeAll(async () => {
      biz = await seedBusiness({ available247: true, calendarMode: 'internal' })
      const [mgr] = await db.select({ id: identities.id }).from(identities)
        .where(and(eq(identities.businessId, biz.businessId), eq(identities.role, 'manager'))).limit(1)
      managerId = mgr!.id
    })

    it('exactly one booking.cancelled audit row per race, across 30 rounds', async () => {
      await repeat(ROUNDS, async () => {
        const cid = await seedCustomer(biz.businessId, freshPhone())
        const { slotStart, slotEnd } = privateSlot()
        const bookingId = await insertBooking(db, biz.businessId, cid, biz.serviceId, slotStart, slotEnd, 'confirmed')
        const actor = managerActor(managerId, biz.businessId, biz.managerPhone)

        const results = await raceN(
          (d) => cancelBooking(d, calendar(biz.businessId), actor, bookingId, 'race-cancel'),
          2,
        )
        // Both honest idempotent ok.
        expect(countOk(results, (r) => r.ok)).toBe(2)

        const auditRows = await db.select().from(auditLog)
          .where(and(eq(auditLog.entityId, bookingId), eq(auditLog.action, 'booking.cancelled')))
        expect(auditRows).toHaveLength(1)
        await resetRows(biz.businessId)
      })
      await teardown(biz.businessId)
    })
  })

  // ───────────────────────────── C5 (E1, GREEN) ─────────────────────────────
  // Two concurrent waitlist offer_slot jobs for one pending entry → exactly one offer sent,
  // exactly one row flips to 'offered'. processJob uses the db SINGLETON internally, so the
  // contention here is at the CAS predicate on the shared connection — still a true CAS race.
  describe('C5 — waitlist double-offer (CAS promotion, expect GREEN)', () => {
    let biz: TestBusiness
    let processWaitlistJob: (job: { data: { type: 'offer_slot' | 'expire_offer'; businessId: string; serviceTypeId: string; slotStart: string; slotEnd: string; waitlistId?: string } }) => Promise<void>
    beforeAll(async () => {
      biz = await seedBusiness({ calendarMode: 'internal', language: 'en' })
      const mod = await import('../../src/workers/waitlist.js')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      processWaitlistJob = (mod as any).processJob
    })

    it('two concurrent offer_slot jobs send exactly one offer, across 30 rounds', async () => {
      await repeat(ROUNDS, async () => {
        sendMessage.mockClear(); sendTemplateMessage.mockClear(); canSendFreeForm.mockResolvedValue(false)
        const cid = await seedCustomer(biz.businessId, freshPhone())
        const { slotStart, slotEnd } = privateSlot()
        const [entry] = await db.insert(waitlist).values({
          businessId: biz.businessId, serviceTypeId: biz.serviceId, customerId: cid,
          slotStart, slotEnd, status: 'pending',
        }).returning({ id: waitlist.id })
        const waitlistId = entry!.id

        const jobData = {
          type: 'offer_slot' as const, businessId: biz.businessId, serviceTypeId: biz.serviceId,
          slotStart: slotStart.toISOString(), slotEnd: slotEnd.toISOString(),
        }
        await Promise.all([
          processWaitlistJob({ data: jobData }),
          processWaitlistJob({ data: jobData }),
        ])

        const totalSends = sendMessage.mock.calls.length + sendTemplateMessage.mock.calls.length
        expect(totalSends).toBe(1)
        const rows = await db.select({ status: waitlist.status }).from(waitlist).where(eq(waitlist.id, waitlistId))
        expect(rows[0]!.status).toBe('offered')
        await resetRows(biz.businessId)
      })
      await teardown(biz.businessId)
    })
  })

  // ───────────────────────────── C6 (A4/E4, GREEN) ──────────────────────────
  // A held booking; race confirmBooking against expireHeldBookings() (the sweep). The
  // atomicity contract (T1.5/T1.7, E4/P1) is dual-CAS on `state='held'`: exactly ONE of
  // {confirm, sweep} flips the row, so the booking ends in EXACTLY ONE terminal state with
  // NO torn state — never confirmed-but-also-expired, never an expired side effect on a row
  // the confirm won (and vice-versa).
  //
  // Two sub-cases match the engine's actual design:
  //   (a) NON-EXPIRED hold (holdExpiresAt in the future): confirm passes its up-front time
  //       guard AND the sweep's `holdExpiresAt < cutoff` predicate EXCLUDES the row, so the
  //       sweep can never expire a live hold. Confirm MUST win → ends 'confirmed', the sweep
  //       writes NO 'booking.expired' audit row. This is the primary E4 guarantee: a slot
  //       being actively confirmed is never swept out from under the customer.
  //   (b) EXPIRED hold (holdExpiresAt in the past): confirm's up-front guard correctly
  //       rejects (ok:false) and the sweep legitimately expires the dead hold. The invariant
  //       is still "exactly one terminal state, side effects once" — the sweep is the sole
  //       winner, confirm fires nothing. (A confirm winning here would be the BUG.)
  describe('C6 — confirm vs hold-expiry sweep: no torn state (expect GREEN)', () => {
    let biz: TestBusiness
    let managerId: string
    beforeAll(async () => {
      biz = await seedBusiness({ available247: true, calendarMode: 'internal' })
      const [mgr] = await db.select({ id: identities.id }).from(identities)
        .where(and(eq(identities.businessId, biz.businessId), eq(identities.role, 'manager'))).limit(1)
      managerId = mgr!.id
    })

    it('(a) live hold + concurrent sweep: confirm wins, never expired, across 30 rounds', async () => {
      await repeat(ROUNDS, async () => {
        const cid = await seedCustomer(biz.businessId, freshPhone())
        const { slotStart, slotEnd } = privateSlot()
        // holdExpiresAt in the FUTURE: confirm passes its time guard; the sweep predicate
        // (holdExpiresAt < now-grace) excludes this row — the live hold is sweep-ineligible.
        const bookingId = await insertBooking(
          db, biz.businessId, cid, biz.serviceId, slotStart, slotEnd, 'held',
          { holdExpiresAt: new Date(Date.now() + 15 * 60_000), calendarEventId: 'internal:test-event' },
        )
        const actor = managerActor(managerId, biz.businessId, biz.managerPhone)

        // Race confirm (own connection) against the sweep (db singleton) concurrently.
        const [confirmRes] = await Promise.all([
          raceN((d) => confirmBooking(d, calendar(biz.businessId), actor, bookingId, 'Test Customer'), 1),
          expireHeldBookings(),
        ])

        const [row] = await db.select({ state: bookings.state }).from(bookings).where(eq(bookings.id, bookingId)).limit(1)
        // A live hold is never expired by the sweep; confirm wins the CAS.
        expect(row?.state).toBe('confirmed')
        expect(confirmRes[0]?.ok).toBe(true)
        // No 'booking.expired' audit row — the sweep did not touch this row.
        const expiredAudit = await db.select().from(auditLog)
          .where(and(eq(auditLog.entityId, bookingId), eq(auditLog.action, 'booking.expired')))
        expect(expiredAudit).toHaveLength(0)
        await resetRows(biz.businessId)
      })
    })

    it('(b) dead hold + concurrent confirm: exactly one terminal state, no torn state, across 30 rounds', async () => {
      await repeat(ROUNDS, async () => {
        const cid = await seedCustomer(biz.businessId, freshPhone())
        const { slotStart, slotEnd } = privateSlot()
        // holdExpiresAt 5 min in the PAST (past the 60s grace): the hold is dead. confirm's
        // up-front time guard must reject it; the sweep legitimately expires it.
        const bookingId = await insertBooking(
          db, biz.businessId, cid, biz.serviceId, slotStart, slotEnd, 'held',
          { holdExpiresAt: new Date(Date.now() - 5 * 60_000), calendarEventId: 'internal:test-event' },
        )
        const actor = managerActor(managerId, biz.businessId, biz.managerPhone)

        const [confirmRes] = await Promise.all([
          raceN((d) => confirmBooking(d, calendar(biz.businessId), actor, bookingId, 'Test Customer'), 1),
          expireHeldBookings(),
        ])

        const [row] = await db.select({ state: bookings.state }).from(bookings).where(eq(bookings.id, bookingId)).limit(1)
        const expiredAudit = await db.select().from(auditLog)
          .where(and(eq(auditLog.entityId, bookingId), eq(auditLog.action, 'booking.expired')))

        // INVARIANT: exactly ONE terminal state, no torn state.
        //  - confirm CANNOT win a dead hold (up-front guard) → it returns ok:false.
        //  - the sweep is the sole winner → state 'expired', exactly one expired audit row.
        expect(confirmRes[0]?.ok).toBe(false)
        expect(row?.state).toBe('expired')
        expect(expiredAudit).toHaveLength(1)
        await resetRows(biz.businessId)
      })
      await teardown(biz.businessId)
    })
  })

  // ───────────────────────────── C7 (E2/B2, GREEN) ──────────────────────────
  // Durable-initiation fault injection: dispatchInitiation writes the dedup ledger row, then
  // the executor throws (simulating a transient send/enqueue failure). The implemented
  // compensation (dispatch.ts T1.10) deletes the just-inserted ledger row so the dedup key is
  // NOT burned without delivery — a re-drive can re-insert and send. Assert: the throw
  // propagates AND the ledger row is gone (re-runnable).
  describe('C7 — durable-initiation compensation on executor throw (expect GREEN)', () => {
    let biz: TestBusiness
    let recipientId: string
    beforeAll(async () => {
      biz = await seedBusiness({ available247: true, calendarMode: 'internal' })
      recipientId = await seedCustomer(biz.businessId, freshPhone())
    })

    it('executor throw compensates the ledger row so a re-drive can still send, across 30 rounds', async () => {
      // escalation.owner_rule: owner audience, transactional, windowPolicy 'skip' → the gate
      // decides send_free_form without needing window/recipient gating, so we reach the executor.
      const initiator = INITIATORS['escalation.owner_rule']
      await repeat(ROUNDS, async (round) => {
        const dedupKey = `c7-test:${round}:${Date.now()}`

        // Round 1: executor throws → expect compensation (ledger row deleted).
        await expect(
          dispatchInitiation(
            db, initiator,
            { businessId: biz.businessId, recipientId, dedupKey },
            { sendFreeForm: async () => { throw new Error('transient send failure (injected)') } },
          ),
        ).rejects.toThrow(/transient send failure/)

        // The dedup key must NOT be burned — no surviving ledger row.
        const afterThrow = await db.select({ id: initiationLog.id }).from(initiationLog)
          .where(and(eq(initiationLog.businessId, biz.businessId), eq(initiationLog.dedupKey, dedupKey)))
        expect(afterThrow).toHaveLength(0)

        // Re-drive with a working executor: the same dedup key must now insert AND send.
        let sent = 0
        const decision = await dispatchInitiation(
          db, initiator,
          { businessId: biz.businessId, recipientId, dedupKey },
          { sendFreeForm: async () => { sent += 1 } },
        )
        expect(sent).toBe(1)
        expect(decision.kind === 'send_free_form' || decision.kind === 'send_template').toBe(true)

        const afterRedrive = await db.select({ id: initiationLog.id }).from(initiationLog)
          .where(and(eq(initiationLog.businessId, biz.businessId), eq(initiationLog.dedupKey, dedupKey)))
        expect(afterRedrive).toHaveLength(1)

        await resetRows(biz.businessId)
      })
      await teardown(biz.businessId)
    })
  })
})
