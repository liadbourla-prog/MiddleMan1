import { describe, it, expect, vi } from 'vitest'
import {
  gateReply,
  BOOKING_NOT_CONFIRMED_FALLBACK,
  FABRICATED_TIME_FALLBACK,
  OCCUPANCY_FALLBACK,
  SAFE_AUDIT_FALLBACK,
  type GateContext,
} from './output-gate.js'
import { buildTurnLedger, type OccupancySpine } from './turn-ledger.js'
import { hasActionFabrication, detectBotTells, hasDeadEnd } from '../flows/voice-guard.js'
import { assertsBookingConfirmed } from '../flows/reply-guard.js'

// T0.2 golden-PARITY suite. gateReply must reproduce Branch-4 makeGenReply's Gates 1/2/3
// verdicts EXACTLY — booking/time/occupancy ENFORCED, action monitor-only (no enforce in
// Phase 0 = no behavior change, RED-TEAM P2). The suite exercises all FOUR makeGenReply
// exit paths: the bookingConfirmed early-return, the three gate exits, the occupancy-spine
// early-return, and the isSafeFallback final return.

const NEVER_SPINE: OccupancySpine = async () => ({ open: false, text: null })

function ctx(opts: {
  input?: Partial<GateContext['input']>
  gateOpts?: GateContext['opts']
  regen?: GateContext['regen']
  spine?: OccupancySpine
  base?: { boundaryTimes: string[]; bookingTimes: string[] }
}): GateContext {
  return {
    ledger: buildTurnLedger({
      businessFacts: '',
      actionLedger: '',
      baseAllowedTimes: opts.base ?? { boundaryTimes: [], bookingTimes: [] },
      occupancySpine: opts.spine ?? NEVER_SPINE,
      businessId: 'biz-test',
    }),
    input: { language: 'he', situation: '', transcript: [], ...opts.input },
    opts: opts.gateOpts ?? {},
    regen: opts.regen ?? (async () => { throw new Error('regen should not be called') }),
  }
}

describe('gateReply — exit path 1: bookingConfirmed early-return', () => {
  it('returns the draft unchanged, never gating, when bookingConfirmed', async () => {
    // A reply that WOULD trip every gate (claims booking + fake time + fullness) is trusted.
    const draft = 'קבעתי לך תור ב-17:00, היום מלא לגמרי'
    const res = await gateReply(draft, ctx({ gateOpts: { bookingConfirmed: true } }))
    expect(res.reply).toBe(draft)
    expect(res.interventions).toEqual([])
  })
})

describe('gateReply — Gate 1: phantom booking claim', () => {
  it('regenerates; a clean correction is kept', async () => {
    const regen = vi.fn(async () => 'איזה יום מתאים לך?')
    const res = await gateReply('קבעתי לך תור', ctx({ regen }))
    expect(regen).toHaveBeenCalledOnce()
    expect(res.reply).toBe('איזה יום מתאים לך?')
    expect(res.interventions).toContain('booking')
  })

  it('falls back when the correction still asserts a booking', async () => {
    const regen = vi.fn(async () => 'מעולה, קבעתי לך!')
    const res = await gateReply('קבעתי לך תור', ctx({ regen }))
    expect(res.reply).toBe(BOOKING_NOT_CONFIRMED_FALLBACK.he)
  })
})

describe('gateReply — Gate 2: fabricated time', () => {
  it('regenerates an unbacked time; a clean correction is kept', async () => {
    const regen = vi.fn(async () => 'בוא נמצא יום שמתאים')
    const res = await gateReply('יש מקום ב-17:00', ctx({ regen }))
    expect(regen).toHaveBeenCalledOnce()
    expect(res.reply).toBe('בוא נמצא יום שמתאים')
    expect(res.interventions).toContain('time')
  })

  it('falls back when the correction still states an unbacked time', async () => {
    const regen = vi.fn(async () => 'אז ב-19:00?')
    const res = await gateReply('יש מקום ב-17:00', ctx({ regen }))
    expect(res.reply).toBe(FABRICATED_TIME_FALLBACK.he)
  })

  it('D1 per-call merge: a time present in THIS call situation is backed, not flagged', async () => {
    // 17:00 is in the situation the core authored → allowed → reply may state it → no regen.
    const res = await gateReply('יש מקום ב-17:00', ctx({ input: { situation: 'שעות פנויות: 17:00' } }))
    expect(res.reply).toBe('יש מקום ב-17:00')
    expect(res.interventions).toEqual([])
  })

  it('D1 per-call merge: base allowlist (boundary/booking) backs a stated time', async () => {
    const res = await gateReply('אנחנו פתוחים עד 20:00', ctx({ base: { boundaryTimes: ['20:00'], bookingTimes: [] } }))
    expect(res.reply).toBe('אנחנו פתוחים עד 20:00')
  })
})

