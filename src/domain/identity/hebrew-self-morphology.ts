// Deterministic Hebrew self-morphology detector — infers the SENDER's own grammatical gender
// from their first-person Hebrew, with NO LLM call.
//
// Why deterministic here: the Branch-3 orchestrator is a function-calling loop with no
// per-turn structured output to carry an LLM `selfGenderEvidence` field (the customer path
// gets that from its extractor — see client.ts). This pure detector is the owner-path producer
// and a customer-path backstop. It is the `self_morphology` signal (rank 3) feeding
// `resolveAddresseeGender`.
//
// Precision over recall (a wrong reading persists and outranks a name guess): it fires ONLY on
// an explicit first-person pronoun (אני / ואני / שאני / אנוכי…) within a short window of a
// curated, UNAMBIGUOUS gendered form. Ambiguous unvocalized forms (רוצה = rotzeh/rotza, באה)
// are excluded. Past-tense first-person is gender-neutral in Hebrew, so it is never a signal.
// No first-person pronoun → null (a third party the sender mentions is not the sender).

const NIQQUD_RE = /[֑-ׇ]/g

// First-person singular pronoun token (optionally with a ו/ש/כש proclitic): אני, ואני, שאני,
// כשאני, אנוכי, אנכי. Matches the WHOLE token only.
const FIRST_PERSON_RE = /^(?:ו|ש|כש|וכש|כ)?(?:אני|אנוכי|אנכי)$/

// Unambiguous feminine first-person forms (present participles / adjectives whose spelling
// differs from the masculine). Excludes forms that are identical unvocalized to the masculine.
const FEMALE_FORMS: ReadonlySet<string> = new Set([
  'מעוניינת', 'מתעניינת', 'צריכה', 'יכולה', 'אוהבת', 'מחפשת', 'הולכת', 'גרה',
  'שמחה', 'בטוחה', 'מעדיפה', 'חושבת', 'יודעת', 'מבינה', 'עסוקה', 'פנויה',
  'מתכוונת', 'חייבת', 'עובדת', 'מצליחה', 'מרגישה', 'מתלבטת', 'שואלת', 'מבקשת',
  'מודאגת', 'מתלבטת', 'אמורה',
])

// Unambiguous masculine first-person forms (the marked masculine stem; a female would add a
// suffix). Guarded by the required first-person pronoun, so "אתה צריך" (you-need) never matches.
const MALE_FORMS: ReadonlySet<string> = new Set([
  'מעוניין', 'מתעניין', 'צריך', 'יכול', 'אוהב', 'מחפש', 'הולך', 'גר',
  'שמח', 'בטוח', 'מעדיף', 'חושב', 'יודע', 'מבין', 'עסוק', 'פנוי',
  'מתכוון', 'חייב', 'עובד', 'מצליח', 'מרגיש', 'מתלבט', 'שואל', 'מבקש', 'אמור',
])

const WINDOW = 3

/**
 * Infer the sender's grammatical gender from their first-person Hebrew, or null when there is
 * no confident self-reference. Pure and deterministic.
 */
export function inferSelfGenderFromHebrew(text: string | null | undefined): 'male' | 'female' | null {
  if (!text) return null
  const stripped = text.normalize('NFC').replace(NIQQUD_RE, '')
  // Hebrew-letter tokens only (drops punctuation, digits, Latin, emoji).
  const tokens = stripped.split(/[^א-ת]+/).filter(Boolean)
  for (let i = 0; i < tokens.length; i++) {
    if (!FIRST_PERSON_RE.test(tokens[i]!)) continue
    for (let j = i + 1; j <= i + WINDOW && j < tokens.length; j++) {
      const t = tokens[j]!
      if (FEMALE_FORMS.has(t)) return 'female'
      if (MALE_FORMS.has(t)) return 'male'
    }
  }
  return null
}
