import { describe, it, expect, vi } from 'vitest'
import {
  gateReply,
  BOOKING_NOT_CONFIRMED_FALLBACK,
  FABRICATED_TIME_FALLBACK,
  OCCUPANCY_FALLBACK,
  type GateContext,
} from './output-gate.js'
import { buildTurnLedger, type OccupancySpine } from './turn-ledger.js'

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
