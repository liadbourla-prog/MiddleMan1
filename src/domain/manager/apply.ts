import { eq, and, or, lte, gte, gt, lt, ne, count, desc } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../../db/client.js'
import { availability, serviceTypes, identities, managerInstructions, bookings, businesses, processedMessages } from '../../db/schema.js'
import { logAudit } from '../audit/logger.js'
import { enqueueMessage } from '../../workers/message-retry.js'

function isValidIANATimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

export type ApplyResult = { ok: true; confirmationMessage: string } | { ok: false; reason: string }

// ── Per-type param schemas ────────────────────────────────────────────────────

const TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/

const availabilityChangeSchema = z.object({
  action: z.enum(['set_hours', 'block', 'unblock', 'bulk_close']),
  dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
  specificDate: z.string().nullable().optional(),
  dateRangeStart: z.string().nullable().optional(),
  dateRangeEnd: z.string().nullable().optional(),
  openTime: z.string().regex(TIME_REGEX, 'openTime must be HH:MM').nullable().optional(),
  closeTime: z.string().regex(TIME_REGEX, 'closeTime must be HH:MM').nullable().optional(),
  reason: z.string().nullable().optional(),
  timezone: z.string().optional(),
})

const serviceChangeSchema = z.object({
  action: z.enum(['create', 'update', 'deactivate']),
  name: z.string(),
  durationMinutes: z.number().int().positive().optional(),
  bufferMinutes: z.number().int().min(0).optional(),
  paymentAmount: z.number().nonnegative().nullable().optional(),
  requiresPayment: z.boolean().nullable().optional(),
  category: z.string().nullable().optional(),
  maxParticipants: z.number().int().positive().nullable().optional(),
})

const permissionChangeSchema = z.object({
  action: z.enum(['grant', 'revoke']),
  phoneNumber: z.string(),
  displayName: z.string().optional(),
})

// ── Entry point ───────────────────────────────────────────────────────────────

export async function applyInstruction(
  db: Db,
  instructionId: string,
  businessId: string,
  actorId: string,
  instructionType: string,
  structuredParams: Record<string, unknown>,
): Promise<ApplyResult> {
  let result: ApplyResult

  switch (instructionType) {
    case 'availability_change':
      result = await applyAvailabilityChange(db, businessId, actorId, structuredParams)
      break
    case 'service_change':
      result = await applyServiceChange(db, businessId, actorId, structuredParams)
      break
    case 'permission_change':
      result = await applyPermissionChange(db, businessId, actorId, structuredParams)
      break
    case 'policy_change':
      // Policy changes are stored in structured_output; no table mutation in V1
      result = { ok: true, confirmationMessage: 'Policy instruction noted and saved.' }
      break
    default:
      result = { ok: false, reason: `Unknown instruction type: ${instructionType}` }
  }

  const now = new Date()
  await db
    .update(managerInstructions)
    .set({
      applyStatus: result.ok ? 'applied' : 'failed',
      appliedAt: result.ok ? now : null,
    })
    .where(eq(managerInstructions.id, instructionId))

  await logAudit(db, {
    businessId,
    actorId,
    action: `manager_instruction.${result.ok ? 'applied' : 'failed'}`,
    entityType: 'manager_instruction',
    entityId: instructionId,
    metadata: { instructionType, ok: result.ok },
  })

  return result
}

// ── Availability change ───────────────────────────────────────────────────────

