import { describe, it, expect } from 'vitest'
import { buildOnboardingSystemPrompt } from '../../src/adapters/llm/client.js'

const base = { step: 'hours', businessName: 'סטודיוגה', lang: 'he' as const, isRetry: false }

describe('buildOnboardingSystemPrompt — transcript injection', () => {
  it('includes the recent turns and an anti-repeat instruction when transcript is present', () => {
    const prompt = buildOnboardingSystemPrompt({
      ...base,
      transcript: [
        { role: 'assistant', text: 'מעולה, הוספתי את השירותים. מתי פתוח?' },
        { role: 'customer', text: 'ראשון עד חמישי 9 עד 18' },
      ],
    })
    expect(prompt).toContain('ראשון עד חמישי 9 עד 18')
    expect(prompt).toContain('do NOT reopen with a word you already used')
  })
  it('omits the recent-conversation block when no transcript is given', () => {
    const prompt = buildOnboardingSystemPrompt(base)
    expect(prompt).not.toContain('Recent conversation so far')
  })
})
