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
  googleCalendarId: text('google_calendar_id').notNull(),
  googleRefreshToken: text('google_refresh_token'),
  timezone: text('timezone').notNull().default('UTC'),
  minBookingBufferMinutes: integer('min_booking_buffer_minutes').notNull().default(30),
  maxBookingDaysAhead: integer('max_booking_days_ahead').notNull().default(365),
  cancellationCutoffMinutes: integer('cancellation_cutoff_minutes').notNull().default(0),
  currency: text('currency').notNull().default('ILS'),
  botPersona: text('bot_persona', { enum: ['female', 'male', 'neutral'] }).notNull().default('neutral'),
  onboardingStep: text('onboarding_step', {
    enum: ['business_name', 'services', 'hours', 'calendar', 'customer_import', 'verify'],
  }).default('business_name'),
  onboardingCompletedAt: timestamp('onboarding_completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const identities = pgTable(
  'identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.id),
    phoneNumber: text('phone_number').notNull(),
    role: text('role', { enum: ['manager', 'delegated_user', 'customer'] }).notNull(),
    displayName: text('display_name'),
    grantedBy: uuid('granted_by'),
    grantedAt: timestamp('granted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    messagingOptOut: boolean('messaging_opt_out').notNull().default(false),
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
  isActive: boolean('is_active').notNull().default(true),
  deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

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
      enum: ['inquiry', 'requested', 'held', 'pending_payment', 'confirmed', 'cancelled', 'expired', 'failed'],
    }).notNull(),
    holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
    calendarEventId: text('calendar_event_id'),
    paymentStatus: text('payment_status', {
      enum: ['not_required', 'pending', 'paid', 'failed'],
    })
      .notNull()
      .default('not_required'),
    cancellationReason: text('cancellation_reason'),
    cancelledByRole: text('cancelled_by_role', { enum: ['customer', 'manager', 'system'] }),
    slotTzAtCreation: text('slot_tz_at_creation'),
    rescheduledFrom: uuid('rescheduled_from'),
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
    enum: ['availability_change', 'policy_change', 'service_change', 'permission_change', 'unknown'],
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

export const providerOnboardingSessions = pgTable('provider_onboarding_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  managerPhone: text('manager_phone').notNull().unique(),
  step: text('step', {
    enum: ['business_name', 'timezone', 'calendar', 'credentials'],
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

export type Business = typeof businesses.$inferSelect
export type Identity = typeof identities.$inferSelect
export type ServiceType = typeof serviceTypes.$inferSelect
export type Availability = typeof availability.$inferSelect
export type Booking = typeof bookings.$inferSelect
export type ConversationSession = typeof conversationSessions.$inferSelect
export type ManagerInstruction = typeof managerInstructions.$inferSelect
export type AuditLogEntry = typeof auditLog.$inferSelect
export type CustomerProfile = typeof customerProfiles.$inferSelect
export type ConversationMessage = typeof conversationMessages.$inferSelect

export type Reminder = typeof reminders.$inferSelect
export type WaitlistEntry = typeof waitlist.$inferSelect
export type ImportToken = typeof importTokens.$inferSelect
export type ProviderOnboardingSession = typeof providerOnboardingSessions.$inferSelect

export type BookingState = Booking['state']
export type IdentityRole = Identity['role']
export type SessionState = ConversationSession['state']
export type SessionIntent = ConversationSession['intent']
export type PaymentStatus = Booking['paymentStatus']
export type InstructionType = ManagerInstruction['classifiedAs']
export type ApplyStatus = ManagerInstruction['applyStatus']
export type BotPersona = Business['botPersona']
export type OnboardingStep = NonNullable<Business['onboardingStep']>
