import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
  numeric,
  jsonb,
  time,
  date,
  index,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export const businesses = pgTable('businesses', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  whatsappNumber: text('whatsapp_number').notNull().unique(),
  whatsappPhoneNumberId: text('whatsapp_phone_number_id'),
  whatsappAccessToken: text('whatsapp_access_token'),
  whatsappAppSecret: text('whatsapp_app_secret'),
  googleCalendarId: text('google_calendar_id').notNull(),
  googleRefreshToken: text('google_refresh_token'),
  timezone: text('timezone').notNull().default('UTC'),
  minBookingBufferMinutes: integer('min_booking_buffer_minutes').notNull().default(30),
  maxBookingDaysAhead: integer('max_booking_days_ahead').notNull().default(365),
  cancellationCutoffMinutes: integer('cancellation_cutoff_minutes').notNull().default(0),
  currency: text('currency').notNull().default('ILS'),
  botPersona: text('bot_persona', { enum: ['female', 'male', 'neutral'] }).notNull().default('neutral'),
  // Booking policy
  confirmationGate: text('confirmation_gate', { enum: ['immediate', 'post_payment'] }).notNull().default('immediate'),
  paymentMethod: text('payment_method'),
  // Availability policy
  available247: boolean('available_247').notNull().default(true),
  // Calendar backend
  calendarMode: text('calendar_mode', { enum: ['google', 'internal'] }).notNull().default('google'),
  // PA state
  paused: boolean('paused').notNull().default(false),
  // Language: default for the business, used when customer language is unknown
  defaultLanguage: text('default_language', { enum: ['he', 'en'] }).notNull().default('he'),
  // Owner-defined escalation rules: [{trigger, value?, customerMessage, customText?}]
  escalationRules: jsonb('escalation_rules').notNull().default([]),
  // Onboarding
  onboardingStep: text('onboarding_step', {
    enum: ['business_name', 'services', 'hours', 'cancellation_policy', 'payment', 'escalation_policy', 'calendar', 'customer_import', 'verify'],
  }).default('business_name'),
  onboardingCompletedAt: timestamp('onboarding_completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Skills layer
  brandVoice: text('brand_voice'),
  googleReviewUrl: text('google_review_url'),
  communicationStyle: jsonb('communication_style'),
  notificationPreferences: jsonb('notification_preferences'),
  handoffBehavior: jsonb('handoff_behavior'),
  automatedMessagesConfig: jsonb('automated_messages_config'),
  bookingEdgeCases: jsonb('booking_edge_cases'),
  // Proactive reshuffle engine knobs (null = safe defaults; see domain/reshuffle/config.ts)
  reshuffleConfig: jsonb('reshuffle_config'),
  // Owner-approval gate for freed-slot waitlist offers (WS-C / #6 / #8).
  // null = owner never asked → first freed slot asks AND offers to set a standing pref.
  // 'ask' = ask each time · 'auto' = offer automatically · 'never' = never offer.
  freedSlotOfferPolicy: text('freed_slot_offer_policy', { enum: ['ask', 'auto', 'never'] }),
  cancellationFeeAmount: numeric('cancellation_fee_amount', { precision: 10, scale: 2 }),
  cancellationFeeCurrency: text('cancellation_fee_currency'),
  // Website builder
  websiteJson: jsonb('website_json'),
  websitePreviewUrl: text('website_preview_url'),
  websiteUrl: text('website_url'),
  // Google Business Profile
  gmbRefreshToken: text('gmb_refresh_token'),
  gmbLocationId: text('gmb_location_id'),
  googleBusinessProfileUrl: text('google_business_profile_url'),
  // Daily briefing (opt-in manager summary)
  dailyBriefingEnabled: boolean('daily_briefing_enabled').notNull().default(false),
  dailyBriefingTime: text('daily_briefing_time').default('09:00'),
})

