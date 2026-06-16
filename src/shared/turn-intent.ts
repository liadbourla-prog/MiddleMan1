import { z } from 'zod'

/**
 * Shared turn-intent triage for every multi-step setup flow (skills AND the
 * Branch-3 manager onboarding). Setup steps tend to understand only
 * approve/skip/edit, so a natural "sure, but can I tell you about our team
 * first?", a side question, or a volunteered fact gets ignored and the step just
 * re-asks. This module gives every flow one uniform way to detect that and resume.
 *
 * It is deliberately dependency-free (no LLM/adapter imports) so it lives cleanly
 * in the shared contract layer: each caller injects its own JSON-LLM function and
 * its own save/present callbacks.
 */

export const turnIntentSchema = z.object({
  kind: z.enum(['answer', 'lead_in', 'info', 'question', 'go_back']),
  // A concrete business fact the owner volunteered (for 'info'); null otherwise.
  capture: z.string().nullable().optional(),
  // If the volunteered fact reads like a customer FAQ, the extracted Q/A.
  faqQuestion: z.string().nullable().optional(),
  faqAnswer: z.string().nullable().optional(),
})
export type TurnIntent = z.infer<typeof turnIntentSchema>

/** System prompt for the triage call. `stepAsk` is a short summary of what the
 *  current step just asked, so the classification is step-aware. */
export function buildTurnIntentPrompt(stepAsk: string): string {
  return `You are triaging a business owner's reply during PA setup.
The PA just asked the owner: """${stepAsk}"""

Classify the owner's reply into one "kind":
- "answer": they are directly answering, approving, editing, or skipping THAT question. This is the DEFAULT — prefer it whenever the reply plausibly responds to the question.
- "lead_in": they want to tell you something but haven't said it yet — e.g. "sure, but can I tell you about our team first?", "I want to add something", "אפשר לספר לך משהו קודם?". No concrete fact is included yet.
- "info": they volunteered a concrete business fact that is NOT an answer to the current question (e.g. "our prices went up", "the main instructor is Yossi"). Put the fact in "capture"; if it reads like a customer FAQ, also fill faqQuestion + faqAnswer.
- "question": they asked YOU a question instead of answering.
- "go_back": they want to change or revisit something asked earlier.

Return JSON. When unsure, choose "answer".`
}

export interface InterjectionHandlers {
  lang: 'he' | 'en'
  /** Re-render the current step's prompt, so we resume exactly where we paused. */
  presentStep: () => string
  /** Persist a volunteered fact as a customer FAQ (optional). */
  saveFaq?: (question: string, answer: string) => Promise<void>
  /** Persist a volunteered fact / question as a free-form note (optional). */
  saveNote?: (text: string) => Promise<void>
}

/**
 * Turn a triaged intent into the reply for an interjection — or `null` when it's
 * a direct answer (the caller then runs its normal step logic). Fail-safe: a
 * `null` intent (triage failed/unavailable) returns `null`, so the flow is never
 * blocked by triage problems.
 */
export async function resolveInterjection(intent: TurnIntent | null, h: InterjectionHandlers): Promise<string | null> {
  if (!intent || intent.kind === 'answer') return null
  const he = h.lang === 'he'

  if (intent.kind === 'lead_in') {
    // Invite the detail; the next turn carries the content. Don't re-present the
    // step yet — we are pausing it on purpose.
    return he ? 'בכיף, ספר לי — אני מקשיב.' : "Sure — go ahead, I'm listening."
  }

  if (intent.kind === 'info') {
    if (intent.faqQuestion && intent.faqAnswer && h.saveFaq) await h.saveFaq(intent.faqQuestion, intent.faqAnswer)
    else if (intent.capture && h.saveNote) await h.saveNote(intent.capture)
    const ack = he ? 'רשמתי 👍' : 'Noted 👍'
    return `${ack}\n\n${h.presentStep()}`
  }

  // 'question' or 'go_back' — acknowledge (and capture), then resume the step.
  if (intent.capture && h.saveNote) await h.saveNote(intent.capture)
  const ack = intent.kind === 'go_back'
    ? (he ? 'הבנתי, רשמתי לי את זה.' : "Got it — I've noted that.")
    : (he ? 'שאלה טובה — בוא נשלים את ההגדרה ואחזור לזה.' : "Good question — let's finish setup and I'll come back to it.")
  return `${ack}\n\n${h.presentStep()}`
}

/** Bare control words (≤2 words that are approve/skip/cancel) skip the LLM triage
 *  — a fast path so simple confirmations stay instant and free. The caller passes
 *  its own control-word predicate (each flow has its own matchers). */
export function isBareControl(text: string, isControl: (t: string) => boolean): boolean {
  return text.trim().split(/\s+/).filter(Boolean).length <= 2 && isControl(text)
}
