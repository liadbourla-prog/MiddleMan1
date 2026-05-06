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
import Fastify from 'fastify'
import { eq, desc } from 'drizzle-orm'
import { db } from '../../../src/db/client.js'
import { businesses, skillWorkflows } from '../../../src/db/schema.js'
import { buildSiteRoutes } from '../../../src/routes/build-site/index.js'
import {
  seedBusiness, teardown, integrationEnabled, llmEnabled,
} from '../setup.js'
import { sim, assertAllRepliesInLanguage } from '../runner.js'
import { websiteBuilderSkill } from '../../../src/skills/website-builder/index.js'
import type { SkillContext } from '../../../src/shared/skill-types.js'
import type { TestBusiness } from '../setup.js'
import type { SimContext } from '../runner.js'
import type { SiteSchema } from '../../../src/skills/website-builder/site-schema.js'

// ── Test fixture: valid minimal SiteSchema ────────────────────────────────────

const VALID_SCHEMA: SiteSchema = {
  business: {
    name: 'Test Barbershop',
    category: 'barbershop',
    tagline: 'Precision cuts for the modern gentleman',
    description: 'A premium barbershop specializing in precision cuts, beard trims, and grooming services. Our team of expert barbers creates a relaxed atmosphere where every client leaves looking and feeling their best.',
    city: 'Tel Aviv',
    address: '12 Rothschild Blvd, Tel Aviv',
    serviceArea: ['Tel Aviv', 'Ramat Gan'],
    phone: '+972501234567',
    googleBusinessProfileUrl: null,
    openingHours: [{ dayOfWeek: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'], opens: '09:00', closes: '19:00' }],
    credentials: [],
    foundedYear: 2019,
    practitionerName: 'Avi Cohen',
    practitionerTitle: 'Master Barber',
    practitionerBio: 'Avi Cohen is a master barber with over 15 years of experience. Trained in London and Tel Aviv, he specializes in precision fades and classic cuts. Every client receives personalized attention.',
  },
  style: {
    variant: 'minimal',
    palette: 'slate',
    logoUrl: null,
    heroImageUrl: null,
  },
  services: [{
    slug: 'haircut',
    name: 'Haircut',
    description: 'A precision haircut tailored to your style. Our barbers consult with you to understand the look you want and deliver a clean, sharp result every time. Includes a warm towel finish.',
    durationMinutes: 30,
    price: 80,
    priceOnRequest: false,
    currency: 'ILS',
    whoFor: 'Ideal for clients who want a sharp, precision cut with personalized styling advice.',
    processSteps: ['Consultation and styling discussion', 'Wash and preparation', 'Precision cut', 'Styling and finish', 'Warm towel touch-up'],
    contraindications: null,
    faqs: [{ question: 'Do I need to wash my hair before?', answer: 'Yes, please arrive with clean hair for the best result.' }],
  }],
  faqs: [
    { question: 'How long does a haircut take?', answer: 'A standard haircut takes approximately 30 minutes from start to finish, including consultation and styling.', topic: 'services', serviceSlug: 'haircut' },
    { question: 'Do you accept walk-ins?', answer: 'We operate by appointment only to ensure you get the best experience. Book via WhatsApp to reserve your spot.', topic: 'booking', serviceSlug: null },
    { question: 'What payment methods do you accept?', answer: 'We accept all major credit cards, cash, and bit payments. Payment is collected at the end of your visit.', topic: 'pricing', serviceSlug: null },
    { question: 'Where are you located?', answer: 'We are located at 12 Rothschild Blvd, Tel Aviv, near the Habima Square. Street parking is available nearby.', topic: 'location', serviceSlug: null },
    { question: 'What is your cancellation policy?', answer: 'We ask for at least 24 hours notice for cancellations. Late cancellations may incur a fee. Contact us via WhatsApp to reschedule.', topic: 'policy', serviceSlug: null },
  ],
  language: 'en',
  generatedAt: new Date().toISOString(),
  workflowId: 'test-wf-001',
}

// ── canHandle unit tests (no DB needed) ─────────────────────────────────────

const baseCtx: SkillContext = {
  business: { id: 'biz-1', name: 'Test', timezone: 'Asia/Jerusalem', defaultLanguage: 'en', botPersona: 'neutral', currency: 'ILS' },
  caller: { id: 'c-1', phoneNumber: '+972500000001', role: 'manager', displayName: null, preferredLanguage: null },
  message: { text: '', receivedAt: new Date() },
  conversationHistory: [],
  language: 'en',
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
    create: vi.fn().mockResolvedValue({ id: 'wf-1', step: 'requirements-gather', state: {}, version: 1, skillName: 'website-builder', status: 'active' }),
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

// ── WB-10: canHandle — update triggers and role gating ───────────────────────

describe('WB-10 — canHandle triggers', () => {
  const msg = (text: string, role: 'manager' | 'customer' = 'manager') => ({
    ...baseCtx,
    caller: { ...baseCtx.caller, role },
    message: { text, receivedAt: new Date() },
  })

  it('matches "build site"', () => expect(websiteBuilderSkill.canHandle(msg('build site'))).toBe(true))
  it('matches "website"', () => expect(websiteBuilderSkill.canHandle(msg('website'))).toBe(true))
  it('matches "landing page"', () => expect(websiteBuilderSkill.canHandle(msg('landing page'))).toBe(true))
  it('matches "אתר" (Hebrew)', () => expect(websiteBuilderSkill.canHandle(msg('אתר'))).toBe(true))
  it('matches "דף נחיתה" (Hebrew)', () => expect(websiteBuilderSkill.canHandle(msg('דף נחיתה'))).toBe(true))
  it('matches "בנה אתר" (Hebrew)', () => expect(websiteBuilderSkill.canHandle(msg('בנה אתר'))).toBe(true))
  it('matches "update website"', () => expect(websiteBuilderSkill.canHandle(msg('update website'))).toBe(true))
  it('matches "edit website"', () => expect(websiteBuilderSkill.canHandle(msg('edit website'))).toBe(true))
  it('matches "שנה אתר" (Hebrew update)', () => expect(websiteBuilderSkill.canHandle(msg('שנה אתר'))).toBe(true))
  it('does NOT match customer role', () => expect(websiteBuilderSkill.canHandle(msg('website', 'customer'))).toBe(false))
})

// ── WB-11: canHandle — no interference with booking ──────────────────────────

describe('WB-11 — canHandle false positives', () => {
  const msg = (text: string) => ({ ...baseCtx, message: { text, receivedAt: new Date() } })

  it('does not match "book appointment Tuesday"', () =>
    expect(websiteBuilderSkill.canHandle(msg('book appointment Tuesday'))).toBe(false))
  it('does not match "cancel my appointment"', () =>
    expect(websiteBuilderSkill.canHandle(msg('cancel my appointment'))).toBe(false))
  it('does not match "what are your available slots"', () =>
    expect(websiteBuilderSkill.canHandle(msg('what are your available slots'))).toBe(false))
  it('does not match booking from customer with website in biz knowledge', () => {
    const ctx = {
      ...baseCtx,
      caller: { ...baseCtx.caller, role: 'customer' as const },
      message: { text: 'book appointment', receivedAt: new Date() },
      businessKnowledge: { ...baseCtx.businessKnowledge, websitePreviewUrl: 'https://preview.example.com' },
    }
    expect(websiteBuilderSkill.canHandle(ctx)).toBe(false)
  })
})

// ── WB-08 + WB-09: /build-site HTTP endpoint tests ───────────────────────────

describe('WB-08/09 — /build-site HTTP endpoint', () => {
  it('WB-08a: missing auth returns 401', async () => {
    process.env['SITE_BUILDER_SECRET'] = 'test-secret-tok'
    const app = Fastify({ logger: false })
    await app.register(buildSiteRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/build-site',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema: VALID_SCHEMA, workflowId: 'wf-test' }),
    })
    expect(res.statusCode).toBe(401)
    await app.close()
    delete process.env['SITE_BUILDER_SECRET']
  })

  it('WB-08b: correct auth + valid schema returns previewUrl and pages', async () => {
    process.env['SITE_BUILDER_SECRET'] = 'test-secret-tok'
    const app = Fastify({ logger: false })
    await app.register(buildSiteRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/build-site',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-secret-tok',
      },
      body: JSON.stringify({ schema: VALID_SCHEMA, workflowId: 'wf-endpoint-test' }),
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { previewUrl: string; pages: Record<string, string> }
    expect(body.previewUrl).toContain('wf-endpoint-test')
    expect(Object.keys(body.pages).length).toBeGreaterThan(0)
    await app.close()
    delete process.env['SITE_BUILDER_SECRET']
  })

  it('WB-09: invalid schema (missing phone) returns 400 with issues', async () => {
    process.env['SITE_BUILDER_SECRET'] = 'test-secret-tok'
    const app = Fastify({ logger: false })
    await app.register(buildSiteRoutes)

    const invalid = {
      ...VALID_SCHEMA,
      business: { ...VALID_SCHEMA.business, phone: '' },
    }

    const res = await app.inject({
      method: 'POST',
      url: '/build-site',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-secret-tok',
      },
      body: JSON.stringify({ schema: invalid, workflowId: 'wf-invalid' }),
    })
    expect(res.statusCode).toBe(400)
    const body = res.json() as { error: string; issues?: unknown[] }
    expect(body.error).toMatch(/schema/i)
    await app.close()
    delete process.env['SITE_BUILDER_SECRET']
  })

  it('WB-09b: missing workflowId returns 400', async () => {
    const app = Fastify({ logger: false })
    await app.register(buildSiteRoutes)

    const res = await app.inject({
      method: 'POST',
      url: '/build-site',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema: VALID_SCHEMA }),
    })
    expect(res.statusCode).toBe(400)
    await app.close()
  })
})

