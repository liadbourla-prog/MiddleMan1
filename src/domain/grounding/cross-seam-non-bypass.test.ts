/**
 * CROSS-SEAM NON-BYPASS INVARIANT (T3.2, TEST-ONLY) — the canonical, consolidated proof that
 * NO customer-facing reply reaches `sendMessage` from ANY of the three output doors without
 * first traversing the unified anti-fabrication gate (`gateReply`, plus the Branch-3 action
 * auditor / the proactive `gateProactiveBody`).
 *
 * The three output doors (seams):
 *   1. Branch 4   — `makeGenReply`               (src/domain/flows/customer-booking.ts)
 *   2. Branch 3   — `gateAndAuditBranch3Reply`   (src/adapters/llm/orchestrator.ts, exported)
 *   3. Proactive  — `generateProactiveCustomerMessage` (src/adapters/llm/client.ts)
 *
 * This file does NOT replace the per-seam guards — it consolidates the cross-cutting invariant in
 * one place so a future refactor of any single door fails HERE (a single, obvious signal) even if
 * the per-seam guard in that file is edited away. The per-seam guards remain authoritative for the
 * shape of their own door:
 *   - Branch 4 + makeGenReply non-bypass:  src/domain/flows/voice-golden.test.ts (PART 3)
 *   - gateReply-returns-wrapped guard:     src/domain/flows/voice-observe.test.ts
 *   - makeGenReply delegation (behavioral): src/domain/flows/make-gen-reply-delegation.test.ts
 *   - Branch-3 thrown-gate → safe fallback: tests/adapters/orchestrator-gate.test.ts (F-rev4)
 *
 * Pure: source-introspection via `readFileSync` (mirrors voice-observe / voice-golden) plus one
 * cheap behavioral assertion per gateable seam. No DB, no network, no engine mocks.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  gateAndAuditBranch3Reply,
  SAFE_AUDIT_FALLBACK as B3_SAFE_AUDIT_FALLBACK,
} from '../../adapters/llm/orchestrator.js'
import { buildTurnLedger, type OccupancySpine } from './turn-ledger.js'

// Read each seam's source ONCE. The URLs are relative to this file (src/domain/grounding/).
const BRANCH4_SRC = readFileSync(new URL('../flows/customer-booking.ts', import.meta.url), 'utf8')
const BRANCH3_SRC = readFileSync(new URL('../../adapters/llm/orchestrator.ts', import.meta.url), 'utf8')
const PROACTIVE_SRC = readFileSync(new URL('../../adapters/llm/client.ts', import.meta.url), 'utf8')

/** Slice out a function body from `start` of `signature` up to the next top-level `export ` decl. */
function bodyFrom(src: string, signature: string, nextExport?: string): string {
  const start = src.indexOf(signature)
  expect(start, `signature not found: ${signature}`).toBeGreaterThan(-1)
  if (nextExport) {
    const end = src.indexOf(nextExport, start + signature.length)
    expect(end, `next-export anchor not found: ${nextExport}`).toBeGreaterThan(start)
    return src.slice(start, end)
  }
  return src.slice(start)
}

// ════════════════════════════════════════════════════════════════════════════
// SEAM 1 — Branch 4: makeGenReply (customer-booking.ts)
// Its ONLY reply-producing return is gateReply's result; a thrown pipeline returns the
// gate-owned SAFE_AUDIT_FALLBACK — never the ungated draft, never an inline observeVoiceTells.
// Grounded in customer-booking.ts:756-809 (makeGenReply body).
// ════════════════════════════════════════════════════════════════════════════

