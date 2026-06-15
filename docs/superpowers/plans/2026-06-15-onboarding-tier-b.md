# Tier-B: Plug Branch-3 Chat Abilities Into Onboarding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect Branch-3 onboarding to the chat machinery the live manager path already uses — transcript continuity (so it stops repeating "מעולה"/identical openers) and the §3.4 language switch — by reusing existing helpers, not rebuilding them.

**Architecture:** Extract Branch-3's language-switch resolution into one shared pure helper that both the live manager path and the onboarding gate call. Wrap the onboarding gate (`webhook.ts` `routeManagerMessage`) with the existing session + transcript functions (`loadActiveSession`/`createSession`/`saveMessage`/`loadTranscript`). Thread the resolved language + transcript into `handleOnboardingMessage` → `generateOnboardingReply`, which injects the transcript so the already-present §11 anti-formula rule has context to honor. No DB migration (reuses `conversation_sessions`/`conversation_messages`).

**Tech Stack:** TypeScript, Fastify, Drizzle, Zod, Gemini (Vertex AI), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-15-onboarding-tier-b-design.md`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/domain/flows/language-switch.ts` | Shared pure language resolution + signal guard | **Create** |
| `src/routes/webhook.ts` | Branch routing | Refactor live manager path to call the shared resolver; rewrite the onboarding gate to plug in session+transcript+language |
| `src/adapters/llm/client.ts` | LLM adapter | `generateOnboardingReply` accepts `transcript`; extract exported `buildOnboardingSystemPrompt` that injects it |
| `src/domain/flows/manager-onboarding.ts` | Onboarding step machine | `handleOnboardingMessage` + helpers + step handlers accept `lang` + `transcript` |
| `tests/flows/language-switch.test.ts` | NEW — resolver + guard unit tests | Create |
| `tests/adapters/onboarding-prompt.test.ts` | NEW — transcript injection unit test | Create |
| `tests/flows/onboarding-transcript-wiring.test.ts` | NEW — handler forwards transcript to generator | Create |

Test glob: `tests/**/*.test.ts`.

---

### Task 1: Shared language-switch resolver + signal guard

**Files:**
- Create: `src/domain/flows/language-switch.ts`
- Test: `tests/flows/language-switch.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/flows/language-switch.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { hasLanguageSignal, resolveTurnLanguage } from '../../src/domain/flows/language-switch.js'

describe('hasLanguageSignal — low-signal tokens must not flip language', () => {
  it('returns false for tokens onboarding constantly sees', () => {
    for (const t of ['24/7', 'GO', 'ok', 'Bit', 'PayPal', '', '03-1234567', '21:00', '9:00-18:00']) {
      expect(hasLanguageSignal(t)).toBe(false)
    }
  })
  it('returns true for Hebrew and real multi-word English', () => {
    expect(hasLanguageSignal('שלום')).toBe(true)
    expect(hasLanguageSignal('I want to set my hours')).toBe(true)
    expect(hasLanguageSignal('credit card')).toBe(true)
  })
})

describe('resolveTurnLanguage', () => {
  const he = 'he' as const
  it('keeps the default on a no-signal token — no flip, no offer', () => {
    const r = resolveTurnLanguage({ body: '24/7', defaultLang: he, preferredLanguage: null, sessionOverride: undefined })
    expect(r.turnLang).toBe('he')
    expect(r.shouldOfferSwitch).toBe(false)
  })
  it('flips and offers on a real other-language sentence', () => {
    const r = resolveTurnLanguage({ body: 'I want to set my hours', defaultLang: he, preferredLanguage: null, sessionOverride: undefined })
    expect(r.turnLang).toBe('en')
    expect(r.detected).toBe('en')
    expect(r.shouldOfferSwitch).toBe(true)
  })
  it('a locked preferredLanguage wins and suppresses the offer', () => {
    const r = resolveTurnLanguage({ body: 'I want to set my hours', defaultLang: he, preferredLanguage: he, sessionOverride: undefined })
    expect(r.turnLang).toBe('he')
    expect(r.shouldOfferSwitch).toBe(false)
  })
  it('a session override wins when no preference is set', () => {
    const r = resolveTurnLanguage({ body: 'I want to set my hours', defaultLang: he, preferredLanguage: null, sessionOverride: he })
    expect(r.turnLang).toBe('he')
    expect(r.shouldOfferSwitch).toBe(false)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/flows/language-switch.test.ts`
