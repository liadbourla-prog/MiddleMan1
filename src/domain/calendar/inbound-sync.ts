import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { db } from '../../db/client.js'
import {
  bookings,
  businesses,
  calendarBlocks,
  calendarSyncChannels,
  identities,
  type Business,
} from '../../db/schema.js'
import { createCalendarClient } from '../../adapters/calendar/client.js'
import type { RawCalendarEvent } from '../../adapters/calendar/types.js'
import { enqueueMessage } from '../../workers/message-retry.js'
import { notifyBusinessBookingChange } from '../initiations/booking-notify.js'
import { logAudit } from '../audit/logger.js'
import { i18n, type Lang } from '../i18n/t.js'

// ── Inbound sync (Phase 3) ──────────────────────────────────────────────────────
// Ingests owner-originated Google Calendar changes back into the internal record
// (internal-as-hub; CALENDAR_UX_DESIGN.md §2 & §6 Phase 3). The guarantee is a
// periodic full reconcile; push notifications are an optimization. Loop/echo
// prevention is by etag compare. Owner-created events become opaque busy-blocks
// (source='google_import'); owner deletions of PA-managed bookings trigger an
// owner-wins reconcile behind a blast-radius gate.
//
// The entire subsystem is feature-flagged OFF until the ops prerequisites land
// (Google domain verification + public HTTPS webhook callback). When disabled
// every entry point is a safe no-op.

const WATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000 // Google caps event channels at ~1 week
const FULL_RECONCILE_FORWARD_MS = 90 * 24 * 60 * 60 * 1000 // reconcile window: now → +90d
const BLAST_RADIUS_THRESHOLD = 2 // >this many affected bookings ⇒ ask before cancelling

/** True only when ops has provisioned the public callback and flipped the flag. */
export function isInboundSyncEnabled(): boolean {
  const v = process.env['CALENDAR_INBOUND_SYNC_ENABLED']
  return v === '1' || v === 'true'
}

/** The public HTTPS address Google posts change notifications to. Ops-provided. */
function webhookAddress(): string | null {
  return process.env['CALENDAR_WEBHOOK_ADDRESS'] ?? null
}

interface SyncContext {
  business: Business
  calendarId: string
  refreshToken: string
  managerPhone: string | null
  lang: Lang
}

function buildCalendar(ctx: SyncContext) {
  return createCalendarClient({
    accessToken: '',
    refreshToken: ctx.refreshToken,
    calendarId: ctx.calendarId,
    businessId: ctx.business.id,
    calendarMode: 'google',
    ...(ctx.managerPhone ? { managerPhoneNumber: ctx.managerPhone } : {}),
    lang: ctx.lang,
  })
}

async function loadSyncContext(businessId: string): Promise<SyncContext | null> {
  const [business] = await db.select().from(businesses).where(eq(businesses.id, businessId)).limit(1)
  if (!business) return null
  if (business.calendarMode !== 'google' || !business.googleRefreshToken) return null

  const [manager] = await db
    .select({ phoneNumber: identities.phoneNumber })
    .from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.role, 'manager')))
    .limit(1)

  return {
    business,
    calendarId: business.googleCalendarId,
    refreshToken: business.googleRefreshToken,
    managerPhone: manager?.phoneNumber ?? null,
    lang: (business.defaultLanguage as Lang | null | undefined) ?? 'he',
  }
}

// ── Watch-channel lifecycle ──────────────────────────────────────────────────

/**
 * Register (or refresh) the Google push channel for a business and seed the
 * initial syncToken via a full reconcile. Idempotent: a fresh channelId is
 * generated each call and the prior channel (if any) is stopped first.
 */