async function applyAvailabilityChange(
  db: Db,
  businessId: string,
  actorId: string,
  params: Record<string, unknown>,
): Promise<ApplyResult> {
  const parsed = availabilityChangeSchema.safeParse(params)
  if (!parsed.success) {
    return { ok: false, reason: `Invalid availability params: ${parsed.error.message}` }
  }

  const p = parsed.data

  if (p.timezone && !isValidIANATimezone(p.timezone)) {
    return { ok: false, reason: `Invalid timezone "${p.timezone}". Use an IANA timezone name, e.g. "Asia/Jerusalem".` }
  }

  if (p.action === 'block' || p.action === 'bulk_close') {
    // For specific-date blocks, check for affected confirmed bookings first
    if (p.specificDate) {
      const dayStart = new Date(`${p.specificDate}T00:00:00Z`)
      const dayEnd = new Date(`${p.specificDate}T23:59:59Z`)
      const affected = await db
        .select({ id: bookings.id, customerId: bookings.customerId, slotStart: bookings.slotStart })
        .from(bookings)
        .where(
          and(
            eq(bookings.businessId, businessId),
            or(eq(bookings.state, 'confirmed'), eq(bookings.state, 'held')),
            gte(bookings.slotStart, dayStart),
            lte(bookings.slotStart, dayEnd),
          ),
        )

      if (affected.length > 0) {
        // Notify affected customers
        const [biz] = await db
          .select({ whatsappNumber: businesses.whatsappNumber })
          .from(businesses)
          .where(eq(businesses.id, businessId))
          .limit(1)

        for (const booking of affected) {
          const [customerIdentity] = await db
            .select({ phoneNumber: identities.phoneNumber })
            .from(identities)
            .where(eq(identities.id, booking.customerId))
            .limit(1)

          if (customerIdentity) {
            const dateStr = booking.slotStart.toLocaleDateString('en-GB', {
              weekday: 'long', day: 'numeric', month: 'long',
            })
            await enqueueMessage(
              customerIdentity.phoneNumber,
              `We're sorry — your appointment on ${dateStr} has been cancelled due to a schedule change. Please contact us to rebook.`,
            ).catch(() => { /* non-fatal */ })
          }
        }

        // Mark bookings as cancelled
        for (const booking of affected) {
          await db
            .update(bookings)
            .set({ state: 'cancelled', cancellationReason: p.reason ?? 'Business schedule change', cancelledByRole: 'manager', updatedAt: new Date() })
            .where(eq(bookings.id, booking.id))
        }
      }
    }

    if (p.action === 'bulk_close' && p.dateRangeStart && p.dateRangeEnd) {
      // Block each day in the range
      const start = new Date(p.dateRangeStart)
      const end = new Date(p.dateRangeEnd)
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().slice(0, 10)
        await db.insert(availability).values({
          businessId,
          dayOfWeek: null,
          specificDate: dateStr,
          openTime: null,
          closeTime: null,
          isBlocked: true,
          reason: p.reason ?? 'Vacation / temporary closure',
        }).onConflictDoNothing()
      }
      return { ok: true, confirmationMessage: `Closed from ${p.dateRangeStart} to ${p.dateRangeEnd}. ${p.reason ? `Reason: ${p.reason}.` : ''}` }
    }

    await db.insert(availability).values({
      businessId,
      dayOfWeek: p.dayOfWeek ?? null,
      specificDate: p.specificDate ?? null,
      openTime: null,
      closeTime: null,
      isBlocked: true,
      reason: p.reason ?? null,
    })
    const label = p.specificDate ?? dayName(p.dayOfWeek)
    return { ok: true, confirmationMessage: `Got it — ${label} is blocked.` }
  }

  if (p.action === 'unblock') {
    if (p.specificDate) {
      await db
        .delete(availability)
        .where(and(eq(availability.businessId, businessId), eq(availability.specificDate, p.specificDate)))
    } else if (p.dayOfWeek !== null && p.dayOfWeek !== undefined) {
      await db
        .delete(availability)
        .where(and(eq(availability.businessId, businessId), eq(availability.dayOfWeek, p.dayOfWeek), eq(availability.isBlocked, true)))
    }
    const label = p.specificDate ?? dayName(p.dayOfWeek)
    return { ok: true, confirmationMessage: `Got it — ${label} is unblocked.` }
  }

  // set_hours — check for bookings outside the new hours on the affected date/day
  if (!p.openTime || !p.closeTime) {
    return { ok: false, reason: 'set_hours requires openTime and closeTime' }
  }

  if (p.specificDate) {
    const newOpenMs = timeToMs(p.openTime)
    const newCloseMs = timeToMs(p.closeTime)
    const dayStart = new Date(`${p.specificDate}T00:00:00Z`)
    const dayEnd = new Date(`${p.specificDate}T23:59:59Z`)
    const affectedByHoursChange = await db
      .select({ id: bookings.id, slotStart: bookings.slotStart })
      .from(bookings)
      .where(
        and(
          eq(bookings.businessId, businessId),
          or(eq(bookings.state, 'confirmed'), eq(bookings.state, 'held')),
          gte(bookings.slotStart, dayStart),
          lte(bookings.slotStart, dayEnd),
        ),
      )

    const outsideHours = affectedByHoursChange.filter((b) => {
      const slotMs = (b.slotStart.getHours() * 60 + b.slotStart.getMinutes()) * 60_000
      return slotMs < newOpenMs || slotMs >= newCloseMs
    })

    if (outsideHours.length > 0) {
      return {
        ok: false,
        reason: `Cannot set hours — ${outsideHours.length} confirmed booking(s) fall outside the new hours on ${p.specificDate}. Cancel them first.`,
      }
    }
  }

  if (p.specificDate) {
    await db
      .insert(availability)
      .values({
        businessId,
        dayOfWeek: null,
        specificDate: p.specificDate,
        openTime: p.openTime,
        closeTime: p.closeTime,
        isBlocked: false,
      })
      .onConflictDoNothing()
    return { ok: true, confirmationMessage: `Hours set for ${p.specificDate}: ${p.openTime}–${p.closeTime}.` }
  }

  if (p.dayOfWeek !== null && p.dayOfWeek !== undefined) {
    // Upsert by deleting and re-inserting for the day
    await db
      .delete(availability)
      .where(and(eq(availability.businessId, businessId), eq(availability.dayOfWeek, p.dayOfWeek), eq(availability.isBlocked, false)))
    await db.insert(availability).values({
      businessId,
      dayOfWeek: p.dayOfWeek,
      specificDate: null,
      openTime: p.openTime,
      closeTime: p.closeTime,
      isBlocked: false,
    })
    return { ok: true, confirmationMessage: `Hours updated for ${dayName(p.dayOfWeek)}: ${p.openTime}–${p.closeTime}.` }
  }

  return { ok: false, reason: 'set_hours requires either dayOfWeek or specificDate' }
}

