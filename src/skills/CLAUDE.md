# Skills — Build Guide for Claude Code

**Prerequisites:** Read root [`CLAUDE.md`](../../CLAUDE.md) and [`ARCHITECTURE.md`](../../ARCHITECTURE.md) Part 14 first.
This file is your tactical reference for building skills correctly. It assumes you know what skills are and focuses on how.

---

## The Interface

Every skill must implement `Skill` from `../../shared/skill-types.js`:

```ts
interface Skill {
  readonly name: string                           // stable kebab-case constant
  canHandle(ctx: SkillContext): boolean           // synchronous, no side effects
  handle(ctx: SkillContext): Promise<SkillOutcome>
}
```

Register in your skill's entry point:

```ts
import { registerSkill } from '../index.js'
import { mySkill } from './index.js'
registerSkill(mySkill)
```

Skills are dispatched in registration order — first `canHandle()` match wins.

---

## SkillContext — Field Reference

| Field | Type | When to use |
|---|---|---|
| `business.id` | `string` | Keying external API calls, logging |
| `business.name` | `string` | Personalizing replies |
| `business.timezone` | `string` (IANA) | Any date/time formatting |
| `business.defaultLanguage` | `'he' \| 'en'` | Fallback when caller has no preference |
| `business.botPersona` | `'female' \| 'male' \| 'neutral'` | Matching reply tone |
| `business.currency` | `string` | Any price display (e.g. `'ILS'`) |
| `caller.id` | `string` | Identity UUID for logging/external keying |
| `caller.phoneNumber` | `string` | E.164 — use for external calls if needed |
| `caller.role` | `'manager' \| 'delegated_user' \| 'customer'` | Gating manager-only features |
| `caller.displayName` | `string \| null` | Personalized replies |
| `caller.preferredLanguage` | `'he' \| 'en' \| null` | null = use `business.defaultLanguage` |
| `message.text` | `string` | The raw inbound message — primary input |
| `message.receivedAt` | `Date` | Timestamp of the message |
| `conversationHistory` | `SkillConversationTurn[]` | Last N turns `[{role, text}]` for multi-turn flows |
| `language` | `'he' \| 'en'` | **Pre-resolved reply language — always use this, not `caller.preferredLanguage`** |
| `sessionId` | `string` | Current session UUID for external state keying |
| `businessKnowledge.services` | `ServiceSummary[]` | Active services: name, duration, price — use for FAQ and content generation |
| `businessKnowledge.policies` | `PolicySummary` | Booking policy fields |
| `businessKnowledge.faqs` | `FAQ[]` | Manager-defined FAQ entries |
| `businessKnowledge.brandVoice` | `string \| null` | Brand voice descriptor for LLM prompts |
| `workflowState` | `WorkflowState \| null` | Active workflow row for this identity, or null — Workflow Skills only |
| `workflow.advance` | `(step, state) => Promise<void>` | Advance to next step with optimistic lock — throws if version conflict |
| `workflow.complete` | `() => Promise<void>` | Mark workflow completed |
| `workflow.fail` | `(error) => Promise<void>` | Mark failed, stores error, notifies manager |
| `workflow.create` | `(skillName, firstStep) => Promise<WorkflowState>` | Create a new workflow — call when `workflowState` is null |
| `recentCompletedBooking` | `CompletedBookingSummary \| null` | Most recent completed booking for this identity |
| `customerSegmentQuery` | `(filter) => Promise<CustomerSummary[]>` | Manager-only: fetch customers by segment (campaign-sender) |

---

## canHandle — Rules

**Do:** Match specific trigger phrases unique to your skill.

```ts
canHandle(ctx: SkillContext): boolean {
  return /website|landing page|אתר|דף נחיתה/i.test(ctx.message.text)
}
```

**Never match these words** — they belong to the booking core:
`book`, `cancel`, `reschedule`, `appointment`, `available`, `slot`, `time`, `hours`, `meeting`, `session`, `זמן`, `לבטל`, `לקבוע`

