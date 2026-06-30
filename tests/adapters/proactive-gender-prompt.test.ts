import { describe, it, expect, beforeEach, vi } from 'vitest'

// T1.6 (prompt half) — generateProactiveCustomerMessage threads addresseeGender into the
// proactive voice core: a free-form send to a known-female customer is feminine; unknown →
// masculine floor (byte-identical). Meta TEMPLATE bodies stay neutral (decision 4) and never
// pass through here — they are sent verbatim, not generated.
const calls: Array<{ config: { systemInstruction?: string } }> = []

vi.mock('@google/genai', () => {
  class GoogleGenAI {
    models = {
      generateContent: async (req: { config: { systemInstruction?: string } }) => {
        calls.push({ config: req.config })
        return { text: 'תזכורת קצרה' }
      },
    }
  }
  return { GoogleGenAI, Type: {} }
})

import { generateProactiveCustomerMessage } from '../../src/adapters/llm/client.js'

async function promptFor(addresseeGender: 'male' | 'female' | null | undefined): Promise<string> {
  calls.length = 0
  await generateProactiveCustomerMessage({
    businessName: 'הסטודיו', language: 'he', situation: 'Send a friendly reminder.', fallback: 'תזכורת',
    ...(addresseeGender === undefined ? {} : { addresseeGender }),
  })
  return calls.at(-1)?.config.systemInstruction ?? ''
}

describe('generateProactiveCustomerMessage threads addressee gender', () => {
  beforeEach(() => { calls.length = 0 })

  it('female → feminine addressing line, no masculine', async () => {
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
