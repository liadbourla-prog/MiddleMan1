// Proactive Reshuffle Engine — entry point.
//
// Opens a campaign when a customer asks to move onto a taken slot and the feature is on.
// Keeps the requester's original booking intact (deferred-cancel already guarantees this);
// the campaign only mutates bookings once an approved proposal is applied.

import { eq } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { businesses, reshuffleCampaigns } from '../../db/schema.js'
import { resolveReshuffleConfig, type ReshuffleConfig } from './config.js'
import { triggerReshuffleCampaign } from '../../workers/reshuffle-campaign.js'

type Db = typeof db

/** Whether the reshuffle engine is enabled for a business. */
export async function reshuffleEnabled(database: Db, businessId: string): Promise<ReshuffleConfig | null> {
  const [biz] = await database.select({ cfg: businesses.reshuffleConfig }).from(businesses).where(eq(businesses.id, businessId)).limit(1)
  if (!biz) return null
  const config = resolveReshuffleConfig(biz.cfg)
  return config.enabled ? config : null
}

export interface OpenCampaignInput {
  businessId: string
  requesterId: string
  requesterBookingId: string
  serviceTypeId: string
  targetSlotStart: Date
  targetSlotEnd: Date
}

/**
 * Create a `searching` campaign and kick off the worker. A campaign snapshots the config
 * in force so mid-flight owner edits don't corrupt an in-progress solve (invariant #8).
 * Returns the campaign id, or null if the feature is off.
 */
export async function openReshuffleCampaign(database: Db, input: OpenCampaignInput): Promise<string | null> {
  const config = await reshuffleEnabled(database, input.businessId)
  if (!config) return null

  const [campaign] = await database
    .insert(reshuffleCampaigns)
    .values({
      businessId: input.businessId,
      requesterId: input.requesterId,
      requesterBookingId: input.requesterBookingId,
      serviceTypeId: input.serviceTypeId,
      targetSlotStart: input.targetSlotStart,
      targetSlotEnd: input.targetSlotEnd,
      status: 'searching',
      configSnapshot: config as unknown as Record<string, unknown>,
    })
    .returning({ id: reshuffleCampaigns.id })

  if (!campaign) return null
  await triggerReshuffleCampaign(campaign.id).catch(() => { /* worker will be retried by next tick */ })
  return campaign.id
}
