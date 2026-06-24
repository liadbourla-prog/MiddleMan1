// Owner-confirm gate for ai_proposed initiations (Phase 6a; design §4.1/§5).
//
// An `ai_proposed` initiator (e.g. win-back of a lapsed customer) does NOT message the
// customer directly. It PROPOSES to the owner — who approves or declines — and the
// customer send fires only on approval. This is the freedSlotApprovals pattern lifted to
// proactive initiations: the PA never messages an outside party on its own judgement
// while an initiator is in probation (CLAUDE.md Principle 1; roadmap "Owner directive").
//
// Discipline (DEV_OPERATING_MODEL / coordination/state.ts): the genuinely-pure decision
// — "may a proposal in status X be resolved by decision Y?" — is the exported
// nextApprovalStatus guard, unit-tested as a truth table without a DB. proposeInitiation
// and resolveInitiationProposal are the thin I/O around it.

import { eq, and, isNull } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { initiationApprovals, initiationLog, identities, businesses } from '../../db/schema.js'
import type { InitiationApproval } from '../../db/schema.js'
import { canSendFreeForm, sendMessage, sendTemplateMessage } from '../../adapters/whatsapp/sender.js'
import { bodyComponents } from '../../adapters/whatsapp/templates.js'
import { generateProactiveCustomerMessage } from '../../adapters/llm/client.js'
import { enqueueMessage } from '../../workers/message-retry.js'
import { logAudit } from '../audit/logger.js'
import { getInitiator } from './registry.js'
import type { InitiatorId } from './registry.js'
import { runRatchet, categoryForInitiator } from './ratchet-runner.js'

const DEFAULT_EXPIRES_IN_HOURS = 72

export interface InitiationProposal {
  businessId: string
  initiatorId: string // e.g. 'churn.winback'
  recipientId: string
  recipientPhone: string
  dedupKey: string // e.g. 'churn.winback:{identityId}:{tier}'
  language: 'he' | 'en'
  situation: string // for LLM phrasing at SEND time (after approval)
  fallback: string
  ownerSummary: string // what the owner sees: "Dana hasn't visited in 14 days — send her a friendly check-in?"
  expiresInHours?: number // default 72
}

export type ProposeOutcome = 'proposed' | 'duplicate' | 'recipient_opted_out'

export type ResolveDecision = 'approve' | 'decline'

export type ApprovalStatus = InitiationApproval['status']

export interface ResolveResult {
  ok: boolean
  outcome: 'sent' | 'declined' | 'unreachable' | 'not_pending'
}

// ── Pure decision guard ───────────────────────────────────────────────────────
// Mirrors coordination/state.ts: a small pure function the I/O wraps, so the
// idempotency/validity rule is testable without a DB. Only a `pending` proposal can be
// resolved; any other status (already approved/declined/expired) is rejected — this is
// what makes resolveInitiationProposal idempotent under a double-tap.

export function nextApprovalStatus(
  current: ApprovalStatus,
  decision: ResolveDecision,
): { ok: true; next: 'approved' | 'declined' } | { ok: false } {
  if (current !== 'pending') return { ok: false }
  return { ok: true, next: decision === 'approve' ? 'approved' : 'declined' }
}

// ── Propose: detector → owner ─────────────────────────────────────────────────

/**
 * Record a proposed initiation and notify the owner. Returns:
 *  - 'recipient_opted_out' — the recipient opted out of messaging; nothing proposed.
 *  - 'duplicate'           — a proposal with this (business, dedupKey) already exists;
 *                            the owner is NOT re-nagged.
 *  - 'proposed'            — fresh proposal recorded + owner notified.
 *
 * No customer message is sent here — only the owner is asked. The send happens later in
 * resolveInitiationProposal on approval.
 */
