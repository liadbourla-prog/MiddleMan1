/**
 * Phase 0 (T0.1/T0.2) — inbound-decision telemetry, pure-shape tests.
 *
 * Mirrors the X1 gate-telemetry approach (src/domain/grounding/gate-telemetry.ts):
 * one structured JSON line per reconciled Google event, emitted at INFO on stdout
 * so Cloud Logging parses it into a queryable jsonPayload. HARD CONSTRAINT: ids +
 * enums + null ONLY — never an event title/body (PII / decision #10 privacy).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  logInboundDecision,
  INBOUND_DECISION_LOG_TYPE,
  type InboundDecisionLog,
} from './inbound-telemetry.js'

function capture(): { lines: unknown[]; restore: () => void } {
  const lines: unknown[] = []
  const spy = vi.spyOn(console, 'log').mockImplementation((arg: unknown) => {
    try {
      const parsed = JSON.parse(String(arg))
      if (parsed && parsed.logType === INBOUND_DECISION_LOG_TYPE) lines.push(parsed)
    } catch { /* not our line */ }
  })
  return { lines, restore: () => spy.mockRestore() }
}

const BASE: InboundDecisionLog = {
  businessId: 'biz-1',
  googleEventId: 'gev-abc',
  decision: 'block_opaque',
  matchedServiceTypeId: null,
  matchTier: null,
  viaTrigger: 'read',
}

describe('logInboundDecision — shape & marker', () => {
  let cap: ReturnType<typeof capture>
  beforeEach(() => { delete process.env['INBOUND_TELEMETRY']; cap = capture() })
  afterEach(() => { cap.restore(); delete process.env['INBOUND_TELEMETRY'] })

  it('emits exactly one line carrying the stable logType marker + INFO severity', () => {
    logInboundDecision(BASE)
    expect(cap.lines).toHaveLength(1)
    const line = cap.lines[0] as Record<string, unknown>
    expect(line['logType']).toBe(INBOUND_DECISION_LOG_TYPE)
    expect(line['severity']).toBe('INFO')
  })

  it('carries all decision fields with the right values', () => {
    logInboundDecision({
      ...BASE,
      decision: 'class_materialized',
      matchedServiceTypeId: 'svc-pilates',
      matchTier: 'template',
      viaTrigger: 'push',
    })
    const line = cap.lines[0] as Record<string, unknown>
    expect(line).toMatchObject({
      businessId: 'biz-1',
      googleEventId: 'gev-abc',
      decision: 'class_materialized',
      matchedServiceTypeId: 'svc-pilates',
      matchTier: 'template',
      viaTrigger: 'push',
    })
  })

  it('NEVER leaks a title/body — an event summary passed nowhere appears in the line', () => {
    logInboundDecision(BASE)
    const raw = JSON.stringify(cap.lines[0])
    // No free-text/PII-shaped keys.
    for (const forbidden of ['summary', 'title', 'description', 'body', 'text', 'phone']) {
      expect(raw.toLowerCase()).not.toContain(forbidden)
    }
  })

  it('is silenced when INBOUND_TELEMETRY is off', () => {
    process.env['INBOUND_TELEMETRY'] = 'off'
    logInboundDecision(BASE)
    expect(cap.lines).toHaveLength(0)
  })

  it('is ON by default (X1 fix: reaches prod at INFO without opt-in)', () => {
    // No env set (deleted in beforeEach).
    logInboundDecision(BASE)
    expect(cap.lines).toHaveLength(1)
  })
})
