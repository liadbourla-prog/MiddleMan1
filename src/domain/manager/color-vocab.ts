// Owner-facing color vocabulary → Google Calendar colorId.
//
// Google Calendar events support exactly 11 fixed colors (there is no arbitrary
// hex). The owner says a color word conversationally ("make Yoga blue", "צבע
// אדום"); this maps it to the nearest of those 11. Pure + fully unit-tested.
//
// The 11 Google event colors (colorId → name):
//   1 Lavender · 2 Sage · 3 Grape · 4 Flamingo · 5 Banana · 6 Tangerine
//   7 Peacock · 8 Graphite · 9 Blueberry · 10 Basil · 11 Tomato

/**
 * Owner color words (English + Hebrew + common synonyms + the canonical Google
 * names) → Google colorId. Keys are normalized (lowercased, whitespace-collapsed)
 * exactly as `colorWordToGoogleId` normalizes its input before lookup.
 */
const COLOR_WORD_TO_ID: Record<string, number> = {
  // red → Tomato (11)
  red: 11,
  tomato: 11,
  אדום: 11,
  // orange → Tangerine (6)
  orange: 6,
  tangerine: 6,
  כתום: 6,
  // yellow → Banana (5)
  yellow: 5,
  banana: 5,
  צהוב: 5,
  // green → Basil (10); light green / sage → Sage (2)
  green: 10,
  basil: 10,
  'dark green': 10,
  ירוק: 10,
  'light green': 2,
  sage: 2,
  'ירוק בהיר': 2,
  // blue → Peacock (7); dark blue / navy → Blueberry (9)
  blue: 7,
  peacock: 7,
  כחול: 7,
  'dark blue': 9,
  navy: 9,
  blueberry: 9,
  'כחול כהה': 9,
  // teal / turquoise → Peacock (7)
  teal: 7,
  turquoise: 7,
  cyan: 7,
  טורקיז: 7,
  // purple → Grape (3); light purple / lavender → Lavender (1)
  purple: 3,
  violet: 3,
  grape: 3,
  סגול: 3,
  'light purple': 1,
  lavender: 1,
  'סגול בהיר': 1,
  לבנדר: 1,
  // pink → Flamingo (4)
  pink: 4,
  flamingo: 4,
  ורוד: 4,
  // gray → Graphite (8)
  gray: 8,
  grey: 8,
  graphite: 8,
  אפור: 8,
}

/**
 * Map an owner's raw color word to a Google Calendar colorId (1–11), or null if
 * it isn't a color we recognize (the PA then lists the palette / asks again).
 * Case- and whitespace-insensitive; handles English, Hebrew, and common synonyms.
 */
export function colorWordToGoogleId(word: string): number | null {
  if (!word) return null
  const normalized = word.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!normalized) return null
  return COLOR_WORD_TO_ID[normalized] ?? null
}
