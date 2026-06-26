import type { NegotiationConstraints } from './negotiation-constraints.js'

export interface FlowResult {
  reply: string
  sessionComplete: boolean
  sessionFailed?: boolean
  escalated?: boolean
  paused?: boolean
  // Set by a state handler (e.g. hold-confirmation) when the customer's message is NOT
  // an answer to the pending question but a fresh intent (an inquiry, a different
  // booking, a cancellation). The dispatcher clears the pending state and re-routes the
  // message through normal intent handling instead of re-asking the stale prompt.
  redispatch?: boolean
}

export type ConfirmationParse = 'yes' | 'no' | 'unclear'

const YES_PATTERNS =
  /^\s*(yes|confirm|ok|okay|sure|yep|yeah|do it|book it|go ahead|כן|כו|אוקיי|אישור|בסדר|בוא נעשה|קדימה|אשר|טוב|בהחלט|יאללה|נשמע טוב|כל הכבוד)\s*[.!]?\s*$/i

const NO_PATTERNS =
  /^\s*(no|nope|cancel|stop|don't|dont|nevermind|never mind|לא|בטל|עצור|בטלו|אל תזמין|לבטל|סגור|אל כן|סליחה לא)\s*[.!]?\s*$/i

// Negation token appearing ANYWHERE — guards the lenient-yes path below so a hedged
// reply ("yes but no", "כן אבל לא") is never auto-upgraded to a confirmation.
const NEG_TOKEN =
  /\b(no|not|don'?t|cancel|stop|nope|never)\b|(^|\s)(לא|אל|בטל|עצור|ביטול)(\s|$)/i

// A reply that OPENS with one of these is an affirmative even when followed by extra
// words. Single-token forms only (multi-word affirmatives like "go ahead" / "בוא נעשה"
// are already covered by the strict whole-message YES_PATTERNS above). Includes the
// frequent one-char כן typo "כו".
const AFFIRM_WORDS = new Set([
  'yes', 'yeah', 'yep', 'yup', 'sure', 'okay', 'ok', 'confirm', 'confirmed',
  'כן', 'כו', 'אוקיי', 'אישור', 'בסדר', 'סבבה', 'בהחלט', 'יאללה', 'קדימה', 'אשר', 'טוב',
])

// Confirm-intent filler that may TRAIL a leading affirmative without turning the reply
// into a revision. If, after the opening affirmative, every remaining word is filler,
// the reply is a plain yes ("yes book me please" / "כן תקבע לי בבקשה"). Any other
// content (a day, a time, a different service) leaves it 'unclear' so the revision /
// re-ask path handles it instead of a wrong auto-confirm.
const CONFIRM_FILLER = new Set([
  // en
  'please', 'book', 'it', 'me', 'that', 'this', 'now', 'go', 'ahead', 'lock', 'in',
  'sounds', 'good', 'great', 'perfect', 'do', 'lets', "let's", 'the', 'my', 'a', 'for',
  // he
  'בבקשה', 'תקבע', 'תזמין', 'תסגור', 'לי', 'את', 'זה', 'המקום', 'מעולה', 'נשמע', 'יופי',
  'בוא', 'נסגור', 'נקבע', 'אפשר', 'רוצה', 'לסגור', 'לקבוע', 'בטוח', 'מצוין', 'תודה',
])

function confirmationWords(text: string): string[] {
  return text
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')
    .replace(/['’]/g, "'")
    .replace(/[!?.,;:"()\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
}

export function parseConfirmation(text: string): ConfirmationParse {
  // Order: strict no/yes first (canonical single-word replies), then the lenient
  // leading-affirmative pass that fixes the live confirmation loop where a clear
  // "yes, book me please" or a "כו" typo was re-asked forever as 'unclear'.
  if (NO_PATTERNS.test(text)) return 'no'
  if (YES_PATTERNS.test(text)) return 'yes'
  if (NEG_TOKEN.test(text)) return 'unclear'
  const words = confirmationWords(text)
  if (words.length === 0 || !AFFIRM_WORDS.has(words[0]!)) return 'unclear'
  return words.slice(1).every((w) => CONFIRM_FILLER.has(w)) ? 'yes' : 'unclear'
}

export type RetentionReply =
  | { kind: 'accept'; index: number } // 0-based index into the offered slots
  | { kind: 'decline' }
  | { kind: 'unclear' }

// Parse a customer's reply to the reschedule-retention offer. Decline reuses the shared
// cancel/no patterns (parseConfirmation === 'no'); a bare number in [1, offeredCount] accepts
// that slot; anything else is unclear (the handler re-asks). Mirrors parseConfirmation's purity.
export function parseRetentionReply(text: string, offeredCount: number): RetentionReply {
  if (parseConfirmation(text) === 'no') return { kind: 'decline' }
  const n = parseInt(text.trim(), 10)
  if (!isNaN(n) && n >= 1 && n <= offeredCount) return { kind: 'accept', index: n - 1 }
  return { kind: 'unclear' }
}

export interface BookingFlowContext {
  pendingBookingId?: string
  pendingSlot?: { start: string; end: string; serviceTypeId: string; serviceName: string; providerHint?: string | null }
  // Incremental slot memory: partial booking facts gathered across clarification
  // turns so we never re-ask something already known. Internal state only — never
  // echoed verbatim to the customer (G2). Resolved into pendingSlot once complete.
  slotDraft?: {
    dateStr?: string // 'YYYY-MM-DD' business-local, already deterministically resolved
    time?: { hour: number; minute: number }
    serviceTypeId?: string
    serviceName?: string
    participants?: number
  }
  // Set once a session greeting/intro has been delivered, so we never re-introduce.
  greeted?: boolean
  awaitingConfirmationFor?: 'hold' | 'cancellation' | 'cancellation_selection' | 'retention_offer'
  targetBookingId?: string
  detectedLanguage?: 'he' | 'en'
  cancellationCandidates?: string[]
  // Phase 3b reschedule-retention: the alternate slots offered before a confirmed cancel,
  // carried across the turn so the customer can pick one by number.
  retentionOfferedSlots?: Array<{ start: string; end: string; serviceTypeId: string; serviceName: string }>
  rescheduledFrom?: string
  clarificationAttempts?: number
  isReschedulingFlow?: boolean
  botPersona?: 'female' | 'male' | 'neutral'
  sessionUnknownCount?: number
  // Language: override locks the language for the session; offerPending means the inline offer was appended last turn
  languageOverride?: 'he' | 'en'
  languageSwitchOfferPending?: boolean
  // Negotiation memory: times the customer has ruled out this session (concrete
  // rejected instances + categorical avoid rules), so the PA never re-offers a slot
  // already refused. Deterministically subtracted from suggestions; see
  // negotiation-constraints.ts and NEGOTIATION_MEMORY_PLAN.md.
  negotiationConstraints?: NegotiationConstraints
  // The concrete slots offered in the LAST suggestion list. If the next turn doesn't
  // book one of them, they're promoted to rejectedSlots (batch rejection — "none of
  // those work"). Transient: consumed/cleared at the start of each turn.
  lastOfferedSlots?: import('./negotiation-constraints.js').RejectedSlot[]
  [key: string]: unknown
}

// Branch 3 manager session context. The orchestrator is stateless per turn, so the
// only state the manager session carries is the language-switch protocol (§3.4):
// a locked override and whether an inline switch offer was appended last turn.
// Mirrors the language fields of BookingFlowContext (Branch 4).
export interface ManagerFlowContext {
  // Locks the session language once the manager accepts/declines a switch offer.
  languageOverride?: 'he' | 'en'
  // True when the previous reply appended an inline switch offer awaiting a yes/no.
  languageSwitchOfferPending?: boolean
  // Negotiation memory (Phase 3 — read-side filter only for Branch 3; capture deferred).
  negotiationConstraints?: NegotiationConstraints
  [key: string]: unknown
}
