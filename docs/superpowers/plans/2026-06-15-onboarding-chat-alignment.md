# Onboarding ↔ Chat-Standard Alignment (Tier A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the Branch-3 manager-onboarding flow from looping at the customer-import step and from violating the chat lawbook (split/flip-flopping gender, stacked questions, self-contradicting prompts), so onboarding speaks to the same standard as the live Branch-3 orchestrator.

**Architecture:** Onboarding is a per-step state machine (`manager-onboarding.ts`) that phrases each turn through `generateOnboardingReply` (which already injects the shared `buildVoiceCore`). This plan (a) replaces the one crude keyword gate that causes the loop with the project's existing LLM-intent pattern (`parseCalendarChoice` → new `parseImportChoice`), (b) lifts the masculine-default / anti-split-gender addressing rule into the shared voice core so every channel inherits it, and (c) fixes three string-level lawbook violations. No new persistence or schema.

**Tech Stack:** TypeScript, Fastify, Drizzle, Zod, Gemini (Vertex AI) via `callWithSchema`, Vitest.

**Out of scope — deferred to a separate Tier-B plan** (`onboarding transcript persistence`): threading the live transcript into `generateOnboardingReply` to kill repetition at the root (e.g. "מעולה" every turn), in-onboarding language switching with preference persistence, and owner-gender capture. These need an onboarding session/turn store and behavioural care; do **not** attempt them here. Naive per-message `detectLang` in onboarding is a *regression* (one-word replies like "ok"/"24/7"/"GO" detect as English and would flip a Hebrew flow) — explicitly excluded.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/adapters/llm/client.ts` | LLM adapter: onboarding parsers + STEP_GOALS | Add `parseImportChoice` + `importChoiceSchema`; fix escalation STEP_GOAL; remove now-redundant customer-only addressing line |
| `src/adapters/llm/voice.ts` | Shared voice core + bot-tell blacklist | Add masculine-default / anti-split addressing rule to `VOICE_CORE`; add `תגיד/י` to `BOT_TELLS` |
| `src/domain/flows/manager-onboarding.ts` | Onboarding state machine | Rewrite `handleCustomerImportStep` gate to use `parseImportChoice`; fix feminine completion fallback |
| `src/domain/i18n/t.ts` | Canonical strings | Fix `ob_import` (drop broken "כן/דלג" menu), `ob_escalation` (single question) |
| `src/routes/oauth.ts` | Google callback → manager message | Route post-connect customer-import prompt through the voice layer |
| `tests/flows/onboarding-customer-import.test.ts` | NEW — flow-control regression for the loop | Create |
| `tests/adapters/voice.test.ts` | NEW — voice-core rule + bot-tell coverage | Create |
| `tests/i18n/onboarding-strings.test.ts` | NEW — string-level lawbook assertions | Create |

Test glob is `tests/**/*.test.ts` (+ `src/domain|routes|skills/**`); `src/adapters/**` is **not** globbed, so voice/i18n tests must live under `tests/`.

---

### Task 1: Add `parseImportChoice` LLM intent parser

Mirrors the existing `parseCalendarChoice` (skip/connect/unclear) — the proven pattern this step should have used. Verified by build now; exercised by Task 2's flow test.

**Files:**
- Modify: `src/adapters/llm/client.ts` (schema near line 888; function after `parseCalendarChoice`, ~line 1040)

- [ ] **Step 1: Add the Zod schema**

In `src/adapters/llm/client.ts`, immediately after the `calendarChoiceSchema` block (currently lines 886-888):

```ts
const importChoiceSchema = z.object({
  choice: z.enum(['import', 'skip', 'unclear']),
})
```

- [ ] **Step 2: Add the parser function**

Immediately after the end of `parseCalendarChoice` (after its closing `}` at ~line 1040):

```ts
// Onboarding "customer_import" step — the manager was asked whether they have an
// existing customer list / booking history / service catalog to bulk-import. They
// reply in free text. Decide whether they want to IMPORT (get an upload link),
// SKIP (move on now), or it's UNCLEAR (a question/confusion → explain & re-ask).
// Replaces the old isAffirmative/isNegative keyword gate that looped on any
// natural phrasing ("נדלג", "בוא נמשיך", "אין רשימה", "יש לי קובץ").
export async function parseImportChoice(
  message: string,
  lang: 'he' | 'en',
): Promise<LlmResult<{ choice: 'import' | 'skip' | 'unclear' }>> {
  const langNote = lang === 'he' ? 'The manager is writing in Hebrew.' : 'The manager is writing in English.'
  const systemPrompt = `${langNote}

The manager is setting up their PA and was asked whether they have an existing customer list, booking history, or service catalog they want to bulk-import now. Classify their reply:

- "import": they want to import / upload now, or say they have a file or list to bring in. Examples: "כן", "יש לי קובץ", "יש לי רשימת לקוחות", "אקסל", "בוא נעלה", "yes", "I have a list", "sure", "let's upload".
- "skip": they have no list, or want to move on / skip / do it later. Examples: "נדלג", "דלג", "אין לי רשימה", "אין רשימת לקוחות", "בוא נמשיך", "להמשיך הלאה", "אחר כך", "skip", "no list", "let's move on", "continue", "not now".
- "unclear": anything else — a question about the format or process, a greeting, or confusion. Examples: "באיזה פורמט?", "מה זאת אומרת?", "what format?", "how does it work?".

Return JSON: { "choice": "import" | "skip" | "unclear" }`
  const safeMessage = sanitizeUserInput(message)
  return callWithSchema(systemPrompt, safeMessage, importChoiceSchema)
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/adapters/llm/client.ts
git commit -m "feat(onboarding): add parseImportChoice intent parser (import/skip/unclear)"
```

---

### Task 2: Rewrite the customer-import gate (kills the infinite loop)

The bug: `handleCustomerImportStep` only advances when `isNegative()` matches (text starting with `no/nope/lo/לא`), so every natural skip/yes phrasing loops forever.

**Files:**
- Modify: `src/domain/flows/manager-onboarding.ts` (import line 8; `handleCustomerImportStep` 570-622)
- Test: `tests/flows/onboarding-customer-import.test.ts` (create)

- [ ] **Step 1: Write the failing flow-control test**

Create `tests/flows/onboarding-customer-import.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Branch-3 onboarding regression: the customer_import step must ADVANCE on any
// natural "skip/move-on/no list" phrasing and must NOT advance on a question
// (unclear). The old isNegative() keyword gate looped on "נדלג"/"בוא נמשיך"/
// "אין רשימה". We mock the LLM client + a fake DB and assert control flow.

const parseImportChoice = vi.fn()
const generateOnboardingReply = vi.fn(async () => 'a human onboarding line')
const generateManagerCommandReply = vi.fn(async () => 'a summary')

vi.mock('../../src/adapters/llm/client.js', () => ({
  parseImportChoice: (...a: unknown[]) => parseImportChoice(...a),
  generateOnboardingReply: (...a: unknown[]) => generateOnboardingReply(...a),
  generateManagerCommandReply: (...a: unknown[]) => generateManagerCommandReply(...a),
  // Unused on this path but imported by the module under test:
  classifyManagerInstruction: vi.fn(),
  parseBusinessName: vi.fn(),
  parseOnboardingServices: vi.fn(),
  parseOnboardingHours: vi.fn(),
  parseOnboardingAnswer: vi.fn(),
  parseCalendarChoice: vi.fn(),
}))

import { handleOnboardingMessage } from '../../src/domain/flows/manager-onboarding.js'
import type { InboundMessage } from '../../src/adapters/whatsapp/types.js'
import type { ResolvedIdentity } from '../../src/domain/identity/types.js'
import type { Business } from '../../src/db/schema.js'

// Records every .set() payload so we can assert whether the step advanced.
// The select chain is a thenable that resolves to [] so `await db.select()...`
// (used by buildVerifySummary on the skip path) yields an empty array.
function makeFakeDb(updates: Record<string, unknown>[]) {
  const selectChain: Record<string, unknown> = {
    then: (resolve: (v: unknown[]) => void) => resolve([]),
  }
  for (const m of ['select', 'from', 'where', 'orderBy', 'limit']) {
    selectChain[m] = () => selectChain
  }
  return {
    select: () => selectChain,
    update: () => ({
      set: (payload: Record<string, unknown>) => ({
        where: async () => { updates.push(payload) },
      }),
    }),
    insert: () => ({
      values: () => ({ returning: async () => [{ token: 'TKN123' }] }),
    }),
  } as unknown as Parameters<typeof handleOnboardingMessage>[0]
}

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Parameters<typeof handleOnboardingMessage>[5]

const business = {
  id: 'biz-1', name: 'סטודיוגה', defaultLanguage: 'he', onboardingStep: 'customer_import',
  whatsappNumber: '+100', available247: false, cancellationCutoffMinutes: 0,
  confirmationGate: 'immediate', paymentMethod: null, escalationRules: [], calendarMode: 'internal',
} as unknown as Business
const identity = { id: 'id-1' } as unknown as ResolvedIdentity
const msg = (body: string): InboundMessage =>
  ({ body, fromNumber: '+972500000000', timestamp: new Date() } as unknown as InboundMessage)

beforeEach(() => { parseImportChoice.mockReset(); generateOnboardingReply.mockClear(); generateManagerCommandReply.mockClear() })

describe('customer_import gate — no more loop', () => {
  it('advances to verify when the manager skips ("נדלג"-style)', async () => {
    parseImportChoice.mockResolvedValue({ ok: true, data: { choice: 'skip' } })
    const updates: Record<string, unknown>[] = []
    await handleOnboardingMessage(makeFakeDb(updates), msg('נדלג'), identity, business, 'https://x', log)
    expect(updates.some((u) => u['onboardingStep'] === 'verify')).toBe(true)
  })

  it('does NOT advance when the reply is a question (unclear) — explains instead', async () => {
    parseImportChoice.mockResolvedValue({ ok: true, data: { choice: 'unclear' } })
    const updates: Record<string, unknown>[] = []
    await handleOnboardingMessage(makeFakeDb(updates), msg('באיזה פורמט?'), identity, business, 'https://x', log)
    expect(updates.some((u) => u['onboardingStep'] === 'verify')).toBe(false)
  })

  it('returns an upload link when the manager wants to import', async () => {
    parseImportChoice.mockResolvedValue({ ok: true, data: { choice: 'import' } })
    const updates: Record<string, unknown>[] = []
    const res = await handleOnboardingMessage(makeFakeDb(updates), msg('יש לי קובץ אקסל'), identity, business, 'https://x', log)
    expect(res.reply).toContain('https://x/import/TKN123')
  })
})
```

- [ ] **Step 2: Run it to verify it fails against the current handler**

Run: `npx vitest run tests/flows/onboarding-customer-import.test.ts`
Expected: FAIL — the "skip" test fails (old handler loops, never sets `onboardingStep: 'verify'`), and the module mock provides `parseImportChoice` which the old code never calls.

- [ ] **Step 3: Update the import line**

In `src/domain/flows/manager-onboarding.ts` line 8, add `parseImportChoice` to the `client.js` import:

```ts
import { classifyManagerInstruction, generateOnboardingReply, generateManagerCommandReply, parseOnboardingAnswer, parseBusinessName, parseOnboardingServices, parseOnboardingHours, parseCalendarChoice, parseImportChoice, type OnboardingHourEntry } from '../../adapters/llm/client.js'
```

(Leave the `isAffirmative, isNegative` import from `steps.js` on line 10 — still used by `handlePaymentStep`.)

- [ ] **Step 4: Rewrite the gate**

Replace the body of `handleCustomerImportStep` (currently lines 570-622). Keep the import-link block and the skip block intact; only the **decision** changes from keyword to LLM intent:

```ts
async function handleCustomerImportStep(
  db: Db,
  msg: InboundMessage,
  business: Business,
  baseUrl: string,
  lang: Lang,
  log: FastifyBaseLogger,
): Promise<OnboardingResult> {
  const choiceResult = await parseImportChoice(msg.body, lang)
  const choice = choiceResult.ok ? choiceResult.data.choice : 'unclear'

  if (choice === 'import') {
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000)
    const [token] = await db
      .insert(importTokens)
      .values({ businessId: business.id, managerPhone: msg.fromNumber, expiresAt })
      .returning({ token: importTokens.token })

    log.info({ businessId: business.id }, 'Onboarding: import token generated')
    const uploadUrl = `${baseUrl}/import/${token!.token}`
    const importLinkFallback = i18n.ob_import_link[lang](uploadUrl)
    const importLinkQ = await generateOnboardingReply({
      step: 'customer_import',
      businessName: business.name,
      lang,
      isRetry: false,
      extraContext: `Manager agreed to import. The secure upload link (valid 30 min) is: ${uploadUrl}. It MUST appear on its own line in the reply. Accepted formats: CSV of contacts (name, phone), booking history (name, phone, date, service), or service catalog (name, duration_minutes, price).`,
    })
    const importLinkReply = importLinkQ || importLinkFallback
    const importLinkWithUrl = importLinkReply.includes(uploadUrl) ? importLinkReply : `${importLinkReply}\n${uploadUrl}`
    return { reply: importLinkWithUrl }
  }

  // A question or confusion ("what format?") — explain and re-ask, stay on this
  // step. Never read as a decline (the old isNegative gate trapped the manager
  // here on any natural phrasing).
  if (choice === 'unclear') {
    return notAnswerReply('customer_import', business.name, lang,
      'The manager neither clearly accepted nor declined importing their existing customers — they asked a question or seem unsure. In one or two sentences explain that you can bulk-import their existing customer list or booking history from a CSV/Excel file so people are recognized from day one, that it is optional, then ask again whether they want to import now or skip. If they asked about the file format, mention it accepts a contacts CSV (name, phone) or booking history (name, phone, date, service).')
  }

  // choice === 'skip' — they have no list or want to move on.
  await db.update(businesses).set({ onboardingStep: 'verify' }).where(eq(businesses.id, business.id))
  log.info({ businessId: business.id }, 'Onboarding: customer import skipped')
  const summary = await buildVerifySummary(db, business, lang)
  const importSkipFallback = `${i18n.ob_import_skip[lang]}\n\n${summary}`
  const importSkipQ = await generateOnboardingReply({
    step: 'verify',
    businessName: business.name,
    lang,
    isRetry: false,
    justConfirmed: lang === 'he' ? 'דילגו על הייבוא' : 'Skipped import',
    extraContext: `Here is the full setup summary to show the manager:\n${summary}`,
  })
  const importSkipReply = importSkipQ || importSkipFallback
  return { reply: importSkipReply }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/flows/onboarding-customer-import.test.ts`
Expected: PASS (all 3).

- [ ] **Step 6: Run the full unit suite (no regressions)**

Run: `npm test`
Expected: PASS (all previously-green tests + the 3 new).

- [ ] **Step 7: Commit**

```bash
git add src/domain/flows/manager-onboarding.ts tests/flows/onboarding-customer-import.test.ts
git commit -m "fix(onboarding): LLM-intent gate for customer_import — ends the skip loop"
```

---

### Task 3: Lift masculine-default / anti-split addressing into the shared voice core

Today the addressing rule lives only in the Branch-4 customer template, so onboarding and the live manager orchestrator have no rule — gender flips and split forms ("תגיד/י") appear. Move it to `buildVoiceCore` so all channels inherit it (DRY), and blacklist the split form.

**Files:**
- Modify: `src/adapters/llm/voice.ts` (`VOICE_CORE`; `BOT_TELLS.he`)
- Modify: `src/adapters/llm/client.ts` (remove now-redundant line 328)
- Test: `tests/adapters/voice.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/adapters/voice.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildVoiceCore, BOT_TELLS } from '../../src/adapters/llm/voice.js'

describe('voice core — Hebrew addressing rule reaches every channel', () => {
  for (const channel of ['customer', 'manager', 'onboarding'] as const) {
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/adapters/voice.test.ts`
Expected: FAIL — `buildVoiceCore` does not yet contain `בלשון זכר`; `BOT_TELLS.he` lacks `תגיד/י`.

- [ ] **Step 3: Add the rule to `VOICE_CORE`**

In `src/adapters/llm/voice.ts`, append a new paragraph to the `VOICE_CORE` template, immediately after the warmth/sycophancy line (the last line ending `...I'd be delighted to help!").`) and before the closing backtick:

```ts
ADDRESSING (Hebrew replies only): address the person you're texting in masculine singular second-person (פנייה בלשון זכר). NEVER write split-gender forms — not "תגיד/י", not "תרצה/תרצי", not "מעוניין/ת". Pick the masculine form. This governs how you address them; it is separate from how the business refers to itself (the persona note, when present, governs that).
```

- [ ] **Step 4: Add the split form to `BOT_TELLS.he`**

In the same file, in the `BOT_TELLS.he` array, the split-gender section already lists `'תרצה/תרצי'` and `'תרצה/י'`. Add `'תגיד/י'` to that group:

```ts
    // Split-gender hedging — always address the customer in one (masculine) form.
    'תרצה/תרצי',
    'תרצה/י',
    'תגיד/י',
```

- [ ] **Step 5: Remove the now-redundant customer-only line**

In `src/adapters/llm/client.ts`, delete the standalone paragraph at line 328 (it is fully covered by the core rule, which `PA_PERSONA_TEMPLATE` already injects via `buildVoiceCore('customer')` at line 313). Remove this block and its surrounding blank lines:

```ts
ADDRESSING THE CUSTOMER (Hebrew): always address the customer in masculine second-person form (פנייה בלשון זכר). NEVER write split-gender forms like "תרצה/תרצי" or "תרצה/י" — pick the masculine form. (This is separate from how you refer to yourself, which the persona note below governs.)
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run tests/adapters/voice.test.ts && npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 7: Commit**

```bash
git add src/adapters/llm/voice.ts src/adapters/llm/client.ts tests/adapters/voice.test.ts
git commit -m "fix(voice): masculine-default addressing in shared core; blacklist תגיד/י"
```

---

### Task 4: Fix string-level lawbook violations (`ob_import` menu, `ob_escalation` double question)

`ob_import` tells the user to reply "כן"/"דלג" — but the parser never matched "דלג", and it's a menu (§9.3). `ob_escalation` stacks two questions (§2.2).

**Files:**
- Modify: `src/domain/i18n/t.ts` (`ob_import` ~216; `ob_escalation` ~187)
- Modify: `src/adapters/llm/client.ts` (escalation `STEP_GOALS` ~515)
- Test: `tests/i18n/onboarding-strings.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/i18n/onboarding-strings.test.ts`:

```ts
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
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/i18n/onboarding-strings.test.ts`
Expected: FAIL — `ob_import.he` contains "דלג"; `ob_escalation` has two `?`.

- [ ] **Step 3: Rewrite `ob_import`**

In `src/domain/i18n/t.ts`, replace the `ob_import` entry (currently lines 215-218):

```ts
  ob_import: {
    he: `כמעט סיימנו! יש לכם רשימת לקוחות, היסטוריית תורים או קטלוג שירותים שתרצו לייבא? זה לא חובה — אפשר גם פשוט להמשיך.`,
    en: `Almost done! Do you have an existing customer list, booking history, or service catalog you'd like to import? It's optional — we can just move on if not.`,
  },
```

- [ ] **Step 4: Rewrite `ob_escalation` to a single question**

In `src/domain/i18n/t.ts`, replace the `ob_escalation` entry (currently lines 187-190):

```ts
  ob_escalation: {
    he: `מתי אני צריך לעצור ולהעביר שיחה אליכם ישירות — אילו נושאים או מצבים?`,
    en: `When should I stop and hand a conversation to you directly — what topics or situations?`,
  },
```

- [ ] **Step 5: Align the escalation STEP_GOAL**

In `src/adapters/llm/client.ts`, replace the `escalation_policy` entry in `STEP_GOALS` (currently lines 515-518):

```ts
  escalation_policy: {
    he: 'שאל מתי ה-PA צריך לעצור ולהעביר שיחה ישירות לבעל העסק — אילו נושאים או מצבים. שאלה אחת בלבד, בלי תפריט מספרים. אם הם מציינים גם מה לומר ללקוח, קלוט זאת — אך אל תשאל על כך בנפרד.',
    en: 'Ask when the PA should stop and hand a conversation to them — what situations or topics. Exactly one question, no numbered menu. If they also say what to tell the customer, capture it, but do not ask about it separately.',
  },
```

(The escalation parser already defaults `customerMessage` to `passed_to_owner` and still extracts a volunteered customer message, so no behaviour is lost — see `PARSE_PROMPTS.escalation_policy`, `client.ts:907`.)

- [ ] **Step 6: Run tests + full suite**

Run: `npx vitest run tests/i18n/onboarding-strings.test.ts && npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/domain/i18n/t.ts src/adapters/llm/client.ts tests/i18n/onboarding-strings.test.ts
git commit -m "fix(onboarding): drop broken import menu; escalation asks one question"
```

---

### Task 5: Fix the feminine completion fallback

The hardcoded launch-completion fallback addresses the owner in feminine grammar. Make it masculine, consistent with Task 3's rule. (String constant inside a handler; verified by build + grep rather than a unit test.)

**Files:**
- Modify: `src/domain/flows/manager-onboarding.ts:645-647`

- [ ] **Step 1: Edit the fallback to masculine**

In `handleVerifyStep`, replace the Hebrew branch of `completionFallback` (currently line 646):

```ts
      ? `\n\nלפני שהלקוחות מגיעים, בוא נלמד קצת על העסק שלך. איך היית מתאר את *${business.name}* — מה הרגש שאתה רוצה שלקוחות יקבלו?`
```

(Was: "בואי … היית מתארת … מה הרגש שאת רוצה". Only grammatical gender changes.)

- [ ] **Step 2: Verify the feminine forms are gone and it compiles**

Run: `grep -n "מתארת\|בואי נלמד" src/domain/flows/manager-onboarding.ts; npx tsc --noEmit`
Expected: grep prints nothing; tsc clean.

- [ ] **Step 3: Commit**

```bash
git add src/domain/flows/manager-onboarding.ts
git commit -m "fix(onboarding): masculine completion fallback"
```

---

### Task 6: Route the post-Google-connect customer-import message through the voice layer

The OAuth callback sends the raw `getPrompt('customer_import')` template (now improved by Task 4, but still un-voiced). Phrase it like every other onboarding turn. (Network/LLM handler — verified by build; no unit test.)

**Files:**
- Modify: `src/routes/oauth.ts` (import block ~line 9; message body ~line 298-304)

- [ ] **Step 1: Import the voice generator**

In `src/routes/oauth.ts`, after the existing `createCalendarClient` import (line 9), add:

```ts
import { generateOnboardingReply } from '../adapters/llm/client.js'
```

- [ ] **Step 2: Generate the import question instead of the raw template**

Replace the `sendMessage` call body (currently lines 298-304):

```ts
        const importQ = await generateOnboardingReply({
          step: 'customer_import',
          businessName: updatedBusiness.name,
          lang,
          isRetry: false,
          justConfirmed: t('ob_calendar_connected', lang),
        })
        await sendMessage(
          {
            toNumber: managerIdentity.phoneNumber,
            body: `${t('ob_calendar_connected', lang)}${calendarPreview}\n\n${importQ || getPrompt('customer_import', lang)}`,
          },
          waCredentials,
        ).catch((err) => app.log.warn({ err }, 'Failed to send calendar confirmation to manager'))
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: clean (`getPrompt` is still used as the fallback, so its import stays).

- [ ] **Step 4: Commit**

```bash
git add src/routes/oauth.ts
git commit -m "fix(onboarding): voice the post-connect import prompt in OAuth callback"
```

---

### Task 7: Full verification gate

- [ ] **Step 1: Typecheck + lint + unit suite**

Run: `npx tsc --noEmit && npm run lint && npm test`
Expected: all clean/green, including the 3 new test files.

- [ ] **Step 2: Manual smoke (real WhatsApp, after deploy) — record under Scenario IDs**

Re-run the `customer_import` leg from the manager phone with each phrasing that looped today: `נדלג`, `בוא נמשיך`, `אין רשימה`, `יש לי קובץ`. Expected: skip phrasings advance to the verify summary; "יש לי קובץ" returns an upload link; a question ("באיזה פורמט?") explains without advancing. Confirm no split-gender forms in any reply. File any defect under its Scenario ID per the master plan.

---

## Self-Review

**Spec coverage** (against the sweep findings):
- 🔴 #1 customer_import loop → Tasks 1-2. ✓
- 🔴 #2 `ob_import` "כן/דלג" contradiction → Task 4 (+ Task 6 stops the OAuth path re-sending the menu). ✓
- 🟠 #3 escalation double question → Task 4. ✓
- 🟠 #5 (gender facet) addressing rule absent from core → Task 3. ✓
- 🟡 #7 OAuth bypasses voice layer → Task 6. ✓
- 🟡 #8 feminine completion fallback → Task 5. ✓
- **Deliberately deferred** (documented in the header, not gaps): 🟠 #4 repetition + #5 transcript-blindness + #6 language switch (Tier-B plan), #9 GO discoverability, #10 import-path data bugs (separate, non-chat). These are out of this plan's scope by design.

**Placeholder scan:** every code/string step contains the literal content; test steps give exact `vitest`/`tsc`/`grep` commands and expected results. No TBDs.

**Type consistency:** `parseImportChoice(message, lang) → LlmResult<{ choice: 'import'|'skip'|'unclear' }>` defined in Task 1, mocked with the same shape in Task 2, branched on the same three literals in the handler. `buildVoiceCore` / `BOT_TELLS` signatures match `voice.ts`. `generateOnboardingReply` input shape matches its definition (`client.ts:525`). `i18n.ob_import` / `i18n.ob_escalation` remain `{he,en}` string records the test indexes directly.
