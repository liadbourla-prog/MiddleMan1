import { eq, and, or, lt, sql, desc } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { conversationSessions } from '../../db/schema.js'
import { isIdentityLocked } from '../flows/concurrency-lock.js'
import type { ActiveSession, SessionState, SessionIntent } from './types.js'

const DEFAULT_SESSION_EXPIRY_MINUTES = parseInt(process.env['SESSION_EXPIRY_MINUTES'] ?? '30', 10)

// Phase 4 (churn): a customer mid-booking (awaiting confirmation or clarification)
// gets a longer idle grace so a brief step-away doesn't expire the session and lose
// the in-flight slot. Only the customer flow uses these waiting_* states.
const MID_FLOW_EXPIRY_MINUTES = 60

export const SESSION_EXPIRY = {
  customer: DEFAULT_SESSION_EXPIRY_MINUTES,
  manager: 240,
} as const

function expiryFromNow(minutes: number = DEFAULT_SESSION_EXPIRY_MINUTES): Date {
  return new Date(Date.now() + minutes * 60 * 1000)
}

export async function loadActiveSession(
  db: Db,
  identityId: string,
): Promise<ActiveSession | null> {
  const now = new Date()

  const [row] = await db
    .select()
    .from(conversationSessions)
    .where(
      and(
        eq(conversationSessions.identityId, identityId),
        or(
          eq(conversationSessions.state, 'active'),
          eq(conversationSessions.state, 'waiting_confirmation'),
          eq(conversationSessions.state, 'waiting_clarification'),
        ),
      ),
    )
    // B4 (T1.8d): bind the NEWEST non-terminal session, never a shadowed older duplicate.
    // The partial unique index (migration 0050) makes duplicates impossible going forward;
    // DESC is the defense-in-depth that also picks correctly during the window before the
    // index would reject a second insert.
    .orderBy(desc(conversationSessions.createdAt))
    .limit(1)

  if (!row) return null
  if (row.expiresAt < now) {
    await expireSession(db, row.id)
    return null
  }

  return {
    id: row.id,
    businessId: row.businessId,
    identityId: row.identityId,
    intent: row.intent ?? 'unknown',
    state: row.state,
    context: (row.context as Record<string, unknown>) ?? {},
    contextVersion: row.contextVersion ?? 0,
    expiresAt: row.expiresAt,
  }
}

export async function createSession(
  db: Db,
  businessId: string,
  identityId: string,
  intent: SessionIntent,
  expiryMinutes?: number,
): Promise<ActiveSession> {
  const now = new Date()
  const expiresAt = expiryFromNow(expiryMinutes)

  let row
  try {
    ;[row] = await db
      .insert(conversationSessions)
      .values({
        businessId,
        identityId,
        intent,
        state: 'active',
        context: {},
        lastMessageAt: now,
        expiresAt,
      })
      .returning()
  } catch (err) {
    // B4 (T1.8d): a concurrent turn that slipped the per-identity lock (fail-open) already
    // created the live session; the partial unique index (migration 0050) rejects this second
    // insert with 23505. Recover by binding to the existing session instead of erroring the
    // turn — the DB, not a lost race, decides there is exactly one active session.
    if (typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505') {
      const existing = await loadActiveSession(db, identityId)
      if (existing) return existing
    }
    throw err
  }

  if (!row) throw new Error('Failed to create session')

  return {
    id: row.id,
    businessId: row.businessId,
    identityId: row.identityId,
    intent: row.intent ?? 'unknown',
    state: row.state,
    context: {},
    contextVersion: row.contextVersion ?? 0,
    expiresAt: row.expiresAt,
  }
}

