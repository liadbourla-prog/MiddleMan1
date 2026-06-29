import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { persistCapturedName, classInstanceMissing, memoryForActiveService, anchorRescheduleDraft, appendNameRequest, buildBusinessFacts, resolveContinuationFocusDay } from './customer-booking.js'
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

// Regression guard for the 2026-06-28 "name never persisted" root cause: persistCapturedName
// ran ONLY on the default intent path, so a name stated on the clarification or hold-redispatch
// path (where extractCustomerIntent also runs) was extracted but never written to display_name —
// which in turn left the owner notification and calendar roster showing "no name". Invariant:
// every intent-extraction site in this flow must be paired with a name-capture call. This reads
// the source so a future extraction site that forgets capture fails loudly.
describe('name-capture invariant — every extractCustomerIntent is paired with persistCapturedName', () => {
  it('has a persistCapturedName call for each extractCustomerIntent call site', () => {
    const src = readFileSync(new URL('./customer-booking.ts', import.meta.url), 'utf8')
    const extractions = (src.match(/await extractCustomerIntent\(/g) ?? []).length
    const captures = (src.match(/await persistCapturedName\(/g) ?? []).length
    expect(extractions).toBeGreaterThan(0)
    expect(captures).toBeGreaterThanOrEqual(extractions)
  })
})

// WS3-T3.2 escape-hatch guard: when a booking-selection answer turns out to be a PIVOT
// (handleBookingSelection returns redispatch), the dispatcher MUST clear the pending
// decision in-memory before falling through to fresh intent — otherwise the next turn
// would re-enter the selection branch and re-bind the pivot. This reads the source so a
// future edit that drops `pendingDecision` from the redispatch fall-through fails loudly.
describe('pendingDecision escape-hatch — dispatcher strips pending state on redispatch', () => {
  it('the booking-selection redispatch fall-through destructures pendingDecision out of ctx', () => {
    const src = readFileSync(new URL('./customer-booking.ts', import.meta.url), 'utf8')
    // The dispatcher branch that calls handleBookingSelection must, on the redispatch path,
    // strip pendingDecision (mirroring the hold branch's pendingSlot strip).
    expect(src).toMatch(/const \{[^}]*pendingDecision:[^}]*\}\s*=\s*ctx/)
    // And the handler is wired into the dispatcher under the booking_selection guard.
    expect(src).toMatch(/handleBookingSelection\(/)
    expect(src).toMatch(/pendingDecision\?\.kind === 'booking_selection'/)
  })
})

// F1d/S1 — a duplicate "already booked into this class" engine result must reassure the
// customer (their spot is confirmed), NEVER fall through to the generic re-offer/substitute
// path that laundered it into a different-date offer (the July-5 drift). This reads the
// source so a future edit that drops the early reassurance branch fails loudly.
describe('already-booked reassurance — duplicate result short-circuits the re-offer (F1d)', () => {
  it('the !result.ok handler branches on code === already_booked BEFORE the substitute path', () => {
    const src = readFileSync(new URL('./customer-booking.ts', import.meta.url), 'utf8')
    const idxAlready = src.indexOf("result.code === 'already_booked'")
    const idxReshuffle = src.indexOf('openReshuffleCampaign')
    expect(idxAlready).toBeGreaterThan(-1)
    // The reassurance branch precedes the re-offer block (reshuffle entry → class substitute).
    expect(idxAlready).toBeLessThan(idxReshuffle)
    // It reassures (ALREADY booked) and does not re-offer a different time.
    expect(src).toMatch(/ALREADY booked for \$\{pendingSlot\.serviceName\}/)
  })
  it('the engine tags the class duplicate guard with code: already_booked', () => {
    const src = readFileSync(new URL('../booking/engine.ts', import.meta.url), 'utf8')
    expect(src).toMatch(/already booked into this class".*code: 'already_booked'/s)
  })
})

describe('resolveContinuationFocusDay — T2.2 Hole B (persist inquiry focus day)', () => {
  it('this-turn day wins over draft and lastInquiry', () => {
    expect(resolveContinuationFocusDay('2026-07-05', '2026-07-01', '2026-06-28')).toBe('2026-07-05')
  })
  it('draft wins over lastInquiry when no this-turn day', () => {
    expect(resolveContinuationFocusDay(undefined, '2026-07-01', '2026-06-28')).toBe('2026-07-01')
  })
  it('falls back to lastInquiry on a bare continuation (no this-turn day, no draft)', () => {
    expect(resolveContinuationFocusDay(undefined, undefined, '2026-06-28')).toBe('2026-06-28')
  })
  it('a DIFFERENT this-turn day overrides a stale lastInquiry (day-change scoping)', () => {
    expect(resolveContinuationFocusDay('2026-07-10', undefined, '2026-06-28')).toBe('2026-07-10')
  })
  it('returns undefined when all empty', () => {
    expect(resolveContinuationFocusDay(undefined, undefined, undefined)).toBeUndefined()
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

describe('buildBusinessFacts — instructor roster', () => {
  const svcs = [{ id: 'y', name: 'יוגה', durationMinutes: 60, maxParticipants: 8 }]
  it('lists real instructors and forbids inventing others', () => {
    const out = buildBusinessFacts(svcs, undefined, undefined, [
      { name: 'דנה', services: ['יוגה'] }, { name: 'נועה', services: ['יוגה'] },
    ])
    expect(out).toContain('דנה')
    expect(out).toContain('נועה')
    expect(out).toMatch(/never name or invent|do not name|do NOT name|do NOT invent/i)
  })
  it('keeps the no-invent rule when the roster is empty', () => {
    const out = buildBusinessFacts(svcs, undefined, undefined, [])
    expect(out).toMatch(/do NOT name|do NOT invent/i)
  })
})
