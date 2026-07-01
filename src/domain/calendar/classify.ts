/**
 * T1.2 — deterministic certainty helpers for the inbound-translator classifier.
 *
 * The classifier auto-opens a booking WITHOUT owner approval only at 100% per-case
 * certainty (design R1, locked 2026-07-01). Certainty comes from one of two signals:
 *   1. Template/pattern match (primary) — the business already runs this class service
 *      on this weekday (see hasExistingClassSeriesOnWeekday in inbound-sync.ts).
 *   2. Structured marker (secondary) — a machine-readable description convention.
 *
 * Free-text NLP guessing is explicitly NOT certainty, and a description implying
 * pre-existing external bookings we don't hold ("2/8 booked") is a reason to ASK the
 * owner, never a green light — occupancy is always counted internally. These helpers
 * are pure so the certainty gate is unit-testable in isolation.
 */

import { normalizeServiceTitle } from './service-match.js'

/**
 * Negative/closed markers that VETO auto-open. If any appears in the (normalized)
 * title or description, the event is NEVER auto-opened — it routes to occupy-and-ASK
 * (weak_pending_confirm) regardless of any certainty signal. This is what makes a
 * private/tentative/invite-only class safe by construction. Conservative + extendable.
 * Single-word markers match as a whole token (so "household" never trips "hold");
 * multi-word phrases match as a normalized substring.
 */
const NEGATIVE_MARKERS = [
  // EN
  'private', 'closed', 'blocked', 'personal', 'hold', 'do not book', 'cancelled', 'canceled',
  // HE — פרטי(private) סגור(closed) חסום(blocked) אישי(personal) מבוטל(cancelled) ביטול(cancellation) לא לקבוע(do-not-schedule)
  'פרטי', 'סגור', 'חסום', 'אישי', 'מבוטל', 'ביטול', 'לא לקבוע',
] as const

/**
 * Occupancy-implying prose that VETOES auto-open: an N/M head-count (e.g. "2/8") or an
 * occupancy word ("booked" / HE "נרשמו"/"תפוס"/"מלא"). Such prose implies pre-existing
 * external bookings we don't hold, so it is a reason to ASK the owner — never a green
 * light. We never PARSE the count; we only detect that prose exists and route to relay.
 */
const OCCUPANCY_WORDS = ['booked', 'נרשמו', 'תפוס', 'מלא'] as const
const NM_HEADCOUNT = /\d+\s*\/\s*\d+/ // "2/8", "2 / 8" — a head-count we must never trust

/**
 * True iff any of the given texts (title, description) carries a private/closed marker.
 * Applies to BOTH the template and structured-marker auto-open paths.
 */
export function hasNegativeMarker(...texts: Array<string | null | undefined>): boolean {
  for (const raw of texts) {
    const norm = normalizeServiceTitle(raw)
    if (!norm) continue
    const tokens = new Set(norm.split(' '))
    for (const marker of NEGATIVE_MARKERS) {
      if (marker.includes(' ')) {
        if (norm.includes(marker)) return true // multi-word phrase → substring
      } else if (tokens.has(marker)) {
        return true // single word → whole-token (no partial-word false positives)
      }
    }
  }
  return false
}

/** True iff the description carries occupancy-implying prose (a head-count we must never trust). */
export function hasOccupancyProse(description: string | null | undefined): boolean {
  if (!description) return false
  if (NM_HEADCOUNT.test(description)) return true // detect on RAW: normalization eats the '/'
  const tokens = new Set(normalizeServiceTitle(description).split(' '))
  return OCCUPANCY_WORDS.some((w) => tokens.has(w))
}

/** A parsed machine-readable class marker from an event description. */
export interface StructuredClassMarker {
  serviceName: string
  /** Explicit capacity from the marker, or null when the clause is absent/invalid. */
  capacity: number | null
}

/**
 * Parse the machine-readable convention `class: <service>; capacity: <n>` out of an
 * event description. Case-insensitive on the keys; tolerates surrounding text. Returns
 * null when the description is absent or carries no such marker — free-text prose
 * (e.g. "2/8 booked") is deliberately NOT a marker.
 */
export function parseStructuredClassMarker(description: string | null | undefined): StructuredClassMarker | null {
  if (!description) return null
  // `class:` up to the next `;` or line break is the service; an optional `capacity: <n>` follows.
  const m = /class:\s*([^;\n\r]+?)\s*(?:;\s*capacity:\s*([^\s;]+)\s*)?(?:$|[;\n\r])/i.exec(description)
  if (!m || !m[1]) return null
  const serviceName = m[1].trim()
  if (!serviceName) return null
  let capacity: number | null = null
  if (m[2] != null) {
    const n = Number(m[2])
    if (Number.isInteger(n) && n > 0) capacity = n
  }
  return { serviceName, capacity }
}

/**
 * The business-local weekday (0=Sun … 6=Sat) of a UTC instant. Uses Intl to render the
 * local calendar date in the target timezone, then reads its weekday — correct across
 * DST and the date boundary (mirrors the en-CA approach in scheduling/series.ts).
 */
export function localWeekday(instant: Date, timezone: string): number {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(instant) // YYYY-MM-DD (local)
  const [y, mo, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y!, mo! - 1, d!)).getUTCDay()
}
