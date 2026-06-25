import { eq, and, or, lte, gte, gt, lt, count, desc, isNull, ilike, inArray } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Db } from '../../db/client.js'
import { availability, serviceTypes, identities, managerInstructions, bookings, businesses, processedMessages, classSeries, calendarBlocks, providerAssignments } from '../../db/schema.js'
import { createSeries, stopSeries, cancelOccurrence } from '../scheduling/series.js'
import { requiredActionForInstruction, DEFAULT_DELEGATED_CALENDAR_ACTIONS, type Action } from '../authorization/check.js'
import { grantDelegatedPermissions, revokeAllDelegatedPermissions } from '../authorization/permissions.js'
import type { IdentityRole } from '../../db/schema.js'
import { logAudit } from '../audit/logger.js'
import { enqueueMessage } from '../../workers/message-retry.js'
import { notifyInstructorsOfCancelledBookings } from '../scheduling/session-cancellation.js'
import { i18n, t, type Lang } from '../i18n/t.js'
import { notifyBusinessBookingChange } from '../initiations/booking-notify.js'
import { createBlock } from '../availability/blocks.js'
import { localTimeToUtc, localParts } from '../availability/compute.js'
import { enqueueBlockMirror, enqueueBookingMirror, enqueueBookingDeletion } from '../../workers/calendar-mirror.js'
import { colorWordToGoogleId } from './color-vocab.js'
import { findProviderByName } from '../provider/lookup.js'
import { resolveReshuffleConfig, type ReshuffleConfig } from '../reshuffle/config.js'
import { clampPaymentOffsetMinutes, type PaymentLinkSendPolicy } from '../payments/timing.js'

/**
 * Deterministic writer for the reshuffle engine knobs. Merges an owner patch over the
 * current config, clamps via resolveReshuffleConfig, persists, and audits. The owner sets
 * these conversationally through the `configureReshuffle` orchestrator tool.
 */
export async function applyReshuffleConfigUpdate(
  database: Db,
  businessId: string,
  patch: Record<string, unknown>,
  actorId?: string,
): Promise<{ ok: true; config: ReshuffleConfig } | { ok: false; reason: string }> {
  const [biz] = await database.select({ cfg: businesses.reshuffleConfig }).from(businesses).where(eq(businesses.id, businessId)).limit(1)
  if (!biz) return { ok: false, reason: 'business_not_found' }

  const merged = resolveReshuffleConfig({ ...resolveReshuffleConfig(biz.cfg), ...patch })
  await database.update(businesses).set({ reshuffleConfig: merged as unknown as Record<string, unknown> }).where(eq(businesses.id, businessId))
  await logAudit(database, {
    businessId,
    actorId: actorId ?? null,
    action: 'reshuffle.config_updated',
    entityType: 'business',
    entityId: businessId,
    metadata: merged as unknown as Record<string, unknown>,
  })
  return { ok: true, config: merged }
}

/**
 * Deterministic writer for the owner-configurable pay-link send timing (Grow Phase 3, §3.1).
 * 'at_booking' clears any offset (send as soon as the booking enters pending_payment, today's
 * behavior); 'offset' pins a clamped minute offset vs slot_start (negative = before, positive
 * = after). The owner sets this conversationally via the `configurePaymentTiming` tool; the
 * payment-request worker reads it. Persists + audits.
 */
export async function applyPaymentTimingUpdate(
  database: Db,
  businessId: string,
  input: { policy: PaymentLinkSendPolicy; offsetMinutes?: number | null },
  actorId?: string,
): Promise<{ ok: true; policy: PaymentLinkSendPolicy; offsetMinutes: number | null } | { ok: false; reason: string }> {
  const [biz] = await database.select({ id: businesses.id }).from(businesses).where(eq(businesses.id, businessId)).limit(1)
  if (!biz) return { ok: false, reason: 'business_not_found' }

  let policy: PaymentLinkSendPolicy
  let offsetMinutes: number | null
  if (input.policy === 'offset') {
    if (input.offsetMinutes == null || !Number.isFinite(input.offsetMinutes)) {
      return { ok: false, reason: 'missing_offset' }
    }
    policy = 'offset'
    offsetMinutes = clampPaymentOffsetMinutes(input.offsetMinutes)
  } else {
    // 'at_booking' has no offset — null it out so the worker takes the always-due path.
    policy = 'at_booking'
    offsetMinutes = null
  }

  await database
    .update(businesses)
    .set({ paymentLinkSendPolicy: policy, paymentLinkOffsetMinutes: offsetMinutes })
    .where(eq(businesses.id, businessId))
  await logAudit(database, {
    businessId,
    actorId: actorId ?? null,
    action: 'payment.timing_updated',
    entityType: 'business',
    entityId: businessId,
    metadata: { policy, offsetMinutes },
  })
  return { ok: true, policy, offsetMinutes }
}

