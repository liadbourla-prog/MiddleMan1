// Typed contract between the core engine (Developer A) and skills (Developer B).
// Developer A owns this file. Skills may only import from src/shared/.

// Structured breakdown of the business's physical address, for surfaces that need parts
// rather than the free-text blob (websites, GMB listings). Every part is optional — the owner
// may give only a street + city. The canonical free-text address stays on SkillBusiness.address.
export interface AddressComponents {
  streetAddress: string | null
  city: string | null
  region: string | null
  country: string | null
  postalCode: string | null
}

export interface SkillBusiness {
  id: string
  name: string
  timezone: string
  defaultLanguage: 'he' | 'en'
  botPersona: 'female' | 'male' | 'neutral'
  currency: string
  // Physical location. `address` is the canonical free-text display string; `addressComponents`
  // is the structured breakdown for websites/GMB; `googleMapsUrl` is a ready-to-use link (the
  // owner's pasted Maps/g.page link, or a derived search URL). All null until the owner sets it.
  address: string | null
  addressComponents: AddressComponents | null
  googleMapsUrl: string | null
}

export interface SkillCaller {
  id: string
  phoneNumber: string
  role: 'manager' | 'delegated_user' | 'customer'
  displayName: string | null
  preferredLanguage: 'he' | 'en' | null
}

export interface SkillMessage {
  text: string
  receivedAt: Date
  imageUrl?: string | null
  imageMediaType?: string | null
}

export interface SkillConversationTurn {
  role: 'customer' | 'assistant'
  text: string
}

export interface ServiceSummary {
  id: string
  name: string
  durationMinutes: number
  price: number | null
  currency: string
  narrative: string | null
}

export interface PolicySummary {
  minBufferMinutes: number
  maxDaysAhead: number
  cancellationCutoffMinutes: number
}

export interface FAQ {
  id: string
  question: string
  answer: string
}

export interface CommunicationStyle {
  formality: 'formal' | 'casual'
  emojiUse: 'none' | 'occasional' | 'frequent'
  useCustomerName: boolean
  humor: boolean
  phrasesToAvoid: string[]
  phrasesToUse: string[]
  rudeCustHandling: 'firm' | 'soft' | 'redirect'
  offLimitTopics: string[]
  fallbackPhrase: string
}

export interface NotificationPreferences {
  newBooking: boolean
  firstTimeCustomer: boolean
  cancellation: boolean
  reschedule: boolean
  noShow: boolean
  upsetLanguage: boolean
}

export interface HandoffBehavior {
  scenarios: string[]
  handoffPhrase: string
  alternateContact: string | null
}

export interface AutomatedMessageTemplate {
  enabled: boolean
  body: string
  delayMinutes?: number
}

export interface AutomatedMessagesConfig {
  booking_confirmation: AutomatedMessageTemplate
  reminder_24h: AutomatedMessageTemplate
  reminder_1h: AutomatedMessageTemplate
  post_appointment: AutomatedMessageTemplate
  no_show: AutomatedMessageTemplate
  cancellation_ack: AutomatedMessageTemplate
  first_booking_welcome: AutomatedMessageTemplate
  waitlist_offer: AutomatedMessageTemplate
  review_request: AutomatedMessageTemplate
  rescheduled_confirmation: AutomatedMessageTemplate
  payment_request: AutomatedMessageTemplate
}

export interface BookingEdgeCases {
  sameDayAllowed: boolean
  sameDayCutoffHour: number | null
  walkInsAccepted: boolean
  backToBackAllowed: boolean
  pricingCommunication: 'state' | 'hide' | 'on_request'
  depositInfo: string | null
}

export interface BusinessKnowledge {
  services: ServiceSummary[]
  policies: PolicySummary
  faqs: FAQ[]
  brandVoice: string | null
  communicationStyle: CommunicationStyle | null
  notificationPreferences: NotificationPreferences | null
  handoffBehavior: HandoffBehavior | null
  automatedMessagesConfig: AutomatedMessagesConfig | null
  confirmationGate: 'immediate' | 'post_payment'
  paymentMethod: string | null
  cancellationFeeAmount: number | null
  cancellationFeeCurrency: string | null
  // Website builder
  websiteJson: Record<string, unknown> | null      // stored SiteSchema — non-null = site exists, seed for content-patch
  websitePreviewUrl: string | null                  // preview URL — non-null triggers update flow
  websiteUrl: string | null                         // production URL once live
  // Google Business Profile
  gmbProfileUrl: string | null
  gmbVerified: boolean                              // true when gmbLocationId is set
}

export interface WorkflowState {
  id: string
  skillName: string
  step: string
  state: Record<string, unknown>
  version: number
}

export interface WorkflowCallbacks {
  advance(step: string, state: Record<string, unknown>): Promise<void>
  complete(): Promise<void>
  fail(error: { code: string; message: string; recoverable: boolean }): Promise<void>
  create(skillName: string, firstStep: string, initialState?: Record<string, unknown>): Promise<WorkflowState>
}

export interface CompletedBookingSummary {
  bookingId: string
  serviceName: string
  slotStart: Date
  customerName: string | null
}

// Modal time band of a customer's visits (business-local). Inlined here (shared must not
// import from core); structurally matches the core TimeBand in domain/crm/customer-profile.ts.
export type CustomerTimeBand = 'morning' | 'afternoon' | 'evening'

