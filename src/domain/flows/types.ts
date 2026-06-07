export interface FlowResult {
  reply: string
  sessionComplete: boolean
  sessionFailed?: boolean
  escalated?: boolean
  paused?: boolean
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
  awaitingConfirmationFor?: 'hold' | 'cancellation' | 'cancellation_selection'
  targetBookingId?: string
  detectedLanguage?: 'he' | 'en'
  cancellationCandidates?: string[]
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
