import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { persistCapturedName, classInstanceMissing, memoryForActiveService, anchorRescheduleDraft, appendNameRequest, buildBusinessFacts, resolveContinuationFocusDay, promotableOfferedSlots, isAskStudioSentinel } from './customer-booking.js'
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

// F1e/S1 — the top-of-turn "batch reject everything offered last turn" promotion must NOT
// promote the slot the customer is actively confirming; otherwise that slot is suppressed
// from a later re-resolution and the booking silently drifts to a different date (the July-5
// drift). The pending slot is excluded; all other offered slots still promote.
describe('promotableOfferedSlots — never reject the slot under active confirmation (F1e)', () => {
  const s = (start: string) => ({ start, end: start, serviceTypeId: 'svc' })
  it('excludes the pending slot from promotion', () => {
    const offered = [s('2026-06-29T13:00:00.000Z'), s('2026-07-05T13:00:00.000Z')]
    const out = promotableOfferedSlots(offered, '2026-06-29T13:00:00.000Z')
    expect(out.map((o) => o.start)).toEqual(['2026-07-05T13:00:00.000Z'])
  })
  it('promotes everything when there is no pending slot', () => {
    const offered = [s('2026-06-29T13:00:00.000Z'), s('2026-07-05T13:00:00.000Z')]
    expect(promotableOfferedSlots(offered, undefined)).toHaveLength(2)
  })
})

