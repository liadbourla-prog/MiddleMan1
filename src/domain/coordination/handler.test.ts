// Mocks must be declared before any imports (vitest hoists these)
import { vi } from 'vitest'

vi.mock('./repository.js', () => ({
  updateCoordination: vi.fn().mockResolvedValue(undefined),
  getIdentityContact: vi.fn().mockResolvedValue({ phone: '+972500000000', name: 'Harel' }),
  insertCoordination: vi.fn().mockResolvedValue('coord_1'),
  findExpired: vi.fn().mockResolvedValue([]),
}))

vi.mock('../../adapters/whatsapp/sender.js', () => ({
  sendMessage: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('../../adapters/llm/client.js', () => ({
  generateProactiveCustomerMessage: vi.fn().mockResolvedValue('msg'),
}))

vi.mock('../audit/logger.js', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}))

import { describe, it, expect, beforeEach } from 'vitest'
import { advanceFromOwner, type BusinessCtx } from './handler.js'
import * as repo from './repository.js'
import type { CoordinationRow } from './repository.js'
import type { CalendarClient } from '../../adapters/calendar/client.js'

const ctx: BusinessCtx = {
  businessId: 'biz_1',
  businessName: 'Test Biz',
  lang: 'en',
  timezone: 'Asia/Jerusalem',
  waCredentials: undefined,
}

const start = new Date('2026-07-01T10:00:00.000Z')
const end = new Date('2026-07-01T10:30:00.000Z')

function makeRow(): CoordinationRow {
  return {
    id: 'coord_1',
    businessId: 'biz_1',
    ownerId: 'owner_1',
    contactId: 'contact_1',
    title: 'Intro call',
    durationMinutes: 30,
    candidateSlots: [{ start, end }],
    status: 'awaiting_owner_confirm',
    agreedSlotStart: start,
    agreedSlotEnd: end,
    expiresAt: new Date('2026-07-10T00:00:00.000Z'),
  }
}

const db = {} as never

describe('advanceFromOwner → book_and_notify', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // re-stub after clear
    ;(repo.getIdentityContact as ReturnType<typeof vi.fn>).mockResolvedValue({ phone: '+972500000000', name: 'Harel' })
  })

  it('books the agreed slot and persists confirmed when the calendar is free', async () => {
    const upsert = vi.fn().mockResolvedValue({ status: 'ok', eventId: 'evt_1', etag: null })
    const calendar = {
      checkAvailability: vi.fn().mockResolvedValue({ status: 'available' }),
      upsertMirrorEvent: upsert,
    } as unknown as CalendarClient

    await advanceFromOwner(db, calendar, makeRow(), { kind: 'confirm' }, ctx)

    expect(upsert).toHaveBeenCalledTimes(1)
    const updateCalls = (repo.updateCoordination as ReturnType<typeof vi.fn>).mock.calls
    const confirmedCall = updateCalls.find((c) => c[2]?.status === 'confirmed')
    expect(confirmedCall).toBeDefined()
    expect(confirmedCall![2]).toMatchObject({ status: 'confirmed', calendarEventId: 'evt_1' })
  })

  it('does NOT book or confirm when the agreed slot is now occupied', async () => {
    const upsert = vi.fn().mockResolvedValue({ status: 'ok', eventId: 'evt_1', etag: null })
    const calendar = {
      checkAvailability: vi.fn().mockResolvedValue({ status: 'occupied' }),
      upsertMirrorEvent: upsert,
    } as unknown as CalendarClient

    await advanceFromOwner(db, calendar, makeRow(), { kind: 'confirm' }, ctx)

    expect(upsert).not.toHaveBeenCalled()
    const updateCalls = (repo.updateCoordination as ReturnType<typeof vi.fn>).mock.calls
    const confirmedCall = updateCalls.find((c) => c[2]?.status === 'confirmed')
    expect(confirmedCall).toBeUndefined()
  })
})
