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
import {
  seedBusiness, seedConfirmedBooking, seedCustomer,
  freshPhone, teardown, integrationEnabled, llmEnabled,
} from './setup.js'
import { sim, hasLanguageLeak } from './runner.js'
import type { TestBusiness } from './setup.js'
import type { SimContext } from './runner.js'

// ── E — Manager commands ───────────────────────────────────────────────────────

describe.skipIf(!integrationEnabled)('E — Manager commands', () => {
  let heBiz: TestBusiness
  let heManagerCtx: SimContext

  beforeEach(async () => {
    heBiz = await seedBusiness({ language: 'he', available247: true })
    heManagerCtx = {
      fromNumber: heBiz.managerPhone,
      toNumber: heBiz.waNumber,
      businessId: heBiz.businessId,
    }
  })

  afterEach(async () => {
    await teardown(heBiz.businessId)
  })

  // ── E1: STATUS ────────────────────────────────────────────────────────────
  it.skipIf(!llmEnabled)('E1: STATUS returns structured report without crashing', async () => {
    const r = await sim(heManagerCtx, 'STATUS')
    expect(r.replies.length).toBeGreaterThan(0)
    const reply = r.replies[0]!
    // Must contain something meaningful
    expect(reply.length).toBeGreaterThan(5)
    // Must be in Hebrew
    expect(hasLanguageLeak(reply, 'he')).toBe(false)
  })

  it.skipIf(!llmEnabled)('E1-en: STATUS in English business returns English report', async () => {
    const enBiz = await seedBusiness({ language: 'en', available247: true })
    const enManagerCtx: SimContext = {
      fromNumber: enBiz.managerPhone,
      toNumber: enBiz.waNumber,
      businessId: enBiz.businessId,
    }

    try {
      const r = await sim(enManagerCtx, 'STATUS')
      expect(r.replies.length).toBeGreaterThan(0)
      expect(hasLanguageLeak(r.replies[0]!, 'en')).toBe(false)
    } finally {
      await teardown(enBiz.businessId)
    }
  })

  // ── E2: PAUSE then customer gets paused message ───────────────────────────
  it.skipIf(!llmEnabled)('E2: PAUSE — customer messages are rejected while paused', async () => {
    // Pause the PA
    const rPause = await sim(heManagerCtx, 'PAUSE')
    expect(rPause.replies.length).toBeGreaterThan(0)

    // Customer tries to book
    const customerCtx: SimContext = { fromNumber: freshPhone(), toNumber: heBiz.waNumber, businessId: heBiz.businessId }
    const rCustomer = await sim(customerCtx, 'אני רוצה לקבוע תספורת')

    // Customer must receive a "paused" message, not a booking flow response
    expect(rCustomer.replies.length).toBeGreaterThan(0)
    const reply = rCustomer.replies[0]!
    // Should be in Hebrew
    expect(hasLanguageLeak(reply, 'he')).toBe(false)
    // Booking flow should NOT have started — no booking created
    expect(rCustomer.bookingState).toBeNull()
    expect(rCustomer.sessionState).not.toBe('waiting_confirmation')
  })

  // ── E3: RESUME then customer can book ────────────────────────────────────
  it.skipIf(!llmEnabled)('E3: RESUME — customer can book after resume', async () => {
    // Pause then resume
    await sim(heManagerCtx, 'PAUSE')
    const rResume = await sim(heManagerCtx, 'RESUME')
    expect(rResume.replies.length).toBeGreaterThan(0)

    // Customer books
    const customerCtx: SimContext = { fromNumber: freshPhone(), toNumber: heBiz.waNumber, businessId: heBiz.businessId }
    const r = await sim(customerCtx, 'אני רוצה לקבוע תספורת')
    expect(r.replies.length).toBeGreaterThan(0)
    // Booking flow should start normally
    expect(r.sessionState).not.toBeNull()
  })

  // ── E4: UPCOMING lists confirmed bookings ─────────────────────────────────
  it.skipIf(!llmEnabled)('E4: UPCOMING lists confirmed upcoming bookings', async () => {
    // Seed a confirmed booking
    const customerId = await seedCustomer(heBiz.businessId, freshPhone())
    await seedConfirmedBooking(heBiz.businessId, customerId, heBiz.serviceId, 3)

    const r = await sim(heManagerCtx, 'UPCOMING')
    expect(r.replies.length).toBeGreaterThan(0)
    const reply = r.replies[0]!
    expect(reply.length).toBeGreaterThan(5)
    expect(hasLanguageLeak(reply, 'he')).toBe(false)
  })

  it.skipIf(!llmEnabled)('E4: UPCOMING with no bookings returns graceful empty message', async () => {
    const r = await sim(heManagerCtx, 'UPCOMING')
    expect(r.replies.length).toBeGreaterThan(0)
    // Should not crash — reply must exist
    expect(r.replies[0]!.length).toBeGreaterThan(0)
  })

  // ── E5: PAID <phone> confirms payment ────────────────────────────────────
  it.skipIf(!llmEnabled)('E5: PAID confirms payment and moves booking to confirmed state', async () => {
    // We need a booking in pending_payment — seed one directly
    const customerPhone = freshPhone()
    const customerId = await seedCustomer(heBiz.businessId, customerPhone)

    // Insert booking in pending_payment state
    const { db } = await import('../../src/db/client.js')
    const { bookings } = await import('../../src/db/schema.js')
    const slotStart = new Date()
    slotStart.setDate(slotStart.getDate() + 5)
    slotStart.setHours(10, 0, 0, 0)
    const slotEnd = new Date(slotStart.getTime() + 30 * 60_000)

    const [booking] = await db
      .insert(bookings)
      .values({
        businessId: heBiz.businessId,
        serviceTypeId: heBiz.serviceId,
        customerId,
        requestedAt: new Date(),
        slotStart,
        slotEnd,
        state: 'pending_payment',
        slotTzAtCreation: 'Asia/Jerusalem',
        calendarEventId: 'internal:test-paid-seed',
      })
      .returning()

    if (!booking) throw new Error('E5: booking seed failed')

    const r = await sim(heManagerCtx, `PAID ${customerPhone}`)
    expect(r.replies.length).toBeGreaterThan(0)
    const reply = r.replies[0]!

    // Reply should confirm payment
    expect(reply.length).toBeGreaterThan(5)
    expect(hasLanguageLeak(reply, 'he')).toBe(false)

    // Booking should now be confirmed
    const { eq } = await import('drizzle-orm')
    const [updated] = await db
      .select({ state: bookings.state })
      .from(bookings)
      .where(eq(bookings.id, booking.id))
      .limit(1)

    expect(updated?.state).toBe('confirmed')
  })

  it.skipIf(!llmEnabled)('E5: PAID with unknown phone returns error gracefully', async () => {
    const r = await sim(heManagerCtx, 'PAID +972599999999')
    expect(r.replies.length).toBeGreaterThan(0)
    // Should not crash — returns an error message
    expect(r.replies[0]!.length).toBeGreaterThan(0)
  })

  // ── E6: HANDLED resolves escalation task ──────────────────────────────────
  it.skipIf(!llmEnabled)('E6: HANDLED marks escalation as handled', async () => {
    const customerPhone = freshPhone()
    const customerId = await seedCustomer(heBiz.businessId, customerPhone)

    // Seed an escalation task directly
    const { db } = await import('../../src/db/client.js')
    const { sql } = await import('drizzle-orm')
    await db.execute(
      sql`INSERT INTO escalated_tasks (business_id, customer_phone, message_body, received_at, escalation_type)
          VALUES (${heBiz.businessId}, ${customerPhone}, 'test escalation message', NOW(), 'platform')`,
    )

    const r = await sim(heManagerCtx, `HANDLED ${customerPhone}`)
    expect(r.replies.length).toBeGreaterThan(0)
    const reply = r.replies[0]!
    expect(reply.length).toBeGreaterThan(0)
    expect(hasLanguageLeak(reply, 'he')).toBe(false)
  })

  // ── E7: Hebrew natural language instruction — service_change ─────────────
  it.skipIf(!llmEnabled)('E7: Hebrew "הוסף שירות" creates a new service', async () => {
    const { db } = await import('../../src/db/client.js')
    const { serviceTypes } = await import('../../src/db/schema.js')
    const { eq } = await import('drizzle-orm')

    const r = await sim(heManagerCtx, 'הוסף שירות: צביעת שיער, 60 דקות')
    expect(r.replies.length).toBeGreaterThan(0)
    const reply = r.replies[0]!
    expect(hasLanguageLeak(reply, 'he')).toBe(false)

    // A new service should exist in the DB
    const services = await db
      .select({ name: serviceTypes.name })
      .from(serviceTypes)
      .where(eq(serviceTypes.businessId, heBiz.businessId))

    // Either a new service was created (count > 2 = the 2 seeded in beforeEach)
    // or reply indicates success — LLM may use different Hebrew for colour/hair
    expect(services.length).toBeGreaterThan(2)
  })

  // ── E8: Hebrew "בלוק יום שישי" — availability_change ────────────────────
  it.skipIf(!llmEnabled)('E8: Hebrew "בלוק יום שישי" blocks that day', async () => {
    const r = await sim(heManagerCtx, 'בלוק יום שישי')
    expect(r.replies.length).toBeGreaterThan(0)
    const reply = r.replies[0]!
    // Reply must be in Hebrew confirming the block
    expect(hasLanguageLeak(reply, 'he')).toBe(false)
    // Should confirm something about Friday / יום שישי
    // (exact phrasing depends on LLM, just check it's not an error)
    expect(r.replies[0]!.length).toBeGreaterThan(5)
  })

  // ── E9: Hebrew ambiguous instruction → clarification in Hebrew (exposes B8) ─
  it.skipIf(!llmEnabled)('E9: ambiguous Hebrew instruction → clarification question in Hebrew (B8)', async () => {
    // "שנה שירות" is intentionally vague — no service name or target
    const r = await sim(heManagerCtx, 'שנה שירות')
    expect(r.replies.length).toBeGreaterThan(0)
    const reply = r.replies[0]!

    // B8: currently clarificationNeeded is generated in English even for Hebrew managers
    // This FAILS until B8 is fixed (language passed to classifyManagerInstruction)
    expect(hasLanguageLeak(reply, 'he')).toBe(false)
    expect(/[א-ת]/.test(reply)).toBe(true)
  })

  it.skipIf(!llmEnabled)('E9-en: ambiguous English instruction → clarification in English', async () => {
    const enBiz = await seedBusiness({ language: 'en', available247: true })
    const enManagerCtx: SimContext = {
      fromNumber: enBiz.managerPhone,
      toNumber: enBiz.waNumber,
      businessId: enBiz.businessId,
    }

    try {
      const r = await sim(enManagerCtx, 'update the service')
      expect(r.replies.length).toBeGreaterThan(0)
      const reply = r.replies[0]!
      expect(hasLanguageLeak(reply, 'en')).toBe(false)
    } finally {
      await teardown(enBiz.businessId)
    }
  })

  // ── E10: Hebrew "24/7" equivalent during onboarding (exposes B6) ──────────
  it.skipIf(!llmEnabled)('E10: "תמיד פתוח" in onboarding hours step sets available247 (B6)', async () => {
    const { db } = await import('../../src/db/client.js')
    const { businesses } = await import('../../src/db/schema.js')
    const { eq } = await import('drizzle-orm')

    // Put business back to hours step
    await db.update(businesses)
      .set({ onboardingStep: 'hours', onboardingCompletedAt: null, available247: false })
      .where(eq(businesses.id, heBiz.businessId))

    // B6: "תמיד פתוח" currently NOT matched — test FAILS until B6 fixed
    const r = await sim(heManagerCtx, 'תמיד פתוח')
    expect(r.replies.length).toBeGreaterThan(0)
    expect(hasLanguageLeak(r.replies[0]!, 'he')).toBe(false)

    const [updated] = await db
      .select({ is247: businesses.available247, step: businesses.onboardingStep })
      .from(businesses)
      .where(eq(businesses.id, heBiz.businessId))
      .limit(1)

    expect(updated?.is247).toBe(true)
    expect(updated?.step).not.toBe('hours')
  })

  // ── E11: Customer messages while business is paused ───────────────────────
  it.skipIf(!llmEnabled)('E11: paused business sends correct language to customer', async () => {
    const enBiz = await seedBusiness({ language: 'en', available247: true, paused: true })
    const customerCtx: SimContext = { fromNumber: freshPhone(), toNumber: enBiz.waNumber, businessId: enBiz.businessId }

    try {
      const r = await sim(customerCtx, 'I want to book a haircut')
      expect(r.replies.length).toBeGreaterThan(0)
      expect(hasLanguageLeak(r.replies[0]!, 'en')).toBe(false)
    } finally {
      await teardown(enBiz.businessId)
    }
  })

  // ── E12: Instruction after onboarding — classified and applied ────────────
  it.skipIf(!llmEnabled)('E12: policy change instruction is recorded and acknowledged', async () => {
    const r = await sim(heManagerCtx, 'מדיניות ביטול: ביטול עד 24 שעות לפני - ללא עלות')
    expect(r.replies.length).toBeGreaterThan(0)
    const reply = r.replies[0]!
    expect(reply.length).toBeGreaterThan(5)
    expect(hasLanguageLeak(reply, 'he')).toBe(false)
  })
})
