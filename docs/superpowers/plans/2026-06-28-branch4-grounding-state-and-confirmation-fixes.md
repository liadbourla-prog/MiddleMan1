# Branch-4 Grounding, State Integrity & Confirmation Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kill the live Branch-4 occupancy fabrications, the lost-confirmation/re-greeting bug, the dropped "yes + question", the customer-path race, and the over-eager "call us" nudge — by re-grounding conversational state against the deterministic spine every turn instead of trusting the transcript.

**Architecture:** Six root causes across two doctrine-level families: (A) **grounding drift** — availability truth isn't re-injected on challenge/continuation/unknown turns, and the output gates are date-blind, so a stale "full" belief launders across turns (ROOTs 1, 2); (B) **state integrity** — the pending confirmation is destroyed by a bundled side-question, the affirmative parse drops a trailing question, and the customer path has no concurrency lock, so a valid "yes" lands on empty state (ROOTs 3, 4). ROOT 5 is truthful instructor grounding (the names were real — the blanket prompt ban is wrong and Branch 4 never loads the roster). ROOT 6 gates the nudge behind genuine spine-confirmed no-availability. The load-bearing fix is a **fresh-spine occupancy backstop inside `makeGenReply`** that re-reads the focused day before any "full" claim is allowed out.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Drizzle ORM (Postgres), Redis (locks), Vitest, Gemini via `generateCustomerReply`. Business under test: סטודיוגה `d3c0c1e7-5c75-4b93-aca5-cc4b2bf941de`, tz `Asia/Jerusalem`.

**Verified against live DB (2026-06-28):** Sunday & Monday pilates classes all OPEN (≤1/8) when the PA said "full"; Wed 01/07 16:00 yoga OPEN when the PA said "filled up"; Babar's clean "כן בבקשה" (12:09:16) produced a fresh greeting and no write because the pending hold had been cleared by the prior bundled "כן בבקשה, מי המורה" turn. `listDayOptions` reproduced at now=12:21 IL returns Sunday pilates 14:00 (8) + 18:00 (8) — proving the spine had the truth the model never saw.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/domain/flows/types.ts` | `parseConfirmation` (ROOT 3a) | Modify |
| `src/domain/flows/types.test.ts` | parse tests | Modify |
| `src/domain/flows/slot-fabrication-guard.ts` | date-aware gate helpers (ROOT 2) | Modify |
| `src/domain/flows/slot-fabrication-guard.test.ts` | gate helper tests | Modify |
| `src/domain/flows/customer-booking.ts` | side-question state preservation (3b), unknown-branch grounding (1a), occupancy backstop in `makeGenReply` (1b/2), `buildBusinessFacts` roster (5), nudge gating (6) | Modify |
| `src/domain/flows/customer-booking.test.ts` | `buildBusinessFacts` + helper tests | Modify |
| `src/domain/flows/concurrency-lock.ts` | per-identity customer lock (ROOT 4) | Modify |
| `src/domain/flows/concurrency-lock.test.ts` | lock test | Create |
| `src/routes/webhook.ts` | wire customer lock + load roster into Branch 4 (4, 5) | Modify |
| `ANTI_FABRICATION.md` | taxonomy, date-aware gate, occupancy backstop, instructor grounding, change log | Modify |

**Sequencing rationale:** Pure-function fixes first (Tasks 1, 2) — fully unit-testable, zero wiring risk. Then the state fix that depends on the parse fix (Task 3). Then grounding (Tasks 4–5) which is the highest live impact. Then concurrency (Task 6) and the truthful-instructor grounding (Task 7). Nudge (Task 8) last. Docs (Task 9).

**Test commands:** single file `npx vitest run src/domain/flows/types.test.ts`; full suite `npm test`; typecheck `npx tsc --noEmit`; lint `npx eslint src/domain/flows/customer-booking.ts`.

---

## Task 1: ROOT 3a — `parseConfirmation` accepts a leading affirmative before a trailing question

**Problem:** `parseConfirmation("כן בבקשה, מי המורה דרך אגב?")` returns `'unclear'` because `'מי'/'המורה'` aren't in `CONFIRM_FILLER`. The customer said "yes" and asked a side question; the engine dropped the yes. Same family as the cancellation bug fixed earlier.

**Design:** Keep the strict no/yes/negation ordering. After the leading affirmative, if the remainder is **not all filler**, today we bail to `'unclear'`. Add a narrow rule: when the remainder is a **trailing question** (contains `?`/`؟` or a leading interrogative word), treat the message as a confirmation *with a bundled question* — return a new variant `'yes_with_question'` so the caller can both confirm and answer. A revision ("yes but Tuesday 7pm instead") must still be `'unclear'` — so the rule only fires when the remainder carries **no slot tokens** (no time, no weekday, no service-ish content). Keep it conservative: require an interrogative signal, and reject if `NEG_TOKEN` or a clock time appears anywhere.

**Files:**
- Modify: `src/domain/flows/types.ts:16` (`ConfirmationParse` type), `src/domain/flows/types.ts:64-74` (`parseConfirmation`)
- Test: `src/domain/flows/types.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `src/domain/flows/types.test.ts` (inside the existing `describe('parseConfirmation', …)` block, or add one):

```ts
import { parseConfirmation } from './types.js'

