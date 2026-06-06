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
    | 'booking_cancellation'
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
  | { step: 'cancellation_policy'; isAnswer: boolean; hours: number | null }
  | { step: 'payment'; isAnswer: boolean; requiresPayment: boolean | null; paymentMethod: string | null }
  | {
      step: 'escalation_policy'
      isAnswer: boolean
      triggers: string[]
      minimalEscalation: boolean
      customerMessage: 'silent' | 'passed_to_owner' | 'owner_callback' | 'custom'
      customText: string | null
    }

export interface TranscriptTurn {
  role: 'customer' | 'assistant'
  text: string
}

export interface OperatorActionOutput {
  action:
    | 'status_all'
    | 'status_one'
    | 'escalations'
    | 'update_all'
    | 'skills_one'
    | 'features'
    | 'retrigger'
    | 'general_qa'
    | 'help'
  businessName: string | null
  skillName: string | null
  updateInstruction: string | null
  freeformReply: string | null
}

export interface BusinessCommunicationStyle {
  formality: 'formal' | 'casual'
  emojiUse: 'none' | 'occasional' | 'frequent'
  useCustomerName: boolean
  humor: boolean
  phrasesToAvoid: string[]
  phrasesToUse: string[]
  fallbackPhrase: string
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
  // Business knowledge — injected when available, absent for bootstrap/fallback paths
  brandVoice?: string | null
  communicationStyle?: BusinessCommunicationStyle | null
  faqs?: Array<{ question: string; answer: string }>
}
