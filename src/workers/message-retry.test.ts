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
})
