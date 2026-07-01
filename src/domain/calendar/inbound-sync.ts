import { randomUUID } from 'node:crypto'
import { and, eq, gte, inArray, lt } from 'drizzle-orm'
import { db } from '../../db/client.js'
import {
  bookings,
  businesses,
  calendarBlocks,
  calendarSyncChannels,
  identities,
  serviceTypes,
  type Business,
} from '../../db/schema.js'
import { createCalendarClient } from '../../adapters/calendar/client.js'
import type { RawCalendarEvent } from '../../adapters/calendar/types.js'
import { enqueueMessage } from '../../workers/message-retry.js'
import { notifyBusinessBookingChange, notifyOwnerBookingChange } from '../initiations/booking-notify.js'
import { logAudit } from '../audit/logger.js'
import { i18n, type Lang } from '../i18n/t.js'
import { logInboundDecision, type ViaTrigger } from './inbound-telemetry.js'
import { matchTitleToService, type ServiceMatch } from './service-match.js'
import { parseStructuredClassMarker, localWeekday, hasNegativeMarker, hasOccupancyProse } from './classify.js'

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

// Booking states that hold a live class seat — the ones a materialized-class MOVE must
// relocate and a materialized-class DELETE must route through the owner-wins gate. Terminal
// states (cancelled/expired/failed/attended/no_show) already released the slot. Mirrors the
// occupancy set in availability/day-options.ts, plus 'held' (a reserved seat mid-booking).
const CLASS_SEAT_STATES = ['requested', 'held', 'pending_payment', 'confirmed'] as const

/** True only when ops has provisioned the public callback and flipped the flag. */
export function isInboundSyncEnabled(): boolean {
  const v = process.env['CALENDAR_INBOUND_SYNC_ENABLED']
  return v === '1' || v === 'true'
}

/** The public HTTPS address Google posts change notifications to. Ops-provided. */
function webhookAddress(): string | null {
  return process.env['CALENDAR_WEBHOOK_ADDRESS'] ?? null
}

export interface SyncContext {
  business: Business
  calendarId: string
  refreshToken: string
  managerPhone: string | null
  lang: Lang
}

/** Human "when" for an owner note, e.g. "Sun 19:00" — business-local, never a raw UTC ISO. */
function formatWhenForOwner(start: Date, timezone: string, lang: Lang): string {
  const day = new Intl.DateTimeFormat(lang === 'he' ? 'he-IL' : 'en-US', { timeZone: timezone, weekday: 'short' }).format(start)
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(start)
  return `${day} ${time}`
}

