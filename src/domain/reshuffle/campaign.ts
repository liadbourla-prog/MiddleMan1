// Proactive Reshuffle Engine — campaign orchestrator (the deterministic brain).
//
// Turns the live state (bookings + discovered willingness from outreach) into a concrete
// proposal via the pure solver. No LLM here; outreach I/O (sending messages, TTL, ladder,
// batching) lives in the worker. This module reads the snapshot and assembles the plan.

import { and, eq, gte, inArray } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { bookings, identities, serviceTypes, reshuffleCampaigns, reshuffleOffers, reshuffleProposals } from '../../db/schema.js'
import { resolveReshuffleConfig, isProtectedFromMove, type ReshuffleConfig } from './config.js'
import { solveReshuffle } from './solver.js'
import type { ReshuffleBooking, Slot } from './types.js'

type Db = typeof db

const HOUR_MS = 3_600_000
const toSlot = (start: Date, end: Date): Slot => ({ start: start.toISOString(), durationMin: Math.round((end.getTime() - start.getTime()) / 60_000) })

/** Whether a service of `durationMin` fits a slot, by duration. Occupied-slot cycles only
 *  need duration compatibility (the slot already hosts a valid booking). The worker passes a
 *  spine-backed `canFit` for open slots / better-offers. */
const durationCanFit = (durationMin: number, slot: Slot): boolean => durationMin <= slot.durationMin

/**
 * Build the displacement-graph snapshot: every future confirmed booking for the business,
 * each tagged `protected` per the owner's policy (near-term / VIP / recently-rescheduled).
 */
export async function buildSnapshot(database: Db, businessId: string, config: ReshuffleConfig, now: Date): Promise<ReshuffleBooking[]> {
  const rows = await database
    .select({
      id: bookings.id,
      customerId: bookings.customerId,
      slotStart: bookings.slotStart,
      slotEnd: bookings.slotEnd,
      durationMinutes: serviceTypes.durationMinutes,
      vip: identities.vip,
      rescheduledFrom: bookings.rescheduledFrom,
      createdAt: bookings.createdAt,
    })
    .from(bookings)
    .innerJoin(serviceTypes, eq(bookings.serviceTypeId, serviceTypes.id))
    .innerJoin(identities, eq(bookings.customerId, identities.id))
    .where(and(eq(bookings.businessId, businessId), eq(bookings.state, 'confirmed'), gte(bookings.slotStart, now)))

  return rows.map((r) => ({
    id: r.id,
    customerId: r.customerId,
    slot: { start: r.slotStart.toISOString(), durationMin: r.durationMinutes },
    serviceDurationMin: r.durationMinutes,
    // "recently rescheduled" is derived from lineage: a booking created via reschedule
    // carries rescheduledFrom; its createdAt is when the move happened.
    protected: isProtectedFromMove(
      { slotStart: r.slotStart, vip: r.vip, lastRescheduledAt: r.rescheduledFrom ? r.createdAt : null },
      config,
      now,
    ),
  }))
}

/** Discovered edges: a booking's owner has agreed (accepted) or proposed (countered) a slot. */
export async function buildWillingness(database: Db, campaignId: string): Promise<Record<string, Slot[]>> {
  const offers = await database
    .select()
    .from(reshuffleOffers)
    .where(and(eq(reshuffleOffers.campaignId, campaignId), inArray(reshuffleOffers.status, ['accepted', 'countered'])))

  const willingness: Record<string, Slot[]> = {}
  for (const o of offers) {
    if (!o.bookingId) continue
    const slot =
      o.status === 'countered' && o.counterSlotStart && o.counterSlotEnd
        ? toSlot(o.counterSlotStart, o.counterSlotEnd)
        : toSlot(o.proposedSlotStart, o.proposedSlotEnd)
    ;(willingness[o.bookingId] ??= []).push(slot)
  }
  return willingness
}

export type AssembleResult =
  | { ok: true; proposalId: string; kind: 'exact' | 'better_offer'; movedCount: number }
  | { ok: false; reason: string }

/**
 * Try to assemble a proposal for a searching campaign from the willingness discovered so far.
 * On success, persists a `pending` proposal and moves the campaign to `solution_pending_approval`.
 * On no solution, leaves the campaign searching (the worker decides when to give up — G-6).
 */
export async function assembleProposal(
  database: Db,
  campaignId: string,
  now: Date,
  canFit: (durationMin: number, slot: Slot) => boolean = durationCanFit,
): Promise<AssembleResult> {
  const [campaign] = await database.select().from(reshuffleCampaigns).where(eq(reshuffleCampaigns.id, campaignId)).limit(1)
  if (!campaign) return { ok: false, reason: 'campaign_not_found' }
  if (campaign.status !== 'searching') return { ok: false, reason: `not_searching:${campaign.status}` }

  const config = resolveReshuffleConfig(campaign.configSnapshot)
  const snapshot = await buildSnapshot(database, campaign.businessId, config, now)
  const willingness = await buildWillingness(database, campaignId)

  const requester = snapshot.find((b) => b.id === campaign.requesterBookingId)
  if (!requester) return { ok: false, reason: 'requester_booking_gone' }

  const targetSlot: Slot = { start: campaign.targetSlotStart.toISOString(), durationMin: requester.serviceDurationMin }

  const solution = solveReshuffle({
    requesterBookingId: campaign.requesterBookingId,
    targetSlot,
    bookings: snapshot,
    willingness,
    requesterAlternatives: [],
    openSlots: [],
    maxChainLength: config.maxChainLength,
    canFit,
  })

  if (!solution) return { ok: false, reason: 'no_solution' }

  const [proposal] = await database
    .insert(reshuffleProposals)
    .values({
      campaignId,
      moves: solution.moves,
      touchedCount: solution.moves.length,
      kind: solution.kind,
      status: 'pending',
      presentedToOwnerAt: now,
    })
    .returning()

  const strategy = solution.moves.length <= 2 ? 'direct' : 'chain'
  await database
    .update(reshuffleCampaigns)
    .set({ status: 'solution_pending_approval', strategy })
    .where(eq(reshuffleCampaigns.id, campaignId))

  return { ok: true, proposalId: proposal!.id, kind: solution.kind, movedCount: solution.moves.length }
}

/** Time helpers re-exported for the worker's TTL/termination logic. */
export const hoursBetween = (a: Date, b: Date): number => Math.abs(a.getTime() - b.getTime()) / HOUR_MS
