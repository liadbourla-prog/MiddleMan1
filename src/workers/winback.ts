// Win-back detector — a periodic scan that finds lapsed customers and PROPOSES a
// re-engagement to the owner via the owner-confirm gate. It NEVER messages the customer
// directly (CLAUDE.md Principle 1; roadmap "Owner directive"): proposeInitiation records
// the proposal + asks the owner; the customer send fires only on owner approval inside
// resolveInitiationProposal.
//
// Thin I/O around two pure cores: the Phase-2 segment reader (cadence-relative lapse) and
// buildWinbackProposal (candidate + copy). Mirrors integrity-sentinel's worker shape:
// a Queue with a `repeat:{every}` tick, startWinbackWorker() + scheduleWinbackJob().

import { Worker, Queue } from 'bullmq'
import { and, eq, isNotNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { businesses } from '../db/schema.js'
import { redisConnection } from '../redis.js'
import { queryCustomerSegment } from '../domain/crm/segment-repository.js'
import { buildWinbackProposal } from '../domain/crm/winback.js'
import { proposeInitiation } from '../domain/initiations/approvals.js'
import { resolveAutonomy } from '../domain/initiations/autonomy.js'
import { runRatchet } from '../domain/initiations/ratchet-runner.js'
import { dispatchInitiation } from '../domain/initiations/dispatch.js'
import { getInitiator } from '../domain/initiations/registry.js'
import { generateProactiveCustomerMessage } from '../adapters/llm/client.js'
import { sendTemplateMessage } from '../adapters/whatsapp/sender.js'
import { bodyComponents } from '../adapters/whatsapp/templates.js'
import { enqueueMessage } from './message-retry.js'

const QUEUE_NAME = 'winback-detector'
const REPEAT_EVERY_MS = 24 * 60 * 60 * 1000 // daily — lapse is a slow signal

export const winbackQueue = new Queue(QUEUE_NAME, { connection: redisConnection })

/**
 * One tick: for every opted-in, live business, propose win-backs for its lapsed customers.
 * Returns the number of fresh proposals recorded. Per-business and per-customer work is
 * wrapped so one failure can't abort the tick.
 */
export async function runWinbackTick(): Promise<number> {
  // Opt-in + live only. proactiveWinbackEnabled defaults OFF → the owner enables it via the
  // Phase-5 control surface; until then no business is scanned.
  const targets = await db
    .select({
      id: businesses.id,
      name: businesses.name,
      timezone: businesses.timezone,
      defaultLanguage: businesses.defaultLanguage,
      whatsappPhoneNumberId: businesses.whatsappPhoneNumberId,
      whatsappAccessToken: businesses.whatsappAccessToken,
    })
    .from(businesses)
    .where(and(eq(businesses.proactiveWinbackEnabled, true), isNotNull(businesses.onboardingCompletedAt)))

  let proposed = 0
  for (const biz of targets) {
    try {
      // Trust ratchet: evaluate demote (and any pending promote) for this business's win-back
      // autonomy, then read the effective state to decide propose vs direct-send.
      await runRatchet(db, biz.id, 'winback').catch(() => {})
      const autonomy = await resolveAutonomy(db, biz.id, 'winback')

      const lapsed = await queryCustomerSegment(db, biz.id, { lapsed: true, hasBooking: true }, biz.timezone)
      const now = new Date()
      for (const summary of lapsed) {
        try {
          const proposal = buildWinbackProposal(summary, biz.name, biz.defaultLanguage, now)
          if (!proposal) continue
          if (autonomy.state === 'owner_configured') {
            // Promoted: the owner has delegated win-backs — send directly under the gate.
            const waCredentials = biz.whatsappPhoneNumberId && biz.whatsappAccessToken
              ? { accessToken: biz.whatsappAccessToken, phoneNumberId: biz.whatsappPhoneNumberId }
              : undefined
            const decision = await dispatchInitiation(db, getInitiator('churn.winback'), {
              businessId: biz.id,
              recipientId: summary.identityId,
              dedupKey: proposal.dedupKey,
            }, {
              sendFreeForm: async () => {
                const body = await generateProactiveCustomerMessage({ businessName: biz.name, language: biz.defaultLanguage, situation: proposal.situation, fallback: proposal.fallback, timeoutMs: 2500 })
                await enqueueMessage(biz.id, summary.phoneNumber, body)
              },
              sendTemplate: async () => {
                // Out-of-window: winback_reengage template — [business].
                await sendTemplateMessage({
                  toNumber: summary.phoneNumber,
                  templateName: 'winback_reengage',
                  languageCode: biz.defaultLanguage === 'he' ? 'he' : 'en',
                  components: bodyComponents([biz.name]),
                  bodyText: proposal.fallback,
                  ...(waCredentials !== undefined && { credentials: waCredentials }),
                }).catch(() => { /* retry queue handles transient failures */ })
              },
            })
            if (decision.kind !== 'skip') proposed++
          } else {
            const outcome = await proposeInitiation(db, {
              businessId: biz.id,
              initiatorId: 'churn.winback',
              recipientId: summary.identityId,
              recipientPhone: summary.phoneNumber,
              dedupKey: proposal.dedupKey,
              language: biz.defaultLanguage,
              situation: proposal.situation,
              fallback: proposal.fallback,
              ownerSummary: proposal.ownerSummary,
            })
            if (outcome === 'proposed') proposed++
          }
        } catch (err) {
          console.error('[winback] customer proposal failed', biz.id, summary.identityId, err)
        }
      }
    } catch (err) {
      console.error('[winback] business scan failed', biz.id, err)
    }
  }
  return proposed
}

export function startWinbackWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      const proposed = await runWinbackTick()
      if (proposed > 0) console.info(`[winback] proposed ${proposed} win-back(s) to owners`)
    },
    { connection: redisConnection },
  )
  worker.on('failed', (job, err) => {
    console.error('[winback] Job failed', { jobId: job?.id, err: err.message })
  })
  return worker
}

export async function scheduleWinbackJob() {
  await winbackQueue.add('tick', {}, { repeat: { every: REPEAT_EVERY_MS }, jobId: 'winback-tick' })
}