export function buildCalendar(ctx: SyncContext) {
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

export async function loadSyncContext(businessId: string): Promise<SyncContext | null> {
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
export async function runInboundSync(businessId: string, opts: { full?: boolean } = {}, viaTrigger: ViaTrigger = 'push'): Promise<{ ok: boolean; reason?: string }> {
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
  const windowMax = new Date(now.getTime() + FULL_RECONCILE_FORWARD_MS)
  // Track whether this pull was WINDOWED (full/no-token/after-410) vs INCREMENTAL (live
  // syncToken). The booking-diff (T2.2) only runs on the windowed path: an incremental
  // delta legitimately omits unchanged bookings, so absence there proves nothing; deletions
  // on the incremental path arrive as `status:'cancelled'` tombstones instead.
  let windowed = !useToken
  let result = await calendar.incrementalSync(
    useToken ? { syncToken: useToken } : { timeMin: now, timeMax: windowMax },
  )

  // Expired token ⇒ re-run as a full reconcile (the real guarantee).
  if (result.status === 'expired') {
    windowed = true
    result = await calendar.incrementalSync({ timeMin: now, timeMax: windowMax })
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
      const affected = await reconcileManagedEvent(ctx, ev, viaTrigger)
      if (affected) ownerCancellations.push(affected)
    } else {
      await reconcileOwnerEvent(ctx, ev, viaTrigger)
    }
  }

  // ── Booking-diff deletion detection (T2.2 — closes PRE-EXISTING BUG A) ────────
  // The windowed/full pull does NOT reliably return a `cancelled` tombstone for a booking
  // event the owner deleted standalone — so a dropped push + expired token would otherwise
  // strand a freed booking as `confirmed` FOREVER. On the windowed path only, diff the
  // PA-managed bookings we expect in-window (that carry a mirrored Google event id) against
  // the ids Google actually returned; an absent one was owner-deleted and is routed through
  // the SAME gated applyOwnerCancellations (blast-radius + notify) as a tombstone. Guarded by
  // C0.1 so a partial/empty-but-200 response can NEVER mass-cancel real bookings.
  if (windowed) {
    const diffDeleted = await detectDeletedBookingsByDiff(ctx, result.events, now, windowMax, ownerCancellations, viaTrigger)
    ownerCancellations.push(...diffDeleted)
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
  // Carried so booking_cancelled telemetry is emitted where the cancellation is actually
  // APPLIED (post-blast-radius-gate), not at detection — a gated booking is never logged cancelled.
  googleEventId: string
  viaTrigger: ViaTrigger
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
async function reconcileManagedEvent(ctx: SyncContext, ev: RawCalendarEvent, viaTrigger: ViaTrigger): Promise<AffectedBooking | null> {
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
    if (!cancelled && ev.etag && booking.googleEtag && ev.etag === booking.googleEtag) {
      logInboundDecision({ businessId, googleEventId: ev.eventId, decision: 'echo_ignored', matchedServiceTypeId: null, matchTier: null, viaTrigger })
      return null
    }
    if (cancelled && (booking.state === 'confirmed' || booking.state === 'held' || booking.state === 'pending_payment')) {
      // Do NOT log booking_cancelled here — detection ≠ application. The blast-radius gate in
      // applyOwnerCancellations may block it; we log only where a cancel is actually applied.
      return { bookingId: booking.id, customerId: booking.customerId, serviceTypeId: booking.serviceTypeId, slotStart: booking.slotStart, googleEventId: ev.eventId, viaTrigger }
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
 * Does the business already run this class service on `weekday` (business-local)? This
 * is the PRIMARY certainty signal for auto-opening an owner-added class (T1.2, R1): a
 * new Sun 19:00 Pilates is certain when Sunday already runs Pilates at other times — it
 * is unmistakably another instance of a class we already manage. Time need NOT match;
 * only the weekday. The event being reconciled is excluded (by googleEventId) so it can
 * never vouch for its own certainty.
 */
async function hasExistingClassSeriesOnWeekday(
  businessId: string,
  serviceTypeId: string,
  weekday: number,
  timezone: string,
  excludeGoogleEventId: string,
): Promise<boolean> {
  const rows = await db
    .select({ startTs: calendarBlocks.startTs, googleEventId: calendarBlocks.googleEventId })
    .from(calendarBlocks)
    .where(and(
      eq(calendarBlocks.businessId, businessId),
      eq(calendarBlocks.type, 'class'),
      eq(calendarBlocks.serviceTypeId, serviceTypeId),
    ))
  return rows.some((r) => r.googleEventId !== excludeGoogleEventId && localWeekday(r.startTs, timezone) === weekday)
}

/**
 * Reconcile an owner-created Google event into the internal record — the inbound
 * *translator* (Google is never a source of truth). Certainty-gated (T1.2, R1):
 *
 *  - No service-name match           → opaque busy-block (title discarded). Decision #10.
 *  - Class-service match + CERTAIN    → materialize a bookable type='class' block
 *      (certainty = the weekday already runs this class, OR a machine-readable marker).
 *  - Class-service match, NOT certain → occupy the slot with an opaque block carrying a
 *      pending-class marker (serviceTypeId set, type='block' ⇒ NOT bookable) and relay to
 *      the owner to confirm it's really open. Becomes a class only on owner confirm.
 *  - Appointment-mode / weak match    → opaque block + owner relay (never a class).
 *
 * HARD invariant: occupancy is ALWAYS counted internally. A description is read only to
 * classify / read a declared capacity — never to trust a head-count ("2/8 booked" is a
 * reason to ASK the owner, never to auto-open). We never surface the owner's title.
 *
 * A cancelled/deleted owner event removes the imported block. Reconciling an EXISTING
 * event only moves its time (re-classification of an existing row is T1.4, deferred).
 */
export async function reconcileOwnerEvent(ctx: SyncContext, ev: RawCalendarEvent, viaTrigger: ViaTrigger): Promise<void> {
  const businessId = ctx.business.id
  const [existing] = await db
    .select({ id: calendarBlocks.id, type: calendarBlocks.type, serviceTypeId: calendarBlocks.serviceTypeId, startTs: calendarBlocks.startTs, endTs: calendarBlocks.endTs })
    .from(calendarBlocks)
    .where(and(eq(calendarBlocks.businessId, businessId), eq(calendarBlocks.googleEventId, ev.eventId)))
    .limit(1)

  // ── DELETE (T1.4) ────────────────────────────────────────────────────────────
  // The owner removed the event in Google. A pending block or a 0-booking class is a
  // clean removal (today's behavior). A materialized class that HAS live bookings must
  // never be silently dropped — route its co-bookings through the owner-wins blast-radius
  // gate (applyOwnerCancellations): >threshold ⇒ ask the manager and cancel NOTHING (keep
  // the block occupied so seats aren't orphaned while the manager decides); ≤threshold ⇒
  // cancel each + notify, then remove the now-empty class block.
  if (ev.status === 'cancelled') {
    if (!existing) return
    if (existing.type === 'class' && existing.serviceTypeId && viaTrigger !== 'read') {
      const affected = await loadClassSeatBookings(businessId, existing.serviceTypeId, existing.startTs, ev.eventId, viaTrigger)
      if (affected.length > 0) {
        await applyOwnerCancellations(ctx, affected)
        // Only remove the class block once its bookings were actually cancelled (≤ threshold).
        // Over threshold the gate cancelled nothing, so keeping the block preserves the seats.
        if (affected.length <= BLAST_RADIUS_THRESHOLD) {
          await deleteImportedBlock(businessId, existing.id, ev.eventId)
        }
        return
      }
    }
    await deleteImportedBlock(businessId, existing.id, ev.eventId)
    return
  }

  // Need a concrete time range to occupy a slot; skip malformed events.
  if (!ev.start || !ev.end) return

  // ── MOVE / UPDATE (T1.4) ──────────────────────────────────────────────────────
  // Update of an already-imported event: move its time. We do NOT re-classify an existing
  // row (that would need the full classifier). When a MATERIALIZED class moves and carries
  // live bookings, the seats follow the class to the new slot (owner-wins, non-destructive —
  // the class instance persists, only its clock time shifts) and each affected customer + the
  // owner is notified via the 'moved' spine.
  //
  // Read-path DEFERRAL (hard): a booked-class move must NOT be applied on a passive read.
  // Beyond the no-notification invariant, patching the block time on a read while leaving the
  // seats behind would STRAND them — the later push would see no time change and never relocate
  // them. So on a read we leave the block at its old time and defer the whole move (patch +
  // relocate + notify) to the push/tick. An unbooked class / opaque block still patches on read.
  if (existing) {
    const oldStart = existing.startTs
    const oldEnd = existing.endTs
    const timeChanged = !oldStart || !oldEnd || oldStart.getTime() !== ev.start.getTime() || oldEnd.getTime() !== ev.end.getTime()
    const isClassMove = existing.type === 'class' && existing.serviceTypeId != null && oldStart != null && timeChanged
    if (isClassMove) {
      const seats = await loadClassSeatBookings(businessId, existing.serviceTypeId!, oldStart!, ev.eventId, viaTrigger)
      if (seats.length > 0 && viaTrigger === 'read') {
        // Deferred — do not mutate anything on the read path; the push/tick applies it with notifications.
        logInboundDecision({ businessId, googleEventId: ev.eventId, decision: 'block_opaque', matchedServiceTypeId: null, matchTier: null, viaTrigger })
        return
      }
      await db
        .update(calendarBlocks)
        .set({ startTs: ev.start, endTs: ev.end, googleEtag: ev.etag, updatedAt: new Date() })
        .where(eq(calendarBlocks.id, existing.id))
      if (seats.length > 0) await relocateClassSeats(ctx, seats, oldStart!, ev.start, ev.end)
      logInboundDecision({ businessId, googleEventId: ev.eventId, decision: 'block_opaque', matchedServiceTypeId: null, matchTier: null, viaTrigger })
      return
    }
    // Opaque block, unchanged time, or a class with no move → patch as before.
    await db
      .update(calendarBlocks)
      .set({ startTs: ev.start, endTs: ev.end, googleEtag: ev.etag, updatedAt: new Date() })
      .where(eq(calendarBlocks.id, existing.id))
    logInboundDecision({ businessId, googleEventId: ev.eventId, decision: 'block_opaque', matchedServiceTypeId: null, matchTier: null, viaTrigger })
    return
  }

  // ── Classify (T1.2) ─────────────────────────────────────────────────────────
  // Resolve a service from the title; a structured marker can name the service too.
  const titleMatch = await matchTitleToService(db, businessId, ev.summary)
  const marker = parseStructuredClassMarker(ev.description)
  const markerMatch: ServiceMatch | null =
    marker && !titleMatch ? await matchTitleToService(db, businessId, marker.serviceName) : titleMatch
  const service = titleMatch ?? markerMatch

  // No service match at all → opaque block, exactly today's behavior (privacy gate).
  if (!service) {
    await insertOpaqueBlock(businessId, ev, null)
    logInboundDecision({ businessId, googleEventId: ev.eventId, decision: 'block_opaque', matchedServiceTypeId: null, matchTier: null, viaTrigger })
    return
  }

  // Appointment-mode (or a class-mode marker that only matched by appointment title):
  // never a class. Occupy + relay so the owner tells us what it is.
  if (service.schedulingMode !== 'class') {
    await insertOpaqueBlock(businessId, ev, null) // no pending-class marker for appointment mode
    logInboundDecision({ businessId, googleEventId: ev.eventId, decision: 'weak_pending_confirm', matchedServiceTypeId: service.serviceTypeId, matchTier: null, viaTrigger })
    await enqueueOwnerClassConfirm(ctx, ev, service)
    return
  }

  // Class-mode match. Certainty via structured marker (secondary) or template/pattern
  // (primary). A marker naming this service is itself the certainty signal.
  //
  // Tightened gate (orchestrator "Tightened template", 2026-07-01): a certainty signal
  // is necessary but no longer sufficient. Two VETOES demote a would-be-certain case to
  // occupy-and-ASK, and the template path additionally requires a duration match:
  //   · negative-marker veto (BOTH paths): a private/closed marker in title/description
  //     is never auto-opened — a private class is safe by construction.
  //   · phantom-occupancy veto (BOTH paths): occupancy-implying prose ("2/8", "booked")
  //     implies external bookings we don't hold — ask the owner, never trust the count.
  //   · duration match (template path): a same-service event of a DIFFERENT length is not
  //     certainly a class instance. The marker path keeps its own declared capacity/duration.
  const markerCertain = marker != null && markerMatch != null
  const eventDurationMinutes = Math.round((ev.end.getTime() - ev.start.getTime()) / 60000)
  const durationMatches = service.classDurationMinutes != null && eventDurationMinutes === service.classDurationMinutes
  const templateCertain = !markerCertain && durationMatches && await hasExistingClassSeriesOnWeekday(
    businessId, service.serviceTypeId, localWeekday(ev.start, ctx.business.timezone), ctx.business.timezone, ev.eventId,
  )
  const vetoed = hasNegativeMarker(ev.summary, ev.description) || hasOccupancyProse(ev.description)

  if ((markerCertain || templateCertain) && !vetoed) {
    // Capacity: the structured marker's declared capacity, else the service default.
    // NEVER a head-count parsed from prose — occupancy is counted internally.
    const capacity = marker?.capacity ?? service.defaultCapacity
    await db.insert(calendarBlocks).values({
      businessId,
      type: 'class',
      startTs: ev.start,
      endTs: ev.end,
      title: null, // never surface the owner's title
      reason: null,
      serviceTypeId: service.serviceTypeId,
      maxParticipants: capacity,
      providerId: null, // never fabricate an instructor (G6-safe)
      googleEventId: ev.eventId,
      googleEtag: ev.etag,
      source: 'google_import', // trips the outbound-mirror skip (calendar-mirror.ts) — no echo loop
    })
    logInboundDecision({ businessId, googleEventId: ev.eventId, decision: 'class_materialized', matchedServiceTypeId: service.serviceTypeId, matchTier: markerCertain ? 'marker' : 'template', viaTrigger })
    await enqueueOwnerClassImported(ctx, ev, service, capacity)
    return
  }

  // Uncertain class → occupy-and-ASK. Opaque block carrying the pending-class marker
  // (serviceTypeId set but type='block' ⇒ findClassBlockProviderForSlot skips it, so it
  // is NOT bookable) + relay to the owner. It becomes a class only on owner confirm.
  await insertOpaqueBlock(businessId, ev, {
    serviceTypeId: service.serviceTypeId,
    maxParticipants: service.defaultCapacity,
  })
  logInboundDecision({ businessId, googleEventId: ev.eventId, decision: 'weak_pending_confirm', matchedServiceTypeId: service.serviceTypeId, matchTier: null, viaTrigger })
  await enqueueOwnerClassConfirm(ctx, ev, service)
}

/**
 * Insert an opaque busy-block for an owner event (title always discarded). When
 * `pending` is provided the row carries a pending-imported-class marker (serviceTypeId +
 * capacity) while STAYING type='block' — occupies the slot but is never bookable until
 * the owner confirms. Mirrors the original reconcileOwnerEvent insert (source='google_import',
 * no enqueueBlockMirror, mirrorToGoogle at its default true).
 */
async function insertOpaqueBlock(
  businessId: string,
  ev: RawCalendarEvent,
  pending: { serviceTypeId: string; maxParticipants: number } | null,
): Promise<void> {
  await db.insert(calendarBlocks).values({
    businessId,
    type: 'block',
    startTs: ev.start!,
    endTs: ev.end!,
    title: null, // never surface the owner's event title (opaque block)
    reason: null,
    serviceTypeId: pending?.serviceTypeId ?? null,
    maxParticipants: pending?.maxParticipants ?? null,
    googleEventId: ev.eventId,
    googleEtag: ev.etag,
    source: 'google_import',
  })
}

/**
 * Delete an imported block by id and audit it (T1.4). Single home so the cancelled-event
 * removal always leaves an audit trail (the old cancelled branch deleted silently).
 */
async function deleteImportedBlock(businessId: string, blockId: string, googleEventId: string): Promise<void> {
  await db.delete(calendarBlocks).where(and(eq(calendarBlocks.id, blockId), eq(calendarBlocks.businessId, businessId)))
  await logAudit(db, {
    businessId,
    actorId: null,
    action: 'calendar.owner_deleted_block',
    entityType: 'calendar_block',
    entityId: blockId,
    metadata: { googleEventId },
  })
}

/**
 * Booking-diff deletion detection (T2.2 — closes PRE-EXISTING BUG A). On the WINDOWED path
 * only, an owner who deleted a booking event standalone in Google leaves no reliable
 * tombstone (unlike the incremental path); the event simply stops appearing. We detect that
 * by DIFF: any live PA-managed booking we expect in-window that carries a mirrored Google
 * event id (`calendarEventId`) whose id is absent from Google's returned set was owner-
 * deleted. Returns those as AffectedBooking records for the SAME gated applyOwnerCancellations
 * path (blast-radius + notify) — never a raw delete.
 *
 * ⚠️ C0.1 COMPLETENESS GUARD (the single most dangerous thing in the plan). Absence is a
 * valid "deleted" signal ONLY when the fetch completed fully (status==='ok' ⇒ all pages
 * drained + HTTP ok, established by the caller) AND the returned set is not implausibly empty
 * relative to what we hold internally. A successful-but-eventually-consistent/empty Google
 * page (0 live events) while we hold ≥1 mirrored booking in-window is NOT "everything was
 * cancelled" — treating it so would fire false cancellation WhatsApps at real paying
 * customers. In that case we ABORT the diff, log, and cancel NOTHING (zero notifications).
 * A non-zero-but-implausibly-short response that omits many bookings is caught downstream by
 * the blast-radius gate (asks the manager, auto-cancels nothing) — never by silent mass-cancel.
 *
 * Occupancy stays 100% internal: this reads the bookings table, never a Google head-count.
 * Bookings already flagged this pass (by a tombstone via reconcileManagedEvent) are skipped
 * so a booking is never double-counted. GROUP-class seats carry calendarEventId=null (no
 * individual mirror event) and are correctly excluded — they have no id to be absent.
 */
async function detectDeletedBookingsByDiff(
  ctx: SyncContext,
  events: RawCalendarEvent[],
  windowMin: Date,
  windowMax: Date,
  alreadyFlagged: AffectedBooking[],
  viaTrigger: ViaTrigger,
): Promise<AffectedBooking[]> {
  const businessId = ctx.business.id

  // The ids Google actually returned as PRESENT (a `cancelled` tombstone is an absence signal,
  // not a presence one, so it is excluded here).
  const returnedIds = new Set<string>()
  for (const ev of events) {
    if (ev.eventId && ev.status !== 'cancelled') returnedIds.add(ev.eventId)
  }

  // Live PA-managed bookings expected in-window that carry a mirrored Google event id.
  const expected = await db
    .select({ id: bookings.id, customerId: bookings.customerId, serviceTypeId: bookings.serviceTypeId, slotStart: bookings.slotStart, calendarEventId: bookings.calendarEventId })
    .from(bookings)
    .where(and(
      eq(bookings.businessId, businessId),
      gte(bookings.slotStart, windowMin),
      lt(bookings.slotStart, windowMax),
      inArray(bookings.state, [...CLASS_SEAT_STATES]),
    ))
  const mirrored = expected.filter((b) => b.calendarEventId)

  // ── C0.1 completeness guard ────────────────────────────────────────────────
  // Google returned ZERO live events over a window in which we hold ≥1 mirrored booking ⇒
  // implausible (a connected calendar with live bookings should return at least those events).
  // Abort the diff, audit, cancel nothing — silent (audit only) so ZERO notifications fire.
  if (returnedIds.size === 0 && mirrored.length > 0) {
    await logAudit(db, {
      businessId,
      actorId: null,
      action: 'calendar.reconcile_completeness_guard',
      entityType: 'business',
      entityId: businessId,
      metadata: { via: 'booking_diff', reason: 'empty_response_over_nonempty_window', mirroredInWindow: mirrored.length },
    })
    return []
  }

  const flaggedIds = new Set(alreadyFlagged.map((a) => a.bookingId))
  const deleted: AffectedBooking[] = []
  for (const b of mirrored) {
    if (flaggedIds.has(b.id)) continue // already caught by a tombstone this pass
    if (returnedIds.has(b.calendarEventId!)) continue // still present in Google
    deleted.push({ bookingId: b.id, customerId: b.customerId, serviceTypeId: b.serviceTypeId, slotStart: b.slotStart, googleEventId: b.calendarEventId!, viaTrigger })
  }
  return deleted
}

/**
 * Load the live class co-bookings occupying (serviceTypeId, classStart) as AffectedBooking
 * records for the owner-wins blast-radius gate (T1.4 DELETE). Occupancy is always counted
 * internally — this reads the bookings table, never a Google head-count.
 */
async function loadClassSeatBookings(
  businessId: string,
  serviceTypeId: string,
  classStart: Date,
  googleEventId: string,
  viaTrigger: ViaTrigger,
): Promise<AffectedBooking[]> {
  const rows = await db
    .select({ id: bookings.id, customerId: bookings.customerId, serviceTypeId: bookings.serviceTypeId, slotStart: bookings.slotStart })
    .from(bookings)
    .where(and(
      eq(bookings.businessId, businessId),
      eq(bookings.serviceTypeId, serviceTypeId),
      eq(bookings.slotStart, classStart),
      inArray(bookings.state, [...CLASS_SEAT_STATES]),
    ))
  return rows.map((r) => ({ bookingId: r.id, customerId: r.customerId, serviceTypeId: r.serviceTypeId, slotStart: r.slotStart, googleEventId, viaTrigger }))
}

/**
 * Relocate a materialized class's already-loaded live seats to the new slot (T1.4). The seat
 * follows the class (owner-wins, non-destructive: no seat is lost, so no blast-radius ask-gate is
 * needed — the gate exists to prevent surprise mass-cancellation, and a move cancels nothing).
 * Each affected customer + the owner is notified via the existing 'moved' spine (honest, never a
 * silent time change). Never called on the passive read path (no notification side effect there).
 */
async function relocateClassSeats(
  ctx: SyncContext,
  affected: AffectedBooking[],
  fromSlotStart: Date,
  newStart: Date,
  newEnd: Date,
): Promise<void> {
  const businessId = ctx.business.id
  if (affected.length === 0) return

  for (const a of affected) {
    await db
      .update(bookings)
      .set({ slotStart: newStart, slotEnd: newEnd, updatedAt: new Date() })
      .where(eq(bookings.id, a.bookingId))

    await notifyBusinessBookingChange(db, businessId, {
      kind: 'moved',
      bookingId: a.bookingId,
      customerId: a.customerId,
      serviceTypeId: a.serviceTypeId,
      fromSlotStart,
      slotStart: newStart,
    })
    notifyOwnerBookingChange(db, businessId, {
      kind: 'moved',
      origin: 'google',
      actorIsManager: false,
      bookingId: a.bookingId,
      customerId: a.customerId,
      serviceTypeId: a.serviceTypeId,
      fromSlotStart,
      slotStart: newStart,
    }).catch(() => { /* non-fatal */ })
  }

  await logAudit(db, {
    businessId,
    actorId: null,
    action: 'calendar.owner_moved_class',
    entityType: 'calendar_block',
    metadata: { serviceTypeId: affected[0]?.serviceTypeId ?? null, fromSlotStart: fromSlotStart.toISOString(), toSlotStart: newStart.toISOString(), affectedCount: affected.length },
  })
}

/** T1.3 — informational owner note after a CERTAIN materialize (owner-wins, code template). */
async function enqueueOwnerClassImported(ctx: SyncContext, ev: RawCalendarEvent, service: ServiceMatch, capacity: number): Promise<void> {
  if (!ctx.managerPhone || !ev.start) return
  const serviceName = await serviceNameFor(ctx.business.id, service.serviceTypeId)
  const when = formatWhenForOwner(ev.start, ctx.business.timezone, ctx.lang)
  await enqueueMessage(ctx.business.id, ctx.managerPhone, i18n.calendar_owner_class_imported[ctx.lang](serviceName, when, capacity))
    .catch(() => { /* non-fatal */ })
}

/** T1.3 — owner confirm QUESTION for an uncertain class (slot occupied until answered). */
async function enqueueOwnerClassConfirm(ctx: SyncContext, ev: RawCalendarEvent, service: ServiceMatch): Promise<void> {
  if (!ctx.managerPhone || !ev.start) return
  const serviceName = await serviceNameFor(ctx.business.id, service.serviceTypeId)
  const when = formatWhenForOwner(ev.start, ctx.business.timezone, ctx.lang)
  await enqueueMessage(ctx.business.id, ctx.managerPhone, i18n.calendar_owner_class_confirm[ctx.lang](serviceName, when))
    .catch(() => { /* non-fatal */ })
}

/** Resolve a service name for an owner note. Falls back to a neutral label if the row is gone. */
async function serviceNameFor(businessId: string, serviceTypeId: string): Promise<string> {
  const [row] = await db
    .select({ name: serviceTypes.name })
    .from(serviceTypes)
    .where(and(eq(serviceTypes.id, serviceTypeId), eq(serviceTypes.businessId, businessId)))
    .limit(1)
  return row?.name ?? 'class'
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
      await enqueueMessage(businessId, ctx.managerPhone, i18n.calendar_owner_reconcile_gate[ctx.lang](affected.length))
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

    // Owner-facing: surface the Google-originated cancellation per-booking. Rules-gated (so an
    // owner who muted 'cancellation' won't get both this and the digest), and the existing
    // blast-radius confirm-gate above + the summary below are unchanged. Best-effort.
    notifyOwnerBookingChange(db, businessId, {
      kind: 'cancelled',
      origin: 'google',
      actorIsManager: false,
      bookingId: a.bookingId,
      customerId: a.customerId,
      serviceTypeId: a.serviceTypeId,
      slotStart: a.slotStart,
    }).catch(() => { /* non-fatal */ })

    // Telemetry at the point of APPLICATION (post-gate) — a gated booking (early return
    // above) is never logged as cancelled, so the decision log reflects reality.
    logInboundDecision({ businessId, googleEventId: a.googleEventId, decision: 'booking_cancelled', matchedServiceTypeId: a.serviceTypeId, matchTier: null, viaTrigger: a.viaTrigger })

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
    await enqueueMessage(businessId, ctx.managerPhone, i18n.calendar_owner_reconcile_applied[ctx.lang](affected.length))
      .catch(() => { /* non-fatal */ })
  }
}

// ── Webhook entry point ──────────────────────────────────────────────────────

/**
 * P6 (SYNC6) authentication gate — pure decision helper so it can be unit-tested
 * without a DB. Returns true only when BOTH the channelToken and resourceId are
 * present in the stored channel record AND exactly match the incoming headers.
 *
 * Strict presence + match on both fields is intentional:
 *   - A null/missing stored token means the channel was registered without one
 *     (anomaly) — we must NOT fall through and accept arbitrary pushes.
 *   - A null/missing stored resourceId is likewise an anomaly — reject.
 *   - A forged or mismatched incoming value on either field is rejected.
 */
export function isAuthenticatedPush(
  channel: { channelToken: string | null | undefined; resourceId: string | null | undefined },
  headers: { channelToken: string | undefined; resourceId: string | undefined },
): boolean {
  if (!channel.channelToken) return false
  if (!headers.channelToken || headers.channelToken !== channel.channelToken) return false
  if (!channel.resourceId) return false
  if (!headers.resourceId || headers.resourceId !== channel.resourceId) return false
  return true
}

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

  // ── P6 / SYNC6 authentication chokepoint ────────────────────────────────
  // Require strict presence + exact match on BOTH channelToken and resourceId.
  // A null stored token (anomaly) or any forged/mismatched header is rejected.
  // The route always 200s to Google; rejection is silent from Google's perspective.
  if (!isAuthenticatedPush(channel, headers)) {
    const reason = !channel.channelToken
      ? 'stored-token-null'
      : !headers.channelToken || headers.channelToken !== channel.channelToken
        ? 'token-mismatch'
        : !channel.resourceId
          ? 'stored-resourceId-null'
          : 'resourceId-mismatch'
    console.warn('[inbound-sync] rejected unauthenticated/mismatched calendar push', {
      channelId: headers.channelId,
      reason,
    })
    return
  }

  await runInboundSync(channel.businessId, {}, 'push').catch((err: unknown) => {
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
      // Not expiring yet — still run a safety full reconcile to catch dropped pushes. This
      // is the renewal cron, not a push, so it's labelled 'cron' in the decision log.
      await runInboundSync(row.businessId, { full: true }, 'cron').catch(() => { /* non-fatal */ })
    }
  }
}

// ── Reconcile-on-read ─────────────────────────────────────────────────────────

/**
 * Fold the owner's own Google edits — events they ADDED or DELETED directly in
 * Google Calendar within a bounded window — back into the internal record on
 * demand. This runs when the manager asks to see their schedule in connected
 * Google mode (Branch 3), so the picture we show, AND the availability we compute,
 * match what the owner sees in Google even before the push/cron inbound sync is
 * provisioned. It is therefore deliberately NOT gated by isInboundSyncEnabled():
 * that flag guards the standing watch-channel + cron machinery (which needs the
 * ops webhook); this is a pull triggered by an explicit read.
 *
 * Scope is owner-visible *schedule* items only — classes, personal events,
 * intra-day blocks, and owner-imported events (all `calendar_blocks`). Customer
 * bookings are intentionally OUT of scope here: owner-cancelling a booking has
 * customer-notification side effects (applyOwnerCancellations) that must never
 * fire from a passive read — those stay on the gated owner-wins path.
 *
 * Deletions are detected by DIFF, not by trusting Google to still return a
 * 'cancelled' tombstone for the window: any internal block we had mirrored to a
 * Google event that is no longer present was removed by the owner. Best-effort —
 * on any Google error we return without mutating, so a hiccup never deletes data
 * or breaks the read.
 */
export async function reconcileScheduleWindowOnRead(
  businessId: string,
  window: { from: Date; to: Date },
): Promise<{ ok: boolean; reason?: string }> {
  const ctx = await loadSyncContext(businessId)
  if (!ctx) return { ok: false, reason: 'business not in connected Google mode' }

  const calendar = buildCalendar(ctx)
  const result = await calendar.incrementalSync({ timeMin: window.from, timeMax: window.to })
  if (result.status !== 'ok') {
    return { ok: false, reason: result.status === 'expired' ? 'windowed reconcile token unexpectedly expired' : result.reason }
  }

  // Index every event Google currently returns for the window. Owner-created
  // events (not PA-managed) are folded in as opaque busy-blocks so they occupy
  // availability; PA-managed echoes of our own writes are left to the diff below.
  const presentGoogleIds = new Set<string>()
  for (const ev of result.events) {
    if (!ev.eventId || ev.status === 'cancelled') continue
    presentGoogleIds.add(ev.eventId)
    if (!ev.paManaged) await reconcileOwnerEvent(ctx, ev, 'read')
  }

  // Diff-based deletion. We only ever consider blocks that START inside the window
  // (matching Google's overlap windowing) and that we had mirrored (carry a
  // googleEventId) — a not-yet-mirrored block has no Google counterpart to be
  // absent from, so its absence proves nothing.
  const blocks = await db
    .select({ id: calendarBlocks.id, googleEventId: calendarBlocks.googleEventId, type: calendarBlocks.type, serviceTypeId: calendarBlocks.serviceTypeId, startTs: calendarBlocks.startTs })
    .from(calendarBlocks)
    .where(and(
      eq(calendarBlocks.businessId, businessId),
      gte(calendarBlocks.startTs, window.from),
      lt(calendarBlocks.startTs, window.to),
    ))

  // ── C0.1 completeness guard ────────────────────────────────────────────────
  // Absence-in-the-returned-set is only a valid "the owner deleted it" signal when
  // the fetch completed fully (status==='ok' ⇒ all pages drained, HTTP ok — checked
  // above) AND the returned set is not implausibly empty relative to what we hold.
  // A successful-but-eventually-consistent/empty Google page (0 live events) while
  // we hold ≥1 mirrored block in-window is NOT "everything was deleted" — treating
  // it as such would permanently destroy valid class/blocks for ALL callers (the
  // pre-existing manager/web data-loss exposure). Abort the diff, log, delete nothing.
  const mirroredInWindow = blocks.filter((b) => b.googleEventId)
  if (presentGoogleIds.size === 0 && mirroredInWindow.length > 0) {
    await logAudit(db, {
      businessId,
      actorId: null,
      action: 'calendar.reconcile_completeness_guard',
      entityType: 'business',
      entityId: businessId,
      metadata: {
        via: 'reconcile_on_read',
        reason: 'empty_response_over_nonempty_window',
        mirroredInWindow: mirroredInWindow.length,
      },
    })
    return { ok: true, reason: 'completeness-guard: empty Google response over non-empty mirrored window; diff-deletion aborted' }
  }

  for (const b of blocks) {
    if (!b.googleEventId || presentGoogleIds.has(b.googleEventId)) continue
    // T1.4 guard: a materialized class with LIVE bookings must never be silently diff-deleted
    // on a passive read — that would orphan the customers with no notification. Defer it to the
    // gated push/tick path (applyOwnerCancellations), which cancels + notifies behind the
    // blast-radius gate. Skip + audit; a 0-booking class or an opaque block deletes as before.
    if (b.type === 'class' && b.serviceTypeId) {
      const seats = await loadClassSeatBookings(businessId, b.serviceTypeId, b.startTs, b.googleEventId, 'read')
      if (seats.length > 0) {
        await logAudit(db, {
          businessId,
          actorId: null,
          action: 'calendar.reconcile_booked_class_delete_deferred',
          entityType: 'calendar_block',
          entityId: b.id,
          metadata: { googleEventId: b.googleEventId, via: 'reconcile_on_read', liveBookings: seats.length },
        })
        continue
      }
    }
    await db.delete(calendarBlocks).where(eq(calendarBlocks.id, b.id))
    await logAudit(db, {
      businessId,
      actorId: null,
      action: 'calendar.owner_deleted_block',
      entityType: 'calendar_block',
      entityId: b.id,
      metadata: { googleEventId: b.googleEventId, via: 'reconcile_on_read' },
    })
  }

  return { ok: true }
}

