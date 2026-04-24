import { eq, and, or, lt } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { conversationSessions } from '../../db/schema.js'
import type { ActiveSession, SessionState, SessionIntent } from './types.js'

const SESSION_EXPIRY_MINUTES = parseInt(process.env['SESSION_EXPIRY_MINUTES'] ?? '30', 10)

function expiryFromNow(): Date {
  return new Date(Date.now() + SESSION_EXPIRY_MINUTES * 60 * 1000)
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
    .orderBy(conversationSessions.createdAt)
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
    expiresAt: row.expiresAt,
  }
}

export async function createSession(
  db: Db,
  businessId: string,
  identityId: string,
  intent: SessionIntent,
): Promise<ActiveSession> {
  const now = new Date()
  const expiresAt = expiryFromNow()

  const [row] = await db
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

  if (!row) throw new Error('Failed to create session')

  return {
    id: row.id,
    businessId: row.businessId,
    identityId: row.identityId,
    intent: row.intent ?? 'unknown',
    state: row.state,
    context: {},
    expiresAt: row.expiresAt,
  }
}

export async function updateSessionContext(
  db: Db,
  sessionId: string,
  context: Record<string, unknown>,
  state?: SessionState,
): Promise<void> {
  await db
    .update(conversationSessions)
    .set({
      context,
      ...(state !== undefined ? { state } : {}),
      lastMessageAt: new Date(),
      expiresAt: expiryFromNow(),
    })
    .where(eq(conversationSessions.id, sessionId))
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

// Called by the hold-expiry background job to clean up stale sessions
export async function expireOldSessions(db: Db): Promise<number> {
  const result = await db
    .update(conversationSessions)
    .set({ state: 'expired' })
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

  return (result as unknown as { rowCount: number }).rowCount ?? 0
}
