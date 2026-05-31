import { eq, and, or, lte, gte, gt, lt, count, desc, isNull, ilike, inArray } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../../db/client.js'
import { availability, serviceTypes, identities, managerInstructions, bookings, businesses, processedMessages } from '../../db/schema.js'
import { logAudit } from '../audit/logger.js'
import { enqueueMessage } from '../../workers/message-retry.js'
import { i18n, t, type Lang } from '../i18n/t.js'
import { generateProactiveCustomerMessage } from '../../adapters/llm/client.js'
import { createBlock } from '../availability/blocks.js'
import { localTimeToUtc } from '../availability/compute.js'
import { enqueueBlockMirror, enqueueBookingDeletion } from '../../workers/calendar-mirror.js'

// Bilingual day names (Sun=0 … Sat=6)
function dayName(dayOfWeek: number | null | undefined, lang: Lang): string {
  if (dayOfWeek === null || dayOfWeek === undefined) return lang === 'he' ? 'אותו יום' : 'that day'
  const daysHe = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']
  const daysEn = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  return (lang === 'he' ? daysHe : daysEn)[dayOfWeek] ?? (lang === 'he' ? 'אותו יום' : 'that day')
}

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
  dayOfWeek: z.coerce.number().int().min(0).max(6).nullable().optional(),
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
  durationMinutes: z.coerce.number().int().positive().optional(),
  bufferMinutes: z.coerce.number().int().min(0).optional(),
  paymentAmount: z.coerce.number().nonnegative().nullable().optional(),
  requiresPayment: z.boolean().nullable().optional(),
  category: z.string().nullable().optional(),
  maxParticipants: z.coerce.number().int().positive().nullable().optional(),
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
  lang: Lang = 'he',
): Promise<ApplyResult> {
  let result: ApplyResult

  switch (instructionType) {
    case 'availability_change':
      result = await applyAvailabilityChange(db, businessId, actorId, structuredParams, lang)
      break
    case 'service_change':
      result = await applyServiceChange(db, businessId, actorId, structuredParams, lang)
      break
    case 'permission_change':
      result = await applyPermissionChange(db, businessId, actorId, structuredParams, lang)
      break
    case 'policy_change':
      result = await applyPolicyChange(db, businessId, actorId, structuredParams, lang)
      break
    case 'booking_cancellation':
      result = await applyBookingCancellation(db, businessId, actorId, structuredParams, lang)
      break
    default:
      result = { ok: false, reason: i18n.apply_unknown_type[lang](instructionType) }
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
  lang: Lang = 'he',
): Promise<ApplyResult> {
  const parsed = availabilityChangeSchema.safeParse(params)
  if (!parsed.success) {
    return { ok: false, reason: `Invalid availability params: ${parsed.error.message}` }
  }

  const p = parsed.data

  if (p.timezone && !isValidIANATimezone(p.timezone)) {
    return { ok: false, reason: `Invalid timezone "${p.timezone}". Use an IANA timezone name, e.g. "Asia/Jerusalem".` }
  }

  // Intra-day block (a specific date with explicit start/end times) is a
  // time-ranged block, not a whole-day closure. It lives in calendar_blocks, not
  // the availability table — this is what makes "block 2–4pm Tuesday" possible
  // (CALENDAR_UX_DESIGN.md §4). Whole-day blocks (no times) keep the old path.
  if (p.action === 'block' && p.specificDate && p.openTime && p.closeTime) {
    return applyIntradayBlock(db, businessId, p.specificDate, p.openTime, p.closeTime, p.reason ?? null, lang)
  }

  if (p.action === 'block' || p.action === 'bulk_close') {
    // For specific-date blocks, check for affected confirmed bookings first
    if (p.specificDate) {
      const dayStart = new Date(`${p.specificDate}T00:00:00Z`)
      const dayEnd = new Date(`${p.specificDate}T23:59:59Z`)
      const affected = await db
        .select({ id: bookings.id, customerId: bookings.customerId, slotStart: bookings.slotStart, calendarEventId: bookings.calendarEventId })
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
        // Fetch business calendar info once for all affected bookings
        const [biz] = await db
          .select({
            name: businesses.name,
            whatsappNumber: businesses.whatsappNumber,
            googleCalendarId: businesses.googleCalendarId,
            googleRefreshToken: businesses.googleRefreshToken,
            calendarMode: businesses.calendarMode,
          })
          .from(businesses)
          .where(eq(businesses.id, businessId))
          .limit(1)

        const [managerIdentity] = await db
          .select({ phoneNumber: identities.phoneNumber })
          .from(identities)
          .where(and(eq(identities.businessId, businessId), eq(identities.role, 'manager')))
          .limit(1)

        // Import calendar client lazily to avoid circular deps
        const { createCalendarClient } = await import('../../adapters/calendar/client.js')
        const calClient = biz ? createCalendarClient({
          accessToken: '',
          refreshToken: biz.googleRefreshToken ?? process.env['GOOGLE_REFRESH_TOKEN'] ?? '',
          calendarId: biz.googleCalendarId,
          businessId,
          calendarMode: (biz.calendarMode as 'google' | 'internal') ?? 'google',
          ...(managerIdentity ? { managerPhoneNumber: managerIdentity.phoneNumber } : {}),
        }) : null

        for (const booking of affected) {
          // Delete the Google Calendar event before cancelling the DB row
          if (booking.calendarEventId && calClient) {
            await calClient.deleteEvent(booking.calendarEventId).catch(() => { /* non-fatal — log but continue */ })
          }

          const [customerIdentity] = await db
            .select({ phoneNumber: identities.phoneNumber, preferredLanguage: identities.preferredLanguage })
            .from(identities)
            .where(eq(identities.id, booking.customerId))
            .limit(1)

          if (customerIdentity) {
            const custLang: Lang = (customerIdentity.preferredLanguage as Lang | null | undefined) ?? 'he'
            const locale = custLang === 'he' ? 'he-IL' : 'en-GB'
            const dateStr = booking.slotStart.toLocaleDateString(locale, {
              weekday: 'long', day: 'numeric', month: 'long',
            })
            const cancelFallback = i18n.booking_cancelled_schedule[custLang](dateStr)
            const cancelMsg = await generateProactiveCustomerMessage({
              businessName: biz?.name ?? biz?.whatsappNumber ?? 'the business',
              language: custLang,
              situation: `The customer's appointment on ${dateStr} has been cancelled due to a schedule change. Apologise briefly and tell them they can reply REBOOK to find a new slot or contact the business directly.`,
              fallback: cancelFallback,
              timeoutMs: 2500,
            }).catch(() => cancelFallback)
            await enqueueMessage(
              customerIdentity.phoneNumber,
              cancelMsg,
            ).catch(() => { /* non-fatal */ })
          }

          await db
            .update(bookings)
            .set({
              state: 'cancelled',
              cancellationReason: p.reason ?? 'Business schedule change',
              cancelledByRole: 'manager',
              rebookingRequested: false,
              updatedAt: new Date(),
            })
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
      return { ok: true, confirmationMessage: i18n.apply_bulk_close[lang](p.dateRangeStart, p.dateRangeEnd) }
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
    const label = p.specificDate ?? dayName(p.dayOfWeek, lang)
    return { ok: true, confirmationMessage: i18n.apply_blocked[lang](label) }
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
    const label = p.specificDate ?? dayName(p.dayOfWeek, lang)
    return { ok: true, confirmationMessage: i18n.apply_unblocked[lang](label) }
  }

  // set_hours — check for bookings outside the new hours on the affected date/day
  if (!p.openTime || !p.closeTime) {
    return { ok: false, reason: t('apply_set_hours_requires_times', lang) }
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
        reason: i18n.apply_hours_conflict[lang](outsideHours.length, p.specificDate!),
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
    return { ok: true, confirmationMessage: i18n.apply_hours_set[lang](p.specificDate, p.openTime, p.closeTime) }
  }

  if (p.dayOfWeek !== null && p.dayOfWeek !== undefined) {
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
    return { ok: true, confirmationMessage: i18n.apply_hours_set[lang](dayName(p.dayOfWeek, lang), p.openTime, p.closeTime) }
  }

  return { ok: false, reason: t('apply_set_hours_requires_target', lang) }
}

// Intra-day time-ranged block → calendar_blocks. Cancels and notifies any active
// bookings that fall inside the blocked window (owner action wins).
async function applyIntradayBlock(
  db: Db,
  businessId: string,
  specificDate: string,
  openTime: string,
  closeTime: string,
  reason: string | null,
  lang: Lang,
): Promise<ApplyResult> {
  const [biz] = await db
    .select({ timezone: businesses.timezone, name: businesses.name, whatsappNumber: businesses.whatsappNumber })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)
  const tz = biz?.timezone ?? 'UTC'

  const startTs = localTimeToUtc(specificDate, openTime, tz)
  const endTs = localTimeToUtc(specificDate, closeTime, tz)
  if (endTs <= startTs) {
    return { ok: false, reason: lang === 'he' ? 'שעת הסיום חייבת להיות אחרי שעת ההתחלה.' : 'End time must be after start time.' }
  }

  // Cancel + notify bookings overlapping the blocked window.
  const affected = await db
    .select({ id: bookings.id, customerId: bookings.customerId, slotStart: bookings.slotStart, calendarEventId: bookings.calendarEventId })
    .from(bookings)
    .where(and(
      eq(bookings.businessId, businessId),
      inArray(bookings.state, ['held', 'confirmed', 'pending_payment']),
      lt(bookings.slotStart, endTs),
      gt(bookings.slotEnd, startTs),
    ))

  for (const booking of affected) {
    await db.update(bookings)
      .set({ state: 'cancelled', cancellationReason: reason ?? 'Business schedule change', cancelledByRole: 'manager', updatedAt: new Date() })
      .where(eq(bookings.id, booking.id))

    // Durable mirror: remove the cancelled booking's Google event when present.
    if (booking.calendarEventId) {
      await enqueueBookingDeletion(businessId, booking.id, booking.calendarEventId)
    }

    const [customer] = await db
      .select({ phoneNumber: identities.phoneNumber, preferredLanguage: identities.preferredLanguage })
      .from(identities)
      .where(eq(identities.id, booking.customerId))
      .limit(1)
    if (customer) {
      const custLang: Lang = (customer.preferredLanguage as Lang | null | undefined) ?? 'he'
      const locale = custLang === 'he' ? 'he-IL' : 'en-GB'
      const dateStr = booking.slotStart.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' })
      await enqueueMessage(customer.phoneNumber, i18n.booking_cancelled_schedule[custLang](dateStr)).catch(() => { /* non-fatal */ })
    }
  }

  const block = await createBlock(db, {
    businessId,
    type: 'block',
    start: startTs,
    end: endTs,
    title: reason ?? (lang === 'he' ? 'זמן חסום' : 'Blocked time'),
    reason,
  })

  // Durable outbound mirror (Phase 2) — no-op in internal mode.
  await enqueueBlockMirror(businessId, block.id)

  const affectedNote = affected.length > 0
    ? (lang === 'he' ? ` ${affected.length} תורים בוטלו והלקוחות עודכנו.` : ` ${affected.length} booking(s) were cancelled and customers notified.`)
    : ''
  const msg = lang === 'he'
    ? `✅ נחסם ${specificDate} בין ${openTime} ל-${closeTime}.${affectedNote}`
    : `✅ Blocked ${specificDate} from ${openTime} to ${closeTime}.${affectedNote}`
  return { ok: true, confirmationMessage: msg }
}

// ── Service change ────────────────────────────────────────────────────────────

async function applyServiceChange(
  db: Db,
  businessId: string,
  actorId: string,
  params: Record<string, unknown>,
  lang: Lang = 'he',
): Promise<ApplyResult> {
  const parsed = serviceChangeSchema.safeParse(params)
  if (!parsed.success) {
    return { ok: false, reason: `Invalid service params: ${parsed.error.message}` }
  }

  const p = parsed.data

  if (p.action === 'create') {
    if (!p.durationMinutes) {
      return { ok: false, reason: lang === 'he' ? 'create דורש durationMinutes.' : 'create requires durationMinutes.' }
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
    const typeStr = maxParticipants > 1
      ? (lang === 'he' ? `, קבוצה עד ${maxParticipants}` : `, group up to ${maxParticipants}`)
      : ''
    return { ok: true, confirmationMessage: i18n.apply_service_created[lang](p.name, p.durationMinutes, priceStr + typeStr) }
  }

  if (p.action === 'deactivate') {
    const safety = await checkServiceDeactivationSafety(db, businessId, p.name)
    if (!safety.safe) {
      const locale = lang === 'he' ? 'he-IL' : 'en-GB'
      const dateStr = safety.earliestDate
        ? safety.earliestDate.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' })
        : (lang === 'he' ? 'בקרוב' : 'soon')
      return {
        ok: false,
        reason: i18n.apply_service_blocked[lang](p.name, safety.blockingCount, dateStr),
      }
    }

    const [existing] = await db
      .select({ id: serviceTypes.id })
      .from(serviceTypes)
      .where(and(eq(serviceTypes.businessId, businessId), eq(serviceTypes.name, p.name)))
      .limit(1)

    if (!existing) return { ok: false, reason: i18n.apply_service_not_found[lang](p.name) }

    await db
      .update(serviceTypes)
      .set({ isActive: false })
      .where(eq(serviceTypes.id, existing.id))

    return { ok: true, confirmationMessage: i18n.apply_service_deactivated[lang](p.name) }
  }

  // update
  const [existing] = await db
    .select({ id: serviceTypes.id })
    .from(serviceTypes)
    .where(and(eq(serviceTypes.businessId, businessId), eq(serviceTypes.name, p.name)))
    .limit(1)

  if (!existing) return { ok: false, reason: i18n.apply_service_not_found[lang](p.name) }

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

  return { ok: true, confirmationMessage: i18n.apply_service_updated[lang](p.name) }
}

// ── Permission change ─────────────────────────────────────────────────────────

async function applyPermissionChange(
  db: Db,
  businessId: string,
  actorId: string,
  params: Record<string, unknown>,
  lang: Lang = 'he',
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
    return { ok: true, confirmationMessage: i18n.apply_permission_granted[lang](p.displayName ?? p.phoneNumber) }
  }

  // revoke
  const [target] = await db
    .select({ id: identities.id })
    .from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.phoneNumber, p.phoneNumber)))
    .limit(1)

  if (!target) return { ok: false, reason: i18n.apply_permission_not_found[lang](p.phoneNumber) }

  await db
    .update(identities)
    .set({ revokedAt: new Date() })
    .where(eq(identities.id, target.id))

  return { ok: true, confirmationMessage: i18n.apply_permission_revoked[lang](p.displayName ?? p.phoneNumber) }
}

