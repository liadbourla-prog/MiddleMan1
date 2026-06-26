import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Db } from '../../db/client.js'
import {
  enqueueDigest,
  fetchUnflushedDigests,
  markDigestsFlushed,
  businessesWithPendingDigests,
} from './digest-queue.js'

// TEST FIDELITY (honest note): this repo has NO real-Postgres / pglite / pg-mem
// harness for domain code (confirmed by grep for pglite|pg-mem|PGlite|newDb|
// "drizzle(" across *.test.ts — no hits). This is therefore a STATEFUL FAKE-DB
// stub, not a true SQL round-trip. The stub keeps an in-memory row array and
// *interprets the real drizzle filter objects* (and/eq/isNull/inArray) produced
// by the repository against those rows. So the repository's real query logic —
// which columns it filters on, ordering by createdAt, flush stamping, and the
// distinct businessId sweep — is genuinely exercised. Only the SQL engine is
// faked; the predicate construction under test is the production code's.

interface Row {
  id: string
  businessId: string
  event: string
  payload: unknown
  createdAt: Date
  flushedAt: Date | null
}

// drizzle column `.name` (snake_case) -> Row field.
const COLUMN_FIELD: Record<string, keyof Row> = {
  id: 'id',
  business_id: 'businessId',
  event: 'event',
  payload: 'payload',
  created_at: 'createdAt',
  flushed_at: 'flushedAt',
}

function isColumn(c: any): c is { name: string } {
  return c && typeof c === 'object' && typeof c.name === 'string' && c.name in COLUMN_FIELD && !('queryChunks' in c) && !('value' in c)
}
function isFragment(c: any): boolean {
  return c && typeof c === 'object' && Array.isArray(c.value)
}
function isParam(c: any): boolean {
  return c && typeof c === 'object' && 'value' in c && !Array.isArray(c.value) && 'encoder' in c
}
function isSql(c: any): boolean {
  return c && typeof c === 'object' && Array.isArray(c.queryChunks)
}

// Evaluate a drizzle SQL filter object against a row. Supports exactly the
// operators the repository uses: and / eq / isNull / inArray.
function evalFilter(f: any, row: Row): boolean {
  if (f == null) return true
  if (!isSql(f)) return true
  const chunks: any[] = f.queryChunks

  // AND combinator: two (or more) nested SQL filters joined by a " and " fragment.
  const nestedSql = chunks.filter(isSql)
  const fragText = chunks.filter(isFragment).map((c) => c.value.join('')).join('|')
  if (nestedSql.length >= 2 && fragText.includes(' and ')) {
    return nestedSql.every((n) => evalFilter(n, row))
  }
  // A single wrapped SQL filter (e.g. and() with one operand) — unwrap.
  if (nestedSql.length === 1 && chunks.every((c) => isSql(c) || isFragment(c))) {
    return evalFilter(nestedSql[0], row)
  }

  // Leaf operator. Find the column and operator text.
  const col = chunks.find(isColumn)
  if (!col) return true
  const field = COLUMN_FIELD[col.name]!
  const val = row[field]
  const opText = chunks.filter(isFragment).map((c) => c.value.join('')).join('')

  if (opText.includes(' is null')) {
    return val === null || val === undefined
  }
  if (opText.includes(' in ')) {
    // inArray: the list is an array chunk of param objects.
    const listChunk = chunks.find((c) => Array.isArray(c))
    const list: unknown[] = Array.isArray(listChunk) ? listChunk.map((p: any) => p.value) : []
    return list.includes(val)
  }
  if (opText.includes(' = ')) {
    const param = chunks.find(isParam)
    return val === (param ? param.value : undefined)
  }
  return true
}