export const identities = pgTable(
  'identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    phoneNumber: text('phone_number').notNull(),
    role: text('role', { enum: ['manager', 'delegated_user', 'customer', 'provider'] }).notNull(),
    displayName: text('display_name'),
    grantedBy: uuid('granted_by'),
    grantedAt: timestamp('granted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    messagingOptOut: boolean('messaging_opt_out').notNull().default(false),
    // Reshuffle engine: VIPs are never moved involuntarily (decision A4)
    vip: boolean('vip').notNull().default(false),
    // Customer's preferred language for PA replies; null = use business default
    preferredLanguage: text('preferred_language', { enum: ['he', 'en'] }),
    conversationPausedUntil: timestamp('conversation_paused_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('identities_business_phone_idx').on(t.businessId, t.phoneNumber)],
)

export const serviceTypes = pgTable('service_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id')
    .notNull()
    .references(() => businesses.id),
  name: text('name').notNull(),
  durationMinutes: integer('duration_minutes').notNull(),
  bufferMinutes: integer('buffer_minutes').notNull().default(0),
  category: text('category'),
  maxParticipants: integer('max_participants').notNull().default(1),
  requiresPayment: boolean('requires_payment').notNull().default(false),
  paymentAmount: numeric('payment_amount', { precision: 10, scale: 2 }),
  // color_id maps to Google Calendar colorId (1-11) or null for default
  colorId: integer('color_id'),
  isActive: boolean('is_active').notNull().default(true),
  deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Skills layer
  narrative: text('narrative'),
  intakeRequired: boolean('intake_required').notNull().default(false),
  intakeNotes: text('intake_notes'),
})

// Named price tiers per service type (CRM_STANDARD.md §1.2). The service base
// price (service_types.payment_amount) is the default/drop-in rate; tiers express
// alternatives — e.g. a 'member' rate. Eligibility (who is a member) is Tier-B and
// inert today: a tier only applies when a caller passes its name to the resolver.
export const servicePriceTiers = pgTable(
  'service_price_tiers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    serviceTypeId: uuid('service_type_id')
      .notNull()
      .references(() => serviceTypes.id),
    tier: text('tier').notNull(), // 'drop_in' | 'member' | free-form
    amount: numeric('amount', { precision: 10, scale: 2 }).notNull(),
    currency: text('currency').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('service_price_tiers_service_tier_idx').on(t.serviceTypeId, t.tier)],
)

// Per-business API keys for the public website data API (website-data-plugin spec).
// We store only the sha256 hash of the raw key; the raw key is shown once at mint.
export const businessApiKeys = pgTable(
  'business_api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    type: text('type', { enum: ['publishable', 'secret'] }).notNull(),
    keyHash: text('key_hash').notNull(),
    prefix: text('prefix').notNull(),
    label: text('label'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('business_api_keys_hash_idx').on(t.keyHash),
    index('business_api_keys_business_idx').on(t.businessId, t.isActive),
  ],
)

export const availability = pgTable(
  'availability',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    providerId: uuid('provider_id').references(() => identities.id),
    dayOfWeek: integer('day_of_week'),
    specificDate: date('specific_date'),
    openTime: time('open_time'),
    closeTime: time('close_time'),
    isBlocked: boolean('is_blocked').notNull().default(false),
    reason: text('reason'),
  },
  (t) => [
    check(
      'availability_day_or_date',
      sql`(${t.dayOfWeek} IS NOT NULL AND ${t.specificDate} IS NULL) OR (${t.dayOfWeek} IS NULL AND ${t.specificDate} IS NOT NULL)`,
    ),
    check('availability_day_of_week_range', sql`${t.dayOfWeek} BETWEEN 0 AND 6 OR ${t.dayOfWeek} IS NULL`),
  ],
)

// Maps which staff members handle which service types
export const providerAssignments = pgTable(
  'provider_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    identityId: uuid('identity_id')
      .notNull()
      .references(() => identities.id),
    serviceTypeId: uuid('service_type_id')
      .notNull()
      .references(() => serviceTypes.id),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('provider_assignments_identity_service_idx').on(t.identityId, t.serviceTypeId),
    index('provider_assignments_business_idx').on(t.businessId, t.isActive),
  ],
)

