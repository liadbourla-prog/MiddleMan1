import { describe, it, expect, beforeEach, vi } from 'vitest'

// T1.7 — the remaining live owner/onboarding reply paths thread addressee gender into their
// voice core: a female owner is addressed feminine; unknown → masculine floor (byte-identical).
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

import {
  buildOnboardingSystemPrompt,
  explainOnboardingConcept,
  generateManagerCommandReply,
  generateOnboardingReply,
} from '../../src/adapters/llm/client.js'

beforeEach(() => { calls.length = 0 })

const lastPrompt = (): string => calls.at(-1)?.config.systemInstruction ?? ''

// buildOnboardingSystemPrompt is pure — assert directly, no LLM round-trip.
describe('buildOnboardingSystemPrompt threads addressee gender', () => {
  const base = { step: 'business_name', businessName: 'הסטודיו', lang: 'he' as const, isRetry: false }

  it('female → feminine line, no masculine', () => {
    const p = buildOnboardingSystemPrompt({ ...base, addresseeGender: 'female' })
    expect(p).toContain('בלשון נקבה')
    expect(p).not.toContain('בלשון זכר')
  })

  it('unknown (null/omitted) → masculine floor, byte-identical', () => {
    const omitted = buildOnboardingSystemPrompt({ ...base })
    const nullGender = buildOnboardingSystemPrompt({ ...base, addresseeGender: null })
    expect(omitted).toBe(nullGender)
    expect(omitted).toContain('בלשון זכר')
    expect(omitted).not.toContain('בלשון נקבה')
  })
})

describe('explainOnboardingConcept threads addressee gender', () => {
  it('female → feminine line', async () => {
    await explainOnboardingConcept({ concept: 'timezone', userMessage: 'מה זה?', step: 'timezone', lang: 'he', addresseeGender: 'female' })
    expect(lastPrompt()).toContain('בלשון נקבה')
    expect(lastPrompt()).not.toContain('בלשון זכר')
  })

  it('unknown → masculine floor', async () => {
    await explainOnboardingConcept({ concept: 'timezone', userMessage: 'מה זה?', step: 'timezone', lang: 'he' })
    expect(lastPrompt()).toContain('בלשון זכר')
    expect(lastPrompt()).not.toContain('בלשון נקבה')
  })
})

describe('generateManagerCommandReply threads addressee gender', () => {
  it('female → feminine line', async () => {
    await generateManagerCommandReply({ businessName: 'הסטודיו', language: 'he', situation: 'STATUS', fallback: 'x', addresseeGender: 'female' })
    expect(lastPrompt()).toContain('בלשון נקבה')
    expect(lastPrompt()).not.toContain('בלשון זכר')
  })

  it('unknown → masculine floor', async () => {
    await generateManagerCommandReply({ businessName: 'הסטודיו', language: 'he', situation: 'STATUS', fallback: 'x' })
    expect(lastPrompt()).toContain('בלשון זכר')
    expect(lastPrompt()).not.toContain('בלשון נקבה')
  })
})

describe('generateOnboardingReply threads addressee gender into its prompt', () => {
  const base = { step: 'business_name', businessName: 'הסטודיו', lang: 'he' as const, isRetry: false }

  it('female → feminine line', async () => {
    await generateOnboardingReply({ ...base, addresseeGender: 'female' })
    expect(lastPrompt()).toContain('בלשון נקבה')
    expect(lastPrompt()).not.toContain('בלשון זכר')
  })

  it('unknown → masculine floor', async () => {
    await generateOnboardingReply({ ...base })
    expect(lastPrompt()).toContain('בלשון זכר')
    expect(lastPrompt()).not.toContain('בלשון נקבה')
  })
})
