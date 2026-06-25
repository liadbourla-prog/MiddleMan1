import { describe, it, expect } from 'vitest'
import { renderAction } from './ledger-block.js'

// Cross-branch reality consistency (INV-3/INV-4):
// docs/superpowers/specs/2026-06-25-cross-branch-consistency-and-booking-authority-design.md
// The owner-facing ground-truth line for a customer self-commit must REFLECT it as done and
// explicitly forbid re-asking the owner to approve it — the exact Yoni-incident failure.
describe('renderAction — booking ground-truth wording', () => {
  const tz = 'Asia/Jerusalem'
  const locale = 'en-GB'
  const when = 'Thu 08:29'

  const selfBookMeta = {
    customerName: 'Yoni',
    serviceName: 'Pilates',
    slotStart: '2026-07-05T14:00:00.000Z', // Sun 17:00 Asia/Jerusalem
    initiator: 'customer_self',
  }

  it('customer self-booking → names who/what/when, marks ALREADY DONE, forbids re-approval', () => {
    const line = renderAction('booking.confirmed', selfBookMeta, when, tz, locale)
    expect(line).toContain('Yoni')
    expect(line).toContain('Pilates')
    expect(line).toContain('themselves')
    expect(line).toContain('ALREADY DONE')
    expect(line).toMatch(/do NOT ask the owner to approve/i)
    // the slot must be reflected so the owner sees a concrete commitment, not a vague one
    expect(line).toMatch(/17:00/)
  })

  it('customer self-cancellation → reflects the cancellation as done, no approval ask', () => {
    const line = renderAction('booking.cancelled', { ...selfBookMeta }, when, tz, locale)
    expect(line).toContain('Yoni')
    expect(line).toContain('cancelled')
    expect(line).toContain('ALREADY DONE')
  })

  it('owner-initiated booking → phrased as the owner\'s own done action, never "already done, do not approve"', () => {
    const line = renderAction('booking.confirmed', { ...selfBookMeta, initiator: 'owner' }, when, tz, locale)
    expect(line).toContain('You booked')
    expect(line).toContain('Yoni')
    expect(line).not.toContain('ALREADY DONE')
  })

  it('missing metadata → falls back gracefully without crashing', () => {
    const line = renderAction('booking.confirmed', null, when, tz, locale)
    expect(line).toContain('a customer')
    expect(line).toContain('an appointment')
  })
})