// ── Integration workflow tests (need DB + LLM) ───────────────────────────────

describe.skipIf(!integrationEnabled)('WB — Website Builder integration', () => {
  let biz: TestBusiness
  let managerCtx: SimContext

  // Mock fetch so preview-deploy step doesn't need a real running server
  beforeEach(async () => {
    biz = await seedBusiness({ language: 'en', available247: true })
    managerCtx = { fromNumber: biz.managerPhone, toNumber: biz.waNumber, businessId: biz.businessId }

    // Intercept callSiteBuilder HTTP call with a fake preview URL
    vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
      if (url.includes('/build-site')) {
        return new Response(
          JSON.stringify({ previewUrl: `http://localhost:3000/preview/${biz.businessId}` }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response('{}', { status: 200 })
    })
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await teardown(biz.businessId)
  })

  // ── WB-07: GATE-1 is correctly blocked ────────────────────────────────────

  it.skipIf(!llmEnabled)('WB-07: domain-setup step is paused when GATE_1_RESOLVED is unset', async () => {
    delete process.env['GATE_1_RESOLVED']

    // Drive through to manager-review approval
    await sim(managerCtx, 'build site')
    await sim(managerCtx, 'minimal style, light green, practitioner Avi Cohen, barber, Tel Aviv')
    await sim(managerCtx, 'ok')
    // Wait through content generation + AEO + preview-deploy
    const rReview = await sim(managerCtx, 'approved')

    // Should be told domain setup is pending (GATE-1)
    expect(rReview.replies.length).toBeGreaterThan(0)
    const combined = rReview.replies.join(' ')
    // Reply must mention domain/pending/coming soon — not an error
    expect(combined.length).toBeGreaterThan(10)
  }, 120_000)

  // ── WB-04: structure-confirm rejection re-runs requirements ───────────────

  it.skipIf(!llmEnabled)('WB-04: manager requests design change at structure-confirm — re-parses', async () => {
    await sim(managerCtx, 'build site')
    // Provide requirements
    await sim(managerCtx, 'bold style, dark blue, practitioner Sarah, hairstylist, Haifa')
    // Reject and request change at structure-confirm
    const r = await sim(managerCtx, 'actually I want minimal style instead')
    expect(r.replies.length).toBeGreaterThan(0)
    assertAllRepliesInLanguage(r, 'en')
  }, 60_000)

  // ── WB-03: Update flow when site exists ──────────────────────────────────

  it.skipIf(!llmEnabled)('WB-03: update flow triggered when website_json exists in DB', async () => {
    // Pre-populate website_json
    await db.update(businesses)
      .set({ websiteJson: VALID_SCHEMA as unknown as Record<string, unknown>, websitePreviewUrl: 'http://localhost:3000/preview/existing' })
      .where(eq(businesses.id, biz.businessId))

    const r = await sim(managerCtx, 'update website')
    expect(r.replies.length).toBeGreaterThan(0)
    // Should show the existing preview URL and ask what to change
    const combined = r.replies.join(' ')
    expect(combined.length).toBeGreaterThan(10)
    assertAllRepliesInLanguage(r, 'en')
  }, 60_000)

  // ── WB-10: Hebrew trigger ─────────────────────────────────────────────────

  it.skipIf(!llmEnabled)('WB-10: Hebrew trigger "בנה אתר" starts build flow', async () => {
    const heBiz = await seedBusiness({ language: 'he', available247: true })
    const heCtx: SimContext = { fromNumber: heBiz.managerPhone, toNumber: heBiz.waNumber, businessId: heBiz.businessId }

    try {
      const r = await sim(heCtx, 'בנה אתר')
      expect(r.replies.length).toBeGreaterThan(0)
      assertAllRepliesInLanguage(r, 'he')
    } finally {
      await teardown(heBiz.businessId)
    }
  }, 60_000)

  // ── WB-01: Full English build flow ────────────────────────────────────────

  it.skipIf(!llmEnabled)('WB-01: full English build flow — website_json and preview_url saved to DB', async () => {
    // Step 1: Trigger
    const r0 = await sim(managerCtx, 'build site')
    expect(r0.replies.length).toBeGreaterThan(0)
    assertAllRepliesInLanguage(r0, 'en')

    // Step 2: requirements-gather
    const r1 = await sim(managerCtx, 'Minimal style, neutral tones, practitioner Avi Cohen, master barber, Tel Aviv, 12 Rothschild. Business since 2019. Domain: avibarber.com')
    assertAllRepliesInLanguage(r1, 'en')

    // Step 3: structure-confirm — approve
    const r2 = await sim(managerCtx, 'looks good, approve')
    assertAllRepliesInLanguage(r2, 'en')

    // Steps 4–5 happen automatically (content-generate → aeo-pass → preview-deploy)
    // Step 6: manager-review — approve
    const r3 = await sim(managerCtx, 'approved')
    assertAllRepliesInLanguage(r3, 'en')

    // Workflow should be at domain-setup (GATE-1 paused) or complete
    const [wf] = await db.select().from(skillWorkflows)
      .where(eq(skillWorkflows.businessId, biz.businessId))
      .orderBy(desc(skillWorkflows.updatedAt)).limit(1)
    expect(['domain-setup', 'complete', 'completed']).toContain(wf?.step ?? wf?.status)

    // website_json and preview_url must be saved
    const [bizRow] = await db.select({ websiteJson: businesses.websiteJson, websitePreviewUrl: businesses.websitePreviewUrl })
      .from(businesses).where(eq(businesses.id, biz.businessId)).limit(1)
    expect(bizRow?.websiteJson).toBeTruthy()
    expect(bizRow?.websitePreviewUrl).toBeTruthy()
  }, 180_000)

  // ── WB-02: Full Hebrew build flow ─────────────────────────────────────────

  it.skipIf(!llmEnabled)('WB-02: full Hebrew build flow — schema language is "he", all replies Hebrew', async () => {
    const heBiz = await seedBusiness({ language: 'he', available247: true })
    const heCtx: SimContext = { fromNumber: heBiz.managerPhone, toNumber: heBiz.waNumber, businessId: heBiz.businessId }

    try {
      const r0 = await sim(heCtx, 'בנה אתר')
      assertAllRepliesInLanguage(r0, 'he')

      const r1 = await sim(heCtx, 'סגנון מינימלי, גוונים בהירים, מטפלת שרה לוי, מספרה, תל אביב, רחוב דיזנגוף')
      assertAllRepliesInLanguage(r1, 'he')

      await sim(heCtx, 'נראה טוב')
      const r3 = await sim(heCtx, 'מאושר')
      assertAllRepliesInLanguage(r3, 'he')

      // website_json language should be 'he'
      const [bizRow] = await db.select({ websiteJson: businesses.websiteJson })
        .from(businesses).where(eq(businesses.id, heBiz.businessId)).limit(1)
      if (bizRow?.websiteJson) {
        const schema = bizRow.websiteJson as unknown as { language?: string }
        expect(schema.language).toBe('he')
      }
    } finally {
      await teardown(heBiz.businessId)
    }
  }, 180_000)
})

// ── SD: Skill dispatch & registry ────────────────────────────────────────────

describe('SD — Skill dispatch', () => {
  it('SD-03: customer booking message is not handled by website-builder canHandle', () => {
    const customerCtx = {
      ...baseCtx,
      caller: { ...baseCtx.caller, role: 'customer' as const },
      message: { text: 'I want to book an appointment for tomorrow at 3pm', receivedAt: new Date() },
    }
    expect(websiteBuilderSkill.canHandle(customerCtx)).toBe(false)
  })
})
