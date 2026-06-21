import { Worker, Queue } from 'bullmq'
import { and, eq, gte, lte, or, isNotNull } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  businesses,
  bookings,
  serviceTypes,
  calendarBlocks,
  reminders,
  integrityFindings,
  identities,
  type Business,
} from '../db/schema.js'
import { createCalendarClient } from '../adapters/calendar/client.js'
import { logAudit } from '../domain/audit/logger.js'
import { enqueueMessage } from './message-retry.js'
import { enqueueBlockMirror, enqueueBookingMirror } from './calendar-mirror.js'
import { redisConnection } from '../redis.js'
import { type Lang } from '../domain/i18n/t.js'
import {
  runIntegrityChecks,
  type IntegrityFinding,
  type IntegritySnapshot,
} from '../domain/audit/integrity.js'

const QUEUE_NAME = 'integrity-sentinel'
const REPEAT_EVERY_MS = 2 * 60 * 60 * 1000 // every 2 hours (WS-B)
const WINDOW_BACK_MS = 24 * 60 * 60 * 1000
const WINDOW_FWD_MS = 90 * 24 * 60 * 60 * 1000
const HOLD_GRACE_MS = parseInt(process.env['HOLD_GRACE_PERIOD_SECONDS'] ?? '60', 10) * 1000
// INV-9 grace: how long an internal record may lack a Google event id before the
// Sentinel treats the outbound mirror as not-yet-landed. Generous enough that a healthy
// async mirror (seconds, with retries) is never flagged; tight enough to catch a silently
// dropped/failed write well inside a 2h tick.
const UNMIRROR_GRACE_MS = parseInt(process.env['UNMIRROR_GRACE_MINUTES'] ?? '15', 10) * 60_000
const QUARANTINE_REASON = 'integrity_quarantine'

export const integritySentinelQueue = new Queue(QUEUE_NAME, { connection: redisConnection })

const ACTIVE_STATES = ['held', 'pending_payment', 'confirmed'] as const

// ── Snapshot loading ──────────────────────────────────────────────────────────

async function loadSnapshot(business: Business, now: Date): Promise<IntegritySnapshot> {
  const from = new Date(now.getTime() - WINDOW_BACK_MS)
  const to = new Date(now.getTime() + WINDOW_FWD_MS)

  const bookingRows = await db
    .select({
      id: bookings.id,
      serviceTypeId: bookings.serviceTypeId,
      slotStart: bookings.slotStart,
      slotEnd: bookings.slotEnd,
      state: bookings.state,
      calendarEventId: bookings.calendarEventId,
      rescheduledFrom: bookings.rescheduledFrom,
      holdExpiresAt: bookings.holdExpiresAt,
      createdAt: bookings.createdAt,
      maxParticipants: serviceTypes.maxParticipants,
    })
    .from(bookings)
    .innerJoin(serviceTypes, eq(bookings.serviceTypeId, serviceTypes.id))
    .where(
      and(
        eq(bookings.businessId, business.id),
        gte(bookings.slotStart, from),
        lte(bookings.slotStart, to),
      ),
    )

  const blockRows = await db
    .select({ googleEventId: calendarBlocks.googleEventId })
    .from(calendarBlocks)
    .where(and(eq(calendarBlocks.businessId, business.id), isNotNull(calendarBlocks.googleEventId)))

  // INV-9 (unmirrored): all blocks in window, INCLUDING those with a null googleEventId —
  // those are the ones whose outbound mirror may not have landed yet.
  const unmirroredBlockRows = await db
    .select({
      id: calendarBlocks.id,
      startTs: calendarBlocks.startTs,
      endTs: calendarBlocks.endTs,
      createdAt: calendarBlocks.createdAt,
      googleEventId: calendarBlocks.googleEventId,
      source: calendarBlocks.source,
    })
    .from(calendarBlocks)
    .where(and(eq(calendarBlocks.businessId, business.id), gte(calendarBlocks.startTs, from), lte(calendarBlocks.startTs, to)))

  // Pending reminders for this business's bookings (sentAt null) — join to scope by business.
  const reminderRows = await db
    .select({ id: reminders.id, bookingId: reminders.bookingId, sentAt: reminders.sentAt })
    .from(reminders)
    .innerJoin(bookings, eq(reminders.bookingId, bookings.id))
    .where(eq(bookings.businessId, business.id))

  const googleMode = business.calendarMode === 'google' && !!business.googleRefreshToken
  let googleEvents: IntegritySnapshot['googleEvents'] = []
  if (googleMode) {
    try {
      const calendar = createCalendarClient({
        accessToken: '',
        refreshToken: business.googleRefreshToken!,
        calendarId: business.googleCalendarId,
        businessId: business.id,
        calendarMode: 'google',
      })
      const listed = await calendar.listEvents(from, to)
      googleEvents = listed.map((e) => ({ id: e.eventId, start: e.start, end: e.end }))
    } catch (err) {
      // Fail open: a Google read error must not produce false ghost/orphan findings.
      // Skip the Google-dependent invariants this run by reporting no events AND no mode.
      console.warn('[integrity-sentinel] listEvents failed; skipping Google invariants', err)
      return buildSnapshot(now, false, bookingRows, [], blockRows, unmirroredBlockRows, reminderRows)
    }
  }

  return buildSnapshot(now, googleMode, bookingRows, googleEvents, blockRows, unmirroredBlockRows, reminderRows)
}