export async function proposeInitiation(db: Db, proposal: InitiationProposal): Promise<ProposeOutcome> {
  // Never propose sending to someone who opted out of messaging.
  const [recipient] = await db
    .select({ messagingOptOut: identities.messagingOptOut })
    .from(identities)
    .where(eq(identities.id, proposal.recipientId))
    .limit(1)
  if (recipient?.messagingOptOut) return 'recipient_opted_out'

  const expiresInHours = proposal.expiresInHours ?? DEFAULT_EXPIRES_IN_HOURS
  const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60_000)

  // Idempotency: the unique (business_id, dedup_key) index is the guard. Insert first;
  // zero rows back means we already proposed this — never re-nag the owner.
  const inserted = await db
    .insert(initiationApprovals)
    .values({
      businessId: proposal.businessId,
      initiatorId: proposal.initiatorId,
      recipientId: proposal.recipientId,
      recipientPhone: proposal.recipientPhone,
      dedupKey: proposal.dedupKey,
      language: proposal.language,
      situation: proposal.situation,
      fallback: proposal.fallback,
      ownerSummary: proposal.ownerSummary,
      expiresAt,
    })
    .onConflictDoNothing({ target: [initiationApprovals.businessId, initiationApprovals.dedupKey] })
    .returning({ id: initiationApprovals.id })

  if (inserted.length === 0) return 'duplicate'

  // Notify the owner (the manager on their PA number). Non-fatal — a notify hiccup must
  // not unwind a recorded proposal.
  const [manager] = await db
    .select({ phoneNumber: identities.phoneNumber })
    .from(identities)
    .where(and(eq(identities.businessId, proposal.businessId), eq(identities.role, 'manager'), isNull(identities.revokedAt)))
    .limit(1)
  if (manager) {
    await enqueueMessage(manager.phoneNumber, proposal.ownerSummary).catch(() => {})
  }

  await logAudit(db, {
    businessId: proposal.businessId,
    actorId: null,
    action: 'initiation.proposed',
    entityType: 'initiation_approval',
    entityId: inserted[0]!.id,
    metadata: { initiatorId: proposal.initiatorId, dedupKey: proposal.dedupKey },
  })

  return 'proposed'
}

// ── Resolve: owner approves / declines ────────────────────────────────────────

/**
 * Apply the owner's decision to a pending proposal. Idempotent: a non-pending proposal
 * yields { ok:false, outcome:'not_pending' } (mirrors how coordination guards the owner
 * confirm to valid statuses), so a double-tap can't double-send.
 *
 * On approve, the send is owner-authorised. It fires only if the customer is inside the
 * 24h window (no ai_proposed template exists yet); out of window we record the approval
 * but report 'unreachable' so the owner knows it couldn't be delivered now.
 *
 * Designed to be called cleanly by the Branch-3 orchestrator approve/decline tool.
 */
