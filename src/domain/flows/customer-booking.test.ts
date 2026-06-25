import { describe, it, expect, vi } from 'vitest'
import { persistCapturedName, classInstanceMissing } from './customer-booking.js'

vi.mock('../identity/customer-resolver.js', () => ({
  setCustomerName: vi.fn().mockResolvedValue(undefined),
  deriveLastName: (n: string | null) => (n && n.trim().split(/\s+/).length >= 2 ? n.trim().split(/\s+/).pop()! : null),
}))
import { setCustomerName } from '../identity/customer-resolver.js'

vi.mock('../availability/blocks.js', () => ({
  findClassBlockProviderForSlot: vi.fn(),
}))
import { findClassBlockProviderForSlot } from '../availability/blocks.js'

describe('persistCapturedName', () => {
  const db = {} as never
  it('saves name + derived lastName when stored displayName is null', async () => {
    await persistCapturedName(db, 'biz1', 'c1', null, 'Guy Cohen')
    expect(setCustomerName).toHaveBeenCalledWith(db, 'biz1', 'c1', { displayName: 'Guy Cohen', lastName: 'Cohen' })
  })
  it('does NOT overwrite an existing stored name', async () => {
    vi.mocked(setCustomerName).mockClear()
    await persistCapturedName(db, 'biz1', 'c1', 'Existing', 'Guy Cohen')
    expect(setCustomerName).not.toHaveBeenCalled()
  })
  it('no-ops when no name was captured', async () => {
    vi.mocked(setCustomerName).mockClear()
    await persistCapturedName(db, 'biz1', 'c1', null, null)
    expect(setCustomerName).not.toHaveBeenCalled()
  })
})

describe('classInstanceMissing — Branch 4 anti-invented-time gate', () => {
  const db = {} as never
  const slot = new Date('2026-06-29T14:00:00.000Z') // 17:00 Asia/Jerusalem — no class there

  it('appointment-mode service is never gated and never hits the DB', async () => {
    vi.mocked(findClassBlockProviderForSlot).mockClear()
    const svc = { id: 'svc-appt', schedulingMode: 'appointment' as const }
    expect(await classInstanceMissing(db, 'biz1', svc, slot)).toBe(false)
    expect(findClassBlockProviderForSlot).not.toHaveBeenCalled()
  })

  it('class-mode service WITH no class block at the slot is reported missing (invented time)', async () => {
    vi.mocked(findClassBlockProviderForSlot).mockResolvedValue({ found: false })
    const svc = { id: 'svc-yoga', schedulingMode: 'class' as const }
    expect(await classInstanceMissing(db, 'biz1', svc, slot)).toBe(true)
    expect(findClassBlockProviderForSlot).toHaveBeenCalledWith(db, 'biz1', 'svc-yoga', slot)
  })

  it('class-mode service WITH a real class block at the slot is allowed through', async () => {
    vi.mocked(findClassBlockProviderForSlot).mockResolvedValue({ found: true, providerId: null, maxParticipants: 8 })
    const svc = { id: 'svc-yoga', schedulingMode: 'class' as const }
    expect(await classInstanceMissing(db, 'biz1', svc, slot)).toBe(false)
  })
})