// ── Policy change ─────────────────────────────────────────────────────────────

const policyChangeSchema = z.object({
  subtype: z.enum(['cancellation_cutoff', 'booking_buffer', 'max_days_ahead', 'cancellation_fee', 'other']),
  valueHours: z.coerce.number().nonnegative().nullable().optional(),
  valueDays: z.coerce.number().int().positive().nullable().optional(),
  valueAmount: z.coerce.number().nonnegative().nullable().optional(),
  description: z.string(),
})

async function applyPolicyChange(
  db: Db,
  businessId: string,
  actorId: string,
  params: Record<string, unknown>,
  lang: Lang,
): Promise<ApplyResult> {
  const parsed = policyChangeSchema.safeParse(params)
  if (!parsed.success) {
    return { ok: false, reason: `Invalid policy params: ${parsed.error.message}` }
  }

  const p = parsed.data

  switch (p.subtype) {
    case 'cancellation_cutoff': {
      const hours = p.valueHours ?? 0
      await db
        .update(businesses)
        .set({ cancellationCutoffMinutes: Math.round(hours * 60) })
        .where(eq(businesses.id, businessId))
      await logAudit(db, { businessId, actorId, action: 'policy.cancellation_cutoff_updated', entityType: 'business', entityId: businessId, afterState: { cancellationCutoffMinutes: Math.round(hours * 60) } })
      return { ok: true, confirmationMessage: i18n.apply_policy_cancellation_cutoff[lang](hours) }
    }

    case 'booking_buffer': {
      const hours = p.valueHours ?? 0
      await db
        .update(businesses)
        .set({ minBookingBufferMinutes: Math.round(hours * 60) })
        .where(eq(businesses.id, businessId))
      await logAudit(db, { businessId, actorId, action: 'policy.booking_buffer_updated', entityType: 'business', entityId: businessId, afterState: { minBookingBufferMinutes: Math.round(hours * 60) } })
      return { ok: true, confirmationMessage: i18n.apply_policy_booking_buffer[lang](hours) }
    }

    case 'max_days_ahead': {
      const days = p.valueDays ?? 365
      await db
        .update(businesses)
        .set({ maxBookingDaysAhead: days })
        .where(eq(businesses.id, businessId))
      await logAudit(db, { businessId, actorId, action: 'policy.max_days_ahead_updated', entityType: 'business', entityId: businessId, afterState: { maxBookingDaysAhead: days } })
      return { ok: true, confirmationMessage: i18n.apply_policy_max_days[lang](days) }
    }

    case 'cancellation_fee': {
      const amount = p.valueAmount ?? 0
      const [biz] = await db.select({ currency: businesses.currency }).from(businesses).where(eq(businesses.id, businessId)).limit(1)
      const currency = biz?.currency ?? 'ILS'
      await db
        .update(businesses)
        .set({ cancellationFeeAmount: String(amount), cancellationFeeCurrency: currency })
        .where(eq(businesses.id, businessId))
      await logAudit(db, { businessId, actorId, action: 'policy.cancellation_fee_updated', entityType: 'business', entityId: businessId, afterState: { cancellationFeeAmount: amount, cancellationFeeCurrency: currency } })
      return { ok: true, confirmationMessage: i18n.apply_policy_cancellation_fee[lang](amount, currency) }
    }

    case 'other':
      // Classifier already set ambiguous=true for this subtype — this path shouldn't be reached
      // but handle gracefully in case it is.
      return { ok: false, reason: i18n.apply_policy_unsupported[lang] }
  }
}

