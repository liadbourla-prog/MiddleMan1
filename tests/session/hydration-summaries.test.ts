import { describe, it, expect } from 'vitest'
import { buildHydratedContext } from '../../src/domain/session/hydration.js'
import { bookings, customerSessionNotes } from '../../src/db/schema.js'

// Routes by queried table. Supports the join/where/orderBy/limit chain used by
// buildHydratedContext. customer_session_notes can be made to throw to exercise
// the defensive degrade (table not yet migrated).
function makeDb(opts: { bookings?: unknown[]; notes?: unknown[]; notesThrows?: boolean }) {
  return {
    select() {
      const state: { tbl?: unknown } = {}
      const chain: Record<string, unknown> = {
        from(tbl: unknown) { state.tbl = tbl; return chain },
        leftJoin() { return chain },
        where() { return chain },
        orderBy() { return chain },
        limit() { return chain },
        then(res: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) {
          if (state.tbl === customerSessionNotes) {
            if (opts.notesThrows) return Promise.reject(new Error('relation "customer_session_notes" does not exist')).then(res, rej)
            return Promise.resolve(opts.notes ?? []).then(res, rej)
          }
          if (state.tbl === bookings) return Promise.resolve(opts.bookings ?? []).then(res, rej)
          return Promise.resolve([]).then(res, rej)
        },
      }
      return chain
    },
  }
}

describe('buildHydratedContext — cross-session summaries (A2)', () => {
  it('loads the last few conversation summaries newest-first', async () => {
    const db = makeDb({ notes: [{ summary: 'asked about prenatal yoga, evenings' }, { summary: 'wanted to book for a friend' }] })
    const ctx = await buildHydratedContext(db as never, 'id-1', 'biz-1', null)
    expect(ctx.sessionSummaries).toEqual(['asked about prenatal yoga, evenings', 'wanted to book for a friend'])
    expect(ctx.recentBookings).toEqual([])
    expect(ctx.upcomingBooking).toBeNull()
  })

  it('degrades to no summaries when the table is missing (migration not yet applied)', async () => {
    const db = makeDb({ notesThrows: true })
    const ctx = await buildHydratedContext(db as never, 'id-1', 'biz-1', null)
    expect(ctx.sessionSummaries).toEqual([])
  })
})
