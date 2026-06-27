// Trust-ratchet runner (Phase 6.2; design §5) — the thin I/O orchestration around the pure
// evaluateRatchet. No new decisions live here: it gathers the owner-decision track record + the
// recent opt-out signal, runs the pure ratchet, persists any promote/demote transition, and
// notifies the owner. Imports registry/ratchet/autonomy only (NOT approvals) — approvals.ts
// imports THIS module, so the dependency is one-way (no cycle).

import { eq, and, inArray, gte, isNull } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { initiationApprovals, initiationLog, identities, businesses } from '../../db/schema.js'
import { INITIATORS, type InitiatorId } from './registry.js'
import type { Initiator } from './types.js'
import { evaluateRatchet, DEFAULT_RATCHET, type AutonomyState, type RatchetHistory, type RecentSends } from './ratchet.js'
import { resolveAutonomy, setAutonomyState } from './autonomy.js'
import { isPromotionalSuppressed } from './consent.js'
import { enqueueMessage } from '../../workers/message-retry.js'
import { logAudit } from '../audit/logger.js'

const RECENT_SEND_WINDOW_DAYS = 30

/** The registry initiator ids belonging to a consent/ratchet category. */
function initiatorIdsForCategory(category: string): string[] {
  return (Object.values(INITIATORS) as Initiator[]).filter((i) => i.category === category).map((i) => i.id)
}

/** The category for an initiator id (or null if it has none / is unknown). */
export function categoryForInitiator(initiatorId: string): string | null {
  return (INITIATORS[initiatorId as InitiatorId] as Initiator | undefined)?.category ?? null
}

/**
 * Evaluate + apply the trust ratchet for one (business, category): gather the owner-decision
 * track record (from initiation_approvals) and, when already promoted, the recent opt-out signal
 * (from initiation_log + identities), run the pure ratchet, persist any promote/demote, and notify
 * the owner. Returns the effective autonomy state after any transition. Non-fatal on notify hiccups.
 */
export async function runRatchet(db: Db, businessId: string, category: string): Promise<AutonomyState> {
  const ids = initiatorIdsForCategory(category)
  if (ids.length === 0) return 'ai_proposed'

  const current = await resolveAutonomy(db, businessId, category)

  // Track record: approved vs declined proposals for this category.
  const decisions = await db
    .select({ status: initiationApprovals.status })
    .from(initiationApprovals)
    .where(and(eq(initiationApprovals.businessId, businessId), inArray(initiationApprovals.initiatorId, ids)))
  const history: RatchetHistory = {
    approved: decisions.filter((d) => d.status === 'approved').length,
    declined: decisions.filter((d) => d.status === 'declined').length,
  }

  // Recent-send opt-out signal — only needed (and only meaningful) once promoted.
  let recentSends: RecentSends = { total: 0, optOuts: 0 }
  if (current.state === 'owner_configured') {
    const since = new Date(Date.now() - RECENT_SEND_WINDOW_DAYS * 24 * 60 * 60_000)
    const sends = await db
      .select({ recipientId: initiationLog.recipientId })
      .from(initiationLog)
      .where(and(eq(initiationLog.businessId, businessId), inArray(initiationLog.initiatorId, ids), gte(initiationLog.createdAt, since)))
    const recipientIds = [...new Set(sends.map((s) => s.recipientId).filter((v): v is string => v != null))]
    let optOuts = 0
    if (recipientIds.length > 0) {
      const recips = await db
        .select({ messagingOptOut: identities.messagingOptOut, promotionalOptOuts: identities.promotionalOptOuts })
        .from(identities)
        .where(inArray(identities.id, recipientIds))
      optOuts = recips.filter((r) => isPromotionalSuppressed(r.messagingOptOut, (r.promotionalOptOuts as Record<string, boolean> | null) ?? null, category)).length
    }
    recentSends = { total: sends.length, optOuts }
  }

  const verdict = evaluateRatchet(current.state, current.vetoed, history, recentSends, DEFAULT_RATCHET)
  if (verdict === 'hold') return current.state

  const nextState: AutonomyState = verdict === 'promote' ? 'owner_configured' : 'ai_proposed'
  await setAutonomyState(db, businessId, category, nextState)

  await logAudit(db, {
    businessId, actorId: null,
    action: verdict === 'promote' ? 'initiation.autonomy_promoted' : 'initiation.autonomy_demoted',
    entityType: 'initiation_autonomy', entityId: category,
    metadata: { category, history, recentSends },
  })

  // Notify the owner (non-fatal). Promotion offers a veto; demotion explains the fall-back.
  try {
    const [biz] = await db.select({ name: businesses.name, defaultLanguage: businesses.defaultLanguage }).from(businesses).where(eq(businesses.id, businessId)).limit(1)
    const [manager] = await db.select({ phoneNumber: identities.phoneNumber }).from(identities)
      .where(and(eq(identities.businessId, businessId), eq(identities.role, 'manager'), isNull(identities.revokedAt))).limit(1)
    if (biz && manager) {
      const he = biz.defaultLanguage === 'he'
      const msg = verdict === 'promote'
        ? (he
            ? `למדתי איך את/ה נוהג/ת עם הפניות מסוג "${category}" — מעכשיו אטפל בהן אוטומטית ואסמן רק חריגים. אם תעדיף/י שאמשיך לשאול כל פעם, פשוט כתבו לי.`
            : `I've learned how you handle "${category}" outreach — I'll take care of these automatically now and only flag the unusual ones. If you'd rather I keep asking each time, just tell me.`)
        : (he
            ? `שמתי לב לכמה ביטולי הסכמה בפניות "${category}", אז חזרתי לשאול אותך לפני כל אחת — ליתר ביטחון.`
            : `I noticed a few opt-outs on "${category}" outreach, so I've gone back to asking you before each one — just to be safe.`)
      await enqueueMessage(businessId, manager.phoneNumber, msg).catch(() => {})
    }
  } catch { /* notify is best-effort */ }

  return nextState
}