// ── Booking cancellation ──────────────────────────────────────────────────────

const bookingCancellationSchema = z.object({
  customerNameHint: z.string().optional(),
  customerPhone: z.string().optional(),
  slotDateHint: z.string().optional(),
  bookingId: z.string().uuid().optional(),
  reason: z.string().optional(),
})

async function applyBookingCancellation(
  db: Db,
  businessId: string,
  actorId: string,
  params: Record<string, unknown>,
  lang: Lang,
): Promise<ApplyResult> {
  const parsed = bookingCancellationSchema.safeParse(params)
  if (!parsed.success) {
    return { ok: false, reason: `Invalid booking_cancellation params: ${parsed.error.message}` }
  }

  const p = parsed.data

  // Resolve the booking: prefer explicit bookingId, else search by customer hint + date
  let bookingRow: { id: string; customerId: string; slotStart: Date; calendarEventId: string | null; serviceTypeId: string } | undefined

  if (p.bookingId) {
    const [row] = await db
      .select({ id: bookings.id, customerId: bookings.customerId, slotStart: bookings.slotStart, calendarEventId: bookings.calendarEventId, serviceTypeId: bookings.serviceTypeId })
      .from(bookings)
      .where(and(eq(bookings.id, p.bookingId), eq(bookings.businessId, businessId), or(eq(bookings.state, 'confirmed'), eq(bookings.state, 'held'))))
      .limit(1)
    bookingRow = row
  } else {
    // Search by customer phone or name + optional date hint
    let candidateIdentityId: string | undefined

    if (p.customerPhone) {
      const [id] = await db
        .select({ id: identities.id })
        .from(identities)
        .where(and(eq(identities.businessId, businessId), eq(identities.phoneNumber, p.customerPhone)))
        .limit(1)
      candidateIdentityId = id?.id
    } else if (p.customerNameHint) {
      const matches = await db
        .select({ id: identities.id, displayName: identities.displayName })
        .from(identities)
        .where(eq(identities.businessId, businessId))
      const lower = p.customerNameHint.toLowerCase()
      const match = matches.find((m) => m.displayName?.toLowerCase().includes(lower))
      candidateIdentityId = match?.id
    }

    if (!candidateIdentityId) {
      return { ok: false, reason: lang === 'he' ? 'לא נמצא לקוח תואם. ציין שם, טלפון, או מזהה תור.' : 'No matching customer found. Specify a name, phone number, or booking ID.' }
    }

    const baseWhere = and(
      eq(bookings.businessId, businessId),
      eq(bookings.customerId, candidateIdentityId),
      or(eq(bookings.state, 'confirmed'), eq(bookings.state, 'held')),
      gt(bookings.slotStart, new Date()),
    )

    let candidates = await db
      .select({ id: bookings.id, customerId: bookings.customerId, slotStart: bookings.slotStart, calendarEventId: bookings.calendarEventId, serviceTypeId: bookings.serviceTypeId })
      .from(bookings)
      .where(baseWhere)
      .orderBy(bookings.slotStart)
      .limit(10)

    if (p.slotDateHint) {
      const hintLower = p.slotDateHint.toLowerCase()
      const filtered = candidates.filter((b) => {
        const dateStr = b.slotStart.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }).toLowerCase()
        return dateStr.includes(hintLower) || b.slotStart.toISOString().startsWith(p.slotDateHint!)
      })
      if (filtered.length > 0) candidates = filtered
    }

    if (candidates.length === 0) {
      return { ok: false, reason: lang === 'he' ? 'לא נמצא תור עתידי פעיל ללקוח זה.' : 'No active upcoming booking found for this customer.' }
    }
    if (candidates.length > 1) {
      const locale = lang === 'he' ? 'he-IL' : 'en-GB'
      const list = candidates.slice(0, 5).map((b) =>
        b.slotStart.toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
      ).join(', ')
      return { ok: false, reason: lang === 'he' ? `נמצאו ${candidates.length} תורים. ציין תאריך: ${list}` : `Found ${candidates.length} bookings. Specify a date: ${list}` }
    }
    bookingRow = candidates[0]
  }

  if (!bookingRow) {
    return { ok: false, reason: lang === 'he' ? 'התור לא נמצא או כבר בוטל.' : 'Booking not found or already cancelled.' }
  }

  // Delete Google Calendar event
  const [biz] = await db
    .select({ googleRefreshToken: businesses.googleRefreshToken, googleCalendarId: businesses.googleCalendarId, calendarMode: businesses.calendarMode })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)

  if (bookingRow.calendarEventId && biz?.calendarMode !== 'internal') {
    const { createCalendarClient } = await import('../../adapters/calendar/client.js')
    const cal = createCalendarClient({
      accessToken: '',
      refreshToken: biz?.googleRefreshToken ?? process.env['GOOGLE_REFRESH_TOKEN'] ?? '',
      calendarId: biz?.googleCalendarId ?? '',
      businessId,
      calendarMode: 'google',
    })
    await cal.deleteEvent(bookingRow.calendarEventId).catch(() => { /* non-fatal */ })
  }

  // Cancel the booking
  await db.update(bookings)
    .set({ state: 'cancelled', cancellationReason: p.reason ?? 'Cancelled by manager', cancelledByRole: 'manager', updatedAt: new Date() })
    .where(eq(bookings.id, bookingRow.id))

  // Notify the customer
  const [customer] = await db
    .select({ phoneNumber: identities.phoneNumber, preferredLanguage: identities.preferredLanguage, displayName: identities.displayName })
    .from(identities)
    .where(eq(identities.id, bookingRow.customerId))
    .limit(1)

  if (customer) {
    const custLang: Lang = (customer.preferredLanguage as Lang | null | undefined) ?? lang
    const locale = custLang === 'he' ? 'he-IL' : 'en-GB'
    const dateStr = bookingRow.slotStart.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
    await enqueueMessage(customer.phoneNumber, i18n.booking_cancelled_schedule[custLang](dateStr)).catch(() => { /* non-fatal */ })
  }

  await logAudit(db, {
    businessId,
    actorId,
    action: 'booking.manager_cancelled',
    entityType: 'booking',
    entityId: bookingRow.id,
    metadata: { reason: p.reason, customerNameHint: p.customerNameHint, slotDateHint: p.slotDateHint },
  })

  const locale = lang === 'he' ? 'he-IL' : 'en-GB'
  const slotStr = bookingRow.slotStart.toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  const who = customer?.displayName ?? customer?.phoneNumber ?? (lang === 'he' ? 'הלקוח' : 'the customer')
  const msg = lang === 'he'
    ? `✅ התור של ${who} ב-${slotStr} בוטל. הלקוח קיבל הודעה.`
    : `✅ ${who}'s booking on ${slotStr} has been cancelled. The customer has been notified.`
  return { ok: true, confirmationMessage: msg }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── STATUS ────────────────────────────────────────────────────────────────────

