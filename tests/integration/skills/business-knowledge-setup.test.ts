// Mocks must be declared before any imports (vitest hoists these)
import { vi } from 'vitest'

vi.mock('../../../src/redis.js', () => ({
  redisConnection: { quit: vi.fn(), on: vi.fn(), disconnect: vi.fn() },
}))
vi.mock('../../../src/workers/message-retry.js', () => ({
  enqueueMessage: vi.fn().mockResolvedValue(undefined),
  messageRetryQueue: { add: vi.fn() },
  startMessageRetryWorker: vi.fn(),
}))
vi.mock('../../../src/workers/reminder.js', () => ({
  scheduleReminders: vi.fn().mockResolvedValue(undefined),
  cancelReminders: vi.fn().mockResolvedValue(undefined),
  startReminderWorker: vi.fn(),
}))
vi.mock('../../../src/workers/waitlist.js', () => ({
  triggerWaitlistForSlot: vi.fn().mockResolvedValue(undefined),
  startWaitlistWorker: vi.fn(),
}))
vi.mock('../../../src/workers/queued-messages.js', () => ({
  queueMessageForLater: vi.fn().mockResolvedValue(undefined),
  startQueuedMessageWorker: vi.fn(),
}))

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq, and, desc } from 'drizzle-orm'
import { db } from '../../../src/db/client.js'
import {
  businesses, businessFaqs, skillWorkflows, deferredFeatureRequests,
} from '../../../src/db/schema.js'
import {
  seedBusiness, teardown, integrationEnabled, llmEnabled,
} from '../setup.js'
import { sim, assertAllRepliesInLanguage } from '../runner.js'
import { businessKnowledgeSetupSkill } from '../../../src/skills/business-knowledge-setup/index.js'
import type { SkillContext } from '../../../src/shared/skill-types.js'
import type { TestBusiness } from '../setup.js'
import type { SimContext } from '../runner.js'

// ── canHandle unit tests (no DB needed) ─────────────────────────────────────

const baseCtx: SkillContext = {
  business: { id: 'biz-1', name: 'Test', timezone: 'Asia/Jerusalem', defaultLanguage: 'he', botPersona: 'neutral', currency: 'ILS' },
  caller: { id: 'c-1', phoneNumber: '+972500000001', role: 'manager', displayName: null, preferredLanguage: null },
  message: { text: '', receivedAt: new Date() },
  conversationHistory: [],
  language: 'he',
  sessionId: 'sess-1',
  businessKnowledge: {
    services: [], policies: {}, faqs: [], brandVoice: null, communicationStyle: null,
    notificationPreferences: null, handoffBehavior: null, automatedMessagesConfig: null,
    bookingEdgeCases: null, cancellationFeeAmount: null, cancellationFeeCurrency: null,
    websiteJson: null, websitePreviewUrl: null, websiteUrl: null,
  },
  workflowState: null,
  workflow: {
    advance: vi.fn(), complete: vi.fn(), fail: vi.fn(),
    create: vi.fn().mockResolvedValue({ id: 'wf-1', step: 'brand-voice', state: {}, version: 1, skillName: 'business-knowledge-setup', status: 'active' }),
  },
  recentCompletedBooking: null,
  customerSegmentQuery: vi.fn(),
  saveFAQs: vi.fn(), saveServiceNarrative: vi.fn(), saveBrandVoice: vi.fn(),
  saveCommunicationStyle: vi.fn(), saveNotificationPreferences: vi.fn(),
  saveHandoffBehavior: vi.fn(), saveAutomatedMessagesConfig: vi.fn(),
  saveBookingEdgeCases: vi.fn(), saveCancellationFee: vi.fn(),
  saveCancellationCutoffMinutes: vi.fn(), deferFeatureRequest: vi.fn(),
  saveWebsiteConfig: vi.fn(), saveServiceIntakeNotes: vi.fn(),
}

// ── BK-10: canHandle does NOT intercept booking phrases ─────────────────────

