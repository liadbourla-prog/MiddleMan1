import { describe, it, expect } from 'vitest'
import { buildVoiceCore } from '../../src/adapters/llm/voice.js'

// T0.8 — parameterized addressee gender in buildVoiceCore. Phase 0 is behavior-preserving:
// the unknown/masculine case must be byte-identical to the prior hardcoded rule.
describe('buildVoiceCore addressee gender', () => {
  it('defaults to masculine when gender is omitted/null (the unknown floor)', () => {
    const def = buildVoiceCore('customer')
    expect(def).toContain('בלשון זכר')
    expect(def).toContain('masculine singular second-person')
    expect(def).not.toContain('בלשון נקבה')
  })

  it('omitted === explicit male === null (byte-identical, no behavior change)', () => {
    expect(buildVoiceCore('customer')).toBe(buildVoiceCore('customer', 'male'))
    expect(buildVoiceCore('customer')).toBe(buildVoiceCore('customer', null))
    expect(buildVoiceCore('manager')).toBe(buildVoiceCore('manager', 'male'))
  })

  it('female switches to the single feminine form and drops masculine', () => {
    const fem = buildVoiceCore('customer', 'female')
    expect(fem).toContain('בלשון נקבה')
    expect(fem).toContain('feminine singular second-person')
    expect(fem).not.toContain('בלשון זכר')
    expect(fem).not.toContain('masculine singular second-person')
  })

  it('ONLY the addressing line differs male vs female — head and channel note are identical', () => {
    const m = buildVoiceCore('customer', 'male')
    const f = buildVoiceCore('customer', 'female')
    // identical prefix up to the ADDRESSING line
    expect(m.split('ADDRESSING')[0]).toBe(f.split('ADDRESSING')[0])
    // identical suffix after the addressing line (the per-channel note)
    expect(m.split('governs that).')[1]).toBe(f.split('governs that).')[1])
  })

  it('still bans split-gender in BOTH forms (the prompt forbids it as a negative example)', () => {
    for (const g of ['male', 'female'] as const) {
      const line = buildVoiceCore('customer', g)
      expect(line).toContain('NEVER write split-gender forms')
    }
  })
})
