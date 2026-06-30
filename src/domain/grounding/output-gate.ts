/**
 * The one output gate (Unified Anti-Fabrication Gate — Phase 0 spine).
 *
 * `gateReply` runs the EXISTING pure claim-detectors (slot-fabrication-guard.ts +
 * reply-guard.ts, unchanged) against the per-turn TurnLedger, regenerating once with a
 * corrective and falling back to a safe, assertion-free reply on persistence. It is the
 * generalized form of Branch-4 `makeGenReply`'s Gates 1/2/3 — extracted verbatim so the
 * same gate can later run at every output door (Branch 3, the proactive seam).
 *
 * Booking / time / occupancy are ENFORCED exactly as Branch 4 enforces them today. As of
 * T3.1a the self-authored action-fabrication class (check / ask / "get back to you" phrasing,
 * `hasActionFabrication`) is ALSO ENFORCED here — graduated from the monitor it formerly rode
 * in observeVoiceTells. Such phrasing is unbacked BY CONSTRUCTION (the honest escalation
 * replies are code templates that bypass this gate), so it needs no `backedActions` check.
 * The cancel/waitlist `detectActionClaims` classes remain a separate, later concern (T3.1b).
 *
 * Parity is load-bearing: the regen correctives, the four exit paths (bookingConfirmed
 * early-return, the three gate exits, the occupancy-spine early-return), and the
 * observeVoiceTells `isSafeFallback` flags are reproduced byte-for-byte from makeGenReply.
 */
import { assertsBookingConfirmed } from '../flows/reply-guard.js'
import { observeVoiceTells, hasActionFabrication } from '../flows/voice-guard.js'
import {
  extractClockTimes,
  findUnbackedTimes,
  extractFullTimes,
  assertsNoAvailability,
  extractDayScopedTimes,
  daysShareOpenTime,
} from '../flows/slot-fabrication-guard.js'
import { buildAllowedTimes, type TurnLedger } from './turn-ledger.js'

// ── Safe fallbacks (assert nothing false) + correctives. Owned by the gate now. ──────

// Safe clarification when the LLM keeps asserting a booking that was never made
// (cardinal "said done, didn't do" backstop — see reply-guard.ts). Warm, claims nothing,
// moves forward with one question (owner #3a: honest is never robotic).
export const BOOKING_NOT_CONFIRMED_FALLBACK: Record<'he' | 'en', string> = {
  he: 'רגע, עדיין לא קבעתי כלום — לאיזה יום ושעה בא לך, ואני אסדר?',
  en: "Hang on — I haven't booked anything yet. What day and time works for you and I'll sort it?",
}

// Safe reply when the model keeps stating times the spine never offered (a fabricated-
// availability claim that survived one regeneration). States no time at all — better to
// ask than to offer a slot that does not exist / is blocked. Owner D1 wording: steer with
// "open / available" framing, NEVER "real time" (that implies the customer asked for a fake one).
export const FABRICATED_TIME_FALLBACK: Record<'he' | 'en', string> = {
  he: 'בוא נמצא לך שעה פנויה שמתאימה — איזה יום הכי נוח לך?',
  en: "Let's get you into an open slot that works — which day suits you best?",
}

// Safe reply when the model insists a day/class is full while the spine surfaced real
// open options this turn (occupancy fabrication, survived one regeneration). Asserts NO
// fullness and invents no time — surfaces that the day is open and invites a time.
export const OCCUPANCY_FALLBACK: Record<'he' | 'en', string> = {
  he: 'יש עדיין מקומות פנויים באותו יום — איזו שעה הכי מתאימה לך?',
  en: 'That day actually still has open spots — which time works best for you?',
}

// Appended to the situation when the first draft falsely claimed the day/class is full
// despite real open options being listed. Forces the model back onto them.
export const OCCUPANCY_GUARD_INSTRUCTION =
  'CRITICAL: There ARE open, bookable options this turn — the times listed above as open / with spots left are real and available right now. Do NOT tell the customer the day, class, or slot is full, fully booked, or that nothing is available. Offer the real open times listed above and ask which one they would like.'

