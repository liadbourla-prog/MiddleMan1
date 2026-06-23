import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { InboundMessage } from '../../src/adapters/whatsapp/types.js'

// In-memory fake of the two Lua scripts the coalescer runs against Redis.
const lists = new Map<string, string[]>()
const seqs = new Map<string, number>()

vi.mock('../../src/redis.js', () => ({
  redis: {
    eval: async (script: string, _numKeys: number, ...rest: string[]) => {
      if (script.includes('RPUSH')) {
        // ENQUEUE: KEYS[1]=buf KEYS[2]=seq ARGV[1]=json ARGV[2]=ttl
        const [bufKey, seqKey, json] = rest
        const list = lists.get(bufKey!) ?? []
        list.push(json!)
        lists.set(bufKey!, list)
        const n = (seqs.get(seqKey!) ?? 0) + 1
        seqs.set(seqKey!, n)
        return n
      }
      // FLUSH: KEYS[1]=seq KEYS[2]=buf ARGV[1]=expectedSeq
      const [seqKey, bufKey, expected] = rest
      if (String(seqs.get(seqKey!)) === expected) {
        const items = [...(lists.get(bufKey!) ?? [])]
        lists.delete(bufKey!)
        seqs.delete(seqKey!)
        return items
      }
      return []
    },
  },
  redisConnection: {},
}))

const { bufferInbound, flushBurst, combineInbound, shouldBypassCoalescing, debounceMsForRole } =
  await import('../../src/domain/flows/message-coalescer.js')

function mkMsg(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 'm1',
    fromNumber: '+15550001',
    toNumber: '+15559999',
    body: 'hello',
    timestamp: new Date('2026-06-23T10:00:00Z'),
    rawPayload: {},
    ...over,
  }
}

const BIZ = 'biz-1'
const ID = 'cust-1'

beforeEach(() => {
  lists.clear()
  seqs.clear()
})

describe('bufferInbound + flushBurst', () => {
  it('returns increasing sequence numbers within a burst', async () => {
    expect(await bufferInbound(BIZ, ID, mkMsg({ messageId: 'a' }))).toBe(1)
    expect(await bufferInbound(BIZ, ID, mkMsg({ messageId: 'b' }))).toBe(2)
    expect(await bufferInbound(BIZ, ID, mkMsg({ messageId: 'c' }))).toBe(3)
  })

  it('only the last message of the burst flushes; earlier seqs get null', async () => {
    const s1 = await bufferInbound(BIZ, ID, mkMsg({ messageId: 'a', body: 'one' }))
    const s2 = await bufferInbound(BIZ, ID, mkMsg({ messageId: 'b', body: 'two' }))
    const s3 = await bufferInbound(BIZ, ID, mkMsg({ messageId: 'c', body: 'three' }))

    // Earlier scheduled flushes see a newer seq → no-op.
    expect(await flushBurst(BIZ, ID, s1)).toBeNull()
    expect(await flushBurst(BIZ, ID, s2)).toBeNull()

    // The last message wins and drains the whole burst in order.
    const burst = await flushBurst(BIZ, ID, s3)
    expect(burst?.map((m) => m.body)).toEqual(['one', 'two', 'three'])
  })

  it('clears state after a flush so the next burst starts fresh', async () => {
    const s1 = await bufferInbound(BIZ, ID, mkMsg({ body: 'first burst' }))
    await flushBurst(BIZ, ID, s1)

    expect(await bufferInbound(BIZ, ID, mkMsg({ body: 'second burst' }))).toBe(1)
  })

  it('keeps separate bursts per conversation', async () => {
    await bufferInbound(BIZ, 'cust-A', mkMsg())
    expect(await bufferInbound(BIZ, 'cust-B', mkMsg())).toBe(1)
  })

  it('revives timestamps as Date objects', async () => {
    const s = await bufferInbound(BIZ, ID, mkMsg())
    const burst = await flushBurst(BIZ, ID, s)
    expect(burst?.[0]?.timestamp).toBeInstanceOf(Date)
  })
})

describe('combineInbound', () => {
  it('joins bodies with newlines and keeps the last messageId', () => {
    const combined = combineInbound([
      mkMsg({ messageId: 'a', body: 'stuck at hospital' }),
      mkMsg({ messageId: 'b', body: 'free up my 6pm' }),
      mkMsg({ messageId: 'c', body: 'thursday 7am instead?' }),
    ])
    expect(combined.body).toBe('stuck at hospital\nfree up my 6pm\nthursday 7am instead?')
    expect(combined.messageId).toBe('c')
  })

  it('is a no-op shape for a single message', () => {
    const combined = combineInbound([mkMsg({ messageId: 'solo', body: 'just one' })])
    expect(combined.body).toBe('just one')
    expect(combined.messageId).toBe('solo')
  })
})

describe('shouldBypassCoalescing', () => {
  it('bypasses any message carrying an image', () => {
    expect(shouldBypassCoalescing(mkMsg({ imageMediaId: 'img1' }), 'customer')).toBe(true)
    expect(shouldBypassCoalescing(mkMsg({ imageMediaId: 'img1' }), 'manager')).toBe(true)
  })

  it('bypasses manager keyword commands (exact and prefix)', () => {
    expect(shouldBypassCoalescing(mkMsg({ body: 'STATUS' }), 'manager')).toBe(true)
    expect(shouldBypassCoalescing(mkMsg({ body: ' pause ' }), 'manager')).toBe(true)
    expect(shouldBypassCoalescing(mkMsg({ body: 'BOOKINGS tomorrow' }), 'delegated_user')).toBe(true)
    expect(shouldBypassCoalescing(mkMsg({ body: 'PAID +15551234' }), 'manager')).toBe(true)
  })

  it('does not treat keyword-like customer text as a command', () => {
    expect(shouldBypassCoalescing(mkMsg({ body: 'STATUS' }), 'customer')).toBe(false)
    expect(shouldBypassCoalescing(mkMsg({ body: 'I want a haircut' }), 'manager')).toBe(false)
  })
})

describe('debounceMsForRole', () => {
  it('gives managers a wider window than customers', () => {
    expect(debounceMsForRole('manager')).toBeGreaterThan(debounceMsForRole('customer'))
    expect(debounceMsForRole('delegated_user')).toBe(debounceMsForRole('manager'))
  })
})
