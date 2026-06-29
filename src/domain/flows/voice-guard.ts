/**
 * Voice guard (Gate 7) — PURE, deterministic detectors for the MECHANICAL
 * bot-tells a human employee never produces. These detect STRUCTURAL voice
 * failures (IVR menus, yes/no menus, bilingual leaks, split-gender hedging,
 * stacked questions, robotic grovel, conversational dead-ends) that the
 * CHAT_LEVEL_LAWBOOK Voice Bible forbids.
 *
 * These will be wired in MONITOR-ONLY mode (log, don't mutate) in T-V.2/T-V.3,
 * so detectors favor HIGH RECALL — but each carries the precision guards noted
 * below to spare the known false-positive traps (noun alternation vs split
 * gender, polite "sorry" vs grovel, embedded brand names vs bilingual leak).
 *
 * Pure + synchronous: every detector is `(text: string) => boolean`. The
 * phrase-based detectors (yes/no menu, grovel, split-gender) reuse the
 * `BOT_TELLS` phrase lists from the LLM voice core so the prompt guidance and
 * the runtime detectors stay in sync. The structural detectors are regex-based.
 */

import { BOT_TELLS } from '../../adapters/llm/voice.js'
import { assertsNoAvailability } from './slot-fabrication-guard.js'

const lower = (text: string): string => text.toLowerCase()

/** True if `text` contains any Hebrew letter. */
function hasHebrew(text: string): boolean {
  return /[֐-׿]/.test(text)
}

/** True if any phrase from `phrases` appears (case-insensitively) in `text`. */
function containsAnyPhrase(text: string, phrases: string[]): boolean {
  const hay = lower(text)
  return phrases.some((p) => hay.includes(lower(p)))
}

// ── 1. Numbered / IVR menu ─────────────────────────────────────────────────
// "reply 1/2/3", "reply with the number", "press 1", numbered list lines used
// as a choice menu, Hebrew "ענו/תגיד/השב את המספר", "מספר 1". A bare clock time
// ("10:00") or price never matches: the digit-menu patterns require menu-shaped
// context (reply/press/number, or a list-item digit followed by . or )).
const NUMBERED_MENU_RE: RegExp[] = [
  /\breply\s+(?:with\s+)?(?:the\s+)?(?:number|[1-9])\b/i,
  /\bpress\s+[1-9]\b/i,
  /(?:^|\n)\s*[1-9][.)]\s/, // numbered list lines: "1. " / "2) "
  /(?:ענה|ענו|תגיד|השב|בחר|הקש)\s+(?:את\s+)?המספר/,
  /מספר\s+[1-9](?![\d:])/,
]
export function hasNumberedMenu(text: string): boolean {
  if (!text) return false
  return NUMBERED_MENU_RE.some((re) => re.test(text))
}

// ── 2. Yes/No menu ─────────────────────────────────────────────────────────
// "(כן/לא)", "(כן / לא)", "(yes/no)", "(yes / no)", "reply YES", "השב כן".
// Reuses the BOT_TELLS yes/no entries plus structural regexes.
const YES_NO_PHRASES: string[] = [
  ...BOT_TELLS.en.filter((p) => /yes|no/.test(p)),
  ...BOT_TELLS.he.filter((p) => p.includes('כן') || p.includes('לא')),
]
const YES_NO_MENU_RE: RegExp[] = [
  /\(\s*(?:yes|כן)\s*\/\s*(?:no|לא)\s*\)/i,
  /\breply\s+yes\b/i,
  /השב\s+כן(?![֐-׿])/,
]
export function hasYesNoMenu(text: string): boolean {
  if (!text) return false
  if (YES_NO_MENU_RE.some((re) => re.test(text))) return true
  return containsAnyPhrase(text, YES_NO_PHRASES)
}

