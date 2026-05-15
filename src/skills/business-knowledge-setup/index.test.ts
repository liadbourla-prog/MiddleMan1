import { describe, it, expect, vi } from 'vitest'
import { businessKnowledgeSetupSkill } from './index.js'
import type { SkillContext, WorkflowState } from '../../shared/skill-types.js'

const makeWorkflow = (overrides: Partial<WorkflowState> = {}): WorkflowState => ({
  id: 'wf-1',
  skillName: 'business-knowledge-setup',
  step: 'brand-voice',
  state: {},
  version: 1,
  ...overrides,
})

const baseCtx: SkillContext = {
  business: { id: 'biz-1', name: 'Test Salon', timezone: 'Asia/Jerusalem', defaultLanguage: 'en', botPersona: 'neutral', currency: 'ILS' },
  caller: { id: 'mgr-1', phoneNumber: '+972500000001', role: 'manager', displayName: 'Dana', preferredLanguage: null },
  message: { text: '', receivedAt: new Date() },
  conversationHistory: [],
  language: 'en',
  sessionId: 'session-1',
  businessKnowledge: {
    services: [{ id: 'svc-1', name: 'Haircut', durationMinutes: 45, price: 150, currency: 'ILS', narrative: null }],
    policies: { minBufferMinutes: 0, maxDaysAhead: 30, cancellationCutoffMinutes: 0 },
    faqs: [],
    brandVoice: null,
    communicationStyle: null,
    notificationPreferences: null,
    handoffBehavior: null,
    automatedMessagesConfig: null,
    confirmationGate: 'immediate',
    paymentMethod: null,
    cancellationFeeAmount: null,
    cancellationFeeCurrency: null,
    websiteJson: null,
    websitePreviewUrl: null,
    websiteUrl: null,
    gmbProfileUrl: null,
    gmbVerified: false,
  },
  workflowState: null,
  workflow: {
    advance: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(makeWorkflow()),
  },
  recentCompletedBooking: null,
  customerSegmentQuery: vi.fn().mockResolvedValue([]),
  saveFAQs: vi.fn().mockResolvedValue(undefined),
  saveServiceNarrative: vi.fn().mockResolvedValue(undefined),
  saveBrandVoice: vi.fn().mockResolvedValue(undefined),
  saveCommunicationStyle: vi.fn().mockResolvedValue(undefined),
  saveNotificationPreferences: vi.fn().mockResolvedValue(undefined),
  saveHandoffBehavior: vi.fn().mockResolvedValue(undefined),
  saveAutomatedMessagesConfig: vi.fn().mockResolvedValue(undefined),
  saveBookingEdgeCases: vi.fn().mockResolvedValue(undefined),
  saveServiceIntakeNotes: vi.fn().mockResolvedValue(undefined),
  saveCancellationFee: vi.fn().mockResolvedValue(undefined),
  saveCancellationCutoffMinutes: vi.fn().mockResolvedValue(undefined),
  deferFeatureRequest: vi.fn().mockResolvedValue(undefined),
  saveWebsiteConfig: vi.fn().mockResolvedValue(undefined),
  requestGmbOAuth: vi.fn().mockResolvedValue('https://accounts.google.com/oauth'),
  requestGmbVerification: vi.fn().mockResolvedValue(undefined),
  saveGmbLocation: vi.fn().mockResolvedValue(undefined),
  createGmbListing: vi.fn().mockResolvedValue({ locationId: 'accounts/123/locations/456', profileUrl: 'https://maps.google.com/test' }),
}

function ctx(text: string, workflowState: WorkflowState | null = null): SkillContext {
  return {
    ...baseCtx,
    message: { text, receivedAt: new Date() },
    workflowState,
    workflow: {
      advance: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue(makeWorkflow()),
    },
    saveBrandVoice: vi.fn().mockResolvedValue(undefined),
    saveFAQs: vi.fn().mockResolvedValue(undefined),
    saveCommunicationStyle: vi.fn().mockResolvedValue(undefined),
    saveNotificationPreferences: vi.fn().mockResolvedValue(undefined),
    saveHandoffBehavior: vi.fn().mockResolvedValue(undefined),
    saveAutomatedMessagesConfig: vi.fn().mockResolvedValue(undefined),
    saveBookingEdgeCases: vi.fn().mockResolvedValue(undefined),
    saveServiceIntakeNotes: vi.fn().mockResolvedValue(undefined),
    saveCancellationFee: vi.fn().mockResolvedValue(undefined),
    saveCancellationCutoffMinutes: vi.fn().mockResolvedValue(undefined),
    deferFeatureRequest: vi.fn().mockResolvedValue(undefined),
  }
}

// ── canHandle ──────────────────────────────────────────────────────────────────

describe('canHandle', () => {
  it('returns true when active workflow matches this skill', () => {
    const c = ctx('anything', makeWorkflow())
    expect(businessKnowledgeSetupSkill.canHandle(c)).toBe(true)
  })

  it('returns true for manager trigger phrases (en)', () => {
    for (const phrase of ['update business info', 'update brand voice', 'business setup', 'business knowledge']) {
      const c = ctx(phrase)
      expect(businessKnowledgeSetupSkill.canHandle(c)).toBe(true)
    }
  })

  it('returns true for manager trigger phrases (he)', () => {
    for (const phrase of ['עדכן עסק', 'עדכן מידע', 'ידע עסקי', 'הגדרות עסק']) {
      const c = ctx(phrase)
      expect(businessKnowledgeSetupSkill.canHandle(c)).toBe(true)
    }
  })

  it('returns false for customer callers even with trigger phrase', () => {
    const c = { ...ctx('update business info'), caller: { ...baseCtx.caller, role: 'customer' as const } }
    expect(businessKnowledgeSetupSkill.canHandle(c)).toBe(false)
  })

  it('does not match booking phrases', () => {
    for (const phrase of ['book appointment', 'cancel my booking', 'available slots', 'reschedule']) {
      const c = ctx(phrase)
      expect(businessKnowledgeSetupSkill.canHandle(c)).toBe(false)
    }
  })

  it('returns false for unrelated manager messages with no active workflow', () => {
    const c = ctx('What is the weather today?')
    expect(businessKnowledgeSetupSkill.canHandle(c)).toBe(false)
  })
})