export async function resolveInitiationProposal(
  db: Db,
  approvalId: string,
  decision: ResolveDecision,
): Promise<ResolveResult> {
  const [approval] = await db
    .select()
    .from(initiationApprovals)
    .where(eq(initiationApprovals.id, approvalId))
    .limit(1)

  if (!approval) return { ok: false, outcome: 'not_pending' }

  const guard = nextApprovalStatus(approval.status, decision)
  if (!guard.ok) return { ok: false, outcome: 'not_pending' }

  const now = new Date()

  if (decision === 'decline') {
    await db
      .update(initiationApprovals)
      .set({ status: 'declined', decidedAt: now })
      .where(eq(initiationApprovals.id, approvalId))
    await logAudit(db, {
      businessId: approval.businessId,
      actorId: null,
      action: 'initiation.declined',
      entityType: 'initiation_approval',
      entityId: approvalId,
      metadata: { initiatorId: approval.initiatorId, dedupKey: approval.dedupKey },
    })
    const cat = categoryForInitiator(approval.initiatorId)
    if (cat) await runRatchet(db, approval.businessId, cat).catch(() => {})
    return { ok: true, outcome: 'declined' }
  }

  // ── approve ──
  // The send is now owner-approved. Load the business (name + WA credentials) up front — needed
  // for both the in-window free-form send and the out-of-window template fallback.
  const [biz] = await db
    .select({
      name: businesses.name,
      whatsappPhoneNumberId: businesses.whatsappPhoneNumberId,
      whatsappAccessToken: businesses.whatsappAccessToken,
    })
    .from(businesses)
    .where(eq(businesses.id, approval.businessId))
    .limit(1)

  const businessName = biz?.name ?? ''
  const creds = biz?.whatsappPhoneNumberId && biz?.whatsappAccessToken
    ? { accessToken: biz.whatsappAccessToken, phoneNumberId: biz.whatsappPhoneNumberId }
    : undefined
  const cat = categoryForInitiator(approval.initiatorId)
  const inWindow = approval.recipientId ? await canSendFreeForm(approval.recipientId) : false

  // Out of window: only an approved template can be delivered. The only ai_proposed templated
  // initiator today is churn.winback (winback_reengage, params [business]); a future ai_proposed
  // initiator with different params would need a per-initiator param resolver here.
  if (!inWindow) {
    const windowPolicy = getInitiator(approval.initiatorId as InitiatorId)?.windowPolicy
    const templateName = windowPolicy && windowPolicy !== 'skip' ? windowPolicy.templateName : null

    if (!templateName) {
      // No template → record approval but report unreachable (owner knows it couldn't send now).
      await db
        .update(initiationApprovals)
        .set({ status: 'approved', decidedAt: now })
        .where(eq(initiationApprovals.id, approvalId))
      await logAudit(db, {
        businessId: approval.businessId,
        actorId: null,
        action: 'initiation.approved_unreachable',
        entityType: 'initiation_approval',
        entityId: approvalId,
        metadata: { initiatorId: approval.initiatorId, dedupKey: approval.dedupKey },
      })
      if (cat) await runRatchet(db, approval.businessId, cat).catch(() => {})
      return { ok: true, outcome: 'unreachable' }
    }

    await sendTemplateMessage({
      toNumber: approval.recipientPhone,
      templateName,
      languageCode: approval.language === 'en' ? 'en' : 'he',
      components: bodyComponents([businessName]),
      bodyText: approval.fallback,
      ...(creds !== undefined && { credentials: creds }),
    }).catch(() => {})

    await db
      .insert(initiationLog)
      .values({
        businessId: approval.businessId,
        initiatorId: approval.initiatorId,
        recipientId: approval.recipientId,
        dedupKey: approval.dedupKey,
        decision: 'send_template',
        audience: 'customer',
      })
      .onConflictDoNothing({ target: [initiationLog.businessId, initiationLog.dedupKey] })
    await db
      .update(initiationApprovals)
      .set({ status: 'approved', decidedAt: now })
      .where(eq(initiationApprovals.id, approvalId))
    await logAudit(db, {
      businessId: approval.businessId,
      actorId: null,
      action: 'initiation.approved_sent',
      entityType: 'initiation_approval',
      entityId: approvalId,
      metadata: { initiatorId: approval.initiatorId, dedupKey: approval.dedupKey, template: templateName },
    })
    if (cat) await runRatchet(db, approval.businessId, cat).catch(() => {})
    return { ok: true, outcome: 'sent' }
  }

  // In-window: phrase + send free-form.
  const body = await generateProactiveCustomerMessage({
    businessName,
    language: approval.language === 'en' ? 'en' : 'he',
    situation: approval.situation,
    fallback: approval.fallback,
    timeoutMs: 2500,
  })

  await sendMessage({ toNumber: approval.recipientPhone, body }, creds).catch(() => {})

  // Record the actual send in the initiation ledger (idempotent via dedup index).
  await db
    .insert(initiationLog)
    .values({
      businessId: approval.businessId,
      initiatorId: approval.initiatorId,
      recipientId: approval.recipientId,
      dedupKey: approval.dedupKey,
      decision: 'send_free_form',
      audience: 'customer',
    })
    .onConflictDoNothing({ target: [initiationLog.businessId, initiationLog.dedupKey] })

  await db
    .update(initiationApprovals)
    .set({ status: 'approved', decidedAt: now })
    .where(eq(initiationApprovals.id, approvalId))

  await logAudit(db, {
    businessId: approval.businessId,
    actorId: null,
    action: 'initiation.approved_sent',
    entityType: 'initiation_approval',
    entityId: approvalId,
    metadata: { initiatorId: approval.initiatorId, dedupKey: approval.dedupKey },
  })

  if (cat) await runRatchet(db, approval.businessId, cat).catch(() => {})

  return { ok: true, outcome: 'sent' }
}
