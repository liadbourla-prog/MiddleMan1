/**
 * Pure greeting/social-pleasantry detector, shared between the Branch-4 dispatcher and the
 * owner-ping throttle (escalation/engine.ts). Lives in its own module so the throttle can
 * reuse it WITHOUT importing customer-booking.ts (which imports the engine — a cycle).
 *
 * A message qualifies only when it is SHORT and essentially just a pleasantry — "hi can I
 * book tomorrow?" classifies as booking and never reaches this check.
 */
const GREETING_SOCIAL_RE =
  /^(?:hi+|hey+|hello+|yo|sup|hiya|good\s*(?:morning|afternoon|evening|night)|how\s*(?:are|r)\s*(?:you|u)|how's\s*it\s*going|what'?s\s*up|thanks?|thank\s*you|thx|ty|ok(?:ay)?|cool|nice|great|bye+|goodbye|see\s*you|cheers|שלום|היי+|הי|הלו|אהלן|אהל[ןן]|בוקר\s*טוב|צהריים\s*טובים|ערב\s*טוב|לילה\s*טוב|מה\s*נשמע|מה\s*קורה|מה\s*שלומ(?:ך|ך)|תודה(?:\s*רבה)?|סבבה|אוקיי?|יופי|מגניב|ביי+|להתראות|כל\s*טוב)$/iu

export function looksLikeGreetingOrSocial(text: string): boolean {
  // Strip emoji, punctuation, and collapse whitespace, then bound the length so a
  // genuine request that merely opens with "hi" is never swallowed here.
  const cleaned = text
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')
    .replace(/['’]/g, '') // strip apostrophes so "what's" → "whats" (not "what s")
    .replace(/[!?.,;:"()\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length === 0) return false
  if (cleaned.split(' ').length > 4) return false
  return GREETING_SOCIAL_RE.test(cleaned)
}
