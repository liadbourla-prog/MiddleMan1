/**
 * Slot-fabrication guard (Branch 4 cardinal safety).
 *
 * Branch 4's conversational reply layer phrases availability from a sanitized
 * situation string. On open-ended availability inquiries the model can INVENT
 * plausible clock times — e.g. interpolating "17:00 / 19:00" from the open-hours
 * window and the class cadence in the transcript — and present them as bookable,
 * even though the deterministic spine never offered them and they sit on
 * internally-blocked time. The booking path validates a time the CUSTOMER
 * proposes (input gating); nothing ever validated a time the PA proposes. This
 * module is that missing OUTPUT gate: scan the drafted reply for clock times and
 * return any the system did not actually back this turn.
 *
 * Pure + synchronous: detection only. The caller (makeGenReply) regenerates once
 * with the real allowlist, then falls back to a deterministic reply. The allowlist
 * the caller assembles is what keeps this from flagging legitimate mentions:
 *   - times the system actually offered this turn (the spine's real openings),
 *   - the business-hour boundary times (legit to state: "we're open 09:00–20:00"),
 *   - times the customer themselves raised (so a refusal — "we don't have 17:00" —
 *     is allowed to echo the asked time),
 *   - the customer's own real booking times (cancellation/list/reschedule restate them).
 *
 * Scope: HH:MM (24-hour) clock times, which is exactly how every system-surfaced
 * slot is rendered (formatSlotTime → en-GB 2-digit/24h), so the model mirrors that
 * format when it fabricates. Bare am/pm phrasing is out of scope by design.
 */

/** Canonical zero-padded 'HH:MM'. Returns null for out-of-range h/m. */
export function canonicalTime(hour: number, minute: number): string | null {
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

// HH:MM token not embedded in a longer digit/colon run (so '17:00:00' or a stray
// '1234:00' won't half-match). Hebrew "ב-17:00" / "בשעה 19:00" and "09:00–20:00"
// all surface the bare HH:MM, which is what we capture.
const CLOCK_RE = /(?<![\d:])(\d{1,2}):(\d{2})(?![\d:])/g

/**
 * All distinct HH:MM clock times stated in `text`, canonicalized. Order-preserving,
 * deduped. Prices ("80 ₪"), dates ("28 ביוני"), durations ("60 דקות") have no colon
 * and are never matched.
 */
export function extractClockTimes(text: string): string[] {
  if (!text) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(CLOCK_RE)) {
    const canon = canonicalTime(Number(m[1]), Number(m[2]))
    if (canon && !seen.has(canon)) {
      seen.add(canon)
      out.push(canon)
    }
  }
  return out
}

// A bare hour in time context: after a Hebrew time preposition (ב/ל/בשעה, with an
// optional hyphen) or an English time word (at/by/around/till/until), 0–23. This
// only ever WIDENS the allowlist (permits the PA to echo a time the customer
// raised), so erring toward catching more mentions is safe.
const MENTIONED_BARE_RE =
  /(?:בשעה|ב|ל|at|by|around|till|until|from)[\s-]*(\d{1,2})(?![\d:])/gi

/**
 * Times the customer is treated as having raised in `text`: every HH:MM plus any
 * bare in-context hour (→ 'HH:00'). Fed from the customer's own turns so a reply
 * may legitimately reference a time the customer asked about (notably a refusal).
 */
export function extractMentionedTimes(text: string): string[] {
  if (!text) return []
  const out = new Set<string>(extractClockTimes(text))
  for (const m of text.matchAll(MENTIONED_BARE_RE)) {
    const canon = canonicalTime(Number(m[1]), 0)
    if (canon) out.add(canon)
  }
  return [...out]
}

// Clock times the SITUATION explicitly marks as full (no seats left) — rendered as
// "HH:MM (full)" / "HH:MM (מלא)" by buildDayOptionsText. Excluded from the "open
// options" signal so a day on which every class is full is never mistaken for one
// that still has availability.
export function extractFullTimes(text: string): string[] {
  if (!text) return []
  const out = new Set<string>()
  for (const m of text.matchAll(/(\d{1,2}):(\d{2})\s*\((?:full|מלא)\)/gi)) {
    const canon = canonicalTime(Number(m[1]), Number(m[2]))
    if (canon) out.add(canon)
  }
  return [...out]
}

// Does the reply assert BLANKET unavailability — a whole day / class is full or
// nothing is open? Conservative, phrase-based, and ALWAYS paired in the gate with a
// deterministic "≥1 open option exists this turn" signal, so a genuinely-full day
// (no open signal) is never touched. Targets sweeping claims, not a specific-time
// negative ("no class at 19:00"), which the gate further protects via the
// reply-restates-an-open-time check.
const NO_AVAILABILITY_RE: RegExp[] = [
  /fully\s*booked/i, /completely\s*full/i, /\ball\s*booked\b/i, /no\s*availability/i,
  /no\s*(?:open\s*)?spots?\b/i, /no\s*openings?\b/i, /nothing\s*(?:is\s*)?available/i,
  /sold\s*out/i, /no\s*slots?\s*(?:left|available)/i, /\ball\s*(?:full|taken|booked)\b/i,
  /התמלא/, /מלא\s*לגמרי/, /מלא\s*לחלוטין/, /הכל\s*מלא/, /הכול\s*מלא/, /כבר\s*מלא/,
  /אין\s*מקום/, /אין\s*מקומות/, /אין\s*זמינות/, /אין\s*שיעורים\s*פנויים/, /נתפסו\s*כל/, /הכל\s*תפוס/,
]
export function assertsNoAvailability(text: string): boolean {
  return !!text && NO_AVAILABILITY_RE.some((re) => re.test(text))
}

/**
 * Clock times the reply states that are NOT in `allowed` — candidate fabrications.
 * `allowed` holds canonical 'HH:MM' strings the caller has assembled from the
 * spine + boundaries + customer-raised + real bookings.
 */
export function findUnbackedTimes(reply: string, allowed: Iterable<string>): string[] {
  const allowSet = allowed instanceof Set ? allowed : new Set(allowed)
  return extractClockTimes(reply).filter((t) => !allowSet.has(t))
}