// Which manager-level actions a delegated_user has been granted by the owner.
// One row per (identity, action). The owner declares exactly what a staff member
// may do (e.g. edit the calendar but not change pricing); authorize() enforces it
// at the apply seam. Closes the "in-memory only" gap in authorization/check.ts.
export const delegatedPermissions = pgTable(
  'delegated_permissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    identityId: uuid('identity_id')
      .notNull()
      .references(() => identities.id),
    action: text('action').notNull(), // matches the Action union in authorization/check.ts
    grantedBy: uuid('granted_by'),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('delegated_permissions_identity_action_idx').on(t.identityId, t.action),
    index('delegated_permissions_identity_idx').on(t.identityId),
  ],
)

export const bookings = pgTable(
  'bookings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    serviceTypeId: uuid('service_type_id')
      .notNull()
      .references(() => serviceTypes.id),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => identities.id),
    providerId: uuid('provider_id').references(() => identities.id),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    slotStart: timestamp('slot_start', { withTimezone: true }).notNull(),
    slotEnd: timestamp('slot_end', { withTimezone: true }).notNull(),
    state: text('state', {
      enum: ['inquiry', 'requested', 'held', 'pending_payment', 'confirmed', 'cancelled', 'expired', 'failed', 'attended', 'no_show'],
    }).notNull(),
    holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
    calendarEventId: text('calendar_event_id'),
    // Last Google etag written by the outbound mirror — used by inbound sync for
    // loop prevention (incoming etag == last-written ⇒ our own echo, ignore).
    googleEtag: text('google_etag'),
    paymentStatus: text('payment_status', {
      enum: ['not_required', 'pending', 'paid', 'failed'],
    })
      .notNull()
      .default('not_required'),
    cancellationReason: text('cancellation_reason'),
    cancelledByRole: text('cancelled_by_role', { enum: ['customer', 'manager', 'system'] }),
    slotTzAtCreation: text('slot_tz_at_creation'),
    rescheduledFrom: uuid('rescheduled_from'),
    // Set when manager bulk-cancels and agrees to help customer rebook
    rebookingRequested: boolean('rebooking_requested').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('bookings_business_state_idx').on(t.businessId, t.state),
    index('bookings_slot_idx').on(t.businessId, t.slotStart, t.slotEnd),
    index('bookings_hold_expires_idx')
      .on(t.holdExpiresAt)
      .where(sql`${t.state} = 'held'`),
  ],
)

// Time-ranged blocks, personal events, and proactively-scheduled group sessions.
// Single home for "manager-occupied time" — distinct from recurring working hours
// (availability table) and customer bookings (bookings table). See CALENDAR_UX_DESIGN.md.
export const calendarBlocks = pgTable(
  'calendar_blocks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    type: text('type', { enum: ['block', 'personal', 'class'] }).notNull().default('block'),
    startTs: timestamp('start_ts', { withTimezone: true }).notNull(),
    endTs: timestamp('end_ts', { withTimezone: true }).notNull(),
    title: text('title'),
    reason: text('reason'),
    // For type='class': the group service this session instances, and its capacity
    serviceTypeId: uuid('service_type_id').references(() => serviceTypes.id),
    maxParticipants: integer('max_participants'),
    // For type='class' materialized from a recurring series: links back to the
    // parent series so the materializer can detect already-created occurrences
    // (idempotency) and a single-instance edit can become a series exception.
    seriesId: uuid('series_id'),
    // Optional owner/staff scoping
    providerId: uuid('provider_id').references(() => identities.id),
    // Google mirror linkage (Google mode only)
    googleEventId: text('google_event_id'),
    googleEtag: text('google_etag'),
    // Provenance: 'internal' = created via PA/Branch 3; 'google_import' = ingested from owner's Google edit
    source: text('source', { enum: ['internal', 'google_import'] }).notNull().default('internal'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('calendar_blocks_business_range_idx').on(t.businessId, t.startTs, t.endTs),
    index('calendar_blocks_google_event_idx').on(t.businessId, t.googleEventId),
    index('calendar_blocks_series_idx').on(t.seriesId),
  ],
)

