import { describe, it, expect } from 'vitest'
import { extractAllowedTimesFromToolResult, resolvedDaysFromToolArgs } from '../../src/adapters/llm/orchestrator.js'
import { gateReply } from '../../src/domain/grounding/output-gate.js'
import { buildTurnLedger, type OccupancySpine } from '../../src/domain/grounding/turn-ledger.js'

const TZ = 'Asia/Jerusalem'
// 2026-06-29 is a Monday (business-local). weekday 3 = Wednesday → next Wed = 2026-07-01.
const NOW = new Date('2026-06-29T06:00:00Z')

// Build a Branch-3-shaped ledger the way the orchestrator loop will: accumulated tool
// times go into bookingTimes (no boundary concept in Branch 3); the occupancy spine is a
// listDayOptions reader; backedActions is the loop's succeededActions set.
function branch3Ledger(opts: {
  allowedTimes?: string[]
  backedActions?: string[]
  occupancyOpen?: boolean
  occupancyText?: string | null
}) {
  const spine: OccupancySpine = async () => ({
    open: opts.occupancyOpen ?? false,
    text: opts.occupancyText ?? null,
  })
  return buildTurnLedger({
    businessFacts: '## Services offered\n- Yoga (group class, up to 10)',
    actionLedger: '',
    baseAllowedTimes: { boundaryTimes: [], bookingTimes: opts.allowedTimes ?? [] },
    occupancySpine: spine,
    backedActions: (opts.backedActions ?? []) as never[],
    calendarConnected: false,
    businessId: 'biz-1',
  })
}

// T1.1 — Branch-3 per-turn allowlist accumulator.
// The orchestrator must seed its time allowlist from the AVAILABILITY tool RESULTS
// (system-authored, en-GB/he-IL 24h strings), so a manager reply that states one of
// those real times is never mistaken for a fabrication. Capture is via extractClockTimes
// over the result strings; non-availability tools (e.g. searchWeb) are NOT scanned so a
// stray "14:00" in a web snippet can't launder a fabricated availability claim.

describe('extractAllowedTimesFromToolResult (T1.1)', () => {
  it('captures the 24h times from a check_free_slots result (freeSlots start/end)', () => {
    const result = {
      freeSlots: [
        { start: 'Tue, 3 Jun, 14:00', end: '14:30' },
        { start: 'Wed, 4 Jun, 09:00', end: '09:30' },
      ],
      durationMinutes: 30,
      count: 2,
    }
    const times = extractAllowedTimesFromToolResult('listCalendarEvents', result)
    expect(times).toEqual(expect.arrayContaining(['14:00', '14:30', '09:00', '09:30']))
  })

  it('captures the times from a list_today/list_range result (buildScheduleView events)', () => {
    const result = {
      events: [
        { eventId: 'a', title: 'Yoga', start: 'Tue, 3 Jun, 10:00', end: '11:00', isBooking: true, kind: 'booking' },
        { eventId: 'b', title: 'Block', start: 'Tue, 3 Jun, 17:00', end: '18:00', isBooking: false, kind: 'block' },
      ],
      count: 2,
    }
    const times = extractAllowedTimesFromToolResult('listCalendarEvents', result)
    expect(times).toEqual(expect.arrayContaining(['10:00', '11:00', '17:00', '18:00']))
  })

  it('captures the Hebrew (he-IL) 24h slot strings too', () => {
    const result = { freeSlots: [{ start: 'יום ג׳, 3 ביוני, 14:00', end: '14:30' }], count: 1 }
    const times = extractAllowedTimesFromToolResult('listCalendarEvents', result)
    expect(times).toEqual(expect.arrayContaining(['14:00', '14:30']))
  })

  it('does NOT scan non-availability tool results (a searchWeb snippet time stays out)', () => {
    const result = { results: [{ snippet: 'Event starts at 14:00 sharp' }] }
    expect(extractAllowedTimesFromToolResult('searchWeb', result)).toEqual([])
  })

  it('returns [] for a failed/empty availability result', () => {
    expect(extractAllowedTimesFromToolResult('listCalendarEvents', { error: 'boom' })).toEqual([])
    expect(extractAllowedTimesFromToolResult('listCalendarEvents', { freeSlots: [], count: 0 })).toEqual([])
    expect(extractAllowedTimesFromToolResult('listCalendarEvents', null)).toEqual([])
  })

  it('dedupes repeated times', () => {
    const result = {
      events: [
        { start: 'Tue, 3 Jun, 10:00', end: '11:00' },
        { start: 'Wed, 4 Jun, 10:00', end: '11:00' },
      ],
      count: 2,
    }
    const times = extractAllowedTimesFromToolResult('listCalendarEvents', result)
    expect(times.filter((t) => t === '10:00')).toHaveLength(1)
  })
})

