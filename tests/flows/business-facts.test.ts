import { describe, it, expect } from 'vitest'
import { buildBusinessFacts } from '../../src/domain/flows/customer-booking.js'

// Phase 1 (grounding) — the authoritative, closed-world facts block injected into
// every customer reply. These lock the contract that prevents C3 (invented
// instructors/prices/capacities/policy) and C4 (suggestibility). Mirrors the real
// סטודיוגה config from the soft-launch test: 3 private services, no prices, no staff.
const STUDIOGA_SERVICES = [
  { id: 's1', name: 'יוגה', durationMinutes: 60, maxParticipants: 1 },
  { id: 's2', name: 'פילאטיס', durationMinutes: 60, maxParticipants: 1 },
  { id: 's3', name: 'סדנת נשימות', durationMinutes: 75, maxParticipants: 1 },
]

describe('buildBusinessFacts — closed-world grounding', () => {
  it('lists exactly the active services and marks the list complete', () => {
    const facts = buildBusinessFacts(STUDIOGA_SERVICES, undefined, undefined)
    expect(facts).toContain('COMPLETE list')
    expect(facts).toContain('יוגה')
    expect(facts).toContain('פילאטיס')
    expect(facts).toContain('סדנת נשימות')
  })

  it('forbids naming or inventing instructors/staff (kills the דן/דנה/נועה hallucination)', () => {
    const facts = buildBusinessFacts(STUDIOGA_SERVICES, undefined, undefined)
    expect(facts.toLowerCase()).toContain('do not name')
    expect(facts.toLowerCase()).toContain('instructor')
  })

  it('marks private 1-on-1 services so the LLM cannot offer "up to 10 people"', () => {
    const facts = buildBusinessFacts(STUDIOGA_SERVICES, undefined, undefined)
    expect(facts).toContain('private 1-on-1')
    expect(facts).not.toMatch(/up to \d+ people/)
  })

  it('marks services with no price so the LLM cannot quote 450₪', () => {
    const facts = buildBusinessFacts(STUDIOGA_SERVICES, undefined, undefined)
    expect(facts).toContain('do NOT quote a price')
  })

  it('renders a group service capacity when one genuinely exists', () => {
    const facts = buildBusinessFacts(
      [{ id: 'g1', name: 'Spin', durationMinutes: 45, maxParticipants: 12 }],
      undefined,
      undefined,
    )
    expect(facts).toContain('up to 12 people')
  })

  it('surfaces the real booking horizon so November is not falsely "not open yet"', () => {
    const facts = buildBusinessFacts(
      STUDIOGA_SERVICES,
      undefined,
      { maxBookingDaysAhead: 365 } as never,
    )
    expect(facts).toContain('365 days ahead')
    expect(facts.toLowerCase()).toContain('not open yet')
  })

  it('surfaces the business address verbatim so Branch 4 can answer "where are you?"', () => {
    const facts = buildBusinessFacts(
      STUDIOGA_SERVICES,
      undefined,
      { address: 'הרצל 1, תל אביב' } as never,
    )
    expect(facts).toContain('הרצל 1, תל אביב')
    expect(facts.toLowerCase()).toContain('address')
  })

  it('surfaces a derived Google Maps link alongside the address', () => {
    const facts = buildBusinessFacts(
      STUDIOGA_SERVICES,
      undefined,
      { address: 'Herzl 1, Tel Aviv' } as never,
    )
    expect(facts).toContain('https://www.google.com/maps/search/')
  })

  it('uses the owner-pasted map link over a derived one when present', () => {
    const facts = buildBusinessFacts(
      STUDIOGA_SERVICES,
      undefined,
      { address: 'Herzl 1', googleMapsUrl: 'https://g.page/studio' } as never,
    )
    expect(facts).toContain('https://g.page/studio')
    expect(facts).not.toContain('maps/search')
  })

  it('guards against inventing an address when none is on record', () => {
    const facts = buildBusinessFacts(STUDIOGA_SERVICES, undefined, undefined)
    expect(facts.toLowerCase()).toContain('none on record')
    expect(facts.toLowerCase()).toContain('do not invent')
  })

  it('refuses to offer anything when no services are configured', () => {
    const facts = buildBusinessFacts([], undefined, undefined)
    expect(facts).toContain('NO bookable services')
    expect(facts.toLowerCase()).toContain('do not')
  })

  it('uses a real price when business knowledge provides one', () => {
    const facts = buildBusinessFacts(
      [{ id: 's1', name: 'Massage', durationMinutes: 45, maxParticipants: 1 }],
      { services: [{ id: 's1', price: 250, currency: 'ILS' }] } as never,
      undefined,
    )
    expect(facts).toContain('250 ILS')
    expect(facts).not.toContain('do NOT quote a price')
  })
})
