export interface CustomerIntentOutput {
  intent: 'booking' | 'rescheduling' | 'cancellation' | 'inquiry' | 'list_bookings' | 'system_explanation' | 'unknown'
  slotRequest: {
    hasSpecificDate: boolean
    hasSpecificTime: boolean
    // Structured date/time CLASSIFICATION — the LLM reports what the customer said;
    // the deterministic core (availability/resolve-slot.ts) computes the absolute
    // instant. The LLM never does calendar arithmetic. (resolvedStart/End are kept
    // for back-compat only and are IGNORED by Branch 4.)
    relativeDay: 'today' | 'tomorrow' | 'day_after_tomorrow' | 'this_week' | 'next_week' | null
    weekday: number | null // 0=Sun … 6=Sat
    weekdayAnchor?: 'this' | 'next' | null
    explicitDate: { year: number | null; month: number | null; day: number | null } | null
    time: { hour: number; minute: number } | null
    timeOfDay: 'morning' | 'afternoon' | 'evening' | null
    resolvedStart: string | null
    resolvedEnd: string | null
    dateHint: string | null
    timeHint: string | null
    dateAmbiguous?: boolean | undefined
  } | null
  serviceTypeHint: string | null
  providerHint: string | null
  customerNameHint: string | null
  participantsHint: number | null
  summary: string | null
  rawEntities: Record<string, string>
  detectedLanguage: 'he' | 'en'
  // Categorical time windows the customer RULES OUT ("no mornings", "not Thursdays") —
  // distinct from slotRequest (what they want). Folded into per-session negotiation
  // constraints so suggestions honour the exclusion. See negotiation-constraints.ts.
  avoidConstraints?: {
    beforeHour: number | null // exclude slots starting before this business-local hour
    afterHour: number | null // exclude slots starting at/after this business-local hour
    weekdays: number[] | null // exclude these business-local weekdays (0=Sun … 6=Sat)
  } | null
  // True when the customer asks for an arrangement the standard catalog can't express:
  // a PRIVATE version of a group class, a GROUP booking beyond a 1-on-1 service's
  // capacity, an explicitly OUT-OF-HOURS session, or a bespoke event. Shape-only signal;
  // the deterministic core confirms unfulfillability before any owner escalation.
  specialArrangementRequest?: boolean
  // True when the customer asks to UNDO a cancellation / bring back a just-cancelled
  // booking. Drives the snapshot-based restore path (re-offers the exact cancelled slot).
  restorePrevious?: boolean
  // True ONLY when the customer explicitly asks to join a waitlist / have their place
  // kept for a slot or class that is full. Three-state like the flags above: omitted →
  // undefined (model never spoke), never silently false. Consumed by the join flow (WL-4).
  joinWaitlist?: boolean
  // The SENDER's own grammatical gender, inferred ONLY from their first-person Hebrew
  // ("מעוניינת"→female, "מעוניין"→male). 'none' when no gendered self-reference appears.
  // Feeds resolveAddresseeGender (self_morphology signal). Defaults to 'none'.
  selfGenderEvidence: 'male' | 'female' | 'none'
}

export interface ManagerInstructionOutput {
  instructionType:
    | 'availability_change'
    | 'policy_change'
    | 'service_change'
    | 'permission_change'
    | 'booking_cancellation'
    | 'recurring_class_change'
    | 'provider_change'
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
  // IANA timezone of the business. When present, generateCustomerReply injects a
  // DATE FACTS block so the conversational replier states real dates instead of
  // inventing them. Real human dates the LLM phrases — not internal codes (G2).
  businessTimezone?: string | undefined
  // Authoritative, closed-world business facts (exhaustive service list, capacities,
  // prices, and an explicit "no other staff/services exist" statement). Built from
  // real config by the flow layer and injected as a ground-truth block so the reply
  // LLM can never invent instructors, prices, capacities, or services. When the
  // transcript and these facts disagree, these facts win.
  businessFacts?: string | undefined
  // L1 grounding (ACTION_GROUNDING_SPEC.md): a record of real, system-performed actions
  // involving this customer (e.g. a proactive outreach the business just sent them). Lets
  // a reply continue an outreach thread instead of cold-greeting, and overrides any action
  // the transcript merely implies. Built from audit_log by the flow layer.
  actionLedger?: string | undefined
  botPersona?: 'female' | 'male' | 'neutral' | undefined
  // How to address the PERSON in Hebrew second-person (resolved per-identity, decision 1).
  // null/undefined → masculine floor (byte-identical to the prior hardcoded rule). Orthogonal
  // to botPersona (the PA's SELF-voice). Applied at the voice chokepoint AND as a reinforcing note.
  addresseeGender?: 'male' | 'female' | null | undefined
  customerMemory?: {
    returningCustomer: boolean
    preferredServiceName: string | null
    displayName: string | null
    // Last few bookings (newest first) so the PA can reference history naturally.
    recentBookings?: Array<{ serviceName: string; slotStart: string; state: string }>
    // Notes from prior conversations (newest first) — what was discussed across visits.
    sessionSummaries?: string[]
  } | null
  // Business knowledge — injected when available, absent for bootstrap/fallback paths
  brandVoice?: string | null
  communicationStyle?: BusinessCommunicationStyle | null
  faqs?: Array<{ question: string; answer: string }>
}