export async function buildStatusReport(db: Db, businessId: string, lang: Lang = 'he'): Promise<string> {
  const [business] = await db
    .select({
      googleRefreshToken: businesses.googleRefreshToken,
      whatsappNumber: businesses.whatsappNumber,
      calendarMode: businesses.calendarMode,
      paused: businesses.paused,
      confirmationGate: businesses.confirmationGate,
      paymentMethod: businesses.paymentMethod,
    })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)

  const calendarStatus = business?.calendarMode === 'internal'
    ? t('status_cal_internal', lang)
    : business?.googleRefreshToken ? t('status_cal_ok', lang) : t('status_cal_missing', lang)

  const [customerRow] = await db
    .select({ total: count() })
    .from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.role, 'customer')))

  const [lastBooking] = await db
    .select({ slotStart: bookings.slotStart })
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

  const paused = business?.paused ?? false
  const statusLine = paused ? t('status_paused', lang) : t('status_live', lang)
  const customerCount = customerRow?.total ?? 0
  const noneStr = t('status_none', lang)
  const lastBookingStr = lastBooking
    ? lastBooking.slotStart.toLocaleString(lang === 'he' ? 'he-IL' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' })
    : noneStr
  const minAgo = lastMessage ? Math.round((Date.now() - lastMessage.processedAt.getTime()) / 60_000) : null
  const lastMsgStr = minAgo !== null ? i18n.status_min_ago[lang](minAgo) : t('status_unknown', lang)
  const paymentStr = business?.confirmationGate === 'post_payment'
    ? i18n.status_payment_post[lang](business.paymentMethod ?? noneStr)
    : t('status_payment_immediate', lang)

  return [
    statusLine,
    `📅 ${lang === 'he' ? 'לוח שנה' : 'Calendar'}: ${calendarStatus}`,
    `💰 ${lang === 'he' ? 'אישור' : 'Confirmation'}: ${paymentStr}`,
    `${t('status_customers', lang)}: ${customerCount}`,
    `${t('status_last_booking', lang)}: ${lastBookingStr}`,
    `${t('status_last_msg', lang)}: ${lastMsgStr}`,
    ...(paused ? ['', t('status_resume_hint', lang)] : []),
  ].join('\n')
}

