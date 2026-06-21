import { Worker, Queue } from 'bullmq'
import { and, desc, eq, gt, gte, inArray, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { auditLog, identities, businesses } from '../db/schema.js'
import { sendMessage } from '../adapters/whatsapp/sender.js'
import { redisConnection } from '../redis.js'
import { logAudit } from '../domain/audit/logger.js'
import { i18n, type Lang } from '../domain/i18n/t.js'
import { generateProactiveCustomerMessage } from '../adapters/llm/client.js'

// Proactive customer-reply notification (see the proactive-notification design).
// When the manager has the PA reach out to a customer, executeMessageCustomer writes an
// `outreach.message_sent` audit row (actorId = the requester, entityId = the customer).
// That row is the outreach→requester linkage: "requester R is awaiting a reply from
// customer C since time T". When C next writes back (an inbound on Branch 4), this worker
// pings R on Branch 3 — once per outreach. The grounding contract (CHAT_LEVEL_LAWBOOK §7.4)
// is honoured: every outcome is written to audit_log, and `reply_notified` is recorded ONLY
// after a confirmed delivery, so a failed send is never reported as success.

const QUEUE_NAME = 'outreach-reply-notify'

// How long after an outreach an inbound from that customer still counts as "the reply".
// Long enough for a next-day reply, short enough that an unrelated message weeks later
// isn't misattributed. Env-overridable for ops tuning.
const REPLY_WINDOW_HOURS = parseInt(process.env['OUTREACH_REPLY_WINDOW_HOURS'] ?? '48', 10)
// A deferred notification (requester's WhatsApp window was closed) is flushed on their next
// inbound — but not if it has gone stale. Caps how old a deferral we will still deliver.
const DEFERRED_MAX_AGE_HOURS = parseInt(process.env['OUTREACH_DEFERRED_MAX_AGE_HOURS'] ?? '168', 10)

const REPLY_HANDLED_ACTIONS = ['outreach.reply_notified', 'outreach.reply_deferred'] as const

export const outreachReplyNotifyQueue = new Queue<OutreachReplyJob>(QUEUE_NAME, { connection: redisConnection })

interface NotifyJob {
  type: 'notify'
  businessId: string
  customerId: string
  // The id of the `outreach.message_sent` audit row this reply answers. Used as the BullMQ
  // jobId so several quick customer messages collapse into one notification.
  outreachRowId: string
  replyText: string
}
interface FlushJob {
  type: 'flush'
  businessId: string
  // The requester (manager / delegated_user) who just messaged the business — deliver any
  // notifications that were deferred because their WhatsApp window was previously closed.
  actorId: string
}
export type OutreachReplyJob = NotifyJob | FlushJob

// ── Pure decision helpers (DB-free, unit-tested) ──────────────────────────────

interface AuditRowLite {
  id: string
  entityId: string | null
  createdAt: Date
}

/**
 * Given a customer's `outreach.message_sent` rows and the `reply_notified`/`reply_deferred`
 * markers for that same customer, return the most recent outreach that (a) is still inside
 * the reply window and (b) has not already been handled by a marker written after it.
 * Returns null when there is nothing to notify about. Pure — the caller supplies `now`.
 */
export function pickPendingOutreach(
  sentRows: AuditRowLite[],
  handledRows: AuditRowLite[],
  now: Date,
  windowMs: number,
): AuditRowLite | null {
  const cutoff = now.getTime() - windowMs
  const latestSent = sentRows
    .filter((r) => r.createdAt.getTime() >= cutoff)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
  if (!latestSent) return null
  // Already handled if any marker was written at or after this outreach.
  const handled = handledRows.some((h) => h.createdAt.getTime() >= latestSent.createdAt.getTime())
  return handled ? null : latestSent
}

/**
 * From a requester's deferred notifications, return those still deliverable: not yet
 * superseded by a `reply_notified` for the same customer written after the deferral, and
 * not older than the staleness cap. Newest-first. Pure.
 */
export function filterDeliverableDeferrals(
  deferredRows: AuditRowLite[],
  notifiedRows: AuditRowLite[],
  now: Date,
  maxAgeMs: number,
): AuditRowLite[] {
  const minTime = now.getTime() - maxAgeMs
  return deferredRows
    .filter((d) => d.createdAt.getTime() >= minTime)
    .filter((d) => !notifiedRows.some(
      (n) => n.entityId === d.entityId && n.createdAt.getTime() > d.createdAt.getTime(),
    ))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
}

function truncate(s: string, max = 300): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

// ── Detection (called inline on the customer inbound hot path) ─────────────────

/**
 * Cheap indexed lookup: is THIS customer one the PA recently reached out to, whose reply
 * we have not yet relayed? Returns the matching `outreach.message_sent` row, or null. Run
 * inline in the customer flow to decide whether to enqueue a notification — keeps the hot
 * path to two indexed reads and moves the actual send off it.
 */
export async function findPendingOutreachForCustomer(
  businessId: string,
  customerId: string,
): Promise<{ id: string } | null> {
  const cutoff = new Date(Date.now() - REPLY_WINDOW_HOURS * 60 * 60_000)
  const sentRows = await db
    .select({ id: auditLog.id, entityId: auditLog.entityId, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(and(
      eq(auditLog.businessId, businessId),
      eq(auditLog.entityType, 'identity'),
      eq(auditLog.entityId, customerId),
      eq(auditLog.action, 'outreach.message_sent'),
      gte(auditLog.createdAt, cutoff),
    ))
    .orderBy(desc(auditLog.createdAt))
    .limit(1)
  const latestSent = sentRows[0]
  if (!latestSent) return null

  const handled = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(
      eq(auditLog.businessId, businessId),
      eq(auditLog.entityType, 'identity'),
      eq(auditLog.entityId, customerId),
      inArray(auditLog.action, REPLY_HANDLED_ACTIONS as unknown as string[]),
      gt(auditLog.createdAt, latestSent.createdAt),
    ))
    .limit(1)
  if (handled.length > 0) return null

  return { id: latestSent.id }
}

// ── Enqueue helpers ───────────────────────────────────────────────────────────

export async function enqueueOutreachReplyNotify(job: Omit<NotifyJob, 'type'>): Promise<void> {
  await outreachReplyNotifyQueue.add(
    'notify',
    { type: 'notify', ...job },
    // jobId keyed on the outreach row collapses concurrent replies to one notification.
    { attempts: 3, backoff: { type: 'fixed', delay: 10_000 }, jobId: `outreach-reply-${job.outreachRowId}` },
  )
}

export async function enqueueOutreachReplyFlush(businessId: string, actorId: string): Promise<void> {
  await outreachReplyNotifyQueue.add(
    'flush',
    { type: 'flush', businessId, actorId },
    // One in-flight flush per requester is enough; collapse rapid manager messages.
    { attempts: 2, backoff: { type: 'fixed', delay: 5_000 }, jobId: `outreach-flush-${actorId}` },
  )
}

// ── Shared send + record ──────────────────────────────────────────────────────

interface BizCtx {
  name: string
  defaultLanguage: string | null
  waCredentials: { accessToken: string; phoneNumberId: string } | undefined
}

async function loadBiz(businessId: string): Promise<BizCtx | null> {
  const [biz] = await db
    .select({
      name: businesses.name,
      defaultLanguage: businesses.defaultLanguage,
      whatsappPhoneNumberId: businesses.whatsappPhoneNumberId,
      whatsappAccessToken: businesses.whatsappAccessToken,
    })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)
  if (!biz) return null
  return {
    name: biz.name,
    defaultLanguage: biz.defaultLanguage,
    waCredentials: biz.whatsappPhoneNumberId && biz.whatsappAccessToken
      ? { accessToken: biz.whatsappAccessToken, phoneNumberId: biz.whatsappPhoneNumberId }
      : undefined,
  }
}

async function customerDisplay(customerId: string, lang: Lang): Promise<string> {
  const [cust] = await db
    .select({ displayName: identities.displayName, phoneNumber: identities.phoneNumber })
    .from(identities)
    .where(eq(identities.id, customerId))
    .limit(1)
  return cust?.displayName || cust?.phoneNumber || (lang === 'he' ? 'הלקוח' : 'the customer')
}

/**
 * Compose and send the manager-facing update, then record the outcome. Returns the audit
 * action that was written so the caller (notify vs flush) can branch on deferral.
 * Never writes `reply_notified` unless the send actually succeeded.
 */
async function deliverNotification(opts: {
  businessId: string
  actorId: string
  actorPhone: string
  customerId: string
  replyText: string
  biz: BizCtx
  lang: Lang
  // When true (the flush path) the requester just messaged, so the window is open and an
  // out-of-window result is unexpected — we record a hard failure rather than re-deferring.
  fromFlush: boolean
}): Promise<'reply_notified' | 'reply_deferred' | 'failed'> {
  const customerName = await customerDisplay(opts.customerId, opts.lang)
  const reply = truncate(opts.replyText)
  const fallback = i18n.outreach_reply_notify[opts.lang](customerName, reply)
  const situation = `A customer you reached out to, ${customerName}, has just replied: "${reply}". Let the manager know the customer wrote back, quote what they said, and offer to act on it (for example, book a time). Keep it short and natural; do not invent any detail beyond their reply.`

  const body = await generateProactiveCustomerMessage({
    businessName: opts.biz.name,
    language: opts.lang,
    situation,
    fallback,
    timeoutMs: 2500,
  })

  const res = await sendMessage({ toNumber: opts.actorPhone, body }, opts.biz.waCredentials)

  const record = (action: string, meta: Record<string, unknown>) =>
    logAudit(db, {
      businessId: opts.businessId,
      actorId: opts.actorId,
      action,
      entityType: 'identity',
      entityId: opts.customerId,
      metadata: { to: opts.actorPhone, replyText: reply, customerName, ...meta },
    }).catch(() => { /* ledger write is best-effort; never throw on it */ })

  if (res.ok) {
    await record('outreach.reply_notified', opts.fromFlush ? { deferred: true } : {})
    return 'reply_notified'
  }
  if (res.outsideWindow && !opts.fromFlush) {
    // Requester's WhatsApp window is closed — persist the reply so we can flush it the next
    // time they message. Marks the outreach handled so the customer messaging again won't
    // re-enqueue (we are now waiting on the requester, not the customer).
    await record('outreach.reply_deferred', {})
    return 'reply_deferred'
  }
  // Hard failure: write nothing so BullMQ retries can re-attempt and a later customer
  // message can re-enqueue. An undelivered notification is an explicit non-action.
  return 'failed'
}

/** Resolve who to notify: the outreach requester, falling back to the business manager. */
async function resolveRequester(businessId: string, actorId: string | null): Promise<
  { id: string; phoneNumber: string; preferredLanguage: string | null } | null
> {
  if (actorId) {
    const [actor] = await db
      .select({ id: identities.id, phoneNumber: identities.phoneNumber, preferredLanguage: identities.preferredLanguage, revokedAt: identities.revokedAt })
      .from(identities)
      .where(eq(identities.id, actorId))
      .limit(1)
    if (actor && !actor.revokedAt && actor.phoneNumber) {
      return { id: actor.id, phoneNumber: actor.phoneNumber, preferredLanguage: actor.preferredLanguage }
    }
  }
  const [manager] = await db
    .select({ id: identities.id, phoneNumber: identities.phoneNumber, preferredLanguage: identities.preferredLanguage })
    .from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.role, 'manager'), isNull(identities.revokedAt)))
    .limit(1)
  return manager ?? null
}

