// Proactive Reshuffle Engine — inbound reply routing.
//
// When a customer who has a live reshuffle offer replies, we interpret it (behind the
// deterministic guardrail — an ambiguous reply is never a yes), update the offer, and
// re-kick the campaign so the solver can try to close a cycle with the new edge.

import { and, desc, eq } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { reshuffleOffers, reshuffleCampaigns, businesses } from '../../db/schema.js'
import { interpretOutreachReply } from './outreach.js'
import { buildOutreachClassifier } from './interpret.js'
import { triggerReshuffleCampaign } from '../../workers/reshuffle-campaign.js'

type Db = typeof db

export interface ReshuffleReplyResult {
  handled: boolean
  /** A short acknowledgement to send back to the customer, when handled. */
  ack?: string
}

/**
 * If this customer has an outstanding reshuffle offer, interpret their reply and update it.
 * Returns `{ handled: false }` when there's no live offer (the normal flow should run).
 */
export async function handleReshuffleReply(database: Db, identityId: string, messageText: string, lang: 'he' | 'en'): Promise<ReshuffleReplyResult> {
  const [offer] = await database
    .select()
    .from(reshuffleOffers)
    .where(and(eq(reshuffleOffers.customerId, identityId), eq(reshuffleOffers.status, 'probing')))
    .orderBy(desc(reshuffleOffers.offeredAt))
    .limit(1)

  if (!offer) return { handled: false }

  // First-accepted-hold-wins / expiry safety: ignore an offer whose TTL has lapsed.
  if (offer.offerExpiresAt && offer.offerExpiresAt.getTime() < Date.now()) {
    await database.update(reshuffleOffers).set({ status: 'expired' }).where(eq(reshuffleOffers.id, offer.id))
    return { handled: false }
  }

  // Build the classifier for this offer: yes/no fast-path, then LLM counter-offer extraction
  // (Phase 7.2). Needs the business timezone for slot resolution + the offered slot's duration.
  const [biz] = await database
    .select({ timezone: businesses.timezone })
    .from(reshuffleCampaigns)
    .innerJoin(businesses, eq(reshuffleCampaigns.businessId, businesses.id))
    .where(eq(reshuffleCampaigns.id, offer.campaignId))
    .limit(1)
  const timezone = biz?.timezone ?? 'UTC'
  const durationMin = Math.max(1, Math.round((offer.proposedSlotEnd.getTime() - offer.proposedSlotStart.getTime()) / 60_000))
  const candidateSummary = offer.proposedSlotStart.toLocaleString(lang === 'he' ? 'he-IL' : 'en-GB', {
    timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const classify = buildOutreachClassifier({ durationMin, timezone, lang, candidateSummary })

  const verdict = await interpretOutreachReply(messageText, classify)

  if (verdict.verdict === 'unclear') {
    return {
      handled: true,
      ack: lang === 'he'
        ? 'רק שאוודא — האם זה מתאים לך? אפשר להשיב כן או לא 🙂'
        : "Just so I'm sure — does that work for you? A simple yes or no is perfect 🙂",
    }
  }

  if (verdict.verdict === 'no') {
    await database.update(reshuffleOffers).set({ status: 'declined' }).where(eq(reshuffleOffers.id, offer.id))
    await triggerReshuffleCampaign(offer.campaignId).catch(() => { /* next tick will retry */ })
    return {
      handled: true,
      ack: lang === 'he' ? 'תודה שהודעת! התור שלך נשאר כמו שהוא.' : 'Thanks for letting me know! Your appointment stays as is.',
    }
  }

  if (verdict.verdict === 'counter') {
    await database
      .update(reshuffleOffers)
      .set({ status: 'countered', counterSlotStart: new Date(verdict.counterSlot.start), counterSlotEnd: new Date(new Date(verdict.counterSlot.start).getTime() + verdict.counterSlot.durationMin * 60_000) })
      .where(eq(reshuffleOffers.id, offer.id))
    await triggerReshuffleCampaign(offer.campaignId).catch(() => {})
    return { handled: true, ack: lang === 'he' ? 'מעולה, אבדוק את זה ואחזור אליך.' : "Great — let me check that and get back to you." }
  }

  // verdict === 'yes'
  await database.update(reshuffleOffers).set({ status: 'accepted' }).where(eq(reshuffleOffers.id, offer.id))
  await triggerReshuffleCampaign(offer.campaignId).catch(() => {})
  return {
    handled: true,
    ack: lang === 'he' ? 'תודה רבה! אעדכן אותך ברגע שהכל מסודר.' : "Thank you! I'll confirm as soon as everything's arranged.",
  }
}