describe('parseConfirmation — bundled yes + question', () => {
  it('treats a leading yes with a trailing question as yes_with_question', () => {
    expect(parseConfirmation('כן בבקשה, מי המורה דרך אגב?')).toBe('yes_with_question')
    expect(parseConfirmation('yes please, who is the instructor?')).toBe('yes_with_question')
  })
  it('still treats a plain leading yes as yes', () => {
    expect(parseConfirmation('כן בבקשה')).toBe('yes')
    expect(parseConfirmation('yes book me please')).toBe('yes')
  })
  it('does NOT confirm a revision that changes the slot', () => {
    expect(parseConfirmation('כן אבל ביום שלישי ב-19:00')).toBe('unclear')
    expect(parseConfirmation('yes but make it Tuesday 19:00')).toBe('unclear')
  })
  it('does NOT confirm when a negation appears', () => {
    expect(parseConfirmation('כן אבל לא בא לי, מתי עוד יש?')).toBe('unclear')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/domain/flows/types.test.ts -t "bundled yes"`
Expected: FAIL — `yes_with_question` not produced (returns `'unclear'`).

- [ ] **Step 3: Implement**

In `src/domain/flows/types.ts`, change the type at line 16:

```ts
export type ConfirmationParse = 'yes' | 'no' | 'unclear' | 'yes_with_question'
```

Add an interrogative detector above `parseConfirmation` (after `confirmationWords`, ~line 62):

```ts
// A trailing question signal: an explicit question mark (he/ar/en) or a leading
// interrogative word. Used to recognise "yes + a side question" without treating a
// slot REVISION as a confirmation.
const QUESTION_RE = /[?؟]/
const INTERROGATIVE_WORDS = new Set([
  'who', 'what', 'when', 'where', 'why', 'how', 'which',
  'מי', 'מה', 'מתי', 'איפה', 'למה', 'איך', 'כמה', 'איזה', 'איזו',
])
```

Replace `parseConfirmation` (lines 64-74) with:

```ts
export function parseConfirmation(text: string): ConfirmationParse {
  if (NO_PATTERNS.test(text)) return 'no'
  if (YES_PATTERNS.test(text)) return 'yes'
  if (NEG_TOKEN.test(text)) return 'unclear'
  const words = confirmationWords(text)
  if (words.length === 0 || !AFFIRM_WORDS.has(words[0]!)) return 'unclear'
  const rest = words.slice(1)
  if (rest.every((w) => CONFIRM_FILLER.has(w))) return 'yes'
  // A leading affirmative followed by a SIDE QUESTION (not a slot revision): confirm,
  // and let the caller answer the question. Reject if it carries a clock time (a likely
  // revision) — weekday/service revisions are caught by the booking-path re-extraction,
  // but a time is the strongest revision signal and must not auto-confirm.
  const hasQuestion = QUESTION_RE.test(text) || rest.some((w) => INTERROGATIVE_WORDS.has(w))
  const hasClockTime = /(?<![\d:])\d{1,2}:\d{2}(?![\d:])/.test(text)
  if (hasQuestion && !hasClockTime) return 'yes_with_question'
  return 'unclear'
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/domain/flows/types.test.ts`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Typecheck for unhandled variant**

Run: `npx tsc --noEmit`
Expected: errors in `customer-booking.ts` / `webhook.ts` where `parseConfirmation` results are switched and `'yes_with_question'` is now unhandled. **This is intended** — Task 3 handles the Branch-4 sites; for Branch-3/onboarding sites in `webhook.ts`, treat `'yes_with_question'` as `'yes'` is wrong there (no pending slot question), so map it to `'unclear'` at those call sites. Apply this minimal mapping in `webhook.ts` everywhere `parseConfirmation(msg.body)` feeds a language-switch yes/no (lines ~789, ~1051) and `provider`/onboarding: `const ans = parseConfirmation(x); const answer = ans === 'yes_with_question' ? 'unclear' : ans`. Do NOT change behaviour there beyond this collapse.

- [ ] **Step 6: Commit**

```bash
git add src/domain/flows/types.ts src/domain/flows/types.test.ts src/routes/webhook.ts
git commit -m "fix(branch4): parseConfirmation accepts leading yes + trailing question (yes_with_question)"
```

---

## Task 2: ROOT 2 — date-aware gate helpers (day-scoped open times)

**Problem:** `extractClockTimes`/`extractFullTimes` are bare `HH:MM`. In Babar B2 the false "Wed 16:00 full" shares the token `16:00` with the offered "Mon 16:00", so `replySurfacesOpen` wrongly spared the lie. Gate 2/3 must reason about **day+time**, not bare time.

**Design:** The situation is system-authored with day headers (`buildDayOptionsText` emits `Classes on <DayLabel>: <svc> at HH:MM (cap)`). Add a pure helper that sections text by day label and returns `Map<dayKey, Set<HH:MM>>`. A "day key" is a normalized day label: English weekday OR Hebrew weekday (`יום ראשון`/`ראשון`…) OR an `en-GB` date fragment (`29 June`). Times appearing before any day token bucket under `''` (unscoped). This is heuristic but deterministic and unit-testable; it converts the cross-day coincidence from a false-negative into a correct catch for the common case.

**Files:**
- Modify: `src/domain/flows/slot-fabrication-guard.ts` (append helpers)
- Test: `src/domain/flows/slot-fabrication-guard.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/domain/flows/slot-fabrication-guard.test.ts`:

```ts
import { extractDayScopedTimes, daysShareOpenTime } from './slot-fabrication-guard.js'

describe('extractDayScopedTimes', () => {
  it('scopes Hebrew day sections', () => {
    const m = extractDayScopedTimes('ביום רביעי יוגה ב-16:00 התמלא. יש יוגה ביום שני ב-16:00 או שלישי ב-10:00')
    expect([...(m.get('רביעי') ?? [])]).toContain('16:00')
    expect([...(m.get('שני') ?? [])]).toContain('16:00')
    expect([...(m.get('שלישי') ?? [])]).toContain('10:00')
  })
  it('scopes English day sections', () => {
    const m = extractDayScopedTimes('Classes on Monday: yoga at 16:00. Tuesday: yoga at 10:00.')
    expect([...(m.get('monday') ?? [])]).toContain('16:00')
    expect([...(m.get('tuesday') ?? [])]).toContain('10:00')
  })
})

describe('daysShareOpenTime', () => {
  it('returns true only when the SAME day shares the time', () => {
    const situationOpen = new Map([['שני', new Set(['16:00'])]]) // Mon 16:00 open
    // Reply surfaces Mon 16:00 (open) — same day/time → spared
    expect(daysShareOpenTime(situationOpen, extractDayScopedTimes('ביום שני ב-16:00 פנוי'))).toBe(true)
    // Reply only mentions Wed 16:00 — different day → NOT spared
    expect(daysShareOpenTime(situationOpen, extractDayScopedTimes('ביום רביעי ב-16:00'))).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/domain/flows/slot-fabrication-guard.test.ts -t "DayScoped"`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement**

Append to `src/domain/flows/slot-fabrication-guard.ts`:

```ts
// Day tokens we section text on. Hebrew weekday cores (with/without "יום") + English
// weekday names. Order matters: longer/explicit first so "יום ראשון" wins over "ראשון".
const DAY_TOKENS: Array<{ re: RegExp; key: string }> = [
  { re: /\bsunday\b/i, key: 'sunday' }, { re: /\bmonday\b/i, key: 'monday' },
  { re: /\btuesday\b/i, key: 'tuesday' }, { re: /\bwednesday\b/i, key: 'wednesday' },
  { re: /\bthursday\b/i, key: 'thursday' }, { re: /\bfriday\b/i, key: 'friday' },
  { re: /\bsaturday\b/i, key: 'saturday' },
  { re: /ראשון/, key: 'ראשון' }, { re: /שני/, key: 'שני' }, { re: /שלישי/, key: 'שלישי' },
  { re: /רביעי/, key: 'רביעי' }, { re: /חמישי/, key: 'חמישי' }, { re: /שישי/, key: 'שישי' },
  { re: /שבת/, key: 'שבת' },
]

// Find the day key whose token appears latest at-or-before `idx` in `text`.
function dayKeyAt(text: string, idx: number): string {
  let best = ''
  let bestPos = -1
  for (const { re, key } of DAY_TOKENS) {
    const m = text.slice(0, idx).match(new RegExp(re.source + '(?![\\s\\S]*' + re.source + ')', re.flags))
    if (m && m.index != null && m.index > bestPos) { bestPos = m.index; best = key }
  }
  return best
}

/**
 * Map of day key -> set of canonical HH:MM in that day's section. Each clock time is
 * attributed to the nearest preceding day token (or '' when none precedes it). Pure.
 */
export function extractDayScopedTimes(text: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  if (!text) return out
  for (const m of text.matchAll(CLOCK_RE)) {
    const canon = canonicalTime(Number(m[1]), Number(m[2]))
    if (!canon || m.index == null) continue
    const key = dayKeyAt(text, m.index)
    if (!out.has(key)) out.set(key, new Set())
    out.get(key)!.add(canon)
  }
  return out
}

/**
 * True when `reply` surfaces at least one open time on the SAME day it is open in
 * `situationOpen`. Unscoped ('') situation times match any reply day (back-compat).
 */
export function daysShareOpenTime(
  situationOpen: Map<string, Set<string>>,
  replyTimes: Map<string, Set<string>>,
): boolean {
  for (const [day, times] of situationOpen) {
    const replySet = day === '' 
      ? new Set([...replyTimes.values()].flatMap((s) => [...s]))
      : replyTimes.get(day)
    if (replySet && [...times].some((t) => replySet.has(t))) return true
  }
  return false
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/domain/flows/slot-fabrication-guard.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/domain/flows/slot-fabrication-guard.ts src/domain/flows/slot-fabrication-guard.test.ts
git commit -m "feat(branch4): day-scoped time extraction for date-aware occupancy gate"
```

---

## Task 3: ROOT 3b — preserve the pending confirmation when the customer bundles a side-question

**Problem:** While `awaitingConfirmationFor === 'hold'`, "כן בבקשה, מי המורה" parsed as `'unclear'` (pre-Task-1) → `rebuildOnSlotPivot` classified the teacher question as an `inquiry` → the **`isRedirect`** branch cleared `pendingSlot`/`awaitingConfirmationFor` and set the session to `active`. The next clean "כן בבקשה" then had nothing to confirm → fresh greeting, no booking. The customer never abandoned the booking — they asked a side question.

**Design:** Two guards in `handleHoldConfirmation`:
1. **`yes_with_question` (from Task 1):** treat as a confirmation. Proceed exactly as `'yes'` does, but append a one-line answer hint to the situation so the reply also addresses the question. Simplest robust form: confirm the booking (the existing yes path) — the side question (e.g. "who's the instructor") is answered by the grounded reply because `businessFacts` now includes the roster (Task 7). No separate redirect.
2. **A pure inquiry while awaiting confirmation must NOT clear the hold:** in `rebuildOnSlotPivot`, the `isRedirect` branch currently clears the pending slot for `inquiry`/`list_bookings`. Change: when `session.state === 'waiting_confirmation' && ctx.awaitingConfirmationFor === 'hold'`, an `inquiry`/`list_bookings` is a *side question*, not abandonment → do **not** clear the hold; return `null` so `handleHoldConfirmation` falls through to the `unclear` re-ask, which restates the exact pending slot. (Cancellation still redirects — that IS leaving the booking.)

**Files:**
- Modify: `src/domain/flows/customer-booking.ts` — `rebuildOnSlotPivot` (lines ~1331-1334) and `handleHoldConfirmation` (lines ~1797-1842)

- [ ] **Step 1: Guard the redirect against side-questions during a pending hold**

In `rebuildOnSlotPivot`, replace the `isRedirect` definition (lines ~1332-1334):

```ts
  const isRebuild = (intent.intent === 'booking' || intent.intent === 'rescheduling') && hasNewSlot
  // A pure inquiry / list while a HOLD is awaiting confirmation is a SIDE QUESTION, not
  // abandonment — do NOT redirect (which would clear the pending slot). Only a cancellation
  // (genuinely leaving the booking) still redirects from the confirmation step.
  const awaitingHold = session.state === 'waiting_confirmation' && ctx.awaitingConfirmationFor === 'hold'
  const isRedirect = !isRebuild && (
    intent.intent === 'cancellation' ||
    (!awaitingHold && (intent.intent === 'inquiry' || intent.intent === 'list_bookings'))
  )
```

- [ ] **Step 2: Handle `yes_with_question` as a confirmation in `handleHoldConfirmation`**

In `handleHoldConfirmation` (line ~1797), replace:

```ts
  const confirmation = parseConfirmation(messageText)

  // Root B: a non-"yes" reply may be REVISING the slot, not answering. If so, rebuild
  if (confirmation !== 'yes') {
```

with:

```ts
  const parsed = parseConfirmation(messageText)
  // A leading yes bundled with a side question (Task 1) is still a confirmation — the
  // grounded reply answers the question (roster/facts are in businessFacts).
  const confirmation: 'yes' | 'no' | 'unclear' = parsed === 'yes_with_question' ? 'yes' : parsed

  // Root B: a non-"yes" reply may be REVISING the slot, not answering. If so, rebuild
  if (confirmation !== 'yes') {
```

Leave the rest of `handleHoldConfirmation` unchanged — the existing `confirmation === 'yes'` path now also serves `yes_with_question`.

- [ ] **Step 3: Apply the same `yes_with_question`→`yes` collapse in cancellation confirmation**

In `handleCancellationConfirmation` (line ~2394), replace `const confirmation = parseConfirmation(messageText)` with:

```ts
  const parsedCancel = parseConfirmation(messageText)
  const confirmation: 'yes' | 'no' | 'unclear' = parsedCancel === 'yes_with_question' ? 'yes' : parsedCancel
```

(A "yes, but when's the next slot?" on a cancel confirm is still a yes-to-cancel; the side question is non-destructive.)

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS — no remaining unhandled `'yes_with_question'` in Branch 4.

- [ ] **Step 5: Manual reproduction check (documented, no live send)**

Re-run the spine/trace mentally against Babar's transcript: 12:08:49 "כן בבקשה, מי המורה" → `yes_with_question` → `confirmation='yes'` → group-class `directlyConfirmed` → booked on the FIRST yes; no orphaned second turn. Record this expectation in the commit body.

- [ ] **Step 6: Commit**

```bash
git add src/domain/flows/customer-booking.ts
git commit -m "fix(branch4): keep pending hold on a bundled side-question; treat yes+question as confirm

Babar lost-confirmation root: an inquiry during waiting_confirmation cleared the hold
via rebuildOnSlotPivot's redirect; a clean 'yes' then hit empty state and re-greeted.
Now a side-question never discards the pending slot, and yes+question confirms directly."
```

---

## Task 4: ROOT 1 — fresh-spine occupancy backstop in `makeGenReply` (+ broaden grounding)

**Problem (the live failure):** On challenge/continuation/unknown turns the handler does not re-inject the focused day's availability, so the model recycles a stale "full" from the transcript and Gate 3 is blind (its `openOffered` signal is empty). Verified: spine had Sunday pilates 14:00/18:00 open at 12:21 IL, but the PA said "אין מקום" and Gate 3 never fired.

**Design — the load-bearing fix:** Give `makeGenReply` an async **fresh-spine check** for the focused day, plus a per-turn `focusDay` passed via the reply `opts`. Gate 3 becomes: if the reply `assertsNoAvailability` AND a `focusDay` is in play AND the spine shows that day has open classes/slots → regenerate with the real options injected, then `OCCUPANCY_FALLBACK`. This is independent of which branch produced the reply and re-grounds before any "full" claim escapes — the anti-laundering guarantee the doctrine demands. The pre-existing situation-embedded `openOffered` signal stays as a cheap first check; the spine read is the authority when a `focusDay` exists.

`focusDay` is set by every branch that talks about a specific day: the time-missing booking branch, the class-gate branch, the inquiry day-branch, the unavailable-slot reoffer, and the unknown/default branch (Step 6).

**Files:**
- Modify: `src/domain/flows/customer-booking.ts` — `GenReply` type (~545), `makeGenReply` (~585-650), `handleBookingFlow` factory call (~769), and the call sites that know a day.

- [ ] **Step 1: Extend the `GenReply` type and factory signature**

Replace the `GenReply` type (lines ~545-548) with:

```ts
type GenReply = (
  input: Parameters<typeof generateCustomerReply>[0],
  opts?: { bookingConfirmed?: boolean; focusDay?: { dateStr: string; serviceTypeId?: string } },
) => Promise<string>
```

Change `makeGenReply` signature (line ~585) to close over a spine reader:

```ts
function makeGenReply(
  businessFacts: string,
  actionLedger: string,
  timeGuard: { boundaryTimes: string[]; bookingTimes: string[] },
  dayHasOpenOptions: (dateStr: string, serviceTypeId?: string) => Promise<{ open: boolean; text: string | null }>,
): GenReply {
```

- [ ] **Step 2: Rework Gate 3 to use the fresh-spine backstop + day-scoped check**

Inside `makeGenReply`'s returned function, replace the entire Gate 3 block (lines ~622-646) with:

```ts
    // Gate 3 — fabricated unavailability (occupancy). Two signals, strongest first:
    //  (a) Fresh-spine backstop: if a focusDay is in play and the reply asserts blanket
    //      fullness, RE-READ that day from the spine. If it has open options, the claim
    //      is a laundered lie regardless of what the situation text held — regenerate
    //      with the real options, then OCCUPANCY_FALLBACK. (Kills cross-turn laundering.)
    //  (b) Situation signal (back-compat): open interior times present in the situation
    //      that the reply hides, now compared DAY-SCOPED so a cross-day HH:MM coincidence
    //      no longer spares a specific-slot false-full.
    if (assertsNoAvailability(reply)) {
      // (a) spine backstop
      if (opts.focusDay) {
        const spine = await dayHasOpenOptions(opts.focusDay.dateStr, opts.focusDay.serviceTypeId)
        if (spine.open) {
          const corrected = await generateCustomerReply({
            ...grounded,
            situation: `${input.situation}\n\n${OCCUPANCY_GUARD_INSTRUCTION}${spine.text ? ` Real open options: ${spine.text}` : ''}`,
          })
          return assertsNoAvailability(corrected) && !replySurfacesAnyTime(corrected)
            ? OCCUPANCY_FALLBACK[input.language]
            : corrected
        }
      }
      // (b) situation signal, day-scoped
      const situationOpen = extractDayScopedTimes(input.situation ?? '')
      for (const set of situationOpen.values()) {
        for (const t of timeGuard.boundaryTimes) set.delete(t)
        for (const t of timeGuard.bookingTimes) set.delete(t)
      }
      for (const t of extractFullTimes(input.situation ?? '')) {
        for (const set of situationOpen.values()) set.delete(t)
      }
      const anyOpen = [...situationOpen.values()].some((s) => s.size > 0)
      if (anyOpen && !daysShareOpenTime(situationOpen, extractDayScopedTimes(reply))) {
        const corrected = await generateCustomerReply({
          ...grounded,
          situation: `${input.situation}\n\n${OCCUPANCY_GUARD_INSTRUCTION}`,
        })
        reply = assertsNoAvailability(corrected) && !daysShareOpenTime(situationOpen, extractDayScopedTimes(corrected))
          ? OCCUPANCY_FALLBACK[input.language]
          : corrected
      }
    }

    return reply
```

Add the small helper near the top of `makeGenReply`'s body (above the `let reply = ...`) — a reply that states ANY clock time is treated as surfacing an option for the spine-backstop branch:

```ts
    const replySurfacesAnyTime = (text: string): boolean => extractClockTimes(text).length > 0
```

Add imports at the top of the file (line ~14) — extend the existing `slot-fabrication-guard` import:

```ts
import { extractClockTimes, extractMentionedTimes, findUnbackedTimes, canonicalTime, extractFullTimes, assertsNoAvailability, extractDayScopedTimes, daysShareOpenTime } from './slot-fabrication-guard.js'
```

- [ ] **Step 3: Implement `dayHasOpenOptions` and pass it to the factory**

In `handleBookingFlow`, just before `const genReply = makeGenReply(...)` (line ~769), add:

```ts
  // Fresh-spine occupancy reader for the output gate: re-reads a focused day's real
  // class/slot availability so a "full" claim can never launder past makeGenReply
  // without a current spine check. Best-effort: a failure reports "not open" (the gate
  // simply doesn't fire — safe), never throws into the reply path.
  const dayHasOpenOptions = async (dateStr: string, serviceTypeId?: string): Promise<{ open: boolean; text: string | null }> => {
    if (!business) return { open: false, text: null }
    try {
      const r = await buildDayOptionsText(db, business, dateStr, businessTimezone, serviceTypeId, undefined)
      return { open: r.offered.length > 0, text: r.text }
    } catch {
      return { open: false, text: null }
    }
  }
```

Change the factory call (line ~769) to:

```ts
  const genReply = makeGenReply(businessFacts, actionLedger, { boundaryTimes, bookingTimes }, dayHasOpenOptions)
```

- [ ] **Step 4: Pass `focusDay` from the branches that name a day**

Add `focusDay` to the `genReply(...)` calls that discuss a specific day. For each, the day is already resolved locally:

- **Time-missing booking branch** (line ~1512): add `, { focusDay: { dateStr: draft.dateStr!, serviceTypeId: draft.serviceTypeId } }` as the 2nd arg.
- **Class-gate branch** (`classInstanceMissing`, line ~1620): `, { focusDay: { dateStr: localParts(slotStart, businessTimezone).dateStr, serviceTypeId: svc.id } }`.
- **Slot-unavailable reoffer in `handleHoldConfirmation`** (line ~2005): `, { focusDay: { dateStr: localParts(new Date(pendingSlot.start), businessTimezone).dateStr, serviceTypeId: pendingSlot.serviceTypeId } }`.
- **Inquiry day-branch** (line ~1075, the `inquiryReply`): when `resolvedDay?.ok`, pass `, { focusDay: { dateStr: resolvedDay.dateStr, ...(inquiryService ? { serviceTypeId: inquiryService.id } : {}) } }`. (Hoist `resolvedDay`/`inquiryService` so they're in scope at the reply call — they are declared in the same `case 'inquiry'` block.)

Each `genReply(input)` becomes `genReply(input, { focusDay })`.

- [ ] **Step 5: Verify the existing occupancy test still holds + add a day-scoped test**

The §6 "Monday completely full after listing 11/14/18" case must still be caught by signal (b). Add an integration-style unit test asserting the day-scoped logic in `slot-fabrication-guard.test.ts` is already covered by Task 2. For `makeGenReply` itself (impure), add a note: covered by manual reproduction (Step 7) — there is no existing unit harness for `makeGenReply`; do not invent one in this task.

- [ ] **Step 6: Broaden grounding into the unknown/default branch**

In the `default:` case of the intent switch (lines ~1109-1160), before building `unknownSituation`, resolve a focus day from the current intent or the carried draft and inject real options so a challenge/continuation never recycles a stale "full":

```ts
        // Re-ground: if this turn references a day (or continues an in-flight one), inject
        // that day's REAL options so a challenge ("are you sure it's full?") or continuation
        // ("I want to join") is answered from the spine, never from a stale transcript claim.
        let unknownFocus: { dateStr: string; serviceTypeId?: string } | undefined
        let unknownDayText: string | null = null
        if (business) {
          const dp = intent.slotRequest && (intent.slotRequest.relativeDay || intent.slotRequest.weekday != null || intent.slotRequest.explicitDate)
            ? resolveRequestedDate({ relativeDay: intent.slotRequest.relativeDay ?? null, weekday: intent.slotRequest.weekday ?? null, explicitDate: intent.slotRequest.explicitDate ?? null }, businessTimezone, new Date())
            : null
          const focusDateStr = (dp?.ok ? dp.dateStr : undefined) ?? updatedCtx.slotDraft?.dateStr
          const focusSvc = resolveService(intent.serviceTypeHint, activeServices)?.id ?? updatedCtx.slotDraft?.serviceTypeId
          if (focusDateStr) {
            const r = await buildDayOptionsText(db, business, focusDateStr, businessTimezone, focusSvc, updatedCtx.negotiationConstraints)
            unknownDayText = r.text
            unknownFocus = { dateStr: focusDateStr, ...(focusSvc ? { serviceTypeId: focusSvc } : {}) }
          }
        }
```

Append `unknownDayText` to the mid-conversation `unknownSituation` strings (the two non-greet branches): add ` ${unknownDayText ? 'Real options for the day in question: ' + unknownDayText + ' Never say a day/class is full if options are listed here.' : ''}`. Pass the focus to the reply: `const unknownReply = await genReply({ … }, unknownFocus ? { focusDay: unknownFocus } : undefined)`.

- [ ] **Step 7: Typecheck + lint + manual reproduction**

Run: `npx tsc --noEmit` → PASS. Run: `npx eslint src/domain/flows/customer-booking.ts` → no new errors.
Manual: trace Jonny 12:20 "בטוח אין מקום בראשון?" — now classified unknown/inquiry, `focusDay=Sunday/pilates`, spine backstop sees 14:00/18:00 open → "full" reply is regenerated/falls back to OCCUPANCY_FALLBACK. Document in commit body.

- [ ] **Step 8: Commit**

```bash
git add src/domain/flows/customer-booking.ts
git commit -m "fix(branch4): occupancy truth — fresh-spine backstop in makeGenReply + day-scoped gate + unknown-branch grounding

Re-reads the focused day from the spine before any 'full' claim escapes, so a stale
occupancy belief can no longer launder across challenge/continuation/unknown turns
(verified: Sunday pilates 14:00/18:00 open while PA said 'full')."
```

---

## Task 5: ROOT 6 — gate the "call us" nudge behind genuine no-availability

**Problem:** `nudgeAfterRepeatedTries` fires once `clarificationAttempts` hits `MAX_CLARIFICATION_ATTEMPTS` (4). In Jonny's chat the dead-ends were **fabricated** unavailability, so the counter inflated on lies and the PA prematurely suggested a phone call. With Task 4 the fabrications stop, which removes most of this — but the counter still rises on legitimately-empty days; the nudge should only fire when the spine genuinely has nothing for the customer's service over the horizon.

**Design:** Before nudging, do a spine check: if the focused service has ANY upcoming open class/slot in the next 14 days, do **not** nudge — instead reset and offer the next real options. Only nudge when the spine is truly empty (or no business).

**Files:**
- Modify: `src/domain/flows/customer-booking.ts` — `handleBookingIntent` `nudgeAfterRepeatedTries` (lines ~1454-1467)

- [ ] **Step 1: Replace `nudgeAfterRepeatedTries` body**

```ts
  const nudgeAfterRepeatedTries = async (): Promise<FlowResult> => {
    // Only nudge toward a phone call when the spine GENUINELY has nothing — never on a
    // string of fabricated/empty turns. If real options exist, surface them instead.
    const svcId = draft.serviceTypeId
    const next = business
      ? await suggestNextClassesText(db, business, svcId, businessTimezone, ctx.negotiationConstraints).catch(() => NO_SUGGESTION)
      : NO_SUGGESTION
    const { dateStr: _droppedDate, time: _droppedTime, ...keptDraft } = draft
    if (next.text) {
      await updateSessionContext(db, session.id, {
        ...ctx, slotDraft: keptDraft, clarificationAttempts: 0,
        ...(next.offered.length > 0 ? { lastOfferedSlots: next.offered } : {}),
      }, 'waiting_clarification')
      const reply = await genReply({
        businessTimezone, businessName, language: lang, transcript, ...persona, customerMemory: extractMemory(ctx),
        situation: `The customer has gone back and forth on dates/times. Don't suggest a phone call — there ARE real upcoming options: ${next.text} Offer these and ask which they'd like. Do NOT say anything is full.`,
      })
      return { reply, sessionComplete: false }
    }
    await updateSessionContext(db, session.id, { ...ctx, slotDraft: keptDraft, clarificationAttempts: 0 }, 'waiting_clarification')
    const reply = await genReply({
      businessTimezone, businessName, language: lang, transcript, ...persona, customerMemory: extractMemory(ctx),
      situation: 'The customer has struggled to land on a workable date/time after several tries, and there are genuinely no upcoming openings to offer. Warmly suggest it might be quickest to sort out by phone with the business — but stay open: invite them to name another day and you will keep trying. Do NOT end the conversation or say goodbye.',
    })
    return { reply, sessionComplete: false }
  }
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit` → PASS.

- [ ] **Step 3: Commit**

```bash
git add src/domain/flows/customer-booking.ts
git commit -m "fix(branch4): only nudge to phone when the spine genuinely has no openings"
```

---

## Task 6: ROOT 4 — per-identity concurrency lock on the customer path

**Problem:** The manager path runs in `withBusinessLock`; the customer path does not. Two customer messages 12s apart (beyond the coalescer's debounce) processed concurrently and produced an interleaved, nonsensical reply (Jonny 11:49:33). A race on the session row can also drop in-flight booking state.

**Design:** Add a **per-identity** lock (`lock:customer:<identityId>`) that, on contention, **waits and retries** (turns serialize rather than drop — dropping a customer turn is worse than a short delay). Add `withIdentityLock(identityId, fn)` to `concurrency-lock.ts` reusing `acquireLock`/`releaseLock` with an identity-scoped key, polling for up to ~8s. Wrap the customer flow body in `routeCustomerMessage`.

**Files:**
- Modify: `src/domain/flows/concurrency-lock.ts`
- Create: `src/domain/flows/concurrency-lock.test.ts`
- Modify: `src/routes/webhook.ts` — `routeCustomerMessage`

- [ ] **Step 1: Write failing test (lock serializes)**

Create `src/domain/flows/concurrency-lock.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// In-memory redis stub: SET NX PX + DEL semantics enough for the lock.
const store = new Map<string, string>()
vi.mock('../../redis.js', () => ({
  redis: {
    set: async (k: string, v: string, _px: string, _ms: number, nx: string) => {
      if (nx === 'NX' && store.has(k)) return null
      store.set(k, v); return 'OK'
    },
    eval: async (_s: string, _n: number, k: string, v: string) => {
      if (store.get(k) === v) { store.delete(k); return 1 } return 0
    },
    rpush: async () => 1, expire: async () => 1, lpop: async () => null,
  },
}))

import { withIdentityLock } from './concurrency-lock.js'

beforeEach(() => store.clear())

describe('withIdentityLock', () => {
  it('serializes two concurrent runs for the same identity', async () => {
    const order: string[] = []
    const slow = withIdentityLock('id1', async () => { order.push('a-start'); await new Promise(r => setTimeout(r, 50)); order.push('a-end') })
    const fast = withIdentityLock('id1', async () => { order.push('b-run') })
    await Promise.all([slow, fast])
    expect(order).toEqual(['a-start', 'a-end', 'b-run'])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/domain/flows/concurrency-lock.test.ts`
Expected: FAIL — `withIdentityLock` not exported.

- [ ] **Step 3: Implement `withIdentityLock`**

Append to `src/domain/flows/concurrency-lock.ts`:

```ts
function customerLockKey(identityId: string): string {
  return `lock:customer:${identityId}`
}

async function acquireIdentityLock(identityId: string): Promise<string | null> {
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const result = await redis.set(customerLockKey(identityId), token, 'PX', LOCK_TTL_MS, 'NX')
  return result === 'OK' ? token : null
}

async function releaseIdentityLock(identityId: string, token: string): Promise<void> {
  const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`
  await redis.eval(script, 1, customerLockKey(identityId), token)
}

/**
 * Run fn while holding a per-identity lock, SERIALIZING concurrent turns from the same
 * customer (a customer turn must not be dropped — unlike Branch 3, which enqueues). On
 * contention, poll for the lock up to ~8s; if still unavailable (a wedged holder), give
 * up the lock-wait and run anyway so the customer is never left unanswered.
 */
export async function withIdentityLock<T>(identityId: string, fn: () => Promise<T>): Promise<T> {
  let token: string | null = null
  for (let i = 0; i < 40 && !token; i++) {
    token = await acquireIdentityLock(identityId)
    if (!token) await new Promise((r) => setTimeout(r, 200))
  }
  try {
    return await fn()
  } finally {
    if (token) await releaseIdentityLock(identityId, token)
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/domain/flows/concurrency-lock.test.ts`
Expected: PASS.

- [ ] **Step 5: Wrap the customer flow**

In `src/routes/webhook.ts`, add the import (near line 54):

```ts
import { withBusinessLock, withIdentityLock } from '../domain/flows/concurrency-lock.js'
```

(Remove the now-duplicate `withBusinessLock` import on line 54 if it stands alone.)

In `routeCustomerMessage`, wrap from the `saveMessage` inbound (line ~605) through the end of the function in `await withIdentityLock(identity.id, async () => { … })`. The session must be (re)loaded **inside** the lock so a queued turn sees the prior turn's committed state. Move the `loadActiveSession`/create block (lines ~556-586) to the **start of the locked closure** so serialized turns re-read fresh session state. Keep the paused-gate and credential setup (which don't touch session state) before the lock.

- [ ] **Step 6: Typecheck + targeted test**

Run: `npx tsc --noEmit` → PASS. Run: `npx vitest run src/routes/webhook.test.ts` → PASS (adjust any test that constructs `routeCustomerMessage` expectations if it asserts call ordering).

- [ ] **Step 7: Commit**

```bash
git add src/domain/flows/concurrency-lock.ts src/domain/flows/concurrency-lock.test.ts src/routes/webhook.ts
git commit -m "fix(branch4): per-identity lock serializes concurrent customer turns (no more interleaved replies)"
```

---

## Task 7: ROOT 5 — truthful instructor grounding (names are real)

**Problem (reclassified):** "דנה ונועה" are **real** instructors the owner configured — not a fabrication. But `buildBusinessFacts` blanket-bans naming any instructor, and Branch 4 never loads the roster, so a truthful instructor answer is unsupported (it worked by luck this time and could name the wrong instructor next time). Per doctrine §1, prompt-only rules aren't a lever — ground it.

**Design:** Load the instructor roster in the Branch-4 customer path and pass a closed-world instructor block into `buildBusinessFacts`: list the real instructors and which services they teach, and change the rule from "never name" to "only these instructors exist — never invent another; do not volunteer them unless the customer asks." This keeps the closed-world guarantee (no invention) while letting the PA answer "who teaches yoga?" truthfully.

**Files:**
- Modify: `src/domain/flows/customer-booking.ts` — `buildBusinessFacts` (~656-680), `handleBookingFlow` signature + facts call (~682-751)
- Modify: `src/routes/webhook.ts` — load roster, pass it to `handleBookingFlow`
- Test: `src/domain/flows/customer-booking.test.ts`

- [ ] **Step 1: Write failing test for `buildBusinessFacts` with roster**

Add to `src/domain/flows/customer-booking.test.ts`:

```ts
import { buildBusinessFacts } from './customer-booking.js'

describe('buildBusinessFacts — instructor roster', () => {
  const svcs = [{ id: 'y', name: 'יוגה', durationMinutes: 60, maxParticipants: 8 }]
  it('lists real instructors and forbids inventing others', () => {
    const out = buildBusinessFacts(svcs, undefined, undefined, [
      { name: 'דנה', services: ['יוגה'] }, { name: 'נועה', services: ['יוגה'] },
    ])
    expect(out).toContain('דנה')
    expect(out).toContain('נועה')
    expect(out).toMatch(/only|exhaustive|do not (?:name|invent)/i)
  })
  it('keeps the no-invent rule when the roster is empty', () => {
    const out = buildBusinessFacts(svcs, undefined, undefined, [])
    expect(out).toMatch(/do NOT (?:name|invent)/i)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/domain/flows/customer-booking.test.ts -t "instructor roster"`
Expected: FAIL — `buildBusinessFacts` has only 3 params.

- [ ] **Step 3: Implement — add the 4th param to `buildBusinessFacts`**

Replace the signature + instructor line (lines ~656-680):

```ts
export function buildBusinessFacts(
  activeServices: Array<{ id: string; name: string; durationMinutes: number; maxParticipants: number }>,
  businessKnowledge: BusinessKnowledge | undefined,
  business: Business | undefined,
  instructors: Array<{ name: string; services: string[] }> = [],
): string {
```

Replace the old instructor line:

```ts
  lines.push('Instructors/staff: do NOT name, list, suggest, or invent any instructor or staff member. If the customer names one, do not confirm or deny by name — say you will check with the business.')
```

with:

```ts
  if (instructors.length > 0) {
    const list = instructors.map((i) => i.services.length > 0 ? `${i.name} (${i.services.join(', ')})` : i.name).join('; ')
    lines.push(`Instructors (this is the COMPLETE list — never name or invent anyone else): ${list}. Do NOT proactively advertise who teaches what; only name an instructor if the customer asks.`)
  } else {
    lines.push('Instructors/staff: none on record — do NOT name, suggest, or invent any instructor. If the customer names one, say you will check with the business.')
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/domain/flows/customer-booking.test.ts -t "instructor roster"`
Expected: PASS.

- [ ] **Step 5: Thread the roster from the webhook into the flow**

In `handleBookingFlow` add a parameter (end of the signature, line ~695):

```ts
  isFirstMessage?: boolean,
  instructorRoster?: Array<{ name: string; services: string[] }>,
```

Update the facts call (line ~751):

```ts
  const businessFacts = buildBusinessFacts(activeServices, businessKnowledge, business, instructorRoster ?? [])
```

In `src/routes/webhook.ts` `routeCustomerMessage`, load the roster alongside `businessKnowledge` (line ~625) using the existing loader:

```ts
import { loadInstructorRoster } from '../domain/provider/roster.js'
```

```ts
  const [businessKnowledge, workflowState, instructorRoster] = await Promise.all([
    loadBusinessKnowledge(db, business.id, business.currency),
    loadActiveWorkflow(db, identity.id),
    loadInstructorRoster(db, business.id).catch(() => []),
  ])
```

Map the roster to the `{ name, services }` shape and pass to `handleBookingFlow` (line ~701) as the new last arg:

```ts
    isFirstMessage,
    instructorRoster.map((r) => ({ name: r.name, services: r.services })),
```

- [ ] **Step 6: Typecheck + full suite**

Run: `npx tsc --noEmit` → PASS. Run: `npm test` → PASS.

- [ ] **Step 7: Commit**

```bash
git add src/domain/flows/customer-booking.ts src/domain/flows/customer-booking.test.ts src/routes/webhook.ts
git commit -m "fix(branch4): ground instructor names in the real roster (closed-world, not a blanket ban)"
```

---

## Task 8: Full-suite + lint gate

- [ ] **Step 1:** Run `npm test` → all PASS.
- [ ] **Step 2:** Run `npx tsc --noEmit` → no errors.
- [ ] **Step 3:** Run `npx eslint src/domain/flows src/routes/webhook.ts` → no new errors (skills-boundary lint unaffected — no `src/skills` change).
- [ ] **Step 4:** If any pre-existing test asserts the old `parseConfirmation`/`buildBusinessFacts`/Gate-3 behaviour, update it to the new contract (do not weaken new assertions).

---

## Task 9: Update `ANTI_FABRICATION.md`

**Files:** Modify `ANTI_FABRICATION.md`

- [ ] **Step 1:** In §3 taxonomy, update the **Occupancy fabrication** row status to note the **cross-turn laundering** failure mode and the **fresh-spine backstop** fix. Remove "Service / staff fabrication" framing for instructors — replace with a note that instructor names are now **roster-grounded** (real names allowed; invention still closed-world-blocked).
- [ ] **Step 2:** In §4.6 / §6 (Gate 3), document: (a) the date-blind limitation is now mitigated by `extractDayScopedTimes`/`daysShareOpenTime`; (b) the **fresh-spine occupancy backstop** in `makeGenReply` (`dayHasOpenOptions` + `focusDay`) is the load-bearing anti-laundering mechanism — "never let a 'full' belief pass without a current spine read."
- [ ] **Step 3:** In §10 limitations, update "Cross-day time coincidence" (now handled day-scoped for the common case) and "Occupancy claims not yet output-gated" (now gated via fresh-spine backstop).
- [ ] **Step 4:** Add a §11 change-log entry summarizing this work (ROOTs 1–6) and that it is **separate from** the time-fabrication gate: also note the **state-integrity** family (parseConfirmation `yes_with_question`, side-question hold preservation, per-identity lock) is a *non-fabrication* reliability fix that shares the doctrine ("re-ground state every turn; never trust the transcript over the core").
- [ ] **Step 5:** Commit.

```bash
git add ANTI_FABRICATION.md
git commit -m "docs(anti-fabrication): occupancy fresh-spine backstop, date-aware gate, instructor grounding, state-integrity family"
```

---

## Out of scope / flagged (do not block this plan)

- **Expired provider WhatsApp token** (MiddleMan onboarding number) — unrelated infra; flag to the owner.
- **Two stale active services** (`פיזיוטרפיית ספורט` d1035e4e, `שיקום` 81e81419) still `is_active=true` — the owner is removing them via the PA; do not touch the DB directly (guardrail).
- **Deploy-during-conversation artifacts** — the lost-confirmation root is the side-question state-clear (Task 3), not the deploy; no code change needed for the deploy itself, but avoid mid-conversation cutovers when possible.

## Self-review notes

- Spec coverage: ROOT 1 → Task 4; ROOT 2 → Tasks 2 + 4; ROOT 3 → Tasks 1 + 3; ROOT 4 → Task 6; ROOT 5 → Task 7; ROOT 6 → Task 5; docs → Task 9. All six covered.
- Type consistency: `ConfirmationParse` gains `'yes_with_question'` (Task 1), collapsed to `'yes'`/`'unclear'` at every call site (Tasks 1 step 5, 3); `GenReply` opts gains `focusDay` (Task 4) used consistently; `buildBusinessFacts` 4th param `instructors: {name, services}[]` matches the roster mapping (Task 7).
- Placeholder scan: every code step contains complete code; no TBD/"handle edge cases".
