import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Source-introspection guard (mirrors flows/voice-observe.test.ts +
// special-arrangement-escalation.test.ts): the Branch-3 manager orchestrator reply is the
// final string returned from runManagerOrchestratorLoop. Every reply-string return point
// must be wrapped in observeVoiceTells so a future edit can't silently bypass the
// deterministic Gate 7 (non-bypass invariant). Driving the full Gemini tool loop isn't
// unit-testable, so we assert the wiring at the source level; observeVoiceTells's own
// behavior is covered by src/domain/flows/voice-observe.test.ts.
describe('non-bypass invariant — runManagerOrchestratorLoop returns are wrapped in observeVoiceTells', () => {
  it('every reply return point in runManagerOrchestratorLoop routes through observeVoiceTells', () => {
    const srcPath = fileURLToPath(new URL('../../src/adapters/llm/orchestrator.ts', import.meta.url))
    const src = readFileSync(srcPath, 'utf8')

    // The orchestrator must import the Gate 7 observer.
    expect(src).toMatch(/import\s*\{[^}]*\bobserveVoiceTells\b[^}]*\}\s*from\s*['"][^'"]*voice-guard\.js['"]/)

    // Isolate the runManagerOrchestratorLoop body — it is the last function in the file.
    const fnStart = src.indexOf('export async function runManagerOrchestratorLoop(')
    expect(fnStart).toBeGreaterThan(-1)
    const body = src.slice(fnStart)

    // Every reply-EXIT return must hand its value to observeVoiceTells. A reply exit
    // returns either the `fallback` string or the audited `finalReply`; the only other
    // `return` in the function is a data-builder inside a `.map(...)` callback that emits
    // a template literal (`return \`[…`), which is NOT a reply exit. Count reply exits by
    // matching the reply-bearing returns rather than every `return ` token.
    const replyExitReturns = (body.match(/\breturn\s+(?:observeVoiceTells\(|fallback\b|finalReply\b)/g) ?? []).length
    const observed = (body.match(/return observeVoiceTells\(/g) ?? []).length
    // The loop has: the normal final reply, the LLM-error fallback, and the
    // loop-exhaustion fallback — three reply exits at minimum.
    expect(replyExitReturns).toBeGreaterThanOrEqual(3)
    expect(observed).toBe(replyExitReturns)

    // No bare reply exit may remain (the non-bypass guard for Branch-3).
    expect(body).not.toMatch(/\breturn\s+fallback\b(?!\s*,)/)
    expect(body).not.toMatch(/\breturn\s+finalReply\b(?!\s*,)/)

    // The two deliberately-terse fallbacks are safe-fallback-exempt so the monitor
    // log isn't flooded by their (intentional) dead_end shape.
    const safeFallbackWraps = (body.match(/isSafeFallback:\s*true/g) ?? []).length
    expect(safeFallbackWraps).toBeGreaterThanOrEqual(2)
  })
})