// ── PAUSE / RESUME ────────────────────────────────────────────────────────────

export async function pausePA(db: Db, businessId: string, lang: Lang = 'he'): Promise<string> {
  await db.update(businesses).set({ paused: true }).where(eq(businesses.id, businessId))
  return t('pause_confirm', lang)
}

export async function resumePA(db: Db, businessId: string, lang: Lang = 'he'): Promise<string> {
  await db.update(businesses).set({ paused: false }).where(eq(businesses.id, businessId))
  return t('resume_confirm', lang)
}

// ── PAUSE / RESUME CONVERSATION ──────────────────────────────────────────────

export async function pauseConversation(
  db: Db,
  businessId: string,
  customerIdentifier: string,
  durationMinutes: number,
  lang: Lang = 'he',
): Promise<string> {
  const matches = await db
    .select({ id: identities.id, phoneNumber: identities.phoneNumber, displayName: identities.displayName })
    .from(identities)
    .where(
      and(
        eq(identities.businessId, businessId),
        eq(identities.role, 'customer'),
        isNull(identities.revokedAt),
        or(
          ilike(identities.displayName, `%${customerIdentifier}%`),
          eq(identities.phoneNumber, customerIdentifier),
        ),
      ),
    )
    .limit(5)

  if (matches.length === 0) return t('pause_conv_not_found', lang)
  if (matches.length > 1) {
    const names = matches.map((m) => m.displayName ?? m.phoneNumber).join(', ')
    return i18n.pause_conv_ambiguous[lang](names)
  }

  const match = matches[0]!
  const pausedUntil = new Date(Date.now() + durationMinutes * 60_000)
  await db.update(identities).set({ conversationPausedUntil: pausedUntil }).where(eq(identities.id, match.id))

  const name = match.displayName ?? match.phoneNumber
  return i18n.pause_conv_confirm[lang](name, durationMinutes)
}

