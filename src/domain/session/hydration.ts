import { eq, and, or, desc, gte } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { bookings, serviceTypes, conversationSessions, conversationMessages, customerSessionNotes } from '../../db/schema.js'
import type { CustomerMemory } from '../customer/profile.js'
import type { TranscriptTurn } from '../../adapters/llm/types.js'

export interface RecentBooking {
  serviceName: string
  slotStart: string
  state: string
}

export interface HydratedContext {
  customerMemory: CustomerMemory | null
  // Surfaced directly so the LLM prompt can reference them without parsing
  returningCustomer: boolean
  preferredServiceName: string | null
  daysSinceLastBooking: number | null
  upcomingBooking: {
    id: string
    slotStart: string
    serviceName: string
    state: string
  } | null
  // Last ~6 months of this customer's bookings, newest first — lets the PA
  // reference history naturally ("the usual?") without reciting a database.
  recentBookings: RecentBooking[]
  // Last few cross-session conversation summaries (newest first) — what was
  // DISCUSSED across prior visits, so the PA picks up like a regular.
  sessionSummaries: string[]
}

export async function buildHydratedContext(
  db: Db,
  identityId: string,
  businessId: string,
  memory: CustomerMemory | null,
): Promise<HydratedContext> {
  // Load the next upcoming confirmed booking for this customer, if any
  const now = new Date()
  const upcomingRows = await db
    .select({
      id: bookings.id,
      slotStart: bookings.slotStart,
      state: bookings.state,
      serviceName: serviceTypes.name,
    })
    .from(bookings)
    .leftJoin(serviceTypes, eq(bookings.serviceTypeId, serviceTypes.id))
    .where(
      and(
        eq(bookings.customerId, identityId),
        eq(bookings.businessId, businessId),
        or(eq(bookings.state, 'confirmed'), eq(bookings.state, 'held')),
      ),
    )
    .orderBy(desc(bookings.slotStart))
    .limit(1)

  const upcoming = upcomingRows[0] ?? null

  // Recent booking history — last 6 months, newest first, capped.
  const sixMonthsAgo = new Date(now.getTime() - 182 * 24 * 60 * 60_000)
  const recentRows = await db
    .select({
      slotStart: bookings.slotStart,
      state: bookings.state,
      serviceName: serviceTypes.name,
    })
    .from(bookings)
    .leftJoin(serviceTypes, eq(bookings.serviceTypeId, serviceTypes.id))
    .where(
      and(
        eq(bookings.customerId, identityId),
        eq(bookings.businessId, businessId),
        gte(bookings.slotStart, sixMonthsAgo),
        or(eq(bookings.state, 'confirmed'), eq(bookings.state, 'cancelled')),
      ),
    )
    .orderBy(desc(bookings.slotStart))
    .limit(8)

  const recentBookings: RecentBooking[] = recentRows.map((r) => ({
    serviceName: r.serviceName ?? 'Appointment',
    slotStart: r.slotStart.toISOString(),
    state: r.state,
  }))

  // Cross-session conversation summaries (last 3). Defensive: if the table is
  // not present yet (migration not applied), degrade to none rather than throw.
  let sessionSummaries: string[] = []
  try {
    const noteRows = await db
      .select({ summary: customerSessionNotes.summary })
      .from(customerSessionNotes)
      .where(eq(customerSessionNotes.identityId, identityId))
      .orderBy(desc(customerSessionNotes.createdAt))
      .limit(3)
    sessionSummaries = noteRows.map((r) => r.summary)
  } catch {
    sessionSummaries = []
  }

  const daysSinceLastBooking =
    memory?.lastBookingAt != null
      ? Math.floor((now.getTime() - memory.lastBookingAt.getTime()) / (1000 * 60 * 60 * 24))
      : null

  return {
    customerMemory: memory,
    returningCustomer: memory !== null && memory.totalBookings > 0,
    preferredServiceName: memory?.preferredServiceName ?? null,
    daysSinceLastBooking,
    upcomingBooking: upcoming
      ? {
          id: upcoming.id,
          slotStart: upcoming.slotStart.toISOString(),
          serviceName: upcoming.serviceName ?? 'Appointment',
          state: upcoming.state,
        }
      : null,
    recentBookings,
    sessionSummaries,
  }
}

// ── Cross-session carryover (recent conversational memory) ────────────────────
// A customer's transcript is scoped to one session; when a session ends (a booking
// confirmed, a 30-min idle expiry, etc.) the next message would otherwise start
// cold. This pulls the tail of the customer's most recent prior session — when it
// was recent enough — so a continuing conversation keeps its thread and the PA
// doesn't re-introduce itself. Booking state is NEVER carried (only conversational
// context): just the last few turns plus greeted/language flags.

const CARRYOVER_WINDOW_MS = 6 * 60 * 60 * 1000 // 6 hours

export interface SessionCarryover {
  priorTurns: TranscriptTurn[]
  greeted: boolean
  detectedLanguage?: 'he' | 'en'
  languageOverride?: 'he' | 'en'
}

export async function loadSessionCarryover(
  db: Db,
  identityId: string,
  now: Date = new Date(),
  windowMs: number = CARRYOVER_WINDOW_MS,
): Promise<SessionCarryover | null> {
  const [prev] = await db
    .select({
      id: conversationSessions.id,
      context: conversationSessions.context,
      lastMessageAt: conversationSessions.lastMessageAt,
    })
    .from(conversationSessions)
    .where(eq(conversationSessions.identityId, identityId))
    .orderBy(desc(conversationSessions.lastMessageAt))
    .limit(1)

  if (!prev || !prev.lastMessageAt) return null
  if (now.getTime() - prev.lastMessageAt.getTime() > windowMs) return null

  const rows = await db
    .select({ role: conversationMessages.role, text: conversationMessages.text })
    .from(conversationMessages)
    .where(eq(conversationMessages.sessionId, prev.id))
    .orderBy(desc(conversationMessages.createdAt))
    .limit(6)

  const priorTurns: TranscriptTurn[] = rows
    .reverse()
    .map((r) => ({ role: r.role as 'customer' | 'assistant', text: r.text }))

  const ctx = (prev.context as Record<string, unknown>) ?? {}
  const lang = (v: unknown): 'he' | 'en' | undefined => (v === 'he' || v === 'en' ? v : undefined)
  const detectedLanguage = lang(ctx['detectedLanguage'])
  const languageOverride = lang(ctx['languageOverride'])

  return {
    priorTurns,
    greeted: ctx['greeted'] === true,
    ...(detectedLanguage ? { detectedLanguage } : {}),
    ...(languageOverride ? { languageOverride } : {}),
  }
}