Expected: FAIL — module `src/domain/flows/language-switch.ts` does not exist.

- [ ] **Step 3: Create the helper**

Create `src/domain/flows/language-switch.ts`:

```ts
import { detectLang, type Lang } from '../i18n/t.js'

// True only when the text carries a real language signal. Stops low-signal tokens
// onboarding constantly sees — "24/7", "Bit", "GO", times, phone numbers, bare
// digits — from wrongly flipping the conversation language. A Hebrew letter is
// always a signal; otherwise we require at least two Latin word-tokens of >=2
// letters, so single brand/keyword tokens (PayPal, Bit, GO) never trigger a switch.
export function hasLanguageSignal(text: string): boolean {
  if (/[֐-׿]/.test(text)) return true
  const latinWords = text.match(/[A-Za-z]{2,}/g)
  return (latinWords?.length ?? 0) >= 2
}

// Branch-3 §3.4 language resolution, extracted so the live manager path and the
// onboarding gate run the identical decision. Pure — no I/O.
// - effectiveOverride: a locked identity preference or session-level override wins.
// - no language signal ⇒ do not flip (treat the turn as the resolved language).
// - offer a switch only when an unlocked turn's detected language differs from default.
export function resolveTurnLanguage(input: {
  body: string
  defaultLang: Lang
  preferredLanguage: Lang | null
  sessionOverride: Lang | undefined
}): { turnLang: Lang; detected: Lang; shouldOfferSwitch: boolean } {
  const effectiveOverride: Lang | undefined = input.preferredLanguage ?? input.sessionOverride
  const detected: Lang = hasLanguageSignal(input.body)
    ? detectLang(input.body)
    : (effectiveOverride ?? input.defaultLang)
  const turnLang: Lang = effectiveOverride ?? detected
  const shouldOfferSwitch = !effectiveOverride && detected !== input.defaultLang
  return { turnLang, detected, shouldOfferSwitch }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/flows/language-switch.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/domain/flows/language-switch.ts tests/flows/language-switch.test.ts
git commit -m "feat(flows): shared resolveTurnLanguage + hasLanguageSignal guard"
```

---

### Task 2: Refactor the live manager path to use the shared resolver (behavior-preserving)

**Files:**
- Modify: `src/routes/webhook.ts:715-719` + import

The existing `tests/flows/manager-language-switch.test.ts` is the regression guard — its cases all carry language signal, so the guard does not change their outcome.

- [ ] **Step 1: Add the import**

In `src/routes/webhook.ts`, find the import of `parseConfirmation` (line 24: `import { parseConfirmation, type ManagerFlowContext } from '../domain/flows/types.js'`). Immediately after it add:

```ts
import { resolveTurnLanguage } from '../domain/flows/language-switch.js'
```

- [ ] **Step 2: Replace the inline resolution block**

In `routeManagerMessage`, replace these lines (currently 715-719):

```ts
  const effectiveOverride: Lang | undefined = identity.preferredLanguage ?? sessionOverride
  const detected = detectLang(msg.body)
  const turnLang: Lang = effectiveOverride ?? detected
  // Offer a switch when this turn's language differs from the default and nothing is locked.
  const shouldOfferSwitch = !effectiveOverride && detected !== defaultLang
```

with:

```ts
  const { turnLang, detected, shouldOfferSwitch } = resolveTurnLanguage({
    body: msg.body,
    defaultLang,
    preferredLanguage: identity.preferredLanguage,
    sessionOverride,
  })
```

- [ ] **Step 3: Fix any now-unused import**

Run: `npx tsc --noEmit`
If it reports `detectLang` (or `Lang`) as unused in `webhook.ts`, check for other uses first: `grep -n "detectLang\|: Lang" src/routes/webhook.ts`. `detectLang`/`Lang` are also used by the customer (Branch 4) path and elsewhere in this file, so they should remain used — only remove an import if tsc actually flags it unused. Re-run `npx tsc --noEmit` until clean.

- [ ] **Step 4: Verify the live-path behavior is unchanged**

Run: `npx vitest run tests/flows/manager-language-switch.test.ts`
Expected: PASS (proves the extraction preserved behavior).
Run: `npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/routes/webhook.ts
git commit -m "refactor(webhook): live manager path uses shared resolveTurnLanguage"
```

---

### Task 3: `generateOnboardingReply` injects the transcript (anti-repetition)