export async function registerWatchChannel(businessId: string): Promise<{ ok: boolean; reason?: string }> {
  if (!isInboundSyncEnabled()) return { ok: false, reason: 'inbound sync disabled' }
  const address = webhookAddress()
  if (!address) return { ok: false, reason: 'CALENDAR_WEBHOOK_ADDRESS not configured' }

  const ctx = await loadSyncContext(businessId)
  if (!ctx) return { ok: false, reason: 'business not in connected Google mode' }

  const calendar = buildCalendar(ctx)

  // Stop any existing channel before opening a new one (avoid duplicate pushes).
  const [existing] = await db
    .select()
    .from(calendarSyncChannels)
    .where(eq(calendarSyncChannels.businessId, businessId))
    .limit(1)
  if (existing?.channelId && existing.resourceId) {
    await calendar.stopChannel(existing.channelId, existing.resourceId).catch(() => { /* best effort */ })
  }

  const channelId = randomUUID()
  const channelToken = randomUUID()
  const watch = await calendar.watchEvents(channelId, address, channelToken, WATCH_TTL_MS)
  if (watch.status === 'error') return { ok: false, reason: watch.reason }

  const now = new Date()
  const row = {
    businessId,
    calendarId: ctx.calendarId,
    channelId,
    resourceId: watch.resourceId,
    channelToken,
    channelExpiration: watch.expiration,
    status: 'active' as const,
    lastError: null,
    updatedAt: now,
  }
  if (existing) {
    await db.update(calendarSyncChannels).set(row).where(eq(calendarSyncChannels.businessId, businessId))
  } else {
    await db.insert(calendarSyncChannels).values(row)
  }

  // Seed the syncToken with an initial full reconcile so the first push has a cursor.
  await runInboundSync(businessId, { full: true }).catch(() => { /* non-fatal: cron retries */ })

  await logAudit(db, {
    businessId,
    actorId: null,
    action: 'calendar.watch_registered',
    entityType: 'business',
    entityId: businessId,
    metadata: { channelId, expiration: watch.expiration?.toISOString() ?? null },
  })
  return { ok: true }
}

/** Stop the active push channel for a business (e.g. on disconnect). */
export async function unregisterWatchChannel(businessId: string): Promise<void> {
  const ctx = await loadSyncContext(businessId)
  const [existing] = await db
    .select()
    .from(calendarSyncChannels)
    .where(eq(calendarSyncChannels.businessId, businessId))
    .limit(1)
  if (ctx && existing?.channelId && existing.resourceId) {
    const calendar = buildCalendar(ctx)
    await calendar.stopChannel(existing.channelId, existing.resourceId).catch(() => { /* best effort */ })
  }
  if (existing) {
    await db
      .update(calendarSyncChannels)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(eq(calendarSyncChannels.businessId, businessId))
  }
}

// ── Incremental sync + reconcile ─────────────────────────────────────────────

/**
 * Pull changes from Google and reconcile them into the internal record. Uses the
 * stored syncToken for an incremental pull; falls back to a windowed full
 * reconcile when there is no token, when `opts.full` is set, or when Google
 * reports the token expired (410).
 */
export async function runInboundSync(businessId: string, opts: { full?: boolean } = {}): Promise<{ ok: boolean; reason?: string }> {
  if (!isInboundSyncEnabled()) return { ok: false, reason: 'inbound sync disabled' }
  const ctx = await loadSyncContext(businessId)
  if (!ctx) return { ok: false, reason: 'business not in connected Google mode' }

  const [channel] = await db
    .select()
    .from(calendarSyncChannels)
    .where(eq(calendarSyncChannels.businessId, businessId))
    .limit(1)

  const calendar = buildCalendar(ctx)
  const useToken = !opts.full && channel?.syncToken ? channel.syncToken : null

  const now = new Date()
  let result = await calendar.incrementalSync(
    useToken
      ? { syncToken: useToken }
      : { timeMin: now, timeMax: new Date(now.getTime() + FULL_RECONCILE_FORWARD_MS) },
  )

  // Expired token ⇒ re-run as a full reconcile (the real guarantee).
  if (result.status === 'expired') {
    result = await calendar.incrementalSync({
      timeMin: now,
      timeMax: new Date(now.getTime() + FULL_RECONCILE_FORWARD_MS),
    })
  }

  if (result.status === 'error') {
    await db
      .update(calendarSyncChannels)
      .set({ status: 'error', lastError: result.reason, updatedAt: new Date() })
      .where(eq(calendarSyncChannels.businessId, businessId))
    return { ok: false, reason: result.reason }
  }
  if (result.status === 'expired') {
    return { ok: false, reason: 'sync token expired and full reconcile also failed' }
  }

  const ownerCancellations: AffectedBooking[] = []
  for (const ev of result.events) {
    if (!ev.eventId) continue
    if (ev.paManaged) {
      const affected = await reconcileManagedEvent(ctx, ev)
      if (affected) ownerCancellations.push(affected)
    } else {
      await reconcileOwnerEvent(ctx, ev)
    }
  }

  // Apply the owner-wins reconcile for cancelled PA bookings, behind the gate.
  if (ownerCancellations.length > 0) {
    await applyOwnerCancellations(ctx, ownerCancellations)
  }

  await db
    .update(calendarSyncChannels)
    .set({
      syncToken: result.nextSyncToken ?? channel?.syncToken ?? null,
      lastSyncAt: new Date(),
      status: 'active',
      lastError: null,
      updatedAt: new Date(),
    })
    .where(eq(calendarSyncChannels.businessId, businessId))

  return { ok: true }
}

