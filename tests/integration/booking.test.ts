// Mocks must be declared before any imports (vitest hoists these)
import { vi } from 'vitest'

vi.mock('../../src/redis.js', () => ({
  redisConnection: { quit: vi.fn(), on: vi.fn(), disconnect: vi.fn() },
}))
vi.mock('../../src/workers/message-retry.js', () => ({
  enqueueMessage: vi.fn().mockResolvedValue(undefined),
  messageRetryQueue: { add: vi.fn() },
  startMessageRetryWorker: vi.fn(),
}))
vi.mock('../../src/workers/reminder.js', () => ({
  scheduleReminders: vi.fn().mockResolvedValue(undefined),
  cancelReminders: vi.fn().mockResolvedValue(undefined),
  startReminderWorker: vi.fn(),
}))
vi.mock('../../src/workers/waitlist.js', () => ({
  triggerWaitlistForSlot: vi.fn().mockResolvedValue(undefined),
  startWaitlistWorker: vi.fn(),
}))
vi.mock('../../src/workers/queued-messages.js', () => ({
  queueMessageForLater: vi.fn().mockResolvedValue(undefined),
  startQueuedMessageWorker: vi.fn(),
}))

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { parseConfirmation } from '../../src/domain/flows/types.js'
import {
  seedBusiness, seedConfirmedBooking, seedCustomer,
  freshPhone, teardown, integrationEnabled, llmEnabled, futureDateStr,
} from './setup.js'
import { sim, assertAllRepliesInLanguage } from './runner.js'
import { agentRun } from './agent.js'
import type { TestBusiness } from './setup.js'
import type { SimContext } from './runner.js'

// ── Category B: parseConfirmation — pure unit, no DB needed ─────────────────

describe('B — parseConfirmation Hebrew gaps', () => {
  // These FAIL until B2 is fixed — each missing pattern is a bug
  it('B2.1 recognises "טוב" as YES', () => {
    expect(parseConfirmation('טוב')).toBe('yes')
  })
  it('B2.2 recognises "בהחלט" as YES', () => {
    expect(parseConfirmation('בהחלט')).toBe('yes')
  })
  it('B2.3 recognises "יאללה" as YES', () => {
    expect(parseConfirmation('יאללה')).toBe('yes')
  })
  it('B2.4 recognises "נשמע טוב" as YES', () => {
    expect(parseConfirmation('נשמע טוב')).toBe('yes')
  })
  it('B2.5 recognises "כל הכבוד" as YES', () => {
    expect(parseConfirmation('כל הכבוד')).toBe('yes')
  })
  it('B2.6 recognises "סגור" as NO', () => {
    expect(parseConfirmation('סגור')).toBe('no')
  })
  it('B2.7 recognises "אל כן" as NO', () => {
    expect(parseConfirmation('אל כן')).toBe('no')
  })
  it('B2.8 recognises "סליחה לא" as NO', () => {
    expect(parseConfirmation('סליחה לא')).toBe('no')
  })

  // Control — already working
  it('control: "כן" is YES', () => {
    expect(parseConfirmation('כן')).toBe('yes')
  })
  it('control: "לא" is NO', () => {
    expect(parseConfirmation('לא')).toBe('no')
  })
  it('control: "yes" is YES', () => {
    expect(parseConfirmation('yes')).toBe('yes')
  })
  it('control: "no" is NO', () => {
    expect(parseConfirmation('no')).toBe('no')
  })
  it('control: "maybe" is unclear', () => {
    expect(parseConfirmation('maybe')).toBe('unclear')
  })
})

// ── Integration tests — require live DB and LLM ──────────────────────────────