describe('gateReply — Gate 3: occupancy', () => {
  it('exit path 2: spine early-return regenerates a laundered "full" claim; fallback on persistence', async () => {
    const spine: OccupancySpine = async () => ({ open: true, text: '10:00, 12:00' })
    const regen = vi.fn(async () => 'עדיין מלא לגמרי אצלנו') // still asserts fullness, no time
    const res = await gateReply(
      'היום מלא לגמרי',
      ctx({ gateOpts: { focusDay: { dateStr: '2026-07-01' } }, spine, regen }),
    )
    expect(regen).toHaveBeenCalledOnce()
    expect(res.reply).toBe(OCCUPANCY_FALLBACK.he)
    expect(res.interventions).toContain('occupancy')
  })

  it('exit path 2: spine early-return keeps a clean correction', async () => {
    const spine: OccupancySpine = async () => ({ open: true, text: '10:00, 12:00' })
    const regen = vi.fn(async () => 'יש מקומות פנויים, איזו שעה מתאימה?')
    const res = await gateReply(
      'אין מקום',
      ctx({ gateOpts: { focusDay: { dateStr: '2026-07-01' } }, spine, regen }),
    )
    expect(res.reply).toBe('יש מקומות פנויים, איזו שעה מתאימה?')
  })

  it('spine early-return SKIPPED when the reply already surfaces a concrete time', async () => {
    // "no class at 15:00, but there's 16:00" — a time-scoped negative with same-day options.
    // Both times are backed by the situation (so Gate 2 passes), the reply surfaces a time
    // (so the spine path (a) is skipped), and it shares the open 16:00 (so signal (b) spares
    // it). Net: no regen, spine never read, reply unchanged.
    const spine = vi.fn(NEVER_SPINE)
    const res = await gateReply(
      'אין שיעור ב-15:00, אבל יש ב-16:00',
      ctx({ gateOpts: { focusDay: { dateStr: '2026-07-01' } }, spine, input: { situation: 'פנוי: 15:00, 16:00' } }),
    )
    expect(spine).not.toHaveBeenCalled()
    expect(res.reply).toBe('אין שיעור ב-15:00, אבל יש ב-16:00')
  })

  it('situation signal (b): regenerates when the situation has an open time the reply hides', async () => {
    const regen = vi.fn(async () => 'יש מקום ב-14:00, רוצה?')
    const res = await gateReply(
      'יום ראשון מלא לגמרי',
      ctx({ input: { situation: 'ראשון: 14:00, 18:00 פנוי' }, regen }),
    )
    expect(regen).toHaveBeenCalledOnce()
    expect(res.interventions).toContain('occupancy')
  })
})

describe('gateReply — exit path 3/4: clean reply passes through', () => {
  it('a reply with no claim/time/fullness is returned unchanged and never regenerates', async () => {
    const res = await gateReply('איזה יום מתאים לך?', ctx({}))
    expect(res.reply).toBe('איזה יום מתאים לך?')
    expect(res.interventions).toEqual([])
  })
})

