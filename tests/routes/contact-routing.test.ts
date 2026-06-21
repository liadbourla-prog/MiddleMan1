// Mocks must be declared before any imports (vitest hoists these)
import { vi } from 'vitest'

vi.mock('../../src/db/client.js', () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ phoneNumber: '+972501111111' }]),
        }),
      }),
    }),
  },
}))

vi.mock('../../src/domain/coordination/repository.js', () => ({
  findActiveByContact: vi.fn(),
}))

vi.mock('../../src/domain/coordination/handler.js', () => ({
  advanceFromContact: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../src/adapters/calendar/client.js', () => ({
  createCalendarClient: vi.fn().mockReturnValue({}),
}))

vi.mock('../../src/adapters/whatsapp/sender.js', () => ({
  sendMessage: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('../../src/adapters/llm/client.js', () => ({
  generateProactiveCustomerMessage: vi.fn().mockResolvedValue('msg'),
  generateManagerCommandReply: vi.fn().mockResolvedValue('msg'),
  generateProviderOnboardingReply: vi.fn().mockResolvedValue('msg'),
  generateOnboardingReply: vi.fn().mockResolvedValue('msg'),
}))

// Additional mocks required by webhook.ts imports
vi.mock('../../src/adapters/whatsapp/webhook.js', () => ({
  verifySignature: vi.fn().mockReturnValue(true),
  verifyWebhookChallenge: vi.fn().mockReturnValue(null),
  normalizeWebhookPayload: vi.fn().mockReturnValue({ messages: [], nonTextReplies: [] }),
}))
vi.mock('../../src/adapters/whatsapp/media.js', () => ({
  downloadAndUploadMedia: vi.fn().mockResolvedValue({ ok: false, error: 'not needed' }),
}))
vi.mock('../../src/domain/identity/resolver.js', () => ({
  resolveIdentity: vi.fn(),
  registerCustomer: vi.fn(),
}))
vi.mock('../../src/domain/session/manager.js', () => ({
  loadActiveSession: vi.fn().mockResolvedValue(null),
  createSession: vi.fn().mockResolvedValue({ id: 'sess1', context: {} }),
  completeSession: vi.fn().mockResolvedValue(undefined),
  updateSessionContext: vi.fn().mockResolvedValue(undefined),
  SESSION_EXPIRY: { manager: 14400000 },
}))
vi.mock('../../src/domain/flows/customer-booking.js', () => ({
  handleBookingFlow: vi.fn().mockResolvedValue({ reply: 'ok', sessionComplete: false }),
}))
vi.mock('../../src/domain/reshuffle/inbound.js', () => ({
  handleReshuffleReply: vi.fn().mockResolvedValue({ handled: false }),
}))
vi.mock('../../src/domain/flows/types.js', () => ({
  parseConfirmation: vi.fn().mockReturnValue('unclear'),
}))
vi.mock('../../src/domain/flows/language-switch.js', () => ({
  resolveTurnLanguage: vi.fn().mockReturnValue({ turnLang: 'he', detected: 'he', shouldOfferSwitch: false }),
}))
vi.mock('../../src/domain/flows/manager-onboarding.js', () => ({
  handleOnboardingMessage: vi.fn().mockResolvedValue({ reply: 'ok' }),
}))
vi.mock('../../src/domain/flows/provider-onboarding.js', () => ({
  handleProviderOnboarding: vi.fn().mockResolvedValue({ reply: 'ok' }),
}))
vi.mock('../../src/adapters/llm/orchestrator.js', () => ({
  runManagerOrchestratorLoop: vi.fn().mockResolvedValue('ok'),
}))
vi.mock('../../src/domain/authorization/permissions.js', () => ({
  loadDelegatedPermissions: vi.fn().mockResolvedValue([]),
}))
vi.mock('../../src/domain/audit/logger.js', () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/domain/manager/apply.js', () => ({
  buildStatusReport: vi.fn().mockResolvedValue('report'),
  pausePA: vi.fn().mockResolvedValue(undefined),
  resumePA: vi.fn().mockResolvedValue(undefined),
  buildUpcomingReport: vi.fn().mockResolvedValue('report'),
  markEscalationHandled: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/domain/booking/engine.js', () => ({
  confirmPaymentReceived: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('../../src/workers/message-retry.js', () => ({
  enqueueMessage: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/workers/generate-customer-summary.js', () => ({
  enqueueCustomerSummary: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/workers/outreach-reply-notify.js', () => ({
  findPendingOutreachForCustomer: vi.fn().mockResolvedValue(null),
  enqueueOutreachReplyNotify: vi.fn().mockResolvedValue(undefined),
  enqueueOutreachReplyFlush: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/domain/customer/profile.js', () => ({
  loadCustomerMemory: vi.fn().mockResolvedValue(null),
}))
vi.mock('../../src/domain/session/hydration.js', () => ({
  buildHydratedContext: vi.fn().mockResolvedValue({}),
  loadSessionCarryover: vi.fn().mockResolvedValue(null),
}))
vi.mock('../../src/domain/messages/repository.js', () => ({
  saveMessage: vi.fn().mockResolvedValue(undefined),
  loadTranscript: vi.fn().mockResolvedValue([]),
}))
vi.mock('../../src/skills/index.js', () => ({
  dispatchSkill: vi.fn().mockResolvedValue(null),
}))
vi.mock('../../src/domain/skills/knowledge-resolver.js', () => ({
  loadBusinessKnowledge: vi.fn().mockResolvedValue(null),
}))
vi.mock('../../src/domain/provider/roster.js', () => ({
  loadInstructorRoster: vi.fn().mockResolvedValue([]),
  loadTeachingSchedule: vi.fn().mockResolvedValue([]),
}))
vi.mock('../../src/domain/skills/workflow-helpers.js', () => ({
  loadActiveWorkflow: vi.fn().mockResolvedValue(null),
}))
vi.mock('../../src/domain/skills/context-builder.js', () => ({
  buildSkillContext: vi.fn().mockResolvedValue({}),
}))
vi.mock('../../src/domain/flows/concurrency-lock.js', () => ({
  withBusinessLock: vi.fn().mockImplementation((_bizId, _msgId, fn) => fn()),
}))
vi.mock('../../src/domain/i18n/t.js', () => ({
  i18n: {
    outreach_reply_notify: { he: vi.fn().mockReturnValue('relay msg'), en: vi.fn().mockReturnValue('relay msg') },
    non_text_reply: { he: 'non-text', en: 'non-text' },
    revoked_access: { he: 'revoked', en: 'revoked' },
    paused_msg: { he: vi.fn().mockReturnValue('paused'), en: vi.fn().mockReturnValue('paused') },
    pause_confirm: { he: 'paused', en: 'paused' },
    resume_confirm: { he: 'resumed', en: 'resumed' },
    manager_process_error: { he: vi.fn().mockReturnValue('err'), en: vi.fn().mockReturnValue('err') },
    manager_classify_error: { he: 'err', en: 'err' },
    escalation_handled: { he: vi.fn().mockReturnValue('handled'), en: vi.fn().mockReturnValue('handled') },
  },
  managerSwitchOfferSuffix: vi.fn().mockReturnValue(''),
}))

import { describe, it, expect, beforeEach } from 'vitest'
import { routeContactMessage } from '../../src/routes/webhook.js'
import { findActiveByContact } from '../../src/domain/coordination/repository.js'
import { advanceFromContact } from '../../src/domain/coordination/handler.js'
import { sendMessage } from '../../src/adapters/whatsapp/sender.js'

const fakeBusiness = {
  id: 'biz1',
  name: 'Test Biz',
  timezone: 'Asia/Jerusalem',
  defaultLanguage: 'he',
  whatsappPhoneNumberId: 'waid1',
  whatsappAccessToken: 'token1',
  googleRefreshToken: 'refresh1',
  googleCalendarId: 'cal1',
  calendarMode: 'internal',
  paused: false,
  onboardingCompletedAt: new Date(),
  currency: 'ILS',
  botPersona: null,
  whatsappNumber: '+972509999999',
  whatsappAppSecret: null,
} as never

const fakeIdentity = {
  id: 'c1',
  role: 'contact' as const,
  preferredLanguage: null,
  displayName: 'Harel',
  phoneNumber: '+972500000000',
  businessId: 'biz1',
  revokedAt: null,
  messagingOptOut: false,
} as never

const fakeMsg = {
  messageId: 'msg1',
  fromNumber: '+972500000000',
  toNumber: '+972509999999',
  body: 'Thursday works',
  timestamp: new Date(),
  rawPayload: {},
} as never

const fakeApp = { log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } } as never

const fakeRow = {
  id: 'coord1',
  businessId: 'biz1',
  ownerId: 'owner1',
  contactId: 'c1',
  title: 'Sync',
  durationMinutes: 60,
  candidateSlots: [{ start: new Date('2026-06-25T10:00:00Z'), end: new Date('2026-06-25T11:00:00Z') }],
  status: 'awaiting_counterparty' as const,
  agreedSlotStart: null,
  agreedSlotEnd: null,
  expiresAt: new Date(Date.now() + 86400000),
}

describe('routeContactMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('Scenario A: active coordination found — calls advanceFromContact', async () => {
    vi.mocked(findActiveByContact).mockResolvedValue(fakeRow as never)

    await routeContactMessage(fakeMsg, fakeIdentity, fakeBusiness, fakeApp)

    expect(advanceFromContact).toHaveBeenCalledOnce()
    expect(advanceFromContact).toHaveBeenCalledWith(
      expect.anything(), // db
      expect.anything(), // calendar client
      fakeRow,
      'Thursday works',
      expect.objectContaining({ businessId: 'biz1', lang: 'he' }),
    )
  })

  it('Scenario B: no active coordination — advanceFromContact NOT called, sendMessage relays to manager', async () => {
    vi.mocked(findActiveByContact).mockResolvedValue(null)

    await routeContactMessage(fakeMsg, fakeIdentity, fakeBusiness, fakeApp)

    expect(advanceFromContact).not.toHaveBeenCalled()
    expect(sendMessage).toHaveBeenCalledOnce()
  })
})
