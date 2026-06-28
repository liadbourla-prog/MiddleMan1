/**
 * Deterministic cancellation/disambiguation matching (Branch 4).
 *
 * When a customer asks to cancel and has several upcoming bookings, the flow used
 * to dump the whole list and accept ONLY a numeric pick — so a perfectly clear
 * "cancel my yoga on Friday at 12" was ignored and re-asked up to three times
 * (observed live). These pure matchers let the flow narrow candidates by the
 * service / weekday / time the customer already stated, in BOTH the initial
 * request and any free-text reply to the menu.
 *
 * Pure + synchronous: no LLM, no DB. Time matching reuses the same `HH:MM`
 * extractor the fabrication guard uses; weekday matching uses a bounded Hebrew/
 * English lexicon (NOT fuzzy NLP); service matching is token-based on the name.
 */

import { extractMentionedTimes } from './slot-fabrication-guard.js'

export interface CancelBooking {
  id: string
  slotStart: Date
  serviceTypeId: string
  serviceName: string
}

// Weekday lexicon → 0..6 (Sun..Sat). Hebrew weekday words (שני/שלישי/…) collide with
// ordinals ("the second"), so the Hebrew names ראשון–שישי are matched ONLY when
// prefixed by "יום" (day); שבת and the English names stand alone.
const EN_WEEKDAY: Array<[RegExp, number]> = [
  [/\bsun(day)?\b/i, 0], [/\bmon(day)?\b/i, 1], [/\btue(s|sday)?\b/i, 2],
  [/\bwed(nesday)?\b/i, 3], [/\bthu(r|rs|rsday)?\b/i, 4], [/\bfri(day)?\b/i, 5],
  [/\bsat(urday)?\b/i, 6],
]
const HE_WEEKDAY: Array<[RegExp, number]> = [
  [/יום\s+ראשון/, 0], [/יום\s+שני/, 1], [/יום\s+שלישי/, 2], [/יום\s+רביעי/, 3],
  [/יום\s+חמישי/, 4], [/יום\s+שישי/, 5], [/(?:יום\s+)?שבת/, 6],
]

/** The single weekday (0..6) named in `text`, or null if none / ambiguous. */
export function weekdayFromText(text: string): number | null {
  const found = new Set<number>()
  for (const [re, dow] of [...EN_WEEKDAY, ...HE_WEEKDAY]) if (re.test(text)) found.add(dow)
  return found.size === 1 ? [...found][0]! : null
}

function localTimeHHMM(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
}

function localDow(d: Date, tz: string): number {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d)
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd)
}

// Significant tokens of a service name (≥3 chars) — mirrors service-resolution.ts.
function serviceTokens(name: string): string[] {
  return name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3)
}

/**
 * Narrow `bookings` to those consistent with every criterion the customer's free
 * text states (service token, weekday, clock time). Returns [] when the text
 * states no usable criterion (so the caller keeps asking) — distinct from a
 * stated-but-unmatched filter, which also yields [].
 */
export function matchCancelBookings(text: string, bookings: CancelBooking[], tz: string): CancelBooking[] {
  const times = new Set(extractMentionedTimes(text))
  const dow = weekdayFromText(text)
  const lower = text.toLowerCase()
  const svcIds = new Set(
    bookings
      .filter((b) => serviceTokens(b.serviceName).some((tok) => lower.includes(tok)))
      .map((b) => b.serviceTypeId),
  )
  const hasTime = times.size > 0
  const hasDow = dow != null
  const hasSvc = svcIds.size > 0
  if (!hasTime && !hasDow && !hasSvc) return []

  return bookings.filter((b) => {
    if (hasTime && !times.has(localTimeHHMM(b.slotStart, tz))) return false
    if (hasDow && localDow(b.slotStart, tz) !== dow) return false
    if (hasSvc && !svcIds.has(b.serviceTypeId)) return false
    return true
  })
}