**Files:**
- Modify: `src/adapters/llm/client.ts` — extract exported `buildOnboardingSystemPrompt`, add `transcript` to `generateOnboardingReply`
- Test: `tests/adapters/onboarding-prompt.test.ts`

`buildOnboardingSystemPrompt` is exported and unit-tested directly (the same way `buildDateFactsBlock` already is in this file), so the prompt is verified without an LLM call.

- [ ] **Step 1: Write the failing test**

Create `tests/adapters/onboarding-prompt.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/adapters/onboarding-prompt.test.ts`
Expected: FAIL — `buildOnboardingSystemPrompt` is not exported.

If instead the run errors on *importing* `client.js` (LLM init throwing without creds), STOP and report NEEDS_CONTEXT — we will move the builder to its own module. (This is not expected: `buildDateFactsBlock` is already exported from this file and unit-tested.)

- [ ] **Step 3: Add the `TranscriptTurn` import**

In `src/adapters/llm/client.ts`, find the existing import from `'./types.js'` (it imports types like `GenerateReplyInput`). Add `TranscriptTurn` to it. If there is no import from `'./types.js'`, add:

```ts
import type { TranscriptTurn } from './types.js'
```

(`TranscriptTurn` is exported from `src/adapters/llm/types.js` — `messages/repository.ts` imports it from there.)

- [ ] **Step 4: Extract and export `buildOnboardingSystemPrompt`**

In `src/adapters/llm/client.ts`, locate `generateOnboardingReply` (around line 525). It currently builds `stepGoal`, `ackLine`, `retryNote`, then an inline `const systemPrompt = ...`. Replace the inline prompt construction by extracting an exported pure builder defined immediately ABOVE `generateOnboardingReply`:

```ts
export function buildOnboardingSystemPrompt(input: {
  step: string
  businessName: string
  lang: 'he' | 'en'
  isRetry: boolean
  justConfirmed?: string
  collectedSummary?: string
  extraContext?: string
  transcript?: TranscriptTurn[]
}): string {
  const stepGoal = STEP_GOALS[input.step]?.[input.lang] ?? STEP_GOALS[input.step]?.en ?? 'Ask for the next required piece of information.'

  const ackLine = input.justConfirmed
    ? (input.lang === 'he'
      ? `התשובה האחרונה שלהם: "${input.justConfirmed}". התחל בהתייחסות קצרה וטבעית לתשובה הזו, ואז שאל את השאלה הבאה.`
      : `Their last answer: "${input.justConfirmed}". Open with a brief natural acknowledgement of that, then ask the next question.`)
    : ''

  const retryNote = input.isRetry
    ? (input.lang === 'he'
      ? 'זהו ניסיון חוזר — הם לא ענו בצורה ברורה. נסח מחדש בסבלנות, מעט שונה.'
      : "This is a retry — they didn't answer clearly. Rephrase patiently, slightly different wording.")
    : ''

  const recentBlock = input.transcript && input.transcript.length > 0
    ? `\nRecent conversation so far (oldest first) — continue it naturally and do NOT reopen with a word you already used this session (if you already opened with "מעולה"/"Great", pick a different opener or none). Vary your phrasing and shape:\n${input.transcript.map((t) => `${t.role === 'customer' ? 'Owner' : 'You'}: ${t.text}`).join('\n')}\n`
    : ''

  return `You are helping "${input.businessName}" set up their WhatsApp PA, texting them as the service.

${buildVoiceCore('onboarding')}

Language: Write ENTIRELY in ${input.lang === 'he' ? 'Hebrew' : 'English'}.
Rules:
- No bullet points. No numbered lists. No markdown.
${ackLine}
${retryNote}
${input.collectedSummary ? `Already configured: ${input.collectedSummary}` : ''}
${input.extraContext ? `Context: ${input.extraContext}` : ''}
${recentBlock}
${middlemanExplainBlock(input.lang, 'brief')}

Current step task: ${stepGoal}

Output: the message text ONLY. No quotes, no labels, no preamble.`
}
```

Then change `generateOnboardingReply`'s input type to add `transcript?: TranscriptTurn[]` and replace its inline prompt construction so its body becomes:

```ts
export async function generateOnboardingReply(input: {
  step: string
  businessName: string
  collectedSummary?: string
  justConfirmed?: string
  isRetry: boolean
  lang: 'he' | 'en'
  extraContext?: string
  transcript?: TranscriptTurn[]
}): Promise<string> {
  const systemPrompt = buildOnboardingSystemPrompt(input)

  try {
    const result = await generateConversational({
      contents: 'Generate the next onboarding message.',
      config: { systemInstruction: systemPrompt, maxOutputTokens: 1024, temperature: 0.45 },
    })
    const text = result.text?.trim()
    if (text) return text
  } catch {
    // fall through — caller uses template fallback
  }
  return ''
}
```

