import { eq, and, lt } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import type { Business } from '../../db/schema.js'
import {
  bookings,
  serviceTypes,
  businessFaqs,
  businesses as businessesTable,
  deferredFeatureRequests,
} from '../../db/schema.js'
import type { ResolvedIdentity } from '../identity/types.js'
import { sendMessage } from '../../adapters/whatsapp/sender.js'
// We only need the id from the session, so accept the minimal shape
type SessionLike = { id: string } | null
import type {
  SkillContext,
  SkillConversationTurn,
  BusinessKnowledge,
  WorkflowState,
  CompletedBookingSummary,
  CustomerSummary,
  SegmentFilter,
  CommunicationStyle,
  NotificationPreferences,
  HandoffBehavior,
  AutomatedMessagesConfig,
  BookingEdgeCases,
  ProposeInitiationInput,
} from '../../shared/skill-types.js'
import { queryCustomerSegment } from '../crm/segment-repository.js'
import { proposeInitiation as proposeInitiationCore } from '../initiations/approvals.js'
import {
  advanceWorkflow,
  completeWorkflow,
  failWorkflow,
  createWorkflow,
} from './workflow-helpers.js'

export async function buildSkillContext(params: {
  db: Db
  business: Business
  identity: ResolvedIdentity
  session: SessionLike
  messageText: string
  conversationHistory: SkillConversationTurn[]
  language: 'he' | 'en'
  workflowState: WorkflowState | null
  businessKnowledge: BusinessKnowledge
  managerPhone?: string
  waCredentials?: { accessToken: string; phoneNumberId: string }
  managerMemorySummaries?: string[]
  imageUrl?: string | null
  imageMediaType?: string | null
}): Promise<SkillContext> {
  const {
    db: dbInst, business, identity, session, messageText,
    conversationHistory, language, workflowState, businessKnowledge,
    managerPhone, waCredentials, managerMemorySummaries,
    imageUrl, imageMediaType,
  } = params

  const recentCompletedBooking = await loadRecentCompletedBooking(dbInst, identity.id)

  const workflowId = workflowState?.id ?? null
  // Mutable — incremented after each advance() so double-advance in one request uses correct version
  let workflowVersion = workflowState?.version ?? 1

  return {
    business: {
      id: business.id,
      name: business.name,
      timezone: business.timezone,
      defaultLanguage: business.defaultLanguage as 'he' | 'en',
      botPersona: business.botPersona as 'female' | 'male' | 'neutral',
      currency: business.currency,
    },
    caller: {
      id: identity.id,
      phoneNumber: identity.phoneNumber,
      role: identity.role as 'manager' | 'delegated_user' | 'customer',
      displayName: identity.displayName,
      preferredLanguage: null,
    },
    message: {
      text: messageText,
      receivedAt: new Date(),
      imageUrl: imageUrl ?? null,
      imageMediaType: imageMediaType ?? null,
    },
    conversationHistory,
    language,
    sessionId: session?.id ?? '',
    businessKnowledge,
    workflowState,
    workflow: {
      async advance(step: string, state: Record<string, unknown>) {
        if (!workflowId) throw new Error('No active workflow to advance')
        await advanceWorkflow(dbInst, workflowId, step, state, workflowVersion)
        workflowVersion++ // keep local version in sync for subsequent calls in same request
      },
      async complete() {
        if (!workflowId) throw new Error('No active workflow to complete')
        await completeWorkflow(dbInst, workflowId)
      },
      async fail(error: { code: string; message: string; recoverable: boolean }) {
        if (!workflowId) throw new Error('No active workflow to fail')
        await failWorkflow(dbInst, workflowId, error, managerPhone ?? identity.phoneNumber, waCredentials)
      },
      async create(skillName: string, firstStep: string, initialState: Record<string, unknown> = {}) {
        return createWorkflow(dbInst, business.id, identity.id, skillName, firstStep, initialState)
      },
    },
    recentCompletedBooking,
    ...(managerMemorySummaries ? { managerMemorySummaries } : {}),
    customerSegmentQuery: async (filter: SegmentFilter): Promise<CustomerSummary[]> => {
      if (identity.role !== 'manager') return []
      return queryCustomerSegment(dbInst, business.id, filter, business.timezone)
    },
    proposeInitiation: async (input: ProposeInitiationInput) =>
      proposeInitiationCore(dbInst, {
        businessId: business.id,
        initiatorId: input.initiatorId,
        recipientId: input.recipientId,
        recipientPhone: input.recipientPhone,
        dedupKey: input.dedupKey,
        language: input.language ?? language,
        situation: input.situation,
        fallback: input.fallback,
        ownerSummary: input.ownerSummary,
      }),
    saveFAQs: async (faqs: Array<{ question: string; answer: string }>) => {
      if (identity.role !== 'manager') return
      await dbInst.delete(businessFaqs).where(eq(businessFaqs.businessId, business.id))
      if (faqs.length > 0) {
        await dbInst.insert(businessFaqs).values(
          faqs.map((f) => ({ businessId: business.id, question: f.question, answer: f.answer }))
        )
      }
    },
    saveServiceNarrative: async (serviceTypeId: string, narrative: string) => {
      if (identity.role !== 'manager') return
      await dbInst
        .update(serviceTypes)
        .set({ narrative })
        .where(and(eq(serviceTypes.id, serviceTypeId), eq(serviceTypes.businessId, business.id)))
    },
    saveBrandVoice: async (brandVoice: string) => {
      if (identity.role !== 'manager') return
      await dbInst.update(businessesTable).set({ brandVoice }).where(eq(businessesTable.id, business.id))
    },
    saveCommunicationStyle: async (style: CommunicationStyle) => {
      if (identity.role !== 'manager') return
      await dbInst.update(businessesTable)
        .set({ communicationStyle: style as unknown as Record<string, unknown> })
        .where(eq(businessesTable.id, business.id))
    },
    saveNotificationPreferences: async (prefs: NotificationPreferences) => {
      if (identity.role !== 'manager') return
      await dbInst.update(businessesTable)
        .set({ notificationPreferences: prefs as unknown as Record<string, unknown> })
        .where(eq(businessesTable.id, business.id))
    },
    saveHandoffBehavior: async (behavior: HandoffBehavior) => {
      if (identity.role !== 'manager') return
      await dbInst.update(businessesTable)
        .set({ handoffBehavior: behavior as unknown as Record<string, unknown> })
        .where(eq(businessesTable.id, business.id))
    },
    saveAutomatedMessagesConfig: async (config: AutomatedMessagesConfig) => {
      if (identity.role !== 'manager') return
      await dbInst.update(businessesTable)
        .set({ automatedMessagesConfig: config as unknown as Record<string, unknown> })
        .where(eq(businessesTable.id, business.id))
    },
    saveBookingEdgeCases: async (cases: BookingEdgeCases) => {
      if (identity.role !== 'manager') return
      await dbInst.update(businessesTable)
        .set({ bookingEdgeCases: cases as unknown as Record<string, unknown> })
        .where(eq(businessesTable.id, business.id))
    },
    saveServiceIntakeNotes: async (serviceTypeId: string, notes: string) => {
      if (identity.role !== 'manager') return
      await dbInst
        .update(serviceTypes)
        .set({ intakeNotes: notes })
        .where(and(eq(serviceTypes.id, serviceTypeId), eq(serviceTypes.businessId, business.id)))
    },
    saveCancellationFee: async (amount: number | null, currency: string) => {
      if (identity.role !== 'manager') return
      await dbInst.update(businessesTable)
        .set({
          cancellationFeeAmount: amount !== null ? String(amount) : null,
          cancellationFeeCurrency: currency,
        })
        .where(eq(businessesTable.id, business.id))
    },
    saveCancellationCutoffMinutes: async (minutes: number) => {
      if (identity.role !== 'manager') return
      await dbInst.update(businessesTable)
        .set({ cancellationCutoffMinutes: minutes })
        .where(eq(businessesTable.id, business.id))
    },
    deferFeatureRequest: async (text: string) => {
      if (identity.role !== 'manager') return
      await dbInst.insert(deferredFeatureRequests).values({ businessId: business.id, rawText: text })
      const operatorPhone = process.env['OPERATOR_PHONE']
      if (operatorPhone) {
        const alert = `🔔 Feature request from *${business.name}* (${identity.phoneNumber}):\n"${text}"`
        await sendMessage({ toNumber: operatorPhone, body: alert }, waCredentials).catch(() => {
          // Operator notification failure must not block the skill response
        })
      }
    },
    saveWebsiteConfig: async (schema: Record<string, unknown>, previewUrl: string) => {
      if (identity.role !== 'manager') return
      await dbInst.update(businessesTable)
        .set({ websiteJson: schema, websitePreviewUrl: previewUrl })
        .where(eq(businessesTable.id, business.id))
    },
    requestGmbOAuth: async () => {
      const baseUrl = process.env['PUBLIC_BASE_URL'] ?? 'https://your-domain.com'
      const state = encodeURIComponent(JSON.stringify({ businessId: business.id, purpose: 'gmb' }))
      const scopes = encodeURIComponent('https://www.googleapis.com/auth/business.manage')
      const clientId = process.env['GOOGLE_CLIENT_ID'] ?? ''
      const redirectUri = encodeURIComponent(`${baseUrl}/oauth/google/callback`)
      return `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${redirectUri}&response_type=code&scope=${scopes}&access_type=offline&prompt=consent&state=${state}`
    },
    requestGmbVerification: async (locationId: string, method: 'POSTCARD' | 'PHONE_CALL') => {
      if (identity.role !== 'manager') return
      const { createGmbClient } = await import('../../adapters/gmb/client.js')
      const gmbRefreshToken = business.gmbRefreshToken
      if (!gmbRefreshToken) throw new Error('No GMB refresh token available')
      const gmbClient = createGmbClient(gmbRefreshToken)
      await gmbClient.requestVerification(locationId, method)
    },
    saveGmbLocation: async (locationId: string, profileUrl: string) => {
      if (identity.role !== 'manager') return
      await dbInst.update(businessesTable)
        .set({ gmbLocationId: locationId, googleBusinessProfileUrl: profileUrl })
        .where(eq(businessesTable.id, business.id))
    },
    createGmbListing: async (params) => {
      if (identity.role !== 'manager') throw new Error('Manager only')
      const { createGmbClient } = await import('../../adapters/gmb/client.js')
      const gmbRefreshToken = business.gmbRefreshToken
      if (!gmbRefreshToken) throw new Error('No GMB refresh token available')
      const gmbClient = createGmbClient(gmbRefreshToken)
      const accounts = await gmbClient.listAccounts()
      if (accounts.length === 0) throw new Error('No GMB accounts found')
      const accountId = accounts[0]!.accountId
      const result = await gmbClient.createLocation(accountId, params)
      await dbInst.update(businessesTable)
        .set({ gmbLocationId: result.locationId, googleBusinessProfileUrl: result.profileUrl })
        .where(eq(businessesTable.id, business.id))
      return result
    },
  }
}

async function loadRecentCompletedBooking(db: Db, identityId: string): Promise<CompletedBookingSummary | null> {
  const now = new Date()
  const [row] = await db
    .select({
      bookingId: bookings.id,
      serviceName: serviceTypes.name,
      slotStart: bookings.slotStart,
    })
    .from(bookings)
    .innerJoin(serviceTypes, eq(bookings.serviceTypeId, serviceTypes.id))
    .where(and(eq(bookings.customerId, identityId), eq(bookings.state, 'confirmed'), lt(bookings.slotEnd, now)))
    .orderBy(bookings.slotEnd)
    .limit(1)

  if (!row) return null
  return {
    bookingId: row.bookingId,
    serviceName: row.serviceName,
    slotStart: row.slotStart,
    customerName: null,
  }
}