// F1b/S1 — an appointment used to require TWO yeses: handleBookingIntent asked "to book?",
// the yes placed a hold and asked AGAIN "lock it in?", the second yes confirmed. The
// customer only reaches the private-hold path on a 'yes', so it must confirm IMMEDIATELY
// (one yes = one confirm), mirroring the class direct-confirm path.
describe('single-confirm appointment path — no double-confirm (F1b)', () => {
  it('the private-hold path confirms immediately rather than re-asking', () => {
    const src = readFileSync(new URL('./customer-booking.ts', import.meta.url), 'utf8')
    // The old second-ask situation string is gone.
    expect(src).not.toContain('Ask the customer to confirm they want it locked in')
    // The private hold is confirmed in the same turn and reported as a booking.
    expect(src).toMatch(/confirmAfterHold = await confirmBooking\(/)
    expect(src).toMatch(/Booking confirmed for \$\{pendingSlot\.serviceName\}/)
  })
})

// F1c/S1 — the "a spot opened" waitlist offer must be bindable on the inbound side: a "yes"
// books the offered slot, a "no" releases it. Previously it set no session state and had no
// consumer, so the reply fell through to fresh intent (the loop's primary trigger). This
// reads the source so a future edit that drops the consumer fails loudly.
describe('waitlist offer acceptance — inbound consumer binds the reply (F1c)', () => {
  it('the consumer loads an open offer and books on yes / releases on no, before the dispatch', () => {
    const src = readFileSync(new URL('./customer-booking.ts', import.meta.url), 'utf8')
    const idxConsumer = src.indexOf('loadOpenWaitlistOffer(db, identity.businessId, identity.id')
    const idxBookingSelection = src.indexOf("pendingDecision?.kind === 'booking_selection'")
    expect(idxConsumer).toBeGreaterThan(-1)
    // Runs before the normal dispatch branches.
    expect(idxConsumer).toBeLessThan(idxBookingSelection)
    // yes → books the offered slot and marks it accepted; no → releases it.
    expect(src).toMatch(/decision === 'yes'[\s\S]*requestBooking\(db, calendar, identity, \{ serviceTypeId: offer\.serviceTypeId/)
    expect(src).toMatch(/status: 'accepted'/)
    expect(src).toMatch(/decision === 'no'[\s\S]*status: 'expired'/)
    // Only engages when no booking step is already in flight (never hijacks a confirmation).
    expect(src).toMatch(/!ctx\.pendingSlot && !ctx\.pendingDecision && !ctx\.awaitingConfirmationFor/)
  })
})

// F3a/F3b/S3 — ask-the-owner. When the PA can't answer, the model emits a sentinel; code
// performs the REAL escalation and replies honestly. The PA must never be told to fabricate
// "I'll check with the business" with no backing action.
describe('ask-the-owner sentinel + de-fabrication (F3a/F3b)', () => {
  it('isAskStudioSentinel detects the can\'t-answer token, not normal replies', () => {
    expect(isAskStudioSentinel('[[ASK_STUDIO]]')).toBe(true)
    expect(isAskStudioSentinel('  [[ASK_STUDIO]] ')).toBe(true)
    expect(isAskStudioSentinel('We have classes at 10:00 and 12:00.')).toBe(false)
  })
  it('the inquiry path escalates for real on the sentinel instead of fabricating a check', () => {
    const src = readFileSync(new URL('./customer-booking.ts', import.meta.url), 'utf8')
    // The inquiry reply checks the sentinel and routes to the real owner relay.
    expect(src).toMatch(/isAskStudioSentinel\(inquiryReply\)[\s\S]*relayUnansweredToOwner\(db, business, identity, messageText/)
    // The relay actually calls the escalation engine.
    expect(src).toMatch(/escalateCustomerQuestion\(db, business, \{ id: identity\.id, phoneNumber: identity\.phoneNumber \}/)
    // De-fabrication: no surviving instruction telling the model to SAY it will check.
    expect(src).not.toContain('say you will check with the business')
    expect(src).not.toContain("say you'll check with the studio")
  })
  it('the global customer prompt no longer instructs "you\'ll check with the business"', () => {
    const src = readFileSync(new URL('../../adapters/llm/client.ts', import.meta.url), 'utf8')
    expect(src).not.toContain("you'll check with the business")
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

describe('buildBusinessFacts — service narrative grounding (T2b.1, H13/H15)', () => {
  it('surfaces an owner-authored narrative so the attribute is answerable without a relay', () => {
    const svcs = [{ id: 'p', name: 'Apparatus Pilates', durationMinutes: 50, maxParticipants: 4, narrative: 'Apparatus pilates uses reformers — spring-loaded carriages for resistance work.' }]
    const out = buildBusinessFacts(svcs, undefined, undefined, [])
    // The owner's own words are present, so the model can answer "what equipment?" from real facts.
    expect(out).toContain('reformers')
    expect(out).toContain('Apparatus Pilates')
  })
  it('a service with no narrative surfaces no attribute text (the relay/no-invent path stays the only honest route)', () => {
    const svcs = [{ id: 'y', name: 'Yoga', durationMinutes: 60, maxParticipants: 8 }]
    const out = buildBusinessFacts(svcs, undefined, undefined, [])
    expect(out).not.toContain('reformers')
    // No fabricated attribute block is emitted when the owner never authored one.
    expect(out).not.toMatch(/equipment|uses |details:/i)
  })
  it('mixes narrated and un-narrated services without leaking one onto the other', () => {
    const svcs = [
      { id: 'p', name: 'Apparatus Pilates', durationMinutes: 50, maxParticipants: 4, narrative: 'uses reformers' },
      { id: 'y', name: 'Yoga', durationMinutes: 60, maxParticipants: 8 },
    ]
    const out = buildBusinessFacts(svcs, undefined, undefined, [])
    expect(out).toContain('reformers')
    // The narrative is attached to its own service line, not the other one.
    const yogaLine = out.split('\n').find((l) => l.includes('Yoga')) ?? ''
    expect(yogaLine).not.toContain('reformers')
  })
})

describe('buildActiveServicesBlock — Branch-3 narrative parity (T2b.1)', () => {
  it('surfaces the same owner-authored narrative in the manager-facing services block', () => {
    const src = readFileSync(new URL('../../adapters/llm/orchestrator.ts', import.meta.url), 'utf8')
    // The Branch-3 services block must consume narrative so the two grounders do not diverge.
    expect(src).toMatch(/buildActiveServicesBlock[\s\S]{0,400}narrative/)
  })
})
