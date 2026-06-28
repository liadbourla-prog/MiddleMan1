// INJ6 real-path test: a customer image *caption* (a booking typed under a photo) must reach the
// booking flow instead of being dropped to the non-text fallback; a captionless image still bounces.
// Also covers the provider channel: a captioned image routes through provider onboarding; a
// captionless one keeps the bilingual image fallback.
//
// Mocks must be declared before any imports (vitest hoists these). This mirrors
// tests/routes/contact-routing.test.ts so the webhook can be driven without a DB or live LLM.
import { vi } from 'vitest'

// Provider channel detection reads PROVIDER_WA_NUMBER at webhook.ts module load. ESM hoists
// imports above plain statements, so set the env inside vi.hoisted() to run before that load.
vi.hoisted(() => {
  process.env['PROVIDER_WA_NUMBER'] = '+972000000000'
})

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

vi.mock('../../src/domain/coordination/repository.js', () => ({ findActiveByContact: vi.fn() }))
vi.mock('../../src/domain/coordination/handler.js', () => ({ advanceFromContact: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../src/adapters/calendar/client.js', () => ({ createCalendarClient: vi.fn().mockReturnValue({}) }))
vi.mock('../../src/adapters/whatsapp/sender.js', () => ({ sendMessage: vi.fn().mockResolvedValue({ ok: true }) }))
vi.mock('../../src/adapters/llm/client.js', () => ({
  generateProactiveCustomerMessage: vi.fn().mockResolvedValue('NON_TEXT_FALLBACK'),
  generateManagerCommandReply: vi.fn().mockResolvedValue('msg'),
  generateProviderOnboardingReply: vi.fn().mockResolvedValue('PROVIDER_IMAGE_FALLBACK'),
  generateOnboardingReply: vi.fn().mockResolvedValue('msg'),
}))
vi.mock('../../src/adapters/whatsapp/webhook.js', () => ({
  verifySignature: vi.fn().mockReturnValue(true),
  verifyWebhookChallenge: vi.fn().mockReturnValue(null),
  normalizeWebhookPayload: vi.fn().mockReturnValue({ messages: [], nonTextReplies: [] }),
}))
vi.mock('../../src/adapters/whatsapp/media.js', () => ({
  downloadAndUploadMedia: vi.fn().mockResolvedValue({ ok: false, error: 'should-not-be-called' }),
}))
vi.mock('../../src/domain/identity/resolver.js', () => ({ resolveIdentity: vi.fn(), registerCustomer: vi.fn() }))
vi.mock('../../src/domain/session/manager.js', () => ({
  loadActiveSession: vi.fn().mockResolvedValue(null),
  createSession: vi.fn().mockResolvedValue({ id: 'sess1', context: {} }),
  completeSession: vi.fn().mockResolvedValue(undefined),
  updateSessionContext: vi.fn().mockResolvedValue(undefined),
  SESSION_EXPIRY: { manager: 14400000 },
}))
vi.mock('../../src/domain/flows/customer-booking.js', () => ({
  handleBookingFlow: vi.fn().mockResolvedValue({ reply: 'BOOKING_FLOW_REPLY', sessionComplete: false }),
}))
vi.mock('../../src/domain/reshuffle/inbound.js', () => ({ handleReshuffleReply: vi.fn().mockResolvedValue({ handled: false }) }))
vi.mock('../../src/domain/flows/types.js', () => ({ parseConfirmation: vi.fn().mockReturnValue('unclear') }))
vi.mock('../../src/domain/flows/language-switch.js', () => ({
  resolveTurnLanguage: vi.fn().mockReturnValue({ turnLang: 'he', detected: 'he', shouldOfferSwitch: false }),
}))
vi.mock('../../src/domain/flows/manager-onboarding.js', () => ({ handleOnboardingMessage: vi.fn().mockResolvedValue({ reply: 'ok' }) }))
vi.mock('../../src/domain/flows/provider-onboarding.js', () => ({
  handleProviderOnboarding: vi.fn().mockResolvedValue({ reply: 'PROVIDER_ONBOARDING_REPLY' }),
}))
vi.mock('../../src/adapters/llm/orchestrator.js', () => ({ runManagerOrchestratorLoop: vi.fn().mockResolvedValue('ok') }))
vi.mock('../../src/domain/authorization/permissions.js', () => ({ loadDelegatedPermissions: vi.fn().mockResolvedValue([]) }))
vi.mock('../../src/domain/audit/logger.js', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../src/domain/manager/apply.js', () => ({
  buildStatusReport: vi.fn().mockResolvedValue('report'),
  pausePA: vi.fn().mockResolvedValue(undefined),
  resumePA: vi.fn().mockResolvedValue(undefined),
  buildUpcomingReport: vi.fn().mockResolvedValue('report'),
  markEscalationHandled: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/domain/booking/engine.js', () => ({ confirmPaymentReceived: vi.fn().mockResolvedValue({ ok: true }) }))
vi.mock('../../src/workers/message-retry.js', () => ({ enqueueMessage: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../src/workers/generate-customer-summary.js', () => ({ enqueueCustomerSummary: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../src/workers/outreach-reply-notify.js', () => ({
  findPendingOutreachForCustomer: vi.fn().mockResolvedValue(null),
  enqueueOutreachReplyNotify: vi.fn().mockResolvedValue(undefined),
  enqueueOutreachReplyFlush: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../src/domain/customer/profile.js', () => ({ loadCustomerMemory: vi.fn().mockResolvedValue(null) }))
vi.mock('../../src/domain/session/hydration.js', () => ({
  buildHydratedContext: vi.fn().mockResolvedValue({}),
  loadSessionCarryover: vi.fn().mockResolvedValue(null),
}))
// saveMessage spy — we assert the caption is persisted (and thus gate-2 sanitized) for the customer role.
vi.mock('../../src/domain/messages/repository.js', () => ({
  saveMessage: vi.fn().mockResolvedValue(undefined),
  loadTranscript: vi.fn().mockResolvedValue([]),
}))
vi.mock('../../src/skills/index.js', () => ({ dispatchSkill: vi.fn().mockResolvedValue(null) }))
vi.mock('../../src/domain/skills/knowledge-resolver.js', () => ({ loadBusinessKnowledge: vi.fn().mockResolvedValue(null) }))
vi.mock('../../src/domain/provider/roster.js', () => ({
  loadInstructorRoster: vi.fn().mockResolvedValue([]),
  loadTeachingSchedule: vi.fn().mockResolvedValue([]),
}))
vi.mock('../../src/domain/skills/workflow-helpers.js', () => ({ loadActiveWorkflow: vi.fn().mockResolvedValue(null) }))
vi.mock('../../src/domain/skills/context-builder.js', () => ({ buildSkillContext: vi.fn().mockResolvedValue({}) }))
vi.mock('../../src/domain/flows/concurrency-lock.js', () => ({
  withBusinessLock: vi.fn().mockImplementation((_bizId, _msgId, fn) => fn()),
  withIdentityLock: vi.fn().mockImplementation((_id, fn) => fn()),
}))
vi.mock('../../src/domain/i18n/t.js', () => ({
  i18n: {
    outreach_reply_notify: { he: vi.fn().mockReturnValue('relay'), en: vi.fn().mockReturnValue('relay') },
    non_text_reply: { he: 'NON_TEXT_HE', en: 'NON_TEXT_EN' },
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
import { routeCustomerMessage, processInboundMessage } from '../../src/routes/webhook.js'
import { handleBookingFlow } from '../../src/domain/flows/customer-booking.js'
import { handleProviderOnboarding } from '../../src/domain/flows/provider-onboarding.js'
import { generateProactiveCustomerMessage, generateProviderOnboardingReply } from '../../src/adapters/llm/client.js'
import { downloadAndUploadMedia } from '../../src/adapters/whatsapp/media.js'
import { saveMessage } from '../../src/domain/messages/repository.js'

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

const fakeCustomer = {
  id: 'cust1',
  role: 'customer' as const,
  preferredLanguage: null,
  displayName: 'Dana',
  phoneNumber: '+972500000000',
  businessId: 'biz1',
  revokedAt: null,
  messagingOptOut: false,
} as never

const fakeApp = { log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } } as never

// A booking typed under a photo — Hebrew has no Latin characters.
const CAPTION = 'אני רוצה לקבוע יוגה ביום ראשון'

function customerImageMsg(body: string) {
  return {
    messageId: `msg-${Math.random()}`,
    fromNumber: '+972500000000',
    toNumber: '+972509999999',
    body,
    timestamp: new Date(),
    rawPayload: {},
    imageMediaId: 'media-abc',
    imageMediaType: 'image/jpeg',
  } as never
}

describe('INJ6 — customer image caption routing', () => {
  beforeEach(() => vi.clearAllMocks())

  it('captioned image reaches the booking flow and does NOT send the non-text fallback', async () => {
    await routeCustomerMessage(customerImageMsg(CAPTION), fakeCustomer, fakeBusiness, fakeApp)

    // The caption was routed as text → booking flow ran with the caption as the message body.
    expect(handleBookingFlow).toHaveBeenCalledOnce()
    const bookingArgs = vi.mocked(handleBookingFlow).mock.calls[0]!
    expect(bookingArgs).toContain(CAPTION)

    // No bounce: the non-text fallback was never generated, and image bytes were never uploaded.
    expect(generateProactiveCustomerMessage).not.toHaveBeenCalled()
    expect(downloadAndUploadMedia).not.toHaveBeenCalled()

    // The caption is persisted as customer-role text (gate-2 sanitized at saveMessage, T4.3i).
    expect(saveMessage).toHaveBeenCalledWith(expect.anything(), 'sess1', 'customer', CAPTION)
  })

  it('captionless image bounces to the single-language non-text fallback (F5)', async () => {
    await routeCustomerMessage(customerImageMsg(''), fakeCustomer, fakeBusiness, fakeApp)

    // No booking flow — there is nothing to act on.
    expect(handleBookingFlow).not.toHaveBeenCalled()
    // Single-language customer fallback. generateProactiveCustomerMessage is called with one language.
    expect(generateProactiveCustomerMessage).toHaveBeenCalledOnce()
    const fallbackArgs = vi.mocked(generateProactiveCustomerMessage).mock.calls[0]![0] as { language: string; fallback: string }
    expect(fallbackArgs.language).toBe('he')
    // Fallback string carries no Latin/English half — single-language by design.
    expect(fallbackArgs.fallback).toBe('NON_TEXT_HE')
  })
})

function providerImageMsg(body: string) {
  return {
    messageId: `pmsg-${Math.random()}`,
    fromNumber: '+972500000000',
    toNumber: process.env['PROVIDER_WA_NUMBER'],
    body,
    timestamp: new Date(),
    rawPayload: {},
    imageMediaId: 'media-xyz',
    imageMediaType: 'image/jpeg',
  } as never
}

describe('INJ6 — provider image caption routing', () => {
  beforeEach(() => vi.clearAllMocks())

  it('captioned image on the provider channel routes through provider onboarding', async () => {
    await processInboundMessage(providerImageMsg(CAPTION), fakeApp)

    expect(handleProviderOnboarding).toHaveBeenCalledOnce()
    expect(handleProviderOnboarding).toHaveBeenCalledWith(expect.anything(), '+972500000000', CAPTION)
    // No bilingual image bounce.
    expect(generateProviderOnboardingReply).not.toHaveBeenCalled()
  })

  it('captionless image on the provider channel keeps the bilingual image fallback', async () => {
    await processInboundMessage(providerImageMsg(''), fakeApp)

    expect(handleProviderOnboarding).not.toHaveBeenCalled()
    // Bilingual fallback by design (Branch 2): generateProviderOnboardingReply invoked with lang 'bilingual'.
    expect(generateProviderOnboardingReply).toHaveBeenCalledOnce()
    const args = vi.mocked(generateProviderOnboardingReply).mock.calls[0]![0] as { lang: string }
    expect(args.lang).toBe('bilingual')
  })
})