describe('BK-10 — canHandle false positives', () => {
  const booking = (text: string) => ({ ...baseCtx, message: { text, receivedAt: new Date() } })
  it('does not match "book appointment"', () => {
    expect(businessKnowledgeSetupSkill.canHandle(booking('book appointment tomorrow'))).toBe(false)
  })
  it('does not match "cancel my booking"', () => {
    expect(businessKnowledgeSetupSkill.canHandle(booking('cancel my booking'))).toBe(false)
  })
  it('does not match customer role', () => {
    const ctx = { ...baseCtx, caller: { ...baseCtx.caller, role: 'customer' as const }, message: { text: 'business info', receivedAt: new Date() } }
    expect(businessKnowledgeSetupSkill.canHandle(ctx)).toBe(false)
  })
  it('matches "business info" from manager', () => {
    expect(businessKnowledgeSetupSkill.canHandle(booking('business info'))).toBe(true)
  })
  it('matches "ידע עסקי" from manager', () => {
    expect(businessKnowledgeSetupSkill.canHandle(booking('ידע עסקי'))).toBe(true)
  })
  it('matches "brand voice" from manager', () => {
    expect(businessKnowledgeSetupSkill.canHandle(booking('brand voice'))).toBe(true)
  })
  it('matches "עדכן מידע" from manager', () => {
    expect(businessKnowledgeSetupSkill.canHandle(booking('עדכן מידע'))).toBe(true)
  })
  it('resumes in-progress workflow regardless of text', () => {
    const ctx = {
      ...baseCtx,
      message: { text: 'hello', receivedAt: new Date() },
      workflowState: { id: 'wf-1', skillName: 'business-knowledge-setup', step: 'brand-voice', state: {}, version: 1, status: 'active' as const },
    }
    expect(businessKnowledgeSetupSkill.canHandle(ctx)).toBe(true)
  })
})

// ── Integration tests (need DB + LLM) ───────────────────────────────────────