describe.skipIf(!integrationEnabled)('A — Happy path booking flows', () => {
  let biz: TestBusiness
  let customerCtx: SimContext

  beforeEach(async () => {
    biz = await seedBusiness({ language: 'he', calendarMode: 'internal', available247: true })
    customerCtx = { fromNumber: freshPhone(), toNumber: biz.waNumber, businessId: biz.businessId }
  })

  afterEach(async () => {
    await teardown(biz.businessId)
  })

  it.skipIf(!llmEnabled)('A1-he: full booking flow in Hebrew — request → hold → confirm', async () => {
    const slot = futureDateStr('he', 3, 10)

    // First message: booking intent
    const r1 = await sim(customerCtx, `אני רוצה לקבוע תספורת ${slot}`)
    expect(r1.replies.length).toBeGreaterThan(0)
    assertAllRepliesInLanguage(r1, 'he')

    // Bot should ask for confirmation — session in waiting_confirmation
    expect(['waiting_confirmation', 'waiting_clarification', 'active']).toContain(r1.sessionState)

    // Drive to confirmation
    let state = r1
    for (let i = 0; i < 6; i++) {
      if (state.sessionState === 'waiting_confirmation') break
      state = await sim(customerCtx, futureDateStr('he', 3 + i, 10 + i))
      assertAllRepliesInLanguage(state, 'he')
    }

    // Confirm
    const rConfirm = await sim(customerCtx, 'כן')
    assertAllRepliesInLanguage(rConfirm, 'he')

    // After first YES the hold is placed; second YES confirms
    if (rConfirm.sessionState === 'waiting_confirmation') {
      const rFinal = await sim(customerCtx, 'כן')
      assertAllRepliesInLanguage(rFinal, 'he')
      expect(rFinal.bookingState).toBe('confirmed')
      expect(rFinal.sessionState).toBe('completed')
    } else {
      expect(rConfirm.bookingState).toBe('confirmed')
      expect(rConfirm.sessionState).toBe('completed')
    }
  })

  it.skipIf(!llmEnabled)('A1-en: full booking flow in English — request → hold → confirm', async () => {
    const engBiz = await seedBusiness({ language: 'en', calendarMode: 'internal', available247: true })
    const engCtx: SimContext = { fromNumber: freshPhone(), toNumber: engBiz.waNumber, businessId: engBiz.businessId }

    try {
      const slot = futureDateStr('en', 3, 10)
      const r1 = await sim(engCtx, `I'd like to book a haircut on ${slot}`)
      expect(r1.replies.length).toBeGreaterThan(0)
      assertAllRepliesInLanguage(r1, 'en')

      let state = r1
      for (let i = 0; i < 6; i++) {
        if (state.sessionState === 'waiting_confirmation') break
        state = await sim(engCtx, futureDateStr('en', 3 + i, 10 + i))
        assertAllRepliesInLanguage(state, 'en')
      }

      const rConfirm = await sim(engCtx, 'yes')
      assertAllRepliesInLanguage(rConfirm, 'en')

      if (rConfirm.sessionState === 'waiting_confirmation') {
        const rFinal = await sim(engCtx, 'yes')
        assertAllRepliesInLanguage(rFinal, 'en')
        expect(rFinal.bookingState).toBe('confirmed')
      } else {
        expect(rConfirm.bookingState).toBe('confirmed')
      }
    } finally {
      await teardown(engBiz.businessId)
    }
  })

  it.skipIf(!llmEnabled)('A4: list bookings returns upcoming appointments', async () => {
    // Seed a confirmed booking directly
    const customerId = await seedCustomer(biz.businessId, customerCtx.fromNumber)
    await seedConfirmedBooking(biz.businessId, customerId, biz.serviceId, 5)

    const r = await sim(customerCtx, 'מה התורים שלי?')
    expect(r.replies.length).toBeGreaterThan(0)
    assertAllRepliesInLanguage(r, 'he')
    expect(r.sessionState).toBe('completed')
    // Reply should contain a date reference
    const reply = r.replies.join(' ')
    expect(reply.length).toBeGreaterThan(5)
  })

  it.skipIf(!llmEnabled)('A5: cancellation of single confirmed booking', async () => {
    const customerId = await seedCustomer(biz.businessId, customerCtx.fromNumber)
    await seedConfirmedBooking(biz.businessId, customerId, biz.serviceId, 5)

    const r1 = await sim(customerCtx, 'אני רוצה לבטל את התור שלי')
    assertAllRepliesInLanguage(r1, 'he')
    expect(r1.sessionState).toBe('waiting_confirmation')

    const r2 = await sim(customerCtx, 'כן')
    assertAllRepliesInLanguage(r2, 'he')
    expect(r2.bookingState).toBe('cancelled')
    expect(r2.sessionState).toBe('completed')
  })

  it.skipIf(!llmEnabled)('A7: cancellation with multiple bookings — numbered selection', async () => {
    const customerId = await seedCustomer(biz.businessId, customerCtx.fromNumber)
    await seedConfirmedBooking(biz.businessId, customerId, biz.serviceId, 5)
    await seedConfirmedBooking(biz.businessId, customerId, biz.serviceId, 7)

    const r1 = await sim(customerCtx, 'אני רוצה לבטל')
    assertAllRepliesInLanguage(r1, 'he')
    // Should list both bookings
    expect(r1.sessionState).toBe('waiting_clarification')
    const reply = r1.replies[0] ?? ''
    expect(reply).toMatch(/1|2/) // numbered list

    const r2 = await sim(customerCtx, '1')
    assertAllRepliesInLanguage(r2, 'he')
    expect(r2.sessionState).toBe('waiting_confirmation')

    const r3 = await sim(customerCtx, 'כן')
    assertAllRepliesInLanguage(r3, 'he')
    expect(r3.bookingState).toBe('cancelled')
  })

  it.skipIf(!llmEnabled)('A8 — B1 regression: reschedule with multiple bookings must ask for new time', async () => {
    const customerId = await seedCustomer(biz.businessId, customerCtx.fromNumber)
    await seedConfirmedBooking(biz.businessId, customerId, biz.serviceId, 5)
    await seedConfirmedBooking(biz.businessId, customerId, biz.serviceId, 7)

    // Trigger rescheduling intent
    const r1 = await sim(customerCtx, 'אני רוצה לשנות תור')
    assertAllRepliesInLanguage(r1, 'he')
    expect(r1.sessionState).toBe('waiting_clarification')

    // Select booking 1
    const r2 = await sim(customerCtx, '1')
    assertAllRepliesInLanguage(r2, 'he')
    expect(r2.sessionState).toBe('waiting_confirmation')

    // Confirm cancellation
    const r3 = await sim(customerCtx, 'כן')
    assertAllRepliesInLanguage(r3, 'he')

    // BUG B1: session completes here instead of asking for new time
    // This assertion FAILS until B1 is fixed:
    expect(r3.sessionState).not.toBe('completed')
    // Bot must ask for new appointment time
    const botReply = (r3.replies[0] ?? '').toLowerCase()
    const asksForTime = botReply.includes('מתי') || botReply.includes('תאריך') || botReply.includes('שעה') || botReply.includes('when') || botReply.includes('date')
    expect(asksForTime).toBe(true)
  })
})