// ── Service change ────────────────────────────────────────────────────────────

async function applyServiceChange(
  db: Db,
  businessId: string,
  actorId: string,
  params: Record<string, unknown>,
): Promise<ApplyResult> {
  const parsed = serviceChangeSchema.safeParse(params)
  if (!parsed.success) {
    return { ok: false, reason: `Invalid service params: ${parsed.error.message}` }
  }

  const p = parsed.data

  if (p.action === 'create') {
    if (!p.durationMinutes) {
      return { ok: false, reason: 'create requires durationMinutes' }
    }
    const hasPrice = p.paymentAmount != null && p.paymentAmount > 0
    const maxParticipants = p.maxParticipants ?? 1
    await db.insert(serviceTypes).values({
      businessId,
      name: p.name,
      durationMinutes: p.durationMinutes,
      bufferMinutes: p.bufferMinutes ?? 0,
      category: p.category ?? null,
      maxParticipants,
      requiresPayment: p.requiresPayment ?? hasPrice,
      paymentAmount: hasPrice ? String(p.paymentAmount) : null,
      isActive: true,
    })
    const priceStr = hasPrice ? `, ${p.paymentAmount}` : ''
    const typeStr = maxParticipants > 1 ? ` (group class, up to ${maxParticipants})` : ''
    return { ok: true, confirmationMessage: `Service "${p.name}" created (${p.durationMinutes} min${priceStr}${typeStr}).` }
  }

  if (p.action === 'deactivate') {
    const [existing] = await db
      .select({ id: serviceTypes.id })
      .from(serviceTypes)
      .where(and(eq(serviceTypes.businessId, businessId), eq(serviceTypes.name, p.name)))
      .limit(1)

    if (!existing) return { ok: false, reason: `Service "${p.name}" not found` }

    await db
      .update(serviceTypes)
      .set({ isActive: false })
      .where(eq(serviceTypes.id, existing.id))

    return { ok: true, confirmationMessage: `Service "${p.name}" deactivated.` }
  }

  // update
  const [existing] = await db
    .select({ id: serviceTypes.id })
    .from(serviceTypes)
    .where(and(eq(serviceTypes.businessId, businessId), eq(serviceTypes.name, p.name)))
    .limit(1)

  if (!existing) return { ok: false, reason: `Service "${p.name}" not found` }

  const updates: Partial<typeof serviceTypes.$inferInsert> = {}
  if (p.durationMinutes !== undefined) updates.durationMinutes = p.durationMinutes
  if (p.bufferMinutes !== undefined) updates.bufferMinutes = p.bufferMinutes
  if (p.category !== undefined) updates.category = p.category ?? null
  if (p.maxParticipants != null) updates.maxParticipants = p.maxParticipants
  if (p.paymentAmount != null) {
    updates.paymentAmount = String(p.paymentAmount)
    updates.requiresPayment = true
  } else if (p.requiresPayment != null) {
    updates.requiresPayment = p.requiresPayment
  }

  if (Object.keys(updates).length > 0) {
    await db.update(serviceTypes).set(updates).where(eq(serviceTypes.id, existing.id))
  }

  return { ok: true, confirmationMessage: `Service "${p.name}" updated.` }
}

