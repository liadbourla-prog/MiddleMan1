import crypto from 'crypto'
import type { FastifyInstance } from 'fastify'
import { eq, and, desc } from 'drizzle-orm'
import { db } from '../db/client.js'
import { businesses, conversationSessions, bookings, auditLog, identities } from '../db/schema.js'
import { replyCapture } from '../adapters/whatsapp/sender.js'
import { processInboundMessage } from './webhook.js'
import type { InboundMessage } from '../adapters/whatsapp/types.js'

interface SimRequest {
  fromNumber: string
  toNumber: string
  body: string
}

export interface SimResponse {
  replies: string[]
  sessionState: string | null
  sessionContext: Record<string, unknown>
  bookingState: string | null
  bookingId: string | null
  auditEntries: Array<{ action: string; entityType: string; afterState: unknown }>
}

export async function simulateRoutes(app: FastifyInstance) {
  app.post<{ Body: SimRequest }>('/simulate', async (request, reply) => {
    const { fromNumber, toNumber, body } = request.body

    const msg: InboundMessage = {
      messageId: `sim-${crypto.randomUUID()}`,
      fromNumber,
      toNumber,
      body,
      timestamp: new Date(),
      rawPayload: null,
    }

    const captured: string[] = []
    await replyCapture.run(captured, () => processInboundMessage(msg, app))

    const [business] = await db
      .select({ id: businesses.id })
      .from(businesses)
      .where(eq(businesses.whatsappNumber, toNumber))
      .limit(1)

    let sessionState: string | null = null
    let sessionContext: Record<string, unknown> = {}
    let bookingState: string | null = null
    let bookingId: string | null = null
    let auditEntries: SimResponse['auditEntries'] = []

    if (business) {
      const [identity] = await db
        .select({ id: identities.id })
        .from(identities)
        .where(and(eq(identities.businessId, business.id), eq(identities.phoneNumber, fromNumber)))
        .limit(1)

      if (identity) {
        const [session] = await db
          .select({ state: conversationSessions.state, context: conversationSessions.context })
          .from(conversationSessions)
          .where(eq(conversationSessions.identityId, identity.id))
          .orderBy(desc(conversationSessions.createdAt))
          .limit(1)

        if (session) {
          sessionState = session.state
          sessionContext = (session.context as Record<string, unknown>) ?? {}
        }

        const [booking] = await db
          .select({ id: bookings.id, state: bookings.state })
          .from(bookings)
          .where(and(eq(bookings.businessId, business.id), eq(bookings.customerId, identity.id)))
          .orderBy(desc(bookings.createdAt))
          .limit(1)

        if (booking) {
          bookingState = booking.state
          bookingId = booking.id
        }
      }

      const recent = await db
        .select({ action: auditLog.action, entityType: auditLog.entityType, afterState: auditLog.afterState })
        .from(auditLog)
        .where(eq(auditLog.businessId, business.id))
        .orderBy(desc(auditLog.createdAt))
        .limit(10)

      auditEntries = recent
    }

    return reply.send({ replies: captured, sessionState, sessionContext, bookingState, bookingId, auditEntries })
  })
}
