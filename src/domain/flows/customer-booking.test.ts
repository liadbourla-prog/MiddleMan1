import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { persistCapturedName, classInstanceMissing, memoryForActiveService, anchorRescheduleDraft, appendNameRequest, buildBusinessFacts, resolveContinuationFocusDay, reanchorInquiryGroundingDay, promotableOfferedSlots, isAskStudioSentinel, bestEffortInquiryFocusDay, handleWaitlistJoinRequest, resolveConcreteWaitlistSlot, renderDayOptions, buildHoldConfirmSituation } from './customer-booking.js'
import { t } from '../i18n/t.js'

vi.mock('../identity/customer-resolver.js', () => ({
  setCustomerName: vi.fn().mockResolvedValue(undefined),
  deriveLastName: (n: string | null) => (n && n.trim().split(/\s+/).length >= 2 ? n.trim().split(/\s+/).pop()! : null),
}))
import { setCustomerName } from '../identity/customer-resolver.js'

vi.mock('../waitlist/join.js', () => ({
  joinWaitlist: vi.fn(),
}))
import { joinWaitlist } from '../waitlist/join.js'

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

// F1c/S1 (WL-6) — the "a spot opened" waitlist offer must be bindable on the inbound side via
// the GENUINE-HOLD path: WL-5 placed a real hold at offer time, so a "yes" CONFIRMS that held
// booking (acceptWaitlistOffer → confirmBooking), and a "no" RELEASES it and cascades to the
// next in line (declineWaitlistOffer). This is the inbound consumer; previously it re-ran a
// first-come requestBooking and hand-flipped the row. This reads the source so a future edit
// that drops the consumer — or reverts to the old first-come behaviour — fails loudly.
describe('waitlist offer acceptance — inbound consumer binds the reply via the genuine-hold path (WL-6)', () => {
  const src = readFileSync(new URL('./customer-booking.ts', import.meta.url), 'utf8')

  it('the consumer loads an open offer before the normal dispatch branches', () => {
    const idxConsumer = src.indexOf('loadOpenWaitlistOffer(db, identity.businessId, identity.id')
    const idxBookingSelection = src.indexOf("pendingDecision?.kind === 'booking_selection'")
    expect(idxConsumer).toBeGreaterThan(-1)
    expect(idxConsumer).toBeLessThan(idxBookingSelection)
    // Only engages when no booking step is already in flight (never hijacks a confirmation).
    expect(src).toMatch(/!ctx\.pendingSlot && !ctx\.pendingDecision && !ctx\.awaitingConfirmationFor/)
  })

  it("'yes' confirms the WL-5 hold via acceptWaitlistOffer — NOT a fresh requestBooking", () => {
    // The yes arm calls the WL-AX domain op, passing the loaded offer + the customer name.
    expect(src).toMatch(/decision === 'yes'[\s\S]*acceptWaitlistOffer\(db, calendar, identity,[\s\S]*offer\)/)
    // It must NOT re-run a first-come requestBooking inside the yes arm.
    expect(src).not.toMatch(/decision === 'yes'[\s\S]*requestBooking\(db, calendar, identity, \{ serviceTypeId: offer\.serviceTypeId/)
    // accepted → confirmed reply (bookingConfirmed) + session complete.
    expect(src).toMatch(/res\.kind === 'accepted'[\s\S]*bookingConfirmed: true/)
    // just_went → warm fallback, NEVER a dead-end (keep on waitlist / find another time).
    expect(src).toMatch(/res\.kind === 'just_went'/)
  })

  it("'no' releases the hold + cascades via declineWaitlistOffer — no manual waitlist write", () => {
    expect(src).toMatch(/decision === 'no'[\s\S]*declineWaitlistOffer\(db, calendar, \{[\s\S]*id: offer\.id/)
  })

  it('does NOT hand-write the waitlist row status from this block (the domain ops own that)', () => {
    // The old first-come block manually flipped the row; WL-AX owns all waitlist status writes.
    expect(src).not.toMatch(/db\.update\(waitlist\)\.set\(\{ status: 'accepted' \}\)/)
    expect(src).not.toMatch(/db\.update\(waitlist\)\.set\(\{ status: 'expired' \}\)\.where\(eq\(waitlist\.id, offer\.id\)\)/)
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

describe('ASK_STUDIO escape hatch on explanation + default paths (T2b.2, H15 mid-conversation)', () => {
  const src = readFileSync(new URL('./customer-booking.ts', import.meta.url), 'utf8')
  // Isolate each path's body so an assertion can't be satisfied by the inquiry path's wiring.
  const explanationBody = src.slice(src.indexOf("case 'system_explanation'"), src.indexOf("default: {"))
  const defaultBody = src.slice(src.indexOf("default: {"), src.indexOf('})()'))

  it("the system_explanation path carries the ASK_STUDIO escape hatch and relays on the sentinel", () => {
    expect(explanationBody).toContain('ASK_STUDIO_INSTRUCTION')
    // On the deliberate sentinel it performs the REAL owner relay over the customer's message.
    expect(explanationBody).toMatch(/isAskStudioSentinel\(explainReply\)[\s\S]*relayUnansweredToOwner\(db, business, identity, messageText/)
  })

  it("the default/unknown path carries the ASK_STUDIO escape hatch and relays on the sentinel", () => {
    expect(defaultBody).toContain('ASK_STUDIO_INSTRUCTION')
    expect(defaultBody).toMatch(/isAskStudioSentinel\(unknownReply\)[\s\S]*relayUnansweredToOwner\(db, business, identity, messageText/)
  })

  it("steers first: the escape hatch never fires on a pure first-message greeting (no relay before genReply)", () => {
    // The greeting situation (mayGreet) must not itself instruct the sentinel — steering is the
    // default; the relay only ever triggers off the model's deliberate sentinel on a real gap.
    expect(defaultBody).toMatch(/mayGreet\s*\n?\s*\?[\s\S]*Greet them warmly/)
  })
})

describe('owner-question relay is NON-BLOCKING (T2c.1 / constraint #3b)', () => {
  const src = readFileSync(new URL('./customer-booking.ts', import.meta.url), 'utf8')
  it('never installs an "owner_question" session lock — the relay is DB state only', () => {
    // The customer must keep booking/asking with a question outstanding; no awaiting-owner mode.
    expect(src).not.toContain("awaitingConfirmationFor: 'owner_question'")
    expect(src).not.toContain('awaitingConfirmationFor: "owner_question"')
  })
  it('every relay return keeps the session open (sessionComplete: false)', () => {
    // Each `const relay = await relayUnansweredToOwner(...)` is immediately returned non-terminally.
    const relayReturns = src.match(/const relay = await relayUnansweredToOwner[\s\S]{0,160}?return \{ reply: relay, sessionComplete: false \}/g) ?? []
    expect(relayReturns.length).toBeGreaterThanOrEqual(3) // inquiry + system_explanation + default
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

describe('reanchorInquiryGroundingDay — T2.3 (§K "Sunday full" preventive grounding re-anchor)', () => {
  const SUN = '2026-07-05' // the day already in context (prior inquiry focus)
  it('REPRO: "פילאטיס ב 12" (no day, concrete time) re-anchors to the prior inquiry focus', () => {
    // The live bug: a day-less, specific-time follow-up pivoted to other days. It must instead
    // ground against the day already in context so the situation carries that day's whole-service set.
    expect(reanchorInquiryGroundingDay(false, true, SUN)).toBe(SUN)
  })
  it('does NOT re-anchor when this turn already named a day (existing resolvedDay path owns it)', () => {
    expect(reanchorInquiryGroundingDay(true, true, SUN)).toBeNull()
  })
  it('does NOT re-anchor a bare service/topic question with no concrete time (no context-day assumption)', () => {
    expect(reanchorInquiryGroundingDay(false, false, SUN)).toBeNull()
  })
  it('does NOT re-anchor when there is no prior inquiry focus to anchor to', () => {
    expect(reanchorInquiryGroundingDay(false, true, undefined)).toBeNull()
  })
})

describe('bestEffortInquiryFocusDay — H19 (T2b.3): unscoped inquiries still get an occupancy focus', () => {
  const tz = 'Asia/Jerusalem'
  const now = new Date('2026-06-30T09:00:00.000Z') // 12:00 local → 2026-06-30

  it('uses the customer-scoped day when one resolved', () => {
    const f = bestEffortInquiryFocusDay({ ok: true, dateStr: '2026-07-05' }, [], 'svc-yoga', tz, now)
    expect(f).toEqual({ dateStr: '2026-07-05', serviceTypeId: 'svc-yoga' })
  })

  it('unscoped: anchors on the SOONEST genuinely-open day we surfaced this turn', () => {
    const offered = [
      { start: '2026-07-04T07:00:00.000Z', end: '2026-07-04T08:00:00.000Z', serviceTypeId: 'svc-pil' },
      { start: '2026-07-02T07:00:00.000Z', end: '2026-07-02T08:00:00.000Z', serviceTypeId: 'svc-yoga' },
    ]
    const f = bestEffortInquiryFocusDay(null, offered, undefined, tz, now)
    expect(f).toEqual({ dateStr: '2026-07-02', serviceTypeId: 'svc-yoga' })
  })

  it('unscoped + transient-empty availability (no offered slots): floors to TODAY so the gate can re-read a genuinely-open spine', () => {
    const f = bestEffortInquiryFocusDay(null, [], 'svc-yoga', tz, now)
    expect(f).toEqual({ dateStr: '2026-06-30', serviceTypeId: 'svc-yoga' })
  })

  it('unscoped, no offered, no inferred service: still floors to TODAY (no service scope)', () => {
    const f = bestEffortInquiryFocusDay(null, [], undefined, tz, now)
    expect(f).toEqual({ dateStr: '2026-06-30' })
  })

  it('never returns undefined — every inquiry hands the gate a focus day', () => {
    expect(bestEffortInquiryFocusDay({ ok: false } as never, [], undefined, tz, now)).toBeDefined()
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

// WL-4 — explicit join-the-waitlist request, mapped to a voice-compliant reply. The flow-local
// helper calls the WL-2 domain op (joinWaitlist) and turns its typed outcome into a sanitized
// situation string (joined/already_on_list) or a routing/name signal (slot_has_space/needs_name).
// It MUST reuse joinWaitlist (no re-implemented insert) and never phrase a YES/NO menu.
describe('handleWaitlistJoinRequest — maps the WL-2 outcome to a voice-compliant reply (WL-4)', () => {
  const identity = { id: 'c1', businessId: 'biz1', phoneNumber: '+10000000000', displayName: 'Dana' } as never
  const slot = { serviceTypeId: 'svc-yoga', slotStart: new Date('2026-07-05T07:00:00.000Z'), slotEnd: new Date('2026-07-05T08:00:00.000Z') }
  // The reply generator is stubbed to echo the situation string so we can assert on what the
  // PA is INSTRUCTED to say (the deterministic, gate-checked situation), not the LLM wording.
  const genReply = vi.fn(async (input: { situation: string }) => input.situation)
  const deps = {
    lang: 'en' as const,
    businessTimezone: 'Asia/Jerusalem',
    businessName: 'Studio',
    transcript: [],
    genReply: genReply as never,
    ctx: {} as never,
  }
  const db = {} as never

  it('joined → confirms on the list AND states the FIFO position (Q3), session complete', async () => {
    vi.mocked(joinWaitlist).mockResolvedValue({ kind: 'joined', waitlistId: 'w1', position: 2 })
    const res = await handleWaitlistJoinRequest(db, identity, slot, deps)
    expect(joinWaitlist).toHaveBeenCalledWith(db, {
      businessId: 'biz1', customerId: 'c1', serviceTypeId: 'svc-yoga',
      slotStart: slot.slotStart, slotEnd: slot.slotEnd,
    })
    expect(res.sessionComplete).toBe(true)
    expect(res.routeToBooking).not.toBe(true)
    // States position (2 / "2nd") and promises a message when a spot opens — never that the
    // position is FIXED.
    expect(res.reply).toMatch(/2/)
    expect(res.reply.toLowerCase()).toMatch(/spot opens|opens up|message/)
    expect(res.reply.toLowerCase()).not.toMatch(/guarantee|fixed|won't change/)
  })

  it('slot_has_space → routes to normal booking (does NOT dead-end on a waitlist message)', async () => {
    vi.mocked(joinWaitlist).mockResolvedValue({ kind: 'slot_has_space' })
    const res = await handleWaitlistJoinRequest(db, identity, slot, deps)
    expect(res.routeToBooking).toBe(true)
  })

  it('already_on_list → warm "already on it" with no duplicate, session complete', async () => {
    vi.mocked(joinWaitlist).mockResolvedValue({ kind: 'already_on_list', waitlistId: 'w1', position: 1 })
    const res = await handleWaitlistJoinRequest(db, identity, slot, deps)
    expect(res.sessionComplete).toBe(true)
    expect(res.routeToBooking).not.toBe(true)
    expect(res.reply.toLowerCase()).toMatch(/already/)
  })

  it('needs_name → asks for the name and does NOT insert / does NOT route to booking', async () => {
    vi.mocked(joinWaitlist).mockResolvedValue({ kind: 'needs_name' })
    const res = await handleWaitlistJoinRequest(db, identity, slot, deps)
    expect(res.routeToBooking).not.toBe(true)
    expect(res.sessionComplete).not.toBe(true)
    // Reuses the existing name-ask copy so the owner gets a name on file.
    expect(res.reply).toContain(t('ask_customer_name', 'en'))
  })
})

// WL-4 — concrete-slot resolution reuses the booking path's deterministic resolver
// (resolveRequestedDate → resolveSlotStart, never hand-rolled date math). Returns the concrete
// (serviceTypeId, slotStart, slotEnd) only when service + a resolvable day + a time are all
// present; otherwise null → the flow falls back to the normal "which session?" clarification.
describe('resolveConcreteWaitlistSlot — concrete slot or null (WL-4)', () => {
  const services = [
    { id: 'svc-yoga', name: 'Yoga', durationMinutes: 60, maxParticipants: 8, category: null, schedulingMode: 'class' as const },
  ]
  const tz = 'Asia/Jerusalem'
  const now = new Date('2026-06-30T09:00:00.000Z') // 12:00 local

  it('resolves a fully-specified slot to (serviceTypeId, slotStart, slotEnd)', () => {
    const intent = { serviceTypeHint: 'Yoga', slotRequest: { explicitDate: { year: 2026, month: 7, day: 5 }, time: { hour: 10, minute: 0 } } } as never
    const out = resolveConcreteWaitlistSlot(intent, services, tz, now)
    expect(out).not.toBeNull()
    expect(out!.serviceTypeId).toBe('svc-yoga')
    expect(out!.slotEnd.getTime() - out!.slotStart.getTime()).toBe(60 * 60_000)
  })

  it('returns null when no time is named (fuzzy) → flow asks which session', () => {
    const intent = { serviceTypeHint: 'Yoga', slotRequest: { explicitDate: { year: 2026, month: 7, day: 5 }, time: null } } as never
    expect(resolveConcreteWaitlistSlot(intent, services, tz, now)).toBeNull()
  })

  it('returns null when no day can be resolved', () => {
    const intent = { serviceTypeHint: 'Yoga', slotRequest: { time: { hour: 10, minute: 0 } } } as never
    expect(resolveConcreteWaitlistSlot(intent, services, tz, now)).toBeNull()
  })
})

// WL-4 — the explicit joinWaitlist intent is wired into the dispatch BEFORE fresh booking
// handling, branches on === true (omitted/undefined never fires it), reuses the WL-2 domain op
// (no re-implemented insert), and is guarded so it never hijacks an in-progress confirmation/
// selection. This reads the source so a future edit that drops the wiring fails loudly.
describe('explicit joinWaitlist wiring (WL-4)', () => {
  const src = readFileSync(new URL('./customer-booking.ts', import.meta.url), 'utf8')

  it('branches on === true, never on a truthy/omitted value', () => {
    expect(src).toMatch(/intent\.joinWaitlist === true/)
    // The omitted/undefined value must NOT trigger it (no bare truthy check on the flag).
    expect(src).not.toMatch(/if \(intent\.joinWaitlist\)/)
  })

  it('reuses the WL-2 domain op via the shared helper — no re-implemented waitlist insert', () => {
    // The helper calls joinWaitlist; there is no hand-rolled insert(waitlist) anywhere in the flow.
    expect(src).toMatch(/await joinWaitlist\(/)
    expect(src).not.toMatch(/\.insert\(waitlist\)/)
  })

  it('routes to normal booking when the slot turns out to have space (slot_has_space)', () => {
    // The wired branch honours routeToBooking by falling through to handleBookingIntent.
    expect(src).toMatch(/routeToBooking/)
  })

  it('is placed before fresh intent extraction so it binds the explicit ask first', () => {
    const idxWire = src.indexOf('intent.joinWaitlist === true')
    const idxSwitch = src.indexOf("case 'booking':")
    expect(idxWire).toBeGreaterThan(-1)
    expect(idxWire).toBeLessThan(idxSwitch)
  })
})

// WL-3 — when the customer asks for a SPECIFIC concrete class that EXISTS but is FULL, the
// offerable renderer (which DROPS full classes so they're never presented as bookable) must
// SURFACE that exact dropped slot up to the caller so the lead-protection site can ADD a
// waitlist offer alongside the later-session substitute (never a dead-end).
describe('renderDayOptions — surfaces the FULL requested slot (WL-3)', () => {
  const tz = 'Asia/Jerusalem'
  const dateStr = '2026-07-05'
  const fullStart = new Date('2026-07-05T07:00:00.000Z') // 10:00 local
  const fullEnd = new Date('2026-07-05T08:00:00.000Z')
  const openStart = new Date('2026-07-05T13:00:00.000Z') // 16:00 local
  const openEnd = new Date('2026-07-05T14:00:00.000Z')
  const mkDay = () => ({
    dateStr,
    classes: [
      { serviceTypeId: 'svc-yoga', serviceName: 'Yoga', start: fullStart, end: fullEnd, spotsTotal: 8, spotsLeft: 0 },
      { serviceTypeId: 'svc-yoga', serviceName: 'Yoga', start: openStart, end: openEnd, spotsTotal: 8, spotsLeft: 3 },
    ],
    privateOpenings: [],
  })

  it('offerable=true + requestedStart on the FULL class → sets fullRequestedSlot, drops it from offered', () => {
    const r = renderDayOptions(mkDay(), dateStr, tz, { offerable: true, requestedStart: fullStart })
    expect(r.fullRequestedSlot).toBeDefined()
    expect(r.fullRequestedSlot!.serviceTypeId).toBe('svc-yoga')
    expect(r.fullRequestedSlot!.slotStart).toBe(fullStart.toISOString())
    expect(r.fullRequestedSlot!.slotEnd).toBe(fullEnd.toISOString())
    // The full class is never presented as bookable; the open 16:00 still is.
    expect(r.offered.some((o) => o.start === fullStart.toISOString())).toBe(false)
    expect(r.offered.some((o) => o.start === openStart.toISOString())).toBe(true)
  })

  it('requestedStart on an OPEN class → no fullRequestedSlot (normal booking proceeds)', () => {
    const r = renderDayOptions(mkDay(), dateStr, tz, { offerable: true, requestedStart: openStart })
    expect(r.fullRequestedSlot).toBeUndefined()
  })

  it('no requestedStart → backward-compatible, never sets fullRequestedSlot', () => {
    const r = renderDayOptions(mkDay(), dateStr, tz, { offerable: true })
    expect(r.fullRequestedSlot).toBeUndefined()
  })
})

// WL-3 — the lead-protection (full-slot) site ADDS a waitlist offer as an ADDITIONAL branch:
// it offers BOTH "keep your place" for the full requested slot AND the later-session substitute
// in ONE message, stores the offered slot in pendingWaitlistJoin, and a follow-up "yes" reuses
// handleWaitlistJoinRequest (NOT a fresh booking). These read the source so a future edit that
// drops the wiring fails loudly.
describe('full-slot waitlist offer + follow-up binding (WL-3)', () => {
  const src = readFileSync(new URL('./customer-booking.ts', import.meta.url), 'utf8')

  it('detects the full requested slot via renderDayOptions/buildDayOptionsText requestedStart', () => {
    // The full-slot site passes the resolved slotStart through to the offerable renderer.
    expect(src).toMatch(/requestedStart/)
    expect(src).toMatch(/fullRequestedSlot/)
  })

  it('surfaces BOTH the waitlist offer AND the later-session substitute (never a dead-end)', () => {
    // The substitute (suggestNextClassesText) is still computed at the full-slot site so the
    // offer never replaces the substitute — both go in one message.
    const idxFull = src.indexOf('fullRequestedSlot')
    expect(idxFull).toBeGreaterThan(-1)
    // A waitlist-offer situation string mentions keeping their place + messaging when a spot opens.
    expect(src).toMatch(/keep their place[\s\S]*spot opens|the moment a spot opens/)
    // It must NOT instruct a YES/NO menu (voice gate).
    expect(src).not.toMatch(/reply YES\/NO|reply 'yes' or 'no'/i)
  })

  it('stores the offered slot in pendingWaitlistJoin so a follow-up yes can act on it', () => {
    expect(src).toMatch(/pendingWaitlistJoin:\s*dayOpts\.fullRequestedSlot/)
  })

  it("binds a follow-up 'yes' to handleWaitlistJoinRequest (NOT a fresh booking) and clears the field", () => {
    // The binding guards on the pending offer, parses a confirmation, and reuses the WL-4 helper.
    expect(src).toMatch(/updatedCtx\.pendingWaitlistJoin/)
    expect(src).toMatch(/pendingWaitlistJoin[\s\S]*parseConfirmation\(messageText\)/)
    expect(src).toMatch(/pendingWaitlistJoin[\s\S]*handleWaitlistJoinRequest\(/)
  })

  it('is placed before fresh intent extraction so the yes is not re-parsed as a new booking', () => {
    const idxBind = src.indexOf('updatedCtx.pendingWaitlistJoin')
    const idxSwitch = src.indexOf("case 'booking':")
    expect(idxBind).toBeGreaterThan(-1)
    expect(idxBind).toBeLessThan(idxSwitch)
  })

  it('clears pendingWaitlistJoin on the paths that clear other pending state', () => {
    // The redirect/clear destructure that strips pendingSlot/pendingDecision also drops pendingWaitlistJoin.
    expect(src).toMatch(/const \{[^}]*pendingWaitlistJoin:[^}]*\}\s*=\s*ctx/)
  })
})

// T1.2 (live P1 bug): the hold-confirm prompt was LLM-authored as an either/or
// ("release the spot … OR take it?"), which made a bare "כן" semantically void and let the
// system book against a decline. The prompt situation must now constrain the model to a SINGLE
// yes/no confirmation of the exact slot — no stacked second question, no either/or — which also
// satisfies the Voice-Bible one-question rule. Pure shape test on buildHoldConfirmSituation.
describe('buildHoldConfirmSituation — single yes/no confirm, no either/or (T1.2)', () => {
  const s = buildHoldConfirmSituation('Do NOT greet. ', 'פילאטיס', 'Sunday, 5 Jul', '18:00')

  it('restates the exact slot (service, day, time) and carries the first-message prefix', () => {
    expect(s).toContain('פילאטיס')
    expect(s).toContain('Sunday, 5 Jul')
    expect(s).toContain('18:00')
    expect(s.startsWith('Do NOT greet. ')).toBe(true)
  })

  it('directs a SINGLE yes/no confirmation', () => {
    expect(s).toMatch(/\bONE\b[^.]*yes\/no/i)
    expect(s).toMatch(/single[^.]*yes\/no/i)
  })

  it('explicitly forbids stacking a second question or offering an either/or', () => {
    expect(s).toMatch(/do NOT stack/i)
    expect(s).toMatch(/either\/or/i) // the directive names and forbids the either/or shape
  })

  it('stays warm + first-person (no robotic menu tell)', () => {
    expect(s).toMatch(/first-person/i)
    expect(s).not.toMatch(/numbered|menu|press \d/i)
  })
})
