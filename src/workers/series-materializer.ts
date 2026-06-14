import { Worker, Queue } from 'bullmq'
import { eq } from 'drizzle-orm'
import { db } from '../db/client.js'
import { classSeries } from '../db/schema.js'
import { materializeSeries } from '../domain/scheduling/series.js'
import { redisConnection } from '../redis.js'

const QUEUE_NAME = 'series-materializer'
const REPEAT_EVERY_MS = 24 * 60 * 60_000 // daily — rolls the recurrence horizon forward

export const seriesMaterializerQueue = new Queue(QUEUE_NAME, { connection: redisConnection })

/**
 * Daily sweep that rolls the recurrence horizon forward: every active series is
 * (idempotently) materialized into concrete calendar_blocks for the next horizon
 * window. New series are also materialized on creation (see manager apply), so
 * this worker only fills the rolling edge — it never duplicates existing instances.
 */
export function startSeriesMaterializerWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      const active = await db
        .select({ id: classSeries.id })
        .from(classSeries)
        .where(eq(classSeries.isActive, true))

      let created = 0
      for (const s of active) {
        const res = await materializeSeries(db, s.id).catch((err) => {
          console.warn('[series-materializer] Failed to materialize series', { seriesId: s.id, err })
          return { created: 0, seriesId: s.id }
        })
        created += res.created
      }
      if (created > 0) {
        console.info(`[series-materializer] Materialized ${created} new class instance(s) across ${active.length} series`)
      }
    },
    { connection: redisConnection },
  )

  worker.on('failed', (job, err) => {
    console.error('[series-materializer] Job failed', { jobId: job?.id, err })
  })

  seriesMaterializerQueue
    .add('tick', {}, { repeat: { every: REPEAT_EVERY_MS }, jobId: 'series-materializer-tick' })
    .catch((err) => console.error('[series-materializer] Failed to schedule job', err))

  return worker
}