export interface CustomerSummary {
  identityId: string
  phoneNumber: string
  displayName: string | null
  totalBookings: number
  lastBookingAt: Date | null
  // Behavioral profile (Phase 2). Optional so existing consumers/mocks stay valid.
  cadenceDays?: number | null
  preferredServiceTypeId?: string | null
  // Instructor affinity (Phase 1b). The most-visited staff member, plus their resolved display
  // name so proactive copy can say "with Dana" without a second lookup. Null for solo operators.
  preferredProviderId?: string | null
  preferredProviderName?: string | null
  // Lifetime spend (Phase 3) — sum of pinned booking amounts; the value model's LTV input.
  lifetimeSpend?: number
  preferredDayOfWeek?: number | null // 0=Sun..6=Sat, business-local
  preferredTimeBand?: CustomerTimeBand | null
  noShowRate?: number
  vip?: boolean
}

export interface SegmentFilter {
  serviceTypeId?: string
  inactiveSinceDays?: number
  hasBooking?: boolean
  // Behavioral targeting (Phase 2) — powers cold-fill / win-back.
  preferredDayOfWeek?: number
  preferredTimeBand?: CustomerTimeBand
  lapsed?: boolean // established cadence + overshot it
  vip?: boolean
  providerId?: string // instructor targeting (Phase 1b) — "invite Dana's regulars"
}

export type StepStatus = 'SUCCESS' | 'RETRYABLE' | 'FATAL' | 'PAUSED'

export interface StepResult {
  status: StepStatus
  retryCount?: number
  errorContext?: { code: string; message: string; recoverable: boolean }
}

/** Everything a skill receives. No DB handles, no tokens, no internal engine state. */
export interface SkillContext {
  business: SkillBusiness
  caller: SkillCaller
  message: SkillMessage
  conversationHistory: SkillConversationTurn[]
  language: 'he' | 'en'
  sessionId: string
  businessKnowledge: BusinessKnowledge
  workflowState: WorkflowState | null
  workflow: WorkflowCallbacks
  recentCompletedBooking: CompletedBookingSummary | null
  managerMemorySummaries?: string[]
  customerSegmentQuery: (filter: SegmentFilter) => Promise<CustomerSummary[]>
  // Phase 6.3: a skill detector PROPOSES a proactive initiation; the core records the owner-confirm
  // proposal (or sends directly once the category is ratchet-promoted). Skills never import the engine.
  proposeInitiation: (input: ProposeInitiationInput) => Promise<ProposeInitiationOutcome>
  saveFAQs: (faqs: Array<{ question: string; answer: string }>) => Promise<void>
  saveServiceNarrative: (serviceTypeId: string, narrative: string) => Promise<void>
  saveBrandVoice: (brandVoice: string) => Promise<void>
  saveCommunicationStyle: (style: CommunicationStyle) => Promise<void>
  saveNotificationPreferences: (prefs: NotificationPreferences) => Promise<void>
  saveHandoffBehavior: (behavior: HandoffBehavior) => Promise<void>
  saveAutomatedMessagesConfig: (config: AutomatedMessagesConfig) => Promise<void>
  saveBookingEdgeCases: (cases: BookingEdgeCases) => Promise<void>
  saveServiceIntakeNotes: (serviceTypeId: string, notes: string) => Promise<void>
  saveCancellationFee: (amount: number | null, currency: string) => Promise<void>
  saveCancellationCutoffMinutes: (minutes: number) => Promise<void>
  deferFeatureRequest: (text: string) => Promise<void>
  // Website builder — writes website_json + website_preview_url to businesses table
  saveWebsiteConfig: (schema: Record<string, unknown>, previewUrl: string) => Promise<void>
  // Google Business Profile
  requestGmbOAuth: () => Promise<string>
  requestGmbVerification: (locationId: string, method: 'POSTCARD' | 'PHONE_CALL') => Promise<void>
  saveGmbLocation: (locationId: string, profileUrl: string) => Promise<void>
  createGmbListing: (params: {
    businessName: string
    categoryId: string
    phone: string
    address: { streetAddress: string; city: string; country: string }
    websiteUrl: string | null
    description: string
    serviceArea: string[]
  }) => Promise<{ locationId: string; profileUrl: string }>
}

/**
 * A proactive initiation a skill DETECTOR proposes (Phase 6.3; design §4.7/§5). The skill never
 * imports the engine: it calls the injected `proposeInitiation` callback with this descriptor and
 * the core records the owner-confirm proposal (and, once the category is ratchet-promoted, may send
 * directly). `initiatorId` is a free string (e.g. 'churn.winback', 'hotlead.alert'); `language`
 * defaults to the skill context language when omitted.
 */
export interface ProposeInitiationInput {
  initiatorId: string
  recipientId: string
  recipientPhone: string
  dedupKey: string
  situation: string // for LLM phrasing at send time (after approval)
  fallback: string
  ownerSummary: string // what the owner is shown in the proposal
  language?: 'he' | 'en'
}

export type ProposeInitiationOutcome = 'proposed' | 'duplicate' | 'recipient_opted_out'

/** Everything a skill may return. The core engine decides what to do with it. */
export interface SkillResult {
  /** The skill handled this message and produced a reply. */
  handled: true
  reply: string
  sessionComplete: boolean
  skillName: string
}

/** A skill that cannot handle the message passes through. */
export interface SkillPassthrough {
  handled: false
  skillName: string
}

export type SkillOutcome = SkillResult | SkillPassthrough

export interface Skill {
  readonly name: string
  /** Fast synchronous check — return true only if this skill owns this message. */
  canHandle(ctx: SkillContext): boolean
  handle(ctx: SkillContext): Promise<SkillOutcome>
}
