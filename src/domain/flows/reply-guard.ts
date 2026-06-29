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
  /העברתי/, // I moved/rescheduled (phantom-reschedule claim — C2)
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
  /\b(?:i(?:'| ha)ve\s+moved|i\s+moved|moved\s+your)\b/i, // phantom-reschedule claim (C2)
]

export function assertsBookingConfirmed(text: string, lang: 'he' | 'en'): boolean {
  if (!text) return false
  const patterns = lang === 'he' ? HE_CONFIRMED : EN_CONFIRMED
  return patterns.some((re) => re.test(text))
}

// ── Generalized claim detection (L2 claim auditor, ACTION_GROUNDING_SPEC.md) ──────
//
// Branch 3 generalizes the booking guard above to every high-risk "said done" claim:
// a customer message sent on the owner's behalf, a Google Calendar connection, a
// cancellation. The orchestrator cross-checks the detected claims against what tools
// actually succeeded this turn (plus the ledger) and regenerates if any is unbacked.
// Detection is COMPLETED-claims only — offers/questions ("אשלח לו?", "want me to text
// him?") move the action forward and must never be flagged.

export type ActionClaim =
  | 'booking_made'
  | 'message_sent'
  | 'calendar_connected'
  | 'cancelled'
  | 'refunded'
  | 'broadcast_sent'
  | 'settings_changed'

// Sending a message TO A CUSTOMER (third person). Deliberately excludes "שלחתי לך" /
// "sent you" — that is the PA handing the owner something in-chat (e.g. a link), not a
// customer outreach.
const HE_MESSAGE_SENT = [
  /שלחתי\s+ל(?!ך)/, // I sent to him/her/them/<name> — not "to you"
  /ההודעה.{0,15}נשלחה/, // the message (to X) was (already) sent
  /יצרתי\s+(?:איתו|איתה|איתם)\s+קשר/, // I contacted him/her/them
  /פניתי\s+(?:אליו|אליה|אליהם)/, // I reached out to them
]
const EN_MESSAGE_SENT = [
  /\bi(?:'| ha)ve\s+(?:messaged|texted|contacted)\b/i,
  /\bi\s+(?:messaged|texted|contacted)\s+(?:him|her|them|\w+)\b/i,
  /\bi\s+sent\s+(?:him|her|them|\w+)\s+(?:a\s+)?(?:message|text|note)\b/i,
  /\b(?:the\s+)?(?:message|text)\s+(?:has\s+been\s+|was\s+|is\s+)?sent\b/i,
  /\breached\s+out\s+to\b/i,
]

const HE_CALENDAR_CONNECTED = [
  /היומן.{0,15}(?:מחובר|חובר|מסונכרן|סונכרן)/, // the calendar is (now/your) connected/synced
  /חיברתי\s+(?:את\s+)?(?:ה)?יומן/, // I connected the calendar
  /הסנכרון\s+(?:הושלם|פעיל)/, // sync is complete/active
]
const EN_CALENDAR_CONNECTED = [
  /\bcalendar\s+(?:is\s+)?(?:now\s+)?(?:connected|linked|synced)\b/i,
  /\b(?:i(?:'| ha)ve\s+)?connected\s+your\s+calendar\b/i,
  /\bsync(?:ing|ed)?\s+is\s+(?:now\s+)?(?:on|active|complete)\b/i,
]

const HE_CANCELLED = [
  /ביטלתי/, // I cancelled
  /(?:ה)?תור\s+בוטל/, // the appointment was cancelled
  /בוטל\s+(?:בהצלחה|לך)/, // cancelled (successfully / for you)
]
const EN_CANCELLED = [
  /\bi(?:'| ha)ve\s+cancell?ed\b/i,
  /\bi\s+cancell?ed\b/i,
  /\b(?:booking|appointment|class|session)\s+(?:has\s+been\s+|was\s+|is\s+)?cancell?ed\b/i,
]

// A completed REFUND to a customer ("I refunded ₪300", "the refund was issued"). Excludes
// offers ("want me to refund?", "להחזיר?") by requiring the completed first-person/passive form.
const HE_REFUNDED = [
  /החזרתי/, // I refunded/returned (money)
  /(?:ה)?זיכוי\s+בוצע/, // the refund was processed
  /הוחזר\s+(?:לך|ה?כסף|התשלום)/, // the money/payment was returned
  /זוכית/, // you were refunded/credited
]
const EN_REFUNDED = [
  /\bi(?:'| ha)ve\s+refunded\b/i,
  /\bi\s+refunded\b/i,
  /\b(?:i(?:'| ha)ve\s+)?issued\s+(?:the\s+|a\s+)?refund\b/i,
  /\brefund\s+(?:has\s+been\s+|was\s+|is\s+)?(?:processed|issued|done|complete)\b/i,
  /\b(?:processed|issued)\s+(?:the\s+|a\s+)?refund\b/i,
]

// A completed BROADCAST / "everyone has been told" claim (announcement to MANY customers).
// Distinct from message_sent (one customer). Excludes offers ("should I let everyone know?").
const HE_BROADCAST_SENT = [
  /שלחתי\s+ל(?:כל|כולם)/, // I sent to all/everyone
  /(?:ההודעה|ההכרזה|העדכון)\s+נשלח(?:ה)?\s+לכל/, // the message/announcement was sent to all
  /עדכנתי\s+את\s+(?:כל\s+)?(?:ה)?לקוחות/, // I updated (all) the customers
  /יידעתי\s+את\s+(?:כל\s+)?(?:ה)?לקוחות|יידעתי\s+את\s+כולם/, // I informed the customers/everyone
]
const EN_BROADCAST_SENT = [
  /\b(?:i(?:'| ha)ve\s+)?notified\s+(?:all\s+|every\s+|your\s+|the\s+)*(?:customers|clients|everyone)\b/i,
  /\bcustomers\s+have\s+been\s+notified\b/i,
  /\b(?:the\s+)?(?:announcement|broadcast)\s+(?:has\s+been\s+|was\s+|is\s+)?(?:sent|sent\s+out)\b/i,
  // Completed first-person only ("I told everyone", "I've let all customers know") — the offer
  // form ("Should I let everyone know?") deliberately stays out (it moves the action forward).
  /\bi(?:'| ha)ve\s+(?:let|told)\s+(?:everyone|all\s+(?:your\s+)?(?:customers|clients))\b/i,
  /\bi\s+told\s+(?:everyone|all\s+(?:your\s+)?(?:customers|clients))\b/i,
]

// A completed business-config change ("I set the price", "updated your hours"). Scoped to a
// settings noun so it never sweeps conversational glue, and deliberately avoids קבעתי/booked
// (that is the booking class). Excludes offers ("want me to change the price?").
const HE_SETTINGS_CHANGED = [
  /(?:עדכנתי|שיניתי|הגדרתי)\s+(?:את\s+)?(?:ה)?(?:מחיר|מחירים|תמחור|שעות|שעת|צבע|קיבולת|הגדרות|מדיניות)/,
  /(?:המחיר|המחירים|השעות|הקיבולת|הצבע)\s+(?:עודכן|עודכנו|שונה|שונו|הוגדר|הוגדרו)/,
]
const EN_SETTINGS_CHANGED = [
  /\bi(?:'| ha)ve\s+(?:set|updated|changed|adjusted)\s+(?:the\s+|your\s+)?(?:price|pricing|rate|hours|colou?r|capacity|settings?|schedule|policy)\b/i,
  /\bi\s+(?:set|updated|changed|adjusted)\s+(?:the\s+|your\s+)?(?:price|pricing|rate|hours|colou?r|capacity|settings?|schedule|policy)\b/i,
  /\b(?:the\s+|your\s+)?(?:price|pricing|hours|capacity|colou?r)\s+(?:has\s+been\s+|have\s+been\s+|is\s+now\s+|are\s+now\s+)?(?:updated|changed|set|adjusted)\b/i,
]

export function detectActionClaims(text: string, lang: 'he' | 'en'): ActionClaim[] {
  if (!text) return []
  const he = lang === 'he'
  const claims: ActionClaim[] = []
  if ((he ? HE_CONFIRMED : EN_CONFIRMED).some((re) => re.test(text))) claims.push('booking_made')
  if ((he ? HE_MESSAGE_SENT : EN_MESSAGE_SENT).some((re) => re.test(text))) claims.push('message_sent')
  if ((he ? HE_CALENDAR_CONNECTED : EN_CALENDAR_CONNECTED).some((re) => re.test(text))) claims.push('calendar_connected')
  if ((he ? HE_CANCELLED : EN_CANCELLED).some((re) => re.test(text))) claims.push('cancelled')
  if ((he ? HE_REFUNDED : EN_REFUNDED).some((re) => re.test(text))) claims.push('refunded')
  if ((he ? HE_BROADCAST_SENT : EN_BROADCAST_SENT).some((re) => re.test(text))) claims.push('broadcast_sent')
  if ((he ? HE_SETTINGS_CHANGED : EN_SETTINGS_CHANGED).some((re) => re.test(text))) claims.push('settings_changed')
  return claims
}