// ── Gate 4 (T3.1a) — self-authored action-fabrication (check/ask/get-back-to-you) ──────
// hasActionFabrication phrasing reaching gateReply is unbacked BY CONSTRUCTION: the honest
// escalation replies are code templates that bypass makeGenReply/gateReply entirely. So the
// gate ENFORCES it (regen once → promise-free fallback on persistence). No backing check.
describe('gateReply — Gate 4: self-authored action fabrication (ENFORCED)', () => {
  it('persisting fabrication → promise-free SAFE_AUDIT_FALLBACK (Hebrew)', async () => {
    // regen ALSO returns an action-fabrication phrasing → terminal fallback.
    const regen = vi.fn(async () => 'אבדוק מול הסטודיו ואחזור אליך')
    const res = await gateReply('אבדוק מול הסטודיו ואחזור אליך', ctx({ regen }))
    expect(regen).toHaveBeenCalledOnce()
    expect(res.reply).toBe(SAFE_AUDIT_FALLBACK.he)
    expect(res.interventions).toContain('action')
  })

  it('persisting fabrication → promise-free SAFE_AUDIT_FALLBACK (English)', async () => {
    const regen = vi.fn(async () => "I'll check with the studio and get back to you.")
    const res = await gateReply(
      "I'll check with the studio and get back to you.",
      ctx({ input: { language: 'en' }, regen }),
    )
    expect(regen).toHaveBeenCalledOnce()
    expect(res.reply).toBe(SAFE_AUDIT_FALLBACK.en)
    expect(res.interventions).toContain('action')
  })

  it('regen fixes it → the clean correction is kept (not the fallback); action still recorded', async () => {
    const regen = vi.fn(async () => 'אין לי את המידע הזה כרגע — הכי טוב לפנות ישירות לעסק. אפשר לעזור בקביעה?')
    const res = await gateReply('אבדוק ואחזור אליך', ctx({ regen }))
    expect(regen).toHaveBeenCalledOnce()
    expect(res.reply).toBe('אין לי את המידע הזה כרגע — הכי טוב לפנות ישירות לעסק. אפשר לעזור בקביעה?')
    expect(res.reply).not.toBe(SAFE_AUDIT_FALLBACK.he)
    expect(res.interventions).toContain('action')
  })

  it('clean reply (no check/ask phrasing) passes untouched — no action intervention, regen never called', async () => {
    const regen = vi.fn(async () => { throw new Error('regen should not be called') })
    const res = await gateReply('איזה יום הכי מתאים לך לשיעור יוגה?', ctx({ regen }))
    expect(regen).not.toHaveBeenCalled()
    expect(res.reply).toBe('איזה יום הכי מתאים לך לשיעור יוגה?')
    expect(res.interventions).not.toContain('action')
  })

  it('bookingConfirmed early-return still SKIPS the action gate (exit path 1 unchanged)', async () => {
    // A draft that WOULD trip Gate 4, but bookingConfirmed trusts the wording.
    const draft = 'קבעתי לך תור, ואחזור אליך עם אישור'
    const regen = vi.fn(async () => { throw new Error('regen should not be called') })
    const res = await gateReply(draft, ctx({ gateOpts: { bookingConfirmed: true }, regen }))
    expect(regen).not.toHaveBeenCalled()
    expect(res.reply).toBe(draft)
    expect(res.interventions).toEqual([])
  })
})

