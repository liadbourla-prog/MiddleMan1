import { vi } from 'vitest'

vi.mock('./repository.js', () => ({
  updateCoordination: vi.fn().mockResolvedValue(undefined),
  getIdentityContact: vi.fn().mockResolvedValue({ phone: '+972500000000', name: 'Eyal' }),
  insertCoordination: vi.fn().mockResolvedValue('coord_1'),
  findExpired: vi.fn().mockResolvedValue([]),
}))
vi.mock('../../adapters/whatsapp/sender.js', () => ({ sendMessage: vi.fn().mockResolvedValue({ ok: true }) }))
vi.mock('../../adapters/llm/client.js', () => ({ generateProactiveCustomerMessage: vi.fn().mockResolvedValue('msg') }))
vi.mock('../audit/logger.js', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./interpret.js', () => ({ interpretContactReply: vi.fn() }))

import { describe, it, expect, beforeEach } from 'vitest'
import { advanceFromContact, type BusinessCtx } from './handler.js'
import { interpretContactReply } from './interpret.js'
import * as repo from './repository.js'
import type { CoordinationRow } from './repository.js'
import type { CalendarClient } from '../../adapters/calendar/client.js'

const ctx: BusinessCtx = { businessId: 'biz_1', businessName: 'Studyoga', lang: 'en', timezone: 'Asia/Jerusalem', waCredentials: undefined }
const calendar = {} as unknown as CalendarClient

function rowWithWindow(): CoordinationRow {
  return {
    id: 'coord_1', businessId: 'biz_1', ownerId: 'owner_1', contactId: 'eyal_1',
    title: 'פגישה עם אייל', durationMinutes: 90,
    candidateSlots: [],
    allowedWindows: [{ start: new Date('2026-06-24T08:00:00Z'), end: new Date('2026-06-24T12:00:00Z') }], // Wed 11–15 local
    status: 'awaiting_counterparty',
    agreedSlotStart: null, agreedSlotEnd: null, expiresAt: new Date('2026-07-10T00:00:00Z'),
  }
}

describe('advanceFromContact — windows', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(repo.getIdentityContact as ReturnType<typeof vi.fn>).mockResolvedValue({ phone: '+972500000000', name: 'Eyal' })
  })

  it('an in-window proposal moves to awaiting_owner_confirm', async () => {
    vi.mocked(interpretContactReply).mockResolvedValue({ kind: 'time', slot: { start: new Date('2026-06-24T09:00:00Z'), end: new Date('2026-06-24T10:30:00Z') } })
    await advanceFromContact({} as never, calendar, rowWithWindow(), 'Wednesday at 12', ctx)
    const calls = (repo.updateCoordination as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.find((c) => c[2]?.status === 'awaiting_owner_confirm')).toBeDefined()
  })

  it('an out-of-window proposal moves to countered (deviation surfaced)', async () => {
    vi.mocked(interpretContactReply).mockResolvedValue({ kind: 'time', slot: { start: new Date('2026-06-24T07:00:00Z'), end: new Date('2026-06-24T08:30:00Z') } })
    await advanceFromContact({} as never, calendar, rowWithWindow(), 'Wednesday at 10', ctx)
    const calls = (repo.updateCoordination as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.find((c) => c[2]?.status === 'countered')).toBeDefined()
  })
})