describe.skipIf(!integrationEnabled)('BK — Business Knowledge Setup integration', () => {
  let biz: TestBusiness
  let managerCtx: SimContext

  beforeEach(async () => {
    biz = await seedBusiness({ language: 'en', available247: true })
    managerCtx = { fromNumber: biz.managerPhone, toNumber: biz.waNumber, businessId: biz.businessId }
  })

  afterEach(async () => {
    await teardown(biz.businessId)
  })

  // ── BK-09: Cancellation mid-flow (no LLM needed) ─────────────────────────

  it.skipIf(!integrationEnabled)('BK-09: "stop" mid-workflow saves and exits cleanly', async () => {
    // Start the workflow
    const r1 = await sim(managerCtx, 'business info')
    expect(r1.replies.length).toBeGreaterThan(0)

    // Check workflow started
    const wf = await db.select().from(skillWorkflows)
      .where(and(eq(skillWorkflows.businessId, biz.businessId), eq(skillWorkflows.status, 'active')))
      .limit(1)
    expect(wf[0]?.skillName).toBe('business-knowledge-setup')

    // Send cancel
    const r2 = await sim(managerCtx, 'stop')
    expect(r2.replies.length).toBeGreaterThan(0)
    expect(r2.sessionState).toBe('completed')

    // Workflow should be completed, not still active
    const wfAfter = await db.select().from(skillWorkflows)
      .where(and(eq(skillWorkflows.businessId, biz.businessId), eq(skillWorkflows.status, 'active')))
      .limit(1)
    expect(wfAfter.length).toBe(0)
  })

  // ── BK-03: Resume after interruption (no LLM needed for start + check) ───

  it.skipIf(!integrationEnabled)('BK-03: workflow resumes at stored step after session gap', async () => {
    const r1 = await sim(managerCtx, 'business info')
    expect(r1.replies.length).toBeGreaterThan(0)

    // Verify workflow is at brand-voice step
    const [wf] = await db.select().from(skillWorkflows)
      .where(eq(skillWorkflows.businessId, biz.businessId))
      .orderBy(desc(skillWorkflows.createdAt))
      .limit(1)
    expect(wf?.step).toBe('brand-voice')

    // New session (different message, no explicit workflow trigger needed — workflowState re-claims)
    const r2 = await sim(managerCtx, 'hello')
    // Should re-claim and prompt for brand voice again (PAUSED at same step)
    expect(r2.replies.length).toBeGreaterThan(0)
  })

  // ── BK-01: Full English workflow ──────────────────────────────────────────

  it.skipIf(!llmEnabled)('BK-01: full English workflow completes and persists to DB', async () => {
    // Trigger
    const r0 = await sim(managerCtx, 'business info')
    expect(r0.replies.length).toBeGreaterThan(0)
    assertAllRepliesInLanguage(r0, 'en')

    // Step 1: brand-voice
    const r1 = await sim(managerCtx, 'We are a premium barbershop focused on precision cuts and a relaxed atmosphere. Clients leave feeling sharp and confident.')
    assertAllRepliesInLanguage(r1, 'en')

    // Step 2: communication-style
    const r2 = await sim(managerCtx, 'Friendly and professional. Use first names. Keep it warm but clean. Avoid slang. If a customer is rude, stay calm and redirect politely.')
    assertAllRepliesInLanguage(r2, 'en')

    // Step 3: notification-prefs
    const r3 = await sim(managerCtx, 'Alert me for new bookings, first-time customers, and cancellations. Skip reschedules.')
    assertAllRepliesInLanguage(r3, 'en')

    // Step 4: handoff-rules
    const r4 = await sim(managerCtx, 'Take over if the customer is upset, asks to speak to a person, or mentions a medical issue. Say "Let me connect you directly."')
    assertAllRepliesInLanguage(r4, 'en')

    // Step 5: cancellation-payment-confirm (approve existing or update)
    const r5 = await sim(managerCtx, 'ok')
    assertAllRepliesInLanguage(r5, 'en')

    // Step 6: service-narratives — haircut
    const r6 = await sim(managerCtx, 'A precision haircut with a warm towel finish. Please wash your hair beforehand. Not suitable for scalp conditions.')
    assertAllRepliesInLanguage(r6, 'en')

    // Step 6 cont: service-narratives — yoga class (second service)
    const r7 = await sim(managerCtx, 'A relaxing group yoga class for all levels. Bring a mat and water. Avoid heavy meals 2 hours before.')
    assertAllRepliesInLanguage(r7, 'en')

    // Step 7: booking-edge-cases
    const r8 = await sim(managerCtx, 'No same-day bookings. No walk-ins. No back-to-back. State prices upfront. No deposits required.')
    assertAllRepliesInLanguage(r8, 'en')

    // Step 8: off-limits
    const r9 = await sim(managerCtx, 'Never negotiate prices or discuss medical advice. Say "Please reach out to me directly for that."')
    assertAllRepliesInLanguage(r9, 'en')

    // Step 9: faq-collect
    const r10 = await sim(managerCtx, 'How long does a haircut take? Do you take walk-ins? What payment methods do you accept? Can I bring my child?')
    assertAllRepliesInLanguage(r10, 'en')

    // Step 10: message-review — approve all
    const r11 = await sim(managerCtx, 'looks good')
    assertAllRepliesInLanguage(r11, 'en')

    // Step 11: faq-review — approve
    const r12 = await sim(managerCtx, 'approved')
    assertAllRepliesInLanguage(r12, 'en')

    // Step 12: open-question — finish
    const r13 = await sim(managerCtx, 'done')
    assertAllRepliesInLanguage(r13, 'en')
    expect(r13.sessionState).toBe('completed')

    // DB assertions: brand_voice set
    const [bizRow] = await db.select({ brandVoice: businesses.brandVoice, communicationStyle: businesses.communicationStyle })
      .from(businesses).where(eq(businesses.id, biz.businessId)).limit(1)
    expect(bizRow?.brandVoice).toBeTruthy()
    expect(bizRow?.communicationStyle).toBeTruthy()

    // FAQs persisted
    const faqs = await db.select().from(businessFaqs).where(eq(businessFaqs.businessId, biz.businessId))
    expect(faqs.length).toBeGreaterThanOrEqual(3)

    // Workflow completed
    const [wf] = await db.select({ status: skillWorkflows.status }).from(skillWorkflows)
      .where(eq(skillWorkflows.businessId, biz.businessId))
      .orderBy(desc(skillWorkflows.updatedAt)).limit(1)
    expect(wf?.status).toBe('completed')
  }, 180_000)

  // ── BK-02: Full Hebrew workflow ───────────────────────────────────────────

  it.skipIf(!llmEnabled)('BK-02: full Hebrew workflow — all replies in Hebrew, no language leaks', async () => {
    // Seed Hebrew business
    const heBiz = await seedBusiness({ language: 'he', available247: true })
    const heCtx: SimContext = { fromNumber: heBiz.managerPhone, toNumber: heBiz.waNumber, businessId: heBiz.businessId }

    try {
      const r0 = await sim(heCtx, 'ידע עסקי')
      expect(r0.replies.length).toBeGreaterThan(0)
      assertAllRepliesInLanguage(r0, 'he')

      await sim(heCtx, 'מספרה פרמיום המתמחה בתספורות מדויקות. הלקוחות יוצאים בהרגשה מעולה ובטוחים בעצמם.')
      const r2 = await sim(heCtx, 'ידידותי ומקצועי. לקרוא ללקוחות בשמם. לא לדון בפוליטיקה.')
      assertAllRepliesInLanguage(r2, 'he')

      await sim(heCtx, 'להתריע על הזמנות חדשות וביטולים.')
      await sim(heCtx, 'להעביר אם הלקוח כועס או מבקש לדבר עם אנשים.')
      await sim(heCtx, 'אוקיי')
      await sim(heCtx, 'תספורת מדויקת עם מגבת חמה. לשטוף שיער מראש.')
      await sim(heCtx, 'שיעור יוגה קבוצתי לכל הרמות. להביא מזרן.')
      await sim(heCtx, 'אין הזמנות באותו יום. אין כניסה ללא תיאום. מחיר גלוי.')
      await sim(heCtx, 'לא לנהל משא ומתן על מחיר. לומר "פנה ישירות אלי".')
      await sim(heCtx, 'כמה זמן לוקחת תספורת? מה קורה אם אתאחר? איך משלמים?')
      await sim(heCtx, 'נראה טוב')
      await sim(heCtx, 'מאושר')
      const rFinal = await sim(heCtx, 'סיים')
      assertAllRepliesInLanguage(rFinal, 'he')
      expect(rFinal.sessionState).toBe('completed')

      // DB: FAQs in Hebrew
      const faqs = await db.select().from(businessFaqs).where(eq(businessFaqs.businessId, heBiz.businessId))
      expect(faqs.length).toBeGreaterThanOrEqual(2)
    } finally {
      await teardown(heBiz.businessId)
    }
  }, 180_000)

  // ── BK-07: Open-question defer unsupported feature ────────────────────────

  it.skipIf(!llmEnabled)('BK-07: unsupported feature request deferred to deferred_feature_requests table', async () => {
    // Start and rush to open-question via skips
    await sim(managerCtx, 'business info')
    await sim(managerCtx, 'skip')
    await sim(managerCtx, 'skip')
    await sim(managerCtx, 'skip')
    await sim(managerCtx, 'skip')
    await sim(managerCtx, 'skip')
    await sim(managerCtx, 'skip')
    await sim(managerCtx, 'skip')
    await sim(managerCtx, 'skip')
    await sim(managerCtx, 'looks good')
    await sim(managerCtx, 'approved')

    // Now in open-question step — send an unsupported request
    const r = await sim(managerCtx, 'I want you to automatically post to Instagram when I get a new booking')
    expect(r.replies.length).toBeGreaterThan(0)

    // Deferred feature request should be recorded
    const deferred = await db.select().from(deferredFeatureRequests)
      .where(eq(deferredFeatureRequests.businessId, biz.businessId))
    expect(deferred.length).toBeGreaterThanOrEqual(1)
  }, 120_000)

  // ── BK-05: FAQ generation structures output ───────────────────────────────

  it.skipIf(!llmEnabled)('BK-05: FAQ generation produces structured Q&As saved to DB', async () => {
    // Progress quickly to faq-collect step
    await sim(managerCtx, 'business info')
    await sim(managerCtx, 'skip')
    await sim(managerCtx, 'skip')
    await sim(managerCtx, 'skip')
    await sim(managerCtx, 'skip')
    await sim(managerCtx, 'ok')        // cancellation-payment-confirm
    await sim(managerCtx, 'skip')      // service-narratives
    await sim(managerCtx, 'skip')      // service-narratives second service
    await sim(managerCtx, 'skip')      // booking-edge-cases
    await sim(managerCtx, 'skip')      // off-limits

    // Now at faq-collect
    const r = await sim(managerCtx, 'How long does a haircut take? Do you accept walk-ins? What payment methods do you offer? Can I bring children? Is parking available?')
    assertAllRepliesInLanguage(r, 'en')

    // After LLM generates FAQs and moves to message-review, check DB
    const faqs = await db.select().from(businessFaqs).where(eq(businessFaqs.businessId, biz.businessId))
    expect(faqs.length).toBeGreaterThanOrEqual(3)
    // Each FAQ must have non-empty question and answer
    for (const faq of faqs) {
      expect(faq.question.length).toBeGreaterThan(5)
      expect(faq.answer.length).toBeGreaterThan(5)
    }
  }, 120_000)

  // ── BK-08: open-question loop limit ──────────────────────────────────────

  it.skipIf(!llmEnabled)('BK-08: open-question loop exits after 3 turns', async () => {
    await sim(managerCtx, 'business info')
    await sim(managerCtx, 'skip')
    await sim(managerCtx, 'skip')
    await sim(managerCtx, 'skip')
    await sim(managerCtx, 'skip')
    await sim(managerCtx, 'ok')
    await sim(managerCtx, 'skip')
    await sim(managerCtx, 'skip')
    await sim(managerCtx, 'skip')
    await sim(managerCtx, 'skip')
    await sim(managerCtx, 'looks good')
    await sim(managerCtx, 'approved')

    // Open-question step: send 3 classifiable items
    await sim(managerCtx, 'We close early on Fridays')
    await sim(managerCtx, 'We also offer beard trims on request')
    const r = await sim(managerCtx, 'That is all the extra info I had')
    // After 3 turns or on completion signal the workflow should complete
    expect(r.replies.length).toBeGreaterThan(0)
  }, 120_000)
})
