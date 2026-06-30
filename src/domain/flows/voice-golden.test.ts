/**
 * Voice golden suite (Gate 7, T-V.4) — the POSITIVE-QUALITY ANCHOR of the voice wave.
 *
 * The deterministic detectors in `voice-guard.ts` are the FLOOR: they catch the
 * mechanical embarrassments (IVR menus, yes/no menus, split-gender, grovel, stacked
 * questions, bilingual leaks, dead-ends). THIS file is where "reads like a sharp human
 * PA" is actually pinned — a curated, representative He+En golden-transcript shape suite
 * for every changed Branch-4 reply path, plus the structural non-bypass invariant that
 * proves no Branch-3 / Branch-4 reply can reach `sendMessage` without traversing the gate.
 *
 * Pure: imports only the detectors from `./voice-guard.js` and reads source text via
 * `readFileSync` for the invariant (mirrors `voice-observe.test.ts` /
 * `special-arrangement-escalation.test.ts`). No DB, no network, no mocks of the engine.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  detectBotTells,
  hasNumberedMenu,
  hasYesNoMenu,
  hasSplitGender,
  hasStackedQuestions,
  hasGrovel,
  hasDeadEnd,
  hasBilingualLeak,
} from './voice-guard.js'
import { i18n } from '../i18n/t.js'

// ── Shape helpers ───────────────────────────────────────────────────────────

/** At most one question mark (ASCII or full-width) — a human PA asks ONE thing. */
function atMostOneQuestion(reply: string): boolean {
  return (reply.match(/[?？]/g) ?? []).length <= 1
}

/**
 * A sharp PA reply always leaves a door open. `hasNextStep` is satisfied by ANY forward
 * marker: an offered clock time (`\d{1,2}:\d{2}`), a day word (He or En), a question that
 * invites the next action, or an explicit hand-off / check-back phrase ("let the studio
 * know" / "להעביר" / "check" / "אבדוק"). Mirrors the FORWARD_STEP intuition but is a
 * local assertion helper for the golden GOOD replies — it is NOT the gate.
 */