// Recurring weekly class definition. Recurrence lives ABOVE the canonical
// availability spine: a series is expanded by the materializer into concrete
// `calendar_blocks` instances (type='class', seriesId set), and the booking
// engine / availability compute keep operating on those instances unchanged.
// Mirrors Google's master + materialized-instances + EXDATE model.
// See CALENDAR_UX_DESIGN.md §8 (recurrence) and PLAN Track 1A.
export const classSeries = pgTable(
  'class_series',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    serviceTypeId: uuid('service_type_id')
      .notNull()
      .references(() => serviceTypes.id),
    // Optional instructor scoping for the whole series.
    providerId: uuid('provider_id').references(() => identities.id),
    dayOfWeek: integer('day_of_week').notNull(), // 0=Sun … 6=Sat (business-local)
    startTime: time('start_time').notNull(), // 'HH:MM' business-local wall clock
    durationMinutes: integer('duration_minutes').notNull(),
    maxParticipants: integer('max_participants').notNull().default(1),
    title: text('title'),
    startDate: date('start_date').notNull(), // first eligible local date (YYYY-MM-DD)
    endDate: date('end_date'), // null = open-ended
    // Timezone snapshot at creation — each weekly instance is resolved at this
    // local clock time via localTimeToUtc(), so a 10:00 class stays 10:00 local
    // across DST regardless of later business-timezone edits.
    timezone: text('timezone').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('class_series_business_idx').on(t.businessId, t.isActive),
    check('class_series_day_of_week_range', sql`${t.dayOfWeek} BETWEEN 0 AND 6`),
  ],
)

// EXDATE-style exceptions: a single occurrence of a series that was cancelled or
// detached. The materializer never (re)creates an instance for an excepted date.
export const classSeriesExceptions = pgTable(
  'class_series_exceptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seriesId: uuid('series_id')
      .notNull()
      .references(() => classSeries.id),
    occurrenceDate: date('occurrence_date').notNull(), // business-local YYYY-MM-DD
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('class_series_exceptions_series_date_idx').on(t.seriesId, t.occurrenceDate)],
)

export const conversationSessions = pgTable(
  'conversation_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    identityId: uuid('identity_id')
      .notNull()
      .references(() => identities.id),
    intent: text('intent', {
      enum: ['booking', 'rescheduling', 'cancellation', 'inquiry', 'list_bookings', 'manager_instruction', 'unknown'],
    }),
    state: text('state', {
      enum: ['active', 'waiting_confirmation', 'waiting_clarification', 'completed', 'expired', 'failed'],
    }).notNull(),
    context: jsonb('context').notNull().default({}),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('sessions_identity_state_idx').on(t.identityId, t.state)],
)

export const managerInstructions = pgTable('manager_instructions', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id')
    .notNull()
    .references(() => businesses.id),
  identityId: uuid('identity_id')
    .notNull()
    .references(() => identities.id),
  rawMessage: text('raw_message').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
  classifiedAs: text('classified_as', {
    enum: ['availability_change', 'policy_change', 'service_change', 'permission_change', 'booking_cancellation', 'recurring_class_change', 'provider_change', 'unknown'],
  }),
  structuredOutput: jsonb('structured_output'),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  applyStatus: text('apply_status', {
    enum: ['pending', 'applied', 'failed', 'requires_clarification'],
  })
    .notNull()
    .default('pending'),
  clarificationRequest: text('clarification_request'),
})

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    actorId: uuid('actor_id').references(() => identities.id),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    beforeState: jsonb('before_state'),
    afterState: jsonb('after_state'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_entity_idx').on(t.entityType, t.entityId)],
)

