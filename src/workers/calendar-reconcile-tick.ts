import { Worker, Queue } from 'bullmq'
import { inArray } from 'drizzle-orm'
import { redisConnection } from '../redis.js'
import { db } from '../db/client.js'
import { calendarSyncChannels } from '../db/schema.js'
import { isInboundSyncEnabled, runInboundSync } from '../domain/calendar/inbound-sync.js'

// ── T2.2 — short-cadence reconcile tick (freshness) ──────────────────────────
// SEPARATE from calendar-sync-renewal.ts: that job is CHANNEL EXPIRY (~6h), this is
// FRESHNESS. Every CALENDAR_RECONCILE_TICK_MS (default 10 min), for each Google-connected
// business we run runInboundSync(businessId, {}, 'tick') on the STORED incremental syncToken.
// The incremental pull returns deltas including `cancelled` tombstones — the primary catch
// for an owner who freed a booked slot directly in Google when the push dropped. When the
// token has expired, runInboundSync re-runs windowed and the C0.1-guarded booking-diff
// (inbound-sync.ts) closes pre-existing Bug A. No-op while the master flag is off.

const QUEUE_NAME = 'calendar-reconcile-tick'
const DEFAULT_TICK_MS = 10 * 60 * 1000 // 10 minutes

/**
 * Resolve the tick cadence from CALENDAR_RECONCILE_TICK_MS. Unset → the 10-min default.
 * `0` / `off` / empty → disabled (returns null; no repeat job scheduled). A positive number
 * overrides the cadence. The whole subsystem is additionally gated by isInboundSyncEnabled(),
 * so the tick never fires until ops provisions and enables inbound sync.
 */
export function reconcileTickIntervalMs(): number | null {
  const raw = process.env['CALENDAR_RECONCILE_TICK_MS']
  if (raw == null) return DEFAULT_TICK_MS
  const norm = raw.trim().toLowerCase()
  if (norm === '' || norm === '0' || norm === 'off') return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TICK_MS
}

/**
 * One reconcile tick: an incremental (syncToken) inbound sync for every Google-connected
 * business. Gated by isInboundSyncEnabled() (no-op when off). Per-business failures are
 * isolated so one bad calendar never stalls the rest of the fleet.
 */
export async function runReconcileTick(): Promise<void> {
  if (!isInboundSyncEnabled()) return
  const rows = await db
    .select({ businessId: calendarSyncChannels.businessId })
    .from(calendarSyncChannels)
    .where(inArray(calendarSyncChannels.status, ['active', 'error']))
  for (const row of rows) {
    // {} (not full) ⇒ the stored syncToken is reused: an incremental delta, near-zero cost
    // when nothing changed and NO full-scan storm. runInboundSync falls back to windowed only
    // when the token is missing/expired, where the booking-diff then applies.
    await runInboundSync(row.businessId, {}, 'tick').catch((err: unknown) => {
      console.error('[calendar-reconcile-tick] sync failed', { businessId: row.businessId, err })
    })
  }
}

export const calendarReconcileTickQueue = new Queue(QUEUE_NAME, { connection: redisConnection })

export function startCalendarReconcileTickWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async () => { await runReconcileTick() },
    { connection: redisConnection },
  )
  worker.on('failed', (job, err) => {
    console.error('[calendar-reconcile-tick] Job failed', { jobId: job?.id, err: err.message })
  })
  return worker
}

export async function scheduleCalendarReconcileTickJob() {
  // Disabled by unsetting the feature flag or by CALENDAR_RECONCILE_TICK_MS=0/off — no repeat
  // job is registered in either case.
  if (!isInboundSyncEnabled()) return
  const every = reconcileTickIntervalMs()
  if (every == null) return
  await calendarReconcileTickQueue.add(
    'tick',
    {},
    { repeat: { every }, jobId: 'calendar-reconcile-tick' },
  )
}