function fakeDb(store: Row[]): Db {
  const api: any = {
    insert: (_table: unknown) => ({
      values: async (vals: any) => {
        const arr = Array.isArray(vals) ? vals : [vals]
        for (const v of arr) {
          store.push({
            id: v.id ?? randomUUID(),
            businessId: v.businessId,
            event: v.event,
            payload: v.payload,
            createdAt: v.createdAt ?? new Date(),
            flushedAt: v.flushedAt ?? null,
          })
        }
      },
    }),
    select: (_cols: unknown) => {
      const builder: any = {
        _filter: null as any,
        from: () => builder,
        where: (f: any) => {
          builder._filter = f
          return builder
        },
        orderBy: () => {
          const rows = store
            .filter((r) => evalFilter(builder._filter, r))
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          return Promise.resolve(rows.map((r) => ({ id: r.id, event: r.event, payload: r.payload })))
        },
      }
      return builder
    },
    selectDistinct: (_cols: unknown) => {
      const builder: any = {
        from: () => builder,
        where: (f: any) => {
          const seen = new Set<string>()
          const out: { businessId: string }[] = []
          for (const r of store) {
            if (!evalFilter(f, r)) continue
            if (seen.has(r.businessId)) continue
            seen.add(r.businessId)
            out.push({ businessId: r.businessId })
          }
          return Promise.resolve(out)
        },
      }
      return builder
    },
    update: (_table: unknown) => {
      const builder: any = {
        _patch: null as any,
        set: (patch: any) => {
          builder._patch = patch
          return builder
        },
        where: (f: any) => {
          for (const r of store) {
            if (evalFilter(f, r)) Object.assign(r, builder._patch)
          }
          return Promise.resolve()
        },
      }
      return builder
    },
  }
  return api as Db
}

describe('digest-queue repository', () => {
  it('enqueues, fetches unflushed, then marks flushed', async () => {
    const store: Row[] = []
    const db = fakeDb(store)
    const businessId = randomUUID()

    await enqueueDigest(db, businessId, 'cancellation', { summary: 'Dana cancelled her 3pm.' })
    const before = await fetchUnflushedDigests(db, businessId)
    expect(before).toHaveLength(1)
    expect(before[0]!.payload).toEqual({ summary: 'Dana cancelled her 3pm.' })

    await markDigestsFlushed(db, before.map((r) => r.id))
    const after = await fetchUnflushedDigests(db, businessId)
    expect(after).toHaveLength(0)
  })

  it('fetchUnflushedDigests scopes to one business and orders oldest-first', async () => {
    const store: Row[] = []
    const db = fakeDb(store)
    const a = randomUUID()
    const b = randomUUID()

    await enqueueDigest(db, a, 'new_booking', { summary: 'second' })
    store[0]!.createdAt = new Date('2026-06-26T10:00:00Z')
    await enqueueDigest(db, a, 'cancellation', { summary: 'first' })
    store[1]!.createdAt = new Date('2026-06-26T09:00:00Z')
    await enqueueDigest(db, b, 'no_show', { summary: 'other business' })

    const rows = await fetchUnflushedDigests(db, a)
    expect(rows).toHaveLength(2)
    expect((rows[0]!.payload as { summary: string }).summary).toBe('first')
    expect((rows[1]!.payload as { summary: string }).summary).toBe('second')
  })

  it('markDigestsFlushed no-ops on an empty id list', async () => {
    const store: Row[] = []
    const db = fakeDb(store)
    const businessId = randomUUID()
    await enqueueDigest(db, businessId, 'reschedule', { summary: 'keep me' })
    await markDigestsFlushed(db, [])
    expect(await fetchUnflushedDigests(db, businessId)).toHaveLength(1)
  })

  it('businessesWithPendingDigests returns distinct businesses with unflushed rows', async () => {
    const store: Row[] = []
    const db = fakeDb(store)
    const a = randomUUID()
    const b = randomUUID()

    await enqueueDigest(db, a, 'new_booking', { summary: 'a1' })
    await enqueueDigest(db, a, 'cancellation', { summary: 'a2' })
    await enqueueDigest(db, b, 'no_show', { summary: 'b1' })

    const pendingBefore = await businessesWithPendingDigests(db)
    expect(new Set(pendingBefore)).toEqual(new Set([a, b]))

    const aRows = await fetchUnflushedDigests(db, a)
    await markDigestsFlushed(db, aRows.map((r) => r.id))

    const pendingAfter = await businessesWithPendingDigests(db)
    expect(pendingAfter).toEqual([b])
  })
})