function buildSnapshot(
  now: Date,
  googleMode: boolean,
  bookingRows: Array<{ id: string; serviceTypeId: string; slotStart: Date; slotEnd: Date; state: string; calendarEventId: string | null; rescheduledFrom: string | null; holdExpiresAt: Date | null; createdAt: Date; maxParticipants: number }>,
  googleEvents: IntegritySnapshot['googleEvents'],
  blockRows: Array<{ googleEventId: string | null }>,
  unmirroredBlockRows: Array<{ id: string; startTs: Date; endTs: Date; createdAt: Date; googleEventId: string | null; source: string }>,
  reminderRows: Array<{ id: string; bookingId: string; sentAt: Date | null }>,
): IntegritySnapshot {
  return {
    now,
    googleMode,
    bookings: bookingRows.map((b) => ({
      id: b.id,
      serviceTypeId: b.serviceTypeId,
      slotStart: b.slotStart,
      slotEnd: b.slotEnd,
      state: b.state,
      calendarEventId: b.calendarEventId,
      rescheduledFrom: b.rescheduledFrom,
      holdExpiresAt: b.holdExpiresAt,
      createdAt: b.createdAt,
      isGroup: (b.maxParticipants ?? 1) > 1,
    })),
    googleEvents,
    knownBlockEventIds: blockRows.map((r) => r.googleEventId).filter((x): x is string => !!x),
    blocks: unmirroredBlockRows.map((b) => ({
      id: b.id,
      start: b.startTs,
      end: b.endTs,
      createdAt: b.createdAt,
      googleEventId: b.googleEventId,
      source: b.source,
    })),
    unmirrorGraceMs: UNMIRROR_GRACE_MS,
    reminders: reminderRows,
    holdGraceMs: HOLD_GRACE_MS,
  }
}