export async function resumeConversation(
  db: Db,
  businessId: string,
  customerIdentifier: string,
  lang: Lang = 'he',
): Promise<string> {
  const matches = await db
    .select({ id: identities.id, phoneNumber: identities.phoneNumber, displayName: identities.displayName })
    .from(identities)
    .where(
      and(
        eq(identities.businessId, businessId),
        eq(identities.role, 'customer'),
        isNull(identities.revokedAt),
        or(
          ilike(identities.displayName, `%${customerIdentifier}%`),
          eq(identities.phoneNumber, customerIdentifier),
        ),
      ),
    )
    .limit(5)

  if (matches.length === 0) return t('pause_conv_not_found', lang)
  if (matches.length > 1) {
    const names = matches.map((m) => m.displayName ?? m.phoneNumber).join(', ')
    return i18n.pause_conv_ambiguous[lang](names)
  }

  const match = matches[0]!
  await db.update(identities).set({ conversationPausedUntil: null }).where(eq(identities.id, match.id))

  const name = match.displayName ?? match.phoneNumber
  return i18n.resume_conv_confirm[lang](name)
}

// ── UPCOMING / BOOKINGS [date] ────────────────────────────────────────────────

export async function buildUpcomingReport(db: Db, businessId: string, forDate?: string, lang: Lang = 'he'): Promise<string> {
  let query = db
    .select({
      id: bookings.id,
      slotStart: bookings.slotStart,
      slotEnd: bookings.slotEnd,
      state: bookings.state,
      customerId: bookings.customerId,
      serviceTypeId: bookings.serviceTypeId,
    })
    .from(bookings)
    .where(and(eq(bookings.businessId, businessId), eq(bookings.state, 'confirmed')))
    .$dynamic()

  if (forDate) {
    const dayStart = new Date(`${forDate}T00:00:00Z`)
    const dayEnd = new Date(`${forDate}T23:59:59Z`)
    query = query.where(and(
      eq(bookings.businessId, businessId),
      eq(bookings.state, 'confirmed'),
      gte(bookings.slotStart, dayStart),
      lte(bookings.slotStart, dayEnd),
    ))
  } else {
    query = query.where(and(
      eq(bookings.businessId, businessId),
      eq(bookings.state, 'confirmed'),
      gt(bookings.slotStart, new Date()),
    ))
  }

  const upcoming = await query.orderBy(bookings.slotStart).limit(15)

  if (upcoming.length === 0) {
    return i18n.upcoming_none[lang](forDate)
  }

  const label = forDate ? i18n.upcoming_label_date[lang](forDate) : t('upcoming_label_all', lang)
  const locale = lang === 'he' ? 'he-IL' : 'en-GB'
  const lines = [i18n.upcoming_header[lang](label, upcoming.length), '']
  for (const b of upcoming) {
    const [customer] = await db
      .select({ displayName: identities.displayName, phoneNumber: identities.phoneNumber })
      .from(identities).where(eq(identities.id, b.customerId)).limit(1)
    const [service] = await db
      .select({ name: serviceTypes.name })
      .from(serviceTypes).where(eq(serviceTypes.id, b.serviceTypeId)).limit(1)

    const time = b.slotStart.toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    const who = customer?.displayName ?? customer?.phoneNumber ?? t('status_unknown', lang)
    lines.push(`• ${time} — ${service?.name ?? (lang === 'he' ? 'תור' : 'Appointment')} — ${who}`)
  }

  return lines.join('\n')
}

