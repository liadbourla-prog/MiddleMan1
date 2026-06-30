// DO-NOT-REGRESS — Addressee-gender NON-BYPASS invariant (plan §5).
//
// "Every customer/owner-facing addressing prompt is built through buildVoiceCore(channel,
// addresseeGender) — no addressing reply path constructs the masculine (or feminine) line by
// hand." The whole gender feature hinges on a single chokepoint: if any flow hand-rolls the
// Hebrew ADDRESSING instruction, it silently re-pins masculine and the resolved gender never
// reaches that reply. This grep-style sweep over the source tree fails the build the moment the
// addressing line is authored anywhere outside voice.ts.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_ROOT = fileURLToPath(new URL('../../src', import.meta.url))

// The literal source fragments that ONLY the canonical addressing line (voice.ts) may contain.
// (The "זכר"/"נקבה" gender tokens are interpolated into "פנייה בלשון ${he}", so the word "בלשון"
// — the Hebrew "in the … form" marker — is the literal substring to guard, not the joined phrase.)
const ADDRESSING_FRAGMENTS = ['ADDRESSING (Hebrew', 'בלשון']

// The single source file allowed to author the addressing instruction.
const CANONICAL = join('adapters', 'llm', 'voice.ts')

function walkTs(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walkTs(full, acc)
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) acc.push(full)
  }
  return acc
}

describe('DO-NOT-REGRESS: addressee-gender chokepoint is never bypassed', () => {
  const files = walkTs(SRC_ROOT)

  it('the Hebrew ADDRESSING instruction is authored ONLY in adapters/llm/voice.ts', () => {
    const offenders: Array<{ file: string; fragment: string }> = []
    for (const file of files) {
      if (file.endsWith(CANONICAL)) continue
      const text = readFileSync(file, 'utf8')
      for (const frag of ADDRESSING_FRAGMENTS) {
        if (text.includes(frag)) offenders.push({ file: file.slice(SRC_ROOT.length + 1), fragment: frag })
      }
    }
    expect(offenders, 'an addressing line was hand-built outside buildVoiceCore (voice.ts)').toEqual([])
  })

  it('voice.ts really does still author the addressing line (guards against a stale grep)', () => {
    const voice = readFileSync(join(SRC_ROOT, CANONICAL), 'utf8')
    for (const frag of ADDRESSING_FRAGMENTS) expect(voice, frag).toContain(frag)
  })
})
