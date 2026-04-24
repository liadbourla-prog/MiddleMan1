export interface FlowResult {
  reply: string
  sessionComplete: boolean
}

export type ConfirmationParse = 'yes' | 'no' | 'unclear'

const YES_PATTERNS =
  /^\s*(yes|confirm|ok|okay|sure|yep|yeah|do it|book it|go ahead|כן|אוקיי|אישור|בסדר|בוא נעשה|קדימה|אשר)\s*[.!]?\s*$/i

const NO_PATTERNS =
  /^\s*(no|nope|cancel|stop|don't|dont|nevermind|never mind|לא|בטל|עצור|בטלו|אל תזמין|לבטל)\s*[.!]?\s*$/i

export function parseConfirmation(text: string): ConfirmationParse {
  if (YES_PATTERNS.test(text)) return 'yes'
  if (NO_PATTERNS.test(text)) return 'no'
  return 'unclear'
}

export interface BookingFlowContext {
  pendingBookingId?: string
  pendingSlot?: { start: string; end: string; serviceTypeId: string; serviceName: string }
  awaitingConfirmationFor?: 'hold' | 'cancellation' | 'cancellation_selection'
  targetBookingId?: string
  detectedLanguage?: 'he' | 'en'
  cancellationCandidates?: string[]
  rescheduledFrom?: string
  clarificationAttempts?: number
  botPersona?: 'female' | 'male' | 'neutral'
  [key: string]: unknown
}
