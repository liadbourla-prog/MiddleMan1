export interface CustomerIntentOutput {
  intent: 'booking' | 'rescheduling' | 'cancellation' | 'inquiry' | 'list_bookings' | 'unknown'
  slotRequest: {
    hasSpecificDate: boolean
    hasSpecificTime: boolean
    resolvedStart: string | null
    resolvedEnd: string | null
    dateHint: string | null
    timeHint: string | null
    dateAmbiguous?: boolean | undefined
  } | null
  serviceTypeHint: string | null
  providerHint: string | null
  summary: string | null
  rawEntities: Record<string, string>
  detectedLanguage: 'he' | 'en'
}

export interface ManagerInstructionOutput {
  instructionType:
    | 'availability_change'
    | 'policy_change'
    | 'service_change'
    | 'permission_change'
    | 'unknown'
  structuredParams: Record<string, unknown>
  ambiguous: boolean
  clarificationNeeded: string | null
}

export type LlmResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string }

export type ParseableOnboardingStep = 'cancellation_policy' | 'payment' | 'escalation_policy'

export type OnboardingAnswerOutput =
  | { step: 'cancellation_policy'; hours: number }
  | { step: 'payment'; requiresPayment: boolean; paymentMethod: string | null }
  | {
      step: 'escalation_policy'
      triggers: string[]
      minimalEscalation: boolean
      customerMessage: 'silent' | 'passed_to_owner' | 'owner_callback' | 'custom'
      customText: string | null
    }

export interface TranscriptTurn {
  role: 'customer' | 'assistant'
  text: string
}

export interface GenerateReplyInput {
  businessName: string
  language: 'he' | 'en'
  situation: string
  transcript: TranscriptTurn[]
  botPersona?: 'female' | 'male' | 'neutral' | undefined
  customerMemory?: {
    returningCustomer: boolean
    preferredServiceName: string | null
    displayName: string | null
  } | null
}