// ── T3.1b — action-claim gate (cancel/waitlist/message) over a real backed-action ledger ──
// Flag-gated (enforceActionClaims): OFF for Branch 3 / Phase 0 (no behavior change); ON for
// Branch 4 always. A detectActionClaims class (cancelled/waitlist_added/message_sent/…) that is
// NOT in ledger.backedActions is a fabrication → regen once → SAFE_AUDIT_FALLBACK on persistence.
// booking_made is excluded here (owned by Gate 1 / opts.bookingConfirmed).
describe('gateReply — action-claim gate (T3.1b, flag-gated)', () => {
  function actionCtx(opts: {
    backed?: string[]
    regen?: GateContext['regen']
    input?: Partial<GateContext['input']>
    enforce?: boolean
    bookingConfirmed?: boolean
  }): GateContext {
    return {
      ledger: buildTurnLedger({
        businessFacts: '',
        actionLedger: '',
        baseAllowedTimes: { boundaryTimes: [], bookingTimes: [] },
        occupancySpine: NEVER_SPINE,
        backedActions: (opts.backed ?? []) as never[],
        businessId: 'biz-test',
      }),
      input: { language: 'he', situation: '', transcript: [], ...opts.input },
      opts: {
        ...(opts.enforce ? { enforceActionClaims: true } : {}),
        ...(opts.bookingConfirmed ? { bookingConfirmed: true } : {}),
      },
      regen: opts.regen ?? (async () => { throw new Error('regen should not be called') }),
    }
  }

  it('(1) cancel FABRICATION caught (He) → regen persists → SAFE_AUDIT_FALLBACK', async () => {
    const regen = vi.fn(async () => 'ביטלתי לך את התור') // still a cancel claim
    const res = await gateReply('ביטלתי לך את התור', actionCtx({ enforce: true, regen }))
    expect(regen).toHaveBeenCalledOnce()
    expect(res.reply).toBe(SAFE_AUDIT_FALLBACK.he)
    expect(res.interventions).toContain('action')
  })

  it('(1) cancel FABRICATION caught (En) → SAFE_AUDIT_FALLBACK', async () => {
    const regen = vi.fn(async () => "I've cancelled your class")
    const res = await gateReply(
      "I've cancelled your class",
      actionCtx({ enforce: true, regen, input: { language: 'en' } }),
    )
    expect(res.reply).toBe(SAFE_AUDIT_FALLBACK.en)
    expect(res.interventions).toContain('action')
  })

  it('(2) REAL cancel passes: backedActions has cancelled → unchanged, no regen, no action', async () => {
    const regen = vi.fn(async () => { throw new Error('regen should not be called') })
    const res = await gateReply('ביטלתי לך את התור', actionCtx({ enforce: true, backed: ['cancelled'], regen }))
    expect(regen).not.toHaveBeenCalled()
    expect(res.reply).toBe('ביטלתי לך את התור')
    expect(res.interventions).not.toContain('action')
  })

  it('(3) waitlist FABRICATION caught (He + En) → SAFE_AUDIT_FALLBACK', async () => {
    const regenHe = vi.fn(async () => 'הוספתי אותך לרשימת ההמתנה')
    const resHe = await gateReply('הוספתי אותך לרשימת ההמתנה', actionCtx({ enforce: true, regen: regenHe }))
    expect(resHe.reply).toBe(SAFE_AUDIT_FALLBACK.he)
    expect(resHe.interventions).toContain('action')

    const regenEn = vi.fn(async () => "I've added you to the waitlist")
    const resEn = await gateReply(
      "I've added you to the waitlist",
      actionCtx({ enforce: true, regen: regenEn, input: { language: 'en' } }),
    )
    expect(resEn.reply).toBe(SAFE_AUDIT_FALLBACK.en)
  })

  it('(4) REAL waitlist add passes: backedActions has waitlist_added → unchanged', async () => {
    const regen = vi.fn(async () => { throw new Error('regen should not be called') })
    const res = await gateReply('הוספתי אותך לרשימת ההמתנה', actionCtx({ enforce: true, backed: ['waitlist_added'], regen }))
    expect(regen).not.toHaveBeenCalled()
    expect(res.reply).toBe('הוספתי אותך לרשימת ההמתנה')
  })

  it('(5) regen FIXES it → corrected reply kept (not fallback); action still recorded', async () => {
    const regen = vi.fn(async () => 'אשמח לעזור — לאיזה תור התכוונת?')
    const res = await gateReply('ביטלתי לך את התור', actionCtx({ enforce: true, regen }))
    expect(regen).toHaveBeenCalledOnce()
    expect(res.reply).toBe('אשמח לעזור — לאיזה תור התכוונת?')
    expect(res.reply).not.toBe(SAFE_AUDIT_FALLBACK.he)
    expect(res.interventions).toContain('action')
  })

  it('(6) flag OFF = no behavior change: unbacked cancel claim unchanged, regen NOT called', async () => {
    const regen = vi.fn(async () => { throw new Error('regen should not be called') })
    // enforce omitted → Branch-3 / Phase-0 default; the action-claim gate never runs.
    const res = await gateReply('ביטלתי לך את התור', actionCtx({ regen }))
    expect(regen).not.toHaveBeenCalled()
    expect(res.reply).toBe('ביטלתי לך את התור')
    expect(res.interventions).not.toContain('action')
  })

  it('(7) booking_made excluded: a booked claim is handled by Gate 1, NOT the action gate', async () => {
    // enforceActionClaims:true, bookingConfirmed:false, empty backed. The booked claim trips
    // Gate 1 (booking) and routes to BOOKING_NOT_CONFIRMED_FALLBACK; the action gate must NOT
    // also fire on booking_made (no double-handling).
    const regen = vi.fn(async () => 'קבעתי לך תור') // persists the booking claim
    const res = await gateReply('קבעתי לך תור', actionCtx({ enforce: true, regen }))
    expect(res.reply).toBe(BOOKING_NOT_CONFIRMED_FALLBACK.he)
    expect(res.interventions).toContain('booking')
    // Gate 1 regen produced a booking claim, which is NOT a detectActionClaims action class
    // we enforce (booking_made is filtered out) — so 'action' must not appear from booking_made.
    expect(res.interventions.filter((i) => i === 'action')).toEqual([])
  })
})

// ── VOICE GATE — the gate-owned SAFE_AUDIT_FALLBACK must be promise-free + warm. ──────
describe('SAFE_AUDIT_FALLBACK — promise-free, warm, one question, forward step', () => {
  for (const lang of ['he', 'en'] as const) {
    it(`(${lang}) does NOT itself match hasActionFabrication (the re-trip trap)`, () => {
      expect(hasActionFabrication(SAFE_AUDIT_FALLBACK[lang])).toBe(false)
    })
    it(`(${lang}) does NOT assert a booking is confirmed`, () => {
      expect(assertsBookingConfirmed(SAFE_AUDIT_FALLBACK[lang], lang)).toBe(false)
    })
    it(`(${lang}) carries exactly one question (?)`, () => {
      const count = (SAFE_AUDIT_FALLBACK[lang].match(/[?？]/g) ?? []).length
      expect(count).toBe(1)
    })
    it(`(${lang}) passes the mechanical voice bar (no bot-tells)`, () => {
      expect(detectBotTells(SAFE_AUDIT_FALLBACK[lang])).toEqual([])
    })
    it(`(${lang}) is NOT a dead_end (it carries a forward step)`, () => {
      expect(hasDeadEnd(SAFE_AUDIT_FALLBACK[lang])).toBe(false)
    })
  }
})
