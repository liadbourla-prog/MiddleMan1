/**
 * Phase 0 (X1) — gate-decision telemetry tests.
 *
 * Proves: (A) `logGateDecision` emits EXACTLY ONE structured line with the required shape, the
 * grounding-empty vs gate-skipped disambiguator, and the env guard; (B) `gateReply` populates
 * `telemetry.occupancyOutcome` so the P2 ambiguity ("grounding empty" vs "gate skipped") is
 * encoded; (C) each of the THREE doors (Branch-4 makeGenReply, Branch-3 gateAndAuditBranch3Reply,
 * proactive gateProactiveBody) emits exactly one line per turn.
 *
 * generateCustomerReply is the ONLY mock (the Branch-4 draft source); every other path is real
 * wiring with network-free inputs (clean drafts → no regen, no LLM round-trip).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const generateCustomerReply = vi.fn<(input: unknown) => Promise<string>>()
vi.mock('../../adapters/llm/client.js', async (importActual) => ({
  ...(await importActual<typeof import('../../adapters/llm/client.js')>()),
  generateCustomerReply: (input: unknown) => generateCustomerReply(input),
}))

import { gateReply, type GateContext } from './output-gate.js'
import { buildTurnLedger, type OccupancySpine } from './turn-ledger.js'
import { logGateDecision, GATE_DECISION_LOG_TYPE, type GateDecisionLog } from './gate-telemetry.js'
import { makeGenReply } from '../flows/customer-booking.js'
import { gateAndAuditBranch3Reply } from '../../adapters/llm/orchestrator.js'
import { gateProactiveBody } from '../../adapters/llm/client.js'

// ── stdout capture: collect ONLY the parsed gate_decision lines console.log emits ───────────
function captureGateLines(): { lines: () => Record<string, unknown>[]; restore: () => void } {
  const collected: Record<string, unknown>[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    if (typeof args[0] !== 'string') return
    try {
      const obj = JSON.parse(args[0]) as Record<string, unknown>
      if (obj['logType'] === GATE_DECISION_LOG_TYPE) collected.push(obj)
    } catch { /* not a gate line */ }
  })
  return { lines: () => collected, restore: () => spy.mockRestore() }
}

const NEVER_SPINE: OccupancySpine = async () => ({ openOverall: false, openInService: false, text: null })

function ctx(opts: {
  input?: Partial<GateContext['input']>
  gateOpts?: GateContext['opts']
  regen?: GateContext['regen']
  spine?: OccupancySpine
  base?: { boundaryTimes: string[]; bookingTimes: string[] }
}): GateContext {
  return {
    ledger: buildTurnLedger({
      businessFacts: '', actionLedger: '',
      baseAllowedTimes: opts.base ?? { boundaryTimes: [], bookingTimes: [] },
      occupancySpine: opts.spine ?? NEVER_SPINE,
      businessId: 'biz-test',
    }),
    input: { language: 'he', situation: '', transcript: [], ...opts.input },
    opts: opts.gateOpts ?? {},
    regen: opts.regen ?? (async () => { throw new Error('regen should not be called') }),
  }
}

const REQUIRED_FIELDS = [
  'door', 'businessId', 'identityId', 'sessionId', 'intent', 'gatesFired', 'regenCount',
  'fellToTemplate', 'focusDay', 'situationHadOpenTimes', 'occupancyOutcome',
] as const

