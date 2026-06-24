// Dispatcher — the only I/O in the spine. Gathers facts, runs the pure gate, enforces
// idempotency via the unique (business_id, dedup_key) ledger, then executes the
// decision through caller-supplied executors. The worker keeps its own data-loading and
// phrasing; it hands a built context + executors here instead of doing the window fork,
// dedup, and send inline.

import { and, eq, gte } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { businesses, identities, initiationLog } from '../../db/schema.js'
import { canSendFreeForm } from '../../adapters/whatsapp/sender.js'
import { logAudit } from '../audit/logger.js'
import { runGate } from './gate.js'
import { isPromotionalSuppressed } from './consent.js'
import { isWithinQuietHours } from './quiet-hours.js'
import type { QuietHoursWindow } from './quiet-hours.js'
import { allocateBudget, DEFAULT_PROMOTIONAL_BUDGET, PROMOTIONAL_BUDGET_WINDOW_DAYS } from './budget.js'
import { INITIATORS } from './registry.js'
import type { InitiatorId } from './registry.js'
import type { Initiator, GateDecision } from './types.js'

export interface DispatchContext {
  businessId: string
  recipientId: string | null // identity id; null for phone-only operator sends
  dedupKey: string // stable for idempotent initiators (reminder), per-event for others (escalation)
  // Optional pre-gathered facts. Omitted facts get safe defaults; for customer/contact
  // audiences windowOpen is computed via canSendFreeForm when not supplied.
  windowOpen?: boolean
  recipientOptedOut?: boolean
  nowInQuietHours?: boolean // Phase 1: dispatcher does not yet compute tz quiet hours; defaults false
}

export interface Executors {
  sendFreeForm: () => Promise<void>
  sendTemplate?: (templateName: string) => Promise<void>
}

/**
 * Run an initiation end to end: gate → idempotency ledger → execute.
 * Returns the resolved decision (a `skip` with reason when not sent — including
 * `dedup_hit` when the ledger already held this dedupKey).
 */
