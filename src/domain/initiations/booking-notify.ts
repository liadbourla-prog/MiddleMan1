// Business-originated booking notifications (Tier 2; template catalog #23–25). When the BUSINESS
// (not the customer) cancels, books-for, or moves a customer's appointment, the customer didn't
// initiate the change and may well be outside the 24-hour window — so a plain free-form send is
// silently dropped by Meta. These helpers route each change through the initiation spine: in-window
// they phrase a warm free-form note; out-of-window they fall back to the approved Utility template.
//
// Transactional + owner_commanded: the owner's action is the trigger and the notice is essential,
// so the gate bypasses opt-out/quiet hours but still enforces in-window-only. Per-event dedupKey
// (the change is the event) keeps re-ticks idempotent without blocking a genuine later change.

import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { businesses, identities, serviceTypes } from '../../db/schema.js'
import { type Lang } from '../i18n/t.js'
import { generateProactiveCustomerMessage } from '../../adapters/llm/client.js'
import { sendTemplateMessage } from '../../adapters/whatsapp/sender.js'
import { bodyComponents } from '../../adapters/whatsapp/templates.js'
import { enqueueMessage } from '../../workers/message-retry.js'
import { dispatchInitiation } from './dispatch.js'
import { getInitiator } from './registry.js'
import { resolveNotificationAction, type NotificationRule } from './notification-rules.js'
import type { NotificationPreferences } from '../../shared/skill-types.js'

export type BusinessBookingChange =
  | { kind: 'cancelled'; bookingId: string; customerId: string; serviceTypeId: string | null; slotStart: Date }
  | { kind: 'confirmed'; bookingId: string; customerId: string; serviceTypeId: string | null; slotStart: Date }
  | { kind: 'moved'; bookingId: string; customerId: string; serviceTypeId: string | null; fromSlotStart: Date; slotStart: Date }

const INITIATOR_FOR_KIND = {
  cancelled: 'booking.cancelled_by_business',
  confirmed: 'booking.confirmation',
  moved: 'booking.moved_by_business',
} as const

/**
 * Notify a customer that the BUSINESS changed their booking. Best-effort: loads the facts it
 * needs, then dispatches through the gate. Never throws (callers fire-and-forget after the
 * deterministic write has already succeeded — a notification failure must not roll it back).
 */
