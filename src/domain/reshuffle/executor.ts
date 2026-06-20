// Proactive Reshuffle Engine — atomic chain executor.
//
// Applies an APPROVED proposal's moves in one transaction (invariants #1, #2, #3):
//   - never writes unless the proposal is `approved` (no write before approval),
//   - re-validates the whole plan under FOR UPDATE at apply time (catches stale approvals,
//     decision D5, and any externally-changed booking),
//   - commits all moves or none (Postgres transaction semantics → atomic apply),
//   - leaves the internal record as source of truth and lets the durable mirror push to Google.

import { eq, inArray } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { bookings, reshuffleCampaigns, reshuffleProposals } from '../../db/schema.js'
import { enqueueBookingMirror } from '../../workers/calendar-mirror.js'
import type { Move } from './types.js'

type Db = typeof db

export type ExecutorResult =
  | { ok: true; movedCount: number }
  | { ok: false; reason: string }

/**
 * Apply an approved reshuffle proposal. Returns `ok:false` (calendar untouched) on any
 * guard failure; on a mid-apply error the transaction rolls back, leaving zero partial writes.
 */
export async function applyReshuffleProposal(database: Db, proposalId: string): Promise<ExecutorResult> {
  const [proposal] = await database
    .select()
    .from(reshuffleProposals)
    .where(eq(reshuffleProposals.id, proposalId))
    .limit(1)

  if (!proposal) return { ok: false, reason: 'proposal_not_found' }
  // Invariant #1: nothing is applied unless the owner approved it.
  if (proposal.status !== 'approved') return { ok: false, reason: `not_approved:${proposal.status}` }

  const moves = proposal.moves as Move[]
  if (!Array.isArray(moves) || moves.length === 0) return { ok: false, reason: 'empty_proposal' }

  const [campaign] = await database
    .select()
    .from(reshuffleCampaigns)
    .where(eq(reshuffleCampaigns.id, proposal.campaignId))
    .limit(1)
  if (!campaign) return { ok: false, reason: 'campaign_not_found' }

  const runInTx = (database as unknown as { transaction: <T>(fn: (t: Db) => Promise<T>) => Promise<T> })

  const result = await runInTx.transaction(async (t) => {
    const ids = moves.map((m) => m.bookingId)
    const locked = await t.select().from(bookings).where(inArray(bookings.id, ids)).for('update')
    const byId = new Map(locked.map((b) => [b.id, b]))

    // Re-validate the entire plan before touching anything (D5 / occupancy).
    for (const m of moves) {
      const b = byId.get(m.bookingId)
      if (!b) return { ok: false as const, reason: 'stale_plan:booking_missing' }
      if (b.state !== 'confirmed') return { ok: false as const, reason: 'stale_plan:not_confirmed' }
      if (b.slotStart.getTime() !== new Date(m.fromSlot.start).getTime()) {
        return { ok: false as const, reason: 'stale_plan:slot_changed' }
      }
    }

    // Apply the cycle. With no DB-level (provider,slot) uniqueness, sequential reassignment
    // inside one transaction never errors on the transient overlap; the cycle's final state
    // is collision-free. (If such a constraint is later added it must be DEFERRABLE — see 0021.)
    for (const m of moves) {
      const start = new Date(m.toSlot.start)
      const end = new Date(start.getTime() + m.toSlot.durationMin * 60_000)
      await t.update(bookings).set({ slotStart: start, slotEnd: end }).where(eq(bookings.id, m.bookingId))
    }
    return { ok: true as const }
  })

  if (!result.ok) {
    await database
      .update(reshuffleCampaigns)
      .set({ status: 'failed', resolvedAt: new Date() })
      .where(eq(reshuffleCampaigns.id, campaign.id))
    return result
  }

  // Committed. Mark applied and write-through to Google via the durable mirror (internal-as-hub).
  await database
    .update(reshuffleProposals)
    .set({ status: 'applied', decidedAt: new Date() })
    .where(eq(reshuffleProposals.id, proposalId))
  await database
    .update(reshuffleCampaigns)
    .set({ status: 'applied', resolvedAt: new Date() })
    .where(eq(reshuffleCampaigns.id, campaign.id))

  for (const m of moves) {
    await enqueueBookingMirror(campaign.businessId, m.bookingId).catch(() => {
      /* non-fatal: calendar reconcile catches up */
    })
  }

  return { ok: true, movedCount: moves.length }
}