describe('Seam 1 — Branch 4 (makeGenReply): every reply traverses gateReply, no bypass path', () => {
  const body = bodyFrom(BRANCH4_SRC, 'export function makeGenReply(', '\nexport function buildBusinessFacts(')

  it('routes its draft through gateReply and returns gateReply\'s result (customer-booking.ts:798/805)', () => {
    expect(body).toMatch(/const result = await gateReply\(/)
    expect(body).toMatch(/return result\.reply/)
  })

  it('on a thrown pipeline returns the gate-owned SAFE_AUDIT_FALLBACK, never the ungated draft (F-rev4, customer-booking.ts:806-807)', () => {
    // The catch sits at the bottom of the try that wraps draft-gen + gateReply.
    expect(body).toMatch(/}\s*catch\s*{\s*return SAFE_AUDIT_FALLBACK\[input\.language\]\s*}/)
  })

  it('has NO inline reply path that bypasses gateReply (no `return reply` / `return observeVoiceTells(`)', () => {
    // `return reply` would hand back the ungated draft; `return observeVoiceTells(` would be an
    // inline Gate-7-only path that skipped the unified gate. Neither may exist in makeGenReply —
    // the Branch-4 voice monitor now lives INSIDE gateReply (see voice-observe.test.ts).
    expect(body).not.toMatch(/return observeVoiceTells\(/)
    expect(body).not.toMatch(/\breturn reply\b/)
    // Exactly three `return`s: (1) `return async (input, opts) => {` — makeGenReply is a FACTORY,
    // this returns the genReply closure, not a reply; (2) `return result.reply` — the gated exit;
    // (3) `return SAFE_AUDIT_FALLBACK[input.language]` — the F-rev4 safe-fallback catch. The only
    // two REPLY returns are both gate-owned. A future edit adding a fourth return flags here for a
    // non-bypass re-review.
    const returns = (body.match(/\breturn\b/g) ?? []).length
    expect(returns).toBe(3)
  })

  // BEHAVIORAL coverage cited (not duplicated): make-gen-reply-delegation.test.ts proves the
  // delegation end-to-end (draft → gateReply → result.reply), and gateReply's own safe-fallback
  // behavior is pinned in output-gate.test.ts. Structural assertions above are this file's job.
})

// ════════════════════════════════════════════════════════════════════════════
// SEAM 2 — Branch 3: orchestrator main loop → gateAndAuditBranch3Reply (orchestrator.ts)
// The model's `textPart` reply exit is fed to gateAndAuditBranch3Reply (gateReply + the L2
// action auditor); the `.catch` on that call returns SAFE_AUDIT_FALLBACK[lang] — never the raw
// textPart. Grounded in orchestrator.ts:1242-1296 (the function) + 1550-1588 (the loop exit).
// ════════════════════════════════════════════════════════════════════════════

describe('Seam 2 — Branch 3 (orchestrator): the textPart reply exit traverses gateAndAuditBranch3Reply, no bypass', () => {
  it('gateAndAuditBranch3Reply internally runs gateReply THEN auditReplyClaims, both fail-safe (orchestrator.ts:1270-1295)', () => {
    const fn = bodyFrom(BRANCH3_SRC, 'export async function gateAndAuditBranch3Reply(', '\n// ── Main loop')
    expect(fn).toMatch(/await gateReply\(/)
    expect(fn).toMatch(/return auditReplyClaims\(/)
    // F-rev4: BOTH stages catch to the safe template, never the ungated `draft`/`gated`.
    // Two `.catch(() => SAFE_AUDIT_FALLBACK[lang])`: one on gateReply, one on auditReplyClaims.
    const catches = (fn.match(/\.catch\(\(\) => SAFE_AUDIT_FALLBACK\[lang\]\)/g) ?? []).length
    expect(catches).toBe(2)
    // The only `return` of model-derived text is auditReplyClaims(...)'s result (which is itself
    // gated). The function never returns the raw `draft`.
    expect(fn).not.toMatch(/\breturn draft\b/)
    expect(fn).not.toMatch(/\breturn gated\b/)
  })

  it('the loop\'s `if (textPart)` exit routes textPart through gateAndAuditBranch3Reply with a fail-safe catch (orchestrator.ts:1550-1588)', () => {
    // Scope to the textPart reply-exit block: from `if (textPart) {` to its `return observeVoiceTells(`.
    const exitStart = BRANCH3_SRC.indexOf('if (textPart) {')
    expect(exitStart).toBeGreaterThan(-1)
    const exitEnd = BRANCH3_SRC.indexOf('return observeVoiceTells(', exitStart)
    expect(exitEnd).toBeGreaterThan(exitStart)
    const block = BRANCH3_SRC.slice(exitStart, exitEnd)

    // The model's textPart is passed as the gate's `draft` — it is NOT returned raw.
    expect(block).toMatch(/await gateAndAuditBranch3Reply\(/)
    expect(block).toMatch(/draft: textPart,/)
    // F-rev4 outer backstop: a thrown gate/auditor cannot leak the ungated textPart.
    expect(block).toMatch(/\.catch\(\(\) => SAFE_AUDIT_FALLBACK\[lang\]\)/)
    // No path in this block hands `textPart` straight to a return / observeVoiceTells.
    expect(block).not.toMatch(/return\s+textPart\b/)
    expect(block).not.toMatch(/observeVoiceTells\(\s*textPart\b/)
  })

  it('BEHAVIORAL — a thrown gate (occupancy spine rejects) returns SAFE_AUDIT_FALLBACK, not the ungated draft (cross-seam F-rev4 variant)', async () => {
    // A focused cross-seam variant of the F-rev4 test in tests/adapters/orchestrator-gate.test.ts:
    // different draft + lang (HE) so it is NOT a verbatim duplicate. A blanket no-availability
    // assertion on a single resolved focus day forces the occupancy spine read, which throws here.
    const throwingSpine: OccupancySpine = async () => { throw new Error('spine read blew up') }
    const ledger = buildTurnLedger({
      businessFacts: '', actionLedger: '',
      baseAllowedTimes: { boundaryTimes: [], bookingTimes: [] },
      occupancySpine: throwingSpine, backedActions: [], calendarConnected: false, businessId: 'biz-x',
    })
    const draft = 'יום ראשון תפוס לגמרי, אין מקום בכלל.' // "Sunday is completely full" → spine re-check throws
    const out = await gateAndAuditBranch3Reply({
      draft,
      ledger,
      lang: 'he',
      focusDay: { dateStr: '2026-07-05' },
      bookingConfirmed: false,
      succeededActions: new Set<never>(),
      calendarConnected: false,
      contents: [],
      systemPrompt: 'sys',
      businessId: 'biz-x',
      actorId: 'u1',
    })
    expect(out).toBe(B3_SAFE_AUDIT_FALLBACK.he)
    expect(out).not.toBe(draft)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// SEAM 3 — Proactive: generateProactiveCustomerMessage (client.ts)
// Every LLM-generated body is produced by the internal `gate(...)` wrapper (gateProactiveBody);
// the only un-gated returns are the already-safe template `input.fallback`.
// Grounded in client.ts:1329-1369 (generateProactiveCustomerMessage body).
// ════════════════════════════════════════════════════════════════════════════

describe('Seam 3 — Proactive (generateProactiveCustomerMessage): every LLM body is gated, no un-gated body return', () => {
  const body = bodyFrom(
    PROACTIVE_SRC,
    'export async function generateProactiveCustomerMessage(',
    '\n// ── Provider onboarding reply generator',
  )

  it('wraps the LLM body in gate(...) / gateProactiveBody before returning it (client.ts:1346/1362)', () => {
    // The internal wrapper IS gateProactiveBody.
    expect(body).toMatch(/const gate = \(body: string\): string => gateProactiveBody\(/)
    // The LLM-generated `text` is only ever returned via gate(text); a falsy text → the safe template.
    expect(body).toMatch(/return text \? gate\(text\) : input\.fallback/)
  })

  it('has NO un-gated `return body`/`return text` path — the only non-gated returns are the safe template fallback', () => {
    // A bypass leak would be `return text` / `return body` NOT wrapped in gate(...) — i.e. the
    // ungated LLM body handed straight back. The legitimate path is the gated ternary
    // `return text ? gate(text) : input.fallback`, so we match a bare `return text`/`return body`
    // followed by a statement terminator (`;` / newline) rather than the ` ? gate(` ternary.
    expect(body).not.toMatch(/\breturn body\s*[;\n]/)
    expect(body).not.toMatch(/\breturn text\s*[;\n]/)
    // The one `return text` that exists is the gated ternary — assert it stays gated.
    expect(body).toMatch(/return text \? gate\(text\)/)
    // Every other return in the body is `input.fallback` (the catch + the timeout wrapper's safe
    // value) or the gate(text) success path above — both safe. The full return inventory:
    //   1. return text ? gate(text) : input.fallback   (LLM body → gated, else template)
    //   2. return input.fallback                        (catch — already-safe template)
    //   3. return input.timeoutMs ? withTimeout(...) : call  (outer; timeout value is input.fallback)
    const returns = (body.match(/\breturn\b/g) ?? []).length
    expect(returns).toBe(3)
    // Both un-gated returns route to the safe template `input.fallback`.
    expect(body).toMatch(/}\s*catch\s*{\s*return input\.fallback\s*}/)
    expect(body).toMatch(/return input\.timeoutMs \? withTimeout\(call, input\.timeoutMs, input\.fallback\) : call/)
  })
})
