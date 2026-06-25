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
  /^\s*(yes|confirm|ok|okay|sure|yep|yeah|do it|book it|go ahead|כן|אוקיי|אישור|בסדר|בוא נעשה|קדימה|אשר|טוב|בהחלט|יאללה|נשמע טוב|כל הכבוד)\s*[.!]?\s*$/i

const NO_PATTERNS =
  /^\s*(no|nope|cancel|stop|don't|dont|nevermind|never mind|לא|בטל|עצור|בטלו|אל תזמין|לבטל|סגור|אל כן|סליחה לא)\s*[.!]?\s*$/i

export function parseConfirmation(text: string): ConfirmationParse {
  if (YES_PATTERNS.test(text)) return 'yes'
  if (NO_PATTERNS.test(text)) return 'no'
  return 'unclear'
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
  [key: string]: unknown
}
