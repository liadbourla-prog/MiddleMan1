// Owner-triggered broadcast announcements (Tier 2; template catalog #19–21). The owner dictates
// one of three fixed-shape updates — opening hours, address, or a promo — and this runner fans it
// out to a customer segment (via the one segment reader, queryCustomerSegment) through the
// initiation spine. Each recipient passes the gate (promotional → opt-out + quiet hours + attention
// budget) and out of window falls back to the matching broadcast_* template ([business, detail]).
//
// A blast-radius breaker (mirroring cold-fill in waitlist.ts) caps one run and aborts on an
// opt-out/error spike, so a bad segment or a wrong detail can't quietly blast everyone. Meta won't
// approve a single free-text variable, hence three fixed-shape templates rather than one generic.

import { eq } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { businesses } from '../../db/schema.js'
import type { SegmentFilter } from '../../shared/skill-types.js'
import { type Lang } from '../i18n/t.js'
import { queryCustomerSegment } from '../crm/segment-repository.js'
import { generateProactiveCustomerMessage } from '../../adapters/llm/client.js'
import { sendMessage, sendTemplateMessage } from '../../adapters/whatsapp/sender.js'
import { bodyComponents } from '../../adapters/whatsapp/templates.js'
import { dispatchInitiation } from './dispatch.js'
import { getInitiator, type InitiatorId } from './registry.js'
import { resolveBlastBreaker, evaluateBlastBreaker, type BlastTally } from './blast-breaker.js'
import { logAudit } from '../audit/logger.js'

export type BroadcastKind = 'hours_change' | 'address_change' | 'promo'

const KIND_CONFIG: Record<BroadcastKind, {
  initiatorId: InitiatorId
  templateName: string
  // Free-form (in-window) phrasing + the Hebrew/English fallback mirroring the template copy.
  situation: (business: string, detail: string) => string
  fallback: (lang: Lang, business: string, detail: string) => string
}> = {
  hours_change: {
    initiatorId: 'broadcast.hours_change',
    templateName: 'broadcast_hours_change',
    situation: (b, d) => `Announce to the customer that ${b} has new opening hours: ${d}. Warm and brief, invite them to visit.`,
    fallback: (lang, b, d) => lang === 'he' ? `עדכון מ${b}: שעות הפעילות החדשות שלנו הן ${d}. נשמח לראותך!` : `Update from ${b}: our new opening hours are ${d}. We'd love to see you!`,
  },
  address_change: {
    initiatorId: 'broadcast.address_change',
    templateName: 'broadcast_address_change',
    situation: (b, d) => `Announce to the customer that ${b} has moved to a new address: ${d}. Warm and brief, say you look forward to seeing them.`,
    fallback: (lang, b, d) => lang === 'he' ? `עדכון מ${b}: עברנו! הכתובת החדשה שלנו: ${d}. מחכים לראותך 🙂` : `Update from ${b}: we've moved! Our new address: ${d}. Hope to see you 🙂`,
  },
  promo: {
    initiatorId: 'broadcast.promo',
    templateName: 'broadcast_promo',
    situation: (b, d) => `Announce a special offer from ${b}: ${d}. Upbeat and brief, invite them to take advantage.`,
    fallback: (lang, b, d) => lang === 'he' ? `מבצע מיוחד מ${b}! ${d} מהרו לנצל 🎉` : `Special offer from ${b}! ${d} Don't miss it 🎉`,
  },
}

export interface BroadcastResult {
  matched: number
  sent: number
  optOuts: number
  errors: number
  aborted: string | null
}

/**
 * Send one broadcast to a customer segment. Returns counts (and the abort verdict if the
 * blast-breaker tripped) so the caller can report honestly to the owner.
 */
export async function runBroadcast(db: Db, input: {
  businessId: string
  kind: BroadcastKind
  detail: string
  filter?: SegmentFilter
}): Promise<BroadcastResult> {
  const cfg = KIND_CONFIG[input.kind]

  const [biz] = await db
    .select({
      name: businesses.name,
      timezone: businesses.timezone,
      defaultLanguage: businesses.defaultLanguage,
      whatsappPhoneNumberId: businesses.whatsappPhoneNumberId,
      whatsappAccessToken: businesses.whatsappAccessToken,
    })
    .from(businesses)
    .where(eq(businesses.id, input.businessId))
    .limit(1)
  if (!biz) return { matched: 0, sent: 0, optOuts: 0, errors: 0, aborted: null }

  const lang: Lang = (biz.defaultLanguage as Lang | null | undefined) ?? 'he'
  const creds = biz.whatsappPhoneNumberId && biz.whatsappAccessToken
    ? { accessToken: biz.whatsappAccessToken, phoneNumberId: biz.whatsappPhoneNumberId }
    : undefined

  const summaries = await queryCustomerSegment(db, input.businessId, input.filter ?? {}, biz.timezone)

  const initiator = getInitiator(cfg.initiatorId)
  const breakerCfg = resolveBlastBreaker(initiator.blastBreaker)
  const tally: BlastTally = { sent: 0, optOuts: 0, errors: 0 }
  let aborted: string | null = null

  // Fresh id per run so a deliberately-repeated announcement is NOT deduped against a prior one,
  // while each recipient still gets exactly one send within this run.
  const broadcastId = Date.now().toString(36)

  const situation = cfg.situation(biz.name, input.detail)
  const fallback = cfg.fallback(lang, biz.name, input.detail)

  for (const s of summaries) {
    const verdict = evaluateBlastBreaker(tally, breakerCfg)
    if (verdict !== 'continue') { aborted = verdict; break }

    let sendFailed = false
    const decision = await dispatchInitiation(db, initiator, {
      businessId: input.businessId,
      recipientId: s.identityId,
      dedupKey: `${cfg.initiatorId}:${s.identityId}:${broadcastId}`,
    }, {
      sendFreeForm: async () => {
        const body = await generateProactiveCustomerMessage({ businessName: biz.name, language: lang, situation, fallback, timeoutMs: 2500 })
        try { await sendMessage({ toNumber: s.phoneNumber, body }, creds) }
        catch { sendFailed = true }
      },
      sendTemplate: async (templateName) => {
        try {
          await sendTemplateMessage({
            toNumber: s.phoneNumber,
            templateName,
            languageCode: lang === 'he' ? 'he' : 'en',
            components: bodyComponents([biz.name, input.detail]),
            bodyText: fallback,
            ...(creds !== undefined && { credentials: creds }),
          })
        } catch { sendFailed = true }
      },
    })

    if (decision.kind === 'skip' && decision.reason === 'opted_out') tally.optOuts++
    else if (sendFailed) tally.errors++
    else if (decision.kind !== 'skip') tally.sent++
  }

  await logAudit(db, {
    businessId: input.businessId,
    actorId: null,
    action: aborted ? 'broadcast.aborted' : 'broadcast.sent',
    entityType: 'initiation',
    metadata: { kind: input.kind, matched: summaries.length, tally, ...(aborted ? { verdict: aborted } : {}) },
  })

  return { matched: summaries.length, sent: tally.sent, optOuts: tally.optOuts, errors: tally.errors, aborted }
}
