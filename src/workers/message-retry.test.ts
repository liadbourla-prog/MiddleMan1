import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../adapters/whatsapp/sender.js', () => ({
  sendMessage: vi.fn(async () => ({ ok: true as const })),
}))

vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [
      { phoneNumberId: 'PNID_199346', accessToken: 'TOKEN_BIZ' },
    ] }) }) }),
  },
}))

import { buildSendArgs } from './message-retry.js'
import { sendMessage } from '../adapters/whatsapp/sender.js'

const sendMessageMock = sendMessage as ReturnType<typeof vi.fn>

describe('message-retry worker credential resolution', () => {
  beforeEach(() => sendMessageMock.mockClear())

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
    // Make the db mock's limit throw so any db access would surface as a failure
    const { db } = await import('../db/client.js')
    const dbMock = db as unknown as { select: ReturnType<typeof vi.fn> }
    const originalSelect = dbMock.select
    dbMock.select = vi.fn(() => { throw new Error('db must not be called for global-credential sends') })

    try {
      const args = await buildSendArgs({ businessId: 'biz-1', toNumber: '+1', body: 'x', useGlobalCredentials: true })
      expect(args.credentials).toBeUndefined()
      expect(args.toNumber).toBe('+1')
      expect(args.body).toBe('x')
    } finally {
      dbMock.select = originalSelect
    }
  })
})