// ── handle ────────────────────────────────────────────────────────────────────

describe('handle', () => {
  it('creates a workflow and returns first question when no active workflow', async () => {
    const c = ctx('update business info')
    const result = await businessKnowledgeSetupSkill.handle(c)

    expect(result.handled).toBe(true)
    if (result.handled) {
      expect(result.reply.length).toBeGreaterThan(0)
      expect(result.sessionComplete).toBe(false)
      expect(result.skillName).toBe(businessKnowledgeSetupSkill.name)
      expect(c.workflow.create).toHaveBeenCalledWith('business-knowledge-setup', expect.any(String), expect.any(Object))
    }
  })

  it('handles CANCEL at brand-voice step — completes workflow and confirms save', async () => {
    const c = ctx('cancel', makeWorkflow({ step: 'brand-voice' }))
    const result = await businessKnowledgeSetupSkill.handle(c)

    expect(result.handled).toBe(true)
    if (result.handled) {
      expect(c.workflow.complete).toHaveBeenCalled()
      expect(result.sessionComplete).toBe(true)
    }
  })

  it('handles brand-voice text — saves brand voice and advances', async () => {
    const c = ctx('We are a warm, family-friendly salon that values personal connection.', makeWorkflow({ step: 'brand-voice' }))
    const result = await businessKnowledgeSetupSkill.handle(c)

    expect(result.handled).toBe(true)
    if (result.handled) {
      expect(c.saveBrandVoice).toHaveBeenCalledWith('We are a warm, family-friendly salon that values personal connection.')
      expect(c.workflow.advance).toHaveBeenCalledWith('communication-style', expect.any(Object))
      expect(result.sessionComplete).toBe(false)
    }
  })

  it('handles SKIP at brand-voice — advances without saving', async () => {
    const c = ctx('skip', makeWorkflow({ step: 'brand-voice' }))
    const result = await businessKnowledgeSetupSkill.handle(c)

    expect(result.handled).toBe(true)
    if (result.handled) {
      expect(c.saveBrandVoice).not.toHaveBeenCalled()
      expect(c.workflow.advance).toHaveBeenCalledWith('communication-style', expect.any(Object))
    }
  })

  it('always returns skillName matching the registered name', async () => {
    const c = ctx('hello', makeWorkflow({ step: 'brand-voice' }))
    const result = await businessKnowledgeSetupSkill.handle(c)
    expect(result.skillName).toBe(businessKnowledgeSetupSkill.name)
  })

  it('returns a non-empty reply in all paths', async () => {
    const steps: Array<WorkflowState['step']> = ['brand-voice', 'notification-prefs', 'faq-collect']
    for (const step of steps) {
      const c = ctx('skip', makeWorkflow({ step }))
      const result = await businessKnowledgeSetupSkill.handle(c)
      if (result.handled) {
        expect(result.reply.length).toBeGreaterThan(0)
      }
    }
  })

  it('cancellation-payment-confirm APPROVE advances without saving fee', async () => {
    const c = ctx('APPROVE', makeWorkflow({ step: 'cancellation-payment-confirm' }))
    const result = await businessKnowledgeSetupSkill.handle(c)

    expect(result.handled).toBe(true)
    if (result.handled) {
      expect(c.saveCancellationFee).not.toHaveBeenCalled()
      expect(c.workflow.advance).toHaveBeenCalledWith('service-narratives', expect.any(Object))
    }
  })

  it('cancellation-payment-confirm with fee text — saves fee', async () => {
    const c = ctx('cancellation fee 80 ILS', makeWorkflow({ step: 'cancellation-payment-confirm' }))
    const result = await businessKnowledgeSetupSkill.handle(c)

    expect(result.handled).toBe(true)
    if (result.handled) {
      expect(c.saveCancellationFee).toHaveBeenCalledWith(80, expect.any(String))
    }
  })

  it('faq-review APPROVE saves FAQs and advances', async () => {
    const c = ctx('approve', makeWorkflow({
      step: 'faq-review',
      state: { generatedFaqs: [{ question: 'Do you take walk-ins?', answer: 'Yes!' }] },
    }))
    const result = await businessKnowledgeSetupSkill.handle(c)

    expect(result.handled).toBe(true)
    if (result.handled) {
      expect(c.saveFAQs).toHaveBeenCalledWith([{ question: 'Do you take walk-ins?', answer: 'Yes!' }])
    }
  })

  it('open-question DONE transitions to website-offer', async () => {
    const c = ctx('done', makeWorkflow({ step: 'open-question' }))
    const result = await businessKnowledgeSetupSkill.handle(c)

    expect(result.handled).toBe(true)
    if (result.handled) {
      expect(c.workflow.advance).toHaveBeenCalledWith('website-offer', expect.any(Object))
      expect(result.sessionComplete).toBe(false)
    }
  })
})