// ── Permission change ─────────────────────────────────────────────────────────

async function applyPermissionChange(
  db: Db,
  businessId: string,
  actorId: string,
  params: Record<string, unknown>,
): Promise<ApplyResult> {
  const parsed = permissionChangeSchema.safeParse(params)
  if (!parsed.success) {
    return { ok: false, reason: `Invalid permission params: ${parsed.error.message}` }
  }

  const p = parsed.data

  if (p.action === 'grant') {
    await db
      .insert(identities)
      .values({
        businessId,
        phoneNumber: p.phoneNumber,
        role: 'delegated_user',
        displayName: p.displayName ?? null,
        grantedBy: actorId,
        grantedAt: new Date(),
      })
      .onConflictDoNothing()
    return { ok: true, confirmationMessage: `${p.displayName ?? p.phoneNumber} granted delegated access.` }
  }

  // revoke
  const [target] = await db
    .select({ id: identities.id })
    .from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.phoneNumber, p.phoneNumber)))
    .limit(1)

  if (!target) return { ok: false, reason: `No identity found for ${p.phoneNumber}` }

  await db
    .update(identities)
    .set({ revokedAt: new Date() })
    .where(eq(identities.id, target.id))

  return { ok: true, confirmationMessage: `Access revoked for ${p.displayName ?? p.phoneNumber}.` }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── STATUS ────────────────────────────────────────────────────────────────────

export async function buildStatusReport(db: Db, businessId: string): Promise<string> {
  const [business] = await db
    .select({ googleRefreshToken: businesses.googleRefreshToken, whatsappNumber: businesses.whatsappNumber })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)

  const calendarStatus = business?.googleRefreshToken ? '✅ Connected' : '❌ Not connected'

  const [customerRow] = await db
    .select({ total: count() })
    .from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.role, 'customer')))

  const [lastBooking] = await db
    .select({ slotStart: bookings.slotStart, state: bookings.state })
    .from(bookings)
    .where(and(eq(bookings.businessId, businessId), eq(bookings.state, 'confirmed')))
    .orderBy(desc(bookings.slotStart))
    .limit(1)

  const [lastMessage] = await db
    .select({ processedAt: processedMessages.processedAt })
    .from(processedMessages)
    .where(eq(processedMessages.businessId, businessId))
    .orderBy(desc(processedMessages.processedAt))
    .limit(1)

  const customerCount = customerRow?.total ?? 0
  const lastBookingStr = lastBooking
    ? lastBooking.slotStart.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
    : 'None'
  const lastMsgStr = lastMessage
    ? `${Math.round((Date.now() - lastMessage.processedAt.getTime()) / 60_000)} min ago`
    : 'Unknown'

  return [
    '✅ PA is live',
    `📅 Calendar: ${calendarStatus}`,
    `👥 Customers: ${customerCount}`,
    `📋 Last confirmed booking: ${lastBookingStr}`,
    `🕐 Last message processed: ${lastMsgStr}`,
  ].join('\n')
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function dayName(dayOfWeek: number | null | undefined): string {
  if (dayOfWeek === null || dayOfWeek === undefined) return 'that day'
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  return days[dayOfWeek] ?? 'that day'
}

function timeToMs(time: string): number {
  const [h = '0', m = '0'] = time.split(':')
  return (parseInt(h, 10) * 60 + parseInt(m, 10)) * 60_000
}
