import { describe, it, expect } from 'vitest'
import { buildDateFactsBlock } from '../../src/adapters/llm/client.js'

// buildDateFactsBlock is the pure, timezone-aware date-facts builder injected into
// the conversational customer reply prompt (Bug 2 fix). It must give the LLM REAL
// dates to phrase so it never invents them — and must never leak internal codes.
describe('buildDateFactsBlock', () => {
  // Sunday 7 June 2026, 09:00 UTC = 12:00 in Jerusalem (UTC+3 summer) — same day.
  const now = new Date('2026-06-07T09:00:00.000Z')

  it('reports the correct today/tomorrow for Asia/Jerusalem', () => {
    const block = buildDateFactsBlock('Asia/Jerusalem', now)
    expect(block).toContain('Today: Sunday, 2026-06-07')
    expect(block).toContain('Tomorrow: Monday, 2026-06-08')
  })

  it('lists today..today+7 (8 day lines) in order', () => {
    const block = buildDateFactsBlock('Asia/Jerusalem', now)
    const dayLines = block.split('\n').filter((l) => l.startsWith('- '))
    expect(dayLines).toHaveLength(8)
    expect(dayLines[2]).toBe('- Tuesday, 2026-06-09')
    expect(dayLines[7]).toBe('- Sunday, 2026-06-14')
  })

  it('resolves "today" in the business timezone, not UTC, across the date line', () => {
    // 22:30 UTC on 7 June = 01:30 on 8 June in Jerusalem — today is already Monday.
    const lateNight = new Date('2026-06-07T22:30:00.000Z')
    const block = buildDateFactsBlock('Asia/Jerusalem', lateNight)
    expect(block).toContain('Today: Monday, 2026-06-08')
    expect(block).toContain('Tomorrow: Tuesday, 2026-06-09')
  })

  it('crosses month and year boundaries correctly', () => {
    const block = buildDateFactsBlock('Asia/Jerusalem', new Date('2026-12-29T09:00:00.000Z'))
    expect(block).toContain('Today: Tuesday, 2026-12-29')
    // +3 days lands in the new year
    expect(block).toContain('Friday, 2027-01-01')
  })

  it('contains no raw reason codes, enums, or internal field names (G2)', () => {
    const block = buildDateFactsBlock('Asia/Jerusalem', now)
    for (const leak of [
      'past_slot', 'outside_hours', 'calendar_error', 'policy_violation',
      'hold_conflict', 'not_found', 'slot_conflict', 'cutoff_passed',
      'max_days_ahead', 'min_buffer', 'ambiguous_date', 'impossible_date',
      'serviceTypeId', 'pendingSlot', 'resolvedStart',
    ]) {
      expect(block).not.toContain(leak)
    }
  })

  it('instructs the model to phrase dates, never compute them', () => {
    const block = buildDateFactsBlock('Asia/Jerusalem', now)
    expect(block).toContain('NEVER compute, guess, or invent a date')
  })
})
