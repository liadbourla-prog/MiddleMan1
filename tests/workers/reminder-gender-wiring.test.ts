import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// T1.6 — the reminder worker is the canonical free-form proactive send. It must read the
// recipient's addresseeGender and pass it into the FREE-FORM generator (so the LLM body is
// gender-correct), while the Meta TEMPLATE path stays neutral (decision 4) — no gender variable
// is fed into the templated send. Driving the full worker needs heavy stubbing, so we assert the
// wiring at the source level (same approach as the orchestrator non-bypass guard).
const src = readFileSync(fileURLToPath(new URL('../../src/workers/reminder.ts', import.meta.url)), 'utf8')

describe('reminder worker wires addressee gender into free-form sends only', () => {
  it('loads the recipient addresseeGender from identities', () => {
    expect(src).toMatch(/addresseeGender:\s*identities\.addresseeGender/)
  })

  it('passes addresseeGender into the free-form generateProactiveCustomerMessage call', () => {
    // The free-form send carries the resolved gender.
    expect(src).toMatch(/generateProactiveCustomerMessage\([^)]*addresseeGender/s)
  })

  it('does NOT thread gender into the Meta template send (decision 4 — templates neutral)', () => {
    // Isolate the sendTemplateMessage(...) call and assert it carries no addresseeGender.
    const tStart = src.indexOf('sendTemplateMessage({')
    expect(tStart).toBeGreaterThan(-1)
    const tEnd = src.indexOf('})', tStart)
    const templateCall = src.slice(tStart, tEnd)
    expect(templateCall).not.toMatch(/addresseeGender/)
  })
})
