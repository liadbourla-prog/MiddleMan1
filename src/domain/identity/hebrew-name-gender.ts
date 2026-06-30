// Offline, deterministic Hebrew given-name → grammatical-gender dictionary.
//
// One of the two signal producers feeding `resolveAddresseeGender` (the other is
// self-morphology harvested from the sender's own Hebrew). This one is a pure, static
// lookup — NO LLM, NO network, no DB — so it is cheap, deterministic, and safe to call on
// every inbound. It maps a person's FIRST given-name token to 'male' | 'female', and
// returns `null` for anything it is not confident about (unknown, Latin-script, emoji, or
// genuinely UNISEX names). "Unknown" is a first-class answer: a wrong guess mis-genders a
// real person, so the conservative default is null and a higher-confidence signal
// (self-morphology, or the owner's explicit setCustomerGender) decides instead.
//
// Confidence tier: `name` (rank 2 in the resolver). Seeded with the most common Israeli
// given names; extend the sets as real data surfaces. Correctness over coverage — only add
// a name here when its gender is unambiguous.

// Strip Hebrew niqqud / cantillation marks (U+0591–U+05C7) and keep only Hebrew letters
// (U+05D0–U+05EA), so punctuation, emoji, digits, and Latin characters fall away. A token
// that reduces to empty (Latin name, emoji) yields null downstream.
const NIQQUD_RE = /[֑-ׇ]/g
const NON_HEBREW_LETTER_RE = /[^א-ת]/g

function normalizeFirstToken(raw: string): string {
  if (!raw) return ''
  const first = raw.trim().split(/\s+/)[0] ?? ''
  return first.normalize('NFC').replace(NIQQUD_RE, '').replace(NON_HEBREW_LETTER_RE, '')
}

// Clearly-masculine common Israeli given names.
const MALE_NAMES: ReadonlySet<string> = new Set([
  'דוד', 'משה', 'יוסף', 'יוסי', 'אברהם', 'אבי', 'יעקב', 'קובי', 'יצחק', 'איציק',
  'שלמה', 'שמואל', 'אהרון', 'בנימין', 'בני', 'דניאל', 'יונתן', 'יהונתן', 'נתן', 'איתי',
  'איתן', 'אורי', 'עידו', 'עומר', 'רועי', 'ניר', 'גיא', 'ארז', 'רן', 'עמוס',
  'גלעד', 'אלון', 'יורם', 'חיים', 'מאיר', 'צבי', 'דב', 'זאב', 'ארי', 'אריה',
  'ברק', 'עוז', 'עידן', 'יהודה', 'שמעון', 'ראובן', 'אשר', 'גד', 'דן', 'נפתלי',
  'מרדכי', 'מוטי', 'בועז', 'עמיחי', 'אליהו', 'אלי', 'נדב', 'יואב', 'אסף', 'תומר',
  'ליאור', 'אורן', 'גידי', 'רפאל', 'רפי', 'מתן', 'יניב', 'שחף', 'אלעד', 'ערן',
  'גבריאל', 'מנחם', 'נחום', 'עוזי', 'יגאל', 'עמרי', 'הראל', 'ישראל', 'שי',
])

// Clearly-feminine common Israeli given names.
const FEMALE_NAMES: ReadonlySet<string> = new Set([
  'שרה', 'רבקה', 'רחל', 'לאה', 'מרים', 'חנה', 'אסתר', 'רות', 'נעמי', 'דנה',
  'נועה', 'מיכל', 'יעל', 'תמר', 'שירה', 'מאיה', 'ליאת', 'אורלי', 'גלית', 'סיגל',
  'רונית', 'אילנה', 'אורית', 'מירב', 'הילה', 'ענת', 'דפנה', 'יערה', 'אביגיל', 'שני',
  'ספיר', 'נטלי', 'מורן', 'קרן', 'ליהי', 'הדס', 'אפרת', 'מאי', 'אלינור', 'גלי',
  'נופר', 'עדיה', 'שירן', 'דריה', 'אגם', 'אודליה', 'רעות', 'מיכאלה', 'גפן',
  'מיה', 'יסמין', 'לירז', 'לימור', 'שלומית', 'תהילה', 'איילת', 'נורית', 'תמרה',
  'אביבית', 'חגית', 'ורד', 'סמדר', 'בתיה', 'זהבה', 'מלכה', 'פנינה', 'גילה', 'ציפי',
  'רוית', 'שירלי', 'מעיין', 'אלה', 'נגה', 'טליה', 'יהודית', 'דבורה', 'ברכה', 'מרגלית',
])

// Genuinely UNISEX names — explicitly return null even though they are common, so a guess
// is never made on them. (These appear in neither set above, but listing them explicitly
// documents the intent and guards against a future accidental add to MALE/FEMALE.)
const UNISEX_NAMES: ReadonlySet<string> = new Set([
  'גל', 'שיר', 'רותם', 'עדן', 'אופיר', 'טל', 'נועם', 'יובל', 'עמית', 'אור',
  'רוני', 'עדי', 'מור', 'נטע', 'אריאל', 'שחר', 'חן', 'ליעד', 'אופק', 'הדר',
  'שון', 'אלמוג', 'סתיו', 'רום', 'דקל', 'ניצן', 'עינב', 'שקד', 'אביב', 'יהל',
])

/**
 * Map a display name's first given-name token to a grammatical gender, or `null` when not
 * confident (unknown / unisex / non-Hebrew / empty). Pure and deterministic.
 */
export function genderFromName(displayName: string | null | undefined): 'male' | 'female' | null {
  const name = normalizeFirstToken(displayName ?? '')
  if (!name) return null
  if (UNISEX_NAMES.has(name)) return null
  if (MALE_NAMES.has(name)) return 'male'
  if (FEMALE_NAMES.has(name)) return 'female'
  return null
}
