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
  seedBusiness, freshPhone, teardown, integrationEnabled, llmEnabled, futureDateStr,
} from './setup.js'
import { sim, assertAllRepliesInLanguage, hasLanguageLeak } from './runner.js'
import type { TestBusiness } from './setup.js'
import type { SimContext } from './runner.js'

// ── C — Language parity matrix ────────────────────────────────────────────────
//
// Every test runs a flow in both Hebrew and English, asserting:
//   (a) replies are in the correct language (no leakage)
//   (b) structural outcomes match (same session states, booking states)
//
// Bug regressions: C1→B3, C2→B4, C3→B4, C4→B8, C7→B5, C10→B6

describe.skipIf(!integrationEnabled)('C — Language parity', () => {

  // ── C1: Quota error is localized ────────────────────────────────────────────
  //
  // When LLM quota is exceeded, the error message must be in the business's
  // language. B3: English hardcoded even when lang === 'he'.
  //
  // This test stubs extractCustomerIntent to return quota_exceeded, then
  // checks that the reply matches the expected language.
  describe('C1 — quota error reply language', () => {
    let heBiz: TestBusiness
    let enBiz: TestBusiness

    beforeEach(async () => {
      ;[heBiz, enBiz] = await Promise.all([
        seedBusiness({ language: 'he', available247: true }),
        seedBusiness({ language: 'en', available247: true }),
      ])
    })

    afterEach(async () => {
      await Promise.all([teardown(heBiz.businessId), teardown(enBiz.businessId)])
    })

    it.skipIf(!llmEnabled)('C1-he: quota error reply must be Hebrew', async () => {
      // Force quota error by stubbing the LLM client after import resolution
      const { extractCustomerIntent } = await import('../../src/adapters/llm/client.js')
      const spy = vi.spyOn(
        await import('../../src/adapters/llm/client.js'),
        'extractCustomerIntent',
      ).mockResolvedValueOnce({ ok: false, error: 'quota_exceeded' })

      const ctx: SimContext = { fromNumber: freshPhone(), toNumber: heBiz.waNumber, businessId: heBiz.businessId }
      const r = await sim(ctx, 'אני רוצה לקבוע תור')

      spy.mockRestore()

      expect(r.replies.length).toBeGreaterThan(0)
      const reply = r.replies[0]!
      // B3: currently the quota message is hardcoded English — this test FAILS until B3 is fixed
      expect(hasLanguageLeak(reply, 'he')).toBe(false)
      // Must contain Hebrew characters
      expect(/[א-ת]/.test(reply)).toBe(true)
    })

    it.skipIf(!llmEnabled)('C1-en: quota error reply must be English', async () => {
      const spy = vi.spyOn(
        await import('../../src/adapters/llm/client.js'),
        'extractCustomerIntent',
      ).mockResolvedValueOnce({ ok: false, error: 'quota_exceeded' })

      const ctx: SimContext = { fromNumber: freshPhone(), toNumber: enBiz.waNumber, businessId: enBiz.businessId }
      const r = await sim(ctx, 'I want to book an appointment')

      spy.mockRestore()

      expect(r.replies.length).toBeGreaterThan(0)
      const reply = r.replies[0]!
      expect(hasLanguageLeak(reply, 'en')).toBe(false)
      expect(/[a-zA-Z]/.test(reply)).toBe(true)
    })
  })

  // ── C2: Language switch offer — English-default biz, Hebrew-writing customer ─
  //
  // B4: English-default side is missing כן/לא suffix and has no mirror.
  // Both directions must be bilingual so the customer understands.
  describe('C2 — language switch offer (English biz, Hebrew customer)', () => {
    let biz: TestBusiness

    beforeEach(async () => {
      biz = await seedBusiness({ language: 'en', available247: true })
    })

    afterEach(async () => { await teardown(biz.businessId) })

    it.skipIf(!llmEnabled)('C2: offer must mention both כן/לא and YES/NO', async () => {
      const ctx: SimContext = { fromNumber: freshPhone(), toNumber: biz.waNumber, businessId: biz.businessId }
      // Hebrew-writing customer to English-default business → triggers language switch offer
      const r = await sim(ctx, 'שלום אני רוצה לקבוע תור')

      expect(r.replies.length).toBeGreaterThan(0)
      const reply = r.replies[0]!

      // Session must be waiting for language confirmation
      expect(r.sessionState).toBe('waiting_language_confirmation')

      // B4: English-default side is missing Hebrew (כן / לא) — FAILS until B4 fixed
      expect(reply).toMatch(/כן/)
      expect(reply).toMatch(/לא/)
      // Must also have English options so English-reader understands
      expect(reply).toMatch(/YES|yes/)
      expect(reply).toMatch(/NO|no/)
    })
  })

  // ── C3: Language switch offer — Hebrew-default biz, English-writing customer ─
  //
  // Symmetric case: customer writes English to Hebrew-default business.
  // The offer must be bilingual (both כן/לא and YES/NO).
  describe('C3 — language switch offer (Hebrew biz, English customer)', () => {
    let biz: TestBusiness

    beforeEach(async () => {
      biz = await seedBusiness({ language: 'he', available247: true })
    })

    afterEach(async () => { await teardown(biz.businessId) })

    it.skipIf(!llmEnabled)('C3: offer must mention both YES/NO and כן/לא', async () => {
      const ctx: SimContext = { fromNumber: freshPhone(), toNumber: biz.waNumber, businessId: biz.businessId }
      // English-writing customer to Hebrew-default business
      const r = await sim(ctx, 'Hello I want to book an appointment')

      expect(r.replies.length).toBeGreaterThan(0)
      const reply = r.replies[0]!

      // May be language switch offer or direct booking flow depending on intent detection
      if (r.sessionState === 'waiting_language_confirmation') {
        // Offer must be bilingual
        expect(reply).toMatch(/YES|yes/)
        expect(reply).toMatch(/NO|no/)
        expect(reply).toMatch(/כן/)
        expect(reply).toMatch(/לא/)
      } else {
        // If no offer, reply must be in Hebrew (business default, no switch done yet)
        expect(hasLanguageLeak(reply, 'he')).toBe(false)
      }
    })

    it.skipIf(!llmEnabled)('C3: after accepting language switch, replies are in English', async () => {
      const ctx: SimContext = { fromNumber: freshPhone(), toNumber: biz.waNumber, businessId: biz.businessId }
      const r1 = await sim(ctx, 'Hello I want to book an appointment')

      if (r1.sessionState !== 'waiting_language_confirmation') {
        // Language switch not triggered — skip remainder
        return
      }

      // Accept English
      const r2 = await sim(ctx, 'yes')
      expect(r2.replies.length).toBeGreaterThan(0)
      // After accepting English, all subsequent replies should be in English
      assertAllRepliesInLanguage(r2, 'en')
    })

    it.skipIf(!llmEnabled)('C3: after declining language switch, replies stay Hebrew', async () => {
      const ctx: SimContext = { fromNumber: freshPhone(), toNumber: biz.waNumber, businessId: biz.businessId }
      const r1 = await sim(ctx, 'Hello I want to book an appointment')

      if (r1.sessionState !== 'waiting_language_confirmation') {
        return
      }

      // Decline switch — stays Hebrew
      const r2 = await sim(ctx, 'no')
      expect(r2.replies.length).toBeGreaterThan(0)
      assertAllRepliesInLanguage(r2, 'he')
    })
  })

  // ── C4: Manager clarification must be in manager's language ─────────────────
  //
  // B8: classifyManagerInstruction produces clarificationNeeded in English
  // regardless of business language. Hebrew managers get English questions.
  describe('C4 — manager clarification language (exposes B8)', () => {
    let heBiz: TestBusiness
    let enBiz: TestBusiness

    beforeEach(async () => {
      ;[heBiz, enBiz] = await Promise.all([
        seedBusiness({ language: 'he', available247: true }),
        seedBusiness({ language: 'en', available247: true }),
      ])
    })

    afterEach(async () => {
      await Promise.all([teardown(heBiz.businessId), teardown(enBiz.businessId)])
    })

    it.skipIf(!llmEnabled)('C4-he: ambiguous manager instruction → clarification in Hebrew', async () => {
      // Hebrew manager sends vague instruction that requires clarification
      const heManagerCtx: SimContext = {
        fromNumber: heBiz.managerPhone,
        toNumber: heBiz.waNumber,
        businessId: heBiz.businessId,
      }
      // Intentionally vague: "שנה את השירות" — doesn't specify which service
      const r = await sim(heManagerCtx, 'שנה את השירות')

      expect(r.replies.length).toBeGreaterThan(0)
      const reply = r.replies[0]!

      // B8: currently returns English clarification even for Hebrew manager — FAILS until B8 fixed
      expect(hasLanguageLeak(reply, 'he')).toBe(false)
      expect(/[א-ת]/.test(reply)).toBe(true)
    })

    it.skipIf(!llmEnabled)('C4-en: ambiguous manager instruction → clarification in English', async () => {
      const enManagerCtx: SimContext = {
        fromNumber: enBiz.managerPhone,
        toNumber: enBiz.waNumber,
        businessId: enBiz.businessId,
      }
      const r = await sim(enManagerCtx, 'update the service')

      expect(r.replies.length).toBeGreaterThan(0)
      const reply = r.replies[0]!

      expect(hasLanguageLeak(reply, 'en')).toBe(false)
      expect(/[a-zA-Z]/.test(reply)).toBe(true)
    })
  })

  // ── C5: Vague slot clarification ask is in correct language ──────────────────
  //
  // When the customer gives a vague date ("sometime this week"), the bot must
  // ask for clarification in the same language as the business default.
  describe('C5 — vague date clarification language', () => {
    let heBiz: TestBusiness
    let enBiz: TestBusiness

    beforeEach(async () => {
      ;[heBiz, enBiz] = await Promise.all([
        seedBusiness({ language: 'he', available247: true }),
        seedBusiness({ language: 'en', available247: true }),
      ])
    })

    afterEach(async () => {
      await Promise.all([teardown(heBiz.businessId), teardown(enBiz.businessId)])
    })

    it.skipIf(!llmEnabled)('C5-he: vague date → clarification in Hebrew', async () => {
      const ctx: SimContext = { fromNumber: freshPhone(), toNumber: heBiz.waNumber, businessId: heBiz.businessId }
      const r = await sim(ctx, 'אני רוצה לקבוע תספורת, מתי שיהיה הכי קרוב')

      expect(r.replies.length).toBeGreaterThan(0)
      // May result in clarification ask or active flow — either way: Hebrew reply
      for (const reply of r.replies) {
        expect(hasLanguageLeak(reply, 'he')).toBe(false)
      }
    })

    it.skipIf(!llmEnabled)('C5-en: vague date → clarification in English', async () => {
      const ctx: SimContext = { fromNumber: freshPhone(), toNumber: enBiz.waNumber, businessId: enBiz.businessId }
      const r = await sim(ctx, 'I want a haircut sometime this week')

      expect(r.replies.length).toBeGreaterThan(0)
      for (const reply of r.replies) {
        expect(hasLanguageLeak(reply, 'en')).toBe(false)
      }
    })
  })

  // ── C6: Slot unavailable reply is in correct language ───────────────────────
  //
  // When the requested slot is taken, the bot's "that slot is unavailable"
  // message must match the session language.
  describe('C6 — slot unavailable reply language', () => {
    let heBiz: TestBusiness
    let enBiz: TestBusiness

    beforeEach(async () => {
      ;[heBiz, enBiz] = await Promise.all([
        seedBusiness({ language: 'he', available247: true }),
        seedBusiness({ language: 'en', available247: true }),
      ])
    })

    afterEach(async () => {
      await Promise.all([teardown(heBiz.businessId), teardown(enBiz.businessId)])
    })

    it.skipIf(!llmEnabled)('C6-he: Hebrew reply even when slot unavailable', async () => {
      const ctx: SimContext = { fromNumber: freshPhone(), toNumber: heBiz.waNumber, businessId: heBiz.businessId }
      // Request slot in the past — guaranteed unavailable
      const r = await sim(ctx, 'אני רוצה תספורת ב-1 בינואר 2020 בשעה 10:00')

      expect(r.replies.length).toBeGreaterThan(0)
      for (const reply of r.replies) {
        expect(hasLanguageLeak(reply, 'he')).toBe(false)
      }
    })

    it.skipIf(!llmEnabled)('C6-en: English reply when slot unavailable', async () => {
      const ctx: SimContext = { fromNumber: freshPhone(), toNumber: enBiz.waNumber, businessId: enBiz.businessId }
      const r = await sim(ctx, 'I want a haircut on January 1 2020 at 10am')

      expect(r.replies.length).toBeGreaterThan(0)
      for (const reply of r.replies) {
        expect(hasLanguageLeak(reply, 'en')).toBe(false)
      }
    })
  })

  // ── C7: Hebrew equivalent of REBOOK shortcut (exposes B5) ───────────────────
  //
  // B5: REBOOK is checked with `=== 'REBOOK'` — Hebrew customers who type the
  // Hebrew equivalent ("תיאום מחדש" etc.) don't get the shortcut.
  describe('C7 — REBOOK command Hebrew equivalent (B5)', () => {
    let heBiz: TestBusiness

    beforeEach(async () => {
      heBiz = await seedBusiness({ language: 'he', available247: true })
    })

    afterEach(async () => { await teardown(heBiz.businessId) })

    it.skipIf(!llmEnabled)('C7.1: "REBOOK" works for English-path customer', async () => {
      const enBiz = await seedBusiness({ language: 'en', available247: true })
      const ctx: SimContext = { fromNumber: freshPhone(), toNumber: enBiz.waNumber, businessId: enBiz.businessId }

      try {
        const r = await sim(ctx, 'REBOOK')
        expect(r.replies.length).toBeGreaterThan(0)
        // Bot should ask what service and when — not treat it as unknown intent
        expect(r.sessionState).not.toBe('failed')
        assertAllRepliesInLanguage(r, 'en')
      } finally {
        await teardown(enBiz.businessId)
      }
    })

    it.skipIf(!llmEnabled)('C7.2: "תיאום מחדש" gets same treatment as REBOOK — B5 exposed', async () => {
      const ctx: SimContext = { fromNumber: freshPhone(), toNumber: heBiz.waNumber, businessId: heBiz.businessId }

      // B5: currently maps to 'unknown' intent — bot does NOT ask for new appointment
      // This test FAILS until B5 is fixed (Hebrew REBOOK equivalent added)
      const r = await sim(ctx, 'תיאום מחדש')
      expect(r.replies.length).toBeGreaterThan(0)
      // Should not fail the session — should ask for service + time
      expect(r.sessionState).not.toBe('failed')
      assertAllRepliesInLanguage(r, 'he')
    })

    it.skipIf(!llmEnabled)('C7.3: "קביעת תור מחדש" also works as Hebrew REBOOK — B5 exposed', async () => {
      const ctx: SimContext = { fromNumber: freshPhone(), toNumber: heBiz.waNumber, businessId: heBiz.businessId }

      const r = await sim(ctx, 'קביעת תור מחדש')
      expect(r.replies.length).toBeGreaterThan(0)
      expect(r.sessionState).not.toBe('failed')
      assertAllRepliesInLanguage(r, 'he')
    })
  })

  // ── C8: No services configured — correct language ──────────────────────────
  //
  // When a customer asks about services but none are configured, the bot
  // should direct them to contact the business — in the right language.
  describe('C8 — inquiry with no services configured', () => {
    let heBiz: string
    let enBiz: string

    beforeEach(async () => {
      // Seed bare businesses without services — direct DB insert only for businesses
      // (seedBusiness always seeds services, so we use the businesses and deactivate)
      const [h, e] = await Promise.all([
        seedBusiness({ language: 'he', available247: true }),
        seedBusiness({ language: 'en', available247: true }),
      ])
      heBiz = h.businessId
      enBiz = e.businessId

      // Deactivate all services for these businesses
      const { db } = await import('../../src/db/client.js')
      const { serviceTypes } = await import('../../src/db/schema.js')
      const { eq } = await import('drizzle-orm')
      await db.update(serviceTypes).set({ isActive: false }).where(eq(serviceTypes.businessId, h.businessId))
      await db.update(serviceTypes).set({ isActive: false }).where(eq(serviceTypes.businessId, e.businessId))

      // Store waNumbers for sim contexts
      ;(globalThis as Record<string, unknown>)['_c8_he_wa'] = h.waNumber
      ;(globalThis as Record<string, unknown>)['_c8_en_wa'] = e.waNumber
    })

    afterEach(async () => {
      await Promise.all([teardown(heBiz), teardown(enBiz)])
      delete (globalThis as Record<string, unknown>)['_c8_he_wa']
      delete (globalThis as Record<string, unknown>)['_c8_en_wa']
    })

    it.skipIf(!llmEnabled)('C8-he: no services → Hebrew reply directing to business', async () => {
      const waNumber = (globalThis as Record<string, unknown>)['_c8_he_wa'] as string
      const ctx: SimContext = { fromNumber: freshPhone(), toNumber: waNumber, businessId: heBiz }
      const r = await sim(ctx, 'מה השירותים שלכם?')

      expect(r.replies.length).toBeGreaterThan(0)
      for (const reply of r.replies) {
        expect(hasLanguageLeak(reply, 'he')).toBe(false)
      }
      expect(r.sessionState).toBe('completed')
    })

    it.skipIf(!llmEnabled)('C8-en: no services → English reply directing to business', async () => {
      const waNumber = (globalThis as Record<string, unknown>)['_c8_en_wa'] as string
      const ctx: SimContext = { fromNumber: freshPhone(), toNumber: waNumber, businessId: enBiz }
      const r = await sim(ctx, 'What services do you offer?')

      expect(r.replies.length).toBeGreaterThan(0)
      for (const reply of r.replies) {
        expect(hasLanguageLeak(reply, 'en')).toBe(false)
      }
      expect(r.sessionState).toBe('completed')
    })
  })

  // ── C9: Full booking flow — structural parity He vs En ──────────────────────
  //
  // The session state sequence (active → waiting_confirmation → completed) and
  // booking state (requested → held → confirmed) must be identical for Hebrew
  // and English happy-path bookings.
  describe.skipIf(!llmEnabled)('C9 — structural parity: Hebrew vs English booking', () => {
    it('C9: he and en booking flows produce same session state sequence', async () => {
      const [heBiz, enBiz] = await Promise.all([
        seedBusiness({ language: 'he', available247: true }),
        seedBusiness({ language: 'en', available247: true }),
      ])

      async function runBookingFlow(lang: 'he' | 'en', waNumber: string, businessId: string): Promise<string[]> {
        const ctx: SimContext = { fromNumber: freshPhone(), toNumber: waNumber, businessId }
        const states: string[] = []

        const slot = futureDateStr(lang, 4, 11)
        const firstMsg = lang === 'he'
          ? `אני רוצה לקבוע תספורת ${slot}`
          : `I'd like to book a haircut on ${slot}`

        let r = await sim(ctx, firstMsg)
        states.push(r.sessionState ?? 'null')

        // Drive until waiting_confirmation or terminal
        for (let i = 0; i < 5 && r.sessionState !== 'waiting_confirmation' && r.sessionState !== 'completed' && r.sessionState !== 'failed'; i++) {
          const clarify = lang === 'he' ? futureDateStr('he', 4 + i, 11) : futureDateStr('en', 4 + i, 11)
          r = await sim(ctx, clarify)
          states.push(r.sessionState ?? 'null')
        }

        if (r.sessionState === 'waiting_confirmation') {
          r = await sim(ctx, lang === 'he' ? 'כן' : 'yes')
          states.push(r.sessionState ?? 'null')

          if (r.sessionState === 'waiting_confirmation') {
            r = await sim(ctx, lang === 'he' ? 'כן' : 'yes')
            states.push(r.sessionState ?? 'null')
          }
        }

        return states
      }

      try {
        const [heStates, enStates] = await Promise.all([
          runBookingFlow('he', heBiz.waNumber, heBiz.businessId),
          runBookingFlow('en', enBiz.waNumber, enBiz.businessId),
        ])

        // Terminal states must match: both should end in 'completed'
        const heFinal = heStates.at(-1)
        const enFinal = enStates.at(-1)
        expect(heFinal).toBe('completed')
        expect(enFinal).toBe('completed')
      } finally {
        await Promise.all([teardown(heBiz.businessId), teardown(enBiz.businessId)])
      }
    })
  })

  // ── C10: 24/7 onboarding keyword — Hebrew equivalent (exposes B6) ────────────
  //
  // B6: manager-onboarding hours step only recognises '24/7', 'always open',
  // 'always'. Hebrew managers who type "תמיד פתוח" or "פתוח כל היום" don't
  // get the 24/7 shortcut — onboarding loops incorrectly.
  describe('C10 — onboarding 24/7 keyword Hebrew parity (B6)', () => {
    it.skipIf(!llmEnabled)('C10: "תמיד פתוח" during onboarding hours step sets available247', async () => {
      // Seed a business that is NOT yet onboarded (in hours step)
      const { db } = await import('../../src/db/client.js')
      const { businesses } = await import('../../src/db/schema.js')
      const { eq } = await import('drizzle-orm')

      const biz = await seedBusiness({ language: 'he' })
      // Reset to mid-onboarding state: hours step
      await db.update(businesses)
        .set({ onboardingStep: 'hours', onboardingCompletedAt: null, available247: false })
        .where(eq(businesses.id, biz.businessId))

      const managerCtx: SimContext = {
        fromNumber: biz.managerPhone,
        toNumber: biz.waNumber,
        businessId: biz.businessId,
      }

      // B6: "תמיד פתוח" currently NOT recognised — test FAILS until B6 fixed
      const r = await sim(managerCtx, 'תמיד פתוח')

      expect(r.replies.length).toBeGreaterThan(0)
      const reply = r.replies[0]!
      // Reply must be in Hebrew
      expect(hasLanguageLeak(reply, 'he')).toBe(false)

      // After the keyword is recognised, business should advance past hours step
      const [updated] = await db
        .select({ step: businesses.onboardingStep, is247: businesses.available247 })
        .from(businesses)
        .where(eq(businesses.id, biz.businessId))
        .limit(1)

      // B6 regression: currently available247 stays false and step stays 'hours'
      expect(updated?.is247).toBe(true)
      expect(updated?.step).not.toBe('hours')

      await teardown(biz.businessId)
    })

    it.skipIf(!llmEnabled)('C10: "24/7" still works for Hebrew manager (control)', async () => {
      const { db } = await import('../../src/db/client.js')
      const { businesses } = await import('../../src/db/schema.js')
      const { eq } = await import('drizzle-orm')

      const biz = await seedBusiness({ language: 'he' })
      await db.update(businesses)
        .set({ onboardingStep: 'hours', onboardingCompletedAt: null, available247: false })
        .where(eq(businesses.id, biz.businessId))

      const managerCtx: SimContext = {
        fromNumber: biz.managerPhone,
        toNumber: biz.waNumber,
        businessId: biz.businessId,
      }

      const r = await sim(managerCtx, '24/7')
      expect(r.replies.length).toBeGreaterThan(0)

      const [updated] = await db
        .select({ step: businesses.onboardingStep, is247: businesses.available247 })
        .from(businesses)
        .where(eq(businesses.id, biz.businessId))
        .limit(1)

      expect(updated?.is247).toBe(true)
      expect(updated?.step).not.toBe('hours')

      await teardown(biz.businessId)
    })
  })

  // ── C11: No language leakage across all happy-path replies ───────────────────
  //
  // Run a scripted booking conversation in each language and verify every
  // reply is in the correct language. This is the baseline parity test.
  describe.skipIf(!llmEnabled)('C11 — no language leakage in any reply', () => {
    it('C11-he: all replies in Hebrew during a full booking conversation', async () => {
      const biz = await seedBusiness({ language: 'he', available247: true })
      const ctx: SimContext = { fromNumber: freshPhone(), toNumber: biz.waNumber, businessId: biz.businessId }

      try {
        const slot = futureDateStr('he', 3, 14)
        const r1 = await sim(ctx, `אני רוצה לקבוע תספורת ${slot}`)
        assertAllRepliesInLanguage(r1, 'he')

        if (r1.sessionState === 'waiting_confirmation') {
          const r2 = await sim(ctx, 'כן')
          assertAllRepliesInLanguage(r2, 'he')
          if (r2.sessionState === 'waiting_confirmation') {
            const r3 = await sim(ctx, 'כן')
            assertAllRepliesInLanguage(r3, 'he')
          }
        } else if (r1.sessionState === 'waiting_clarification' || r1.sessionState === 'active') {
          const r2 = await sim(ctx, slot)
          assertAllRepliesInLanguage(r2, 'he')
          if (r2.sessionState === 'waiting_confirmation') {
            const r3 = await sim(ctx, 'כן')
            assertAllRepliesInLanguage(r3, 'he')
          }
        }
      } finally {
        await teardown(biz.businessId)
      }
    })

    it('C11-en: all replies in English during a full booking conversation', async () => {
      const biz = await seedBusiness({ language: 'en', available247: true })
      const ctx: SimContext = { fromNumber: freshPhone(), toNumber: biz.waNumber, businessId: biz.businessId }

      try {
        const slot = futureDateStr('en', 3, 14)
        const r1 = await sim(ctx, `I'd like to book a haircut on ${slot}`)
        assertAllRepliesInLanguage(r1, 'en')

        if (r1.sessionState === 'waiting_confirmation') {
          const r2 = await sim(ctx, 'yes')
          assertAllRepliesInLanguage(r2, 'en')
          if (r2.sessionState === 'waiting_confirmation') {
            const r3 = await sim(ctx, 'yes')
            assertAllRepliesInLanguage(r3, 'en')
          }
        } else if (r1.sessionState === 'waiting_clarification' || r1.sessionState === 'active') {
          const r2 = await sim(ctx, slot)
          assertAllRepliesInLanguage(r2, 'en')
          if (r2.sessionState === 'waiting_confirmation') {
            const r3 = await sim(ctx, 'yes')
            assertAllRepliesInLanguage(r3, 'en')
          }
        }
      } finally {
        await teardown(biz.businessId)
      }
    })
  })
})
