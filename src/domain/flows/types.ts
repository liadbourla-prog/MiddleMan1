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

export type ConfirmationParse = 'yes' | 'no' | 'unclear' | 'yes_with_question'

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

// A trailing question signal: an explicit question mark (he/ar/en) or a leading
// interrogative word. Used to recognise "yes + a side question" without treating a
// slot REVISION as a confirmation.
const QUESTION_RE = /[?؟]/
const INTERROGATIVE_WORDS = new Set([
  'who', 'what', 'when', 'where', 'why', 'how', 'which',
  'מי', 'מה', 'מתי', 'איפה', 'למה', 'איך', 'כמה', 'איזה', 'איזו',
])

export function parseConfirmation(text: string): ConfirmationParse {
  if (NO_PATTERNS.test(text)) return 'no'
  if (YES_PATTERNS.test(text)) return 'yes'
  if (NEG_TOKEN.test(text)) return 'unclear'
  const words = confirmationWords(text)
  if (words.length === 0 || !AFFIRM_WORDS.has(words[0]!)) return 'unclear'
  const rest = words.slice(1)
  if (rest.every((w) => CONFIRM_FILLER.has(w))) return 'yes'
  // A leading affirmative followed by a SIDE QUESTION (not a slot revision): confirm,
  // and let the caller answer the question. Reject if it carries a clock time (a likely
  // revision) — weekday/service revisions are caught by the booking-path re-extraction,
  // but a time is the strongest revision signal and must not auto-confirm.
  const hasQuestion = QUESTION_RE.test(text) || rest.some((w) => INTERROGATIVE_WORDS.has(w))
  const hasClockTime = /(?<![\d:])[\d]{1,2}:[\d]{2}(?![\d:])/.test(text)
  if (hasQuestion && !hasClockTime) return 'yes_with_question'
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
  // Set once the PA has softly asked a nameless customer for their name (WS-D). Guards
  // against re-asking every booking turn — the request is appended at most once per session.
  nameAsked?: boolean
  awaitingConfirmationFor?: 'hold' | 'cancellation' | 'cancellation_selection' | 'retention_offer'
  // WS3-T3.2: typed binding for a customer's answer to a PA list-question, so the reply
  // binds to THAT question's options BEFORE fresh intent re-extraction. `candidateIds` are
  // the booking ids offered (sorted order); `isRescheduling` distinguishes the reschedule
  // selection from the cancellation selection (same path, one flag). Set in PARALLEL with
  // the legacy fields (cancellationCandidates / awaitingConfirmationFor / isReschedulingFlow)
  // which remain the source of truth for the confirm/reschedule callers.
  pendingDecision?: {
    kind: 'booking_selection'
    candidateIds: string[]
    isRescheduling: boolean
  }
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
  // Set once a genuine special-arrangement request (private/group/out-of-hours) has been
  // escalated to the owner this session, so we notify them at most once per conversation.
  specialRequestEscalated?: boolean
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
  // The day an availability INQUIRY focused on, persisted so a bare continuation turn
  // ("I want to join") after the inquiry re-reads the SAME day's fresh spine — Gate 3's
  // strongest signal — and corrects a stale "full". Naturally dropped when the next turn
  // names a different day (that day wins). See resolveContinuationFocusDay.
  lastInquiryFocus?: { dateStr: string; serviceTypeId?: string }
  // WS3-T3.5: a bare same-day weekday ("Sunday" when today IS Sunday) is ambiguous —
  // the customer may mean today or the same day next week. When today still has open
  // sessions we ask one warm question and stash the two candidate dates here so the
  // next turn binds the answer ("today" / "next week") without re-resolving.
  pendingWeekdayClarification?: { weekday: number; todayStr: string; nextWeekStr: string; serviceTypeId?: string }
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
