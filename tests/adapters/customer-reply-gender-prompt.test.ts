import { describe, it, expect, vi, beforeEach } from 'vitest'

// T1.1 VOICE GATE (prompt half) — generateCustomerReply must thread addresseeGender into the
// system prompt: a known-female addressee gets the feminine Hebrew addressing line, a known-male
// (and unknown/null) gets masculine, and unknown is byte-identical to today (the masculine floor).
// We capture the systemInstruction handed to Gemini instead of asserting on generated Hebrew.
const calls: Array<{ config: { systemInstruction?: string } }> = []

vi.mock('@google/genai', () => {
  class GoogleGenAI {
    models = {
      generateContent: async (req: { config: { systemInstruction?: string } }) => {
        calls.push({ config: req.config })
        return { text: 'תשובה אנושית' }
      },
    }
  }
  return { GoogleGenAI, Type: {} }
})

import { generateCustomerReply } from '../../src/adapters/llm/client.js'
import type { GenerateReplyInput } from '../../src/adapters/llm/types.js'

const base: GenerateReplyInput = {
  businessName: 'הסטודיו',
  language: 'he',
  situation: 'Customer asked when you are open.',
  transcript: [],
}

async function promptFor(addresseeGender: 'male' | 'female' | null | undefined): Promise<string> {
  calls.length = 0
  await generateCustomerReply({ ...base, ...(addresseeGender === undefined ? {} : { addresseeGender }) })
  return calls.at(-1)?.config.systemInstruction ?? ''
}

describe('generateCustomerReply threads addressee gender into the prompt', () => {
  beforeEach(() => { calls.length = 0 })

  it('female → feminine addressing line, no masculine', async () => {
    const p = await promptFor('female')
    expect(p).toContain('בלשון נקבה')
    expect(p).toContain('feminine singular second-person')
    expect(p).not.toContain('בלשון זכר')
  })

  it('male → masculine addressing line, no feminine', async () => {
    const p = await promptFor('male')
    expect(p).toContain('בלשון זכר')
    expect(p).not.toContain('בלשון נקבה')
  })

  it('unknown (null/omitted) is byte-identical and masculine — the floor (decision 1)', async () => {
    const omitted = await promptFor(undefined)
    const nullGender = await promptFor(null)
    // The unknown floor: omitted and explicit-null produce the SAME prompt, masculine, no note.
    expect(omitted).toBe(nullGender)
    expect(omitted).toContain('בלשון זכר')
    expect(omitted).not.toContain('בלשון נקבה')
  })

  it('both forms explicitly BAN split-gender (the forms appear only as negative examples)', async () => {
    for (const g of ['male', 'female'] as const) {
      const p = await promptFor(g)
      expect(p).toContain('NEVER write split-gender forms')
    }
  })
})