// ── Job processors ────────────────────────────────────────────────────────────

async function processNotify(job: NotifyJob): Promise<void> {
  const { businessId, customerId, replyText } = job

  // Re-check dedupe inside the worker: a prior job (or a flush) may have handled this
  // outreach since the job was enqueued.
  const pending = await findPendingOutreachForCustomer(businessId, customerId)
  if (!pending) return

  // The outreach row carries actorId (the requester). Read it to resolve who to notify.
  const [outreach] = await db
    .select({ actorId: auditLog.actorId })
    .from(auditLog)
    .where(eq(auditLog.id, job.outreachRowId))
    .limit(1)

  const biz = await loadBiz(businessId)
  if (!biz) return
  const requester = await resolveRequester(businessId, outreach?.actorId ?? null)
  if (!requester) return

  const lang: Lang = (requester.preferredLanguage as Lang | null)
    ?? (biz.defaultLanguage as Lang | null)
    ?? 'he'

  const outcome = await deliverNotification({
    businessId,
    actorId: requester.id,
    actorPhone: requester.phoneNumber,
    customerId,
    replyText,
    biz,
    lang,
    fromFlush: false,
  })
  if (outcome === 'failed') throw new Error('outreach-reply notification send failed')
}

async function processFlush(job: FlushJob): Promise<void> {
  const { businessId, actorId } = job
  const cutoff = new Date(Date.now() - DEFERRED_MAX_AGE_HOURS * 60 * 60_000)

  const deferredRows = await db
    .select({ id: auditLog.id, entityId: auditLog.entityId, createdAt: auditLog.createdAt, metadata: auditLog.metadata })
    .from(auditLog)
    .where(and(
      eq(auditLog.businessId, businessId),
      eq(auditLog.actorId, actorId),
      eq(auditLog.action, 'outreach.reply_deferred'),
      gte(auditLog.createdAt, cutoff),
    ))
    .orderBy(desc(auditLog.createdAt))
    .limit(20)
  if (deferredRows.length === 0) return

  const notifiedRows = await db
    .select({ id: auditLog.id, entityId: auditLog.entityId, createdAt: auditLog.createdAt })
    .from(auditLog)
    .where(and(
      eq(auditLog.businessId, businessId),
      eq(auditLog.actorId, actorId),
      eq(auditLog.action, 'outreach.reply_notified'),
    ))

  const deliverable = filterDeliverableDeferrals(
    deferredRows.map((r) => ({ id: r.id, entityId: r.entityId, createdAt: r.createdAt })),
    notifiedRows.map((r) => ({ id: r.id, entityId: r.entityId, createdAt: r.createdAt })),
    new Date(),
    DEFERRED_MAX_AGE_HOURS * 60 * 60_000,
  )
  if (deliverable.length === 0) return

  const biz = await loadBiz(businessId)
  if (!biz) return
  const requester = await resolveRequester(businessId, actorId)
  if (!requester) return
  const lang: Lang = (requester.preferredLanguage as Lang | null)
    ?? (biz.defaultLanguage as Lang | null)
    ?? 'he'

  const byId = new Map(deferredRows.map((r) => [r.id, r]))
  for (const d of deliverable) {
    if (!d.entityId) continue
    const meta = (byId.get(d.id)?.metadata as Record<string, unknown> | null) ?? {}
    const replyText = typeof meta['replyText'] === 'string' ? meta['replyText'] : ''
    await deliverNotification({
      businessId,
      actorId: requester.id,
      actorPhone: requester.phoneNumber,
      customerId: d.entityId,
      replyText,
      biz,
      lang,
      fromFlush: true,
    })
  }
}

async function processJob(job: { data: OutreachReplyJob }): Promise<void> {
  if (job.data.type === 'notify') return processNotify(job.data)
  return processFlush(job.data)
}

export function startOutreachReplyNotifyWorker() {
  const worker = new Worker<OutreachReplyJob>(
    QUEUE_NAME,
    async (job) => processJob(job),
    { connection: redisConnection, concurrency: 3 },
  )

  worker.on('failed', (job, err) => {
    console.error('[outreach-reply-notify] Job failed', { jobId: job?.id, err: err.message })
  })

  return worker
}