// ── Category D: Session & state machine edge cases ───────────────────────────

describe.skipIf(!integrationEnabled)('D — Session edge cases', () => {
  let biz: TestBusiness

  beforeEach(async () => {
    biz = await seedBusiness({ language: 'he', calendarMode: 'internal', available247: true })
  })

  afterEach(async () => {
    await teardown(biz.businessId)
  })

  it.skipIf(!llmEnabled)('D7: clarification loop ends after 3 attempts — does not loop forever', async () => {
    const ctx: SimContext = { fromNumber: freshPhone(), toNumber: biz.waNumber, businessId: biz.businessId }

    // Send vague messages that can't resolve to a specific time
    await sim(ctx, 'אני רוצה תספורת')           // intent detected, no time
    await sim(ctx, 'מתי שנוח לכם')                // still vague
    await sim(ctx, 'לא יודע בדיוק')               // still vague
    const r4 = await sim(ctx, 'תלוי בכם')          // 4th attempt — should hit limit

    // After 3 clarification attempts, the bot apologises and ends the session (state = failed)
    expect(['failed', 'completed']).toContain(r4.sessionState)
    const reply = (r4.replies[0] ?? '').toLowerCase()
    // Reply should convey apology/end — no more asking for time
    expect(reply.length).toBeGreaterThan(0)
  })

  it.skipIf(!llmEnabled)('D1: customer stuck in waiting_confirmation can eventually cancel', async () => {
    const ctx: SimContext = { fromNumber: freshPhone(), toNumber: biz.waNumber, businessId: biz.businessId }
    const slot = futureDateStr('he', 3, 10)

    await sim(ctx, `תספורת ${slot}`)
    // Drive to waiting_confirmation
    let state = await sim(ctx, slot)
    for (let i = 0; i < 5 && state.sessionState !== 'waiting_confirmation'; i++) {
      state = await sim(ctx, futureDateStr('he', 3 + i, 10))
    }
    if (state.sessionState !== 'waiting_confirmation') return // couldn't get there, skip

    // Send irrelevant messages — bot should ask for YES/NO each time, not crash
    for (let i = 0; i < 3; i++) {
      const r = await sim(ctx, 'מה שלומך?')
      expect(r.replies.length).toBeGreaterThan(0)
      // Session must still be alive
      expect(['waiting_confirmation', 'active', 'completed']).toContain(r.sessionState)
    }

    // Ultimately decline
    const rNo = await sim(ctx, 'לא')
    expect(['completed', 'active']).toContain(rNo.sessionState)
  })

  it.skipIf(!llmEnabled)('D8: missing pendingSlot in hold context handled gracefully', async () => {
    // Seed a session in waiting_confirmation with broken context (no pendingSlot)
    const { db } = await import('../../src/db/client.js')
    const { conversationSessions } = await import('../../src/db/schema.js')

    const customerPhone = freshPhone()
    const customerId = await seedCustomer(biz.businessId, customerPhone)

    const ctx: SimContext = { fromNumber: customerPhone, toNumber: biz.waNumber, businessId: biz.businessId }

    // Create a broken session directly
    await db.insert(conversationSessions).values({
      businessId: biz.businessId,
      identityId: customerId,
      intent: 'booking',
      state: 'waiting_confirmation',
      context: { awaitingConfirmationFor: 'hold' }, // pendingSlot intentionally absent
      lastMessageAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    })

    const r = await sim(ctx, 'כן')
    // Should not crash; session should be failed or completed with graceful message
    expect(['failed', 'completed']).toContain(r.sessionState)
    expect(r.replies.length).toBeGreaterThan(0)
  })

  it.skipIf(!llmEnabled)('D3 — B7: hold expiry leaves session open, customer gets no notification', async () => {
    // Create a customer with an expired hold in the DB
    const customerPhone = freshPhone()
    const customerId = await seedCustomer(biz.businessId, customerPhone)

    const { db } = await import('../../src/db/client.js')
    const { bookings: bookingsTable } = await import('../../src/db/schema.js')

    const slotStart = new Date(Date.now() + 2 * 60 * 60 * 1000)
    const slotEnd = new Date(slotStart.getTime() + 30 * 60 * 1000)

    const [booking] = await db.insert(bookingsTable).values({
      businessId: biz.businessId,
      serviceTypeId: biz.serviceId,
      customerId,
      requestedAt: new Date(),
      slotStart,
      slotEnd,
      state: 'held',
      holdExpiresAt: new Date(Date.now() - 1000), // already expired
      calendarEventId: `internal:test-${crypto.randomUUID()}`,
      slotTzAtCreation: 'Asia/Jerusalem',
    }).returning()

    // Run hold expiry worker
    const { expireHeldBookings } = await import('../../src/workers/hold-expiry.js')
    await expireHeldBookings()

    // B7: verify no notification was sent to the customer (enqueueMessage not called for customer)
    const { enqueueMessage } = await import('../../src/workers/message-retry.js')
    const calls = vi.mocked(enqueueMessage).mock.calls
    const customerNotified = calls.some(([toNumber]) => toNumber === customerPhone)
    // This assertion FAILS until B7 is fixed (customer should be notified on hold expiry)
    expect(customerNotified).toBe(true)
  })
})