// ── INV-4 (out_of_hours / break) — worker-side, needs DB blocks ───────────────
// A booking that overlaps an owner block ('block' or 'personal'), excluding our own
// quarantine blocks and class container blocks. This catches "booked into a break /
// personal time" (F6) added after the booking existed.
async function checkOutOfHours(business: Business, now: Date): Promise<IntegrityFinding[]> {
  const from = new Date(now.getTime() - WINDOW_BACK_MS)
  const to = new Date(now.getTime() + WINDOW_FWD_MS)

  const blocks = await db
    .select({ id: calendarBlocks.id, startTs: calendarBlocks.startTs, endTs: calendarBlocks.endTs, type: calendarBlocks.type, reason: calendarBlocks.reason })
    .from(calendarBlocks)
    .where(
      and(
        eq(calendarBlocks.businessId, business.id),
        or(eq(calendarBlocks.type, 'block'), eq(calendarBlocks.type, 'personal')),
        lte(calendarBlocks.startTs, to),
        gte(calendarBlocks.endTs, from),
      ),
    )
  const ownerBlocks = blocks.filter((b) => b.reason !== QUARANTINE_REASON)
  if (ownerBlocks.length === 0) return []

  const activeBookings = await db
    .select({ id: bookings.id, slotStart: bookings.slotStart, slotEnd: bookings.slotEnd, maxParticipants: serviceTypes.maxParticipants })
    .from(bookings)
    .innerJoin(serviceTypes, eq(bookings.serviceTypeId, serviceTypes.id))
    .where(
      and(
        eq(bookings.businessId, business.id),
        or(...ACTIVE_STATES.map((s) => eq(bookings.state, s))),
        gte(bookings.slotStart, from),
        lte(bookings.slotStart, to),
      ),
    )

  const findings: IntegrityFinding[] = []
  for (const bk of activeBookings) {
    if ((bk.maxParticipants ?? 1) > 1) continue // group bookings legitimately sit in a class block
    const hit = ownerBlocks.find((blk) => bk.slotStart < blk.endTs && blk.startTs < bk.slotEnd)
    if (hit) {
      findings.push({
        kind: 'out_of_hours',
        severity: 'critical',
        dedupKey: `out_of_hours:${bk.id}:${hit.id}`,
        bookingId: bk.id,
        slotStart: bk.slotStart,
        detail: { bookingId: bk.id, blockId: hit.id, blockType: hit.type },
        autoRemediable: false,
      })
    }
  }
  return findings
}

// ── Reconcile + act ───────────────────────────────────────────────────────────

/**
 * Run all invariants for one business, reconcile against open findings (dedup),
 * auto-remediate the safe ones, quarantine live collisions, and alert on new critical
 * findings. Exported so the on-demand "is everything correct?" tool can refresh too.
 * Returns the open findings after the run.
 */
export async function runSentinelForBusiness(businessId: string): Promise<typeof integrityFindings.$inferSelect[]> {
  const now = new Date()
  const [business] = await db.select().from(businesses).where(eq(businesses.id, businessId)).limit(1)
  if (!business) return []

  const snapshot = await loadSnapshot(business, now)
  const detected = [...runIntegrityChecks(snapshot), ...(await checkOutOfHours(business, now))]

  // INV-9 self-heal: re-enqueue the outbound mirror for anything still unmirrored. The
  // mirror queue dedups by jobId, so re-enqueueing every tick is safe and idempotent —
  // it recovers a write that was dropped or never enqueued (the live-incident shape). The
  // internal record is already authoritative; this only catches Google up. A mirror that
  // keeps failing exhausts its retries and triggers the owner divergence alert separately.
  for (const f of detected) {
    if (f.kind !== 'unmirrored') continue
    const entity = f.detail['entity']
    const entityId = f.detail['entityId']
    if (typeof entityId !== 'string') continue
    if (entity === 'block') await enqueueBlockMirror(businessId, entityId).catch(() => { /* best-effort */ })
    else if (entity === 'booking') await enqueueBookingMirror(businessId, entityId).catch(() => { /* best-effort */ })
  }

  const existingOpen = await db
    .select()
    .from(integrityFindings)
    .where(and(eq(integrityFindings.businessId, businessId), eq(integrityFindings.status, 'open')))

  const detectedKeys = new Set(detected.map((f) => f.dedupKey))
  const existingByKey = new Map(existingOpen.map((f) => [f.dedupKey, f]))

  // 1. New + recurring findings.
  for (const f of detected) {
    const existing = existingByKey.get(f.dedupKey)
    if (existing) {
      await db.update(integrityFindings).set({ lastSeenAt: now }).where(eq(integrityFindings.id, existing.id))
      continue
    }
    await onNewFinding(business, f, now)
  }

  // 2. Findings that are gone → resolved (remove any quarantine, log).
  for (const old of existingOpen) {
    if (detectedKeys.has(old.dedupKey)) continue
    await resolveFinding(old, now)
  }

  return db
    .select()
    .from(integrityFindings)
    .where(and(eq(integrityFindings.businessId, businessId), eq(integrityFindings.status, 'open')))
}

