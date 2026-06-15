import { describe, it, expect } from 'vitest'
import { buildVoiceCore, BOT_TELLS } from '../../src/adapters/llm/voice.js'

describe('voice core — Hebrew addressing rule reaches every channel', () => {
  for (const channel of ['customer', 'manager', 'onboarding', 'operator', 'proactive'] as const) {
    it(`buildVoiceCore('${channel}') states masculine-default + anti-split addressing`, () => {
      const core = buildVoiceCore(channel)
      expect(core).toContain('בלשון זכר')   // masculine second-person rule present
      expect(core).toContain('תגיד/י')      // names the split form it forbids
    })
  }
})

describe('bot-tell blacklist', () => {
  it('flags the split-gender form seen live in onboarding', () => {
    expect(BOT_TELLS.he).toContain('תגיד/י')
  })
})
