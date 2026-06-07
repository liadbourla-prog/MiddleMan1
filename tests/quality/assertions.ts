// Deterministic conversation-quality assertions — cheap, run on every generated
// reply. These catch the mechanical bot tells the voice bible forbids: language
// mixing, stacked questions, stray markdown, forbidden phrases, and verbatim echo
// of internal templates/tool results. They are intentionally string-only (no LLM)
// so they're fast and reproducible; the nuanced "does it read human" judgement is
// the grader's job (grader.ts).

import { BOT_TELLS } from '../../src/adapters/llm/voice.js'

export type Lang = 'he' | 'en'

const HEBREW = /[֐-׿]/
const HEBREW_G = /[֐-׿]/g
// Latin "words" of 3+ letters — used to detect English bleeding into a Hebrew
// reply. Single letters and short tokens (am/pm, business initials) are ignored.
const LATIN_WORD_G = /[A-Za-z]{3,}/g

export interface AssertionResult {
  pass: boolean
  failures: string[]
}

export interface DeterministicChecks {
  expectedLang: Lang
  // Raw internal strings the reply must NOT echo verbatim (tool results, i18n
  // templates, situation fragments). Compared case-insensitively, whitespace-normalized.
  forbiddenVerbatim?: string[]
  // Allow more than one question mark (rare — e.g. an explicit either/or). Default false.
  allowMultipleQuestions?: boolean
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

export function checkLanguage(reply: string, expected: Lang): string[] {
  const failures: string[] = []
  const hebrewCount = (reply.match(HEBREW_G) ?? []).length
  const latinWords = reply.match(LATIN_WORD_G) ?? []
  const latinWordCount = latinWords.length

  if (expected === 'en') {
    if (hebrewCount > 0) {
      failures.push(`expected English but found ${hebrewCount} Hebrew chars`)
    }
  } else {
    // Hebrew expected: must actually contain Hebrew, and English words must be
    // incidental (business name, a service term) — never a full English sentence.
    if (hebrewCount === 0) {
      failures.push('expected Hebrew but found none')
    } else if (latinWordCount > 4) {
      failures.push(`expected Hebrew but found ${latinWordCount} Latin words (English bleed)`)
    }
  }
  return failures
}

export function checkSingleQuestion(reply: string, allowMultiple = false): string[] {
  if (allowMultiple) return []
  const count = (reply.match(/\?/g) ?? []).length
  return count > 1 ? [`stacked questions: ${count} '?' (expected at most 1)`] : []
}

export function checkFormatting(reply: string): string[] {
  const failures: string[] = []
  if (/^#{1,6}\s/m.test(reply)) failures.push('markdown header (#) present')
  if (/\[[^\]]+\]\([^)]+\)/.test(reply)) failures.push('markdown link present')
  if (reply.includes('```')) failures.push('code fence (```) present')
  if (/<[a-z][^>]*>/i.test(reply)) failures.push('HTML tag present')
  if (/(^|[^*])\*\*([^*]|$)/.test(reply)) failures.push('double-asterisk markdown bold (**) present — WhatsApp uses single *')
  // URLs, if present, must sit on their own line (never mid-sentence).
  const urlLines = reply.split('\n').filter((l) => /https?:\/\//.test(l))
  for (const line of urlLines) {
    const stripped = line.replace(/https?:\/\/\S+/g, '').replace(/[\s•\-*]/g, '')
    if (stripped.length > 0) failures.push(`URL not on its own line: "${line.trim()}"`)
  }
  return failures
}

export function checkBotTells(reply: string): string[] {
  const lower = reply.toLowerCase()
  const failures: string[] = []
  for (const lang of ['he', 'en'] as const) {
    for (const tell of BOT_TELLS[lang]) {
      if (lower.includes(tell.toLowerCase())) failures.push(`bot-tell phrase: "${tell}"`)
    }
  }
  return failures
}

export function checkNoVerbatimEcho(reply: string, forbidden: string[] = []): string[] {
  const norm = normalize(reply)
  const failures: string[] = []
  for (const raw of forbidden) {
    const target = normalize(raw)
    if (target.length >= 8 && norm.includes(target)) {
      failures.push(`verbatim template echo: "${raw}"`)
    }
  }
  return failures
}

export function runDeterministicChecks(reply: string, checks: DeterministicChecks): AssertionResult {
  const failures = [
    ...checkLanguage(reply, checks.expectedLang),
    ...checkSingleQuestion(reply, checks.allowMultipleQuestions),
    ...checkFormatting(reply),
    ...checkBotTells(reply),
    ...checkNoVerbatimEcho(reply, checks.forbiddenVerbatim),
  ]
  if (reply.trim().length === 0) failures.push('empty reply')
  return { pass: failures.length === 0, failures }
}
