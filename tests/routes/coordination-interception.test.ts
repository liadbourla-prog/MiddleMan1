import { vi } from 'vitest'

vi.mock('../../src/db/client.js', () => {
  // mgr displayName lookup → returns one row
  const chain = { from: () => chain, where: () => chain, limit: () => Promise.resolve([{ name: 'Dana' }]) }
  return { db: { select: () => chain } }
})
vi.mock('../../src/domain/coordination/repository.js', () => ({ findActiveByContact: vi.fn() }))
vi.mock('../../src/domain/coordination/handler.js', () => ({ advanceFromContact: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../src/adapters/calendar/client.js', () => ({ createCalendarClient: vi.fn().mockReturnValue({}) }))

import { describe, it, expect, beforeEach } from 'vitest'
import { tryAdvanceActiveCoordination } from '../../src/routes/webhook.js'
import { findActiveByContact } from '../../src/domain/coordination/repository.js'
import { advanceFromContact } from '../../src/domain/coordination/handler.js'

const business = {
  id: 'biz1', name: 'Studyoga', timezone: 'Asia/Jerusalem', defaultLanguage: 'he',
  whatsappPhoneNumberId: 'wa', whatsappAccessToken: 'tok', googleRefreshToken: 'r',
  googleCalendarId: 'cal', calendarMode: 'internal', outreachIdentityMode: 'business',
} as never

const msg = { messageId: 'm1', fromNumber: '+972522858870', toNumber: '+972509999999', body: 'Wednesday at 10' } as never
const activeRow = { id: 'coord1', contactId: 'eyal_1', allowedWindows: [], candidateSlots: [], status: 'awaiting_counterparty' } as never

describe('tryAdvanceActiveCoordination — Branch-4 safety', () => {
  beforeEach(() => vi.clearAllMocks())

  it('a CUSTOMER with an active coordination is intercepted (advanceFromContact called, returns true)', async () => {
    vi.mocked(findActiveByContact).mockResolvedValue(activeRow)
    const customer = { id: 'eyal_1', role: 'customer', preferredLanguage: null } as never
    const handled = await tryAdvanceActiveCoordination(msg, customer, business)
    expect(handled).toBe(true)
    expect(advanceFromContact).toHaveBeenCalledOnce()
  })

  it('a normal CUSTOMER with NO coordination is NOT intercepted (returns false, booking path proceeds)', async () => {
    vi.mocked(findActiveByContact).mockResolvedValue(null)
    const customer = { id: 'cust_2', role: 'customer', preferredLanguage: null } as never
    const handled = await tryAdvanceActiveCoordination(msg, customer, business)
    expect(handled).toBe(false)
    expect(advanceFromContact).not.toHaveBeenCalled()
  })

  it('a MANAGER is never intercepted and never triggers the lookup', async () => {
    const manager = { id: 'owner_1', role: 'manager', preferredLanguage: null } as never
    const handled = await tryAdvanceActiveCoordination(msg, manager, business)
    expect(handled).toBe(false)
    expect(findActiveByContact).not.toHaveBeenCalled()
    expect(advanceFromContact).not.toHaveBeenCalled()
  })
})
