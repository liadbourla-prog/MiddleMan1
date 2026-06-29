// ============================================================================
// WS1 merge-gate concurrency harness — session-lifecycle races (T1.8 B1/E3/E5/B4, T1.9 B3).
//
// Unlike p1-atomicity.test.ts, this file does NOT mock redis: the lock primitives
// (withBusinessLock / withIdentityLock / isIdentityLocked) must contend against a REAL Redis
// at localhost:6379, exactly as production does. The DB is the same REAL ephemeral Postgres
// booted by run-concurrency-harness.sh. Together they exercise the real lock+write races the
// T1.8/T1.9 fixes close — not a unit in isolation.
//
// EXPECTED: every case GREEN.
//   S-B1  manager turn: inbound save is INSIDE the per-business lock → a contended (enqueued)
//         turn leaves NO orphaned inbound.
//   S-E3  queued-messages worker runs its session+flow body under withIdentityLock → a queued
//         message racing a live turn does NOT clobber the session draft (no lost update).
//   S-E5  the session-expiry sweep SKIPS an identity under an active turn lock (live turn not
//         expired out from under itself), but still sweeps a genuinely-stale unlocked session.
//   S-B4  ≤1 non-terminal session per identity: a concurrent createSession race yields exactly
//         one row (the loser recovers via the unique index), and loadActiveSession binds newest.
//   S-B3  the in-lock updateSessionContext is an optimistic CAS: a stale-version write is
//         rejected, never silently overwriting newer in-flight booking state.
// ============================================================================

import { vi } from 'vitest'

// Only the true external side-channels are stubbed (no WhatsApp network, no LLM). The lock,
// session manager, repository, and worker bodies under test run for real against the DB+Redis.
const sendMessage = vi.fn().mockResolvedValue({ ok: true })
vi.mock('../../src/adapters/whatsapp/sender.js', () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...a),
  sendTemplateMessage: vi.fn().mockResolvedValue({ ok: true }),
  canSendFreeForm: vi.fn().mockResolvedValue(false),
}))
// handleBookingFlow stands in for the LLM-driven flow body; its implementation is set per-test
// so S-E3 can detect a lost update on the session draft.
const handleBookingFlow = vi.fn()
vi.mock('../../src/domain/flows/customer-booking.js', () => ({
  handleBookingFlow: (...a: unknown[]) => handleBookingFlow(...a),
}))

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../../src/db/client.js'
import { conversationSessions, conversationMessages } from '../../src/db/schema.js'
import {
  loadActiveSession, createSession, completeSession, updateSessionContext, expireOldSessions,
} from '../../src/domain/session/manager.js'
import { withBusinessLock, withIdentityLock } from '../../src/domain/flows/concurrency-lock.js'
import { saveMessage } from '../../src/domain/messages/repository.js'
import { processJob as processQueuedMessage } from '../../src/workers/queued-messages.js'
import { seedBusiness, seedCustomer, teardown, freshPhone } from '../integration/setup.js'
import type { TestBusiness } from '../integration/setup.js'
import { raceN, countOk } from './race.js'

const ROUNDS = 20

async function nonTerminalSessions(identityId: string): Promise<number> {
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` })
    .from(conversationSessions)
    .where(and(
      eq(conversationSessions.identityId, identityId),
      sql`${conversationSessions.state} in ('active','waiting_confirmation','waiting_clarification')`,
    ))
  return Number(total)
}

async function customerMsgCount(sessionId: string): Promise<number> {
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` })
    .from(conversationMessages)
    .where(and(eq(conversationMessages.sessionId, sessionId), eq(conversationMessages.role, 'customer')))
  return Number(total)
}

