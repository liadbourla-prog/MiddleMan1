import { buildCalendar, loadSyncContext, reconcileOwnerEvent } from './inbound-sync.js'

// ── T2.1 — Branch-4 additions-only read-reconcile ────────────────────────────
// Close the G1/G2 latency window on the CUSTOMER path: when a customer asks about
// availability in connected-Google mode, fold in the owner's just-ADDED Google events
// for the inquiry's focus day BEFORE we answer, so a class the owner added directly in
// Google (with no push delivered yet) is classified and surfaced.
//
// This reuses reconcileOwnerEvent(ctx, ev, 'read') — the ONE certainty-gated inbound
// translator (Phase 1a) with the read-path deferrals (Phase 1b). There is no second
// classifier here. A just-added CERTAIN class materializes-and-is-bookable on read; an
// uncertain one becomes occupy-and-ask; a booked-class move/delete is deferred.
//
// HARD boundary (R2 data-loss): this path is ADDITIONS-ONLY. It performs NO diff-deletion
// — a successful-but-stale/empty Google response can never delete a valid block here. That
// is why 2a needs no completeness guard: it cannot lose data. Deletion stays on the
// push/tick/manager paths (T2.2 + reconcileScheduleWindowOnRead).
//
// Guards (all mandatory): connected-Google only (non-Google is a no-op with no Google
// call); throttle/cache per business+focus-day (the customer path is the first
// high-frequency caller); bounded by the C0.2 timeout already inside incrementalSync; on
// timeout/error we serve the internal record and NEVER block or error the reply; the
// window is the focus day only.

/**
 * Per-(business, focus-day) throttle. The customer path can fire many messages a minute,
 * so a short TTL caps Google pulls to at most one per business per focus-day per window.
 * In-memory + per-instance is intentional and sufficient: it is a rate limiter, not a
 * correctness gate (the tick/push guarantee eventual consistency), so a per-instance cap
 * bounds cost without needing a shared store or a schema column.
 */
const lastReadReconcileAt = new Map<string, number>()

/** Default 90s (middle of the 60–120s band). Ops-tunable without a deploy. */
function ttlMs(): number {
  const raw = process.env['CALENDAR_READ_RECONCILE_TTL_MS']
  const n = raw != null && raw.trim() !== '' ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? n : 90_000
}

/** Test-only: clear the throttle between cases. */
export function _resetReadReconcileThrottle(): void {
  lastReadReconcileAt.clear()
}

export interface ReadReconcileResult {
  ok: boolean
  reason?: string
  skipped?: 'throttled' | 'not_google'
}

/**
 * Fold the owner's just-ADDED Google events for a single focus-day window into the
 * internal record, so a customer availability answer computed right after reflects them.
 * Additions-only; never deletes; throttled; timeout-bounded; best-effort (a bad Google
 * response mutates nothing and never breaks the reply — the caller serves the internal
 * record).
 *
 * The window MUST be the inquiry's focus day (narrow), not the full availability horizon.
 */
export async function foldInOwnerAdditionsForDay(
  businessId: string,
  window: { from: Date; to: Date },
  opts: { now?: Date } = {},
): Promise<ReadReconcileResult> {
  const now = opts.now ?? new Date()

  // Throttle FIRST (cheapest gate) — a 2nd message for the same focus day inside the TTL
  // makes no 2nd Google call. Keyed by business + the day window's start instant.
  const key = `${businessId}:${window.from.toISOString()}`
  const last = lastReadReconcileAt.get(key)
  if (last != null && now.getTime() - last < ttlMs()) {
    return { ok: true, skipped: 'throttled' }
  }

  // Connected-Google only. A non-Google business is a no-op with NO Google call.
  const ctx = await loadSyncContext(businessId)
  if (!ctx) return { ok: true, skipped: 'not_google' }

  // Stamp the throttle BEFORE the network call so a concurrent/subsequent message in the
  // same window can't storm Google, and an errored attempt doesn't retry per-message
  // (freshness is best-effort here; the tick/push backstop guarantees eventual state).
  lastReadReconcileAt.set(key, now.getTime())

  const calendar = buildCalendar(ctx)
  // Bounded by the C0.2 AbortController deadline inside incrementalSync — a hang can never
  // stall the reply. On timeout/error/expired we serve the internal record, mutate nothing.
  const result = await calendar.incrementalSync({ timeMin: window.from, timeMax: window.to })
  if (result.status !== 'ok') {
    return {
      ok: false,
      reason: result.status === 'expired'
        ? 'windowed read-reconcile token unexpectedly expired'
        : result.reason,
    }
  }

  // ADDITIONS-ONLY: fold in owner-ADDED events only. PA-managed echoes are skipped (loop
  // prevention lives in reconcileManagedEvent, off the read path), and cancelled tombstones
  // are ignored — deletion is out of scope on the customer path (R2). No diff-deletion here.
  for (const ev of result.events) {
    if (!ev.eventId || ev.status === 'cancelled') continue
    if (!ev.paManaged) await reconcileOwnerEvent(ctx, ev, 'read')
  }

  return { ok: true }
}