interface AffectedBooking {
  bookingId: string
  customerId: string
  serviceTypeId: string | null
  slotStart: Date
}

/**
 * Reconcile a PA-managed Google event (our own echo or an owner edit of it).
 *  - etag unchanged ⇒ pure echo of our write, ignore (loop prevention).
 *  - cancelled/deleted booking event ⇒ owner-wins cancellation candidate (returned
 *    to the caller for blast-radius gating).
 *  - cancelled/deleted block event ⇒ delete the internal block directly (no
 *    customer impact, low stakes).
 *  - other edits (e.g. time move) ⇒ out of scope for v1; stamp the new etag so we
 *    don't reprocess, and leave the internal record authoritative.
 */
async function reconcileManagedEvent(ctx: SyncContext, ev: RawCalendarEvent): Promise<AffectedBooking | null> {
  const businessId = ctx.business.id
  const cancelled = ev.status === 'cancelled'

  if (ev.paType === 'booking') {
    const bookingId = ev.paId
    if (!bookingId) return null
    const [booking] = await db
      .select({ id: bookings.id, customerId: bookings.customerId, serviceTypeId: bookings.serviceTypeId, slotStart: bookings.slotStart, state: bookings.state, googleEtag: bookings.googleEtag })
      .from(bookings)
      .where(and(eq(bookings.id, bookingId), eq(bookings.businessId, businessId)))
      .limit(1)
    if (!booking) return null
    // Echo of our own write — identical etag means nothing changed on Google's side.
    if (!cancelled && ev.etag && booking.googleEtag && ev.etag === booking.googleEtag) return null
    if (cancelled && (booking.state === 'confirmed' || booking.state === 'held' || booking.state === 'pending_payment')) {
      return { bookingId: booking.id, customerId: booking.customerId, serviceTypeId: booking.serviceTypeId, slotStart: booking.slotStart }
    }
    return null
  }

  // PA-managed block (block/personal/class). Owner deletion ⇒ remove internally.
  if (ev.paId && cancelled) {
    await db
      .delete(calendarBlocks)
      .where(and(eq(calendarBlocks.id, ev.paId), eq(calendarBlocks.businessId, businessId)))
    await logAudit(db, {
      businessId,
      actorId: null,
      action: 'calendar.owner_deleted_block',
      entityType: 'calendar_block',
      entityId: ev.paId,
      metadata: { googleEventId: ev.eventId },
    })
  }
  return null
}

/**
 * Reconcile an owner-created Google event into an opaque internal busy-block.
 * We never surface the owner's title (privacy — personal-calendar leak). A
 * cancelled/deleted owner event removes the imported block.
 */
async function reconcileOwnerEvent(ctx: SyncContext, ev: RawCalendarEvent): Promise<void> {
  const businessId = ctx.business.id
  const [existing] = await db
    .select({ id: calendarBlocks.id })
    .from(calendarBlocks)
    .where(and(eq(calendarBlocks.businessId, businessId), eq(calendarBlocks.googleEventId, ev.eventId)))
    .limit(1)

  if (ev.status === 'cancelled') {
    if (existing) {
      await db.delete(calendarBlocks).where(eq(calendarBlocks.id, existing.id))
    }
    return
  }

  // Need a concrete time range to occupy a slot; skip malformed events.
  if (!ev.start || !ev.end) return

  if (existing) {
    await db
      .update(calendarBlocks)
      .set({ startTs: ev.start, endTs: ev.end, googleEtag: ev.etag, updatedAt: new Date() })
      .where(eq(calendarBlocks.id, existing.id))
  } else {
    await db.insert(calendarBlocks).values({
      businessId,
      type: 'block',
      startTs: ev.start,
      endTs: ev.end,
      title: null, // never surface the owner's event title (opaque block)
      reason: null,
      googleEventId: ev.eventId,
      googleEtag: ev.etag,
      source: 'google_import',
    })
  }
}

/**
 * Owner-wins: apply cancellations the owner made in Google. Blast-radius gate
 * (decision in §7): if more than BLAST_RADIUS_THRESHOLD bookings are affected, do
 * NOT auto-cancel — summarize and ask the manager to confirm via Branch 3. Under
 * the threshold, cancel directly and notify the affected customers.
 */