// ── 3. Bilingual leak ──────────────────────────────────────────────────────
// Hebrew letters AND a RUN of Latin letters (≥4) in the same message, EXCLUDING
// short embedded brand/service/loanword tokens. Precision: strip allowlisted
// words before testing for a residual ≥4-letter Latin run.
const BILINGUAL_ALLOWLIST: string[] = [
  'pilates', 'yoga', 'whatsapp', 'google', 'zoom', 'studio', 'vip', 'spa',
  'crossfit', 'instagram', 'facebook', 'tiktok', 'email', 'sms',
]
export function hasBilingualLeak(text: string): boolean {
  if (!text || !hasHebrew(text)) return false
  // Remove allowlisted loanwords/brands so they don't trip the Latin-run check.
  let residual = text
  for (const word of BILINGUAL_ALLOWLIST) {
    residual = residual.replace(new RegExp(word, 'gi'), ' ')
  }
  return /[A-Za-z]{4,}/.test(residual)
}

// ── 4. Split-gender conjugation ────────────────────────────────────────────
// Hebrew split-gender verb forms: "תכתוב/י", "תרצה/תרצי", "מעוניין/ת", "תגיד/י".
// CRITICAL precision: target the GENDER-SUFFIX slash, NOT noun alternation. A
// Hebrew word followed by "/" then a SHORT (≤3-letter) Hebrew suffix. Capping the
// post-slash run at ≤3 spares noun alternation ("יוגה/פילאטיס", "בוקר/צהריים").
const SPLIT_GENDER_RE = /[֐-׿]{2,}\/[֐-׿]{1,3}(?![֐-׿])/
const SPLIT_GENDER_PHRASES: string[] = BOT_TELLS.he.filter((p) => p.includes('/'))
export function hasSplitGender(text: string): boolean {
  if (!text) return false
  if (containsAnyPhrase(text, SPLIT_GENDER_PHRASES)) return true
  return SPLIT_GENDER_RE.test(text)
}

// ── 5. Stacked questions ───────────────────────────────────────────────────
// More than one question mark (ASCII "?" or full-width "？"). High-recall.
export function hasStackedQuestions(text: string): boolean {
  if (!text) return false
  const count = (text.match(/[?？]/g) ?? []).length
  return count > 1
}

// ── 6. Grovel / robotic apology ────────────────────────────────────────────
// "i apologize", "i'm sorry for the inconvenience", "i sincerely apologize",
// "we apologize", Hebrew "אני מתנצל", "סליחה על אי הנוחות", "מתנצלים".
// Precision: a bare polite "סליחה," / "sorry," opening a clarifying question is
// NOT grovel — only apology-as-statement / "for the inconvenience"-style fires.
const GROVEL_PHRASES: string[] = [
  ...BOT_TELLS.en.filter((p) => p.includes('apologize')),
  ...BOT_TELLS.he.filter((p) => p.includes('מתנצל')),
]
const GROVEL_RE: RegExp[] = [
  /\bi\s+(?:sincerely\s+|truly\s+|deeply\s+)?apologize/i,
  /\bwe\s+apologize/i,
  /\b(?:i'?m|i\s+am|we'?re|we\s+are)\s+sorry\s+for\s+the\s+inconvenience/i,
  /for\s+the\s+inconvenience/i,
  /אני\s+מתנצל/, /אנחנו\s+מתנצל/, /מתנצלים/,
  /סליחה\s+על\s+אי\s+הנוחות/, /מצטער\s+על\s+אי\s+הנוחות/,
]
export function hasGrovel(text: string): boolean {
  if (!text) return false
  if (GROVEL_RE.some((re) => re.test(text))) return true
  return containsAnyPhrase(text, GROVEL_PHRASES)
}