// ── HANDLED / RESUME (escalation management) ─────────────────────────────────

export async function markEscalationHandled(db: Db, businessId: string, customerPhone: string, lang: Lang = 'he'): Promise<string> {
  const { escalatedTasks } = await import('../../db/schema.js')
  const { isNull } = await import('drizzle-orm')
  await db
    .update(escalatedTasks)
    .set({ resolvedAt: new Date() })
    .where(and(eq(escalatedTasks.businessId, businessId), eq(escalatedTasks.customerPhone, customerPhone), isNull(escalatedTasks.resolvedAt)))
  return i18n.escalation_handled[lang](customerPhone)
}

// ── Service deactivation safety check ────────────────────────────────────────

export async function checkServiceDeactivationSafety(
  db: Db,
  businessId: string,
  serviceName: string,
): Promise<{ safe: boolean; blockingCount: number; earliestDate: Date | null }> {
  const [service] = await db
    .select({ id: serviceTypes.id })
    .from(serviceTypes)
    .where(and(eq(serviceTypes.businessId, businessId), eq(serviceTypes.name, serviceName)))
    .limit(1)

  if (!service) return { safe: true, blockingCount: 0, earliestDate: null }

  const futureBookings = await db
    .select({ id: bookings.id, slotStart: bookings.slotStart })
    .from(bookings)
    .where(
      and(
        eq(bookings.businessId, businessId),
        eq(bookings.serviceTypeId, service.id),
        or(eq(bookings.state, 'confirmed'), eq(bookings.state, 'held'), eq(bookings.state, 'pending_payment')),
        gt(bookings.slotStart, new Date()),
      ),
    )
    .orderBy(bookings.slotStart)

  if (futureBookings.length === 0) return { safe: true, blockingCount: 0, earliestDate: null }

  return {
    safe: false,
    blockingCount: futureBookings.length,
    earliestDate: futureBookings[0]!.slotStart,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeToMs(time: string): number {
  const [h = '0', m = '0'] = time.split(':')
  return (parseInt(h, 10) * 60 + parseInt(m, 10)) * 60_000
}
