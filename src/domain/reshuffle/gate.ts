// Proactive Reshuffle Engine — owner approval gate (deterministic core).
//
// The conversational surface (manager-orchestrator tools, consequence explanations) wraps
// these. Default policy is approval-required (decision: PA waits). Nothing is written until
// approve, and reject leaves the calendar untouched (D1/D2).

import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { reshuffleCampaigns, reshuffleOffers, reshuffleProposals } from '../../db/schema.js'
import { applyReshuffleProposal, type ExecutorResult } from './executor.js'

type Db = typeof db

/**
 * Owner approves a pending proposal → mark approved and apply it atomically.
 * Re-validation + atomicity live in the executor (D5/E1). Returns the executor result.
 */
export async function approveProposal(database: Db, proposalId: string, now: Date): Promise<ExecutorResult> {
  const [proposal] = await database.select().from(reshuffleProposals).where(eq(reshuffleProposals.id, proposalId)).limit(1)
  if (!proposal) return { ok: false, reason: 'proposal_not_found' }
  if (proposal.status !== 'pending' && proposal.status !== 'amended') {
    return { ok: false, reason: `not_decidable:${proposal.status}` }
  }

  await database
    .update(reshuffleProposals)
    .set({ status: 'approved', decidedAt: now })
    .where(eq(reshuffleProposals.id, proposalId))

  return applyReshuffleProposal(database, proposalId)
}

/**
 * Owner rejects a proposal → no booking changes; campaign abandoned, outstanding offers
 * released (the worker soft-retracts them to anyone already contacted).
 */
export async function rejectProposal(database: Db, proposalId: string, now: Date): Promise<{ ok: boolean; reason?: string }> {
  const [proposal] = await database.select().from(reshuffleProposals).where(eq(reshuffleProposals.id, proposalId)).limit(1)
  if (!proposal) return { ok: false, reason: 'proposal_not_found' }
  if (proposal.status !== 'pending' && proposal.status !== 'amended') {
    return { ok: false, reason: `not_decidable:${proposal.status}` }
  }

  await database.update(reshuffleProposals).set({ status: 'rejected', decidedAt: now }).where(eq(reshuffleProposals.id, proposalId))
  await database
    .update(reshuffleCampaigns)
    .set({ status: 'abandoned', resolvedAt: now })
    .where(eq(reshuffleCampaigns.id, proposal.campaignId))
  // Release still-active offers (the worker soft-retracts these to anyone contacted).
  await database
    .update(reshuffleOffers)
    .set({ status: 'expired' })
    .where(and(eq(reshuffleOffers.campaignId, proposal.campaignId), inArray(reshuffleOffers.status, ['probing', 'accepted', 'countered'])))

  return { ok: true }
}
