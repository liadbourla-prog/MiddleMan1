import { Worker, Queue, type Job } from 'bullmq'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import { bookings, businesses, calendarBlocks, identities, serviceTypes } from '../db/schema.js'
import { createCalendarClient } from '../adapters/calendar/client.js'
import type { MirrorEventInput } from '../adapters/calendar/types.js'
import { redisConnection } from '../redis.js'
import { enqueueMessage } from './message-retry.js'
import { logAudit } from '../domain/audit/logger.js'
import { i18n, type Lang } from '../domain/i18n/t.js'

// ── Durable outbound mirror (Phase 2) ──────────────────────────────────────────
// Single durable path that write-throughs PA-managed entities into Google
// Calendar. Confirmed bookings + calendar_blocks only — never holds (decision 8).
// Linkage (googleEventId/googleEtag) is stamped back onto the source row so
// inbound sync (Phase 3) can detect our own echoes via etag compare.

const QUEUE_NAME = 'calendar-mirror'
const MAX_ATTEMPTS = 5

export interface CalendarMirrorJob {
  businessId: string
  op: 'upsert' | 'delete'
  entity: 'booking' | 'block'
  entityId: string
  // Required for deletes (the source row is already gone when we delete in Google).
  googleEventId?: string
}

export const calendarMirrorQueue = new Queue<CalendarMirrorJob>(QUEUE_NAME, { connection: redisConnection })

function jobOptions(job: CalendarMirrorJob) {
  return {
    jobId: `${job.entity}:${job.entityId}:${job.op}`,
    attempts: MAX_ATTEMPTS,
    backoff: { type: 'exponential' as const, delay: 5_000 },
    removeOnComplete: true,
    // Keep failed jobs so a divergence can be inspected and replayed.
    removeOnFail: false,
  }
}

/** Enqueue an outbound mirror of a calendar_blocks row (upsert). */
export async function enqueueBlockMirror(businessId: string, blockId: string): Promise<void> {
  const job: CalendarMirrorJob = { businessId, op: 'upsert', entity: 'block', entityId: blockId }
  await calendarMirrorQueue.add('mirror', job, jobOptions(job)).catch(() => { /* non-fatal: reconcile will catch up */ })
}

/** Enqueue deletion of a block's mirrored Google event (call before/after deleting the row). */
export async function enqueueBlockDeletion(businessId: string, blockId: string, googleEventId: string): Promise<void> {
  if (!googleEventId || googleEventId.startsWith('internal:')) return
  const job: CalendarMirrorJob = { businessId, op: 'delete', entity: 'block', entityId: blockId, googleEventId }
  await calendarMirrorQueue.add('mirror', job, jobOptions(job)).catch(() => { /* non-fatal */ })
}

/** Enqueue an outbound mirror of a confirmed booking (upsert). */
export async function enqueueBookingMirror(businessId: string, bookingId: string): Promise<void> {
  const job: CalendarMirrorJob = { businessId, op: 'upsert', entity: 'booking', entityId: bookingId }
  await calendarMirrorQueue.add('mirror', job, jobOptions(job)).catch(() => { /* non-fatal */ })
}

/** Enqueue deletion of a booking's mirrored Google event. */
export async function enqueueBookingDeletion(businessId: string, bookingId: string, googleEventId: string): Promise<void> {
  if (!googleEventId || googleEventId.startsWith('internal:')) return
  const job: CalendarMirrorJob = { businessId, op: 'delete', entity: 'booking', entityId: bookingId, googleEventId }
  await calendarMirrorQueue.add('mirror', job, jobOptions(job)).catch(() => { /* non-fatal */ })
}

interface MirrorContext {
  calendarId: string
  refreshToken: string
  managerPhone?: string
  lang: Lang
  timezone: string
}

async function loadMirrorContext(businessId: string): Promise<MirrorContext | null> {
  const [business] = await db.select().from(businesses).where(eq(businesses.id, businessId)).limit(1)
  if (!business) return null
  // Nothing to mirror unless the business runs in Google mode with a live token.
  if (business.calendarMode !== 'google' || !business.googleRefreshToken) return null

  const [manager] = await db
    .select({ phoneNumber: identities.phoneNumber })
    .from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.role, 'manager'), isNull(identities.revokedAt)))
    .limit(1)

  return {
    calendarId: business.googleCalendarId,
    refreshToken: business.googleRefreshToken,
    ...(manager ? { managerPhone: manager.phoneNumber } : {}),
    lang: (business.defaultLanguage as Lang | null | undefined) ?? 'he',
    timezone: business.timezone ?? 'UTC',
  }
}

