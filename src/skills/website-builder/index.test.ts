import { describe, it, expect, vi, afterEach } from 'vitest'
import { websiteBuilderSkill } from './index.js'
import { runAeoChecks } from './aeo-validator.js'
import type { SkillContext, WorkflowState } from '../../shared/skill-types.js'
import type { SiteSchema } from './site-schema.js'

// ── Mocks ──────────────────────────────────────────────────────────────────────

vi.mock('./content-generator.js', () => ({
  generateSiteContent: vi.fn().mockResolvedValue(null),
  patchSiteContent: vi.fn().mockResolvedValue(null),
  suggestPalette: vi.fn().mockResolvedValue('midnight-blue'),
  // Turn-intent triage defaults to "not an interjection" so confirm/review steps
  // fall through to their normal edit handling in tests (matches production
  // behaviour when triage returns null on any LLM hiccup).
  triageTurn: vi.fn().mockResolvedValue(null),
}))

vi.mock('./aeo-validator.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./aeo-validator.js')>()
  return {
    ...original,
    runFullAeoPass: vi.fn().mockImplementation((schema: SiteSchema) => {
      return original.runAeoChecks(schema)
    }),
    runAdvisoryPass: vi.fn().mockResolvedValue(null),
  }
})

// ── Test fixtures ──────────────────────────────────────────────────────────────

const makeWorkflowState = (overrides: Partial<WorkflowState> = {}): WorkflowState => ({
  id: 'wf-test-1',
  skillName: 'website-builder',
  step: 'requirements-gather',
  state: {},
  version: 1,
  ...overrides,
})

const baseBusinessKnowledge = {
  services: [
    { id: 'svc-1', name: 'Swedish Massage', durationMinutes: 60, price: 280, currency: 'ILS', narrative: null },
    { id: 'svc-2', name: 'Deep Tissue Massage', durationMinutes: 90, price: 380, currency: 'ILS', narrative: null },
  ],
  policies: { minBufferMinutes: 15, maxDaysAhead: 30, cancellationCutoffMinutes: 1440 },
  faqs: [{ id: 'faq-1', question: 'How do I book?', answer: 'Send us a WhatsApp message.' }],
  brandVoice: 'warm and professional',
  communicationStyle: null,
  notificationPreferences: null,
  handoffBehavior: null,
  automatedMessagesConfig: null,
  confirmationGate: 'immediate' as const,
  paymentMethod: null,
  cancellationFeeAmount: null,
  cancellationFeeCurrency: null,
  websiteJson: null,
  websitePreviewUrl: null,
  websiteUrl: null,
  gmbProfileUrl: null,
  gmbVerified: false,
}

