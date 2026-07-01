import { describe, it, expect, vi } from 'vitest'
import { gateReply, OCCUPANCY_FALLBACK, type GateContext } from './output-gate.js'
import { buildTurnLedger, type OccupancySpine } from './turn-ledger.js'

// ════════════════════════════════════════════════════════════════════════════
// P2 REPRO — "Pilates at 12, Sunday" (2026-06-30 live-test §K "Sunday full")
//
// Live transcript (business סטודיוגה): the PA truthfully listed Sunday 5-Jul Pilates at
// 9/11/14/18 + Yoga 10/12/16, the customer asked "פילאטיס ב 12" (Pilates at 12 — a Yoga-only
// time), and the PA replied "all Sunday Pilates is taken" while offering TODAY's (Tuesday) times.
//
// Two structural holes (REDTEAM §P2): (a) the occupancy spine mirrored the turn's service+time
// filter, so a service+specific-time miss read as whole-service-empty; (b) the occupancy
// backstop's escape heuristic was DAY-BLIND — any surfaced clock time (even a WRONG-day one)
// short-circuited it. This repro drives the gate at the exact transcript shape and asserts the
// Phase-0 telemetry `occupancyOutcome` flips from the hole (`skipped_reply_surfaced_time`) to
// `fired` once T2.1 (whole-day spine) + T2.2 (day-aware backstop) land.
// ════════════════════════════════════════════════════════════════════════════

const SUNDAY = '2026-07-05' // weekday 0 (Sun) — the day the customer was discussing
const PILATES = 'svc-pilates'

// Whole-day Sunday spine: Pilates genuinely open at 9/11/14/18 (openInService), so the day is
// NOT full. This is the T2.1 signal the day-blind gate never consulted.
const SUNDAY_PILATES_OPEN: OccupancySpine = async () => ({
  openOverall: true,
  openInService: true,
  text: 'Classes on Sunday: Pilates at 09:00, 11:00, 14:00, 18:00.',
})

// The live reply: asserts Sunday-Pilates fullness, then surfaces TODAY's (יום שלישי / Tuesday)
// times — a WRONG-day alternative for the Sunday claim. The "אין מקומות" clause trips
// assertsNoAvailability; the times sit in the יום-שלישי section, never the Sunday section.
const LIVE_REPLY =
  'אוי, אין מקומות פנויים לפילאטיס ביום ראשון. יש מקום היום, יום שלישי, ב-14:00 או 18:00.'

function ctx(overrides: { regen?: GateContext['regen'] } = {}): GateContext {
  return {
    ledger: buildTurnLedger({
      businessFacts: '',
      actionLedger: '',
      // The wrong-day times (today's 14:00/18:00) are REAL slots — backed so Gate-2 (fabricated
      // time) does not fire first and mask the occupancy path (mirrors the gate-telemetry repro).
      baseAllowedTimes: { boundaryTimes: ['14:00', '18:00'], bookingTimes: [] },
      occupancySpine: SUNDAY_PILATES_OPEN,
      businessId: 'biz-studioga',
    }),
    // Empty situation — the live grounding was narrowed/pivoted so it carried no Sunday open times.
    input: { language: 'he', situation: '', transcript: [] },
    opts: { focusDay: { dateStr: SUNDAY, serviceTypeId: PILATES } },
    regen: overrides.regen ?? (async () => 'יש פילאטיס ביום ראשון ב-09:00, 11:00, 14:00 או 18:00 — איזו שעה מתאימה לך?'),
  }
}

describe('P2 repro — Pilates-at-12 Sunday "all full" laundering', () => {
  it('occupancyAsserted: the live "אין מקומות" reply trips the no-availability detector', async () => {
    const res = await gateReply(LIVE_REPLY, ctx())
    expect(res.telemetry.occupancyAsserted).toBe(true)
    // Grounding carried no open times this turn (the narrow/pivoted situation) — the empty-vs-
    // skipped disambiguator the red-team needed.
    expect(res.telemetry.situationHadOpenTimes).toBe(false)
  })

  it('FIRED (post-fix): the wrong-day surfaced time no longer skips the day-aware backstop', async () => {
    // Hole shape this drove BEFORE the fix: the day-blind heuristic saw 14:00/18:00 and
    // short-circuited → occupancyOutcome === "skipped_reply_surfaced_time", the spine never read.
    // T2.2 makes the escape heuristic day-aware (the times are in the יום-שלישי section, not the
    // Sunday focus section), so the spine IS consulted; T2.1's whole-day read reports Pilates
    // open on Sunday → the gate fires and re-grounds on the real Sunday times.
    const res = await gateReply(LIVE_REPLY, ctx())
    expect(res.telemetry.occupancySpineConsulted).toBe(true)
    expect(res.telemetry.occupancyOutcome).toBe('fired')
    expect(res.interventions).toContain('occupancy')
  })

  it('the regenerated reply re-grounds on the real Sunday Pilates times (no "all full")', async () => {
    const regen = vi.fn(async () => 'יש פילאטיס ביום ראשון ב-09:00, 11:00, 14:00 או 18:00 — איזו שעה מתאימה לך?')
    const res = await gateReply(LIVE_REPLY, ctx({ regen }))
    expect(regen).toHaveBeenCalledOnce()
    expect(res.reply).toContain('09:00')
    expect(res.reply).not.toBe(OCCUPANCY_FALLBACK.he) // a clean correction is kept, not the terminal
  })

  it('GUARD (G1/G5): a correct SAME-day Sunday negative still spares the backstop (no needless regen)', async () => {
    // "no Pilates at 12, but on Sunday at 14:00" — 14:00 sits in the Sunday focus section, so the
    // day-aware heuristic correctly counts it as surfacing the focus day → spine NOT consulted,
    // reply unchanged. (Must not over-fire on a legitimate same-day offer.)
    const spine = vi.fn(SUNDAY_PILATES_OPEN)
    const sameDayReply = 'אין פילאטיס ב-12 ביום ראשון, אבל ביום ראשון יש פילאטיס ב-14:00.'
    const res = await gateReply(sameDayReply, {
      ...ctx(),
      ledger: buildTurnLedger({
        businessFacts: '', actionLedger: '',
        baseAllowedTimes: { boundaryTimes: ['12:00', '14:00'], bookingTimes: [] },
        occupancySpine: spine, businessId: 'biz-studioga',
      }),
    })
    expect(spine).not.toHaveBeenCalled()
    expect(res.reply).toBe(sameDayReply)
    expect(res.interventions).not.toContain('occupancy')
  })
})
