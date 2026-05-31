import { Worker, Queue } from 'bullmq'
import { redisConnection } from '../redis.js'
import { isInboundSyncEnabled, renewExpiringChannels } from '../domain/calendar/inbound-sync.js'

// Channel-renewal cron (Phase 3 inbound sync). Google push channels expire by
// time (~1 week for event channels) and notifications can drop, so this periodic
// pass re-registers channels nearing expiry and runs a safety full reconcile for
// the rest — the full reconcile is the real "always-synced" guarantee; push is an
// optimization (CALENDAR_UX_DESIGN.md §7). No-op while the feature flag is off.

const QUEUE_NAME = 'calendar-sync-renewal'
const REPEAT_EVERY_MS = 6 * 60 * 60 * 1000 // every 6h

export const calendarSyncRenewalQueue = new Queue(QUEUE_NAME, { connection: redisConnection })

export function startCalendarSyncRenewalWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      if (!isInboundSyncEnabled()) return
      await renewExpiringChannels()
    },
    { connection: redisConnection },
  )

  worker.on('failed', (job, err) => {
    console.error('[calendar-sync-renewal] Job failed', { jobId: job?.id, err: err.message })
  })

  return worker
}

export async function scheduleCalendarSyncRenewalJob() {
  await calendarSyncRenewalQueue.add(
    'tick',
    {},
    {
      repeat: { every: REPEAT_EVERY_MS },
      jobId: 'calendar-sync-renewal-tick',
    },
  )
}
