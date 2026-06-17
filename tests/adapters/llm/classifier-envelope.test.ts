import { describe, it, expect, vi } from 'vitest'

// Regression: gemini-2.5-flash sometimes emits the top-level envelope in snake_case
// (instruction_type) instead of the camelCase the schema requires. Before the WS0
// envelope fix this validated to ok:false → "Classification failed" → EVERY Branch-3
// config write silently broke. The defensive normalization in managerInstructionSchema
// must map snake_case aliases so classification still succeeds.
vi.mock('@google/genai', () => {
  class GoogleGenAI {
    models = {
      generateContent: async () => ({
        // Deliberately snake_case + omitted clarificationNeeded — the exact shape
        // 2.5-flash returned in production after thinking was disabled.
        text: JSON.stringify({
          instruction_type: 'provider_change',
          structured_params: { action: 'add', instructorName: 'דן' },
          ambiguous: false,
        }),
      }),
    }
  }
  return { GoogleGenAI, Type: {} }
})

describe('classifyManagerInstruction envelope normalization (WS0)', () => {
  it('accepts snake_case top-level keys and normalizes to the camelCase contract', async () => {
    const { classifyManagerInstruction } = await import('../../../src/adapters/llm/client.js')
    const r = await classifyManagerInstruction('הוסף את דן כמדריך', { businessId: 'x', timezone: 'Asia/Jerusalem' }, 'he')

    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.instructionType).toBe('provider_change')
    expect(r.data.clarificationNeeded).toBeNull() // omitted → defaulted, not a validation failure
    expect((r.data.structuredParams as { instructorName?: string }).instructorName).toBe('דן')
  })
})