// Appended to the situation when the first draft offered an unbacked time. Forces the
// model back onto the deterministic, block-aware times already in the situation.
export const TIME_GUARD_INSTRUCTION =
  'CRITICAL: Your draft offered a time that is NOT available. The ONLY bookable times are those explicitly listed as open times / classes in the context above. Business hours describe when the studio is open, NOT bookable slots — never present a time as available just because it falls within opening hours or between classes. If nothing listed fits what the customer asked, say plainly there is nothing available for that and invite them to pick from the listed options or choose another day. Do NOT state any other clock time as available.'

// Corrective appended for the phantom-booking gate.
const BOOKING_GUARD_INSTRUCTION =
  'CRITICAL: No booking has been made or confirmed. Do NOT state or imply the appointment is booked, reserved, registered, or done. If a decision is needed, ask for it plainly.'

// Corrective appended for Gate 4 — self-authored action fabrication. The model has promised
// to check / ask / find out / get back to the customer, or claimed it reached out — none of
// which it can do: the only honest escalation path is a code-emitted relay that bypasses this
// gate. Gate-local + self-contained (must NOT import from customer-booking.ts).
const ACTION_FABRICATION_GUARD_INSTRUCTION =
  'CRITICAL: Do NOT promise to check, ask, find out, look into, or get back to the customer, and do NOT claim you reached out, asked, or forwarded anything — you cannot perform any of those actions. Answer ONLY from the facts provided above. If — and only if — you genuinely cannot answer from those facts, output EXACTLY the token [[ASK_STUDIO]] and nothing else; the system relays the question to the business for you. Never self-author a follow-up promise.'

// Promise-free terminal fallback for Gate 4. CRITICAL — the re-trip trap: the orchestrator's
// own SAFE_AUDIT_FALLBACK ("I'll check and get back to you") ITSELF matches
// hasActionFabrication, so it cannot be this gate's terminal fallback — it would re-trip the
// very detector that fired. This string therefore promises NOTHING (no "I'll check", no "get
// back to you", no "אבדוק", no "אחזור אליך"), asserts NOTHING done, and steers forward warmly
// with ONE question and a next step. It must not match hasActionFabrication or
// assertsBookingConfirmed (a unit test enforces both).
export const SAFE_AUDIT_FALLBACK: Record<'he' | 'en', string> = {
  he: 'אשמח לעזור עם זה — מה בא לך לעשות עכשיו, לקבוע, לשנות או לבדוק משהו?',
  en: 'Happy to help with that — what would you like to do next, book, change, or look at something?',
}

// ── The gate ─────────────────────────────────────────────────────────────────────────

/** An enforced gate that fired this turn (telemetry). */
export type GateIntervention = 'booking' | 'time' | 'occupancy' | 'action'

export interface GateInput {
  language: 'he' | 'en'
  situation?: string | undefined
  transcript?: ReadonlyArray<{ role: string; text: string }> | undefined
}

export interface GateOpts {
  bookingConfirmed?: boolean | undefined
  focusDay?: { dateStr: string; serviceTypeId?: string } | undefined
}

export interface GateContext {
  ledger: TurnLedger
  input: GateInput
  opts: GateOpts
  /**
   * Regenerate the reply once, appending `instruction` to THIS call's situation —
   * reproduces makeGenReply's `${input.situation}\n\n${instruction}` corrective. The
   * caller closes over the grounded `generateCustomerReply` input.
   */
  regen: (instruction: string) => Promise<string>
}

export interface GateResult {
  reply: string
  interventions: GateIntervention[]
}

/**
 * Run the enforced detectors over `reply` against the ledger. Each gate: detect →
 * regenerate once with a corrective → safe fallback on persistence. Returns the gated
 * reply (already passed through the voice monitor) + which gates fired.
 */