describe('resolvedDaysFromToolArgs (T1.2 / D4 day-derivation)', () => {
  it('resolves a single day from a getSessionRoster date arg', () => {
    const days = resolvedDaysFromToolArgs('getSessionRoster', { serviceName: 'Yoga', date: { weekday: 3 }, time: { hour: 10, minute: 0 } }, TZ, NOW)
    expect(days).toEqual(['2026-07-01'])
  })

  it('resolves today for listCalendarEvents list_today', () => {
    const days = resolvedDaysFromToolArgs('listCalendarEvents', { intent: 'list_today' }, TZ, NOW)
    expect(days).toEqual(['2026-06-29'])
  })

  it('resolves BOTH bounds for a list_range (so a multi-day range never pins one focus day)', () => {
    const days = resolvedDaysFromToolArgs('listCalendarEvents', { intent: 'list_range', dateFrom: { weekday: 3 }, dateTo: { weekday: 4 } }, TZ, NOW)
    expect(days).toEqual(['2026-07-01', '2026-07-02'])
  })

  it('pins no day for a multi-day scan (check_free_slots / list_week)', () => {
    expect(resolvedDaysFromToolArgs('listCalendarEvents', { intent: 'check_free_slots' }, TZ, NOW)).toEqual([])
    expect(resolvedDaysFromToolArgs('listCalendarEvents', { intent: 'list_week' }, TZ, NOW)).toEqual([])
  })

  it('ignores non-day-scoped tools', () => {
    expect(resolvedDaysFromToolArgs('searchWeb', { query: 'x' }, TZ, NOW)).toEqual([])
    expect(resolvedDaysFromToolArgs('manageBusinessSettings', { instruction: 'x' }, TZ, NOW)).toEqual([])
  })
})

describe('Branch-3 gate via gateReply (T1.2 — closes H1)', () => {
  it("catches a fabricated 'Tuesday 14:00 is free' with no backing time", async () => {
    let regenCalled = false
    const res = await gateReply('You\'re free Tuesday at 14:00.', {
      ledger: branch3Ledger({ allowedTimes: [] }),
      input: { language: 'en' },
      opts: {},
      regen: async () => { regenCalled = true; return 'Let me check what is actually open and get back to you.' },
    })
    expect(regenCalled).toBe(true)
    expect(res.interventions).toContain('time')
    expect(res.reply).not.toContain('14:00')
  })

  it("corrects a blanket 'fully booked Wednesday' when the spine still has open capacity", async () => {
    let regenInstruction = ''
    const res = await gateReply('Wednesday is completely full, sorry.', {
      ledger: branch3Ledger({ occupancyOpen: true, occupancyText: 'Yoga 11:00 (3 spots)' }),
      input: { language: 'en' },
      opts: { focusDay: { dateStr: '2026-07-01' } },
      regen: async (instruction) => { regenInstruction = instruction; return 'Actually Wednesday still has the 11:00 Yoga open — want it?' },
    })
    expect(res.interventions).toContain('occupancy')
    expect(regenInstruction).toContain('open')
    expect(res.reply).toContain('11:00')
  })

  it('passes a backed time (surfaced by a tool this turn) untouched', async () => {
    const res = await gateReply('Tuesday 14:00 works — shall I book it?', {
      ledger: branch3Ledger({ allowedTimes: ['14:00'] }),
      input: { language: 'en' },
      opts: {},
      regen: async () => { throw new Error('regen must not run for a backed time') },
    })
    expect(res.interventions).not.toContain('time')
    expect(res.reply).toContain('14:00')
  })

  it("passes a real tool-booked 'I booked you' when bookingConfirmed (backedActions has booking_made)", async () => {
    const res = await gateReply('Done — I booked you for 14:00.', {
      ledger: branch3Ledger({ allowedTimes: [], backedActions: ['booking_made'] }),
      input: { language: 'en' },
      opts: { bookingConfirmed: true },
      regen: async () => { throw new Error('regen must not run when the booking is backed') },
    })
    expect(res.interventions).toHaveLength(0)
    expect(res.reply).toContain('I booked you')
  })

  it('skips the occupancy gate when no single clear day was resolved (focusDay undefined)', async () => {
    const res = await gateReply('Everything is fully booked this week.', {
      ledger: branch3Ledger({ occupancyOpen: true, occupancyText: 'open' }),
      input: { language: 'en' },
      opts: {}, // no focusDay → D4: skip rather than guess
      regen: async () => { throw new Error('regen must not run without a focus day') },
    })
    expect(res.interventions).not.toContain('occupancy')
  })
})