// ════════════════════════════════════════════════════════════════════════════
// A — logGateDecision: shape, the grounding-empty vs gate-skipped distinction, env guard
// ════════════════════════════════════════════════════════════════════════════
describe('logGateDecision — emits exactly one structured line with the required shape', () => {
  let cap: ReturnType<typeof captureGateLines>
  beforeEach(() => { cap = captureGateLines() })
  afterEach(() => { cap.restore(); delete process.env['GATE_TELEMETRY'] })

  const base: GateDecisionLog = {
    door: 'branch4', businessId: 'biz', identityId: 'id', sessionId: 'sess', intent: 'inquiry',
    gatesFired: [], regenCount: 0, fellToTemplate: false, focusDay: null,
    situationHadOpenTimes: false, occupancyAsserted: false, occupancySpineConsulted: false,
    occupancyOutcome: 'not_applicable',
  }

  it('emits one line carrying every required field + severity:INFO + the logType marker', () => {
    logGateDecision(base)
    const lines = cap.lines()
    expect(lines).toHaveLength(1)
    const line = lines[0]!
    for (const f of REQUIRED_FIELDS) expect(line, `missing field ${f}`).toHaveProperty(f)
    expect(line['severity']).toBe('INFO')
    expect(line['logType']).toBe(GATE_DECISION_LOG_TYPE)
  })

  it('DISTINGUISHES grounding-empty from gate-skipped (the exact P2 ambiguity)', () => {
    // Grounding empty: situation carried no open times → a no-availability claim had nothing to
    // contradict it. Encoded by situationHadOpenTimes:false + occupancyOutcome:'skipped_grounding_empty'.
    logGateDecision({ ...base, occupancyAsserted: true, situationHadOpenTimes: false, occupancyOutcome: 'skipped_grounding_empty' })
    // Gate skipped: the day-blind surfaced-time short-circuit fired (the gate never compared days).
    logGateDecision({ ...base, occupancyAsserted: true, situationHadOpenTimes: false, occupancyOutcome: 'skipped_reply_surfaced_time' })
    const [groundingEmpty, gateSkipped] = cap.lines()
    expect(groundingEmpty!['occupancyOutcome']).toBe('skipped_grounding_empty')
    expect(gateSkipped!['occupancyOutcome']).toBe('skipped_reply_surfaced_time')
    // The two states are NOT the same value — a reader can tell them apart from the one line.
    expect(groundingEmpty!['occupancyOutcome']).not.toBe(gateSkipped!['occupancyOutcome'])
  })

  it('carries no message body / PII — only ids, booleans, counts, and categorical enums', () => {
    logGateDecision(base)
    const line = cap.lines()[0]!
    // Every value is a string id, a boolean, a number, null, or an array of category strings.
    for (const [k, v] of Object.entries(line)) {
      if (k === 'gatesFired') { expect(Array.isArray(v)).toBe(true); continue }
      expect(['string', 'boolean', 'number'].includes(typeof v) || v === null, `field ${k} is ${typeof v}`).toBe(true)
    }
  })

  it('GATE_TELEMETRY=0 silences the line; default (unset) emits it', () => {
    process.env['GATE_TELEMETRY'] = '0'
    logGateDecision(base)
    expect(cap.lines()).toHaveLength(0)
    delete process.env['GATE_TELEMETRY']
    logGateDecision(base)
    expect(cap.lines()).toHaveLength(1)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// B — gateReply populates telemetry.occupancyOutcome (the P2 distinction at the source)
// ════════════════════════════════════════════════════════════════════════════
describe('gateReply telemetry — occupancyOutcome encodes grounding-empty vs gate-skipped', () => {
  it('GROUNDING EMPTY: no-availability claim, no focusDay, empty situation → skipped_grounding_empty', async () => {
    const res = await gateReply('אין מקום בכלל ביום ראשון, הכל תפוס.', ctx({}))
    expect(res.telemetry.occupancyAsserted).toBe(true)
    expect(res.telemetry.situationHadOpenTimes).toBe(false)
    expect(res.telemetry.occupancySpineConsulted).toBe(false)
    expect(res.telemetry.occupancyOutcome).toBe('skipped_grounding_empty')
    expect(res.telemetry.gatesFired).not.toContain('occupancy')
  })

  it('GATE SKIPPED (P2 shape): focusDay set, reply surfaces a (backed) time, empty situation → skipped_reply_surfaced_time', async () => {
    // 14:00 is in the base allowlist so Gate-2 does NOT fire — the occupancy block sees the
    // ORIGINAL reply, with its surfaced time triggering the day-blind short-circuit (the P2 hole).
    const res = await gateReply('אין מקום ביום ראשון, אבל יש מחר ב-14:00.', ctx({
      base: { boundaryTimes: ['14:00'], bookingTimes: [] },
      gateOpts: { focusDay: { dateStr: '2026-07-05' } },
      spine: async () => { throw new Error('spine must NOT be consulted on the surfaced-time path') },
    }))
    expect(res.telemetry.occupancyAsserted).toBe(true)
    expect(res.telemetry.situationHadOpenTimes).toBe(false) // grounding empty…
    expect(res.telemetry.occupancySpineConsulted).toBe(false) // …AND the spine backstop was skipped
    expect(res.telemetry.occupancyOutcome).toBe('skipped_reply_surfaced_time')
  })

  it('FIRED: focusDay set, no surfaced time, spine reports open → occupancy fires', async () => {
    const res = await gateReply('אין מקום ביום ראשון, הכל תפוס.', ctx({
      gateOpts: { focusDay: { dateStr: '2026-07-05' } },
      spine: async () => ({ openOverall: true, openInService: true, text: 'יש מקום ב-09:00' }),
      regen: async () => 'בשמחה, יש מקום ב-09:00',
    }))
    expect(res.telemetry.occupancySpineConsulted).toBe(true)
    expect(res.telemetry.occupancyOutcome).toBe('fired')
    expect(res.telemetry.gatesFired).toContain('occupancy')
    expect(res.telemetry.regenCount).toBeGreaterThanOrEqual(1)
  })

  it('PASSED (honest full): focusDay set, spine reports closed → passed_spine_closed (no fire)', async () => {
    const res = await gateReply('אין מקום ביום ראשון, הכל תפוס.', ctx({
      gateOpts: { focusDay: { dateStr: '2026-07-05' } },
      spine: async () => ({ openOverall: false, openInService: false, text: null }),
    }))
    expect(res.telemetry.occupancySpineConsulted).toBe(true)
    expect(res.telemetry.occupancyOutcome).toBe('passed_spine_closed')
    expect(res.telemetry.gatesFired).not.toContain('occupancy')
  })

  it('NOT APPLICABLE: a reply that makes no no-availability claim', async () => {
    const res = await gateReply('איזה יום מתאים לך?', ctx({}))
    expect(res.telemetry.occupancyAsserted).toBe(false)
    expect(res.telemetry.occupancyOutcome).toBe('not_applicable')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// C — each of the three doors emits exactly one line per turn
// ════════════════════════════════════════════════════════════════════════════
describe('three doors — each emits exactly one gate-decision line per turn', () => {
  let cap: ReturnType<typeof captureGateLines>
  beforeEach(() => { cap = captureGateLines(); generateCustomerReply.mockReset() })
  afterEach(() => cap.restore())

  it('Branch 4 (makeGenReply): one branch4 line carrying the threaded identity/session/intent', async () => {
    generateCustomerReply.mockResolvedValueOnce('איזה יום מתאים לך?')
    const genReply = makeGenReply('', '', { boundaryTimes: [], bookingTimes: [] }, NEVER_SPINE, 'biz-4',
      { identityId: 'cust-1', sessionId: 'sess-4', intent: 'inquiry' })
    await genReply({ businessName: 'X', language: 'he', situation: 's', transcript: [] })
    const lines = cap.lines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ door: 'branch4', businessId: 'biz-4', identityId: 'cust-1', sessionId: 'sess-4', intent: 'inquiry' })
  })

  it('Branch 4 (makeGenReply): a thrown draft pipeline still emits one fell-to-template line', async () => {
    generateCustomerReply.mockRejectedValueOnce(new Error('LLM blew up'))
    const genReply = makeGenReply('', '', { boundaryTimes: [], bookingTimes: [] }, NEVER_SPINE, 'biz-4',
      { identityId: 'cust-1', sessionId: 'sess-4', intent: 'booking' })
    await genReply({ businessName: 'X', language: 'he', situation: 's', transcript: [] })
    const lines = cap.lines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ door: 'branch4', fellToTemplate: true })
  })

  it('Branch 3 (gateAndAuditBranch3Reply): a clean draft emits one branch3 line, no LLM round-trip', async () => {
    const ledger = buildTurnLedger({
      businessFacts: '', actionLedger: '',
      baseAllowedTimes: { boundaryTimes: [], bookingTimes: [] },
      occupancySpine: NEVER_SPINE, backedActions: [], calendarConnected: false, businessId: 'biz-3',
    })
    await gateAndAuditBranch3Reply({
      draft: 'איזה יום מתאים לך?', ledger, lang: 'he',
      bookingConfirmed: false, succeededActions: new Set(), calendarConnected: false,
      contents: [], systemPrompt: 'sys', businessId: 'biz-3', actorId: 'mgr-1', sessionId: 'sess-3',
    })
    const lines = cap.lines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ door: 'branch3', businessId: 'biz-3', identityId: 'mgr-1', sessionId: 'sess-3', intent: null })
  })

  it('Proactive (gateProactiveBody): a clean body emits one proactive line (no swap)', () => {
    gateProactiveBody('תזכורת קטנה לגבי המפגש שלך.', { language: 'he', fallback: 'fb', businessId: 'biz-p' })
    const lines = cap.lines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ door: 'proactive', businessId: 'biz-p', fellToTemplate: false, gatesFired: [] })
  })

  it('Proactive (gateProactiveBody): an action-fabrication body emits one line, gatesFired:[action], fellToTemplate:true', () => {
    // A self-authored "I'll check and get back to you" in an automated message is always unbacked.
    gateProactiveBody('אני אבדוק מול הצוות ואחזור אליך עם תשובה.', { language: 'he', fallback: 'תזכורת.', businessId: 'biz-p' })
    const lines = cap.lines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ door: 'proactive', gatesFired: ['action'], fellToTemplate: true })
  })
})
