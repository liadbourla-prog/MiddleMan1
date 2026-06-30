/**
 * Phase 0 (X1) — gate-decision telemetry.
 *
 * One structured line per turn at each of the three output doors (Branch-4 makeGenReply,
 * Branch-3 gateAndAuditBranch3Reply, the proactive gateProactiveBody) so the deterministic
 * gate/grounding decisions are OBSERVABLE in production. The 2026-06-30 red-team was blocked
 * verifying P2 because prod emits only Fastify request logs — no gate-fire trace existed.
 *
 * HARD CONSTRAINT: booleans, counts, and ids ONLY. NEVER a message body, situation string,
 * customer text, phone number, or any other PII. The fields below are all categorical /
 * numeric / id-shaped by construction.
 *
 * The line is emitted as a single JSON object on stdout with `severity:"INFO"` and a stable
 * `logType:"gate_decision"` marker. On Cloud Run, Cloud Logging auto-parses a JSON stdout line
 * into a structured `jsonPayload` entry at the given severity — so the line is queryable in prod
 * (filter: `jsonPayload.logType="gate_decision"`). This is the X1 fix: app-level structured logs
 * that actually reach Cloud Logging, not just Fastify request logs.
 */

/** The stable marker every gate-decision line carries. Filter on this in Cloud Logging. */
export const GATE_DECISION_LOG_TYPE = 'gate_decision'

/** Which output door emitted the line. */
export type GateDoor = 'branch4' | 'branch3' | 'proactive'

/**
 * Why the occupancy gate did — or did NOT — intervene this turn. This field, READ ALONGSIDE
 * `situationHadOpenTimes`, is what removes the exact P2 ambiguity the red-team hit: it
 * distinguishes "the grounding was empty" (the situation carried no open times, so a
 * no-availability claim had nothing to contradict it) from "the gate was skipped" (the
 * day-blind surfaced-time short-circuit, or no focus day) — two states that previously both
 * looked like "occupancy did not fire."
 *
 * - `not_applicable`              — the reply made no no-availability claim, OR the door runs no
 *                                   occupancy gate (proactive). Occupancy logic was never relevant.
 * - `fired`                       — the occupancy gate intervened (regenerated or fell to template).
 * - `passed_spine_closed`         — the fresh spine was read and confirmed the day genuinely has
 *                                   no open capacity (an HONEST "full"); no intervention needed.
 * - `passed_shares_open_time`     — the situation carried open times and the reply surfaced the
 *                                   SAME day's open time(s) (a correct same-day negative); no fire.
 * - `skipped_reply_surfaced_time` — GATE SKIPPED: the reply already surfaced some clock time, so the
 *                                   fresh-spine backstop short-circuited (the day-blind hole). When
 *                                   this co-occurs with `situationHadOpenTimes:false` it is the exact
 *                                   P2 shape (a no-availability claim went unchallenged).
 * - `skipped_grounding_empty`     — GROUNDING EMPTY: a no-availability claim was made, the situation
 *                                   carried no open times, and no focus-day spine path ran, so nothing
 *                                   could contradict the claim.
 */
export type OccupancyGateOutcome =
  | 'not_applicable'
  | 'fired'
  | 'passed_spine_closed'
  | 'passed_shares_open_time'
  | 'skipped_reply_surfaced_time'
  | 'skipped_grounding_empty'

/**
 * The gate-INTERNAL signals produced by `gateReply` (door-agnostic). Each door composes these
 * with its own identity fields (below) into a full {@link GateDecisionLog}. The proactive door,
 * which does not call `gateReply`, fills these itself (occupancy is always `not_applicable` there).
 */
export interface GateTelemetrySignals {
  /** Which enforced gates fired this turn (e.g. ['booking','occupancy']). */
  gatesFired: string[]
  /** How many LLM regenerations were actually consumed this turn (count, never a body). */
  regenCount: number
  /** True when the final reply is one of the safe terminal templates (the gate gave up to a template). */
  fellToTemplate: boolean
  /** Grounding signal: did THIS call's situation string carry any day-scoped open times? */
  situationHadOpenTimes: boolean
  /** Did the reply assert no-availability (so the occupancy gate's logic was reached at all)? */
  occupancyAsserted: boolean
  /** Was the fresh occupancy spine actually read this turn (vs the situation-signal path)? */
  occupancySpineConsulted: boolean
  /** The grounding-empty vs gate-skipped disambiguator — see {@link OccupancyGateOutcome}. */
  occupancyOutcome: OccupancyGateOutcome
}

/** The full per-turn gate-decision record emitted at a door. Ids + booleans + counts ONLY. */
export interface GateDecisionLog extends GateTelemetrySignals {
  door: GateDoor
  businessId: string | null
  identityId: string | null
  sessionId: string | null
  /** The resolved intent class for the turn (a category like 'booking'/'inquiry'/'unknown'), never free text. */
  intent: string | null
  /** The focus-day date string (YYYY-MM-DD) the gate re-grounded against, or null. */
  focusDay: string | null
}

/**
 * Telemetry is ON by default (the X1 fix needs it live in prod at info). Set `GATE_TELEMETRY`
 * to `0` / `false` / `off` to silence it. Evaluated per-call (not at module load) so tests and
 * operators can toggle it without a restart.
 */
function telemetryEnabled(): boolean {
  const v = process.env['GATE_TELEMETRY']
  if (v == null) return true
  const norm = v.trim().toLowerCase()
  return !(norm === '0' || norm === 'false' || norm === 'off' || norm === 'no')
}

/**
 * Emit exactly one structured gate-decision line. Pure side-effect; never throws (telemetry must
 * never break a turn). Writes a single JSON line to stdout at INFO severity for Cloud Logging.
 */
export function logGateDecision(record: GateDecisionLog): void {
  if (!telemetryEnabled()) return
  try {
    // Single JSON line → Cloud Logging jsonPayload at INFO. No bodies/PII by construction.
    console.log(JSON.stringify({ severity: 'INFO', logType: GATE_DECISION_LOG_TYPE, ...record }))
  } catch {
    /* never let telemetry break a reply */
  }
}