**canHandle must be side-effect free.** It is called for every message on every registered skill. No logging, no network calls, no state mutation inside `canHandle`.

**For multi-turn skills**, re-claim follow-up messages by checking both the current text and conversation history:

```ts
canHandle(ctx: SkillContext): boolean {
  if (/website/i.test(ctx.message.text)) return true
  // Re-claim if we're mid-flow (last assistant turn was from this skill)
  const lastAssistant = [...ctx.conversationHistory].reverse().find(t => t.role === 'assistant')
  return lastAssistant?.text.includes('[website-builder]') ?? false
}
```

---

## SkillOutcome — Returning Results

```ts
// You handled it — reply and continue:
return {
  handled: true,
  reply: 'What kind of business is this for?',
  sessionComplete: false,
  skillName: this.name,
}

// You handled it — flow is complete:
return {
  handled: true,
  reply: 'Your site is live at https://...',
  sessionComplete: true,
  skillName: this.name,
}

// Not your message — pass through to next skill or core:
return { handled: false, skillName: this.name }
```

**`sessionComplete: true`** tells the core the conversation is finished. Only set it when the skill's flow is genuinely done. Never hardcode `false` everywhere — sessions that never complete are a resource leak.

---

## Workflow Skills

A Workflow Skill spans multiple sessions (e.g. building a website over several days). Use it when:
- The task requires more than one conversation turn *across sessions*
- You need to persist intermediate results (generated content, domain choice, manager approvals)

**How it works:**

```ts
async handle(ctx: SkillContext): Promise<SkillOutcome> {
  // Load or create workflow state
  const wf = ctx.workflowState ?? await createWorkflow(ctx, this.name, 'requirements-gather')

  switch (wf.step) {
    case 'requirements-gather': {
      // Do step logic, then advance
      await advanceWorkflow(wf.id, 'structure-confirm', { collectedData: ... })
      return { handled: true, reply: '...', sessionComplete: false, skillName: this.name }
    }
    case 'structure-confirm': { ... }
    // ...
    case 'done': {
      await completeWorkflow(wf.id)
      return { handled: true, reply: '...', sessionComplete: true, skillName: this.name }
    }
  }
}
```

**Rules for Workflow Skills:**
- Each step is deterministic TypeScript. LLM calls happen *inside* a step's logic, never for routing between steps.
- `canHandle` must return `true` when `ctx.workflowState?.skillName === this.name` — this is how in-progress workflows resume across sessions.
- `canHandle` must also intercept cancel intent when a workflow is active: check for "stop", "cancel", "never mind" (and Hebrew equivalents) when `ctx.workflowState` is non-null. Handle cancellation before any step logic runs.
- If a step's external call fails, classify it as `RETRYABLE` or `FATAL`. Do not advance. Return a user-facing message appropriate to the classification.
- Advance workflow state using `ctx.workflow.advance()` — never raw DB calls. If `advance()` throws (optimistic lock conflict), reload from `ctx.workflowState` and retry the step logic once.
- Only one active workflow per identity per skill. On a new trigger, check `ctx.workflowState` first — if non-null and same skill, resume it rather than creating a new one.

**StepResult — classify every step outcome:**
```ts
type StepStatus = 'SUCCESS' | 'RETRYABLE' | 'FATAL' | 'PAUSED'
// SUCCESS  → advance to next step
// RETRYABLE → external transient failure; tell user "still working", retry up to 3×
// FATAL    → call ctx.workflow.fail(); notify manager
// PAUSED   → awaiting user input; workflow stays at current step
```

---

## LLM Calls Inside a Skill

You may call the LLM. Rules:

1. Define a typed Zod schema for the expected output
2. Validate the response before using it in any logic
3. On invalid output: return a user-facing error reply — never let raw LLM text flow into your logic

