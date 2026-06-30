import { describe, it, expect, beforeEach, vi } from 'vitest'

// T1.4 (prompt half) — generateProviderOnboardingReply threads addresseeGender into the
// onboarding voice core: a female owner gets the feminine Hebrew addressing line; unknown →
// masculine floor. We capture the systemInstruction instead of asserting generated Hebrew.
const calls: Array<{ config: { systemInstruction?: string } }> = []

vi.mock('@google/genai', () => {
  class GoogleGenAI {
    models = {
      generateContent: async (req: { config: { systemInstruction?: string } }) => {
        calls.push({ config: req.config })
        return { text: 'תשובה' }
      },
    }
  }
  return { GoogleGenAI, Type: {} }
})

import { generateProviderOnboardingReply } from '../../src/adapters/llm/client.js'

async function promptFor(addresseeGender: 'male' | 'female' | null | undefined): Promise<string> {
  calls.length = 0
  await generateProviderOnboardingReply({
    step: 'ask_timezone', lang: 'he', fallback: 'fallback',
    ...(addresseeGender === undefined ? {} : { addresseeGender }),
  })
  return calls.at(-1)?.config.systemInstruction ?? ''
}

describe('generateProviderOnboardingReply threads owner addressee gender', () => {
  beforeEach(() => { calls.length = 0 })

  it('female owner → feminine addressing line, no masculine', async () => {
    const p = await promptFor('female')
    expect(p).toContain('בלשון נקבה')
    expect(p).not.toContain('בלשון זכר')
  })

  it('unknown (null/omitted) → masculine floor, byte-identical', async () => {
    const omitted = await promptFor(undefined)
    const nullGender = await promptFor(null)
    expect(omitted).toBe(nullGender)
    expect(omitted).toContain('בלשון זכר')
    expect(omitted).not.toContain('בלשון נקבה')
  })
})