// Bilingual day names (Sun=0 … Sat=6)
function dayName(dayOfWeek: number | null | undefined, lang: Lang): string {
  if (dayOfWeek === null || dayOfWeek === undefined) return lang === 'he' ? 'אותו יום' : 'that day'
  const daysHe = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת']
  const daysEn = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  return (lang === 'he' ? daysHe : daysEn)[dayOfWeek] ?? (lang === 'he' ? 'אותו יום' : 'that day')
}

/**
 * Business-local calendar-day bounds as absolute UTC instants.
 * Returns [dayStart, dayEndExclusive) so a query uses gte(start) && lt(endExcl).
 * Uses localTimeToUtc (DST-correct) — never `${date}T00:00:00Z`, which is UTC midnight.
 */
function localDayBounds(dateStr: string, tz: string): { dayStart: Date; dayEndExclusive: Date } {
  const dayStart = localTimeToUtc(dateStr, '00:00', tz)
  const [y, m, d] = dateStr.split('-').map(Number)
  const next = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + 1))
  const nextStr = next.toISOString().slice(0, 10)
  const dayEndExclusive = localTimeToUtc(nextStr, '00:00', tz)
  return { dayStart, dayEndExclusive }
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
  // Owner-configurable booking model: 'class' = group, schedule-driven; 'appointment' = private 1-on-1.
  schedulingMode: z.enum(['class', 'appointment']).nullable().optional(),
  // Raw owner color word ("blue", "כחול") → mapped to a Google colorId by color-vocab.
  color: z.string().nullable().optional(),
  // Set by the LLM only when the owner confirms a previously-warned destructive switch.
  confirm: z.boolean().optional(),
})

const permissionChangeSchema = z.object({
  action: z.enum(['grant', 'revoke']),
  phoneNumber: z.string(),
  displayName: z.string().optional(),
})

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/

const recurringClassChangeSchema = z.object({
  action: z.enum(['create', 'stop', 'cancel_occurrence']),
  // Service the recurring class instances (matched by name, case-insensitive).
  serviceName: z.string().optional(),
  dayOfWeek: z.coerce.number().int().min(0).max(6).nullable().optional(),
  startTime: z.string().regex(TIME_REGEX, 'startTime must be HH:MM').nullable().optional(),
  durationMinutes: z.coerce.number().int().positive().nullable().optional(),
  maxParticipants: z.coerce.number().int().positive().nullable().optional(),
  startDate: z.string().regex(DATE_REGEX, 'startDate must be YYYY-MM-DD').nullable().optional(),
  endDate: z.string().regex(DATE_REGEX, 'endDate must be YYYY-MM-DD').nullable().optional(),
  occurrenceDate: z.string().regex(DATE_REGEX, 'occurrenceDate must be YYYY-MM-DD').nullable().optional(),
  providerHint: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
})

const weeklyHoursSchema = z.object({
  dayOfWeek: z.coerce.number().int().min(0).max(6),
  startTime: z.string().regex(TIME_REGEX, 'startTime must be HH:MM'),
  endTime: z.string().regex(TIME_REGEX, 'endTime must be HH:MM'),
})

