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
import { assertsBookingConfirmed, detectActionClaims, type ActionClaim } from '../flows/reply-guard.js'
import { observeVoiceTells, hasActionFabrication } from '../flows/voice-guard.js'
import {
  extractClockTimes,
  findUnbackedTimes,
  extractFullTimes,
  assertsNoAvailability,
  extractDayScopedTimes,
  daysShareOpenTime,
  weekdayKeysForDateStr,
} from '../flows/slot-fabrication-guard.js'
import { buildAllowedTimes, type TurnLedger } from './turn-ledger.js'
import type { GateTelemetrySignals, OccupancyGateOutcome } from './gate-telemetry.js'

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

// Corrective appended for the action-CLAIM gate (T3.1b) — the draft states a COMPLETED action
// (cancelled / added-to-waitlist / messaged-a-customer / …) that the core did NOT perform this
// turn. Distinct from ACTION_FABRICATION_GUARD_INSTRUCTION (check/ask phrasing): this is a
// "said done, didn't do" claim about a discrete action. Mirrors the orchestrator's
// auditReplyClaims correction tone, kept gate-local (must NOT import from customer-booking.ts).
const ACTION_CLAIM_GUARD_INSTRUCTION =
  'CRITICAL: Your draft claims a completed action (such as cancelling, adding to the waitlist, or sending a message) that did NOT happen this turn. Do NOT state it as done. Either say plainly what you WILL do or ASK what the customer wants — never claim a completed action that the system did not perform.'

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

// ── Unified per-turn regeneration budget (T-REGEN / D6 / P6) ───────────────────────────
//
// With the gate at up to FIVE enforce points (booking / time / occupancy / action-claim /
// action-fabrication) plus Branch-3's auditReplyClaims, a single turn could stack unbounded
// regenerate-once LLM round-trips — all inside `withIdentityLock` (60s TTL) — and blow the
// lock. A single shared budget per turn caps the total round-trips AND a shared deadline keeps
// the worst case well under the lock. The owner tunes both on deploy via the env vars below.
//
// CRITICAL no-behavior-change contract: when no budget is threaded (`undefined`), every gate
// regenerates exactly as before. The budget only CAPS the worst case — it never changes a
// single-gate outcome under budget.
export interface RegenBudget {
  /** Remaining regenerations allowed this turn. */
  remaining: number
  /** Wall-clock ms after which no further regeneration is attempted. */
  deadlineMs: number
}

/**
 * Build a per-turn regen budget. Defaults from env with sane fallbacks:
 * - `GATE_REGEN_MAX` (default 3) — max LLM regenerations across all gates/seams this turn.
 * - `GATE_REGEN_DEADLINE_MS` (default 45000) — 45s leaves headroom under the 60s identity lock.
 * The owner tunes these on deploy.
 */
export function makeRegenBudget(opts?: { max?: number; deadlineMs?: number }): RegenBudget {
  const max = opts?.max ?? (Number(process.env['GATE_REGEN_MAX']) || 3)
  const deadlineMs = opts?.deadlineMs ?? (Date.now() + (Number(process.env['GATE_REGEN_DEADLINE_MS']) || 45000))
  return { remaining: max, deadlineMs }
}

/**
 * Try to spend one regeneration. Back-compat: `undefined` budget ALWAYS returns true and
 * decrements nothing (the no-budget callers keep regenerating once per gate as today).
 * With a budget: true (and decrements) only while `remaining > 0` AND the deadline has not
 * passed; otherwise false and no decrement. When false, the caller must skip `regen` and go
 * straight to its safe fallback.
 */
export function tryConsumeRegen(budget?: RegenBudget): boolean {
  if (!budget) return true
  if (budget.remaining > 0 && Date.now() < budget.deadlineMs) {
    budget.remaining -= 1
    return true
  }
  return false
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
  /**
   * Enforce the action-CLAIM gate (T3.1b) — `detectActionClaims` vs `ledger.backedActions`.
   * Default falsy: Branch 3 (whose `auditReplyClaims` owns its own action audit + logging) and
   * all Phase-0 callers are UNCHANGED. Branch 4 always passes `true`.
   */
  enforceActionClaims?: boolean | undefined
}

