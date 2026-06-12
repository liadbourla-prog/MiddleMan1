import { describe, it, expect } from 'vitest'
import { loadSessionCarryover } from '../../src/domain/session/hydration.js'
import { conversationSessions, conversationMessages } from '../../src/db/schema.js'

// Routes resolved rows by queried table; where/orderBy/limit are ignored — the
// carryover window + flag/transcript logic is what's under test.
function makeDb(data: { session?: unknown; messages?: unknown[] }) {
  return {
    select() {
      const state: { tbl?: unknown } = {}
      const chain: Record<string, unknown> = {
        from(tbl: unknown) { state.tbl = tbl; return chain },
        where() { return chain },
        orderBy() { return chain },
        limit() { return chain },
        then(res: (v: unknown[]) => unknown, rej?: (e: unknown) => unknown) {
          let rows: unknown[] = []
          if (state.tbl === conversationSessions) rows = data.session ? [data.session] : []
          else if (state.tbl === conversationMessages) rows = data.messages ?? []
          return Promise.resolve(rows).then(res, rej)
        },
      }
      return chain
    },
  }
}

const NOW = new Date('2026-06-12T12:00:00.000Z')

describe('loadSessionCarryover', () => {
  it('carries the prior session tail + greeted/language flags when recent', async () => {
    const db = makeDb({
      session: {
        id: 's1',
        context: { greeted: true, detectedLanguage: 'he', languageOverride: 'en' },
        lastMessageAt: new Date(NOW.getTime() - 60 * 60_000), // 1h ago
      },
      // DB returns newest-first; loader reverses to oldest-first.
      messages: [
        { role: 'assistant', text: 'second' },
        { role: 'customer', text: 'first' },
      ],
    })

    const out = await loadSessionCarryover(db as never, 'id-1', NOW)
    expect(out).not.toBeNull()
    expect(out!.greeted).toBe(true)
    expect(out!.detectedLanguage).toBe('he')
    expect(out!.languageOverride).toBe('en')
    expect(out!.priorTurns.map((t) => t.text)).toEqual(['first', 'second'])
  })

  it('returns null when the prior session is older than the window', async () => {
    const db = makeDb({
      session: { id: 's1', context: { greeted: true }, lastMessageAt: new Date(NOW.getTime() - 7 * 60 * 60_000) }, // 7h ago
      messages: [{ role: 'customer', text: 'x' }],
    })
    expect(await loadSessionCarryover(db as never, 'id-1', NOW)).toBeNull()
  })

  it('returns null when there is no prior session', async () => {
    expect(await loadSessionCarryover(makeDb({}) as never, 'id-1', NOW)).toBeNull()
  })

  it('defaults greeted=false and omits language when the prior context lacks them', async () => {
    const db = makeDb({
      session: { id: 's1', context: {}, lastMessageAt: new Date(NOW.getTime() - 5 * 60_000) },
      messages: [{ role: 'customer', text: 'hi' }],
    })
    const out = await loadSessionCarryover(db as never, 'id-1', NOW)
    expect(out!.greeted).toBe(false)
    expect(out!.detectedLanguage).toBeUndefined()
    expect(out!.languageOverride).toBeUndefined()
  })
})