export const customerProfiles = pgTable('customer_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id')
    .notNull()
    .references(() => businesses.id),
  identityId: uuid('identity_id')
    .notNull()
    .references(() => identities.id)
    .unique(),
  displayName: text('display_name'),
  preferredServiceTypeId: uuid('preferred_service_type_id').references(() => serviceTypes.id),
  lastBookingId: uuid('last_booking_id'),
  lastBookingAt: timestamp('last_booking_at', { withTimezone: true }),
  totalBookings: integer('total_bookings').notNull().default(0),
  notes: text('notes'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const processedMessages = pgTable('processed_messages', {
  messageId: text('message_id').primaryKey(),
  businessId: uuid('business_id')
    .notNull()
    .references(() => businesses.id),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
})

export const conversationMessages = pgTable(
  'conversation_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => conversationSessions.id),
    role: text('role', { enum: ['customer', 'assistant'] }).notNull(),
    text: text('text').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('messages_session_idx').on(t.sessionId, t.createdAt)],
)

export const reminders = pgTable(
  'reminders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id),
    triggerType: text('trigger_type', { enum: ['24h', '1h', 'confirmation', 'cancellation'] }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('reminders_booking_trigger_idx').on(t.bookingId, t.triggerType)],
)

export const waitlist = pgTable(
  'waitlist',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    serviceTypeId: uuid('service_type_id')
      .notNull()
      .references(() => serviceTypes.id),
    slotStart: timestamp('slot_start', { withTimezone: true }).notNull(),
    slotEnd: timestamp('slot_end', { withTimezone: true }).notNull(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => identities.id),
    status: text('status', { enum: ['pending', 'offered', 'accepted', 'expired'] }).notNull().default('pending'),
    offeredAt: timestamp('offered_at', { withTimezone: true }),
    offerExpiresAt: timestamp('offer_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('waitlist_slot_customer_idx').on(t.businessId, t.slotStart, t.customerId),
    index('waitlist_status_idx').on(t.businessId, t.status),
  ],
)

// One per freed slot that is waiting on owner approval before the waitlist offer goes
// out (WS-C / #6 / #8). Created only when a cancel frees a slot, someone is waiting, and
// the business policy is 'ask' (or unset). The owner approves/declines via Branch 3; an
// approved row triggers the normal waitlist cascade. `candidateCount` is a snapshot for
// the owner prompt. Expires if undecided so a stale request can't fire days later.
export const freedSlotApprovals = pgTable(
  'freed_slot_approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull().references(() => businesses.id),
    serviceTypeId: uuid('service_type_id').notNull().references(() => serviceTypes.id),
    slotStart: timestamp('slot_start', { withTimezone: true }).notNull(),
    slotEnd: timestamp('slot_end', { withTimezone: true }).notNull(),
    // The cancelled booking that freed this slot (provenance / dedup).
    sourceBookingId: uuid('source_booking_id').references(() => bookings.id),
    candidateCount: integer('candidate_count').notNull().default(0),
    status: text('status', { enum: ['pending', 'approved', 'declined', 'expired'] }).notNull().default('pending'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('freed_slot_approvals_pending_idx').on(t.businessId, t.status),
    index('freed_slot_approvals_slot_idx').on(t.businessId, t.slotStart),
  ],
)

// ── Proactive Reshuffle Engine ────────────────────────────────────────────────
// See docs/superpowers/plans/2026-06-18-proactive-reshuffle-engine.md

/** One per reschedule request the engine takes on. */
export const reshuffleCampaigns = pgTable(
  'reshuffle_campaigns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull().references(() => businesses.id),
    requesterId: uuid('requester_id').notNull().references(() => identities.id),
    requesterBookingId: uuid('requester_booking_id').notNull().references(() => bookings.id),
    serviceTypeId: uuid('service_type_id').notNull().references(() => serviceTypes.id),
    targetSlotStart: timestamp('target_slot_start', { withTimezone: true }).notNull(),
    targetSlotEnd: timestamp('target_slot_end', { withTimezone: true }).notNull(),
    status: text('status', {
      enum: ['searching', 'solution_pending_approval', 'applying', 'applied', 'failed', 'abandoned'],
    }).notNull().default('searching'),
    strategy: text('strategy', { enum: ['direct', 'chain', 'broadcast'] }),
    outreachCount: integer('outreach_count').notNull().default(0),
    // The reshuffleConfig in force at start, so mid-flight config edits don't corrupt a solve.
    configSnapshot: jsonb('config_snapshot').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [index('reshuffle_campaigns_status_idx').on(t.businessId, t.status)],
)

