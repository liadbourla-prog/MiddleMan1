import { eq, and } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { businesses, serviceTypes, businessFaqs } from '../../db/schema.js'
import type {
  BusinessKnowledge,
  CommunicationStyle,
  NotificationPreferences,
  HandoffBehavior,
  AutomatedMessagesConfig,
} from '../../shared/skill-types.js'

export async function loadBusinessKnowledge(db: Db, businessId: string, currency: string): Promise<BusinessKnowledge> {
  const [business, services, faqs] = await Promise.all([
    db.select({
      minBookingBufferMinutes: businesses.minBookingBufferMinutes,
      maxBookingDaysAhead: businesses.maxBookingDaysAhead,
      cancellationCutoffMinutes: businesses.cancellationCutoffMinutes,
      brandVoice: businesses.brandVoice,
      communicationStyle: businesses.communicationStyle,
      notificationPreferences: businesses.notificationPreferences,
      handoffBehavior: businesses.handoffBehavior,
      automatedMessagesConfig: businesses.automatedMessagesConfig,
      confirmationGate: businesses.confirmationGate,
      paymentMethod: businesses.paymentMethod,
      cancellationFeeAmount: businesses.cancellationFeeAmount,
      cancellationFeeCurrency: businesses.cancellationFeeCurrency,
      websiteJson: businesses.websiteJson,
      websitePreviewUrl: businesses.websitePreviewUrl,
      websiteUrl: businesses.websiteUrl,
    }).from(businesses).where(eq(businesses.id, businessId)).limit(1),

    db.select({
      id: serviceTypes.id,
      name: serviceTypes.name,
      durationMinutes: serviceTypes.durationMinutes,
      paymentAmount: serviceTypes.paymentAmount,
      narrative: serviceTypes.narrative,
    }).from(serviceTypes).where(and(eq(serviceTypes.businessId, businessId), eq(serviceTypes.isActive, true))),

    db.select({
      id: businessFaqs.id,
      question: businessFaqs.question,
      answer: businessFaqs.answer,
    }).from(businessFaqs).where(and(eq(businessFaqs.businessId, businessId), eq(businessFaqs.isActive, true))),
  ])

  const biz = business[0]

  return {
    services: services.map((s) => ({
      id: s.id,
      name: s.name,
      durationMinutes: s.durationMinutes,
      price: s.paymentAmount !== null ? parseFloat(s.paymentAmount) : null,
      currency,
      narrative: s.narrative,
    })),
    policies: {
      minBufferMinutes: biz?.minBookingBufferMinutes ?? 30,
      maxDaysAhead: biz?.maxBookingDaysAhead ?? 365,
      cancellationCutoffMinutes: biz?.cancellationCutoffMinutes ?? 0,
    },
    faqs: faqs.map((f) => ({ id: f.id, question: f.question, answer: f.answer })),
    brandVoice: biz?.brandVoice ?? null,
    communicationStyle: (biz?.communicationStyle as CommunicationStyle | null) ?? null,
    notificationPreferences: (biz?.notificationPreferences as NotificationPreferences | null) ?? null,
    handoffBehavior: (biz?.handoffBehavior as HandoffBehavior | null) ?? null,
    automatedMessagesConfig: (biz?.automatedMessagesConfig as AutomatedMessagesConfig | null) ?? null,
    confirmationGate: (biz?.confirmationGate as 'immediate' | 'post_payment') ?? 'immediate',
    paymentMethod: biz?.paymentMethod ?? null,
    cancellationFeeAmount: biz?.cancellationFeeAmount !== null && biz?.cancellationFeeAmount !== undefined
      ? parseFloat(biz.cancellationFeeAmount)
      : null,
    cancellationFeeCurrency: biz?.cancellationFeeCurrency ?? null,
    websiteJson: (biz?.websiteJson as Record<string, unknown> | null) ?? null,
    websitePreviewUrl: biz?.websitePreviewUrl ?? null,
    websiteUrl: biz?.websiteUrl ?? null,
  }
}
