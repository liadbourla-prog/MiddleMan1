/**
 * T2.2 — the reconcile TICK loop (freshness), separate from the channel-expiry renewal.
 *
 * BullMQ + redis are mocked so importing the module doesn't open a connection. We test the
 * two pure-ish seams: the cadence knob (default / disable) and runReconcileTick's gating +
 * per-connected-business fan-out into runInboundSync(..., 'tick') on the stored syncToken.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({
  enabled: true,
  channelRows: [] as Array<{ businessId: string }>,
  runInboundSyncMock: vi.fn(async () => ({ ok: true })),
}))
const runInboundSyncMock = h.runInboundSyncMock

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation(() => ({ on: vi.fn() })),
  Queue: vi.fn().mockImplementation(() => ({ add: vi.fn(async () => undefined) })),
}))
vi.mock('../redis.js', () => ({ redisConnection: {} }))
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => h.channelRows }) }),
  },
}))

vi.mock('../domain/calendar/inbound-sync.js', () => ({
  isInboundSyncEnabled: () => h.enabled,
  runInboundSync: h.runInboundSyncMock,
}))

import { runReconcileTick, reconcileTickIntervalMs } from './calendar-reconcile-tick.js'

beforeEach(() => {
  vi.clearAllMocks()
  h.enabled = true
  h.channelRows = []
  delete process.env['CALENDAR_RECONCILE_TICK_MS']
})
afterEach(() => { delete process.env['CALENDAR_RECONCILE_TICK_MS'] })

describe('reconcileTickIntervalMs — cadence knob', () => {
  it('defaults to 10 minutes when unset', () => {
    expect(reconcileTickIntervalMs()).toBe(10 * 60 * 1000)
  })
  it('honours an explicit override', () => {
    process.env['CALENDAR_RECONCILE_TICK_MS'] = '120000'
    expect(reconcileTickIntervalMs()).toBe(120_000)
  })
  it('is disabled by 0 / off / empty', () => {
    for (const v of ['0', 'off', '']) {
      process.env['CALENDAR_RECONCILE_TICK_MS'] = v
      expect(reconcileTickIntervalMs()).toBeNull()
    }
  })
})

describe('runReconcileTick — gating + fan-out', () => {
  it('no-op when isInboundSyncEnabled() is false (regression guard)', async () => {
    h.enabled = false
    h.channelRows = [{ businessId: 'biz-1' }]
    await runReconcileTick()
    expect(runInboundSyncMock).not.toHaveBeenCalled()
  })

  it('runs an incremental (stored-token) sync per Google-connected business, tagged "tick"', async () => {
    h.channelRows = [{ businessId: 'biz-1' }, { businessId: 'biz-2' }]
    await runReconcileTick()
    expect(runInboundSyncMock).toHaveBeenCalledTimes(2)
    // {} (not { full: true }) ⇒ the stored syncToken is reused — no full-scan storm.
    expect(runInboundSyncMock).toHaveBeenNthCalledWith(1, 'biz-1', {}, 'tick')
    expect(runInboundSyncMock).toHaveBeenNthCalledWith(2, 'biz-2', {}, 'tick')
  })

  it('isolates a per-business failure so the rest of the fleet still runs', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    h.channelRows = [{ businessId: 'biz-1' }, { businessId: 'biz-2' }]
    runInboundSyncMock.mockRejectedValueOnce(new Error('boom'))
    await runReconcileTick()
    expect(runInboundSyncMock).toHaveBeenCalledTimes(2)
    errSpy.mockRestore()
  })
})
