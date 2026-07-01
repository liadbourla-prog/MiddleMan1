/**
 * The Turn Truth Ledger (Unified Anti-Fabrication Gate — Phase 0 spine).
 *
 * A single per-turn record the deterministic core fills BEFORE any reply is gated.
 * It is the one source of backing the output gate checks claims against, replacing the
 * scattered closure args (`makeGenReply`'s `{businessFacts, actionLedger, timeGuard,
 * dayHasOpenOptions}` and — in later phases — the Branch-3 orchestrator's accumulators).
 *
 * RED-TEAM D1 — `allowedTimes` is per-turn-BASE ∪ per-CALL, never one frozen set.
 * The ledger holds only the stable per-turn base (`baseAllowedTimes` = boundary ∪
 * booking). `buildAllowedTimes` STILL merges the per-call `situation` + customer-raised
 * transcript times at gate time (each of the 53 Branch-4 call sites + the in-gate
 * correctives pass a different `situation`). Precomputing one per-turn allowlist would
 * false-positive legitimately-offered times into `FABRICATED_TIME_FALLBACK` — a G1/G5
 * regression and a violation of Phase 0's "no behavior change" guarantee.
 *
 * Pure + branch-agnostic: zero db/adapter imports. Branch 4 fills it from its loaders;
 * Branch 3 and the workers will fill the same struct from their own sources in later phases.
 */
import type { ActionClaim } from '../flows/reply-guard.js'
import { extractClockTimes, extractMentionedTimes } from '../flows/slot-fabrication-guard.js'

/** The per-turn base for the time allowlist; the gate merges per-call situation/raised times on top. */
export interface BaseAllowedTimes {
  boundaryTimes: string[]
  bookingTimes: string[]
}

/**
 * Fresh-spine occupancy reader for a focused (day, service): genuinely-open capacity only.
 *
 * T2.1 — reads the WHOLE requested day and exposes TWO scope signals so a service+time miss
 * can never read as whole-service-empty (the §K "Sunday full" laundering):
 *  - `openOverall`   — ANY service has genuinely-open capacity that day (so "the whole day is
 *                      full" is checkable even when the named service is closed).
 *  - `openInService` — the NAMED service (when one is focused) has open capacity that day,
 *                      UNFILTERED by time (so "all Pilates is taken Sunday" is checkable against
 *                      Pilates at 9/11/14/18). When no service is focused it equals `openOverall`.
 * `text` carries the real open options to re-ground the reply on (the service's day when open,
 * else the whole day). Replaces the former single `open`.
 */
export type OccupancySpine = (
  dateStr: string,
  serviceTypeId?: string,
) => Promise<{ openOverall: boolean; openInService: boolean; text: string | null }>

export interface TurnLedger {
  /** Closed-world business facts (exhaustive services/prices/instructors). */
  businessFacts: string
  /** L1 action grounding — real, system-performed actions involving this customer. */
  actionLedger: string
  /** Per-turn base of the time allowlist (D1) — the gate merges per-call times on top. */
  baseAllowedTimes: BaseAllowedTimes
  /** Fresh-spine reader for the occupancy gate's focused-day re-validation. */
  occupancySpine: OccupancySpine
  /** Actions the core actually performed this turn (`partial` must NOT back). Empty in Branch-4 Phase 0. */
  backedActions: Set<ActionClaim>
  /** Whether Google Calendar is connected this turn. */
  calendarConnected: boolean
  businessId?: string | undefined
}

// Structural shape of the per-call reply input the allowlist merge reads. Kept loose so
// the builder stays branch-agnostic (Branch 4's GenerateReplyInput satisfies it).
export interface AllowedTimesInput {
  situation?: string | undefined
  transcript?: ReadonlyArray<{ role: string; text: string }> | undefined
}

/**
 * Assemble the set of clock times a reply is allowed to state — per-turn base ∪ per-call
 * (D1). Union of: the per-turn base (business-hour boundaries + the customer's own real
 * booking times), the times the system surfaced in THIS call's situation string (it is
 * system-authored and block-aware, so every legitimately-offered time is in it), and the
 * times the CUSTOMER raised this conversation (a reply may echo/refuse them). Prior-assistant
 * turns are deliberately excluded — including them would launder a fabrication across turns.
 * Anything else in the reply is a fabrication. Lifted verbatim from customer-booking.ts.
 */
export function buildAllowedTimes(input: AllowedTimesInput, base: BaseAllowedTimes): Set<string> {
  const allowed = new Set<string>([...base.boundaryTimes, ...base.bookingTimes])
  for (const t of extractClockTimes(input.situation ?? '')) allowed.add(t)
  for (const turn of input.transcript ?? []) {
    if (turn.role === 'customer') for (const t of extractMentionedTimes(turn.text)) allowed.add(t)
  }
  return allowed
}

/** Package the already-computed per-turn pieces into one TurnLedger struct. */
export function buildTurnLedger(parts: {
  businessFacts: string
  actionLedger: string
  baseAllowedTimes: BaseAllowedTimes
  occupancySpine: OccupancySpine
  backedActions?: ReadonlySet<ActionClaim> | Iterable<ActionClaim>
  calendarConnected?: boolean
  businessId?: string | undefined
}): TurnLedger {
  return {
    businessFacts: parts.businessFacts,
    actionLedger: parts.actionLedger,
    baseAllowedTimes: parts.baseAllowedTimes,
    occupancySpine: parts.occupancySpine,
    backedActions: new Set<ActionClaim>(parts.backedActions ?? []),
    calendarConnected: parts.calendarConnected ?? false,
    businessId: parts.businessId,
  }
}
