import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mutable slot — individual tests can swap the resolved rows.
let dbLimitResult: unknown[] = [
  { phoneNumberId: 'PNID_199346', accessToken: 'TOKEN_BIZ' },
]

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => dbLimitResult }) }) }),
  },
}))

import { buildSendArgs } from './message-retry.js'

describe('message-retry worker credential resolution', () => {
  beforeEach(() => {
    // Reset to the happy-path row before each test.
    dbLimitResult = [{ phoneNumberId: 'PNID_199346', accessToken: 'TOKEN_BIZ' }]
  })

  it('resolves per-business WA credentials from businessId', async () => {
    const { credentials } = await buildSendArgs({ businessId: 'biz-1', toNumber: '+972500000000', body: 'hi' })
    expect(credentials).toEqual({ accessToken: 'TOKEN_BIZ', phoneNumberId: 'PNID_199346' })
  })

  it('passes through recipient and body', async () => {
    const args = await buildSendArgs({ businessId: 'biz-1', toNumber: '+972500000000', body: 'hi' })
    expect(args.toNumber).toBe('+972500000000')
    expect(args.body).toBe('hi')
  })

  it('returns credentials: undefined and skips db when useGlobalCredentials is true', async () => {
    const args = await buildSendArgs({ businessId: 'biz-1', toNumber: '+1', body: 'x', useGlobalCredentials: true })
    expect(args.credentials).toBeUndefined()
    expect(args.toNumber).toBe('+1')
    expect(args.body).toBe('x')
  })

  it('returns credentials: undefined when db has no matching business row', async () => {
    dbLimitResult = []
    const args = await buildSendArgs({ businessId: 'biz-x', toNumber: '+1', body: 'x' })
    expect(args.credentials).toBeUndefined()
  })

  it('returns credentials: undefined when db row has null credentials', async () => {
    dbLimitResult = [{ phoneNumberId: null, accessToken: null }]
    const args = await buildSendArgs({ businessId: 'biz-x', toNumber: '+1', body: 'x' })
    expect(args.credentials).toBeUndefined()
  })
})