const baseCtx: SkillContext = {
  business: {
    id: 'biz-1',
    name: 'Serenity Massage Studio',
    timezone: 'Asia/Jerusalem',
    defaultLanguage: 'en',
    botPersona: 'neutral',
    currency: 'ILS',
  },
  caller: {
    id: 'mgr-1',
    phoneNumber: '+972501234567',
    role: 'manager',
    displayName: 'Noa',
    preferredLanguage: null,
  },
  message: { text: '', receivedAt: new Date() },
  conversationHistory: [],
  language: 'en',
  sessionId: 'session-test',
  businessKnowledge: baseBusinessKnowledge,
  workflowState: null,
  workflow: {
    advance: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(makeWorkflowState()),
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

function ctx(overrides: Partial<SkillContext> = {}): SkillContext {
  return {
    ...baseCtx,
    ...overrides,
    workflow: {
      advance: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn().mockResolvedValue(undefined),
      fail: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue(makeWorkflowState()),
      ...overrides.workflow,
    },
    message: { text: '', receivedAt: new Date(), ...overrides.message },
  }
}

// ── canHandle ──────────────────────────────────────────────────────────────────

describe('canHandle', () => {
  describe('build triggers — English', () => {
    const buildPhrases = [
      'I need a website',
      'Build my website',
      'Create a landing page for my business',
      'can you build me a site',
      'create site please',
    ]
    for (const phrase of buildPhrases) {
      it(`matches: "${phrase}"`, () => {
        expect(websiteBuilderSkill.canHandle(ctx({ message: { text: phrase, receivedAt: new Date() } }))).toBe(true)
      })
    }
  })

  describe('build triggers — Hebrew', () => {
    const buildPhrasesHe = ['אני רוצה אתר', 'בנה אתר לעסק שלי', 'צור אתר', 'דף נחיתה']
    for (const phrase of buildPhrasesHe) {
      it(`matches: "${phrase}"`, () => {
        expect(websiteBuilderSkill.canHandle(ctx({ message: { text: phrase, receivedAt: new Date() } }))).toBe(true)
      })
    }
  })

  describe('update triggers — English', () => {
    const updatePhrases = [
      'update my website',
      'edit the site',
      'change my website',
      'modify the site please',
      'website update needed',
      'site edit request',
    ]
    for (const phrase of updatePhrases) {
      it(`matches: "${phrase}"`, () => {
        expect(websiteBuilderSkill.canHandle(ctx({ message: { text: phrase, receivedAt: new Date() } }))).toBe(true)
      })
    }
  })

  describe('update triggers — Hebrew', () => {
    const updatePhrasesHe = ['עדכן אתר', 'שנה את האתר שלי', 'ערוך את הדף', 'תעדכן את האתר']
    for (const phrase of updatePhrasesHe) {
      it(`matches: "${phrase}"`, () => {
        expect(websiteBuilderSkill.canHandle(ctx({ message: { text: phrase, receivedAt: new Date() } }))).toBe(true)
      })
    }
  })

  describe('booking phrases — must NOT match', () => {
    const bookingPhrases = [
      'I want to book an appointment',
      'cancel my booking',
      'reschedule my session',
      'what time slots are available',
      'is Thursday available',
    ]
    for (const phrase of bookingPhrases) {
      it(`does not match: "${phrase}"`, () => {
        expect(websiteBuilderSkill.canHandle(ctx({ message: { text: phrase, receivedAt: new Date() } }))).toBe(false)
      })
    }
  })

  it('returns false for manager when message has no trigger keywords', () => {
    expect(websiteBuilderSkill.canHandle(ctx({ message: { text: 'hello there', receivedAt: new Date() } }))).toBe(false)
  })

  it('returns false when caller is not a manager', () => {
    expect(
      websiteBuilderSkill.canHandle(ctx({
        caller: { ...baseCtx.caller, role: 'customer' },
        message: { text: 'I need a website', receivedAt: new Date() },
      }))
    ).toBe(false)
  })

  it('resumes an active workflow regardless of message content', () => {
    expect(
      websiteBuilderSkill.canHandle(ctx({
        workflowState: makeWorkflowState({ step: 'structure-confirm' }),
        caller: { ...baseCtx.caller, role: 'customer' }, // even for customer — workflow trumps
        message: { text: 'hello', receivedAt: new Date() },
      }))
    ).toBe(true)
  })

  it('resumes active workflow even on booking-like text', () => {
    expect(
      websiteBuilderSkill.canHandle(ctx({
        workflowState: makeWorkflowState({ step: 'manager-review' }),
        message: { text: 'cancel', receivedAt: new Date() },
      }))
    ).toBe(true)
  })
})

// ── handle — entry branch ──────────────────────────────────────────────────────

describe('handle — entry branch', () => {
  it('creates a new build-flow workflow when no site exists', async () => {
    const c = ctx({ message: { text: 'build my website', receivedAt: new Date() } })
    const result = await websiteBuilderSkill.handle(c)

    expect(c.workflow.create).toHaveBeenCalledWith('website-builder', 'requirements-gather', {})
    expect(result.handled).toBe(true)
    expect(result.skillName).toBe('website-builder')
    if (result.handled) expect(result.reply.length).toBeGreaterThan(0)
  })

  it('creates an update-flow workflow when site already exists', async () => {
    const c = ctx({
      message: { text: 'update my website', receivedAt: new Date() },
      businessKnowledge: {
        ...baseBusinessKnowledge,
        websitePreviewUrl: 'https://preview.example.com/wf-abc/index.html',
        websiteJson: { business: { name: 'Test' } } as Record<string, unknown>,
      },
    })
    const result = await websiteBuilderSkill.handle(c)

    expect(c.workflow.create).toHaveBeenCalledWith(
      'website-builder',
      'edit-request',
      expect.objectContaining({ isUpdateFlow: true })
    )
    expect(result.handled).toBe(true)
    if (result.handled) expect(result.reply).toContain('https://preview.example.com/wf-abc/index.html')
  })

  it('update-flow pre-populates siteSchema from businessKnowledge.websiteJson', async () => {
    const storedSchema = { business: { name: 'Stored Biz' } } as Record<string, unknown>
    const c = ctx({
      message: { text: 'edit my site', receivedAt: new Date() },
      businessKnowledge: {
        ...baseBusinessKnowledge,
        websiteUrl: 'https://mybiz.com',
        websiteJson: storedSchema,
      },
    })
    await websiteBuilderSkill.handle(c)

    expect(c.workflow.create).toHaveBeenCalledWith(
      'website-builder',
      'edit-request',
      expect.objectContaining({ siteSchema: storedSchema, isUpdateFlow: true })
    )
  })

  it('build flow: no site → starts at requirements-gather, siteSchema not pre-populated', async () => {
    const c = ctx({ message: { text: 'I want a website', receivedAt: new Date() } })
    await websiteBuilderSkill.handle(c)
    expect(c.workflow.create).toHaveBeenCalledWith('website-builder', 'requirements-gather', {})
  })

  it('returns a well-formed SkillOutcome', async () => {
    const c = ctx({ message: { text: 'build my website', receivedAt: new Date() } })
    const result = await websiteBuilderSkill.handle(c)
    expect(result.skillName).toBe('website-builder')
    if (result.handled) {
      expect(typeof result.reply).toBe('string')
      expect(typeof result.sessionComplete).toBe('boolean')
    }
  })
})

// ── handle — cancel ────────────────────────────────────────────────────────────

describe('handle — cancel', () => {
  const cancelPhrases = ['stop', 'cancel', 'never mind', 'quit', 'עצור', 'בטל', 'די', 'הפסק', 'ביטול']

  for (const phrase of cancelPhrases) {
    it(`build flow cancel: "${phrase}" → workflow.complete() called`, async () => {
      const c = ctx({
        message: { text: phrase, receivedAt: new Date() },
        workflowState: makeWorkflowState({ step: 'structure-confirm', state: {} }),
      })
      const result = await websiteBuilderSkill.handle(c)

      expect(c.workflow.complete).toHaveBeenCalled()
      expect(c.workflow.advance).not.toHaveBeenCalled()
      expect(result.handled).toBe(true)
      if (result.handled) {
        expect(result.sessionComplete).toBe(true)
        // Build flow cancel message: resume prompt
        expect(result.reply).toMatch(/saved|progress|build|שמרתי|המשיכו/i)
      }
    })
  }

  it('build flow cancel does NOT call saveWebsiteConfig', async () => {
    const c = ctx({
      message: { text: 'cancel', receivedAt: new Date() },
      workflowState: makeWorkflowState({ step: 'manager-review', state: { siteSchema: { business: {} } } }),
    })
    await websiteBuilderSkill.handle(c)
    expect(c.saveWebsiteConfig).not.toHaveBeenCalled()
  })

  it('update flow cancel → workflow.complete(), no saveWebsiteConfig, site unchanged message', async () => {
    const previewUrl = 'https://preview.example.com/wf-xyz/index.html'
    const c = ctx({
      message: { text: 'cancel', receivedAt: new Date() },
      businessKnowledge: { ...baseBusinessKnowledge, websitePreviewUrl: previewUrl },
      workflowState: makeWorkflowState({
        step: 'content-patch',
        state: { isUpdateFlow: true, editRequest: 'change the tagline' },
      }),
    })
    const result = await websiteBuilderSkill.handle(c)

    expect(c.workflow.complete).toHaveBeenCalled()
    expect(c.saveWebsiteConfig).not.toHaveBeenCalled()
    expect(result.handled).toBe(true)
    if (result.handled) {
      expect(result.sessionComplete).toBe(true)
      expect(result.reply).toContain(previewUrl)
      expect(result.reply).toMatch(/unchanged|ללא שינוי/i)
    }
  })
})

// ── handle — requirements-gather step ────────────────────────────────────────

describe('handle — requirements-gather', () => {
  it('advances to structure-confirm after parsing requirements', async () => {
    const c = ctx({
      message: { text: 'minimal style, forest green, my name is Dana Levi', receivedAt: new Date() },
      workflowState: makeWorkflowState({ step: 'requirements-gather', state: {} }),
    })
    const result = await websiteBuilderSkill.handle(c)

    expect(c.workflow.advance).toHaveBeenCalledWith(
      'structure-confirm',
      expect.any(Object)
    )
    expect(result.handled).toBe(true)
    if (result.handled) expect(result.reply.length).toBeGreaterThan(0)
  })

  it('extracts styleVariant from text', async () => {
    const c = ctx({
      message: { text: 'bold style please', receivedAt: new Date() },
      workflowState: makeWorkflowState({ step: 'requirements-gather', state: {} }),
    })
    await websiteBuilderSkill.handle(c)

    const advanceCall = vi.mocked(c.workflow.advance).mock.calls[0]
    expect(advanceCall?.[1]).toMatchObject({ styleVariant: 'bold' })
  })
})

// ── handle — structure-confirm step ──────────────────────────────────────────

describe('handle — structure-confirm', () => {
  const approvalPhrases = ['approve', 'yes', 'ok', 'looks good', 'אשר', 'כן', 'מאושר']

  for (const phrase of approvalPhrases) {
    it(`"${phrase}" advances to content generation`, async () => {
      const c = ctx({
        message: { text: phrase, receivedAt: new Date() },
        workflowState: makeWorkflowState({
          step: 'structure-confirm',
          state: { styleVariant: 'professional', palette: 'midnight-blue' },
        }),
      })
      // generateSiteContent returns null → skill returns error message
      const result = await websiteBuilderSkill.handle(c)

      expect(c.workflow.advance).toHaveBeenCalledWith(
        'content-generate',
        expect.any(Object)
      )
      expect(result.handled).toBe(true)
    })
  }

  it('does not advance on non-approval text, re-shows structure', async () => {
    const c = ctx({
      message: { text: 'change the style to bold', receivedAt: new Date() },
      workflowState: makeWorkflowState({
        step: 'structure-confirm',
        state: { styleVariant: 'professional', palette: 'midnight-blue' },
      }),
    })
    const result = await websiteBuilderSkill.handle(c)

    // Should advance to structure-confirm again (re-parse then re-show)
    const advanceCalls = vi.mocked(c.workflow.advance).mock.calls
    const lastStep = advanceCalls[advanceCalls.length - 1]?.[0]
    expect(lastStep).toBe('structure-confirm')
    expect(result.handled).toBe(true)
  })
})

// ── handle — manager-review step ─────────────────────────────────────────────

describe('handle — manager-review', () => {
  it('build flow: approval advances to domain-setup', async () => {
    const c = ctx({
      message: { text: 'approve', receivedAt: new Date() },
      workflowState: makeWorkflowState({
        step: 'manager-review',
        state: { previewUrl: 'https://preview.example.com/wf-1/index.html', isUpdateFlow: false },
      }),
    })
    const result = await websiteBuilderSkill.handle(c)

    expect(c.workflow.advance).toHaveBeenCalledWith('domain-setup', expect.any(Object))
    expect(result.handled).toBe(true)
  })

  it('update flow: approval advances to domain-setup', async () => {
    const c = ctx({
      message: { text: 'אשר', receivedAt: new Date() },
      workflowState: makeWorkflowState({
        step: 'manager-review',
        state: { previewUrl: 'https://p.example.com/wf-2/', isUpdateFlow: true },
      }),
    })
    const result = await websiteBuilderSkill.handle(c)

    expect(c.workflow.advance).toHaveBeenCalledWith('domain-setup', expect.any(Object))
    expect(result.handled).toBe(true)
  })

  it('build flow: edit request loops back to content-generate', async () => {
    const c = ctx({
      message: { text: 'change the tagline to something shorter', receivedAt: new Date() },
      workflowState: makeWorkflowState({
        step: 'manager-review',
        state: {
          previewUrl: 'https://p.example.com/wf-3/',
          isUpdateFlow: false,
          editLoopCount: 0,
          siteSchema: { business: { name: 'Test' } },
        },
      }),
    })
    await websiteBuilderSkill.handle(c)

    const allSteps = vi.mocked(c.workflow.advance).mock.calls.map((c) => c[0])
    expect(allSteps).toContain('content-generate')
  })

  it('update flow: edit request loops back to content-patch (not content-generate)', async () => {
    const c = ctx({
      message: { text: 'also update the phone number', receivedAt: new Date() },
      workflowState: makeWorkflowState({
        step: 'manager-review',
        state: {
          previewUrl: 'https://p.example.com/wf-4/',
          isUpdateFlow: true,
          editLoopCount: 0,
          siteSchema: { business: { name: 'Test' } },
        },
      }),
    })
    await websiteBuilderSkill.handle(c)

    const allSteps = vi.mocked(c.workflow.advance).mock.calls.map((c) => c[0])
    expect(allSteps).toContain('content-patch')
    // Must NOT go to content-generate in update flow
    expect(allSteps).not.toContain('content-generate')
  })
})

// ── handle — domain-setup GATE-1 guard ───────────────────────────────────────

describe('handle — domain-setup (GATE-1)', () => {
  afterEach(() => {
    delete process.env['GATE_1_RESOLVED']
  })

  it('stays at domain-setup when GATE-1 is not resolved', async () => {
    delete process.env['GATE_1_RESOLVED']
    const c = ctx({
      message: { text: 'approve', receivedAt: new Date() },
      workflowState: makeWorkflowState({
        step: 'domain-setup',
        state: { previewUrl: 'https://preview.example.com/wf-5/', isUpdateFlow: false },
      }),
    })
    const result = await websiteBuilderSkill.handle(c)

    // Advances back to domain-setup (PAUSED)
    expect(c.workflow.advance).toHaveBeenCalledWith('domain-setup', expect.any(Object))
    expect(result.handled).toBe(true)
    if (result.handled) {
      // Includes preview URL in the reply
      expect(result.reply).toContain('https://preview.example.com/wf-5/')
    }
  })
})

// ── handle — edit-request step ───────────────────────────────────────────────

describe('handle — edit-request (update flow)', () => {
  it('stores edit text and advances to content-patch when siteSchema present', async () => {
    const storedSchema = { business: { name: 'Test Biz' } }
    const c = ctx({
      message: { text: 'change the tagline to "Healing hands in Tel Aviv"', receivedAt: new Date() },
      workflowState: makeWorkflowState({
        step: 'edit-request',
        state: { isUpdateFlow: true, siteSchema: storedSchema },
      }),
    })
    await websiteBuilderSkill.handle(c)

    expect(c.workflow.advance).toHaveBeenCalledWith(
      'content-patch',
      expect.objectContaining({ editRequest: 'change the tagline to "Healing hands in Tel Aviv"' })
    )
  })

  it('falls back to content-generate when siteSchema is absent', async () => {
    const c = ctx({
      message: { text: 'add a new service: hot stone, 90 min, 450 ILS', receivedAt: new Date() },
      workflowState: makeWorkflowState({
        step: 'edit-request',
        state: { isUpdateFlow: true },  // no siteSchema
      }),
    })
    await websiteBuilderSkill.handle(c)

    const allSteps = vi.mocked(c.workflow.advance).mock.calls.map((c) => c[0])
    expect(allSteps).toContain('content-generate')
  })
})

// ── AEO validator — deterministic checks ─────────────────────────────────────

describe('runAeoChecks', () => {
  const minimalFaq = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      question: `Question number ${i + 1} about the business services?`,
      answer: `This is the complete and detailed answer to question number ${i + 1}, fully standalone and factual.`,
      topic: 'general' as const,
      serviceSlug: null,
    }))

  const minimalService = (overrides: Partial<SiteSchema['services'][0]> = {}): SiteSchema['services'][0] => ({
    slug: 'swedish-massage',
    name: 'Swedish Massage',
    description: 'A relaxing full-body Swedish massage session that targets muscle tension and promotes circulation. Ideal for stress relief. Sixty minute session using warm oil and gentle long strokes for complete relaxation.',
    durationMinutes: 60,
    price: 280,
    priceOnRequest: false,
    currency: 'ILS',
    whoFor: 'Ideal for clients who need stress relief and relaxation.',
    processSteps: ['Consultation', 'Preparation', 'Treatment', 'Cool-down'],
    contraindications: null,
    faqs: [],
    ...overrides,
  })

  const validSchema: SiteSchema = {
    business: {
      name: 'Test Studio',
      category: 'Massage Therapy',
      tagline: 'Professional massage therapy in Tel Aviv',
      description: 'Test Studio is a professional massage therapy practice in Tel Aviv, offering Swedish and deep tissue treatments. Our licensed therapists provide personalized care in a serene, comfortable environment for complete relaxation and recovery.',
      city: 'Tel Aviv',
      address: '1 Dizengoff St, Tel Aviv',
      serviceArea: ['Tel Aviv', 'Ramat Gan'],
      phone: '+972501234567',
      googleBusinessProfileUrl: null,
      openingHours: [{ dayOfWeek: ['Monday', 'Tuesday'], opens: '09:00', closes: '18:00' }],
      credentials: [],
      foundedYear: null,
      practitionerName: null,
      practitionerTitle: null,
      practitionerBio: null,
    },
    style: { variant: 'minimal', palette: 'midnight-blue', logoUrl: null, heroImageUrl: null },
    services: [minimalService()],
    faqs: minimalFaq(6),
    language: 'en',
    generatedAt: new Date().toISOString(),
    workflowId: 'wf-test',
  }

  it('passes all checks on valid schema', () => {
    const { report } = runAeoChecks(validSchema)
    const failed = report.checks.filter((c) => !c.passed && !c.autoFixed)
    expect(failed).toHaveLength(0)
  })

  it('fails FAQ_COUNT when fewer than 5 FAQs', () => {
    const schema = { ...validSchema, faqs: minimalFaq(3) }
    const { report } = runAeoChecks(schema)
    const faqCheck = report.checks.find((c) => c.code === 'FAQ_COUNT')
    expect(faqCheck?.passed).toBe(false)
  })

  it('fails FAQ_ANSWER_LENGTH when answers are too short', () => {
    const shortFaqs = minimalFaq(5).map((f) => ({ ...f, answer: 'Short.' }))
    const schema = { ...validSchema, faqs: shortFaqs }
    const { report } = runAeoChecks(schema)
    const check = report.checks.find((c) => c.code === 'FAQ_ANSWER_LENGTH')
    expect(check?.passed).toBe(false)
  })

  it('fails SERVICE_DESCRIPTION when description is too short', () => {
    const schema = { ...validSchema, services: [minimalService({ description: 'Too short.' })] }
    const { report } = runAeoChecks(schema)
    const check = report.checks.find((c) => c.code === 'SERVICE_DESCRIPTION')
    expect(check?.passed).toBe(false)
  })

  it('fails PROCESS_STEPS when service has fewer than 3 steps', () => {
    const schema = { ...validSchema, services: [minimalService({ processSteps: ['Step 1', 'Step 2'] })] }
    const { report } = runAeoChecks(schema)
    const check = report.checks.find((c) => c.code === 'PROCESS_STEPS')
    expect(check?.passed).toBe(false)
  })

  it('fails OPENING_HOURS when no hours defined', () => {
    const schema = { ...validSchema, business: { ...validSchema.business, openingHours: [] } }
    const { report } = runAeoChecks(schema)
    const check = report.checks.find((c) => c.code === 'OPENING_HOURS')
    expect(check?.passed).toBe(false)
  })

  it('fails PHONE when phone is missing', () => {
    const schema = { ...validSchema, business: { ...validSchema.business, phone: '' } }
    const { report } = runAeoChecks(schema)
    const check = report.checks.find((c) => c.code === 'PHONE')
    expect(check?.passed).toBe(false)
  })

  it('auto-fixes SERVICE_AREA by adding city when empty', () => {
    const schema = { ...validSchema, business: { ...validSchema.business, serviceArea: [] } }
    const { schema: patched, report } = runAeoChecks(schema)
    const check = report.checks.find((c) => c.code === 'SERVICE_AREA')
    expect(check?.autoFixed).toBe(true)
    expect(patched.business.serviceArea).toContain('Tel Aviv')
  })

  it('fails TAGLINE_LENGTH when tagline is too long', () => {
    const schema = {
      ...validSchema,
      business: {
        ...validSchema.business,
        tagline: 'We provide the absolute best professional massage therapy services in all of Tel Aviv and beyond',
      },
    }
    const { report } = runAeoChecks(schema)
    const check = report.checks.find((c) => c.code === 'TAGLINE_LENGTH')
    expect(check?.passed).toBe(false)
  })

  it('reports correct passedCount and totalCount', () => {
    const { report } = runAeoChecks(validSchema)
    expect(report.totalCount).toBeGreaterThan(0)
    expect(report.passedCount).toBeLessThanOrEqual(report.totalCount)
  })

  it('counts service-level FAQs in total FAQ count', () => {
    const svcWithFaqs = minimalService({
      faqs: [
        { question: 'Is this safe?', answer: 'Yes, this treatment is completely safe for healthy adults without contraindications.' },
        { question: 'How should I prepare?', answer: 'Drink plenty of water before and after. Wear comfortable clothing and arrive 10 minutes early.' },
      ],
    })
    // Only 3 top-level FAQs, but 2 service-level → total 5
    const schema = { ...validSchema, faqs: minimalFaq(3), services: [svcWithFaqs] }
    const { report } = runAeoChecks(schema)
    const check = report.checks.find((c) => c.code === 'FAQ_COUNT')
    expect(check?.passed).toBe(true)
  })
})

// ── skill name invariant ───────────────────────────────────────────────────────

describe('skill name', () => {
  it('returns the correct skill name in all outcomes', async () => {
    const c = ctx({ message: { text: 'build my website', receivedAt: new Date() } })
    const result = await websiteBuilderSkill.handle(c)
    expect(result.skillName).toBe('website-builder')
    expect(websiteBuilderSkill.name).toBe('website-builder')
  })
})
