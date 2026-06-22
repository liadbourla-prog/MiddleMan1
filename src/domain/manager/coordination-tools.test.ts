import { vi } from 'vitest'

const startCoordination = vi.fn().mockResolvedValue({ ok: true, id: 'coord_1' })
vi.mock('../coordination/handler.js', () => ({
  startCoordination: (...a: unknown[]) => startCoordination(...a),
  advanceFromOwner: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../coordination/repository.js', () => ({
  findActiveByContact: vi.fn().mockResolvedValue(null),
  findById: vi.fn().mockResolvedValue(null),
}))
vi.mock('../identity/resolver.js', () => ({
  isValidE164: (p: string) => /^\+[1-9]\d{6,14}$/.test(p),
  registerContact: vi.fn().mockResolvedValue('new_contact_id'),
}))

import { describe, it, expect, beforeEach } from 'vitest'
import { executeCoordinateMeeting } from './coordination-tools.js'

// Minimal chainable DB stub: select().from().where().limit() resolves to `rows`,
// update().set().where() resolves undefined. Each select consumes the next queued rows.
function makeCtx(selectQueue: unknown[][]) {
  let i = 0
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(selectQueue[i++] ?? []) }) }) }),
    update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
  }
  return {
    db, businessId: 'biz_1', identityId: 'owner_1', timezone: 'Asia/Jerusalem', lang: 'en' as const,
    calendar: {} as never, role: 'manager' as const,
  }
}

const baseArgs = {
  title: 'Meeting with Eyal', phoneNumber: '+972522858870', contactName: 'Eyal',
  durationMinutes: 90,
  windows: [
    { date: { relativeDay: 'tomorrow' as const }, startTime: { hour: 10, minute: 0 }, endTime: { hour: 16, minute: 0 } },
  ],
}

describe('executeCoordinateMeeting — customer counterparty', () => {
  beforeEach(() => { vi.clearAllMocks(); startCoordination.mockResolvedValue({ ok: true, id: 'coord_1' }) })

  it('accepts an existing CUSTOMER as the counterparty (no phone_not_a_contact refusal)', async () => {
    // 1st select: identity lookup by phone → an existing customer.
    // 2nd select: loadBusinessCtx business row. 3rd select: manager displayName.
    const ctx = makeCtx([
      [{ id: 'eyal_1', phone: '+972522858870', role: 'customer' }],
      [{ name: 'Studyoga', whatsappPhoneNumberId: 'wa', whatsappAccessToken: 'tok', outreachIdentityMode: 'business' }],
      [{ name: 'Dana' }],
    ])
    const res = await executeCoordinateMeeting(baseArgs as never, ctx as never)
    expect(res).toMatchObject({ success: true })
    expect(startCoordination).toHaveBeenCalledOnce()
    expect(startCoordination.mock.calls[0]![2]).toMatchObject({ contactId: 'eyal_1' })
  })

  it('refuses to coordinate with the owner/staff', async () => {
    const ctx = makeCtx([[{ id: 'mgr_1', phone: '+972522858870', role: 'manager' }]])
    const res = await executeCoordinateMeeting(baseArgs as never, ctx as never)
    expect(res).toMatchObject({ success: false })
    expect(startCoordination).not.toHaveBeenCalled()
  })

  it('passes allowedWindows through to startCoordination', async () => {
    const ctx = makeCtx([
      [{ id: 'eyal_1', phone: '+972522858870', role: 'customer' }],
      [{ name: 'Studyoga', whatsappPhoneNumberId: 'wa', whatsappAccessToken: 'tok', outreachIdentityMode: 'business' }],
      [{ name: 'Dana' }],
    ])
    await executeCoordinateMeeting(baseArgs as never, ctx as never)
    const input = startCoordination.mock.calls[0]![2] as { allowedWindows?: unknown[] }
    expect(Array.isArray(input.allowedWindows)).toBe(true)
    expect(input.allowedWindows!.length).toBe(1)
  })
})