/**
 * The action classes a reply is allowed to state as completed are those the core actually
 * backed this turn. Mirrors the orchestrator's `unbackedClaims` (NOT imported — replicated as
 * a small pure filter): `booking_made` is excluded (Gate 1 / `opts.bookingConfirmed` owns it);
 * `calendar_connected` is backed when the calendar is connected this turn OR explicitly backed;
 * every other class is backed only when present in `backedActions`.
 */
function unbackedActionClaims(text: string, lang: 'he' | 'en', backed: ReadonlySet<ActionClaim>, calendarConnected: boolean): ActionClaim[] {
  return detectActionClaims(text, lang)
    .filter((c) => c !== 'booking_made')
    .filter((c) => (c === 'calendar_connected' ? !(calendarConnected || backed.has(c)) : !backed.has(c)))
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
  /**
   * Shared per-turn regeneration budget (T-REGEN / D6). When omitted, every gate regenerates
   * once exactly as before (back-compat). When supplied, the SAME budget object is threaded
   * across all enforce points this turn (Branch 4: every genReply in the turn; Branch 3:
   * gateReply + auditReplyClaims) so the total LLM round-trips are capped under the lock TTL.
   */
  budget?: RegenBudget | undefined
}

export interface GateResult {
  reply: string
  interventions: GateIntervention[]
  /**
   * Phase 0 (X1) gate-decision telemetry for this pass — the door-agnostic signals the caller
   * emits as one structured line. `gatesFired` mirrors `interventions`; the rest expose the
   * grounding-empty vs gate-skipped distinction (see gate-telemetry.ts). Booleans/counts only.
   */
  telemetry: GateTelemetrySignals
}

/**
 * Run the enforced detectors over `reply` against the ledger. Each gate: detect →
 * regenerate once with a corrective → safe fallback on persistence. Returns the gated
 * reply (already passed through the voice monitor) + which gates fired.
 */
