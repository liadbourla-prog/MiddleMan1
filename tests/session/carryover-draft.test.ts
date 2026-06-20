import { describe, it, expect } from 'vitest'
import { loadSessionCarryover } from '../../src/domain/session/hydration.js'
import { conversationSessions, conversationMessages } from '../../src/db/schema.js'

// Root C: a booking draft is carried across a session boundary ONLY from a recent,
// genuinely mid-flow prior session — and never live holds / reschedule targets.
function makeDb(prev: { state: string; context: unknown; lastMessageAt: Date } | null) {
  return {
    select() {
      const state: { tbl?: unknown } = {}
      const chain: Record<string, unknown> = {
        from(tbl: unknown) { state.tbl = tbl; return chain },
        where() { return chain },
        orderBy() { return chain },
        limit() { return chain },
        then(res: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) {
          if (state.tbl === conversationSessions) return Promise.resolve(prev ? [prev] : []).then(res, rej)
          if (state.tbl === conversationMessages) return Promise.resolve([{ role: 'customer', text: 'yoga tuesday' }]).then(res, rej)
          return Promise.resolve([]).then(res, rej)
        },
      }
      return chain
    },
  }
}

const NOW = new Date('2026-06-19T12:00:00Z')
const DRAFT = { serviceTypeId: 's1', serviceName: 'יוגה', dateStr: '2026-06-23' }

describe('loadSessionCarryover — Root C draft carry', () => {
  it('carries the draft from a recent mid-flow (waiting_clarification) session', async () => {
    const db = makeDb({
      state: 'waiting_clarification',
      context: { slotDraft: DRAFT, greeted: true },
      lastMessageAt: new Date(NOW.getTime() - 10 * 60 * 1000), // 10 min ago
    })
    const out = await loadSessionCarryover(db as never, 'id1', NOW)
    expect(out?.carriedDraft).toEqual(DRAFT)
  })

  it('does NOT carry from a completed session', async () => {
    const db = makeDb({
      state: 'completed',
      context: { slotDraft: DRAFT },
      lastMessageAt: new Date(NOW.getTime() - 10 * 60 * 1000),
    })
    const out = await loadSessionCarryover(db as never, 'id1', NOW)
    expect(out?.carriedDraft).toBeUndefined()
  })

  it('does NOT carry a stale draft (older than the 90-min window)', async () => {
    const db = makeDb({
      state: 'waiting_confirmation',
      context: { slotDraft: DRAFT },
      lastMessageAt: new Date(NOW.getTime() - 120 * 60 * 1000), // 2h ago
    })
    const out = await loadSessionCarryover(db as never, 'id1', NOW)
    expect(out?.carriedDraft).toBeUndefined()
  })

  it('never carries live holds or reschedule targets — only the draft shape', async () => {
    const db = makeDb({
      state: 'waiting_confirmation',
      context: {
        slotDraft: DRAFT,
        pendingSlot: { start: 'x', end: 'y', serviceTypeId: 's1', serviceName: 'יוגה' },
        pendingBookingId: 'b1',
        rescheduledFrom: 'b0',
      },
      lastMessageAt: new Date(NOW.getTime() - 5 * 60 * 1000),
    })
    const out = await loadSessionCarryover(db as never, 'id1', NOW)
    expect(out?.carriedDraft).toEqual(DRAFT)
    // The carryover surface exposes no hold/reschedule fields at all.
    expect(out).not.toHaveProperty('pendingSlot')
    expect(out).not.toHaveProperty('pendingBookingId')
    expect(out).not.toHaveProperty('rescheduledFrom')
  })
})