// B3 (T1.9): the in-lock session-context write is an OPTIMISTIC compare-and-set.
//
// Every write bumps `context_version` so a concurrent writer can detect it. When the caller
// passes `expectedVersion` (the version it read at load time), the write is gated on the
// version being unchanged — a fail-open second turn (withIdentityLock releases after ~8s) that
// read an older version is REJECTED (returns false) instead of silently clobbering the newer
// in-flight booking state. When `expectedVersion` is omitted the write is unconditional (the
// pre-existing last-write-wins behavior) but STILL bumps the version, so a concurrent CAS
// writer against the old version still loses. Returns whether the write was applied.
export async function updateSessionContext(
  db: Db,
  sessionId: string,
  context: Record<string, unknown>,
  state?: SessionState,
  expiryMinutes?: number,
  expectedVersion?: number,
): Promise<boolean> {
  // Mid-flow states get a longer idle grace (unless the caller set an explicit
  // window) so a customer pausing mid-booking doesn't lose their slot.
  const minutes = expiryMinutes
    ?? (state === 'waiting_confirmation' || state === 'waiting_clarification'
      ? MID_FLOW_EXPIRY_MINUTES
      : undefined)

  const setClause = {
    context,
    contextVersion: sql`${conversationSessions.contextVersion} + 1`,
    ...(state !== undefined ? { state } : {}),
    lastMessageAt: new Date(),
    expiresAt: expiryFromNow(minutes),
  }

  if (expectedVersion === undefined) {
    await db
      .update(conversationSessions)
      .set(setClause)
      .where(eq(conversationSessions.id, sessionId))
    return true
  }

  // CAS path: only write if the version is still the one we read. Under READ COMMITTED, a
  // concurrent winner that bumps the version first makes this UPDATE's predicate fail on
  // re-evaluation → 0 rows → rejected.
  const applied = await db
    .update(conversationSessions)
    .set(setClause)
    .where(and(
      eq(conversationSessions.id, sessionId),
      eq(conversationSessions.contextVersion, expectedVersion),
    ))
    .returning({ id: conversationSessions.id })

  return applied.length > 0
}

export async function completeSession(db: Db, sessionId: string): Promise<void> {
  await db
    .update(conversationSessions)
    .set({ state: 'completed', lastMessageAt: new Date() })
    .where(eq(conversationSessions.id, sessionId))
}

export async function failSession(db: Db, sessionId: string): Promise<void> {
  await db
    .update(conversationSessions)
    .set({ state: 'failed', lastMessageAt: new Date() })
    .where(eq(conversationSessions.id, sessionId))
}

async function expireSession(db: Db, sessionId: string): Promise<void> {
  await db
    .update(conversationSessions)
    .set({ state: 'expired' })
    .where(eq(conversationSessions.id, sessionId))
}

// Called by the session-expiry background sweep to clean up stale sessions.
//
// E5 (T1.8c): the sweep must NEVER expire a session that a live turn is actively holding.
// A turn that began just before expiresAt can run several LLM calls (pushing past it) and
// then refresh expiresAt when it persists — a blanket `UPDATE … WHERE expiresAt < now` would
// expire it out from under the live turn, and the turn's later context write (which doesn't
// re-assert state) would leave the row terminal → "the PA forgot mid-conversation."
//
// Two guards, both needed:
//   1. lock-skip — skip any identity that currently holds the per-identity turn lock (a live
//      turn in flight that has not yet refreshed its expiresAt).
//   2. re-confirm at write time — the per-row UPDATE re-checks `expires_at < now()` in the DB,
//      so a turn that refreshed expiresAt to the future between the candidate read and this
//      write is left untouched (0 rows).
export async function expireOldSessions(db: Db): Promise<number> {
  const candidates = await db
    .select({ id: conversationSessions.id, identityId: conversationSessions.identityId })
    .from(conversationSessions)
    .where(
      and(
        lt(conversationSessions.expiresAt, new Date()),
        or(
          eq(conversationSessions.state, 'active'),
          eq(conversationSessions.state, 'waiting_confirmation'),
          eq(conversationSessions.state, 'waiting_clarification'),
        ),
      ),
    )

  let expired = 0
  for (const c of candidates) {
    // Live turn mid-flight for this identity — leave its session alone this tick.
    if (await isIdentityLocked(c.identityId)) continue

    // Count via RETURNING — the postgres-js driver exposes affected rows as `.count`, not
    // `.rowCount`, so the previous `.rowCount ?? 0` always reported 0 (the rows were still
    // expired; only the count/log was wrong). RETURNING length is driver-agnostic and exact.
    const flipped = await db
      .update(conversationSessions)
      .set({ state: 'expired' })
      .where(
        and(
          eq(conversationSessions.id, c.id),
          // Re-confirm against the DB clock: a turn that just refreshed expiresAt wins.
          lt(conversationSessions.expiresAt, sql`now()`),
          or(
            eq(conversationSessions.state, 'active'),
            eq(conversationSessions.state, 'waiting_confirmation'),
            eq(conversationSessions.state, 'waiting_clarification'),
          ),
        ),
      )
      .returning({ id: conversationSessions.id })
    expired += flipped.length
  }

  return expired
}