export async function gateReply(reply: string, ctx: GateContext): Promise<GateResult> {
  const { ledger, input, opts, regen, budget } = ctx
  const { language } = input
  const businessId = ledger.businessId
  const interventions: GateIntervention[] = []
  // T2.2 — DAY-AWARE escape heuristic. The fresh-spine backstop may only be skipped when the
  // reply surfaces a time ON THE FOCUS DAY — a time on the WRONG day (e.g. "Sunday's full, but
  // 14:00 today") must NOT defeat it (the P2 second hole). A reply "surfaces the focus day" when
  // it states a clock time scoped to that day's weekday section, OR an UNSCOPED time (no day
  // token precedes it — contextually a same-day alternative, so a correct same-day negative
  // "no 12, but 14:00" still spares the backstop: G1/G5). Falls back to the day-blind
  // any-time check only when the focus date is unparseable.
  const replySurfacesFocusDayTime = (text: string, dateStr: string): boolean => {
    const keys = weekdayKeysForDateStr(dateStr)
    if (!keys) return extractClockTimes(text).length > 0
    const scoped = extractDayScopedTimes(text)
    if ((scoped.get('')?.size ?? 0) > 0) return true
    return (scoped.get(keys.he)?.size ?? 0) > 0 || (scoped.get(keys.en)?.size ?? 0) > 0
  }
  // ── Phase 0 (X1) telemetry accumulators ───────────────────────────────────────────────
  // Counted/derived as the gate runs so the caller can emit one structured line. No bodies.
  let regenCount = 0
  let occupancyAsserted = false
  let occupancySpineConsulted = false
  let occupancyOutcome: OccupancyGateOutcome = 'not_applicable'

  // The set of safe-fallback strings any gate may terminate at — the post-regen re-check
  // never re-trips one of these (they are terminal by construction), and the voice monitor
  // exempts them from its bot-tell rules.
  const TERMINALS = new Set<string>([
    FABRICATED_TIME_FALLBACK[language],
    OCCUPANCY_FALLBACK[language],
    BOOKING_NOT_CONFIRMED_FALLBACK[language],
    SAFE_AUDIT_FALLBACK[language],
  ])

  // Run a gate's regenerate-once corrective under the shared budget, with two fail-safes:
  // (1) T-REGEN budget — if the budget is exhausted/expired, SKIP `regen` and go straight to
  //     `fallback` (the cap biting on the worst case). Under-budget (or no budget) → regen as today.
  // (2) F-rev4 — a `regen` that THROWS must NEVER surface the unbacked draft; fall to `fallback`.
  // `stillTrips(corrected)` re-checks the gate's OWN detector on the correction → fallback on persistence.
  const regenOrFallback = async (
    instruction: string,
    fallback: string,
    stillTrips: (corrected: string) => boolean,
  ): Promise<string> => {
    if (!tryConsumeRegen(budget)) return fallback
    try {
      regenCount += 1
      const corrected = await regen(instruction)
      return stillTrips(corrected) ? fallback : corrected
    } catch {
      return fallback
    }
  }

  // Build the telemetry signal bundle for a return — situationHasOpen is computed below the
  // booking early-return, so this is called with whatever is known at the return point.
  const telemetryAt = (situationHadOpenTimes: boolean, finalReply: string): GateTelemetrySignals => ({
    gatesFired: [...interventions],
    regenCount,
    fellToTemplate: TERMINALS.has(finalReply),
    situationHadOpenTimes,
    occupancyAsserted,
    occupancySpineConsulted,
    occupancyOutcome,
  })

  // Exit path 1 — caller asserted a real persisted booking; the slot is real, so trust
  // the wording and skip every gate (only the voice monitor runs).
  if (opts.bookingConfirmed) {
    return { reply: observeVoiceTells(reply, { businessId, language }), interventions, telemetry: telemetryAt(false, reply) }
  }

  // Gate 1 — phantom booking-confirmed claim.
  if (assertsBookingConfirmed(reply, language)) {
    interventions.push('booking')
    reply = await regenOrFallback(
      BOOKING_GUARD_INSTRUCTION,
      BOOKING_NOT_CONFIRMED_FALLBACK[language],
      (c) => assertsBookingConfirmed(c, language),
    )
  }

  // Gate 2 — fabricated availability (a clock time the spine never offered). The allowlist
  // is rebuilt PER-CALL from the ledger base ∪ this call's situation/customer-raised (D1).
  const allowed = buildAllowedTimes(input, ledger.baseAllowedTimes)
  if (findUnbackedTimes(reply, allowed).length > 0) {
    interventions.push('time')
    reply = await regenOrFallback(
      TIME_GUARD_INSTRUCTION,
      FABRICATED_TIME_FALLBACK[language],
      (c) => findUnbackedTimes(c, allowed).length > 0,
    )
  }

  // Gate 3 — fabricated unavailability (occupancy). Two signals, strongest first.
  // Day-scoped situation-open set, computed once (reused by signal b AND the re-check).
  const situationOpen = extractDayScopedTimes(input.situation ?? '')
  for (const set of situationOpen.values()) {
    for (const t of ledger.baseAllowedTimes.boundaryTimes) set.delete(t)
    for (const t of ledger.baseAllowedTimes.bookingTimes) set.delete(t)
  }
  for (const t of extractFullTimes(input.situation ?? '')) {
    for (const set of situationOpen.values()) set.delete(t)
  }
  const situationHasOpen = [...situationOpen.values()].some((s) => s.size > 0)
  if (assertsNoAvailability(reply)) {
    occupancyAsserted = true
    // (a) Fresh-spine backstop. Skip only when the reply surfaces a concrete time ON THE FOCUS
    // DAY (T2.2) — a same-day negative that lists same-day alternatives is correct and must not
    // regen; a wrong-day time no longer counts (the P2 day-blind hole).
    if (opts.focusDay && !replySurfacesFocusDayTime(reply, opts.focusDay.dateStr)) {
      occupancySpineConsulted = true
      const spine = await ledger.occupancySpine(opts.focusDay.dateStr, opts.focusDay.serviceTypeId)
      // T2.1 — fire when EITHER scope is open: the whole day (any service) or the named service
      // that day (unfiltered by time). So "all Pilates is taken Sunday" regenerates against the
      // real Pilates 9/11/14/18, and a "the whole day is full" against any open service.
      if (spine.openOverall || spine.openInService) {
        // The spine's open times are authoritatively backed this turn (a fresh DB read of the
        // focused day). Admit them to the time allowlist so the occupancy correction — which
        // surfaces exactly those times — is not then flagged "unbacked" by the time re-check
        // below (that would fallback a legitimately-offered open slot: a G1/G5 regression).
        for (const t of extractClockTimes(spine.text ?? '')) allowed.add(t)
        interventions.push('occupancy')
        occupancyOutcome = 'fired'
        const out = await regenOrFallback(
          `${OCCUPANCY_GUARD_INSTRUCTION}${spine.text ? ` Real open options: ${spine.text}` : ''}`,
          OCCUPANCY_FALLBACK[language],
          (c) => assertsNoAvailability(c) && !replySurfacesFocusDayTime(c, opts.focusDay!.dateStr),
        )
        // Spine path no longer short-circuits — fall through to the shared re-check + final
        // return so a spine-regen that re-introduces an earlier-gate lie (e.g. an unbacked time)
        // is still caught (D6 no-oscillation). out is either the clean correction or the terminal.
        reply = out
      } else {
        // The fresh spine confirmed the focused day genuinely has no open capacity — an HONEST
        // "full". No intervention; recorded distinctly so an honest full never reads as a skip.
        occupancyOutcome = 'passed_spine_closed'
      }
    } else {
      // (b) Situation signal, day-scoped (back-compat).
      if (situationHasOpen && !daysShareOpenTime(situationOpen, extractDayScopedTimes(reply))) {
        interventions.push('occupancy')
        occupancyOutcome = 'fired'
        reply = await regenOrFallback(
          OCCUPANCY_GUARD_INSTRUCTION,
          OCCUPANCY_FALLBACK[language],
          (c) => assertsNoAvailability(c) && !daysShareOpenTime(situationOpen, extractDayScopedTimes(c)),
        )
      } else if (situationHasOpen) {
        // The situation carried open times and the reply surfaced the SAME day's open time(s):
        // a correct same-day negative ("no 12, but 14:00 that day") — not a fabrication.
        occupancyOutcome = 'passed_shares_open_time'
      } else if (opts.focusDay) {
        // GATE SKIPPED: we are in (b) despite a focusDay because the reply surfaced a time the
        // DAY-AWARE check (T2.2) attributed to the focus day (or unscoped). For a correctly-
        // phrased same-day negative this is legitimate; the residual P2 shape persists only when
        // a wrong-day time carries no recognizable day token and mis-attributes to the focus day
        // (read with situationHadOpenTimes:false). T2.3's grounding re-anchor prevents the
        // wrong-day situation upstream so this case no longer launders a "full" lie.
        occupancyOutcome = 'skipped_reply_surfaced_time'
      } else {
        // GROUNDING EMPTY: a no-availability claim, no focus-day spine path, and the situation
        // carried no open times to contradict it. Nothing could verify the claim.
        occupancyOutcome = 'skipped_grounding_empty'
      }
    }
  }

  // Gate 3b — action-CLAIM fabrication (cancel / waitlist / message / refund / broadcast /
  // settings, T3.1b). Flag-gated: ONLY when opts.enforceActionClaims (Branch 4 always; Branch 3
  // never — its auditReplyClaims owns this). A detectActionClaims class NOT in backedActions is a
  // "said done, didn't do" claim → regen once → SAFE_AUDIT_FALLBACK on persistence. booking_made
  // is excluded (Gate 1 owns it). Composes with the T3.1a hasActionFabrication gate below (both
  // route to SAFE_AUDIT_FALLBACK — fine).
  if (opts.enforceActionClaims && unbackedActionClaims(reply, language, ledger.backedActions, ledger.calendarConnected).length > 0) {
    interventions.push('action')
    reply = await regenOrFallback(
      ACTION_CLAIM_GUARD_INSTRUCTION,
      SAFE_AUDIT_FALLBACK[language],
      (c) => unbackedActionClaims(c, language, ledger.backedActions, ledger.calendarConnected).length > 0,
    )
  }

  // Gate 4 — self-authored action fabrication (check / ask / "get back to you" / "one of our
  // guides will"). These phrasings are produced ONLY by the LLM — the honest escalation replies
  // are CODE TEMPLATES that bypass makeGenReply/gateReply entirely. So any such phrasing reaching
  // here is unbacked BY CONSTRUCTION; it needs NO backedActions check. ENFORCED (T3.1a).
  if (hasActionFabrication(reply)) {
    interventions.push('action')
    reply = await regenOrFallback(
      ACTION_FABRICATION_GUARD_INSTRUCTION,
      SAFE_AUDIT_FALLBACK[language],
      (c) => hasActionFabrication(c),
    )
  }

  // ── Post-regen re-check (T-REGEN / D6 — no oscillation, NO further regen) ────────────
  // A later-gate regeneration can silently re-introduce an EARLIER-gate lie (e.g. the
  // occupancy regen offering an unbacked time, or a time regen newly asserting fullness).
  // Re-validate the final reply against ALL enforced detectors with at most O(detectors)
  // PURE checks (no LLM, no async). If it trips, route straight to that detector's terminal
  // fallback (never re-trip a fallback, guaranteeing termination). First match wins; the
  // ordering mirrors the gate sequence (booking → time → occupancy → action).
  if (!TERMINALS.has(reply)) {
    const recheckFallback = ((): string | null => {
      if (!opts.bookingConfirmed && assertsBookingConfirmed(reply, language)) return BOOKING_NOT_CONFIRMED_FALLBACK[language]
      if (findUnbackedTimes(reply, allowed).length > 0) return FABRICATED_TIME_FALLBACK[language]
      if (assertsNoAvailability(reply) && situationHasOpen && !daysShareOpenTime(situationOpen, extractDayScopedTimes(reply))) return OCCUPANCY_FALLBACK[language]
      if (opts.enforceActionClaims && unbackedActionClaims(reply, language, ledger.backedActions, ledger.calendarConnected).length > 0) return SAFE_AUDIT_FALLBACK[language]
      if (hasActionFabrication(reply)) return SAFE_AUDIT_FALLBACK[language]
      return null
    })()
    if (recheckFallback) {
      reply = recheckFallback
      // Record the re-check's intervention class (telemetry parity with the live gates).
      const cls: GateIntervention = recheckFallback === BOOKING_NOT_CONFIRMED_FALLBACK[language] ? 'booking'
        : recheckFallback === FABRICATED_TIME_FALLBACK[language] ? 'time'
          : recheckFallback === OCCUPANCY_FALLBACK[language] ? 'occupancy'
            : 'action'
      if (!interventions.includes(cls)) interventions.push(cls)
    }
  }

  // Exit path — final return; flag the safe fallbacks so the voice monitor exempts them.
  return {
    reply: observeVoiceTells(reply, { businessId, language }, {
      isSafeFallback: TERMINALS.has(reply),
    }),
    interventions,
    telemetry: telemetryAt(situationHasOpen, reply),
  }
}