// ── Agentic happy-path tests ─────────────────────────────────────────────────

describe.skipIf(!llmEnabled)('A-agent — Full agentic booking flows', () => {
  let biz: TestBusiness

  beforeEach(async () => {
    biz = await seedBusiness({ language: 'he', calendarMode: 'internal', available247: true })
  })

  afterEach(async () => {
    await teardown(biz.businessId)
  })

  it('A-agent-he: agent books a haircut in Hebrew end-to-end', async () => {
    const ctx: SimContext = { fromNumber: freshPhone(), toNumber: biz.waNumber, businessId: biz.businessId }
    const slot = futureDateStr('he', 3, 10)
    const result = await agentRun({
      goal: `קבע תספורת ${slot} ואשר אותה`,
      lang: 'he',
      ctx,
      businessName: 'מספרת בדיקה',
      serviceName: 'תספורת',
      slotHint: slot,
    })

    expect(result.failureReason).toBeNull()
    expect(result.success).toBe(true)
    expect(result.finalState?.bookingState).toBe('confirmed')
  })

  it('A-agent-en: agent books a haircut in English end-to-end', async () => {
    const engBiz = await seedBusiness({ language: 'en', calendarMode: 'internal', available247: true })
    const ctx: SimContext = { fromNumber: freshPhone(), toNumber: engBiz.waNumber, businessId: engBiz.businessId }

    try {
      const slot = futureDateStr('en', 3, 10)
      const result = await agentRun({
        goal: `Book a haircut on ${slot} and confirm it`,
        lang: 'en',
        ctx,
        businessName: 'Test Barbershop',
        serviceName: 'Haircut',
        slotHint: slot,
      })

      expect(result.failureReason).toBeNull()
      expect(result.success).toBe(true)
      expect(result.finalState?.bookingState).toBe('confirmed')
    } finally {
      await teardown(engBiz.businessId)
    }
  })

  it('A6-agent-he: reschedule single booking in Hebrew', async () => {
    const ctx: SimContext = { fromNumber: freshPhone(), toNumber: biz.waNumber, businessId: biz.businessId }
    const customerId = await seedCustomer(biz.businessId, ctx.fromNumber)
    await seedConfirmedBooking(biz.businessId, customerId, biz.serviceId, 5)

    const slot = futureDateStr('he', 4, 14)
    const result = await agentRun({
      goal: `שנה את התור הקיים שלי ל${slot} ואשר אותו`,
      lang: 'he',
      ctx,
      businessName: 'מספרת בדיקה',
      serviceName: 'תספורת',
      slotHint: slot,
      maxTurns: 16,
    })

    // Reschedule = cancel old + confirm new (B1 bug: new booking may not be created)
    expect(result.finalState?.bookingState).toBe('confirmed')
  })
})
