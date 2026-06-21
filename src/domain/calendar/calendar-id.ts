// Calendar-ID validation + selection (F-b).
//
// Root cause this guards against: onboarding once stored a PHONE NUMBER in
// businesses.googleCalendarId (the OAuth callback never set a real one), so every
// Google write 404'd while the internal write succeeded — the PA reported "done"
// truthfully (internal) while nothing landed in Google. These pure helpers make a
// non-calendar value impossible to persist, and pick a valid calendar deterministically.
//
// A Google calendar id is either the literal 'primary' or an email-shaped address:
//   • the owner's account email (the primary calendar), or
//   • a secondary calendar id like <opaque>@group.calendar.google.com.
// A phone number ('+1754…') is neither, which is exactly how the bug slipped through.

export interface CalendarListEntry {
  id: string
  summary: string
  /** Google accessRole: 'owner' | 'writer' | 'reader' | 'freeBusyReader'. */
  accessRole: string
  primary: boolean
}

/** Owner/writer roles can have events written to them; reader/freeBusyReader cannot. */
export function isWritableRole(accessRole: string): boolean {
  return accessRole === 'owner' || accessRole === 'writer'
}

/**
 * Detect a phone-number-shaped value — the exact class of bad data that broke the
 * live business. A run of digits with only +, spaces, dashes, parentheses between
 * them, no '@'. Deliberately conservative: never flags an email-shaped id.
 */
export function isPhoneNumberLike(value: string): boolean {
  const v = value.trim()
  if (!v || v.includes('@')) return false
  if (!/\d/.test(v)) return false
  return /^[+]?[\d\s()\-.]+$/.test(v)
}

/**
 * A value that could plausibly be a Google calendar id: the literal 'primary' or an
 * email-shaped address. Anything else (phone numbers, free text, empty) is rejected
 * so it can never be persisted into businesses.googleCalendarId.
 */
export function isPlausibleCalendarId(value: string | null | undefined): boolean {
  if (!value) return false
  const v = value.trim()
  if (v === 'primary') return true
  if (isPhoneNumberLike(v)) return false
  // Minimal email shape: something@something.something
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)
}

export interface ChosenCalendar {
  calendarId: string
  /**
   * 'preserved' = kept a still-valid prior selection; 'primary' = picked the account's
   * primary; 'only' = the single writable calendar; 'default' = literal 'primary'
   * fallback (e.g. calendarList read failed).
   */
  source: 'preserved' | 'primary' | 'only' | 'default'
  /** Writable calendars the owner can switch between (for surfacing/selection). */
  candidates: CalendarListEntry[]
}

/**
 * Deterministically choose a VALID calendar id to write into businesses.googleCalendarId.
 *
 * Priority:
 *  1. Preserve `preferred` if it is plausible AND still a writable calendar in the list.
 *  2. The list's primary calendar.
 *  3. The single writable calendar, if there is exactly one.
 *  4. The literal 'primary' (safe universal default; also the empty-list fallback).
 *
 * A non-calendar `preferred` (phone number, stale id) is silently dropped.
 */
export function chooseCalendarId(
  calendars: CalendarListEntry[],
  preferred: string | null | undefined,
): ChosenCalendar {
  const writable = calendars.filter((c) => isWritableRole(c.accessRole))

  if (preferred && isPlausibleCalendarId(preferred)) {
    const match = writable.find((c) => c.id === preferred)
    if (match) return { calendarId: match.id, source: 'preserved', candidates: writable }
  }

  const primary = writable.find((c) => c.primary)
  if (primary) return { calendarId: primary.id, source: 'primary', candidates: writable }

  if (writable.length === 1) {
    return { calendarId: writable[0]!.id, source: 'only', candidates: writable }
  }

  return { calendarId: 'primary', source: 'default', candidates: writable }
}

export type CalendarSwitchResult =
  | { status: 'ok'; calendar: CalendarListEntry }
  | { status: 'not_found' }
  | { status: 'ambiguous'; matches: CalendarListEntry[] }

/**
 * Resolve a free-text calendar name (from chat — "use my Testing calendar") to a single
 * writable calendar. Matches case-insensitively against the summary: exact first, then a
 * unique substring. Read-only calendars are never switch targets. Ambiguity and no-match
 * fail closed so the executor can ask the owner rather than guess a write target.
 */
export function resolveCalendarSwitch(
  candidates: CalendarListEntry[],
  requestedName: string,
): CalendarSwitchResult {
  const writable = candidates.filter((c) => isWritableRole(c.accessRole))
  const needle = requestedName.trim().toLowerCase()
  if (!needle) return { status: 'not_found' }

  const exact = writable.filter((c) => c.summary.trim().toLowerCase() === needle)
  if (exact.length === 1) return { status: 'ok', calendar: exact[0]! }
  if (exact.length > 1) return { status: 'ambiguous', matches: exact }

  const partial = writable.filter((c) => c.summary.toLowerCase().includes(needle))
  if (partial.length === 1) return { status: 'ok', calendar: partial[0]! }
  if (partial.length > 1) return { status: 'ambiguous', matches: partial }

  return { status: 'not_found' }
}
