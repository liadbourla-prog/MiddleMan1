/**
 * Phase 0 (T0.1/T0.2) — inbound-decision telemetry for the Google inbound translator.
 *
 * One structured line per reconciled Google event, emitted at each reconcile door
 * (push/tick via `runInboundSync`, read via `reconcileScheduleWindowOnRead`) so the
 * translator's per-event decision is OBSERVABLE in production. A mis-classified event
 * (a personal "Pilates" workout opened as a public class, or a real class left opaque)
 * is otherwise invisible — the same X1 gap that blocked the P2 red-team, where prod
 * emitted only Fastify request logs and no app-level decision trace.
 *
 * HARD CONSTRAINT (decision #10 / privacy): ids + enums + null ONLY. NEVER an event
 * title (`summary`), description, body, customer text, or phone number. The fields
 * below are categorical / id-shaped by construction.
 *
 * Emitted as a single JSON line on stdout with `severity:"INFO"` and a stable
 * `logType:"inbound_decision"` marker. On Cloud Run, Cloud Logging auto-parses a JSON
 * stdout line into a structured `jsonPayload` at the given severity — so the line is
 * queryable in prod (filter: `jsonPayload.logType="inbound_decision"`). This mirrors
 * the X1 fix (commit 997e4ae): app-level structured logs that actually reach Cloud
 * Logging, not just Fastify request logs.
 */

/** The stable marker every inbound-decision line carries. Filter on this in Cloud Logging. */
export const INBOUND_DECISION_LOG_TYPE = 'inbound_decision'

/**
 * What the translator decided for a single reconciled owner/PA event.
 *  - `class_materialized`   — owner-added event certainly matched a class service ⇒ bookable class block (Phase 1).
 *  - `block_opaque`         — owner-added event kept as an opaque busy-block (title discarded; today's default).
 *  - `weak_pending_confirm` — matched but not certain ⇒ occupies the slot, relayed to the owner (Phase 1).
 *  - `booking_cancelled`    — owner deleted a PA-managed booking event ⇒ owner-wins cancellation candidate.
 *  - `echo_ignored`         — a PA-managed event came back unchanged (etag match) ⇒ loop-prevention no-op.
 */
export type InboundDecision =
  | 'class_materialized'
  | 'block_opaque'
  | 'weak_pending_confirm'
  | 'booking_cancelled'
  | 'echo_ignored'

/** Which trigger drove the reconcile that produced this decision. */
export type ViaTrigger = 'push' | 'tick' | 'read'

/** The per-event inbound-decision record. Ids + enums + null ONLY — no titles/bodies. */
export interface InboundDecisionLog {
  businessId: string
  googleEventId: string
  decision: InboundDecision
  /** The matched service_type id when a title→service match occurred, else null. */
  matchedServiceTypeId: string | null
  /** How the match was made (e.g. 'template' | 'marker'), else null. Categorical, never free text. */
  matchTier: string | null
  viaTrigger: ViaTrigger
}

/**
 * Telemetry is ON by default (the X1 fix needs it live in prod at INFO). Set
 * `INBOUND_TELEMETRY` to `0` / `false` / `off` / `no` to silence it. Evaluated per-call
 * so tests and operators can toggle without a restart.
 */
function telemetryEnabled(): boolean {
  const v = process.env['INBOUND_TELEMETRY']
  if (v == null) return true
  const norm = v.trim().toLowerCase()
  return !(norm === '0' || norm === 'false' || norm === 'off' || norm === 'no')
}

/**
 * Emit exactly one structured inbound-decision line. Pure side-effect; never throws
 * (telemetry must never break a reconcile). Writes a single JSON line to stdout at INFO
 * severity for Cloud Logging. No bodies/PII by construction.
 */
export function logInboundDecision(record: InboundDecisionLog): void {
  if (!telemetryEnabled()) return
  try {
    console.log(JSON.stringify({ severity: 'INFO', logType: INBOUND_DECISION_LOG_TYPE, ...record }))
  } catch {
    /* never let telemetry break a reconcile */
  }
}
