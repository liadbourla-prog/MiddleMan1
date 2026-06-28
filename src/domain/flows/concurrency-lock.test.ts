import { describe, it, expect, vi, beforeEach } from 'vitest'

// In-memory redis stub: SET NX PX + DEL-if-match semantics enough for the lock.
const store = new Map<string, string>()
vi.mock('../../redis.js', () => ({
  redis: {
    set: async (k: string, v: string, _px: string, _ms: number, nx: string) => {
      if (nx === 'NX' && store.has(k)) return null
      store.set(k, v); return 'OK'
    },
    eval: async (_s: string, _n: number, k: string, v: string) => {
      if (store.get(k) === v) { store.delete(k); return 1 } return 0
    },
    rpush: async () => 1, expire: async () => 1, lpop: async () => null,
  },
}))

import { withIdentityLock } from './concurrency-lock.js'

beforeEach(() => store.clear())

describe('withIdentityLock', () => {
  it('serializes two concurrent runs for the same identity', async () => {
    const order: string[] = []
    const slow = withIdentityLock('id1', async () => { order.push('a-start'); await new Promise(r => setTimeout(r, 50)); order.push('a-end') })
    const fast = withIdentityLock('id1', async () => { order.push('b-run') })
    await Promise.all([slow, fast])
    expect(order).toEqual(['a-start', 'a-end', 'b-run'])
  })
  it('returns the inner result', async () => {
    const r = await withIdentityLock('id2', async () => 42)
    expect(r).toBe(42)
  })
})