async function processBlockUpsert(ctx: MirrorContext, businessId: string, blockId: string): Promise<void> {
  const [block] = await db.select().from(calendarBlocks).where(
    and(eq(calendarBlocks.id, blockId), eq(calendarBlocks.businessId, businessId)),
  ).limit(1)
  // Row gone (deleted) — nothing to mirror; a separate delete job handles removal.
  if (!block) return
  // Owner-imported blocks originate in Google — never mirror them back out.
  if (block.source === 'google_import') return
  // Internal-only off-limits time (Issue 3): enforced for customers but deliberately
  // invisible in the owner's Google calendar — never push it out.
  if (!block.mirrorToGoogle) return

  let colorId: number | null = null
  if (block.type === 'class' && block.serviceTypeId) {
    const [svc] = await db.select({ colorId: serviceTypes.colorId }).from(serviceTypes)
      .where(eq(serviceTypes.id, block.serviceTypeId)).limit(1)
    colorId = svc?.colorId ?? null
  }

  const summary = block.title ?? (block.type === 'class' ? 'Class' : block.type === 'personal' ? 'Personal' : 'Blocked')
  const input: MirrorEventInput = {
    ...(block.googleEventId ? { googleEventId: block.googleEventId } : {}),
    summary,
    ...(block.reason ? { description: block.reason } : {}),
    start: block.startTs,
    end: block.endTs,
    colorId,
    privateProps: { paType: block.type, paId: block.id },
  }

  const calendar = createCalendarClient({
    accessToken: '', refreshToken: ctx.refreshToken, calendarId: ctx.calendarId,
    calendarMode: 'google', ...(ctx.managerPhone ? { managerPhoneNumber: ctx.managerPhone } : {}), lang: ctx.lang,
  })
  const result = await calendar.upsertMirrorEvent(input)
  if (result.status === 'error') throw new Error(`block mirror failed: ${result.reason}`)

  await db.update(calendarBlocks)
    .set({ googleEventId: result.eventId, googleEtag: result.etag, updatedAt: new Date() })
    .where(eq(calendarBlocks.id, block.id))
}

async function processBookingUpsert(ctx: MirrorContext, businessId: string, bookingId: string): Promise<void> {
  const [booking] = await db.select().from(bookings).where(
    and(eq(bookings.id, bookingId), eq(bookings.businessId, businessId)),
  ).limit(1)
  if (!booking) return
  // Decision 8: mirror confirmed bookings only — never holds/pending.
  if (booking.state !== 'confirmed') return

  const [svc] = await db.select({ name: serviceTypes.name, colorId: serviceTypes.colorId })
    .from(serviceTypes).where(eq(serviceTypes.id, booking.serviceTypeId)).limit(1)
  const [customer] = await db.select({ displayName: identities.displayName })
    .from(identities).where(eq(identities.id, booking.customerId)).limit(1)

  const summary = svc?.name ?? 'Appointment'
  const existingId = booking.calendarEventId && !booking.calendarEventId.startsWith('internal:')
    ? booking.calendarEventId
    : null

  const input: MirrorEventInput = {
    ...(existingId ? { googleEventId: existingId } : {}),
    summary,
    description: customer?.displayName ? `Booking — ${customer.displayName}` : 'Confirmed booking',
    start: booking.slotStart,
    end: booking.slotEnd,
    colorId: svc?.colorId ?? null,
    privateProps: { paType: 'booking', paId: booking.id },
  }

  const calendar = createCalendarClient({
    accessToken: '', refreshToken: ctx.refreshToken, calendarId: ctx.calendarId,
    calendarMode: 'google', ...(ctx.managerPhone ? { managerPhoneNumber: ctx.managerPhone } : {}), lang: ctx.lang,
  })
  const result = await calendar.upsertMirrorEvent(input)
  if (result.status === 'error') throw new Error(`booking mirror failed: ${result.reason}`)

  await db.update(bookings)
    .set({ calendarEventId: result.eventId, googleEtag: result.etag, updatedAt: new Date() })
    .where(eq(bookings.id, booking.id))
}

async function processDeletion(ctx: MirrorContext, googleEventId: string): Promise<void> {
  const calendar = createCalendarClient({
    accessToken: '', refreshToken: ctx.refreshToken, calendarId: ctx.calendarId,
    calendarMode: 'google', ...(ctx.managerPhone ? { managerPhoneNumber: ctx.managerPhone } : {}), lang: ctx.lang,
  })
  const result = await calendar.deleteEvent(googleEventId)
  // not_found is success for our purposes — the event is gone either way.
  if (result.status === 'error') throw new Error(`mirror delete failed: ${result.reason}`)
}

export async function processCalendarMirrorJob(job: Job<CalendarMirrorJob>): Promise<void> {
  const { businessId, op, entity, entityId, googleEventId } = job.data
  const ctx = await loadMirrorContext(businessId)
  if (!ctx) return // internal mode or disconnected — nothing to mirror

  if (op === 'delete') {
    if (googleEventId) await processDeletion(ctx, googleEventId)
    return
  }
  if (entity === 'block') return processBlockUpsert(ctx, businessId, entityId)
  return processBookingUpsert(ctx, businessId, entityId)
}

// Notify the manager when a mirror job exhausts all retries — the internal record
// is authoritative, but their Google view has fallen behind (divergence alert).
async function alertDivergence(jobData: CalendarMirrorJob, errMsg: string): Promise<void> {
  try {
    const ctx = await loadMirrorContext(jobData.businessId)
    if (!ctx?.managerPhone) return
    const body = i18n.calendar_mirror_divergence[ctx.lang]
    await enqueueMessage(jobData.businessId, ctx.managerPhone, body).catch(() => { /* non-fatal */ })
    await logAudit(db, {
      businessId: jobData.businessId,
      actorId: null,
      action: 'calendar.mirror_divergence',
      entityType: jobData.entity,
      entityId: jobData.entityId,
      metadata: { op: jobData.op, error: errMsg },
    })
  } catch {
    /* alerting is best-effort */
  }
}

export function startCalendarMirrorWorker() {
  const worker = new Worker<CalendarMirrorJob>(
    QUEUE_NAME,
    async (job) => processCalendarMirrorJob(job),
    { connection: redisConnection },
  )

  worker.on('failed', (job, err) => {
    console.error('[calendar-mirror] Job failed', { jobId: job?.id, attempt: job?.attemptsMade, err: err.message })
    if (job && job.attemptsMade >= MAX_ATTEMPTS) {
      void alertDivergence(job.data, err.message)
    }
  })

  return worker
}
