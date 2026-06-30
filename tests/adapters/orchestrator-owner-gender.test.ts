import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildSystemPrompt, resolveOwnerAddresseeGender } from '../../src/adapters/llm/orchestrator.js'

// T1.3 — Branch 3 owner self-addressing. The orchestrator resolves the OWNER's Hebrew
// addressee gender (stored ▸ name ▸ self-morphology of the owner's own inbound) and threads
// it into buildVoiceCore('manager'). Unknown → masculine floor (decision 1).

describe('resolveOwnerAddresseeGender', () => {
  it('reads feminine self-morphology from the owner\'s own message (rank self_morphology)', () => {
    const r = resolveOwnerAddresseeGender({ stored: null, storedSource: null, ownerName: null, message: 'אני רוצה לבדוק, אני מעוניינת בזה' })
    expect(r).toEqual({ gender: 'female', source: 'self_morphology' })
  })

  it('falls back to the owner name when the message has no gendered self-reference', () => {
    const r = resolveOwnerAddresseeGender({ stored: null, storedSource: null, ownerName: 'שירה', message: 'מה המצב?' })
    expect(r).toEqual({ gender: 'female', source: 'name' })
  })

  it('a stored explicit gender is not downgraded by a weaker fresh signal', () => {
    const r = resolveOwnerAddresseeGender({ stored: 'female', storedSource: 'explicit', ownerName: 'דוד', message: 'hi' })
    expect(r).toEqual({ gender: 'female', source: 'explicit' })
  })

  it('returns null (→ masculine floor) when nothing resolves', () => {
    expect(resolveOwnerAddresseeGender({ stored: null, storedSource: null, ownerName: null, message: 'hello' })).toBeNull()
  })
})

const baseParams = {
  businessName: 'הסטודיו',
  timezone: 'Asia/Jerusalem',
  lang: 'he' as const,
  businessKnowledge: null,
  activeServices: [],
  instructorRoster: [],
  teachingSchedule: [],
  managerMemorySummaries: [],
  actionLedger: '',
  activeCoordinations: '',
  openQuestions: '',
  outreachIdentity: '',
  bookingAuthority: 'auto' as const,
  conversationHistory: [],
}

describe('buildSystemPrompt threads owner addressee gender', () => {
  it('female owner → feminine manager addressing line', () => {
    const p = buildSystemPrompt({ ...baseParams, addresseeGender: 'female' })
    expect(p).toContain('בלשון נקבה')
    expect(p).not.toContain('בלשון זכר')
  })

  it('unknown owner (omitted/null) → masculine floor', () => {
    const omitted = buildSystemPrompt({ ...baseParams })
    const nullGender = buildSystemPrompt({ ...baseParams, addresseeGender: null })
    for (const p of [omitted, nullGender]) {
      expect(p).toContain('בלשון זכר')
      expect(p).not.toContain('בלשון נקבה')
    }
  })
})

describe('runManagerOrchestratorLoop wires owner gender resolution (source introspection)', () => {
  const src = readFileSync(fileURLToPath(new URL('../../src/adapters/llm/orchestrator.ts', import.meta.url)), 'utf8')
  const body = src.slice(src.indexOf('export async function runManagerOrchestratorLoop('))

  it('resolves the owner gender from the inbound and threads it into buildSystemPrompt', () => {
    // The owner's inbound message feeds the deterministic self-morphology detector.
    expect(body).toMatch(/resolveOwnerAddresseeGender\(/)
    // The resolved value is passed into the system prompt builder.
    expect(body).toMatch(/addresseeGender/)
  })
})