const providerChangeSchema = z.object({
  action: z.enum(['add', 'set_hours', 'assign_service', 'unassign_service', 'remove']),
  instructorName: z.string().min(1),
  phone: z.string().nullable().optional(),
  serviceNames: z.array(z.string()).optional(),
  weeklyHours: z.array(weeklyHoursSchema).optional(),
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
  auth?: { role: IdentityRole; permissions?: Set<Action> },
): Promise<ApplyResult> {
  // Permission gate: a delegated_user may only apply changes the owner granted
  // them. Managers always pass; customers never reach this seam. This is the
  // deterministic enforcement point for owner-declared staff capabilities.
  if (auth && auth.role === 'delegated_user') {
    const required = requiredActionForInstruction(instructionType)
    if (required && !(auth.permissions?.has(required) ?? false)) {
      const reason = lang === 'he'
        ? 'אין לך הרשאה לבצע את השינוי הזה. בקש/י מבעל/ת העסק.'
        : "You don't have permission to make that change — ask the business owner."
      await db
        .update(managerInstructions)
        .set({ applyStatus: 'failed', appliedAt: null })
        .where(eq(managerInstructions.id, instructionId))
      return { ok: false, reason }
    }
  }

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
    case 'recurring_class_change':
      result = await applyRecurringClassChange(db, businessId, actorId, structuredParams, lang)
      break
    case 'provider_change':
      result = await applyProviderChange(db, businessId, actorId, structuredParams, lang)
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

  // Business-local timezone — affected-booking day windows and out-of-hours
  // comparisons below must use this, never server-UTC, or off-zero businesses
  // detect the wrong bookings as affected by a block / hours change.
  const [tzRow] = await db
    .select({ timezone: businesses.timezone })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .limit(1)
  const bizTz = tzRow?.timezone ?? 'UTC'

  // Intra-day block (a specific date with explicit start/end times) is a
  // time-ranged block, not a whole-day closure. It lives in calendar_blocks, not
  // the availability table — this is what makes "block 2–4pm Tuesday" possible
  // (CALENDAR_UX_DESIGN.md §4). Whole-day blocks (no times) keep the old path.
  if (p.action === 'block' && p.specificDate && p.openTime && p.closeTime) {
    return applyIntradayBlock(db, businessId, actorId, p.specificDate, p.openTime, p.closeTime, p.reason ?? null, lang)
  }

  if (p.action === 'block' || p.action === 'bulk_close') {
    // For specific-date blocks, check for affected confirmed bookings first
    if (p.specificDate) {
      const { dayStart, dayEndExclusive } = localDayBounds(p.specificDate, bizTz)
      const affected = await db
        .select({ id: bookings.id, customerId: bookings.customerId, slotStart: bookings.slotStart, calendarEventId: bookings.calendarEventId, providerId: bookings.providerId, serviceTypeId: bookings.serviceTypeId })
        .from(bookings)
        .where(
          and(
            eq(bookings.businessId, businessId),
            or(eq(bookings.state, 'confirmed'), eq(bookings.state, 'held')),
            gte(bookings.slotStart, dayStart),
            lt(bookings.slotStart, dayEndExclusive),
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

          // Business-originated cancel → notify the customer through the initiation spine, which
          // falls back to the booking_cancelled_by_business template when they're out of window
          // (the old free-form enqueueMessage was silently dropped by Meta for cold customers).
          await notifyBusinessBookingChange(db, businessId, {
            kind: 'cancelled',
            bookingId: booking.id,
            customerId: booking.customerId,
            serviceTypeId: booking.serviceTypeId,
            slotStart: booking.slotStart,
          })
        }

        // Notify the instructor(s) of any cancelled sessions (deduped per session).
        await notifyInstructorsOfCancelledBookings(db, {
          businessId,
          lang,
          actorId,
          cancelled: affected.map((b) => ({ providerId: b.providerId, serviceTypeId: b.serviceTypeId, slotStart: b.slotStart })),
        }).catch(() => { /* non-fatal */ })
      }
    }

    if (p.action === 'bulk_close' && p.dateRangeStart && p.dateRangeEnd) {
      // Block each calendar day in the range. Iterate purely on the UTC calendar
      // (getUTCDate, not getDate) so the date strings never drift on a non-UTC server.
      const start = new Date(`${p.dateRangeStart}T00:00:00Z`)
      const end = new Date(`${p.dateRangeEnd}T00:00:00Z`)
      for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
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
    const { dayStart, dayEndExclusive } = localDayBounds(p.specificDate, bizTz)
    const affectedByHoursChange = await db
      .select({ id: bookings.id, slotStart: bookings.slotStart })
      .from(bookings)
      .where(
        and(
          eq(bookings.businessId, businessId),
          or(eq(bookings.state, 'confirmed'), eq(bookings.state, 'held')),
          gte(bookings.slotStart, dayStart),
          lt(bookings.slotStart, dayEndExclusive),
        ),
      )

    const outsideHours = affectedByHoursChange.filter((b) => {
      // Compare in business-local minutes — newOpen/newClose are local 'HH:MM'.
      const slotMs = localParts(b.slotStart, bizTz).minutes * 60_000
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
  actorId: string,
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
    .select({ id: bookings.id, customerId: bookings.customerId, slotStart: bookings.slotStart, calendarEventId: bookings.calendarEventId, providerId: bookings.providerId, serviceTypeId: bookings.serviceTypeId })
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

    // Business-originated cancel → notify through the spine (booking_cancelled_by_business
    // template fallback out of window; the old free-form send was dropped for cold customers).
    await notifyBusinessBookingChange(db, businessId, {
      kind: 'cancelled',
      bookingId: booking.id,
      customerId: booking.customerId,
      serviceTypeId: booking.serviceTypeId,
      slotStart: booking.slotStart,
    })
  }

  // Notify the instructor(s) of any cancelled sessions inside the blocked window (deduped
  // per session — a range can span several classes with different instructors).
  const instructorsNotified = await notifyInstructorsOfCancelledBookings(db, {
    businessId,
    lang,
    actorId,
    cancelled: affected.map((b) => ({ providerId: b.providerId, serviceTypeId: b.serviceTypeId, slotStart: b.slotStart })),
  }).catch(() => 0)

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

  const instructorNote = instructorsNotified > 0
    ? (lang === 'he' ? ` ${instructorsNotified} מדריך/ים עודכנו.` : ` ${instructorsNotified} instructor(s) notified.`)
    : ''
  const affectedNote = affected.length > 0
    ? (lang === 'he' ? ` ${affected.length} תורים בוטלו והלקוחות עודכנו.${instructorNote}` : ` ${affected.length} booking(s) were cancelled and customers notified.${instructorNote}`)
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
    .select({
      id: serviceTypes.id,
      maxParticipants: serviceTypes.maxParticipants,
      schedulingMode: serviceTypes.schedulingMode,
      colorId: serviceTypes.colorId,
    })
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

  // Calendar color: owner says a color word → nearest of Google's 11 colors. An
  // unrecognised word isn't applied — we ask which color instead. A real change
  // also triggers a re-mirror so already-pushed events recolor (see below).
  let colorChanged = false
  if (p.color != null && p.color.trim().length > 0) {
    const colorId = colorWordToGoogleId(p.color)
    if (colorId === null) {
      return { ok: false, reason: i18n.apply_service_color_unknown[lang](p.color) }
    }
    updates.colorId = colorId
    colorChanged = colorId !== (existing.colorId ?? null)
  }

  // Scheduling mode (class ↔ appointment). Consequential switches are guarded.
  let modeMessage: string | null = null
  if (p.schedulingMode === 'class') {
    // A class needs a real group capacity — don't silently keep cap=1.
    const currentCap = existing.maxParticipants ?? 1
    if (p.maxParticipants == null && currentCap <= 1) {
      return { ok: false, reason: i18n.schedule_private_service_needs_capacity[lang](p.name) }
    }
    updates.schedulingMode = 'class'
    // It's class-mode but unbookable until a schedule exists — nudge if there's none.
    const activeSeries = await db
      .select({ id: classSeries.id })
      .from(classSeries)
      .where(and(eq(classSeries.businessId, businessId), eq(classSeries.serviceTypeId, existing.id), eq(classSeries.isActive, true)))
    modeMessage = activeSeries.length > 0
      ? i18n.apply_service_mode_class_set[lang](p.name)
      : i18n.apply_service_mode_class_no_series[lang](p.name)
  } else if (p.schedulingMode === 'appointment') {
    const now = new Date()
    const activeSeries = await db
      .select({ id: classSeries.id })
      .from(classSeries)
      .where(and(eq(classSeries.businessId, businessId), eq(classSeries.serviceTypeId, existing.id), eq(classSeries.isActive, true)))
    const [bookedRow] = await db
      .select({ n: count() })
      .from(bookings)
      .where(and(
        eq(bookings.businessId, businessId),
        eq(bookings.serviceTypeId, existing.id),
        eq(bookings.state, 'confirmed'),
        gt(bookings.slotStart, now),
      ))
    const bookedCount = bookedRow?.n ?? 0
    // Consequential switch: stops the weekly classes. Warn once, apply on confirm.
    if ((activeSeries.length > 0 || bookedCount > 0) && !p.confirm) {
      return { ok: false, reason: i18n.apply_service_mode_appointment_warn[lang](p.name, bookedCount) }
    }
    updates.schedulingMode = 'appointment'
    updates.maxParticipants = 1
    // Stop future materialization; booked instances + existing bookings are kept.
    for (const s of activeSeries) {
      await stopSeries(db, s.id)
    }
    modeMessage = i18n.apply_service_mode_appointment_set[lang](p.name)
  }

  if (Object.keys(updates).length > 0) {
    await db.update(serviceTypes).set(updates).where(eq(serviceTypes.id, existing.id))
  }

  // Re-mirror so existing Google events pick up the new color. Best-effort; the
  // integrity sentinel reconciles anything that fails to enqueue.
  if (colorChanged) {
    const now = new Date()
    const futureBlocks = await db
      .select({ id: calendarBlocks.id })
      .from(calendarBlocks)
      .where(and(
        eq(calendarBlocks.businessId, businessId),
        eq(calendarBlocks.serviceTypeId, existing.id),
        eq(calendarBlocks.type, 'class'),
        gt(calendarBlocks.startTs, now),
      ))
    const futureBookings = await db
      .select({ id: bookings.id })
      .from(bookings)
      .where(and(
        eq(bookings.businessId, businessId),
        eq(bookings.serviceTypeId, existing.id),
        eq(bookings.state, 'confirmed'),
        gt(bookings.slotStart, now),
      ))
    await Promise.all([
      ...futureBlocks.map((b) => enqueueBlockMirror(businessId, b.id)),
      ...futureBookings.map((b) => enqueueBookingMirror(businessId, b.id)),
    ]).catch(() => { /* non-fatal — sentinel reconciles */ })
  }

  let confirmationMessage: string
  if (modeMessage) {
    confirmationMessage = colorChanged ? `${modeMessage} ${i18n.apply_service_color_set[lang](p.name)}` : modeMessage
  } else if (p.color != null && p.color.trim().length > 0) {
    confirmationMessage = i18n.apply_service_color_set[lang](p.name)
  } else {
    confirmationMessage = i18n.apply_service_updated[lang](p.name)
  }

  return { ok: true, confirmationMessage }
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

    // Resolve the identity (existing or just-created) and ensure it is an active
    // delegated_user, then persist WHICH actions the owner is delegating so the
    // grant survives restarts and is enforced deterministically at the apply seam.
    const [granted] = await db
      .select({ id: identities.id })
      .from(identities)
      .where(and(eq(identities.businessId, businessId), eq(identities.phoneNumber, p.phoneNumber)))
      .limit(1)
    if (granted) {
      await db
        .update(identities)
        .set({ role: 'delegated_user', revokedAt: null, grantedBy: actorId, grantedAt: new Date() })
        .where(eq(identities.id, granted.id))
      await grantDelegatedPermissions(db, businessId, granted.id, DEFAULT_DELEGATED_CALENDAR_ACTIONS, actorId)
    }
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
  await revokeAllDelegatedPermissions(db, target.id)

  return { ok: true, confirmationMessage: i18n.apply_permission_revoked[lang](p.displayName ?? p.phoneNumber) }
}

// ── Recurring class change ──────────────────────────────────────────────────
// Recurrence is a scheduling primitive (affects what customers can book and when),
// so it flows through the apply pipeline per MULTI_AGENT_DESIGN.md §1.7 — never a
// direct tool write. The deterministic series engine lives in domain/scheduling.

async function applyRecurringClassChange(
  db: Db,
  businessId: string,
  _actorId: string,
  params: Record<string, unknown>,
  lang: Lang = 'he',
): Promise<ApplyResult> {
  const parsed = recurringClassChangeSchema.safeParse(params)
  if (!parsed.success) {
    return { ok: false, reason: `Invalid recurring class params: ${parsed.error.message}` }
  }
  const p = parsed.data

  const [biz] = await db.select({ timezone: businesses.timezone }).from(businesses).where(eq(businesses.id, businessId)).limit(1)
  const tz = biz?.timezone ?? 'UTC'

  // Resolve the service this class instances (by name, case-insensitive).
  async function resolveService() {
    if (!p.serviceName) return null
    const [svc] = await db
      .select({ id: serviceTypes.id, name: serviceTypes.name, durationMinutes: serviceTypes.durationMinutes, maxParticipants: serviceTypes.maxParticipants })
      .from(serviceTypes)
      .where(and(eq(serviceTypes.businessId, businessId), eq(serviceTypes.isActive, true), ilike(serviceTypes.name, p.serviceName)))
      .limit(1)
    return svc ?? null
  }

  if (p.action === 'create') {
    if (p.dayOfWeek === null || p.dayOfWeek === undefined || !p.startTime) {
      return { ok: false, reason: lang === 'he' ? 'יצירת שיעור קבוע דורשת יום ושעה.' : 'Creating a recurring class requires a day and a start time.' }
    }
    const svc = await resolveService()
    if (!svc) {
      return { ok: false, reason: lang === 'he' ? `לא מצאתי שירות בשם "${p.serviceName ?? ''}".` : `No service named "${p.serviceName ?? ''}" found.` }
    }
    // Guard: a private (1-on-1) service must not become a cap=1 weekly class
    // without an explicit group capacity — that materializes class instances that
    // double-list with private openings (WS-C). Ask for the group size instead.
    if ((svc.maxParticipants ?? 1) <= 1 && (p.maxParticipants == null || p.maxParticipants <= 1)) {
      return { ok: false, reason: i18n.schedule_private_service_needs_capacity[lang](svc.name) }
    }
    // Resolve a named instructor (explicit-add model). A hint that matches no
    // existing instructor → clarify, don't silently create a provider-less series.
    let seriesProviderId: string | null = null
    if (p.providerHint && p.providerHint.trim().length > 0) {
      const found = await findProviderByName(db, businessId, p.providerHint.trim())
      if (found.status === 'none') return { ok: false, reason: i18n.apply_provider_not_found[lang](p.providerHint.trim()) }
      if (found.status === 'ambiguous') return { ok: false, reason: i18n.apply_provider_ambiguous[lang](p.providerHint.trim()) }
      seriesProviderId = found.id
    }
    const startDate = p.startDate ?? localParts(new Date(), tz).dateStr
    const { created } = await createSeries(db, {
      businessId,
      serviceTypeId: svc.id,
      providerId: seriesProviderId,
      dayOfWeek: p.dayOfWeek,
      startTime: p.startTime,
      durationMinutes: p.durationMinutes ?? svc.durationMinutes,
      maxParticipants: p.maxParticipants ?? svc.maxParticipants ?? 1,
      title: svc.name,
      startDate,
      endDate: p.endDate ?? null,
      timezone: tz,
    })
    const dn = dayName(p.dayOfWeek, lang)
    const msg = lang === 'he'
      ? `✅ קבעתי ${svc.name} כל ${dn} ב-${p.startTime}. נוצרו ${created} מפגשים בהמשך.`
      : `✅ Set up ${svc.name} every ${dn} at ${p.startTime}. ${created} upcoming session(s) created.`
    return { ok: true, confirmationMessage: msg }
  }

  // stop / cancel_occurrence both need to locate the series.
  const svc = await resolveService()
  const seriesConds = [eq(classSeries.businessId, businessId), eq(classSeries.isActive, true)]
  if (svc) seriesConds.push(eq(classSeries.serviceTypeId, svc.id))
  if (p.dayOfWeek !== null && p.dayOfWeek !== undefined) seriesConds.push(eq(classSeries.dayOfWeek, p.dayOfWeek))
  const matches = await db.select({ id: classSeries.id }).from(classSeries).where(and(...seriesConds))

  if (matches.length === 0) {
    return { ok: false, reason: lang === 'he' ? 'לא מצאתי שיעור קבוע תואם.' : 'No matching recurring class found.' }
  }
  if (matches.length > 1) {
    return { ok: false, reason: lang === 'he' ? 'יש כמה שיעורים קבועים תואמים — איזה מהם?' : 'Several recurring classes match — which one?' }
  }
  const seriesId = matches[0]!.id

  if (p.action === 'stop') {
    const { deletedInstances } = await stopSeries(db, seriesId)
    const msg = lang === 'he'
      ? `✅ הפסקתי את השיעור הקבוע. ${deletedInstances} מפגשים עתידיים (ללא הרשמות) הוסרו.`
      : `✅ Stopped the recurring class. ${deletedInstances} future unbooked session(s) removed.`
    return { ok: true, confirmationMessage: msg }
  }

  // cancel_occurrence
  if (!p.occurrenceDate) {
    return { ok: false, reason: lang === 'he' ? 'ביטול מפגש בודד דורש תאריך.' : 'Cancelling a single session requires a date.' }
  }
  await cancelOccurrence(db, seriesId, p.occurrenceDate, p.reason ?? null)
  const msg = lang === 'he'
    ? `✅ ביטלתי את המפגש בתאריך ${p.occurrenceDate}. שאר השיעורים הקבועים נשארים.`
    : `✅ Cancelled the session on ${p.occurrenceDate}. The rest of the recurring series stays.`
  return { ok: true, confirmationMessage: msg }
}

// ── Policy change ─────────────────────────────────────────────────────────────

const policyChangeSchema = z.object({
  subtype: z.enum(['cancellation_cutoff', 'booking_buffer', 'max_days_ahead', 'cancellation_fee', 'booking_authority', 'other']),
  valueHours: z.coerce.number().nonnegative().nullable().optional(),
  valueDays: z.coerce.number().int().positive().nullable().optional(),
  valueAmount: z.coerce.number().nonnegative().nullable().optional(),
  valueMode: z.enum(['auto', 'owner_approval']).nullable().optional(),
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

    case 'booking_authority': {
      // Per-business booking authority (design 2026-06-25). Governs only PA/owner-initiated
      // bookings; customer self-bookings are never gated. Default to owner_approval when the
      // mode is somehow missing — the safe side is "ask the owner first".
      const mode = p.valueMode ?? 'owner_approval'
      await db
        .update(businesses)
        .set({ bookingAuthority: mode })
        .where(eq(businesses.id, businessId))
      await logAudit(db, { businessId, actorId, action: 'policy.booking_authority_updated', entityType: 'business', entityId: businessId, afterState: { bookingAuthority: mode } })
      return { ok: true, confirmationMessage: i18n.apply_policy_booking_authority[lang](mode) }
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

  // Business-originated cancel → notify through the spine, which falls back to the
  // booking_cancelled_by_business template when the customer is out of window (the old free-form
  // enqueueMessage was silently dropped by Meta for cold customers).
  await notifyBusinessBookingChange(db, businessId, {
    kind: 'cancelled',
    bookingId: bookingRow.id,
    customerId: bookingRow.customerId,
    serviceTypeId: bookingRow.serviceTypeId,
    slotStart: bookingRow.slotStart,
  })

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

// ── Provider (instructor) change ──────────────────────────────────────────────

/** Build a synthetic, unique, non-null placeholder phone for a name-only instructor. */
function syntheticProviderPhone(): string {
  return `provider:${randomUUID()}@local`
}

/** Resolve a service name (case-insensitive) to its id within the business. */
async function findServiceByName(db: Db, businessId: string, name: string): Promise<{ id: string; name: string } | null> {
  const [svc] = await db
    .select({ id: serviceTypes.id, name: serviceTypes.name })
    .from(serviceTypes)
    .where(and(eq(serviceTypes.businessId, businessId), ilike(serviceTypes.name, name), eq(serviceTypes.isActive, true)))
    .limit(1)
  return svc ?? null
}

/** Human-readable hours fragment for confirmations, e.g. " (Mon 09:00–13:00, Wed 09:00–13:00)". */
function hoursFragment(weeklyHours: { dayOfWeek: number; startTime: string; endTime: string }[], lang: Lang): string {
  if (weeklyHours.length === 0) return ''
  const parts = weeklyHours.map((h) => `${dayName(h.dayOfWeek, lang)} ${h.startTime}–${h.endTime}`)
  return ` (${parts.join(', ')})`
}

export async function applyProviderChange(
  db: Db,
  businessId: string,
  actorId: string,
  params: Record<string, unknown>,
  lang: Lang = 'he',
): Promise<ApplyResult> {
  const parsed = providerChangeSchema.safeParse(params)
  if (!parsed.success) {
    return { ok: false, reason: `Invalid provider params: ${parsed.error.message}` }
  }
  const p = parsed.data

  if (p.action === 'add') {
    // Resolve services first — unknown service → clarify, do not auto-create.
    const serviceNames = p.serviceNames ?? []
    const services: { id: string; name: string }[] = []
    for (const name of serviceNames) {
      const svc = await findServiceByName(db, businessId, name)
      if (!svc) return { ok: false, reason: i18n.apply_provider_service_not_found[lang](name) }
      services.push(svc)
    }

    // Find-or-create the provider identity (by display name).
    const existing = await findProviderByName(db, businessId, p.instructorName)
    if (existing.status === 'ambiguous') return { ok: false, reason: i18n.apply_provider_ambiguous[lang](p.instructorName) }

    let providerId: string
    if (existing.status === 'found') {
      providerId = existing.id
    } else {
      const phone = p.phone && p.phone.trim().length > 0 ? p.phone.trim() : syntheticProviderPhone()
      const [created] = await db.insert(identities).values({
        businessId,
        phoneNumber: phone,
        role: 'provider',
        displayName: p.instructorName,
        messagingOptOut: !(p.phone && p.phone.trim().length > 0), // name-only → no notifications
        grantedBy: actorId,
        grantedAt: new Date(),
      }).onConflictDoNothing().returning({ id: identities.id })
      if (created) {
        providerId = created.id
      } else {
        // Conflict on (businessId, phoneNumber) — fetch the existing row.
        const [row] = await db.select({ id: identities.id }).from(identities)
          .where(and(eq(identities.businessId, businessId), eq(identities.phoneNumber, phone))).limit(1)
        providerId = row!.id
      }
    }

    // Assign services (idempotent on the unique (identityId, serviceTypeId) index).
    for (const svc of services) {
      await db.insert(providerAssignments).values({
        businessId, identityId: providerId, serviceTypeId: svc.id, isActive: true,
      }).onConflictDoUpdate({
        target: [providerAssignments.identityId, providerAssignments.serviceTypeId],
        set: { isActive: true },
      })
    }

    // Set weekly availability (replace any existing weekly rows for this provider).
    if (p.weeklyHours && p.weeklyHours.length > 0) {
      await db.delete(availability).where(and(
        eq(availability.providerId, providerId),
        isNull(availability.specificDate), // weekly rows only — leave date-specific blocks
      ))
      for (const h of p.weeklyHours) {
        await db.insert(availability).values({
          businessId, providerId, dayOfWeek: h.dayOfWeek, openTime: h.startTime, closeTime: h.endTime, isBlocked: false,
        })
      }
    }

    const servicesStr = services.map((s) => s.name).join(', ')
    return { ok: true, confirmationMessage: i18n.apply_provider_added[lang](p.instructorName, servicesStr, hoursFragment(p.weeklyHours ?? [], lang)) }
  }

  // All non-add actions operate on an existing provider.
  const found = await findProviderByName(db, businessId, p.instructorName)
  if (found.status === 'ambiguous') return { ok: false, reason: i18n.apply_provider_ambiguous[lang](p.instructorName) }
  if (found.status === 'none') return { ok: false, reason: i18n.apply_provider_not_found[lang](p.instructorName) }
  const providerId = found.id

  if (p.action === 'set_hours') {
    await db.delete(availability).where(and(eq(availability.providerId, providerId), isNull(availability.specificDate)))
    for (const h of p.weeklyHours ?? []) {
      await db.insert(availability).values({
        businessId, providerId, dayOfWeek: h.dayOfWeek, openTime: h.startTime, closeTime: h.endTime, isBlocked: false,
      })
    }
    return { ok: true, confirmationMessage: i18n.apply_provider_hours_set[lang](p.instructorName, hoursFragment(p.weeklyHours ?? [], lang)) }
  }

  if (p.action === 'assign_service' || p.action === 'unassign_service') {
    const names = p.serviceNames ?? []
    if (names.length === 0) return { ok: false, reason: i18n.apply_provider_service_not_found[lang]('') }
    const setActive = p.action === 'assign_service'
    const done: string[] = []
    for (const name of names) {
      const svc = await findServiceByName(db, businessId, name)
      if (!svc) return { ok: false, reason: i18n.apply_provider_service_not_found[lang](name) }
      await db.insert(providerAssignments).values({
        businessId, identityId: providerId, serviceTypeId: svc.id, isActive: setActive,
      }).onConflictDoUpdate({
        target: [providerAssignments.identityId, providerAssignments.serviceTypeId],
        set: { isActive: setActive },
      })
      done.push(svc.name)
    }
    const msg = setActive
      ? i18n.apply_provider_assigned[lang](p.instructorName, done.join(', '))
      : i18n.apply_provider_unassigned[lang](p.instructorName, done.join(', '))
    return { ok: true, confirmationMessage: msg }
  }

  // remove
  await db.update(providerAssignments).set({ isActive: false }).where(eq(providerAssignments.identityId, providerId))
  return { ok: true, confirmationMessage: i18n.apply_provider_removed[lang](p.instructorName) }
}
