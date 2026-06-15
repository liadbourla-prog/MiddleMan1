import { describe, it, expect } from 'vitest'
import { i18n } from '../../src/domain/i18n/t.js'

const countQ = (s: string) => (s.match(/\?/g) ?? []).length

describe('ob_import — no broken menu', () => {
  it('Hebrew prompt does not instruct an unsupported "דלג" keyword', () => {
    expect(i18n.ob_import.he).not.toContain('דלג')
  })
  it('English prompt does not instruct a "Skip" keyword', () => {
    expect(i18n.ob_import.en).not.toContain('Skip')
  })
  it('asks a single question', () => {
    expect(countQ(i18n.ob_import.he)).toBe(1)
    expect(countQ(i18n.ob_import.en)).toBe(1)
  })
})

describe('ob_escalation — one question only (§2.2)', () => {
  it('asks exactly one question in each language', () => {
    expect(countQ(i18n.ob_escalation.he)).toBe(1)
    expect(countQ(i18n.ob_escalation.en)).toBe(1)
  })

  it('the retry variant does not re-introduce the dropped second ask', () => {
    expect(i18n.ob_escalation_retry.he).not.toContain('ומה לומר')
    expect(i18n.ob_escalation_retry.en).not.toContain('what to say')
  })
})
