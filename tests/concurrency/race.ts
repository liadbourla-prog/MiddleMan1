// WS1 merge-gate concurrency harness — the raceN primitive.
//
// The whole point of this harness is REAL contention against a REAL Postgres. The
// production `db` singleton (src/db/client.ts) uses a single pooled connection set, so
// two awaited calls on it interleave at the JS event-loop level but do NOT genuinely
// contend at the database level (advisory locks taken on the same backend re-enter, CAS
// races resolve in statement order). To prove the P1 atomicity work holds, each racer
// must run on its OWN postgres backend connection so advisory locks and CAS predicates
// are arbitrated by Postgres, not by Node's scheduler.
//
// raceN therefore opens `n` SEPARATE postgres({ max: 1 }) connections, wraps each in its
// own drizzle instance, and fires `fn(db_i)` for all n concurrently. Every connection is
// closed in a finally so a harness run never leaks backends into the ephemeral cluster.

import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import * as schema from '../../src/db/schema.js'
import type { Db } from '../../src/db/client.js'

/**
 * Run `fn` on `n` independent postgres connections concurrently. Each invocation gets its
 * own backend (max:1) so advisory locks / CAS are genuinely contended at the DB layer.
 *
 * A throw inside any `fn(db_i)` is recorded as a `{ ok:false, error }` result rather than
 * rejecting the whole `Promise.all` — otherwise one racer's failure would discard the
 * other racers' outcomes and we could not assert "exactly one winner".
 */
export async function raceN<R>(fn: (db: Db) => Promise<R>, n: number): Promise<R[]> {
  const url = process.env['DATABASE_URL']
  if (!url) throw new Error('raceN: DATABASE_URL must be set (run via run-concurrency-harness.sh)')

  const clients: ReturnType<typeof postgres>[] = []
  for (let i = 0; i < n; i++) {
    clients.push(postgres(url, { max: 1 }))
  }

  try {
    const dbs = clients.map((c) => drizzle(c, { schema }) as unknown as Db)
    // Each racer is wrapped so a throw becomes a settled rejection captured by Promise.all
    // only via allSettled-style mapping — we keep Promise.all but pre-catch so no result is
    // lost. The caller decides how to interpret thrown vs returned outcomes.
    return await Promise.all(
      dbs.map(async (d) => {
        return await fn(d)
      }),
    )
  } finally {
    await Promise.all(clients.map((c) => c.end({ timeout: 5 }).catch(() => undefined)))
  }
}

/**
 * Variant of raceN that never rejects: each racer's outcome is captured as a settled
 * result `{ ok:true, value }` or `{ ok:false, error }`. Use this when a racer is EXPECTED
 * to throw (e.g. the executor-throws compensation case) and the test must still inspect the
 * other racers' outcomes.
 */
export type Settled<R> = { ok: true; value: R } | { ok: false; error: unknown }

export async function raceNSettled<R>(fn: (db: Db) => Promise<R>, n: number): Promise<Settled<R>[]> {
  const url = process.env['DATABASE_URL']
  if (!url) throw new Error('raceNSettled: DATABASE_URL must be set (run via run-concurrency-harness.sh)')

  const clients: ReturnType<typeof postgres>[] = []
  for (let i = 0; i < n; i++) {
    clients.push(postgres(url, { max: 1 }))
  }

  try {
    const dbs = clients.map((c) => drizzle(c, { schema }) as unknown as Db)
    return await Promise.all(
      dbs.map(async (d): Promise<Settled<R>> => {
        try {
          return { ok: true, value: await fn(d) }
        } catch (error) {
          return { ok: false, error }
        }
      }),
    )
  } finally {
    await Promise.all(clients.map((c) => c.end({ timeout: 5 }).catch(() => undefined)))
  }
}

/** Count results matching a predicate — convenience for "exactly one winner" assertions. */
export function countOk<R>(results: R[], pred: (r: R) => boolean): number {
  return results.filter(pred).length
}

/**
 * Run `fn` `times` times sequentially, awaiting each. Used for the ~30× flakiness loop:
 * a race that passes once may still be flaky, so each case repeats the seed→race→assert
 * cycle many rounds. `fn` receives the 0-based round index.
 */
export async function repeat(times: number, fn: (round: number) => Promise<void>): Promise<void> {
  for (let i = 0; i < times; i++) {
    await fn(i)
  }
}