export async function gateReply(reply: string, ctx: GateContext): Promise<GateResult> {
  const { ledger, input, opts, regen } = ctx
  const { language } = input
  const businessId = ledger.businessId
  const interventions: GateIntervention[] = []
  const replySurfacesAnyTime = (text: string): boolean => extractClockTimes(text).length > 0

  // Exit path 1 — caller asserted a real persisted booking; the slot is real, so trust
  // the wording and skip every gate (only the voice monitor runs).
  if (opts.bookingConfirmed) {
    return { reply: observeVoiceTells(reply, { businessId, language }), interventions }
  }

  // Gate 1 — phantom booking-confirmed claim.
  if (assertsBookingConfirmed(reply, language)) {
    interventions.push('booking')
    const corrected = await regen(BOOKING_GUARD_INSTRUCTION)
    reply = assertsBookingConfirmed(corrected, language)
      ? BOOKING_NOT_CONFIRMED_FALLBACK[language]
      : corrected
  }

  // Gate 2 — fabricated availability (a clock time the spine never offered). The allowlist
  // is rebuilt PER-CALL from the ledger base ∪ this call's situation/customer-raised (D1).
  const allowed = buildAllowedTimes(input, ledger.baseAllowedTimes)
  if (findUnbackedTimes(reply, allowed).length > 0) {
    interventions.push('time')
    const corrected = await regen(TIME_GUARD_INSTRUCTION)
    reply = findUnbackedTimes(corrected, allowed).length > 0
      ? FABRICATED_TIME_FALLBACK[language]
      : corrected
  }

  // Gate 3 — fabricated unavailability (occupancy). Two signals, strongest first.
  if (assertsNoAvailability(reply)) {
    // (a) Fresh-spine backstop. Skip when the reply already surfaces a concrete time — a
    // time-scoped negative that lists same-day alternatives is correct and must not regen.
    if (opts.focusDay && !replySurfacesAnyTime(reply)) {
      const spine = await ledger.occupancySpine(opts.focusDay.dateStr, opts.focusDay.serviceTypeId)
      if (spine.open) {
        interventions.push('occupancy')
        const corrected = await regen(
          `${OCCUPANCY_GUARD_INSTRUCTION}${spine.text ? ` Real open options: ${spine.text}` : ''}`,
        )
        const out = assertsNoAvailability(corrected) && !replySurfacesAnyTime(corrected)
          ? OCCUPANCY_FALLBACK[language]
          : corrected
        // Exit path 2 — occupancy-spine early return.
        return {
          reply: observeVoiceTells(out, { businessId, language }, { isSafeFallback: out === OCCUPANCY_FALLBACK[language] }),
          interventions,
        }
      }
    }
    // (b) Situation signal, day-scoped (back-compat).
    const situationOpen = extractDayScopedTimes(input.situation ?? '')
    for (const set of situationOpen.values()) {
      for (const t of ledger.baseAllowedTimes.boundaryTimes) set.delete(t)
      for (const t of ledger.baseAllowedTimes.bookingTimes) set.delete(t)
    }
    for (const t of extractFullTimes(input.situation ?? '')) {
      for (const set of situationOpen.values()) set.delete(t)
    }
    const anyOpen = [...situationOpen.values()].some((s) => s.size > 0)
    if (anyOpen && !daysShareOpenTime(situationOpen, extractDayScopedTimes(reply))) {
      interventions.push('occupancy')
      const corrected = await regen(OCCUPANCY_GUARD_INSTRUCTION)
      reply = assertsNoAvailability(corrected) && !daysShareOpenTime(situationOpen, extractDayScopedTimes(corrected))
        ? OCCUPANCY_FALLBACK[language]
        : corrected
    }
  }

  // Gate 4 — self-authored action fabrication (check / ask / "get back to you" / "one of our
  // guides will"). These phrasings are produced ONLY by the LLM — the honest escalation replies
  // are CODE TEMPLATES that bypass makeGenReply/gateReply entirely. So any such phrasing reaching
  // here is unbacked BY CONSTRUCTION; it needs NO backedActions check. ENFORCED (T3.1a).
  if (hasActionFabrication(reply)) {
    interventions.push('action')
    const corrected = await regen(ACTION_FABRICATION_GUARD_INSTRUCTION)
    reply = hasActionFabrication(corrected) ? SAFE_AUDIT_FALLBACK[language] : corrected
  }

  // Exit path 3/4 — final return; flag the safe fallbacks so the voice monitor exempts them.
  return {
    reply: observeVoiceTells(reply, { businessId, language }, {
      isSafeFallback: reply === FABRICATED_TIME_FALLBACK[language]
        || reply === OCCUPANCY_FALLBACK[language]
        || reply === BOOKING_NOT_CONFIRMED_FALLBACK[language]
        || reply === SAFE_AUDIT_FALLBACK[language],
    }),
    interventions,
  }
}