async function onNewFinding(business: Business, f: IntegrityFinding, now: Date): Promise<void> {
  let quarantineBlockId: string | null = null

  // Quarantine a live collision: block NEW bookings into the contested slot. The booking
  // engine's spatial guard already refuses overlaps with 'block' calendar_blocks, so this
  // needs no engine change. Not mirrored to Google — it's an internal safety hold.
  if (f.quarantineSlot) {
    const [blk] = await db
      .insert(calendarBlocks)
      .values({
        businessId: business.id,
        type: 'block',
        startTs: f.quarantineSlot.start,
        endTs: f.quarantineSlot.end,
        title: '⚠ Integrity hold',
        reason: QUARANTINE_REASON,
        source: 'internal',
      })
      .returning({ id: calendarBlocks.id })
    quarantineBlockId = blk?.id ?? null
  }

  // Auto-remediate the safe ones.
  let autoRemediated = false
  if (f.autoRemediable) {
    autoRemediated = await autoRemediate(f, now)
  }

  const [inserted] = await db
    .insert(integrityFindings)
    .values({
      businessId: business.id,
      kind: f.kind,
      severity: f.severity,
      status: 'open',
      dedupKey: f.dedupKey,
      ...(f.bookingId ? { bookingId: f.bookingId } : {}),
      ...(f.slotStart ? { slotStart: f.slotStart } : {}),
      detail: f.detail,
      autoRemediated,
      quarantineBlockId,
      firstSeenAt: now,
      lastSeenAt: now,
    })
    .returning({ id: integrityFindings.id })

  await logAudit(db, {
    businessId: business.id,
    actorId: null,
    action: `integrity.${f.kind}`,
    entityType: 'integrity_finding',
    ...(inserted ? { entityId: inserted.id } : {}),
    metadata: { severity: f.severity, autoRemediated, quarantined: !!quarantineBlockId, detail: f.detail },
  }).catch(() => { /* best-effort */ })

  // Alert: critical findings go to owner + operator immediately. Auto-remediated
  // warnings are silent (already fixed); other warnings are recorded but not pushed.
  if (f.severity === 'critical') {
    await alertFinding(business, f).catch(() => { /* best-effort */ })
    if (inserted) {
      await db.update(integrityFindings).set({ notifiedAt: now }).where(eq(integrityFindings.id, inserted.id))
    }
  }
}

async function autoRemediate(f: IntegrityFinding, now: Date): Promise<boolean> {
  try {
    if (f.kind === 'stuck_hold' && f.bookingId) {
      await db.update(bookings).set({ state: 'expired', holdExpiresAt: null, updatedAt: now }).where(eq(bookings.id, f.bookingId))
      return true
    }
    if (f.kind === 'reminder_orphan') {
      const reminderId = f.detail['reminderId']
      if (typeof reminderId === 'string') {
        await db.delete(reminders).where(eq(reminders.id, reminderId))
        return true
      }
    }
  } catch (err) {
    console.warn('[integrity-sentinel] auto-remediate failed', f.kind, err)
  }
  return false
}

async function resolveFinding(old: typeof integrityFindings.$inferSelect, now: Date): Promise<void> {
  if (old.quarantineBlockId) {
    await db.delete(calendarBlocks).where(eq(calendarBlocks.id, old.quarantineBlockId)).catch(() => { /* best-effort */ })
  }
  await db
    .update(integrityFindings)
    .set({ status: 'resolved', resolvedAt: now })
    .where(eq(integrityFindings.id, old.id))
}

