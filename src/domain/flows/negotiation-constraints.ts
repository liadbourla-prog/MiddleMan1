/**
 * Negotiation memory — pure helpers for per-session slot constraints.
 *
 * In a multi-turn slot negotiation the customer rules times out ("not Thursday 3pm",
 * "no mornings"). Those rejections previously lived only in the scrolling transcript,
 * so once they aged out of the window the PA could re-offer a time already refused.
 *
 * This module is the deterministic memory: a small `NegotiationConstraints` object
 * carried in the session context. The LLM never has to "remember" a rejection — these
 * constraints are subtracted from the engine's candidate slots BEFORE the LLM phrases a
 * suggestion (Principle #1: LLM interpretive only). See NEGOTIATION_MEMORY_PLAN.md.
 *
 * Pure: no DB, no side effects, no ambient clock (callers inject `now`). All wall-clock
 * arithmetic happens in the business timezone via `localParts`.
 *
 * Design invariants (locked):
 *  - Rejected slots are time-keyed, concrete-instance, SERVICE-AGNOSTIC: rejecting
 *    "yoga Thursday 3pm" suppresses 3pm that Thursday for every service (the customer is
 *    busy then). `serviceTypeId` is metadata only and never participates in matching.
 *  - "Thursday 3pm" is THAT Thursday's 3pm (a concrete instant), not a weekly recurrence.
 *  - Suppression applies to proactive SUGGESTIONS only — never to an explicit request.
 *    An explicit reference to a rejected time un-suppresses it (a mind-change).
 */

import { localParts } from '../availability/compute.js'
import type { Slot } from '../availability/compute.js'

/** A concrete slot instance the customer ruled out. ISO instants. */
export interface RejectedSlot {
  start: string
  end: string
  serviceTypeId?: string // metadata only — NOT used for matching
}

/** Categorical time preferences ("no mornings", "not Thursdays"). Business-local. */
export interface AvoidConstraint {
  beforeHour?: number // suppress slots whose local start hour < beforeHour (12 ⇒ "no mornings")
  afterHour?: number // suppress slots whose local start hour >= afterHour
  weekdays?: number[] // suppress these business-local weekdays (0=Sun … 6=Sat)
}

export interface NegotiationConstraints {
  rejectedSlots?: RejectedSlot[]
  avoid?: AvoidConstraint
}

/** Cap on stored rejected slots — a long session can't bloat the context/prompt. */
export const MAX_REJECTED_SLOTS = 12

function avoidIsEmpty(a: AvoidConstraint | undefined): boolean {
  if (!a) return true
  return a.beforeHour == null && a.afterHour == null && (a.weekdays == null || a.weekdays.length === 0)
}

/**
 * Housekeeping applied on session load: drop rejected slots whose start has passed
 * (the engine won't offer past slots anyway), and cap to the most recent N. Returns a
 * compacted object; empty fields are omitted so the stored context stays minimal.
 */
export function pruneConstraints(c: NegotiationConstraints | undefined, now: Date): NegotiationConstraints {
  if (!c) return {}
  const future = (c.rejectedSlots ?? []).filter((r) => new Date(r.start).getTime() > now.getTime())
  const capped = future.slice(-MAX_REJECTED_SLOTS)
  const out: NegotiationConstraints = {}
  if (capped.length > 0) out.rejectedSlots = capped
  if (c.avoid && !avoidIsEmpty(c.avoid)) out.avoid = c.avoid
  return out
}

/** True when a proactive suggestion of `start` should be suppressed. */
export function isSlotSuppressed(start: Date, c: NegotiationConstraints | undefined, tz: string): boolean {
  if (!c) return false
  const t = start.getTime()
  if (c.rejectedSlots?.some((r) => new Date(r.start).getTime() === t)) return true
  const a = c.avoid
  if (a && !avoidIsEmpty(a)) {
    const lp = localParts(start, tz)
    const hour = Math.floor(lp.minutes / 60)
    if (a.beforeHour != null && hour < a.beforeHour) return true
    if (a.afterHour != null && hour >= a.afterHour) return true
    if (a.weekdays && a.weekdays.includes(lp.dayOfWeek)) return true
  }
  return false
}

/** Drop suppressed slots from a candidate list (proactive suggestion path only). */
export function filterOpenSlots<T extends Slot>(
  slots: T[],
  c: NegotiationConstraints | undefined,
  tz: string,
): T[] {
  if (!c || (!c.rejectedSlots?.length && avoidIsEmpty(c.avoid))) return slots
  return slots.filter((s) => !isSlotSuppressed(s.start, c, tz))
}

/** Record one or more rejected slots, deduped by start instant and capped. */
export function addRejectedSlots(
  c: NegotiationConstraints | undefined,
  slots: RejectedSlot[],
): NegotiationConstraints {
  const existing = c?.rejectedSlots ?? []
  const seen = new Set(existing.map((r) => new Date(r.start).getTime()))
  const merged = [...existing]
  for (const s of slots) {
    const key = new Date(s.start).getTime()
    if (!seen.has(key)) {
      seen.add(key)
      merged.push(s)
    }
  }
  return { ...(c ?? {}), rejectedSlots: merged.slice(-MAX_REJECTED_SLOTS) }
}

/** Un-suppress a slot the customer has explicitly referenced again (mind-change). */
export function removeRejectedSlot(
  c: NegotiationConstraints | undefined,
  startISO: string,
): NegotiationConstraints {
  if (!c?.rejectedSlots?.length) return c ?? {}
  const t = new Date(startISO).getTime()
  const filtered = c.rejectedSlots.filter((r) => new Date(r.start).getTime() !== t)
  const out: NegotiationConstraints = { ...c }
  if (filtered.length > 0) out.rejectedSlots = filtered
  else delete out.rejectedSlots
  return out
}

/**
 * Merge categorical avoid rules (Phase 2 extraction feeds this). Hour bounds overwrite;
 * weekdays union. Enforcement is already live via {@link isSlotSuppressed}.
 */
export function mergeAvoid(
  c: NegotiationConstraints | undefined,
  avoid: AvoidConstraint,
): NegotiationConstraints {
  const prev = c?.avoid ?? {}
  const next: AvoidConstraint = { ...prev }
  if (avoid.beforeHour != null) next.beforeHour = avoid.beforeHour
  if (avoid.afterHour != null) next.afterHour = avoid.afterHour
  if (avoid.weekdays && avoid.weekdays.length > 0) {
    next.weekdays = Array.from(new Set([...(prev.weekdays ?? []), ...avoid.weekdays])).sort((a, b) => a - b)
  }
  return { ...(c ?? {}), avoid: next }
}
