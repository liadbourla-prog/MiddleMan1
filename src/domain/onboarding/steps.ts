import type { OnboardingStep } from '../../db/schema.js'
import { i18n, type Lang } from '../i18n/t.js'

export interface StepDefinition {
  prompt: string
  retryPrompt?: string
}

// Kept for backward-compat (oauth.ts uses it for the calendar-connected message)
export const ONBOARDING_PROMPTS: Record<OnboardingStep, StepDefinition> = {
  business_name: { prompt: i18n.ob_business_name.en },
  services: { prompt: i18n.ob_services.en, retryPrompt: i18n.ob_services_retry.en },
  hours: { prompt: i18n.ob_hours.en, retryPrompt: i18n.ob_hours_retry.en },
  cancellation_policy: { prompt: i18n.ob_cancellation.en, retryPrompt: i18n.ob_cancellation_retry.en },
  payment: { prompt: i18n.ob_payment.en, retryPrompt: i18n.ob_payment_retry.en },
  escalation_policy: { prompt: i18n.ob_escalation.en, retryPrompt: i18n.ob_escalation_retry.en },
  calendar: { prompt: i18n.ob_calendar.en },
  customer_import: { prompt: i18n.ob_import.en },
  verify: { prompt: i18n.ob_verify.en },
}

export function getPrompt(step: OnboardingStep, lang: Lang): string {
  const map: Record<OnboardingStep, string> = {
    business_name: i18n.ob_business_name[lang],
    services: i18n.ob_services[lang],
    hours: i18n.ob_hours[lang],
    cancellation_policy: i18n.ob_cancellation[lang],
    payment: i18n.ob_payment[lang],
    escalation_policy: i18n.ob_escalation[lang],
    calendar: i18n.ob_calendar[lang],
    customer_import: i18n.ob_import[lang],
    verify: i18n.ob_verify[lang],
  }
  return map[step]
}

export function getRetryPrompt(step: OnboardingStep, lang: Lang): string | undefined {
  const map: Partial<Record<OnboardingStep, string>> = {
    services: i18n.ob_services_retry[lang],
    hours: i18n.ob_hours_retry[lang],
    cancellation_policy: i18n.ob_cancellation_retry[lang],
    payment: i18n.ob_payment_retry[lang],
    escalation_policy: i18n.ob_escalation_retry[lang],
  }
  return map[step]
}

export const ONBOARDING_STEP_ORDER: OnboardingStep[] = [
  'business_name',
  'services',
  'hours',
  'cancellation_policy',
  'payment',
  'escalation_policy',
  'calendar',
  'customer_import',
  'verify',
]

export function nextStep(current: OnboardingStep): OnboardingStep | null {
  const idx = ONBOARDING_STEP_ORDER.indexOf(current)
  return ONBOARDING_STEP_ORDER[idx + 1] ?? null
}

export function isAffirmative(text: string): boolean {
  const t = text.trim().toLowerCase()
  return ['yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'ken', 'כן'].some((w) => t.startsWith(w))
}

export function isNegative(text: string): boolean {
  const t = text.trim().toLowerCase()
  return ['no', 'nope', 'lo', 'לא'].some((w) => t.startsWith(w))
}