// ── 7. Dead end ────────────────────────────────────────────────────────────
// A genuine UNAVAILABILITY assertion with NO forward step. Conservative: fires
// only when the text asserts unavailability AND contains NEITHER a question NOR
// any forward-step marker (an offered time, "another day", "next", "instead",
// "check", a handoff). Monitor-only — but unavailability is the gate, NOT bare
// negation. The unavailability signal is `assertsNoAvailability` (shared with the
// slot-fabrication guard), supplemented only by the two genuine-unavailability
// phrasings it happens to miss ("not available" / "unavailable"). Bare negations
// like "No problem." / "אין בעיה." are deliberately NOT triggers — they are
// negation, not unavailability, and would flood the monitor log with benign replies.
const LOCAL_NO_AVAIL_RE: RegExp[] = [
  /\bnot\s+available\b/i, /\bunavailable\b/i,
]
const FORWARD_STEP_RE: RegExp[] = [
  /\d{1,2}:\d{2}/, // an offered clock time
  /another\s+day/i, /\bnext\b/i, /\binstead\b/i, /\bcheck\b/i,
  /let\s+the\s+studio\s+know/i, /reach\s+out/i,
  /יום\s+אחר/, /להעביר/, /אעביר/, /יחזרו\s+אליך/, /שיחזרו/, /במקום/, /אחר/,
]
export function hasDeadEnd(text: string): boolean {
  if (!text) return false
  const negative = assertsNoAvailability(text) || LOCAL_NO_AVAIL_RE.some((re) => re.test(text))
  if (!negative) return false
  if (/[?？]/.test(text)) return false // has a question → forward
  if (FORWARD_STEP_RE.some((re) => re.test(text))) return false // has a forward marker
  return true
}

// ── Aggregator ─────────────────────────────────────────────────────────────
export type BotTell =
  | 'numbered_menu'
  | 'yes_no_menu'
  | 'bilingual_leak'
  | 'split_gender'
  | 'stacked_questions'
  | 'grovel'
  | 'dead_end'

const DETECTORS: ReadonlyArray<readonly [BotTell, (text: string) => boolean]> = [
  ['numbered_menu', hasNumberedMenu],
  ['yes_no_menu', hasYesNoMenu],
  ['bilingual_leak', hasBilingualLeak],
  ['split_gender', hasSplitGender],
  ['stacked_questions', hasStackedQuestions],
  ['grovel', hasGrovel],
  ['dead_end', hasDeadEnd],
]

/** Every bot-tell that fires for `text`. Empty array → clean. */
export function detectBotTells(text: string): BotTell[] {
  return DETECTORS.filter(([, fn]) => fn(text)).map(([tell]) => tell)
}

// ── Gate 7 observer (MONITOR-ONLY) ─────────────────────────────────────────
// Regen is OFF by default. The flag is read into a const that is never true in
// this wave; the regen body is intentionally absent (see TODO below). When the
// flag is ever enabled, the regenerate-once path lands behind it.
const VOICE_REGEN_ENABLED = process.env.VOICE_REGEN_ENABLED === '1'

/**
 * Observe Branch-4 reply for mechanical bot-tells and LOG when present.
 * MONITOR-ONLY: returns `reply` byte-for-byte, never mutates or regenerates.
 *
 * Intentional safe-fallback strings (FABRICATED_TIME_FALLBACK / OCCUPANCY_FALLBACK)
 * are deliberately terse — exempt them from the dead-end tell so the monitor isn't
 * flooded. Other tells, if any, are still logged.
 */
export function observeVoiceTells(
  reply: string,
  ctx: { businessId?: string | undefined; language: 'he' | 'en' },
  opts?: { isSafeFallback?: boolean },
): string {
  let tells = detectBotTells(reply)
  if (opts?.isSafeFallback) tells = tells.filter((t) => t !== 'dead_end')
  if (tells.length > 0) {
    console.warn('[voice-gate] bot-tell detected (monitor-only)', {
      businessId: ctx.businessId, gate: 'voice', tells, draftExcerpt: reply.slice(0, 200),
    })
  }
  // MONITOR-ONLY: never mutate the reply here. TODO(voice-regen): when VOICE_REGEN_ENABLED
  // (default OFF) is set AND the Gemini-vs-Claude model decision is made, regenerate once
  // with a corrective instruction citing the violated Voice Bible rule and ship the BETTER
  // of the two — "better" = passes fabrication AND has fewer mechanical tells, never
  // "warmer but unbacked". Counts against the unified per-turn regeneration cap (WS5).
  if (VOICE_REGEN_ENABLED) {
    // No-op in this wave: the regenerate path is intentionally not implemented yet.
  }
  return reply
}
