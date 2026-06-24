// Win-back proposal builder — PURE. Given one lapsed-customer summary (already
// cadence-overshot by the Phase-2 segment reader), decide whether they're a sensible
// win-back candidate and, if so, shape the owner-facing proposal + the eventual
// customer-facing copy. No I/O: the worker (workers/winback.ts) fetches the segment and
// feeds each summary here, then hands a non-null result to proposeInitiation (the
// owner-confirm gate). The customer is NEVER messaged from here — only proposed.
//
// Mirrors the pure-core discipline of customer-profile.ts / coordination/state.ts: a
// truth-table-testable decision, no DB, no clock beyond the injected `now`.

import type { CustomerSummary } from '../../shared/skill-types.js'

// Don't chase ancient one-timers: a last visit older than this is a cold lead, not a
// lapse worth a friendly check-in.
const MAX_RECENCY_DAYS = 180

// A chronic no-show is not someone to re-invite proactively.
const MAX_NO_SHOW_RATE = 0.5

const MS_PER_DAY = 86_400_000

/** Day-bucket a date to its UTC epoch-day. Keying the dedup on the last-visit day means a
 *  win-back is proposed once per lapse episode: while lastBookingAt is unchanged the key is
 *  stable; if the customer returns (new lastBookingAt) a future lapse gets a fresh key. */
export function epochDay(d: Date): number {
  return Math.floor(d.getTime() / MS_PER_DAY)
}

export interface WinbackProposal {
  dedupKey: string
  ownerSummary: string // manager-facing, business default language
  situation: string // customer-facing intent → LLM phrasing at send time (post-approval)
  fallback: string // customer-facing copy if the LLM is unavailable
}

/**
 * Build a win-back proposal for a lapsed customer, or null to skip. Skip when there's no
 * established last visit, the last visit is older than MAX_RECENCY_DAYS (ancient one-timer),
 * or the customer is a chronic no-show (noShowRate ≥ MAX_NO_SHOW_RATE).
 */
export function buildWinbackProposal(
  summary: CustomerSummary,
  businessName: string,
  lang: 'he' | 'en',
  now: Date,
): WinbackProposal | null {
  const last = summary.lastBookingAt
  if (!last) return null

  const daysSince = Math.floor((now.getTime() - last.getTime()) / MS_PER_DAY)
  if (daysSince > MAX_RECENCY_DAYS) return null

  if ((summary.noShowRate ?? 0) >= MAX_NO_SHOW_RATE) return null

  const dedupKey = `churn.winback:${summary.identityId}:${epochDay(last)}`

  // A neutral name so the owner summary reads naturally even without a stored displayName.
  const name = summary.displayName?.trim()
    ? summary.displayName.trim()
    : lang === 'he'
      ? 'הלקוח/ה'
      : 'this customer'
  const cadence = summary.cadenceDays ?? null
  const instructor = summary.preferredProviderName?.trim() || null

  const ownerSummary =
    lang === 'he'
      ? buildOwnerSummaryHe(name, cadence, daysSince)
      : buildOwnerSummaryEn(name, cadence, daysSince)

  // When we know the customer's usual instructor, name them — a far warmer, higher-converting
  // framing than a generic business-level check-in.
  const withInstructorHe = instructor ? ` הלקוח/ה בדרך כלל מגיע/ה ל${instructor} — אפשר להזכיר את זה אם זה משתלב טבעי.` : ''
  const withInstructorEn = instructor ? ` They usually come to ${instructor} — mention that if it fits naturally.` : ''

  const situation =
    lang === 'he'
      ? `יצירת קשר חמה לחזרת לקוח/ה שלא ביקר/ה כבר ${daysSince} ימים אצל ${businessName}. להזכיר שהתגעגענו ולהזמין בעדינות לחזור — בלי לבקש תגובת אישור, בלי לחץ.${withInstructorHe}`
      : `Warm win-back outreach to a customer who hasn't visited ${businessName} in ${daysSince} days. Let them know we've missed them and would love to see them back — gentle, no confirmation-word demand, no pressure.${withInstructorEn}`

  const fallback =
    lang === 'he'
      ? `היי! מ${businessName} — התגעגענו אליך. נשמח לראות אותך שוב בקרוב 😊`
      : `Hi! It's ${businessName} — we've missed you and would love to see you back soon 😊`

  return { dedupKey, ownerSummary, situation, fallback }
}

function buildOwnerSummaryEn(name: string, cadence: number | null, daysSince: number): string {
  const rhythm = cadence != null
    ? `${name} usually books about every ${cadence} days but hasn't been in for ~${daysSince} days.`
    : `${name} hasn't been in for ~${daysSince} days.`
  return `${rhythm} Want me to send a friendly check-in? Just say yes or no.`
}

function buildOwnerSummaryHe(name: string, cadence: number | null, daysSince: number): string {
  const rhythm = cadence != null
    ? `${name} בדרך כלל קובע/ת בערך כל ${cadence} ימים, אבל לא ביקר/ה כבר ~${daysSince} ימים.`
    : `${name} לא ביקר/ה כבר ~${daysSince} ימים.`
  return `${rhythm} שאשלח הודעת התעניינות חמה? פשוט תגיד/י כן או לא.`
}