export async function notifyBusinessBookingChange(db: Db, businessId: string, change: BusinessBookingChange): Promise<void> {
  try {
    const [biz] = await db
      .select({
        name: businesses.name,
        timezone: businesses.timezone,
        defaultLanguage: businesses.defaultLanguage,
        whatsappPhoneNumberId: businesses.whatsappPhoneNumberId,
        whatsappAccessToken: businesses.whatsappAccessToken,
      })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1)
    if (!biz) return

    const [customer] = await db
      .select({ phoneNumber: identities.phoneNumber, preferredLanguage: identities.preferredLanguage })
      .from(identities)
      .where(eq(identities.id, change.customerId))
      .limit(1)
    if (!customer) return

    let serviceName: string | null = null
    if (change.serviceTypeId) {
      const [svc] = await db
        .select({ name: serviceTypes.name })
        .from(serviceTypes)
        .where(eq(serviceTypes.id, change.serviceTypeId))
        .limit(1)
      serviceName = svc?.name ?? null
    }

    const lang: Lang = (customer.preferredLanguage as Lang | null | undefined) ?? (biz.defaultLanguage as Lang | null | undefined) ?? 'he'
    const locale = lang === 'he' ? 'he-IL' : 'en-GB'
    const fmtDate = (d: Date) => new Intl.DateTimeFormat(locale, { timeZone: biz.timezone, weekday: 'long', day: 'numeric', month: 'long' }).format(d)
    const fmtTime = (d: Date) => new Intl.DateTimeFormat(locale, { timeZone: biz.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
    const fmtDateTime = (d: Date) => `${fmtDate(d)} ${fmtTime(d)}`
    const service = serviceName ?? (lang === 'he' ? 'התור שלך' : 'your appointment')

    const waCredentials = biz.whatsappPhoneNumberId && biz.whatsappAccessToken
      ? { accessToken: biz.whatsappAccessToken, phoneNumberId: biz.whatsappPhoneNumberId }
      : undefined

    // Per-kind: the situation/fallback for the in-window free-form send, the positional template
    // variables, and a stable dedupKey (moves carry the new slot so a second move re-notifies).
    let situation: string
    let fallback: string
    let templateValues: string[]
    let dedupKey: string

    if (change.kind === 'cancelled') {
      const dateStr = fmtDate(change.slotStart)
      situation = `The business has cancelled the customer's "${service}" appointment on ${dateStr}. Apologise briefly for the inconvenience and offer to help find a new time. Warm, never blaming.`
      fallback = lang === 'he'
        ? `מ${biz.name}: התור שלך ל${service} בתאריך ${dateStr} בוטל. אנחנו מצטערים על אי-הנוחות — נשמח לעזור לקבוע מועד חדש 🙏`
        : `From ${biz.name}: your ${service} appointment on ${dateStr} was cancelled. Sorry for the inconvenience — we'd be glad to help you find a new time 🙏`
      templateValues = [biz.name, service, dateStr]
      dedupKey = `booking.cancelled_by_business:${change.bookingId}`
    } else if (change.kind === 'confirmed') {
      const dateStr = fmtDate(change.slotStart)
      const timeStr = fmtTime(change.slotStart)
      situation = `The business has booked a "${service}" appointment for the customer on ${dateStr} at ${timeStr}. Confirm it warmly and invite them to reply if anything needs changing.`
      fallback = lang === 'he'
        ? `מ${biz.name}: התור שלך ל${service} נקבע בהצלחה לתאריך ${dateStr} בשעה ${timeStr}. נתראה!`
        : `From ${biz.name}: your ${service} appointment is booked for ${dateStr} at ${timeStr}. See you then!`
      templateValues = [biz.name, service, dateStr, timeStr]
      dedupKey = `booking.confirmation:${change.bookingId}`
    } else {
      const currentStr = fmtDateTime(change.fromSlotStart)
      const newStr = fmtDateTime(change.slotStart)
      situation = `The business has moved the customer's "${service}" appointment from ${currentStr} to ${newStr}. Let them know warmly and invite them to reply if the new time doesn't work.`
      fallback = lang === 'he'
        ? `מ${biz.name}: התור שלך הועבר מ-${currentStr} ל-${newStr}. אם המועד החדש לא מתאים — רק תכתבו לי ונסדר 🙂`
        : `From ${biz.name}: your appointment was moved from ${currentStr} to ${newStr}. If the new time doesn't work, just message me and we'll sort it 🙂`
      templateValues = [biz.name, currentStr, newStr]
      dedupKey = `booking.moved_by_business:${change.bookingId}:${change.slotStart.toISOString()}`
    }

    await dispatchInitiation(db, getInitiator(INITIATOR_FOR_KIND[change.kind]), {
      businessId,
      recipientId: change.customerId,
      dedupKey,
    }, {
      sendFreeForm: async () => {
        const body = await generateProactiveCustomerMessage({ businessName: biz.name, language: lang, situation, fallback, timeoutMs: 2500 })
        await enqueueMessage(customer.phoneNumber, body)
      },
      sendTemplate: async (templateName) => {
        await sendTemplateMessage({
          toNumber: customer.phoneNumber,
          templateName,
          languageCode: lang === 'he' ? 'he' : 'en',
          components: bodyComponents(templateValues),
          bodyText: fallback,
          ...(waCredentials !== undefined && { credentials: waCredentials }),
        }).catch(() => { /* non-fatal — retry queue / next change handles transient failures */ })
      },
    })
  } catch (err) {
    console.error('[booking-notify] notify failed', { businessId, kind: change.kind, bookingId: change.bookingId, err: (err as Error).message })
  }
}

/**
 * Reflect a CUSTOMER self-booking to the OWNER (cross-branch consistency, 2026-06-25 design
 * §4.1.4 / INV-3 proactive). So the owner is never blind to a commitment made on the customer
 * side. Gated by the notification-rules resolver ('new_booking' → defaults to 'notify'; the owner
 * can mute/tune via configureNotifications). Owner audience, transactional, window-ungated. Routed
 * through the spine for dedup (one notice per booking) + trust-ratchet eligibility. Best-effort:
 * never throws (fire-and-forget after the booking write has already committed).
 */
export async function notifyOwnerNewBooking(
  db: Db,
  businessId: string,
  booking: { bookingId: string; customerId: string; serviceTypeId: string | null; slotStart: Date },
): Promise<void> {
  try {
    const [biz] = await db
      .select({
        name: businesses.name,
        timezone: businesses.timezone,
        defaultLanguage: businesses.defaultLanguage,
        notificationRules: businesses.notificationRules,
        notificationPreferences: businesses.notificationPreferences,
      })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1)
    if (!biz) return

    const action = resolveNotificationAction(
      (biz.notificationRules as NotificationRule[] | null) ?? null,
      (biz.notificationPreferences as NotificationPreferences | null) ?? null,
      'new_booking',
    )
    if (action === 'handle_silently') return

    // Owner notifications go to the business manager.
    const [manager] = await db
      .select({ id: identities.id, phoneNumber: identities.phoneNumber })
      .from(identities)
      .where(and(eq(identities.businessId, businessId), eq(identities.role, 'manager'), isNull(identities.revokedAt)))
      .limit(1)
    if (!manager) return

    const lang: Lang = (biz.defaultLanguage as Lang | null | undefined) ?? 'he'

    const [cust] = await db
      .select({ displayName: identities.displayName, phone: identities.phoneNumber })
      .from(identities)
      .where(eq(identities.id, booking.customerId))
      .limit(1)
    const who = cust?.displayName ?? (cust?.phone ? cust.phone.slice(-4) : (lang === 'he' ? 'לקוח' : 'a customer'))

    let serviceName: string | null = null
    if (booking.serviceTypeId) {
      const [svc] = await db
        .select({ name: serviceTypes.name })
        .from(serviceTypes)
        .where(eq(serviceTypes.id, booking.serviceTypeId))
        .limit(1)
      serviceName = svc?.name ?? null
    }

    const locale = lang === 'he' ? 'he-IL' : 'en-GB'
    const dateStr = new Intl.DateTimeFormat(locale, { timeZone: biz.timezone, weekday: 'long', day: 'numeric', month: 'long' }).format(booking.slotStart)
    const timeStr = new Intl.DateTimeFormat(locale, { timeZone: biz.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(booking.slotStart)
    const svc = serviceName ?? (lang === 'he' ? 'תור' : 'an appointment')
    const body = lang === 'he'
      ? `🟢 ${who} קבע/ה ${svc} ל${dateStr} בשעה ${timeStr}.`
      : `🟢 ${who} booked ${svc} for ${dateStr} at ${timeStr}.`

    await dispatchInitiation(db, getInitiator('booking.new_for_owner'), {
      businessId,
      recipientId: manager.id,
      dedupKey: `booking.new_for_owner:${booking.bookingId}`,
    }, {
      sendFreeForm: async () => { await enqueueMessage(manager.phoneNumber, body).catch(() => { /* non-fatal */ }) },
    }).catch(() => { /* non-fatal */ })
  } catch (err) {
    console.error('[booking-notify] owner new-booking notify failed', { businessId, bookingId: booking.bookingId, err: (err as Error).message })
  }
}
