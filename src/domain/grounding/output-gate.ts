/**
 * The one output gate (Unified Anti-Fabrication Gate — Phase 0 spine).
 *
 * `gateReply` runs the EXISTING pure claim-detectors (slot-fabrication-guard.ts +
 * reply-guard.ts, unchanged) against the per-turn TurnLedger, regenerating once with a
 * corrective and falling back to a safe, assertion-free reply on persistence. It is the
 * generalized form of Branch-4 `makeGenReply`'s Gates 1/2/3 — extracted verbatim so the
 * same gate can later run at every output door (Branch 3, the proactive seam).
 *
 * Phase-0 scope (RED-TEAM P2 — no behavior change): only booking / time / occupancy are
 * ENFORCED, exactly as Branch 4 enforces them today. The action class stays MONITOR-ONLY
 * (it rides inside observeVoiceTells, as today); enforcing it here would be a behavior
 * change. `ledger.backedActions` is carried for the later phases that graduate the monitor.
 *
 * Parity is load-bearing: the regen correctives, the four exit paths (bookingConfirmed
 * early-return, the three gate exits, the occupancy-spine early-return), and the
 * observeVoiceTells `isSafeFallback` flags are reproduced byte-for-byte from makeGenReply.
 */
import { assertsBookingConfirmed } from '../flows/reply-guard.js'
import { observeVoiceTells } from '../flows/voice-guard.js'
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
// (cardinal "said done, didn't do" backstop — see reply-guard.ts).
export const BOOKING_NOT_CONFIRMED_FALLBACK: Record<'he' | 'en', string> = {
  he: 'רגע, עוד לא סגרנו את זה — לאיזה יום ושעה בא לך?',
  en: "Hang on — that's not booked yet. What day and time works for you?",
}

// Safe reply when the model keeps stating times the spine never offered (a fabricated-
// availability claim that survived one regeneration). States no time at all — better to
// ask than to offer a slot that does not exist / is blocked.
export const FABRICATED_TIME_FALLBACK: Record<'he' | 'en', string> = {
  he: 'בוא נמצא לך זמן שמתאים — לאיזה יום שאבדוק עבורך?',
  en: "Let's find a time that works for you — which day should I check?",
}

// Safe reply when the model insists a day/class is full while the spine surfaced real
// open options this turn (occupancy fabrication, survived one regeneration). Asserts NO
// fullness and invents no time — invites the customer to pick a time.
export const OCCUPANCY_FALLBACK: Record<'he' | 'en', string> = {
  he: 'יש עדיין מקומות פנויים באותו יום — איזו שעה מתאימה לך?',
  en: 'There are still open spots that day — which time works for you?',
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

// ── The gate ─────────────────────────────────────────────────────────────────────────

/** An enforced gate that fired this turn (telemetry; action is monitor-only in Phase 0). */
export type GateIntervention = 'booking' | 'time' | 'occupancy'

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

  // Exit path 3/4 — final return; flag the safe fallbacks so the voice monitor exempts them.
  return {
    reply: observeVoiceTells(reply, { businessId, language }, {
      isSafeFallback: reply === FABRICATED_TIME_FALLBACK[language]
        || reply === OCCUPANCY_FALLBACK[language]
        || reply === BOOKING_NOT_CONFIRMED_FALLBACK[language],
    }),
    interventions,
  }
}
