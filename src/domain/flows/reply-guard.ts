/**
 * Reply-vs-state binding guard (Branch 4 cardinal safety).
 *
 * The customer reply LLM phrases a sanitized situation. On non-success paths the
 * transcript can be saturated with confirmation-shaped context ("…17:00. לסגור?"),
 * and the model may hallucinate a DONE-booking claim ("קבעתי ✅") even though the
 * deterministic engine wrote nothing. That is the cardinal "said done, didn't do"
 * failure. `assertsBookingConfirmed` detects a reply that CLAIMS a booking is made
 * so the caller can reject/regenerate it whenever no booking was actually persisted.
 *
 * Pure + synchronous: detection only. It matches *completed* claims, never offers
 * or questions ("רוצה שאקבע?", "shall I book it?") — those move the booking forward
 * and must be allowed.
 */

// Hebrew: first-person/stated completion ("I booked you", "you're registered",
// "the appointment was set"). Deliberately excludes future/offer forms (לקבוע,
// אקבע, רוצה שאקבע) so a normal "shall I lock it in?" prompt is not flagged.
const HE_CONFIRMED = [
  /קבעתי/, // I booked/set
  /שרייְנתי|שריינתי/, // I reserved
  /רשמתי\s+אותך/, // I registered you
  /נרשמת/, // you got registered
  /(?:אתה|את)\s+רשומ(?:ה)?/, // you are registered
  /רשומ(?:ה)?\s+לך/, // registered for you
  /נקבע\s+לך/, // it's been set for you
  /התור\s+נקבע/, // the appointment was set
  /הזמנתי\s+לך/, // I booked for you
]

// English: completed claims only. \bbooked\b / reserved / registered / "all set" /
// "locked it in" / "signed you up". Offers ("to book", "shall I book") are excluded
// by requiring the completed wording.
const EN_CONFIRMED = [
  /\byou(?:'| a)re\s+(?:all\s+)?(?:booked|set|registered)\b/i,
  /\bi(?:'| ha)ve\s+booked\b/i,
  /\bi\s+booked\b/i,
  /\bi(?:'| ha)ve\s+(?:reserved|registered|signed)\b/i,
  /\blocked\s+it\s+in\b/i,
  /\bsigned\s+you\s+up\b/i,
  /\byour\s+(?:booking|appointment|spot)\s+is\s+(?:confirmed|booked|set)\b/i,
]

export function assertsBookingConfirmed(text: string, lang: 'he' | 'en'): boolean {
  if (!text) return false
  const patterns = lang === 'he' ? HE_CONFIRMED : EN_CONFIRMED
  return patterns.some((re) => re.test(text))
}