```ts
import { z } from 'zod'

const WebsiteIntentSchema = z.object({
  businessDescription: z.string(),
  preferredStyle: z.enum(['minimal', 'bold', 'professional']),
})

// After calling your LLM:
const parsed = WebsiteIntentSchema.safeParse(rawLlmOutput)
if (!parsed.success) {
  return {
    handled: true,
    reply: ctx.language === 'he'
      ? 'משהו השתבש, בוא ננסה שוב. מה הייתה הכוונה שלך?'
      : "Something went wrong. Could you rephrase that?",
    sessionComplete: false,
    skillName: this.name,
  }
}
const { businessDescription, preferredStyle } = parsed.data
```

---

## Error Handling

`handle()` must never throw an unhandled exception. Wrap your logic:

```ts
async handle(ctx: SkillContext): Promise<SkillOutcome> {
  try {
    // ... skill logic
  } catch (err) {
    // Log the error, then return a graceful reply
    console.error(`[${this.name}] error:`, err)
    return {
      handled: true,
      reply: ctx.language === 'he' ? 'אירעה שגיאה, נסה שוב מאוחר יותר' : 'An error occurred, please try again.',
      sessionComplete: false,
      skillName: this.name,
    }
  }
}
```

---

## What You Can and Cannot Import

**Allowed:**
- `../../shared/skill-types.js` — the contract types
- Any npm package (e.g. `zod`, `axios`, external SDKs)
- Other files within your own skill directory

**Forbidden (ESLint will block CI):**
- `../../domain/**` — core booking, session, auth logic
- `../../adapters/**` — WhatsApp, Calendar, LLM clients
- `../../db/**` — database client and schema
- `../../workers/**` — BullMQ job infrastructure
- `../../routes/**` — HTTP routes

If you need something that isn't in `SkillContext`, the correct path is: open a discussion with Developer A to extend `src/shared/skill-types.ts`. Do not import from core.

---

## Test Pattern

Every skill needs `src/skills/<your-skill>/index.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { yourSkill } from './index.js'
import type { SkillContext } from '../../shared/skill-types.js'

const baseCtx: SkillContext = {
  business: { id: 'biz-1', name: 'Test Biz', timezone: 'Asia/Jerusalem', defaultLanguage: 'en', botPersona: 'neutral', currency: 'ILS' },
  caller: { id: 'caller-1', phoneNumber: '+972500000000', role: 'customer', displayName: null, preferredLanguage: null },
  message: { text: '', receivedAt: new Date() },
  conversationHistory: [],
  language: 'en',
  sessionId: 'session-1',
}

describe('canHandle', () => {
  it('matches intended triggers', () => {
    expect(yourSkill.canHandle({ ...baseCtx, message: { text: 'I need a website', receivedAt: new Date() } })).toBe(true)
  })

  it('does not match booking phrases', () => {
    expect(yourSkill.canHandle({ ...baseCtx, message: { text: 'I want to book an appointment', receivedAt: new Date() } })).toBe(false)
    expect(yourSkill.canHandle({ ...baseCtx, message: { text: 'cancel my booking', receivedAt: new Date() } })).toBe(false)
  })
})

describe('handle', () => {
  it('returns a well-formed SkillOutcome', async () => {
    const result = await yourSkill.handle({ ...baseCtx, message: { text: 'I need a website', receivedAt: new Date() } })
    expect(result.skillName).toBe(yourSkill.name)
    if (result.handled) {
      expect(result.reply.length).toBeGreaterThan(0)
      expect(typeof result.sessionComplete).toBe('boolean')
    }
  })
})
```

---

## Production Checklist (before opening a PR)

- [ ] No `console.log` left in code
- [ ] No `// TODO` or unimplemented stubs
- [ ] All user-facing strings handle both `'he'` and `'en'` via `ctx.language`
- [ ] `canHandle` tested against booking phrases (no false positives)
- [ ] `handle` tested for happy path + error path
- [ ] `sessionComplete` set correctly (not hardcoded `false`)
- [ ] `skillName` returns `this.name` (not a hardcoded string)
- [ ] Import boundary clean (no forbidden imports)
