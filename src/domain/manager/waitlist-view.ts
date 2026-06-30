/**
 * WL-9 — Owner read-side "who's on the waitlist?" tool (Branch 3).
 *
 * READ-ONLY. Answers "who's waiting for {service} [on {date/time}]?" for the owner.
 * Returns STRUCTURED DATA (count + entries with name/phone/status/tier/joinedAt); the
 * orchestrator LLM phrases the owner-facing reply, so there is no fixed human-facing
 * string to voice-gate here (any literal text would have to comply with
 * CHAT_LEVEL_LAWBOOK.md — we keep the output as data).
 *
 * Lives in its OWN file (not orchestrator-tools.ts) because that file is being edited
 * by a parallel effort; this reuses ToolContext from there via a read-only type import.
 *
 * Tier = the WL-2a fairness logic (plan §3.2): a waiter with NO active booking in
 * [now, now+7d] at this business (any service) ranks AHEAD (priority) of one who has a
 * session that week (normal). FIFO within tier. Reused from domain/waitlist/priority.ts.
 */

import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm'
import { waitlist, identities, bookings } from '../../db/schema.js'
import { serviceTypes } from '../../db/schema.js'
import { rankWaitlistCandidates, waitlistTier } from '../waitlist/priority.js'
import type { ToolContext } from './orchestrator-tools.js'
import { resolveSlotRange, type RelativeDay } from '../availability/resolve-slot.js'

// Active booking states that count as a "commitment" for the fairness window
// (plan §3.2: confirmed | pending_payment | held — any service, business-scoped).
const COMMITMENT_STATES = ['confirmed', 'pending_payment', 'held'] as const
// Waitlist rows the owner cares about: people still waiting or mid-offer.
const VISIBLE_WAITLIST_STATES = ['pending', 'offered'] as const
const WINDOW_MS = 7 * 24 * 60 * 60 * 1000

interface DatePieces {
  relativeDay?: RelativeDay
  weekday?: number
  explicitDate?: { year?: number; month?: number; day?: number }
}
interface TimePieces { hour: number; minute: number }

export interface ViewWaitlistArgs {
  // Name of the class/service (matched fuzzily). Optional only when the business has a
  // single active service; otherwise required so the right list is found.
  serviceName?: string
  // Optional concrete slot — when the owner asks about ONE specific session
  // ("who's waiting for tomorrow's 10:00?"). Omit for the whole service's waitlist.
  date?: DatePieces
  time?: TimePieces
}

function toDateParts(d: DatePieces | undefined) {
  return {
    relativeDay: d?.relativeDay ?? null,
    weekday: d?.weekday ?? null,
    explicitDate: d?.explicitDate
      ? { year: d.explicitDate.year ?? null, month: d.explicitDate.month ?? null, day: d.explicitDate.day ?? null }
      : null,
  }
}

export async function executeViewWaitlist(args: ViewWaitlistArgs, ctx: ToolContext): Promise<object> {
  // ── Resolve the named service to a serviceTypeId, the SAME way orchestrator-tools
  // does (fuzzy ilike; single-active fallback when no name is given). No name + many
  // services ⇒ ask which.
  let serviceTypeId: string | null = null
  let serviceName: string | null = null
  if (args.serviceName && args.serviceName.trim().length > 0) {
    const [svc] = await ctx.db
      .select({ id: serviceTypes.id, name: serviceTypes.name })
      .from(serviceTypes)
      .where(and(eq(serviceTypes.businessId, ctx.businessId), eq(serviceTypes.isActive, true)))
      .limit(50)
      .then((rows) =>
        rows.filter((r) => r.name.toLowerCase().includes(args.serviceName!.trim().toLowerCase())),
      )
    serviceTypeId = svc?.id ?? null
    serviceName = svc?.name ?? null
  } else {
    const active = await ctx.db
      .select({ id: serviceTypes.id, name: serviceTypes.name })
      .from(serviceTypes)
      .where(and(eq(serviceTypes.businessId, ctx.businessId), eq(serviceTypes.isActive, true)))
      .limit(2)
    if (active.length === 1) {
      serviceTypeId = active[0]!.id
      serviceName = active[0]!.name
    }
  }

  if (!serviceTypeId) {
    return { error: 'unknown_service', guidance: 'Ask the owner which class/service they mean.' }
  }

  // ── Optionally narrow to one concrete slot. The LLM only classified the pieces; the
  // deterministic core resolves the absolute instant (Principle #1, never guess a slot).
  let slotStart: Date | null = null
  if (args.date && args.time) {
    const resolved = resolveSlotRange(
      { date: toDateParts(args.date), startTime: args.time, durationMinutes: 1 },
      ctx.timezone,
      new Date(),
    )
    if (!resolved.ok) {
      return { error: 'unresolvable_slot', needsClarification: true, guidance: 'Ask the owner which exact day and time they mean.' }
    }
    slotStart = resolved.start
  }

  // ── Read the waiting entries (status ∈ {pending, offered}) joined to identities for
  // name + phone, FIFO by createdAt. Scoped to business + service (+ slot if given).
  const conds = [
    eq(waitlist.businessId, ctx.businessId),
    eq(waitlist.serviceTypeId, serviceTypeId),
    inArray(waitlist.status, [...VISIBLE_WAITLIST_STATES]),
  ]
  if (slotStart) conds.push(eq(waitlist.slotStart, slotStart))

  const rows = await ctx.db
    .select({
      id: waitlist.id,
      customerId: waitlist.customerId,
      status: waitlist.status,
      createdAt: waitlist.createdAt,
      displayName: identities.displayName,
      phoneNumber: identities.phoneNumber,
    })
    .from(waitlist)
    .innerJoin(identities, eq(waitlist.customerId, identities.id))
    .where(and(...conds))
    .orderBy(asc(waitlist.createdAt))

  if (rows.length === 0) {
    return {
      service: serviceName,
      ...(slotStart ? { slot: slotStart.toISOString() } : {}),
      count: 0,
      entries: [],
    }
  }

  // ── Commitment probe (WL-2a fairness, plan §3.2): which of these waiters has an
  // ACTIVE booking in [now, now+7d] at this business (any service)? One batched read.
  const now = new Date()
  const windowEnd = new Date(now.getTime() + WINDOW_MS)
  const candidateIds = [...new Set(rows.map((r) => r.customerId))]
  const committedRows = await ctx.db
    .select({ customerId: bookings.customerId })
    .from(bookings)
    .where(
      and(
        eq(bookings.businessId, ctx.businessId),
        inArray(bookings.customerId, candidateIds),
        inArray(bookings.state, [...COMMITMENT_STATES]),
        gte(bookings.slotStart, now),
        lte(bookings.slotStart, windowEnd),
      ),
    )
  const committed = new Set(committedRows.map((b) => b.customerId))

  // ── Rank: priority tier (no commitment) first, FIFO within tier. Reuse the pure
  // WL-2a ranker so owner-read ordering matches the worker's offer ordering exactly.
  const hasCommitment = (entry: (typeof rows)[number]) => committed.has(entry.customerId)
  const ranked = rankWaitlistCandidates(rows, hasCommitment)

  return {
    service: serviceName,
    ...(slotStart ? { slot: slotStart.toISOString() } : {}),
    count: ranked.length,
    entries: ranked.map((r) => ({
      name: r.displayName,
      phoneNumber: r.phoneNumber,
      status: r.status,
      tier: waitlistTier(committed.has(r.customerId)),
      joinedAt: r.createdAt.toISOString(),
    })),
  }
}