(Verify `STEP_GOALS`, `buildVoiceCore`, `middlemanExplainBlock`, `generateConversational` are all already in scope in `client.ts` — they are; `buildOnboardingSystemPrompt` just relocates the existing inline string.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/adapters/onboarding-prompt.test.ts && npx tsc --noEmit`
Expected: tests PASS, tsc clean.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all green (existing onboarding tests still pass — the prompt is unchanged when no transcript is passed).

- [ ] **Step 7: Commit**

```bash
git add src/adapters/llm/client.ts tests/adapters/onboarding-prompt.test.ts
git commit -m "feat(onboarding): generateOnboardingReply injects transcript to vary replies"
```

---

### Task 4: Thread `lang` + `transcript` through the onboarding handlers

**Files:**
- Modify: `src/domain/flows/manager-onboarding.ts`
- Test: `tests/flows/onboarding-transcript-wiring.test.ts`

Goal: `handleOnboardingMessage` accepts the resolved `lang` and a `transcript`, and forwards the transcript to every `generateOnboardingReply` (via `onboardingQuestion`, `notAnswerReply`, and direct calls) so replies vary. All new params default so non-webhook callers (`oauth.ts`, `import.ts`) are unaffected.

- [ ] **Step 1: Write the failing wiring test**

Create `tests/flows/onboarding-transcript-wiring.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Proves handleOnboardingMessage forwards the session transcript down to
// generateOnboardingReply, so the anti-repetition context actually reaches the LLM.
const generateOnboardingReply = vi.fn(async () => 'next question')
const parseBusinessName = vi.fn(async () => ({ ok: true, data: { isBusinessName: true, name: 'סטודיוגה' } }))

vi.mock('../../src/adapters/llm/client.js', () => ({
  generateOnboardingReply: (...a: unknown[]) => generateOnboardingReply(...a),
  parseBusinessName: (...a: unknown[]) => parseBusinessName(...a),
  // Unused on the business_name path but imported by the module under test:
  classifyManagerInstruction: vi.fn(),
  generateManagerCommandReply: vi.fn(),
  parseOnboardingServices: vi.fn(),
  parseOnboardingHours: vi.fn(),
  parseOnboardingAnswer: vi.fn(),
  parseCalendarChoice: vi.fn(),
  parseImportChoice: vi.fn(),
}))

import { handleOnboardingMessage } from '../../src/domain/flows/manager-onboarding.js'
import type { InboundMessage } from '../../src/adapters/whatsapp/types.js'
import type { ResolvedIdentity } from '../../src/domain/identity/types.js'
import type { Business } from '../../src/db/schema.js'
import type { TranscriptTurn } from '../../src/adapters/llm/types.js'

function fakeDb() {
  const chain: Record<string, unknown> = { then: (r: (v: unknown[]) => void) => r([]) }
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit']) chain[m] = () => chain
  return {
    select: () => chain,
    update: () => ({ set: () => ({ where: async () => {} }) }),
    insert: () => ({ values: () => ({ returning: async () => [{ id: 'x' }] }) }),
  } as unknown as Parameters<typeof handleOnboardingMessage>[0]
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Parameters<typeof handleOnboardingMessage>[5]
const business = { id: 'b1', name: 'סטודיוגה', defaultLanguage: 'he', onboardingStep: 'business_name' } as unknown as Business
const identity = { id: 'i1' } as unknown as ResolvedIdentity
const msg = { body: 'סטודיוגה', fromNumber: '+972500000000', timestamp: new Date() } as unknown as InboundMessage

beforeEach(() => { generateOnboardingReply.mockClear() })

it('forwards the transcript into generateOnboardingReply', async () => {
  const transcript: TranscriptTurn[] = [{ role: 'assistant', text: 'מה שם העסק?' }, { role: 'customer', text: 'סטודיוגה' }]
  await handleOnboardingMessage(fakeDb(), msg, identity, business, 'https://x', log, 'he', transcript)
  expect(generateOnboardingReply).toHaveBeenCalled()
  const passed = generateOnboardingReply.mock.calls.every((c) => (c[0] as { transcript?: unknown }).transcript === transcript)
  expect(passed).toBe(true)
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/flows/onboarding-transcript-wiring.test.ts`
Expected: FAIL — `handleOnboardingMessage` doesn't accept `lang`/`transcript` params yet, and doesn't forward `transcript`.

- [ ] **Step 3: Update `handleOnboardingMessage` signature + dispatch**

In `src/domain/flows/manager-onboarding.ts`, add the `TranscriptTurn` import to the existing client import line (line 8) — append `, type TranscriptTurn` is wrong (it's from a different module); instead add a separate import near the top:

```ts
import type { TranscriptTurn } from '../../adapters/llm/types.js'
```

Change `handleOnboardingMessage` (currently lines 18-49) to accept `lang` and `transcript`, replacing the internal `lang` computation, and pass `transcript` to every handler:

```ts
export async function handleOnboardingMessage(
  db: Db,
  msg: InboundMessage,
  identity: ResolvedIdentity,
  business: Business,
  baseUrl: string,
  log: FastifyBaseLogger,
  lang: Lang = (business.defaultLanguage as Lang | null | undefined) ?? 'he',
  transcript: TranscriptTurn[] = [],
): Promise<OnboardingResult> {
  const step = (business.onboardingStep ?? 'business_name') as OnboardingStep

  switch (step) {
    case 'business_name':
      return handleBusinessNameStep(db, msg, business, lang, log, transcript)
    case 'services':
      return handleServiceStep(db, msg, identity, business, lang, log, transcript)
    case 'hours':
      return handleHoursStep(db, msg, identity, business, lang, log, transcript)
    case 'cancellation_policy':
      return handleCancellationPolicyStep(db, msg, business, lang, log, transcript)
    case 'payment':
      return handlePaymentStep(db, msg, business, lang, log, transcript)
    case 'escalation_policy':
      return handleEscalationPolicyStep(db, msg, business, baseUrl, lang, log, transcript)
    case 'calendar':
      return handleCalendarStepWithBody(db, business, baseUrl, msg.body, lang, transcript)
    case 'customer_import':
      return handleCustomerImportStep(db, msg, business, baseUrl, lang, log, transcript)
    case 'verify':
      return handleVerifyStep(db, msg, identity, business, lang, log, transcript)
  }
}
```

(The old `const lang = ...` line inside the function is removed — `lang` is now a parameter.)

- [ ] **Step 4: Thread `transcript` into the two shared helpers**

Update `onboardingQuestion` (currently lines 58-74) — add `transcript` to its options bag and forward it:

```ts
async function onboardingQuestion(
  step: string,
  businessName: string,
  lang: Lang,
  opts: { justConfirmed?: string; collectedSummary?: string; isRetry?: boolean; extraContext?: string; transcript?: TranscriptTurn[] } = {},
): Promise<string> {
  const q = await generateOnboardingReply({
    step,
    businessName,
    lang,
    isRetry: opts.isRetry ?? false,
    ...(opts.justConfirmed !== undefined ? { justConfirmed: opts.justConfirmed } : {}),
    ...(opts.collectedSummary !== undefined ? { collectedSummary: opts.collectedSummary } : {}),
    ...(opts.extraContext !== undefined ? { extraContext: opts.extraContext } : {}),
    ...(opts.transcript !== undefined ? { transcript: opts.transcript } : {}),
  })
  return q || getPrompt(step as OnboardingStep, lang)
}
```

Update `notAnswerReply` (currently lines 80-87) to accept and forward `transcript`:

```ts
async function notAnswerReply(
  step: string,
  businessName: string,
  lang: Lang,
  guidance: string,
  transcript: TranscriptTurn[] = [],
): Promise<OnboardingResult> {
  return { reply: await onboardingQuestion(step, businessName, lang, { isRetry: true, extraContext: guidance, transcript }) }
}
```

- [ ] **Step 5: Add `transcript` param to every step handler and forward it**

For EACH handler below, add a final parameter `transcript: TranscriptTurn[] = []` to its signature, and pass `transcript` at every call site of `onboardingQuestion`, `notAnswerReply`, and `generateOnboardingReply` inside it.

1. `handleBusinessNameStep(db, msg, business, lang, log, transcript: TranscriptTurn[] = [])`
   - `onboardingQuestion('business_name', ..., { isRetry: true, extraContext: '...', transcript })`
   - `onboardingQuestion('services', displayName, lang, { justConfirmed: displayName, transcript })`
2. `handleServiceStep(db, msg, identity, business, lang, log, transcript: TranscriptTurn[] = [])`
   - the `retryPrompt` `onboardingQuestion('services', ..., { isRetry: true, transcript })`
   - `notAnswerReply('services', business.name, lang, '...', transcript)`
   - `onboardingQuestion('hours', business.name, lang, { justConfirmed: confirmation, transcript })`
3. `handleHoursStep(db, msg, identity, business, lang, log, transcript: TranscriptTurn[] = [])`
   - the `retryPrompt` `onboardingQuestion('hours', ..., { isRetry: true, transcript })`
   - both `onboardingQuestion('cancellation_policy', ..., { justConfirmed: ..., transcript })` calls (the 24/7 branches and the normal branch)
   - `notAnswerReply('hours', business.name, lang, '...', transcript)`
4. `handleCancellationPolicyStep(db, msg, business, lang, log, transcript: TranscriptTurn[] = [])`
   - `notAnswerReply('cancellation_policy', business.name, lang, '...', transcript)`
   - the retry `onboardingQuestion('cancellation_policy', ..., { isRetry: true, transcript })`
   - `onboardingQuestion('payment', business.name, lang, { justConfirmed: confirmation, transcript })`
5. `handlePaymentStep(db, msg, business, lang, log, transcript: TranscriptTurn[] = [])`
   - all `notAnswerReply(...)` calls → add `transcript`
   - all `onboardingQuestion('escalation_policy'|'payment'|'payment_method', ..., { ..., transcript })` calls → add `transcript`
6. `handleEscalationPolicyStep(db, msg, business, baseUrl, lang, log, transcript: TranscriptTurn[] = [])`
   - `notAnswerReply('escalation_policy', business.name, lang, '...', transcript)`
   - `onboardingQuestion('calendar', business.name, lang, { justConfirmed: summary, extraContext: ..., transcript })`
7. `handleCalendarStepWithBody(db, business, baseUrl, body, lang = 'he', transcript: TranscriptTurn[] = [])` — note this one is `export`ed and also called by `oauth.ts`; keep `lang` defaulting to `'he'` and add `transcript` AFTER it with a default so the existing `oauth.ts` call (which passes up to `lang`) still compiles.
   - `onboardingQuestion('customer_import', business.name, lang, { justConfirmed: ..., transcript })`
   - the `generateOnboardingReply({ step: 'calendar', ... })` direct call → add `transcript`
8. `handleCustomerImportStep(db, msg, business, baseUrl, lang, log, transcript: TranscriptTurn[] = [])`
   - the `import` branch `generateOnboardingReply({ step: 'customer_import', ... })` → add `transcript`
   - `notAnswerReply('customer_import', business.name, lang, '...', transcript)`
   - the skip branch `generateOnboardingReply({ step: 'verify', ... })` → add `transcript`
9. `handleVerifyStep(db, msg, identity, business, lang, log, transcript: TranscriptTurn[] = [])`
   - every `generateOnboardingReply({ step: 'verify', ... })` call (the GO/completion, the meta-question, and the correction-applied branches) → add `transcript`

Do NOT change `buildVerifySummary` (it uses `generateManagerCommandReply`, a different generator — out of scope for transcript threading).

- [ ] **Step 6: Run the wiring test + full suite + tsc**

Run: `npx vitest run tests/flows/onboarding-transcript-wiring.test.ts && npx tsc --noEmit && npm test`
Expected: the wiring test PASSES, tsc clean, all existing tests green (including `tests/flows/onboarding-customer-import.test.ts` — its calls omit the new params, which default).

- [ ] **Step 7: Commit**

```bash
git add src/domain/flows/manager-onboarding.ts tests/flows/onboarding-transcript-wiring.test.ts
git commit -m "feat(onboarding): thread lang + transcript through onboarding handlers"
```

---

### Task 5: Plug the onboarding gate into session + transcript + language

**Files:**
- Modify: `src/routes/webhook.ts` — `routeManagerMessage` onboarding gate (currently lines 485-494) + import

This wraps the gate with the same session/transcript/language machinery the live manager path uses. Verified by `tsc` + the full suite staying green (the pure decision is already covered by Task 1; the live-path precedent `manager-language-switch.test.ts` shows this wiring style isn't unit-tested at the handler level). Manual WhatsApp validation is in Task 6.

- [ ] **Step 1: Add the `generateOnboardingReply` import**

In `src/routes/webhook.ts`, the onboarding handler is imported already (`handleOnboardingMessage`). Add `generateOnboardingReply` for the switch-accept ack. Find the import of `handleOnboardingMessage` and add `generateOnboardingReply` from the client. If `handleOnboardingMessage` is imported from `'../domain/flows/manager-onboarding.js'`, add a separate import:

```ts
import { generateOnboardingReply } from '../adapters/llm/client.js'
```

(Confirm `loadActiveSession`, `createSession`, `updateSessionContext`, `SESSION_EXPIRY` are already imported — they are, lines 17-21; `saveMessage`/`loadTranscript` line 43; `parseConfirmation`/`ManagerFlowContext` line 24; `managerSwitchOfferSuffix`/`Lang` line 44; `resolveTurnLanguage` added in Task 2.)

- [ ] **Step 2: Rewrite the onboarding gate**

Replace the onboarding gate block (currently lines 485-494):

```ts
  // Onboarding gate — intercept all messages until setup is complete
  if (!business.onboardingCompletedAt) {
    const baseUrl = process.env['PUBLIC_BASE_URL'] ?? 'https://your-domain.com'
    const result = await handleOnboardingMessage(db, msg, identity, business, baseUrl, app.log)
    const onboardingSendResult = await sendMessage({ toNumber: msg.fromNumber, body: result.reply }, waCredentials)
    if (!onboardingSendResult.ok) {
      app.log.error({ error: onboardingSendResult.error, toNumber: msg.fromNumber }, 'Manager onboarding send failed')
    }
    return
  }
```

with:

```ts
  // Onboarding gate — intercept all messages until setup is complete. Plugged into
  // the same chat machinery the live manager path uses: manager session for
  // transcript continuity (so replies vary, no repeated openers) + the §3.4
  // language switch. Reuses loadActiveSession/createSession/saveMessage/
  // loadTranscript/resolveTurnLanguage — nothing rebuilt.
  if (!business.onboardingCompletedAt) {
    const baseUrl = process.env['PUBLIC_BASE_URL'] ?? 'https://your-domain.com'
    const defaultLang: Lang = (business.defaultLanguage as Lang | null | undefined) ?? 'he'

    let obSession = await loadActiveSession(db, identity.id)
    if (!obSession) {
      obSession = await createSession(db, business.id, identity.id, 'manager_instruction', SESSION_EXPIRY.manager)
    }
    const obCtx = (obSession.context as ManagerFlowContext | undefined) ?? {}
    let sessionOverride: Lang | undefined = obCtx.languageOverride

    // Answer to a previously-appended switch offer, before any step processing.
    if (obCtx.languageSwitchOfferPending && !identity.preferredLanguage && !sessionOverride) {
      const answer = parseConfirmation(msg.body)
      if (answer === 'yes') {
        const chosen: Lang = defaultLang === 'he' ? 'en' : 'he'
        await db.update(identities).set({ preferredLanguage: chosen }).where(eq(identities.id, identity.id)).catch(() => { /* non-fatal */ })
        await updateSessionContext(db, obSession.id, { ...obCtx, languageOverride: chosen, languageSwitchOfferPending: false }, undefined, SESSION_EXPIRY.manager)
        const ack = await generateOnboardingReply({
          step: business.onboardingStep ?? 'business_name',
          businessName: business.name,
          lang: chosen,
          isRetry: false,
          extraContext: 'The owner just confirmed continuing in this language. Acknowledge in one short phrase, then re-ask the current setup question.',
        })
        await saveMessage(db, obSession.id, 'assistant', ack).catch(() => { /* non-fatal */ })
        await sendMessage({ toNumber: msg.fromNumber, body: ack }, waCredentials)
        return
      }
      if (answer === 'no') {
        sessionOverride = defaultLang
        await updateSessionContext(db, obSession.id, { ...obCtx, languageOverride: defaultLang, languageSwitchOfferPending: false }, undefined, SESSION_EXPIRY.manager)
      }
      // 'unclear' — fall through; offer may be re-appended below.
    }

    const { turnLang, detected, shouldOfferSwitch } = resolveTurnLanguage({
      body: msg.body,
      defaultLang,
      preferredLanguage: identity.preferredLanguage,
      sessionOverride,
    })

    await saveMessage(db, obSession.id, 'customer', msg.body).catch((err) => {
      app.log.warn({ err }, 'Failed to save onboarding inbound message to transcript')
    })
    const obTranscript = await loadTranscript(db, obSession.id, 10).catch(() => [])

    const result = await handleOnboardingMessage(db, msg, identity, business, baseUrl, app.log, turnLang, obTranscript)
    const reply = shouldOfferSwitch ? result.reply + managerSwitchOfferSuffix(detected) : result.reply

    await updateSessionContext(db, obSession.id, {
      ...obCtx,
      languageSwitchOfferPending: shouldOfferSwitch,
      ...(sessionOverride ? { languageOverride: sessionOverride } : {}),
    }, undefined, SESSION_EXPIRY.manager).catch(() => { /* non-fatal */ })

    await saveMessage(db, obSession.id, 'assistant', reply).catch((err) => {
      app.log.warn({ err }, 'Failed to save onboarding outbound message to transcript')
    })

    const onboardingSendResult = await sendMessage({ toNumber: msg.fromNumber, body: reply }, waCredentials)
    if (!onboardingSendResult.ok) {
      app.log.error({ error: onboardingSendResult.error, toNumber: msg.fromNumber }, 'Manager onboarding send failed')
    }
    return
  }
```

(Confirm `identities` and `eq` are already imported in `webhook.ts` — they are, used throughout. `business.onboardingStep` is the live step; `generateOnboardingReply` returns `''` on LLM failure, and the ack send of an empty body is acceptable but rare — if you prefer, guard `ack || <one-line fallback>`; not required.)

- [ ] **Step 3: Verify build + full suite**

Run: `npx tsc --noEmit && npm test`
Expected: tsc clean; all tests green (including `manager-language-switch.test.ts` and `onboarding-customer-import.test.ts`).

- [ ] **Step 4: Commit**

```bash
git add src/routes/webhook.ts
git commit -m "feat(onboarding): plug gate into session transcript + §3.4 language switch"
```

---

### Task 6: Full verification + final review

- [ ] **Step 1: Typecheck + full suite**

Run: `npx tsc --noEmit && npm test`
Expected: clean; all green including the 3 new test files.

- [ ] **Step 2: Manual WhatsApp smoke (after deploy)**

From `+972543503704` to the PA number, mid-onboarding:
- Send several step answers in a row; confirm replies do NOT all open with "מעולה" / identical shapes (transcript anti-repetition).
- Send a short Latin token where a value is expected (e.g. `24/7` for hours, `Bit` for payment): confirm the PA stays in Hebrew (no wrong English flip).
- Send a full English sentence: confirm the PA replies in English and appends the switch offer; reply "כן"/"yes" and confirm it continues in English and re-asks the step.
File any defect under its scenario and add a regression test before closing.

---

## Self-Review

**Spec coverage:**
- Shared `language-switch.ts` (hasLanguageSignal + resolveTurnLanguage) → Task 1. ✓
- Live manager path refactor to call the shared resolver (behavior-preserving) → Task 2. ✓
- `generateOnboardingReply` transcript injection → Task 3. ✓
- Thread `lang` + `transcript` through `handleOnboardingMessage` + handlers → Task 4. ✓
- Onboarding gate: session load/create, save inbound/outbound, loadTranscript(10), language resolution, pending-offer handling, append switch suffix, persist session language state → Task 5. ✓
- No migration; `.catch` on all session/message I/O → Tasks 5. ✓
- Transcript window = 10; keep §3.4 offer during onboarding; guard rule (Hebrew or ≥2 Latin words) → Tasks 1 & 5. ✓
- Out of scope (owner-gender capture) → not present. ✓

**Placeholder scan:** every code step has literal content; commands have expected output; no TBDs.

**Type consistency:** `resolveTurnLanguage(input) → { turnLang, detected, shouldOfferSwitch }` defined in Task 1, called identically in Tasks 2 and 5. `hasLanguageSignal(text): boolean` consistent. `buildOnboardingSystemPrompt(input)` and `generateOnboardingReply` both take `transcript?: TranscriptTurn[]` (Task 3), forwarded via the same field name through `onboardingQuestion`/`notAnswerReply`/handlers (Task 4) and supplied from `loadTranscript` (Task 5). `handleOnboardingMessage(..., lang, transcript)` signature defined in Task 4 matches the call in Task 5. `ManagerFlowContext.languageOverride`/`languageSwitchOfferPending` reused as defined in `flows/types.ts`. `SESSION_EXPIRY.manager`, `createSession(..., 'manager_instruction', ...)`, `updateSessionContext(db, id, ctx, undefined, expiry)` all match existing signatures.