// ── Alerting ──────────────────────────────────────────────────────────────────

function describeFinding(f: IntegrityFinding, lang: Lang, businessName: string): string {
  const en: Record<string, string> = {
    double_book: 'two bookings overlap the same time',
    ghost: 'a confirmed booking is missing from Google Calendar',
    orphan: 'a Google Calendar event collides with a booking',
    time_mismatch: "a booking's time no longer matches Google Calendar",
    reschedule_residue: 'a reschedule left two active bookings',
    out_of_hours: 'a booking sits inside a break / blocked time',
    unmirrored: 'an event saved here has not synced to Google Calendar yet',
  }
  const he: Record<string, string> = {
    double_book: 'שתי הזמנות חופפות באותו זמן',
    ghost: 'הזמנה מאושרת חסרה ב-Google Calendar',
    orphan: 'אירוע ב-Google Calendar מתנגש עם הזמנה',
    time_mismatch: 'זמן ההזמנה כבר לא תואם ל-Google Calendar',
    reschedule_residue: 'שינוי תור השאיר שתי הזמנות פעילות',
    out_of_hours: 'הזמנה נמצאת בתוך הפסקה / זמן חסום',
    unmirrored: 'אירוע שנשמר כאן עדיין לא סונכרן ל-Google Calendar',
  }
  const desc = (lang === 'he' ? he : en)[f.kind] ?? f.kind
  return lang === 'he'
    ? `⚠️ בעיית יומן ב-${businessName}: ${desc}. בדקו בהקדם.`
    : `⚠️ Calendar issue at ${businessName}: ${desc}. Please check it soon.`
}

async function alertFinding(business: Business, f: IntegrityFinding): Promise<void> {
  const lang: Lang = (business.defaultLanguage as Lang | null | undefined) ?? 'he'

  // Owner (manager), in business language.
  const [manager] = await db
    .select({ phoneNumber: identities.phoneNumber })
    .from(identities)
    .where(and(eq(identities.businessId, business.id), eq(identities.role, 'manager')))
    .limit(1)
  if (manager) {
    await enqueueMessage(manager.phoneNumber, describeFinding(f, lang, business.name)).catch(() => { /* non-fatal */ })
  }

  // Operator (platform), in English with the technical detail.
  const operatorPhone = process.env['OPERATOR_PHONE']
  if (operatorPhone) {
    const body = [
      `🛡️ *Integrity finding* (${f.severity})`,
      `Business: ${business.name} (${business.whatsappNumber})`,
      `Kind: ${f.kind}`,
      `Detail: ${JSON.stringify(f.detail)}`,
    ].join('\n')
    await enqueueMessage(operatorPhone, body).catch(() => { /* non-fatal */ })
  }
}

// ── Worker lifecycle ──────────────────────────────────────────────────────────

export async function runSentinelTick(): Promise<number> {
  // Live businesses only (onboarding complete). Paused businesses still get audited —
  // a paused PA can still have stale state worth catching.
  const live = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(isNotNull(businesses.onboardingCompletedAt))

  let total = 0
  for (const b of live) {
    try {
      const open = await runSentinelForBusiness(b.id)
      total += open.length
    } catch (err) {
      console.error('[integrity-sentinel] business run failed', b.id, err)
    }
  }
  return total
}

export function startIntegritySentinelWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      const open = await runSentinelTick()
      if (open > 0) console.info(`[integrity-sentinel] ${open} open finding(s) across businesses`)
    },
    { connection: redisConnection },
  )
  worker.on('failed', (job, err) => {
    console.error('[integrity-sentinel] Job failed', { jobId: job?.id, err: err.message })
  })
  return worker
}

export async function scheduleIntegritySentinelJob() {
  await integritySentinelQueue.add(
    'tick',
    {},
    { repeat: { every: REPEAT_EVERY_MS }, jobId: 'integrity-sentinel-tick' },
  )
}
