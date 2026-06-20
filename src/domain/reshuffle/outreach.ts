// Proactive Reshuffle Engine — outreach reply interpretation.
//
// This is the interpretive-LLM seam (CLAUDE.md principle 1): an LLM classifies a free-text
// reply, but the engine NEVER lets the LLM turn a hedge into an acceptance. The deterministic
// guardrails here are the safety net (scenario C3): an ambiguous reply can never become "yes".
//
// Message *composition* (warm phrasing via generateProactiveCustomerMessage) lives in the
// worker layer; this module is the pure, unit-testable interpretation half.

import type { Slot } from './types.js'

/** What the LLM classifier is asked to produce for a reply to a swap probe. */
export interface RawOutreachClassification {
  intent: 'accept' | 'decline' | 'counter' | 'unclear'
  /** Present only for `counter` — the alternative slot the customer proposed. */
  counterSlot?: Slot | null
  /** 0–1; an `accept` below the threshold is downgraded to `unclear`. */
  confidence?: number
}

export type OutreachVerdict =
  | { verdict: 'yes' }
  | { verdict: 'no' }
  | { verdict: 'counter'; counterSlot: Slot }
  | { verdict: 'unclear' }

export type OutreachClassifier = (text: string) => Promise<RawOutreachClassification>

/** Below this, an LLM `accept` is not trusted as a firm yes. */
const ACCEPT_CONFIDENCE_FLOOR = 0.6

// Deterministic hedge markers (EN + HE). If the reply hedges, it is NEVER an acceptance,
// regardless of what the LLM returned. Kept small and high-precision on purpose.
const HEDGE_MARKERS = [
  'maybe', 'not sure', 'unsure', 'let me check', 'let me see', "i'll check", 'i will check',
  "i'll think", 'think about it', 'perhaps', 'possibly', 'might', 'dunno', "don't know", 'idk',
  'אולי', 'לא בטוח', 'אבדוק', 'אני אבדוק', 'תן לי לחשוב', 'נראה',
]

function isHedging(text: string): boolean {
  const t = text.toLowerCase()
  return HEDGE_MARKERS.some((m) => t.includes(m))
}

function isUsableSlot(s: Slot | null | undefined): s is Slot {
  return !!s && typeof s.start === 'string' && s.start.length > 0 && typeof s.durationMin === 'number' && s.durationMin > 0
}

/**
 * Turn a free-text reply into a typed verdict. The LLM proposes; the guardrails dispose:
 * a hedging reply is always `unclear`, a low-confidence acceptance is `unclear`, and a
 * counter without a usable slot is `unclear`. Only an unambiguous, confident acceptance
 * becomes `yes`.
 */
export async function interpretOutreachReply(text: string, classify: OutreachClassifier): Promise<OutreachVerdict> {
  // Deterministic guardrail first — the LLM can never override a hedge into a commitment.
  if (isHedging(text)) return { verdict: 'unclear' }

  const raw = await classify(text)

  switch (raw.intent) {
    case 'counter':
      return isUsableSlot(raw.counterSlot)
        ? { verdict: 'counter', counterSlot: raw.counterSlot }
        : { verdict: 'unclear' }

    case 'accept': {
      const confident = raw.confidence === undefined || raw.confidence >= ACCEPT_CONFIDENCE_FLOOR
      return confident ? { verdict: 'yes' } : { verdict: 'unclear' }
    }

    case 'decline':
      return { verdict: 'no' }

    case 'unclear':
    default:
      return { verdict: 'unclear' }
  }
}