export async function dispatchInitiation(
  db: Db,
  initiator: Initiator,
  ctx: DispatchContext,
  exec: Executors,
): Promise<GateDecision> {
  const isOutsideParty = initiator.audience === 'customer' || initiator.audience === 'contact'

  let windowOpen = ctx.windowOpen
  if (windowOpen === undefined) {
    windowOpen = isOutsideParty && ctx.recipientId ? await canSendFreeForm(ctx.recipientId) : true
  }

  // Consent is centralized here (Phase 5.1): for promotional outside-party sends, load the
  // recipient's two-tier opt-out state when the caller didn't pre-supply it. A caller that
  // pre-knows still wins (ctx.recipientOptedOut override). Transactional initiators skip the
  // load — the gate ignores recipientOptedOut for them anyway.
  let recipientOptedOut = ctx.recipientOptedOut
  if (
    recipientOptedOut === undefined &&
    initiator.consentClass === 'promotional' &&
    isOutsideParty &&
    ctx.recipientId
  ) {
    const [rec] = await db
      .select({ messagingOptOut: identities.messagingOptOut, promotionalOptOuts: identities.promotionalOptOuts })
      .from(identities)
      .where(eq(identities.id, ctx.recipientId))
      .limit(1)
    recipientOptedOut = isPromotionalSuppressed(
      rec?.messagingOptOut ?? false,
      (rec?.promotionalOptOuts as Record<string, boolean> | null) ?? null,
      initiator.category,
    )
  }

  // Quiet hours are likewise centralized here (Phase 5.2): for promotional outside-party sends,
  // compute nowInQuietHours from the business-level quiet_hours window + timezone when the caller
  // didn't pre-supply it. A caller that pre-computed still wins (ctx.nowInQuietHours override).
  // Transactional initiators skip the load — the gate ignores nowInQuietHours for them. null/absent
  // column → leave false (no suppression). Same guard as the consent load (don't double-load).
  let nowInQuietHours = ctx.nowInQuietHours
  if (
    nowInQuietHours === undefined &&
    initiator.consentClass === 'promotional' &&
    isOutsideParty
  ) {
    const [business] = await db
      .select({ timezone: businesses.timezone, quietHours: businesses.quietHours })
      .from(businesses)
      .where(eq(businesses.id, ctx.businessId))
      .limit(1)
    const window = business?.quietHours as QuietHoursWindow | null
    if (window) {
      nowInQuietHours = isWithinQuietHours(new Date(), business!.timezone, window)
    }
  }

  const decision = runGate({
    audience: initiator.audience,
    consentClass: initiator.consentClass,
    windowPolicy: initiator.windowPolicy,
    enabled: initiator.defaultEnabled,
    windowOpen,
    recipientOptedOut: recipientOptedOut ?? false,
    nowInQuietHours: nowInQuietHours ?? false,
  })

  if (decision.kind === 'skip') {
    await logAudit(db, {
      businessId: ctx.businessId,
      actorId: null,
      action: 'initiation.skipped',
      entityType: 'initiation',
      entityId: initiator.id,
      metadata: { dedupKey: ctx.dedupKey, reason: decision.reason },
    })
    return decision
  }

  // Attention budget (Phase 5.3, design §4.4): promotional sends compete for a rolling
  // per-customer budget. Count this recipient's promotional sends in the window from the
  // initiation_log (recipient index), then run the allocator with the current candidate. Over
  // budget → defer with a logged reason ("failure is explicit"); transactional sends are exempt.
  if (initiator.consentClass === 'promotional' && isOutsideParty && ctx.recipientId) {
    const windowStart = new Date(Date.now() - PROMOTIONAL_BUDGET_WINDOW_DAYS * 24 * 60 * 60_000)
    const recent = await db
      .select({ initiatorId: initiationLog.initiatorId })
      .from(initiationLog)
      .where(and(eq(initiationLog.recipientId, ctx.recipientId), gte(initiationLog.createdAt, windowStart)))
    const spent = recent.filter((r) => INITIATORS[r.initiatorId as InitiatorId]?.consentClass === 'promotional').length
    const [alloc] = allocateBudget(
      [{ id: initiator.id, priority: initiator.priority ?? 0, expValue: 1 }],
      spent,
      DEFAULT_PROMOTIONAL_BUDGET,
    )
    if (alloc && !alloc.admit) {
      await logAudit(db, {
        businessId: ctx.businessId,
        actorId: null,
        action: 'initiation.deferred',
        entityType: 'initiation',
        entityId: initiator.id,
        metadata: { dedupKey: ctx.dedupKey, reason: 'budget_exhausted', spent, budget: DEFAULT_PROMOTIONAL_BUDGET },
      })
      return { kind: 'skip', reason: 'budget_exhausted' }
    }
  }

  // Idempotency: the unique (business_id, dedup_key) index is the guard. Insert first;
  // zero rows back means this initiation already fired — do not send again.
  const inserted = await db
    .insert(initiationLog)
    .values({
      businessId: ctx.businessId,
      initiatorId: initiator.id,
      recipientId: ctx.recipientId,
      dedupKey: ctx.dedupKey,
      decision: decision.kind,
      audience: initiator.audience,
    })
    .onConflictDoNothing({ target: [initiationLog.businessId, initiationLog.dedupKey] })
    .returning({ id: initiationLog.id })

  if (inserted.length === 0) {
    await logAudit(db, {
      businessId: ctx.businessId,
      actorId: null,
      action: 'initiation.deduped',
      entityType: 'initiation',
      entityId: initiator.id,
      metadata: { dedupKey: ctx.dedupKey },
    })
    return { kind: 'skip', reason: 'dedup_hit' }
  }

  if (decision.kind === 'send_template' && exec.sendTemplate) {
    await exec.sendTemplate(decision.templateName)
  } else {
    await exec.sendFreeForm()
  }

  return decision
}