async function applyOwnerCancellations(ctx: SyncContext, affected: AffectedBooking[]): Promise<void> {
  const businessId = ctx.business.id

  if (affected.length > BLAST_RADIUS_THRESHOLD) {
    if (ctx.managerPhone) {
      await enqueueMessage(ctx.managerPhone, i18n.calendar_owner_reconcile_gate[ctx.lang](affected.length))
        .catch(() => { /* non-fatal */ })
    }
    await logAudit(db, {
      businessId,
      actorId: null,
      action: 'calendar.owner_reconcile_gated',
      entityType: 'booking',
      metadata: { affectedCount: affected.length, bookingIds: affected.map((a) => a.bookingId) },
    })
    return
  }

  for (const a of affected) {
    await db
      .update(bookings)
      .set({
        state: 'cancelled',
        cancellationReason: 'Owner cancelled via Google Calendar',
        cancelledByRole: 'manager',
        rebookingRequested: false,
        updatedAt: new Date(),
      })
      .where(eq(bookings.id, a.bookingId))

    // Tell the customer through the initiation spine: in-window it phrases a warm note, out of
    // window it falls back to the booking_cancelled_by_business template instead of being silently
    // dropped by Meta (the old free-form enqueueMessage failed for cold customers). Best-effort.
    await notifyBusinessBookingChange(db, businessId, {
      kind: 'cancelled',
      bookingId: a.bookingId,
      customerId: a.customerId,
      serviceTypeId: a.serviceTypeId,
      slotStart: a.slotStart,
    })

    await logAudit(db, {
      businessId,
      actorId: null,
      action: 'calendar.owner_reconcile_applied',
      entityType: 'booking',
      entityId: a.bookingId,
      afterState: { state: 'cancelled' },
      metadata: { source: 'google_import' },
    })
  }

  if (ctx.managerPhone) {
    await enqueueMessage(ctx.managerPhone, i18n.calendar_owner_reconcile_applied[ctx.lang](affected.length))
      .catch(() => { /* non-fatal */ })
  }
}

// ── Webhook entry point ──────────────────────────────────────────────────────

/**
 * Handle an inbound Google push. Google sends only headers (no useful body); the
 * channelId + token authenticate it and we then pull the actual changes. Returns
 * quickly regardless — Google needs a fast 2xx and retries on its own.
 */
export async function handleWatchNotification(headers: {
  channelId: string | undefined
  resourceId: string | undefined
  channelToken: string | undefined
  resourceState: string | undefined
}): Promise<void> {
  if (!isInboundSyncEnabled()) return
  if (!headers.channelId) return
  // 'sync' is the initial handshake ping — acknowledge without pulling.
  if (headers.resourceState === 'sync') return

  const [channel] = await db
    .select()
    .from(calendarSyncChannels)
    .where(eq(calendarSyncChannels.channelId, headers.channelId))
    .limit(1)
  if (!channel) return
  // Authenticate via the shared token we registered the channel with.
  if (channel.channelToken && channel.channelToken !== headers.channelToken) return

  await runInboundSync(channel.businessId).catch((err: unknown) => {
    console.error('[inbound-sync] webhook-triggered sync failed', err)
  })
}

// ── Renewal cron ──────────────────────────────────────────────────────────────

/**
 * Re-register channels expiring within the lookahead window, and run a periodic
 * full reconcile so a dropped push is never the difference between synced and
 * diverged. Called by the renewal cron worker.
 */
export async function renewExpiringChannels(lookaheadMs = 24 * 60 * 60 * 1000): Promise<void> {
  if (!isInboundSyncEnabled()) return
  const horizon = new Date(Date.now() + lookaheadMs)
  const rows = await db
    .select({ businessId: calendarSyncChannels.businessId, expiration: calendarSyncChannels.channelExpiration })
    .from(calendarSyncChannels)
    .where(inArray(calendarSyncChannels.status, ['active', 'error']))

  for (const row of rows) {
    const expiringSoon = !row.expiration || row.expiration <= horizon
    if (expiringSoon) {
      await registerWatchChannel(row.businessId).catch((err: unknown) => {
        console.error('[inbound-sync] channel renewal failed', { businessId: row.businessId, err })
      })
    } else {
      // Not expiring yet — still run a safety full reconcile to catch dropped pushes.
      await runInboundSync(row.businessId, { full: true }).catch(() => { /* non-fatal */ })
    }
  }
}

