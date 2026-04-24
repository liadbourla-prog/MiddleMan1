import type { OnboardingStep } from '../../db/schema.js'

export interface StepDefinition {
  prompt: string
  retryPrompt?: string
}

export const ONBOARDING_PROMPTS: Record<OnboardingStep, StepDefinition> = {
  business_name: {
    prompt:
      "Hi! I'm your new PA. Let's finish setup together — it only takes a few minutes.\n\nFirst: what name should I use for your business when I talk to customers? (e.g. \"Liad's Barbershop\")",
  },
  services: {
    prompt:
      "Great! Now tell me your services.\n\nSend them like this:\n\"Haircut 30 min, Beard trim 20 min, Full grooming 60 min\"\n\nYou can always add or change services later.",
    retryPrompt:
      "I didn't quite catch that. Please list your services with a duration for each — for example:\n\"Haircut 30 min, Beard trim 20 min\"",
  },
  hours: {
    prompt:
      "Perfect! Now set your working hours.\n\nSend them like this:\n\"Mon–Fri 9am to 7pm, Saturday 9am to 3pm, closed Sunday\"\n\nYou can change these at any time.",
    retryPrompt:
      "I couldn't parse those hours. Please try again, for example:\n\"Mon–Fri 9:00–18:00, Saturday 9:00–14:00, closed Sunday\"",
  },
  calendar: {
    prompt:
      'Now let\'s connect your Google Calendar — this is where all bookings will appear.\n\nTap the link below (takes about 20 seconds):\n{{OAUTH_LINK}}\n\nOnce connected, I\'ll confirm here automatically.',
  },
  customer_import: {
    prompt:
      'Almost done! Do you have an existing customer list, booking history, or service catalog to import?\n\nReply "Yes" to get a secure upload link, or "Skip" to continue without importing.',
  },
  verify: {
    prompt:
      "You're all set! Send me any message to confirm your PA is live and working.",
  },
}

export const ONBOARDING_STEP_ORDER: OnboardingStep[] = [
  'business_name',
  'services',
  'hours',
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