import { actionsFromToolResult } from '../../src/adapters/llm/orchestrator.js'

describe('actionsFromToolResult — extended backed-action coverage (T1.3)', () => {
  it('backs a refund only on ok:true (refundTransaction)', () => {
    expect(actionsFromToolResult('refundTransaction', {}, { ok: true, fact: '{}' })).toEqual(['refunded'])
    expect(actionsFromToolResult('refundTransaction', {}, { ok: false, reason: 'no_refundable_charge' })).toEqual([])
  })

  it('backs a broadcast only when something was actually sent (sent > 0)', () => {
    expect(actionsFromToolResult('broadcastAnnouncement', {}, { ok: true, matched: 10, sent: 8 })).toEqual(['broadcast_sent'])
    // matched 0 / sent 0 → nothing was sent → must NOT back "customers notified" (H12).
    expect(actionsFromToolResult('broadcastAnnouncement', {}, { ok: true, matched: 0, sent: 0 })).toEqual([])
    expect(actionsFromToolResult('broadcastAnnouncement', {}, { ok: false, reason: 'missing_detail' })).toEqual([])
  })

  it('backs a settings change (and cancellation) on manageBusinessSettings success; clarification backs nothing', () => {
    const ok = actionsFromToolResult('manageBusinessSettings', { instruction: 'set price 300' }, { success: true, fact: 'price set' })
    expect(ok).toContain('settings_changed')
    expect(ok).toContain('cancelled')
    // clarificationNeeded → success:false → nothing backed (the "set the price" repro).
    expect(actionsFromToolResult('manageBusinessSettings', { instruction: 'change price' }, { success: false, clarificationNeeded: 'which service?' })).toEqual([])
  })

  it('coordinateMeeting: partial:true must NOT back a "texted them" claim; a full send does', () => {
    // saved-but-couldn't-message → partial → no backing (H4 — "texted Harel" on partial).
    expect(actionsFromToolResult('coordinateMeeting', { contactName: 'Harel' }, { success: true, partial: true, message: '...' })).toEqual([])
    expect(actionsFromToolResult('coordinateMeeting', { contactName: 'Harel' }, { success: true, coordinationId: 'c1', message: '...' })).toEqual(['message_sent'])
    expect(actionsFromToolResult('coordinateMeeting', {}, { success: false, reason: 'no_recipient' })).toEqual([])
  })

  it('resolveMeetingCoordination: confirm → booking_made (H16); counter_offer → message_sent; abandon → none', () => {
    expect(actionsFromToolResult('resolveMeetingCoordination', { coordinationId: 'c1', action: 'confirm' }, { success: true })).toEqual(['booking_made'])
    expect(actionsFromToolResult('resolveMeetingCoordination', { coordinationId: 'c1', action: 'counter_offer' }, { success: true })).toEqual(['message_sent'])
    expect(actionsFromToolResult('resolveMeetingCoordination', { coordinationId: 'c1', action: 'abandon' }, { success: true })).toEqual([])
    expect(actionsFromToolResult('resolveMeetingCoordination', { coordinationId: 'c1', action: 'confirm' }, { success: false })).toEqual([])
  })

  it('a partial result never backs (global partial≠backed rule)', () => {
    expect(actionsFromToolResult('messageCustomer', {}, { ok: true, partial: true })).toEqual([])
  })
})