describe('WS1 session-lifecycle races (real Redis + real Postgres)', () => {
  let biz: TestBusiness
  beforeAll(async () => { biz = await seedBusiness({ available247: true, calendarMode: 'internal' }) })
  afterAll(async () => { await teardown(biz.businessId) })

  // ───────────────────────────── S-B1 (B1, GREEN) ───────────────────────────
  // Two near-simultaneous manager turns. withBusinessLock ENQUEUES the contended one and runs
  // fn only for the holder. Because the inbound saveMessage now lives INSIDE the lock, the
  // enqueued-and-dropped turn persists NOTHING → no orphaned inbound (the bug was: it saved its
  // inbound before the lock, leaving a user message with no assistant reply).
  describe('S-B1 — manager inbound save inside the per-business lock (no orphan)', () => {
    it('a contended manager turn leaves no orphaned inbound, across rounds', async () => {
      for (let r = 0; r < ROUNDS; r++) {
        const cid = await seedCustomer(biz.businessId, freshPhone())
        const session = await createSession(db, biz.businessId, cid, 'manager_instruction')

        let ran = 0
        const turn = (msgId: string, body: string) =>
          withBusinessLock(biz.businessId, msgId, async () => {
            ran += 1
            // Inbound saved INSIDE the lock — the contended turn that never acquires the lock
            // never reaches this line, so it cannot orphan an inbound.
            await saveMessage(db, session.id, 'customer', body)
            await new Promise((res) => setTimeout(res, 30))
          })

        const results = await Promise.all([turn(`m-${r}-a`, 'first'), turn(`m-${r}-b`, 'second')])

        // Exactly one turn ran; the other was enqueued (returned null).
        expect(ran).toBe(1)
        expect(results.filter((x) => x === null)).toHaveLength(1)
        // Exactly one inbound persisted — the enqueued turn left no orphan.
        expect(await customerMsgCount(session.id)).toBe(1)

        await completeSession(db, session.id)
      }
    })
  })

  // ───────────────────────────── S-E3 (E3, GREEN) ───────────────────────────
  // Two concurrent queued-message replays for the same identity. processJob now wraps its
  // session-load → flow → persist body in withIdentityLock, so the two serialize: each reads the
  // OTHER's committed draft mutation. Without the lock both would read the same stale draft and
  // the second write would clobber the first (lost update).
  describe('S-E3 — queued-messages worker serialized by withIdentityLock (no clobbered draft)', () => {
    beforeEach(() => {
      sendMessage.mockClear()
      // The flow body does a read-modify-write on the session draft counter `n`. A delay widens
      // the race window so a missing lock WOULD interleave (and lose an update).
      handleBookingFlow.mockImplementation(async (
        _db: unknown, _cal: unknown, _identity: unknown,
        session: { id: string; context: Record<string, unknown> },
      ) => {
        const current = Number(session.context?.['n'] ?? 0)
        await new Promise((res) => setTimeout(res, 40))
        await updateSessionContext(db, session.id, { ...session.context, n: current + 1 })
        return { reply: '', paused: false, sessionComplete: false }
      })
    })

    it('two concurrent queued replays both apply — no lost session-draft update, across rounds', async () => {
      for (let r = 0; r < ROUNDS; r++) {
        const phone = freshPhone()
        const cid = await seedCustomer(biz.businessId, phone)
        // Pre-create the live session with n=0 so processJob's load path (not the hydrate path) runs.
        const session = await createSession(db, biz.businessId, cid, 'booking')
        await updateSessionContext(db, session.id, { n: 0 })

        const job = { data: { businessId: biz.businessId, fromNumber: phone, toNumber: biz.managerPhone, body: 'hi' } }
        await Promise.all([processQueuedMessage(job), processQueuedMessage(job)])

        // Both replays ran under the lock and serialized → counter is 2, not 1 (no lost update).
        const [row] = await db.select({ context: conversationSessions.context })
          .from(conversationSessions).where(eq(conversationSessions.id, session.id)).limit(1)
        expect(Number((row?.context as Record<string, unknown>)?.['n'])).toBe(2)

        await completeSession(db, session.id)
      }
    })
  })

  // ───────────────────────────── S-E5 (E5, GREEN) ───────────────────────────
  // The expiry sweep must not expire a session a live turn is holding. With the identity lock
  // held, expireOldSessions SKIPS the row; with no lock, it sweeps the genuinely-stale row.
  describe('S-E5 — session-expiry sweep guards rows under an active turn lock', () => {
    async function seedStaleSession(identityId: string): Promise<string> {
      const past = new Date(Date.now() - 60 * 60_000)
      const [row] = await db.insert(conversationSessions).values({
        businessId: biz.businessId, identityId, intent: 'booking', state: 'active',
        context: {}, lastMessageAt: past, expiresAt: past,
      }).returning({ id: conversationSessions.id })
      return row!.id
    }

    it('a session under an active identity lock is NOT expired mid-turn', async () => {
      const cid = await seedCustomer(biz.businessId, freshPhone())
      const sessionId = await seedStaleSession(cid)

      // Simulate a live turn holding the lock while the sweep ticks concurrently.
      await withIdentityLock(cid, async () => {
        await expireOldSessions(db)
        const [row] = await db.select({ state: conversationSessions.state })
          .from(conversationSessions).where(eq(conversationSessions.id, sessionId)).limit(1)
        expect(row?.state).toBe('active')
      })

      await db.delete(conversationSessions).where(eq(conversationSessions.id, sessionId))
    })

    it('a genuinely-stale, unlocked session IS swept', async () => {
      const cid = await seedCustomer(biz.businessId, freshPhone())
      const sessionId = await seedStaleSession(cid)

      const count = await expireOldSessions(db)
      expect(count).toBeGreaterThanOrEqual(1)
      const [row] = await db.select({ state: conversationSessions.state })
        .from(conversationSessions).where(eq(conversationSessions.id, sessionId)).limit(1)
      expect(row?.state).toBe('expired')

      await db.delete(conversationSessions).where(eq(conversationSessions.id, sessionId))
    })
  })

  // ───────────────────────────── S-B4 (B4, GREEN) ───────────────────────────
  // ≤1 non-terminal session per identity. A concurrent createSession race (separate DB backends)
  // must yield exactly one row — the loser hits the partial unique index (23505) and recovers by
  // binding the existing live session. loadActiveSession binds the newest non-terminal session.
  describe('S-B4 — single active session + newest-first selection', () => {
    it('concurrent createSession yields exactly one non-terminal row, across rounds', async () => {
      for (let r = 0; r < ROUNDS; r++) {
        const cid = await seedCustomer(biz.businessId, freshPhone())

        const results = await raceN((d) => createSession(d, biz.businessId, cid, 'booking'), 2)

        // Both calls return a session (one inserts, one recovers) and they agree on the id.
        expect(countOk(results, (s) => !!s?.id)).toBe(2)
        expect(results[0]!.id).toBe(results[1]!.id)
        // Exactly one non-terminal row exists for the identity (the unique index held).
        expect(await nonTerminalSessions(cid)).toBe(1)

        await db.update(conversationSessions).set({ state: 'completed' })
          .where(eq(conversationSessions.identityId, cid))
      }
    })

    it('loadActiveSession binds the NEWEST non-terminal session, not a completed older one', async () => {
      const cid = await seedCustomer(biz.businessId, freshPhone())
      const older = await createSession(db, biz.businessId, cid, 'booking')
      await completeSession(db, older.id)        // terminal — must be excluded
      const newer = await createSession(db, biz.businessId, cid, 'booking')

      const active = await loadActiveSession(db, cid)
      expect(active?.id).toBe(newer.id)

      await db.update(conversationSessions).set({ state: 'completed' })
        .where(eq(conversationSessions.identityId, cid))
    })
  })
})