/** One per "we asked customer X whether they'll take slot Y". Mirrors the waitlist offer lifecycle. */
export const reshuffleOffers = pgTable(
  'reshuffle_offers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id').notNull().references(() => reshuffleCampaigns.id),
    customerId: uuid('customer_id').notNull().references(() => identities.id),
    bookingId: uuid('booking_id').references(() => bookings.id),
    proposedSlotStart: timestamp('proposed_slot_start', { withTimezone: true }).notNull(),
    proposedSlotEnd: timestamp('proposed_slot_end', { withTimezone: true }).notNull(),
    status: text('status', {
      enum: ['probing', 'accepted', 'declined', 'countered', 'expired'],
    }).notNull().default('probing'),
    counterSlotStart: timestamp('counter_slot_start', { withTimezone: true }),
    counterSlotEnd: timestamp('counter_slot_end', { withTimezone: true }),
    offeredAt: timestamp('offered_at', { withTimezone: true }).notNull().defaultNow(),
    offerExpiresAt: timestamp('offer_expires_at', { withTimezone: true }),
  },
  (t) => [index('reshuffle_offers_campaign_idx').on(t.campaignId, t.status)],
)

/** The assembled solution presented to the owner (the approval gate's persisted state). */
export const reshuffleProposals = pgTable(
  'reshuffle_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campaignId: uuid('campaign_id').notNull().references(() => reshuffleCampaigns.id),
    // Ordered moves: [{ bookingId, customerId, fromSlot, toSlot }]
    moves: jsonb('moves').notNull(),
    touchedCount: integer('touched_count').notNull(),
    kind: text('kind', { enum: ['exact', 'better_offer'] }).notNull().default('exact'),
    status: text('status', {
      enum: ['pending', 'amended', 'rejected', 'approved', 'expired', 'applied'],
    }).notNull().default('pending'),
    amendedFromId: uuid('amended_from_id'),
    presentedToOwnerAt: timestamp('presented_to_owner_at', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => [index('reshuffle_proposals_campaign_idx').on(t.campaignId, t.status)],
)

export const providerOnboardingSessions = pgTable('provider_onboarding_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  managerPhone: text('manager_phone').notNull().unique(),
  step: text('step', {
    enum: ['business_name', 'timezone', 'calendar', 'services', 'waba_check', 'waba_guide', 'credentials'],
  }).notNull().default('business_name'),
  collectedData: jsonb('collected_data').notNull().default({}),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const importTokens = pgTable('import_tokens', {
  token: uuid('token').primaryKey().defaultRandom(),
  businessId: uuid('business_id')
    .notNull()
    .references(() => businesses.id),
  managerPhone: text('manager_phone').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// Tasks escalated to the operator (us) when a customer asks something no PA handles
export const escalatedTasks = pgTable(
  'escalated_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    customerPhone: text('customer_phone').notNull(),
    messageBody: text('message_body').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    // 'platform' = unknown intent after threshold; 'owner_rule' = matched owner-defined trigger
    escalationType: text('escalation_type', { enum: ['platform', 'owner_rule'] }).notNull(),
    triggerRule: text('trigger_rule'),
    forwardedAt: timestamp('forwarded_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('escalated_tasks_business_idx').on(t.businessId, t.resolvedAt),
  ],
)

// Log of operator-triggered bulk updates pushed to all agents
export const agentUpdateLog = pgTable('agent_update_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  triggeredAt: timestamp('triggered_at', { withTimezone: true }).notNull().defaultNow(),
  updateType: text('update_type').notNull(),
  payload: jsonb('payload').notNull(),
  appliedToCount: integer('applied_to_count').notNull().default(0),
})

export const businessFaqs = pgTable('business_faqs', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id')
    .notNull()
    .references(() => businesses.id),
  question: text('question').notNull(),
  answer: text('answer').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const skillWorkflows = pgTable(
  'skill_workflows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    identityId: uuid('identity_id')
      .notNull()
      .references(() => identities.id),
    skillName: text('skill_name').notNull(),
    step: text('step').notNull(),
    state: jsonb('state').notNull().default({}),
    status: text('status', { enum: ['active', 'paused', 'completed', 'failed'] }).notNull(),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Partial unique index: one active workflow per identity per skill
    index('idx_skill_workflows_active').on(t.identityId, t.skillName).where(sql`${t.status} = 'active'`),
  ],
)

export const deferredFeatureRequests = pgTable('deferred_feature_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id')
    .notNull()
    .references(() => businesses.id),
  rawText: text('raw_text').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const workflowStepLogs = pgTable('workflow_step_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  workflowId: uuid('workflow_id')
    .notNull()
    .references(() => skillWorkflows.id),
  stepName: text('step_name').notNull(),
  status: text('status', { enum: ['SUCCESS', 'RETRYABLE', 'FATAL', 'PAUSED'] }).notNull(),
  inputSnapshot: jsonb('input_snapshot'),
  outputSnapshot: jsonb('output_snapshot'),
  latencyMs: integer('latency_ms'),
  retryCount: integer('retry_count').notNull().default(0),
  errorContext: jsonb('error_context'),
  tokensUsed: integer('tokens_used'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// Cross-session manager conversation summaries (used by orchestrator system prompt)
export const managerMemory = pgTable(
  'manager_memory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull().references(() => businesses.id),
    identityId: uuid('identity_id').notNull().references(() => identities.id),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    summary: text('summary').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('manager_memory_identity_idx').on(t.identityId, t.createdAt)],
)

// Cross-session customer conversation summaries (Branch 4 memory). Distinct from
// customer_profiles (booking-derived facts): these capture what was DISCUSSED so
// the PA can pick up across visits, mirroring manager_memory.
export const customerSessionNotes = pgTable(
  'customer_session_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull().references(() => businesses.id),
    identityId: uuid('identity_id').notNull().references(() => identities.id),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    summary: text('summary').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('customer_session_notes_identity_idx').on(t.identityId, t.createdAt)],
)

// Non-customer contacts: suppliers, partners, staff
export const businessContacts = pgTable(
  'business_contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull().references(() => businesses.id),
    name: text('name').notNull(),
    phoneNumber: text('phone_number'),
    email: text('email'),
    role: text('role'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('business_contacts_business_idx').on(t.businessId)],
)

// Cross-session operator notes for Branch 1 memory
export const operatorSessionNotes = pgTable(
  'operator_session_notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    summary: text('summary').notNull(),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
)

// Per-business Google Calendar watch-channel + incremental-sync state (Phase 3,
// inbound sync). One row per business in connected mode. The watch channel is a
// push subscription that Google renews-by-expiry; syncToken drives incremental
// events.list with a periodic full-reconcile fallback when it is null/expired.
// See CALENDAR_UX_DESIGN.md §6 Phase 3.
export const calendarSyncChannels = pgTable(
  'calendar_sync_channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id)
      .unique(),
    calendarId: text('calendar_id').notNull(),
    // The channel UUID we generate and Google echoes back in X-Goog-Channel-ID.
    channelId: text('channel_id'),
    // Google-assigned opaque resource id (X-Goog-Resource-ID) for the watched calendar.
    resourceId: text('resource_id'),
    // Shared secret echoed in X-Goog-Channel-Token — authenticates inbound pushes.
    channelToken: text('channel_token'),
    // When the current watch channel lapses; the renewal cron re-registers before this.
    channelExpiration: timestamp('channel_expiration', { withTimezone: true }),
    // Incremental sync cursor from events.list; null ⇒ next run does a full reconcile.
    syncToken: text('sync_token'),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    status: text('status', { enum: ['active', 'expired', 'error'] }).notNull().default('active'),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('calendar_sync_channels_channel_idx').on(t.channelId),
    index('calendar_sync_channels_resource_idx').on(t.resourceId),
  ],
)

// ── Type exports ──────────────────────────────────────────────────────────────

export type Business = typeof businesses.$inferSelect
export type Identity = typeof identities.$inferSelect
export type ServiceType = typeof serviceTypes.$inferSelect
export type ServicePriceTier = typeof servicePriceTiers.$inferSelect
export type BusinessApiKey = typeof businessApiKeys.$inferSelect
export type Availability = typeof availability.$inferSelect
export type ProviderAssignment = typeof providerAssignments.$inferSelect
export type DelegatedPermission = typeof delegatedPermissions.$inferSelect
export type Booking = typeof bookings.$inferSelect
export type CalendarBlock = typeof calendarBlocks.$inferSelect
export type CalendarBlockType = CalendarBlock['type']
export type ClassSeries = typeof classSeries.$inferSelect
export type ClassSeriesException = typeof classSeriesExceptions.$inferSelect
export type ConversationSession = typeof conversationSessions.$inferSelect
export type ManagerInstruction = typeof managerInstructions.$inferSelect
export type AuditLogEntry = typeof auditLog.$inferSelect
export type CustomerProfile = typeof customerProfiles.$inferSelect
export type ConversationMessage = typeof conversationMessages.$inferSelect
export type Reminder = typeof reminders.$inferSelect
export type WaitlistEntry = typeof waitlist.$inferSelect
export type ImportToken = typeof importTokens.$inferSelect
export type ProviderOnboardingSession = typeof providerOnboardingSessions.$inferSelect
export type EscalatedTask = typeof escalatedTasks.$inferSelect
export type AgentUpdateLog = typeof agentUpdateLog.$inferSelect
export type BusinessFaq = typeof businessFaqs.$inferSelect
export type SkillWorkflow = typeof skillWorkflows.$inferSelect
export type WorkflowStepLog = typeof workflowStepLogs.$inferSelect
export type DeferredFeatureRequest = typeof deferredFeatureRequests.$inferSelect
export type ManagerMemory = typeof managerMemory.$inferSelect
export type CustomerSessionNote = typeof customerSessionNotes.$inferSelect
export type BusinessContact = typeof businessContacts.$inferSelect
export type OperatorSessionNote = typeof operatorSessionNotes.$inferSelect
export type CalendarSyncChannel = typeof calendarSyncChannels.$inferSelect
export type ReshuffleCampaign = typeof reshuffleCampaigns.$inferSelect
export type ReshuffleOffer = typeof reshuffleOffers.$inferSelect
export type ReshuffleProposal = typeof reshuffleProposals.$inferSelect
export type FreedSlotApproval = typeof freedSlotApprovals.$inferSelect

export type BookingState = Booking['state']
export type IdentityRole = Identity['role']
export type SessionState = ConversationSession['state']
export type SessionIntent = ConversationSession['intent']
export type PaymentStatus = Booking['paymentStatus']
export type InstructionType = ManagerInstruction['classifiedAs']
export type ApplyStatus = ManagerInstruction['applyStatus']
export type BotPersona = Business['botPersona']
export type OnboardingStep = NonNullable<Business['onboardingStep']>
export type ConfirmationGate = Business['confirmationGate']
export type CalendarMode = Business['calendarMode']

export type EscalationRule = {
  trigger: 'keyword' | 'unknown_intent' | 'emotional'
  value?: string
  threshold?: number
  customerMessage: 'silent' | 'passed_to_owner' | 'owner_callback' | 'custom'
  customText?: string
}
