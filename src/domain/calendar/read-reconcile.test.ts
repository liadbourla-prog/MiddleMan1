/**
 * T2.1 — Branch-4 additions-only read-reconcile (foldInOwnerAdditionsForDay).
 *
 * The customer path is the first HIGH-FREQUENCY caller, so this is the seam that
 * folds in owner-ADDED Google events for the inquiry's focus day before we answer —
 * without ever diff-deleting (R2 data-loss). It is ADDITIONS-ONLY by construction.
 *
 * These tests isolate T2.1's own logic (connected-Google gate, throttle/cache,
 * timeout/error → serve-internal, additions-only fold-in) by mocking the inbound-sync
 * primitives it delegates to. That materialization itself is CERTAIN/uncertain-gated is
 * already proven by the Phase-1 reconcileOwnerEvent tests; here we only prove the read
 * door calls it for owner-added events and never mutates on a bad Google response.
 *
 * Repros:
 *   (a) owner adds a certain class, no push delivered → the day-ask folds it in
 *       (reconcileOwnerEvent called for the owner-added event, via='read').
 *   (b) a 2nd customer message within the TTL → NO 2nd Google call (throttle).
 *   (c) Google times out / errors → reply still returns from the internal record,
 *       nothing mutated (reconcileOwnerEvent never called).
 *   (d) a non-Google business → NO Google call at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  const incrementalSyncMock = vi.fn(async () => h.incrementalResult)
  return {
    ctx: null as unknown,
    incrementalResult: null as unknown,
    incrementalSyncMock,
    loadSyncContextMock: vi.fn(async () => h.ctx),
    buildCalendarMock: vi.fn(() => ({ incrementalSync: incrementalSyncMock })),
    reconcileOwnerEventMock: vi.fn(async () => undefined),
  }
})
const { incrementalSyncMock, buildCalendarMock, reconcileOwnerEventMock } = h

vi.mock('./inbound-sync.js', () => ({
  loadSyncContext: h.loadSyncContextMock,
  buildCalendar: h.buildCalendarMock,
  reconcileOwnerEvent: h.reconcileOwnerEventMock,
}))

import { foldInOwnerAdditionsForDay, _resetReadReconcileThrottle } from './read-reconcile.js'

const WINDOW = { from: new Date('2026-07-05T00:00:00Z'), to: new Date('2026-07-06T00:00:00Z') }
const CONNECTED_CTX = { business: { id: 'biz-1', timezone: 'Asia/Jerusalem' }, calendarId: 'cal-1', refreshToken: 'rt', managerPhone: null, lang: 'he' }

const ownerAddedEvent = {
  eventId: 'g-new-pilates',
  status: 'confirmed',
  summary: 'Pilates',
  start: new Date('2026-07-05T16:00:00Z'),
  end: new Date('2026-07-05T17:00:00Z'),
  etag: 'etag-1',
  paManaged: false,
  paType: null,
  paId: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  _resetReadReconcileThrottle()
  h.ctx = CONNECTED_CTX
  h.incrementalResult = { status: 'ok', events: [ownerAddedEvent], nextSyncToken: null }
  delete process.env['CALENDAR_READ_RECONCILE_TTL_MS']
})

describe('T2.1 additions-only read-reconcile', () => {
  it('(a) folds in an owner-added event for the focus day (reconcileOwnerEvent via read), no push needed', async () => {
    const res = await foldInOwnerAdditionsForDay('biz-1', WINDOW, { now: new Date('2026-07-05T15:00:00Z') })
    expect(res.ok).toBe(true)
    expect(incrementalSyncMock).toHaveBeenCalledTimes(1)
    expect(reconcileOwnerEventMock).toHaveBeenCalledTimes(1)
    // Delegated via the read trigger so Phase-1's read-path deferrals apply.
    expect(reconcileOwnerEventMock).toHaveBeenCalledWith(CONNECTED_CTX, ownerAddedEvent, 'read')
  })

  it('(a2) never diff-deletes: a PA-managed echo and a cancelled tombstone in the window are skipped, only owner ADDS fold in', async () => {
    h.incrementalResult = {
      status: 'ok',
      nextSyncToken: null,
      events: [
        ownerAddedEvent,
        { ...ownerAddedEvent, eventId: 'g-echo', paManaged: true }, // our own echo — skip
        { ...ownerAddedEvent, eventId: 'g-gone', status: 'cancelled' }, // tombstone — additions-only ignores it
      ],
    }
    const res = await foldInOwnerAdditionsForDay('biz-1', WINDOW, { now: new Date('2026-07-05T15:00:00Z') })
    expect(res.ok).toBe(true)
    // Only the single owner-added, non-cancelled, non-PA event was folded in.
    expect(reconcileOwnerEventMock).toHaveBeenCalledTimes(1)
    expect(reconcileOwnerEventMock).toHaveBeenCalledWith(CONNECTED_CTX, ownerAddedEvent, 'read')
  })

  it('(b) a 2nd message within the TTL makes NO 2nd Google call (per business+focus-day throttle)', async () => {
    const t0 = new Date('2026-07-05T15:00:00Z')
    await foldInOwnerAdditionsForDay('biz-1', WINDOW, { now: t0 })
    expect(incrementalSyncMock).toHaveBeenCalledTimes(1)

    const t1 = new Date(t0.getTime() + 30_000) // 30s later, inside the ~90s TTL
    const res = await foldInOwnerAdditionsForDay('biz-1', WINDOW, { now: t1 })
    expect(res.skipped).toBe('throttled')
    expect(incrementalSyncMock).toHaveBeenCalledTimes(1) // still just one Google call

    // A DIFFERENT focus day is a distinct throttle key → allowed.
    const otherDay = { from: new Date('2026-07-06T00:00:00Z'), to: new Date('2026-07-07T00:00:00Z') }
    await foldInOwnerAdditionsForDay('biz-1', otherDay, { now: t1 })
    expect(incrementalSyncMock).toHaveBeenCalledTimes(2)

    // Past the TTL, the original day is refreshable again.
    const t2 = new Date(t0.getTime() + 120_000)
    await foldInOwnerAdditionsForDay('biz-1', WINDOW, { now: t2 })
    expect(incrementalSyncMock).toHaveBeenCalledTimes(3)
  })

  it('(c) Google timeout/error → served from the internal record, NOTHING mutated', async () => {
    h.incrementalResult = { status: 'error', reason: 'Google incrementalSync timed out after 4000ms' }
    const res = await foldInOwnerAdditionsForDay('biz-1', WINDOW, { now: new Date('2026-07-05T15:00:00Z') })
    expect(res.ok).toBe(false)
    // The reply is never blocked/errored by us; the caller serves the internal record.
    // Crucially: no fold-in ran, so nothing was mutated on a bad response.
    expect(reconcileOwnerEventMock).not.toHaveBeenCalled()
  })

  it('(c2) an errored attempt still consumes the throttle slot (no per-message error storm)', async () => {
    h.incrementalResult = { status: 'error', reason: 'boom' }
    const t0 = new Date('2026-07-05T15:00:00Z')
    await foldInOwnerAdditionsForDay('biz-1', WINDOW, { now: t0 })
    const res = await foldInOwnerAdditionsForDay('biz-1', WINDOW, { now: new Date(t0.getTime() + 10_000) })
    expect(res.skipped).toBe('throttled')
    expect(incrementalSyncMock).toHaveBeenCalledTimes(1)
  })

  it('(d) a non-Google business makes NO Google call at all', async () => {
    h.ctx = null // loadSyncContext returns null for a business not in connected-Google mode
    const res = await foldInOwnerAdditionsForDay('biz-1', WINDOW, { now: new Date('2026-07-05T15:00:00Z') })
    expect(res.skipped).toBe('not_google')
    expect(buildCalendarMock).not.toHaveBeenCalled()
    expect(incrementalSyncMock).not.toHaveBeenCalled()
    expect(reconcileOwnerEventMock).not.toHaveBeenCalled()
  })
})
