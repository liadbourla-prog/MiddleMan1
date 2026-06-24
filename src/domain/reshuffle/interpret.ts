// Proactive Reshuffle Engine — counter-offer extraction (Phase 7.2; design §6).
//
// The reshuffle reply pipeline (outreach.ts) already supports a `counter` verdict, but the v1
// classifier only did deterministic yes/no — so an off-script reply ("can we do Tuesday at 3?")
// fell through to `unclear` and looped, a managed-conversation dead-letter. This module fills that
// gap: deterministic yes/no first (fast, no LLM), then LLM extraction of a proposed alternative
// slot. Mirrors coordination/interpret.ts: the LLM only extracts day/time PIECES; resolveSlotRange
// does the calendar arithmetic (Principle #1), and interpretOutreachReply's guardrail still has the
// final say (a hedge / low-confidence / unusable slot is never an acceptance).

import { resolveSlotRange } from '../availability/resolve-slot.js'
import { interpretMeetingReply, type MeetingReplyOutput } from '../../adapters/llm/client.js'
import { parseConfirmation } from '../flows/types.js'
import type { RawOutreachClassification, OutreachClassifier } from './outreach.js'

/**
 * Pure: map the LLM-extracted reply pieces into a reshuffle outreach classification. A
 * propose_time that resolves to a real slot becomes a `counter` (the customer named a different
 * time); decline → decline; anything else → unclear. The slot's duration is the offered service's.
 */
export function mapReplyToCounter(
  raw: MeetingReplyOutput,
  opts: { durationMin: number; timezone: string; now: Date },
): RawOutreachClassification {
  if (raw.intent === 'decline') return { intent: 'decline' }
  if (raw.intent === 'propose_time' && raw.startTime) {
    const resolved = resolveSlotRange(
      {
        date: {
          relativeDay: raw.relativeDay ?? null,
          weekday: raw.weekday ?? null,
          explicitDate: raw.explicitDate ?? null,
        },
        startTime: raw.startTime,
        endTime: null,
        durationMinutes: opts.durationMin,
      },
      opts.timezone,
      opts.now,
    )
    if (resolved.ok) {
      return { intent: 'counter', counterSlot: { start: resolved.start.toISOString(), durationMin: opts.durationMin } }
    }
  }
  return { intent: 'unclear' }
}

/**
 * Build the OutreachClassifier for a live offer: deterministic yes/no first (no LLM), then LLM
 * counter-offer extraction resolved deterministically. The interpretOutreachReply guardrail wraps
 * this and downgrades hedges / unusable slots to `unclear`.
 */
export function buildOutreachClassifier(opts: {
  durationMin: number
  timezone: string
  lang: 'he' | 'en'
  candidateSummary: string
  now?: Date
}): OutreachClassifier {
  return async (text: string): Promise<RawOutreachClassification> => {
    const yn = parseConfirmation(text)
    if (yn === 'yes') return { intent: 'accept', confidence: 0.95 }
    if (yn === 'no') return { intent: 'decline' }
    const res = await interpretMeetingReply(text, opts.candidateSummary, opts.lang)
    if (!res.ok) return { intent: 'unclear' }
    return mapReplyToCounter(res.data, { durationMin: opts.durationMin, timezone: opts.timezone, now: opts.now ?? new Date() })
  }
}
