/**
 * Unit tests for chooseAppSecret (T4.6 — ID5 app-secret empty-string guard).
 *
 * chooseAppSecret is a pure helper that decides which app secret to use for
 * WhatsApp signature verification. The critical invariant: an empty/whitespace
 * stored secret must be treated as ABSENT (fall back to global) so that a
 * misconfigured business row never causes a silent signature-verification drop.
 *
 * RED→GREEN: these tests were written before the helper was exported.
 */
import { describe, it, expect } from 'vitest'
import { chooseAppSecret } from './webhook.js'

describe('chooseAppSecret (ID5 empty-secret guard)', () => {
  const GLOBAL = 'global-secret-abc123'
  const BIZ_SECRET = 'biz-secret-def456'

  // ── Normal cases ──────────────────────────────────────────────────────────

  it('returns the business secret when it is non-empty', () => {
    const result = chooseAppSecret(BIZ_SECRET, GLOBAL)
    expect(result.secret).toBe(BIZ_SECRET)
    expect(result.emptyStored).toBe(false)
  })

  it('trims surrounding whitespace and returns the trimmed business secret', () => {
    const result = chooseAppSecret('  ' + BIZ_SECRET + '  ', GLOBAL)
    expect(result.secret).toBe(BIZ_SECRET)
    expect(result.emptyStored).toBe(false)
  })

  it('falls back to global when stored secret is null', () => {
    const result = chooseAppSecret(null, GLOBAL)
    expect(result.secret).toBe(GLOBAL)
    expect(result.emptyStored).toBe(false)
  })

  it('falls back to global when stored secret is undefined', () => {
    const result = chooseAppSecret(undefined, GLOBAL)
    expect(result.secret).toBe(GLOBAL)
    expect(result.emptyStored).toBe(false)
  })

  // ── ID5 bug cases — empty/whitespace must NOT silently return '' ──────────

  it('empty-string stored secret → falls back to global, emptyStored=true', () => {
    const result = chooseAppSecret('', GLOBAL)
    expect(result.secret).toBe(GLOBAL)
    expect(result.emptyStored).toBe(true)
  })

  it('whitespace-only stored secret → falls back to global, emptyStored=true', () => {
    const result = chooseAppSecret('   ', GLOBAL)
    expect(result.secret).toBe(GLOBAL)
    expect(result.emptyStored).toBe(true)
  })

  it('tab-only stored secret → falls back to global, emptyStored=true', () => {
    const result = chooseAppSecret('\t\n', GLOBAL)
    expect(result.secret).toBe(GLOBAL)
    expect(result.emptyStored).toBe(true)
  })

  // ── Edge: no global secret either ────────────────────────────────────────

  it('no global and no stored → secret is undefined', () => {
    const result = chooseAppSecret(null, undefined)
    expect(result.secret).toBeUndefined()
    expect(result.emptyStored).toBe(false)
  })

  it('no global and empty stored → secret is undefined, emptyStored=true', () => {
    const result = chooseAppSecret('', undefined)
    expect(result.secret).toBeUndefined()
    expect(result.emptyStored).toBe(true)
  })
})
