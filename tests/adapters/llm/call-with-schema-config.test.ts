import { describe, it, expect, vi, beforeEach } from 'vitest'

// Capture every config passed to generateContent so we can assert the classifier
// path is immune to gemini-2.5-flash thinking-token starvation (Workstream 0).
const calls: Array<{ model: string; config: Record<string, unknown> }> = []

vi.mock('@google/genai', () => {
  class GoogleGenAI {
    models = {
      generateContent: async (req: { model: string; config: Record<string, unknown> }) => {
        calls.push({ model: req.model, config: req.config })
        return {
          text: JSON.stringify({
            instructionType: 'provider_change',
            structuredParams: { action: 'add', instructorName: 'דן' },
            ambiguous: false,
            clarificationNeeded: null,
          }),
        }
      },
    }
  }
  return { GoogleGenAI, Type: {} }
})

describe('callWithSchema generation config (WS0: no thinking-token starvation)', () => {
  beforeEach(() => { calls.length = 0 })

  it('classifyManagerInstruction disables thinking and reserves output headroom', async () => {
    const { classifyManagerInstruction } = await import('../../../src/adapters/llm/client.js')
    const r = await classifyManagerInstruction('הוסף את דן כמדריך', { businessId: 'x', timezone: 'Asia/Jerusalem' }, 'he')

    expect(r.ok).toBe(true)
    expect(calls.length).toBeGreaterThan(0)
    const cfg = calls[0]!.config as { thinkingConfig?: { thinkingBudget?: number }; maxOutputTokens?: number }
    // Thinking must be explicitly disabled on the classifier path (valid on Flash).
    expect(cfg.thinkingConfig?.thinkingBudget).toBe(0)
    // And the output budget must have real headroom for larger classifier JSON.
    expect(cfg.maxOutputTokens ?? 0).toBeGreaterThanOrEqual(2048)
  })
})