function hasNextStep(reply: string): boolean {
  const r = reply.toLowerCase()
  const offeredTime = /\d{1,2}:\d{2}/.test(reply)
  const dayWord =
    /\b(today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.test(reply) ||
    /(היום|מחר|מחרתיים|ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/.test(reply)
  const invitingQuestion = /[?？]/.test(reply)
  const handoff =
    r.includes('let the studio know') ||
    r.includes('check') ||
    reply.includes('להעביר') ||
    reply.includes('אעביר') ||
    reply.includes('אבדוק') ||
    reply.includes('יחזרו') ||
    reply.includes('להודיע')
  return offeredTime || dayWord || invitingQuestion || handoff
}

/**
 * Assert a GOOD golden reply meets the full quality bar: no mechanical tell, at most one
 * question, and a forward step. Per-detector asserts are kept explicit at the call sites
 * for the categories each path is most at risk of, but every GOOD reply passes the
 * aggregate `detectBotTells === []`.
 */
function expectGoldenGood(reply: string): void {
  expect(detectBotTells(reply)).toEqual([])
  expect(atMostOneQuestion(reply)).toBe(true)
  expect(hasNextStep(reply)).toBe(true)
}

// ════════════════════════════════════════════════════════════════════════════
// PART 1 — Golden GOOD replies (He + En) for the changed Branch-4 reply paths.
// Each entry is a curated example of correct output: what a sharp human PA would say.
// ════════════════════════════════════════════════════════════════════════════

describe('golden GOOD replies — the quality bar (detectBotTells === [], one question, a next step)', () => {
  // ── Path 1: lead-protection substitute (class full → offer next real classes) ──
  describe('path 1 — lead-protection substitute (full → next real openings)', () => {
    const en =
      "Today's Yoga classes are all full — the next openings are Wednesday 10:00 and Thursday 18:00. Want me to grab one of those?"
    // Masculine singular, no split-gender, offers concrete next slots.
    const he =
      'כל שיעורי היוגה היום מלאים — הפתיחות הקרובות הן רביעי 10:00 וחמישי 18:00. לתפוס לך אחד מהם?'

    it('EN reads like a sharp PA', () => {
      expectGoldenGood(en)
      expect(hasDeadEnd(en)).toBe(false) // "full" but with offered times → forward
    })
    it('HE reads like a sharp PA (masculine singular, no split-gender)', () => {
      expectGoldenGood(he)
      expect(hasSplitGender(he)).toBe(false)
      expect(hasBilingualLeak(he)).toBe(false)
    })
  })

  // ── Path 2: ambiguous same-weekday ask (today vs next week) ──
  describe('path 2 — ambiguous same-weekday clarification (today vs next week)', () => {
    const en = "We've got Yoga today and again next Sunday — which works better for you?"
    const he = 'יש לנו יוגה היום ושוב ביום ראשון הבא — מה מתאים לך יותר?'

    it('EN asks exactly one clarifying question with both options grounded', () => {
      expectGoldenGood(en)
      expect(hasStackedQuestions(en)).toBe(false)
    })
    it('HE asks exactly one clarifying question', () => {
      expectGoldenGood(he)
      expect(hasStackedQuestions(he)).toBe(false)
      expect(hasBilingualLeak(he)).toBe(false)
    })
  })

  // ── Path 3: bundled side-question answer on confirm (booked + grounded answer) ──
  describe('path 3 — bundled side-question answer on confirm (booked + answers, grounded)', () => {
    const en =
      "You're booked for Yoga tomorrow at 18:00. Yes, mats are provided — just bring water. See you then!"
    const he = 'קבעתי לך יוגה מחר ב-18:00. כן, מזרנים יש במקום — רק תביא מים. נתראה!'

    it('EN confirms AND answers the side question, no second question', () => {
      expectGoldenGood(en)
      expect(atMostOneQuestion(en)).toBe(true)
    })
    it('HE confirms AND answers the side question (masculine singular)', () => {
      expectGoldenGood(he)
      expect(hasSplitGender(he)).toBe(false)
      expect(hasBilingualLeak(he)).toBe(false)
    })
  })

  // ── Path 4: special-arrangement / escalation hand-off ("passed to the studio") ──
  describe('path 4 — special-arrangement / escalation hand-off (warm, no grovel, next step)', () => {
    const en =
      "I've passed your request to the studio — they'll be in touch shortly. Anything else in the meantime?"
    const he = 'העברתי את הבקשה שלך לסטודיו — הם יחזרו אליך בקרוב. עוד משהו בינתיים?'

    it('EN hands off warmly with no grovel and a next step', () => {
      expectGoldenGood(en)
      expect(hasGrovel(en)).toBe(false)
      expect(hasDeadEnd(en)).toBe(false)
    })
    it('HE hands off warmly with no grovel and a next step', () => {
      expectGoldenGood(he)
      expect(hasGrovel(he)).toBe(false)
      expect(hasBilingualLeak(he)).toBe(false)
    })
  })

  // ── Path 5: occupancy-corrected reply (day genuinely full → honest + forward) ──
  describe('path 5 — occupancy-corrected reply (day full, honest + forward)', () => {
    const en =
      "Sunday's Yoga is fully booked, but Monday 09:00 still has room. Want me to hold that for you?"
    const he = 'יום ראשון ביוגה תפוס לגמרי, אבל ביום שני ב-09:00 עוד יש מקום. לשמור לך אותו?'

    it('EN is honest about full AND offers a real forward slot', () => {
      expectGoldenGood(en)
      expect(hasDeadEnd(en)).toBe(false) // genuine "full" but a next slot is offered
    })
    it('HE is honest about full AND offers a real forward slot', () => {
      expectGoldenGood(he)
      expect(hasDeadEnd(he)).toBe(false)
      expect(hasBilingualLeak(he)).toBe(false)
    })
  })

  // ── Path 6: suppressed-re-ask "still waiting" reply (T2c.1 / P5) — the real shipped string ──
  describe('path 6 — owner-question re-ask references the open thread (still waiting, not a fresh don\'t-know)', () => {
    const en = i18n.question_still_pending.en('the studio')
    const he = i18n.question_still_pending.he('הסטודיו')

    it('EN reads warm, references the open thread, and keeps moving (no grovel/dead-end)', () => {
      expectGoldenGood(en)
      expect(hasGrovel(en)).toBe(false)
      expect(hasDeadEnd(en)).toBe(false)
      expect(/still waiting/i.test(en)).toBe(true) // references the OPEN thread, not a fresh "I don't have that"
    })
    it('HE reads warm and references the open thread (no bilingual leak, no dead-end)', () => {
      expectGoldenGood(he)
      expect(hasBilingualLeak(he)).toBe(false)
      expect(hasDeadEnd(he)).toBe(false)
    })
  })
})

// ════════════════════════════════════════════════════════════════════════════
// PART 2 — Golden BAD replies. The gate MUST catch these; each asserts the tell.
// ════════════════════════════════════════════════════════════════════════════

describe('golden BAD replies — the gate flags real bot-tells', () => {
  it('numbered / IVR menu (EN + He)', () => {
    const en = 'Reply 1 for today, 2 for next week.'
    const he = 'ענה את המספר: 1 להיום, 2 לשבוע הבא.'
    expect(detectBotTells(en)).toContain('numbered_menu')
    expect(detectBotTells(he)).toContain('numbered_menu')
    expect(hasNumberedMenu(en)).toBe(true)
    expect(hasNumberedMenu(he)).toBe(true)
  })

  it('yes/no menu (EN + He)', () => {
    const en = 'Shall I book it? (yes/no)'
    const he = 'לקבוע? (כן/לא)'
    expect(detectBotTells(en)).toContain('yes_no_menu')
    expect(detectBotTells(he)).toContain('yes_no_menu')
    expect(hasYesNoMenu(en)).toBe(true)
    expect(hasYesNoMenu(he)).toBe(true)
  })

  it('split-gender conjugation (He)', () => {
    const he = 'תרצה/תרצי לקבוע מחר?'
    expect(detectBotTells(he)).toContain('split_gender')
  })

  it('stacked questions (two `?`)', () => {
    const en = 'What day works? What time works?'
    expect(detectBotTells(en)).toContain('stacked_questions')
  })

  it('grovel / robotic apology (EN + He)', () => {
    const en = 'I sincerely apologize for the inconvenience.'
    const he = 'אני מתנצל על אי הנוחות.'
    expect(detectBotTells(en)).toContain('grovel')
    expect(detectBotTells(he)).toContain('grovel')
  })

  it('dead-end (unavailability assertion, no forward step)', () => {
    const en = 'Sunday is fully booked.'
    expect(detectBotTells(en)).toContain('dead_end')
  })

  it('bilingual leak (Hebrew reply with an English sentence)', () => {
    const he = 'קבעתי לך מחר. Please confirm your attendance.'
    expect(detectBotTells(he)).toContain('bilingual_leak')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// PART 3 — Non-bypass invariant (the structural guarantee). Source-introspection,
// mirroring the readFileSync guards in voice-observe.test.ts and the escalation test.
// This file is the CANONICAL home of the invariant for BOTH branches.
// ════════════════════════════════════════════════════════════════════════════

describe('non-bypass invariant — Branch-4: every gateReply return is wrapped in observeVoiceTells', () => {
  it('every reply-exit of the unified gate routes through observeVoiceTells', () => {
    // The Branch-4 voice monitor now lives in the unified gate (grounding/output-gate.ts).
    // makeGenReply delegates every reply to gateReply, whose every exit wraps observeVoiceTells.
    const src = readFileSync(new URL('../grounding/output-gate.ts', import.meta.url), 'utf8')

    const fnStart = src.indexOf('export async function gateReply(')
    expect(fnStart).toBeGreaterThan(-1)
    const body = src.slice(fnStart) // gateReply is the last symbol in the file

    // Every value-returning `return {` in gateReply must hand its reply to observeVoiceTells.
    // After T-REGEN the occupancy early-return was folded into the single final exit (the
    // post-regen re-check needs one place to converge), leaving two object-returns: the
    // bookingConfirmed early-return and the final exit — both observeVoiceTells-wrapped.
    const returns = (body.match(/\breturn\s+\{/g) ?? []).length
    const observed = (body.match(/reply: observeVoiceTells\(/g) ?? []).length
    expect(returns).toBeGreaterThanOrEqual(2)
    expect(observed).toBe(returns)

    // The import is present so the wrapper is the real Gate-7 observer, not a shadow.
    // (hasActionFabrication may also be imported alongside it — it is the Gate-4 detector.)
    expect(src).toMatch(/import\s+\{[^}]*\bobserveVoiceTells\b[^}]*\}\s+from\s+'\.\.\/flows\/voice-guard\.js'/)
  })

  it('makeGenReply delegates to gateReply — it cannot produce a reply that bypasses the gate', () => {
    const src = readFileSync(new URL('./customer-booking.ts', import.meta.url), 'utf8')
    const fnStart = src.indexOf('export function makeGenReply(')
    expect(fnStart).toBeGreaterThan(-1)
    const body = src.slice(fnStart, src.indexOf('\nexport function buildBusinessFacts('))
    // Its ONLY reply-producing return is gateReply's result — no inline reply path remains.
    expect(body).toMatch(/await gateReply\(/)
    expect(body).toMatch(/return result\.reply/)
    expect(body).not.toMatch(/return observeVoiceTells\(/)
  })
})

describe('non-bypass invariant — Branch-3: every runManagerOrchestratorLoop reply-exit is wrapped in observeVoiceTells', () => {
  it('every reply-exit of the orchestrator loop routes through observeVoiceTells', () => {
    const src = readFileSync(
      new URL('../../adapters/llm/orchestrator.ts', import.meta.url),
      'utf8',
    )

    const fnStart = src.indexOf('export async function runManagerOrchestratorLoop(')
    expect(fnStart).toBeGreaterThan(-1)

    // Scope to the REPLY-PRODUCING region: from the main `while (iterations ...)` loop to the
    // end of the function. The orchestrator's setup region (before the loop) contains a nested
    // `coordRows.map((c) => { ... return `...` })` callback return that yields a STRING for a
    // list — not a reply-exit — so we deliberately start counting at the loop. Every reply-exit
    // of the loop (and the post-loop fallback) lives in this region, and each MUST be a
    // `return observeVoiceTells(`. The function is typed `Promise<string>`; its only `return`s
    // in this region are reply-exits (the `break` falls through to the final wrapped return).
    const loopStart = src.indexOf('while (iterations < MAX_ITERATIONS)', fnStart)
    expect(loopStart).toBeGreaterThan(-1)
    const after = src.slice(loopStart)
    const endRel = after.indexOf('\n}\n')
    expect(endRel).toBeGreaterThan(-1)
    const scoped = after.slice(0, endRel)

    const returns = (scoped.match(/\breturn\s+/g) ?? []).length
    const observed = (scoped.match(/return observeVoiceTells\(/g) ?? []).length
    // Three reply-exits: LLM-error fallback, real final reply, loop-exhaustion fallback.
    expect(observed).toBeGreaterThanOrEqual(3)
    expect(observed).toBe(returns)

    expect(src).toMatch(
      /import\s+\{\s*observeVoiceTells\s*\}\s+from\s+'\.\.\/\.\.\/domain\/flows\/voice-guard\.js'/,
    )
  })
})
