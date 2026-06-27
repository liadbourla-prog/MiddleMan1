import { describe, it, expect, vi } from 'vitest'
import { persistCapturedName, classInstanceMissing, memoryForActiveService, anchorRescheduleDraft, appendNameRequest } from './customer-booking.js'
import { t } from '../i18n/t.js'

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

describe('appendNameRequest — Branch 4 soft name capture (WS-D)', () => {
  it('appends the name request and flips nameAsked for a nameless customer mid-booking', () => {
    const r = appendNameRequest('Booked you for Monday at 10:00.', {
      intent: 'booking', displayName: null, nameAsked: false, lang: 'en',
    })
    expect(r.reply).toBe(`Booked you for Monday at 10:00.\n\n${t('ask_customer_name', 'en')}`)
    expect(r.nameAsked).toBe(true)
  })

  it('uses the Hebrew copy when lang is he', () => {
    const r = appendNameRequest('קבעתי לך ליום שני ב-10:00.', {
      intent: 'rescheduling', displayName: null, nameAsked: false, lang: 'he',
    })
    expect(r.reply.endsWith(t('ask_customer_name', 'he'))).toBe(true)
    expect(r.nameAsked).toBe(true)
  })

  it('leaves the reply untouched when the customer already has a displayName', () => {
    const r = appendNameRequest('Booked you for Monday at 10:00.', {
      intent: 'booking', displayName: 'Guy Cohen', nameAsked: false, lang: 'en',
    })
    expect(r.reply).toBe('Booked you for Monday at 10:00.')
    expect(r.nameAsked).toBe(false)
  })

  it('does not re-ask once nameAsked is already true', () => {
    const r = appendNameRequest('Booked you for Monday at 10:00.', {
      intent: 'booking', displayName: null, nameAsked: true, lang: 'en',
    })
    expect(r.reply).toBe('Booked you for Monday at 10:00.')
    expect(r.nameAsked).toBe(true)
  })

  it('does not append for a read-only inquiry intent', () => {
    const r = appendNameRequest('We are open Mon–Fri 9–5.', {
      intent: 'inquiry', displayName: null, nameAsked: false, lang: 'en',
    })
    expect(r.reply).toBe('We are open Mon–Fri 9–5.')
    expect(r.nameAsked).toBe(false)
  })

  it('does not append onto an empty reply', () => {
    const r = appendNameRequest('', {
      intent: 'booking', displayName: null, nameAsked: false, lang: 'en',
    })
    expect(r.reply).toBe('')
    expect(r.nameAsked).toBe(false)
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

describe('anchorRescheduleDraft — Branch 4 same-day time-only reschedule', () => {
  const services = [
    { id: 'svc-yoga', name: 'יוגה', durationMinutes: 60, maxParticipants: 8, category: null, schedulingMode: 'class' as const },
  ]

  it('reschedule: keeps the existing booking day when the customer gives only a time', () => {
    const existing = { slotStart: new Date('2026-06-29T07:00:00.000Z'), serviceTypeId: 'svc-yoga' }
    const intent = { intent: 'rescheduling', slotRequest: { time: { hour: 12, minute: 0 } } } as any
    const draft = anchorRescheduleDraft(existing, intent, services, 'Asia/Jerusalem')
    expect(draft.dateStr).toBe('2026-06-29')
    expect(draft.time).toEqual({ hour: 12, minute: 0 })
    expect(draft.serviceTypeId).toBe('svc-yoga')
  })

  it('reschedule: lets the customer override the day when they state one', () => {
    const existing = { slotStart: new Date('2026-06-29T07:00:00.000Z'), serviceTypeId: 'svc-yoga' }
    const intent = { intent: 'rescheduling', slotRequest: { weekday: 2, time: { hour: 12, minute: 0 } } } as any
    const draft = anchorRescheduleDraft(existing, intent, services, 'Asia/Jerusalem')
    expect(draft.dateStr).not.toBe('2026-06-29')
  })
})

describe('memoryForActiveService — Root D: do not switch service from cross-session memory', () => {
  // Mirrors the live bug: customer is mid-yoga-booking but cross-session memory says the
  // customer's "preferred service" is pilates; the reply must stay anchored to yoga.
  const baseCtx = {
    returningCustomer: true,
    preferredServiceName: 'פילאטיס',
    customerMemory: { displayName: 'Dana' },
  } as never

  it('overrides the cross-session preferred service with the in-flight service', () => {
    const mem = memoryForActiveService(baseCtx, 'יוגה')
    expect(mem?.preferredServiceName).toBe('יוגה')
  })

  it('passes memory through unchanged when there is no in-flight service', () => {
    const mem = memoryForActiveService(baseCtx, null)
    expect(mem?.preferredServiceName).toBe('פילאטיס')
  })

  it('returns null when the customer has no memory at all', () => {
    expect(memoryForActiveService({} as never, 'יוגה')).toBeNull()
  })
})
