# Meeting Coordination — Production Fixes (Round 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two production bugs in the meeting-coordination feature — the PA inventing an owner's name, and coordinating-with-a-customer bypassing the state machine (no boundary enforcement, Branch-4 hijack) — without disturbing normal Branch-4 customer sessions.

**Architecture:** Add a `meeting_coordinations.allowed_windows` column + window-aware `classifyContactReply` so the PA enforces day/time-range boundaries and flags out-of-window proposals to the owner as deviations. Add a business-level `outreach_identity_mode` setting + owner-name persistence so the PA asks how to identify itself instead of fabricating a name. Allow an existing customer to be a coordination counterparty (remove the `phone_not_a_contact` refusal) and hoist the active-coordination lookup ahead of role routing so a customer-counterparty's replies advance the coordination instead of the booking flow.

**Tech Stack:** TypeScript (Node ESM), Drizzle ORM (Postgres), Vitest, Gemini function-calling orchestrator. Run on branch `dev/system/coordination-prod-fixes-round1`. **Do not deploy** — the owner runs `/update-agent` after review.

**Conventions:**
- Tests run with `npm test` (vitest). A single file: `npx vitest run <path>`.
- Type/build check: `npm run build` (tsc). Lint only covers `src/skills` here, irrelevant to this work.
- All imports use the `.js` extension (ESM), even for `.ts` sources.
- Commit after every green task.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/db/schema.ts` | Drizzle schema | Modify — add `businesses.outreachIdentityMode`, `meetingCoordinations.allowedWindows` |
| `src/db/migrations/0025_coordination_windows_identity.sql` | SQL migration | Create |
| `scripts/apply-coordination-migration.ts` | Idempotent applier+verifier | Modify — apply + verify the two new columns |
| `src/domain/coordination/types.ts` | Coordination domain types | Modify — `accept_slot`/`deviation` reply classes, `relay_out_of_window_to_owner` effect |
| `src/domain/coordination/state.ts` | Pure classify + transition | Modify — window-aware classify, new transitions |
| `src/domain/coordination/introducer.ts` | Pure self-identification resolver | Create |
| `src/domain/coordination/repository.ts` | DB access for coordinations | Modify — read/write `allowedWindows` |
| `src/domain/coordination/handler.ts` | Impure orchestration of a coordination | Modify — windows offers, deviation side effect, introducer, `BusinessCtx.introducer` |
| `src/domain/i18n/t.ts` | i18n strings | Modify — `coordination_deviation_to_owner`, introducer-param offer string |
| `src/domain/manager/coordination-tools.ts` | `coordinateMeeting` / `resolveMeetingCoordination` tool handlers | Modify — accept customer, windows arg, identification persistence |
| `src/routes/webhook.ts` | Inbound routing | Modify — routing-first interception via `tryAdvanceActiveCoordination` |
| `src/adapters/llm/orchestrator.ts` | Branch-3 prompt + tool declarations | Modify — prompt hardening, `windows`/`identifyAs` args, outreach-identity context |
| `src/domain/coordination/state.test.ts` | Pure state tests | Modify — window classify + new transitions |
| `src/domain/coordination/introducer.test.ts` | Pure introducer tests | Create |
| `src/domain/coordination/handler-windows.test.ts` | Window flow integration | Create |
| `src/domain/manager/coordination-tools.test.ts` | Tool handler tests | Create |
| `tests/routes/coordination-interception.test.ts` | Routing-first + Branch-4 non-interference | Create |

---

## Task 1: Schema + migration for the two new columns

**Files:**
- Modify: `src/db/schema.ts` (businesses block ~line 65; meetingCoordinations block ~line 640)
- Create: `src/db/migrations/0025_coordination_windows_identity.sql`

- [ ] **Step 1: Add the `businesses.outreachIdentityMode` column**

In `src/db/schema.ts`, in the `businesses` table, immediately after the `freedSlotOfferPolicy` line (~line 65), add:

```ts
  // How the PA introduces itself when reaching out on the owner's behalf during a
  // meeting coordination. null = not yet chosen (the PA asks the owner once).
  outreachIdentityMode: text('outreach_identity_mode', { enum: ['business', 'owner_name'] }),
```

- [ ] **Step 2: Add the `meetingCoordinations.allowedWindows` column**

In `src/db/schema.ts`, in the `meetingCoordinations` table, immediately after the `candidateSlots` line (~line 640), add:

```ts
    // [{ start: ISO, end: ISO }] — owner-given day/time RANGES (acceptable start..end).
    // Null/absent ⇒ the discrete candidateSlots path. The negotiation boundary.
    allowedWindows: jsonb('allowed_windows'),
```

- [ ] **Step 3: Write the migration SQL**

Create `src/db/migrations/0025_coordination_windows_identity.sql`:

```sql
-- Round-1 meeting-coordination fixes. See docs/superpowers/specs/2026-06-22-meeting-coordination-fixes-design.md.
-- Hand-applied (IF NOT EXISTS) — re-runs are safe. Apply via scripts/apply-coordination-migration.ts.

-- Bug 1: business-level self-identification preference for outreach.
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS outreach_identity_mode text
    CHECK (outreach_identity_mode IN ('business', 'owner_name'));

-- Bug 2: day/time-range boundaries for a coordination.
ALTER TABLE meeting_coordinations
  ADD COLUMN IF NOT EXISTS allowed_windows jsonb;
```

- [ ] **Step 4: Verify the project still builds**

Run: `npm run build`
Expected: PASS (no type errors). The new columns are nullable, so existing inserts/selects compile unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/migrations/0025_coordination_windows_identity.sql
git commit -m "feat(coordination): schema + migration for allowed_windows and outreach_identity_mode"
```

---

## Task 2: Domain types for window classification

**Files:**
- Modify: `src/domain/coordination/types.ts`

- [ ] **Step 1: Add the in-window and deviation reply classes**

In `src/domain/coordination/types.ts`, replace the `ContactReplyClass` union with:

```ts
// What the contact's reply resolved to (produced by interpret.ts + classify).
export type ContactReplyClass =
  | { kind: 'accept'; candidateIndex: number }   // picked one of the discrete candidate slots
  | { kind: 'accept_slot'; slot: Slot }          // proposed a time INSIDE an allowed window
  | { kind: 'counter'; slot: Slot }              // proposed a time outside the discrete candidates
  | { kind: 'deviation'; slot: Slot; window: Slot } // proposed a time OUTSIDE the allowed windows
  | { kind: 'decline' }
  | { kind: 'unclear' }
```

- [ ] **Step 2: Add the out-of-window side effect**

In the same file, add one line to the `SideEffect` union, right after the `relay_counter_to_owner` line:

```ts
  | { kind: 'relay_out_of_window_to_owner'; slot: Slot; window: Slot } // out-of-window deviation: flag to owner
```

- [ ] **Step 3: Verify build**

Run: `npm run build`
Expected: FAIL — `state.ts` does not yet handle the new union members (exhaustiveness). This is expected; Task 3 fixes it. (If your tsconfig does not error on this, build PASSES — either is fine to proceed.)

- [ ] **Step 4: Commit**

```bash
git add src/domain/coordination/types.ts
git commit -m "feat(coordination): add accept_slot/deviation reply classes and out-of-window effect"
```

---

## Task 3: Window-aware classify + transitions (pure, TDD)

**Files:**
- Modify: `src/domain/coordination/state.ts`
- Test: `src/domain/coordination/state.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/domain/coordination/state.test.ts`, add after the existing `classifyContactReply` describe block:

```ts
describe('classifyContactReply — windows', () => {
  const w0: Slot = { start: new Date('2026-06-23T07:00:00Z'), end: new Date('2026-06-23T13:00:00Z') } // Tue 10–16 local-ish
  const w1: Slot = { start: new Date('2026-06-24T08:00:00Z'), end: new Date('2026-06-24T12:00:00Z') } // Wed 11–15 local-ish
  const windows = [w0, w1]

  it('an in-window proposal classifies as accept_slot with the proposed slot', () => {
    const proposed: Slot = { start: new Date('2026-06-24T09:00:00Z'), end: new Date('2026-06-24T10:30:00Z') }
    const r = classifyContactReply(proposed, [], windows)
    expect(r).toEqual({ kind: 'accept_slot', slot: proposed })
  })

  it('an out-of-window proposal classifies as deviation with the same-day window', () => {
    const proposed: Slot = { start: new Date('2026-06-24T07:00:00Z'), end: new Date('2026-06-24T08:30:00Z') } // before w1 start
    const r = classifyContactReply(proposed, [], windows)
    expect(r).toEqual({ kind: 'deviation', slot: proposed, window: w1 })
  })

  it('falls back to discrete candidate matching when no windows are given', () => {
    const r = classifyContactReply({ start: new Date('2026-06-26T09:00:00Z'), end: new Date('2026-06-26T10:00:00Z') }, candidates)
    expect(r).toEqual({ kind: 'accept', candidateIndex: 1 })
  })
})

describe('nextCoordinationState — window events', () => {
  const slot: Slot = { start: new Date('2026-06-24T09:00:00Z'), end: new Date('2026-06-24T10:30:00Z') }
  const window: Slot = { start: new Date('2026-06-24T08:00:00Z'), end: new Date('2026-06-24T12:00:00Z') }

  it('accept_slot → awaiting_owner_confirm + ping owner with the proposed slot', () => {
    const r = nextCoordinationState('awaiting_counterparty', { type: 'contact_reply', reply: { kind: 'accept_slot', slot }, candidates })
    expect(r.status).toBe('awaiting_owner_confirm')
    expect(r.effect).toEqual({ kind: 'ping_owner_confirm', slot })
    expect(r.agreedSlot).toEqual(slot)
  })

  it('deviation → countered + relay_out_of_window_to_owner', () => {
    const r = nextCoordinationState('awaiting_counterparty', { type: 'contact_reply', reply: { kind: 'deviation', slot, window }, candidates })
    expect(r.status).toBe('countered')
    expect(r.effect).toEqual({ kind: 'relay_out_of_window_to_owner', slot, window })
    expect(r.counterSlot).toEqual(slot)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/coordination/state.test.ts`
Expected: FAIL — `classifyContactReply` takes 2 args / does not branch on windows; `nextCoordinationState` has no `accept_slot`/`deviation` cases.

- [ ] **Step 3: Implement window-aware classify**

In `src/domain/coordination/state.ts`, replace the `classifyContactReply` function with:

```ts
function sameUtcDay(a: Date, b: Date): boolean {
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10)
}

export function classifyContactReply(
  proposed: Slot,
  candidates: Slot[],
  windows?: Slot[],
): ContactReplyClass {
  // Windows path (Bug 2): boundary is the owner-given day/time ranges.
  if (windows && windows.length > 0) {
    const inWindow = windows.find(
      (w) => proposed.start.getTime() >= w.start.getTime() && proposed.end.getTime() <= w.end.getTime(),
    )
    if (inWindow) return { kind: 'accept_slot', slot: proposed }
    // Out of every window → deviation. Frame against the same-day window when there is
    // one, else the first window (the violated boundary shown to the owner).
    const framed = windows.find((w) => sameUtcDay(w.start, proposed.start)) ?? windows[0]!
    return { kind: 'deviation', slot: proposed, window: framed }
  }

  // Discrete path (unchanged): a start within 5 min of a candidate counts as that candidate.
  const idx = candidates.findIndex(
    (c) => Math.abs(c.start.getTime() - proposed.start.getTime()) <= SLOT_MATCH_MS,
  )
  if (idx >= 0) return { kind: 'accept', candidateIndex: idx }
  return { kind: 'counter', slot: proposed }
}
```

- [ ] **Step 4: Implement the new transitions**

In `src/domain/coordination/state.ts`, inside `nextCoordinationState`, in the `if (event.type === 'contact_reply')` block, add these two branches immediately after the existing `if (r.kind === 'accept') { ... }` block:

```ts
    if (r.kind === 'accept_slot') {
      return { status: 'awaiting_owner_confirm', effect: { kind: 'ping_owner_confirm', slot: r.slot }, agreedSlot: r.slot }
    }
    if (r.kind === 'deviation') {
      return { status: 'countered', effect: { kind: 'relay_out_of_window_to_owner', slot: r.slot, window: r.window }, counterSlot: r.slot }
    }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/domain/coordination/state.test.ts`
Expected: PASS (all old and new cases).

- [ ] **Step 6: Commit**

```bash
git add src/domain/coordination/state.ts src/domain/coordination/state.test.ts
git commit -m "feat(coordination): window-aware classifyContactReply + accept_slot/deviation transitions"
```

---

## Task 4: Pure self-identification resolver (TDD)

**Files:**
- Create: `src/domain/coordination/introducer.ts`
- Test: `src/domain/coordination/introducer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/domain/coordination/introducer.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolveOutreachIntroducer } from './introducer.js'

describe('resolveOutreachIntroducer', () => {
  it('uses the business name when mode is business', () => {
    expect(resolveOutreachIntroducer({ mode: 'business', businessName: 'Studyoga', ownerName: 'Dana', lang: 'en' }))
      .toBe('Studyoga')
  })

  it('uses the owner name in English when mode is owner_name and a real name exists', () => {
    expect(resolveOutreachIntroducer({ mode: 'owner_name', businessName: 'Studyoga', ownerName: 'Dana', lang: 'en' }))
      .toBe("Dana's assistant")
  })

  it('uses the owner name in Hebrew', () => {
    expect(resolveOutreachIntroducer({ mode: 'owner_name', businessName: 'סטודיוגה', ownerName: 'דנה', lang: 'he' }))
      .toBe('העוזר/ת של דנה')
  })

  it('falls back to the business name when owner_name is chosen but the name is the placeholder', () => {
    expect(resolveOutreachIntroducer({ mode: 'owner_name', businessName: 'Studyoga', ownerName: 'Owner', lang: 'en' }))
      .toBe('Studyoga')
  })

  it('falls back to the business name when mode is unset', () => {
    expect(resolveOutreachIntroducer({ mode: null, businessName: 'Studyoga', ownerName: null, lang: 'en' }))
      .toBe('Studyoga')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/domain/coordination/introducer.test.ts`
Expected: FAIL — module `./introducer.js` does not exist.

- [ ] **Step 3: Implement the resolver**

Create `src/domain/coordination/introducer.ts`:

```ts
import type { Lang } from '../i18n/t.js'

// Pure: decide how the PA introduces itself when reaching out on the owner's behalf.
// Never emits the "Owner" placeholder (or an empty name) — falls back to the business
// name so the PA can never leak a placeholder or fabricate a personal name.
export function resolveOutreachIntroducer(opts: {
  mode: 'business' | 'owner_name' | null
  businessName: string
  ownerName: string | null
  lang: Lang
}): string {
  const name = opts.ownerName?.trim() ?? ''
  const isPlaceholder = name === '' || name.toLowerCase() === 'owner'
  if (opts.mode === 'owner_name' && !isPlaceholder) {
    return opts.lang === 'he' ? `העוזר/ת של ${name}` : `${name}'s assistant`
  }
  return opts.businessName
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/domain/coordination/introducer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/coordination/introducer.ts src/domain/coordination/introducer.test.ts
git commit -m "feat(coordination): pure resolveOutreachIntroducer (never fabricates a name)"
```

---

## Task 5: i18n — deviation line + introducer-parameterized offer

**Files:**
- Modify: `src/domain/i18n/t.ts` (coordination block ~line 779)

- [ ] **Step 1: Re-parameterize the offer string to take an introducer**

In `src/domain/i18n/t.ts`, replace the `coordination_offer_to_contact` entry with (rename the first param from `businessName` to `introducer`; the rendered text is unchanged in shape):

```ts
  coordination_offer_to_contact: {
    he: (introducer: string, times: string) => `שלום, מ${introducer} — רוצים לקבוע פגישה. מתאים לך אחד מהמועדים: ${times}? אפשר גם להציע זמן אחר.`,
    en: (introducer: string, times: string) => `Hi, this is ${introducer} — we'd like to set up a meeting. Do any of these work: ${times}? Or suggest another time.`,
  },
```

- [ ] **Step 2: Add the out-of-window deviation line**

In the same coordination block, immediately after `coordination_counter_to_owner`, add:

```ts
  coordination_deviation_to_owner: {
    he: (contact: string, time: string, window: string) => `${contact} מבקש ${time}, אבל הגדרת ${window}. לאשר בכל זאת, או שאבקש זמן בתוך החלון?`,
    en: (contact: string, time: string, window: string) => `${contact} wants ${time}, but you set ${window}. Accept anyway, or should I ask for a time inside your window?`,
  },
```

- [ ] **Step 3: Verify build fails on the renamed callers**

Run: `npm run build`
Expected: FAIL — `handler.ts` still calls `coordination_offer_to_contact[...](ctx.businessName, times)` (still compiles since it's positional string args) AND the new `coordination_deviation_to_owner` is unused yet. In practice this step PASSES the build (positional args unchanged); proceed regardless — Task 6 wires the new line and introducer.

- [ ] **Step 4: Commit**

```bash
git add src/domain/i18n/t.ts
git commit -m "feat(i18n): introducer-parameterized coordination offer + out-of-window deviation line"
```

---

## Task 6: Handler — windows offers, deviation effect, introducer (TDD)

**Files:**
- Modify: `src/domain/coordination/repository.ts`
- Modify: `src/domain/coordination/handler.ts`
- Test: `src/domain/coordination/handler-windows.test.ts`

- [ ] **Step 1: Add `allowedWindows` to the repository row + read/write**

In `src/domain/coordination/repository.ts`:

(a) Add to the `CoordinationRow` interface, after `candidateSlots: Slot[]`:

```ts
  allowedWindows: Slot[]
```

(b) In `hydrate`, after the `candidateSlots: raw.map(...)` line, add a sibling field (and compute `rawW` at the top of the function next to `raw`):

```ts
  const rawW = ((row.allowedWindows as Array<{ start: string; end: string }> | null) ?? [])
```

then add to the returned object:

```ts
    allowedWindows: rawW.map((s) => ({ start: new Date(s.start), end: new Date(s.end) })),
```

(c) Extend `insertCoordination`'s input type and values. Change the signature input to include:

```ts
  durationMinutes: number; candidateSlots: Slot[]; allowedWindows?: Slot[] | null; expiresAt: Date
```

and in the `.values({...})` object add after the `candidateSlots:` line:

```ts
    allowedWindows: input.allowedWindows && input.allowedWindows.length > 0
      ? input.allowedWindows.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() }))
      : null,
```

- [ ] **Step 2: Add `introducer` to `BusinessCtx` + window/format helpers in the handler**

In `src/domain/coordination/handler.ts`:

(a) Add to the `BusinessCtx` interface, after `timezone: string`:

```ts
  introducer?: string  // how the PA identifies itself in outreach; falls back to businessName
```

(b) Add these helpers next to `formatSlot`/`describeCandidates`:

```ts
function formatWindow(w: Slot, ctx: BusinessCtx): string {
  const locale = ctx.lang === 'he' ? 'he-IL' : 'en-GB'
  const date = new Intl.DateTimeFormat(locale, { timeZone: ctx.timezone, weekday: 'long', day: 'numeric', month: 'long' }).format(w.start)
  const t = (d: Date) => new Intl.DateTimeFormat(locale, { timeZone: ctx.timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(d)
  return `${date} ${t(w.start)}–${t(w.end)}`
}

function describeWindows(windows: Slot[], ctx: BusinessCtx): string {
  return windows.map((w) => formatWindow(w, ctx)).join(' / ')
}

// What to offer the contact: the day/time windows when present, else the discrete candidates.
function describeOffer(row: { candidateSlots: Slot[]; allowedWindows: Slot[] }, ctx: BusinessCtx): string {
  return row.allowedWindows.length > 0 ? describeWindows(row.allowedWindows, ctx) : describeCandidates(row.candidateSlots, ctx)
}

function introducerOf(ctx: BusinessCtx): string {
  return ctx.introducer ?? ctx.businessName
}
```

- [ ] **Step 3: Wire windows into `startCoordination`**

In `startCoordination`, replace the body from the availability guard through the `phraseAndSend` offer with:

```ts
  const useWindows = !!input.allowedWindows && input.allowedWindows.length > 0

  // Discrete path keeps the per-candidate availability pre-filter. Windows path offers the
  // owner-given ranges as-is and relies on the book-time availability re-check (no holds).
  let offerSlots = input.candidateSlots
  if (!useWindows) {
    const freeSlots: Slot[] = []
    for (const s of input.candidateSlots) {
      const avail = await calendar.checkAvailability(s)
      if (avail.status === 'available') freeSlots.push(s)
    }
    if (freeSlots.length === 0) return { ok: false, reason: 'no_free_candidates' }
    offerSlots = freeSlots
  }

  const expiresAt = new Date(Date.now() + COORDINATION_EXPIRY_HOURS * 3_600_000)
  const id = await repo.insertCoordination(db, {
    businessId: input.businessId, ownerId: input.ownerId, contactId: input.contactId,
    title: input.title, durationMinutes: input.durationMinutes, candidateSlots: offerSlots,
    allowedWindows: input.allowedWindows ?? null, expiresAt,
  })

  const times = useWindows ? describeWindows(input.allowedWindows!, input.ctx) : describeCandidates(offerSlots, input.ctx)
  const sent = await phraseAndSend({
    toNumber: input.contactPhone,
    situation: `You are reaching out on behalf of the business to set up a meeting ("${input.title}"). Offer these times and invite them to pick one or propose another: ${times}.`,
    fallback: i18n.coordination_offer_to_contact[input.ctx.lang](introducerOf(input.ctx), times),
    ctx: input.ctx,
  })
```

Also extend the `startCoordination` `input` parameter type to include `allowedWindows?: Slot[]`:

```ts
  title: string; durationMinutes: number; candidateSlots: Slot[]; allowedWindows?: Slot[]; ctx: BusinessCtx;
```

- [ ] **Step 4: Pass windows to classify + handle the deviation effect**

In `advanceFromContact`, change the classify call to pass the windows:

```ts
  const reply: ContactReplyClass = intent.kind === 'time'
    ? classifyContactReply(intent.slot, row.candidateSlots, row.allowedWindows)
    : { kind: 'decline' }
```

In the `unclear` branch of `advanceFromContact`, replace the `const times = describeCandidates(row.candidateSlots, ctx)` line and the fallback with the offer helper + introducer:

```ts
      const times = describeOffer(row, ctx)
      await phraseAndSend({
        toNumber: phone,
        situation: `Their reply about the meeting time was unclear. Ask one short question to clarify which of these works, or what time they prefer: ${times}.`,
        fallback: i18n.coordination_offer_to_contact[ctx.lang](introducerOf(ctx), times),
        ctx,
      })
```

In `applyTransition`, add a new `case` immediately after the `relay_counter_to_owner` case:

```ts
    case 'relay_out_of_window_to_owner': {
      // Persist the proposed slot as BOTH counter and agreed, so an owner "confirm" books it.
      await repo.updateCoordination(db, row.id, { status: t.status, counterSlot: e.slot, agreedSlot: e.slot })
      const time = formatSlot(e.slot, ctx)
      const win = formatWindow(e.window, ctx)
      if (owner.phone) await phraseAndSend({
        toNumber: owner.phone,
        situation: `The contact ${contactName} wants ${time} for "${row.title}", but that is OUTSIDE the owner's allowed window (${win}). Surface this as a deviation: ask the owner to accept this out-of-window time, or to have you push for a time inside the window. Do NOT say it is booked.`,
        fallback: i18n.coordination_deviation_to_owner[ctx.lang](contactName, time, win),
        ctx,
      })
      await auditContactReplied('out_of_window', e.slot)
      break
    }
```

In `applyTransition`, update the `message_contact_candidates` and `message_contact_new_candidate` cases to use the offer helper + introducer:

For `message_contact_candidates`, replace its body with:

```ts
    case 'message_contact_candidates': {
      const times = describeOffer(row, ctx)
      if (contact.phone) await phraseAndSend({ toNumber: contact.phone, situation: `Re-send the meeting time options: ${times}.`, fallback: i18n.coordination_offer_to_contact[ctx.lang](introducerOf(ctx), times), ctx })
      break
    }
```

For `message_contact_new_candidate`, change only its `fallback` argument from `i18n.coordination_offer_to_contact[ctx.lang](ctx.businessName, time)` to:

```ts
fallback: i18n.coordination_offer_to_contact[ctx.lang](introducerOf(ctx), time),
```

- [ ] **Step 5: Write the failing window-flow test**

Create `src/domain/coordination/handler-windows.test.ts`:

```ts
import { vi } from 'vitest'

vi.mock('./repository.js', () => ({
  updateCoordination: vi.fn().mockResolvedValue(undefined),
  getIdentityContact: vi.fn().mockResolvedValue({ phone: '+972500000000', name: 'Eyal' }),
  insertCoordination: vi.fn().mockResolvedValue('coord_1'),
  findExpired: vi.fn().mockResolvedValue([]),
}))
vi.mock('../../adapters/whatsapp/sender.js', () => ({ sendMessage: vi.fn().mockResolvedValue({ ok: true }) }))
vi.mock('../../adapters/llm/client.js', () => ({ generateProactiveCustomerMessage: vi.fn().mockResolvedValue('msg') }))
vi.mock('../audit/logger.js', () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }))
vi.mock('./interpret.js', () => ({ interpretContactReply: vi.fn() }))

import { describe, it, expect, beforeEach } from 'vitest'
import { advanceFromContact, type BusinessCtx } from './handler.js'
import { interpretContactReply } from './interpret.js'
import * as repo from './repository.js'
import type { CoordinationRow } from './repository.js'
import type { CalendarClient } from '../../adapters/calendar/client.js'

const ctx: BusinessCtx = { businessId: 'biz_1', businessName: 'Studyoga', lang: 'en', timezone: 'Asia/Jerusalem', waCredentials: undefined }
const calendar = {} as unknown as CalendarClient

function rowWithWindow(): CoordinationRow {
  return {
    id: 'coord_1', businessId: 'biz_1', ownerId: 'owner_1', contactId: 'eyal_1',
    title: 'פגישה עם אייל', durationMinutes: 90,
    candidateSlots: [],
    allowedWindows: [{ start: new Date('2026-06-24T08:00:00Z'), end: new Date('2026-06-24T12:00:00Z') }], // Wed 11–15 local
    status: 'awaiting_counterparty',
    agreedSlotStart: null, agreedSlotEnd: null, expiresAt: new Date('2026-07-10T00:00:00Z'),
  }
}

describe('advanceFromContact — windows', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(repo.getIdentityContact as ReturnType<typeof vi.fn>).mockResolvedValue({ phone: '+972500000000', name: 'Eyal' })
  })

  it('an in-window proposal moves to awaiting_owner_confirm', async () => {
    vi.mocked(interpretContactReply).mockResolvedValue({ kind: 'time', slot: { start: new Date('2026-06-24T09:00:00Z'), end: new Date('2026-06-24T10:30:00Z') } })
    await advanceFromContact({} as never, calendar, rowWithWindow(), 'Wednesday at 12', ctx)
    const calls = (repo.updateCoordination as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.find((c) => c[2]?.status === 'awaiting_owner_confirm')).toBeDefined()
  })

  it('an out-of-window proposal moves to countered (deviation surfaced)', async () => {
    vi.mocked(interpretContactReply).mockResolvedValue({ kind: 'time', slot: { start: new Date('2026-06-24T07:00:00Z'), end: new Date('2026-06-24T08:30:00Z') } })
    await advanceFromContact({} as never, calendar, rowWithWindow(), 'Wednesday at 10', ctx)
    const calls = (repo.updateCoordination as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.find((c) => c[2]?.status === 'countered')).toBeDefined()
  })
})
```

- [ ] **Step 6: Run the window-flow test + the existing handler test**

Run: `npx vitest run src/domain/coordination/handler-windows.test.ts src/domain/coordination/handler.test.ts`
Expected: PASS (new window flow + existing discrete book flow both green).

- [ ] **Step 7: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/domain/coordination/repository.ts src/domain/coordination/handler.ts src/domain/coordination/handler-windows.test.ts
git commit -m "feat(coordination): windows offers, out-of-window deviation, introducer in outreach"
```

---

## Task 7: Tool handler — accept customer counterparty, windows arg, identity persistence (TDD)

**Files:**
- Modify: `src/domain/manager/coordination-tools.ts`
- Test: `src/domain/manager/coordination-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/domain/manager/coordination-tools.test.ts`:

```ts
import { vi } from 'vitest'

const startCoordination = vi.fn().mockResolvedValue({ ok: true, id: 'coord_1' })
vi.mock('../coordination/handler.js', () => ({
  startCoordination: (...a: unknown[]) => startCoordination(...a),
  advanceFromOwner: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../coordination/repository.js', () => ({
  findActiveByContact: vi.fn().mockResolvedValue(null),
  findById: vi.fn().mockResolvedValue(null),
}))
vi.mock('../identity/resolver.js', () => ({
  isValidE164: (p: string) => /^\+[1-9]\d{6,14}$/.test(p),
  registerContact: vi.fn().mockResolvedValue('new_contact_id'),
}))

import { describe, it, expect, beforeEach } from 'vitest'
import { executeCoordinateMeeting } from './coordination-tools.js'

// Minimal chainable DB stub: select().from().where().limit() resolves to `rows`,
// update().set().where() resolves undefined. Each test sets `rows` per call via a queue.
function makeCtx(selectQueue: unknown[][]) {
  let i = 0
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve(selectQueue[i++] ?? []) }) }) }),
    update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
  }
  return {
    db, businessId: 'biz_1', identityId: 'owner_1', timezone: 'Asia/Jerusalem', lang: 'en' as const,
    calendar: {} as never, role: 'manager' as const,
  }
}

const baseArgs = {
  title: 'Meeting with Eyal', phoneNumber: '+972522858870', contactName: 'Eyal',
  durationMinutes: 90,
  windows: [
    { date: { relativeDay: 'tomorrow' as const }, startTime: { hour: 10, minute: 0 }, endTime: { hour: 16, minute: 0 } },
  ],
}

describe('executeCoordinateMeeting — customer counterparty', () => {
  beforeEach(() => { vi.clearAllMocks(); startCoordination.mockResolvedValue({ ok: true, id: 'coord_1' }) })

  it('accepts an existing CUSTOMER as the counterparty (no phone_not_a_contact refusal)', async () => {
    // 1st select: identity lookup by phone → an existing customer.
    // 2nd select: loadBusinessCtx business row. 3rd select: manager displayName.
    const ctx = makeCtx([
      [{ id: 'eyal_1', phone: '+972522858870', role: 'customer' }],
      [{ name: 'Studyoga', whatsappPhoneNumberId: 'wa', whatsappAccessToken: 'tok', outreachIdentityMode: 'business' }],
      [{ name: 'Dana' }],
    ])
    const res = await executeCoordinateMeeting(baseArgs as never, ctx as never)
    expect(res).toMatchObject({ success: true })
    expect(startCoordination).toHaveBeenCalledOnce()
    // counterparty is the existing customer's identity id
    expect(startCoordination.mock.calls[0]![2]).toMatchObject({ contactId: 'eyal_1' })
  })

  it('refuses to coordinate with the owner/staff', async () => {
    const ctx = makeCtx([[{ id: 'mgr_1', phone: '+972522858870', role: 'manager' }]])
    const res = await executeCoordinateMeeting(baseArgs as never, ctx as never)
    expect(res).toMatchObject({ success: false })
    expect(startCoordination).not.toHaveBeenCalled()
  })

  it('passes allowedWindows through to startCoordination', async () => {
    const ctx = makeCtx([
      [{ id: 'eyal_1', phone: '+972522858870', role: 'customer' }],
      [{ name: 'Studyoga', whatsappPhoneNumberId: 'wa', whatsappAccessToken: 'tok', outreachIdentityMode: 'business' }],
      [{ name: 'Dana' }],
    ])
    await executeCoordinateMeeting(baseArgs as never, ctx as never)
    const input = startCoordination.mock.calls[0]![2] as { allowedWindows?: unknown[] }
    expect(Array.isArray(input.allowedWindows)).toBe(true)
    expect(input.allowedWindows!.length).toBe(1)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/domain/manager/coordination-tools.test.ts`
Expected: FAIL — the current handler returns `phone_not_a_contact` for a customer, has no `windows` handling, and `loadBusinessCtx` does not select `outreachIdentityMode`.

- [ ] **Step 3: Update the args interface + imports**

In `src/domain/manager/coordination-tools.ts`:

(a) Add the introducer import near the top imports:

```ts
import { resolveOutreachIntroducer } from '../coordination/introducer.js'
```

(b) Replace the `CoordinateMeetingArgs` interface with:

```ts
interface CoordinateMeetingArgs {
  contactName?: string
  phoneNumber?: string
  title: string
  date?: DatePieces
  startTime?: TimePieces
  endTime?: TimePieces
  durationMinutes?: number
  fallbacks?: Array<{ date: DatePieces; startTime: TimePieces }>
  windows?: Array<{ date: DatePieces; startTime: TimePieces; endTime: TimePieces }>
  identifyAs?: 'business' | 'owner_name'
  ownerName?: string
}
```

- [ ] **Step 4: Add the persistence helper + introducer in `loadBusinessCtx`**

In `src/domain/manager/coordination-tools.ts`, replace `loadBusinessCtx` with:

```ts
async function loadBusinessCtx(ctx: ToolContext): Promise<BusinessCtx> {
  const [biz] = await ctx.db
    .select({ name: businesses.name, whatsappPhoneNumberId: businesses.whatsappPhoneNumberId, whatsappAccessToken: businesses.whatsappAccessToken, outreachIdentityMode: businesses.outreachIdentityMode })
    .from(businesses).where(eq(businesses.id, ctx.businessId)).limit(1)
  const [mgr] = await ctx.db
    .select({ name: identities.displayName })
    .from(identities).where(and(eq(identities.businessId, ctx.businessId), eq(identities.role, 'manager'))).limit(1)
  const introducer = resolveOutreachIntroducer({
    mode: (biz?.outreachIdentityMode as 'business' | 'owner_name' | null) ?? null,
    businessName: biz?.name ?? '',
    ownerName: mgr?.name ?? null,
    lang: ctx.lang,
  })
  return {
    businessId: ctx.businessId,
    businessName: biz?.name ?? '',
    lang: ctx.lang,
    timezone: ctx.timezone,
    waCredentials: biz?.whatsappPhoneNumberId && biz.whatsappAccessToken
      ? { accessToken: biz.whatsappAccessToken, phoneNumberId: biz.whatsappPhoneNumberId }
      : undefined,
    introducer,
  }
}

// Persist the owner's self-identification choice so the PA never re-asks and never
// fabricates a name. mode → businesses; a real owner name → the manager's displayName.
async function persistOutreachIdentity(ctx: ToolContext, identifyAs?: 'business' | 'owner_name', ownerName?: string): Promise<void> {
  if (!identifyAs) return
  await ctx.db.update(businesses).set({ outreachIdentityMode: identifyAs }).where(eq(businesses.id, ctx.businessId))
  if (identifyAs === 'owner_name' && ownerName?.trim()) {
    await ctx.db.update(identities).set({ displayName: ownerName.trim() })
      .where(and(eq(identities.businessId, ctx.businessId), eq(identities.role, 'manager')))
  }
}
```

- [ ] **Step 5: Rewrite the body of `executeCoordinateMeeting`**

In `src/domain/manager/coordination-tools.ts`, replace the body of `executeCoordinateMeeting` (everything after the `ownerAuth` guard, through the final return) with:

```ts
  // Persist the identification preference (if the owner just answered) BEFORE building
  // the business context, so the resolved introducer reflects the new choice.
  await persistOutreachIdentity(ctx, args.identifyAs, args.ownerName)

  // 1. Resolve the negotiation boundary: day/time WINDOWS, or a discrete primary + fallbacks.
  let candidateSlots: Slot[] = []
  let allowedWindows: Slot[] | undefined
  let durationMinutes: number

  if (args.windows && args.windows.length > 0) {
    if (!args.durationMinutes || args.durationMinutes <= 0) {
      return { success: false, needsClarification: true, reason: 'no_duration', guidance: 'Ask the owner how long the meeting should run (e.g. 90 minutes).' }
    }
    durationMinutes = args.durationMinutes
    const wins: Slot[] = []
    for (const w of args.windows) {
      const r = resolveSlotRange({ date: toParts(w.date), startTime: w.startTime, endTime: w.endTime, durationMinutes: null }, ctx.timezone, new Date())
      if (r.ok && (r.end.getTime() - r.start.getTime()) >= durationMinutes * 60000) wins.push({ start: r.start, end: r.end })
    }
    if (wins.length === 0) {
      return { success: false, needsClarification: true, reason: 'no_valid_windows', guidance: 'Ask the owner for day/time windows wide enough to fit the meeting.' }
    }
    allowedWindows = wins
  } else {
    if (!args.date || !args.startTime) {
      return { success: false, needsClarification: true, reason: 'no_time', guidance: 'Ask the owner for a primary time (and how long the meeting runs), or for day/time windows.' }
    }
    const primary = resolveSlotRange(
      { date: toParts(args.date), startTime: args.startTime, endTime: args.endTime ?? null, durationMinutes: args.durationMinutes ?? null },
      ctx.timezone, new Date(),
    )
    if (!primary.ok) {
      return { success: false, needsClarification: true, reason: primary.reason, guidance: 'Ask the owner for a valid primary time (and how long the meeting runs).' }
    }
    durationMinutes = Math.round((primary.end.getTime() - primary.start.getTime()) / 60000)
    candidateSlots = [{ start: primary.start, end: primary.end }]
    for (const fb of args.fallbacks ?? []) {
      const r = resolveSlotRange({ date: toParts(fb.date), startTime: fb.startTime, endTime: null, durationMinutes }, ctx.timezone, new Date())
      if (r.ok) candidateSlots.push({ start: r.start, end: r.end })
    }
  }

  // 2. Resolve / register the counterparty. An EXISTING CUSTOMER may be the counterparty
  //    (keeps role='customer', no CRM pollution); a brand-new person becomes role='contact'.
  //    The owner / staff can never be the counterparty.
  let contactId: string
  let contactPhone: string
  const phone = args.phoneNumber?.replace(/[\s-]/g, '')
  if (phone && isValidE164(phone)) {
    const [existing] = await ctx.db.select({ id: identities.id, phone: identities.phoneNumber, role: identities.role })
      .from(identities).where(and(eq(identities.businessId, ctx.businessId), eq(identities.phoneNumber, phone))).limit(1)
    if (existing && (existing.role === 'manager' || existing.role === 'delegated_user' || existing.role === 'provider')) {
      return { success: false, reason: 'cannot_coordinate_with_self', guidance: 'That number belongs to you or your staff — I can only coordinate with an external person or a customer.' }
    } else if (existing) {
      contactId = existing.id; contactPhone = existing.phone
    } else {
      contactId = await registerContact(ctx.db, ctx.businessId, phone, args.contactName); contactPhone = phone
    }
  } else if (args.contactName) {
    const [c] = await ctx.db.select({ id: identities.id, phone: identities.phoneNumber })
      .from(identities).where(and(eq(identities.businessId, ctx.businessId), eq(identities.role, 'contact'), ilike(identities.displayName, `%${args.contactName}%`))).limit(1)
    if (!c) return { success: false, reason: 'need_phone', guidance: `I don't have a number for ${args.contactName}. Ask the owner for their phone number.` }
    contactId = c.id; contactPhone = c.phone
  } else {
    return { success: false, reason: 'no_recipient', guidance: 'Ask the owner who to coordinate with — a name on file or a phone number.' }
  }

  // 3. One active coordination per counterparty.
  const active = await findActiveByContact(ctx.db, ctx.businessId, contactId)
  if (active) {
    return { success: false, reason: 'already_active', guidance: 'There is already an open meeting coordination with this person. Resolve or abandon that one first.' }
  }

  // 4. Kick off.
  const businessCtx = await loadBusinessCtx(ctx)
  const res = await startCoordination(ctx.db, ctx.calendar, {
    businessId: ctx.businessId, ownerId: ctx.identityId, contactId, contactPhone,
    title: args.title, durationMinutes, candidateSlots,
    ...(allowedWindows ? { allowedWindows } : {}), ctx: businessCtx,
  })
  if (!res.ok) {
    if (res.reason === 'no_free_candidates') {
      return { success: false, reason: 'no_free_candidates', guidance: 'None of those times are free on your calendar. Ask the owner for other times.' }
    }
    return { success: true, partial: true, message: `I saved the meeting request, but I couldn't message ${args.contactName ?? 'them'} yet — they need to message us first. I'll relay their reply the moment they do.` }
  }
  return { success: true, coordinationId: res.id, message: `Reaching out to ${args.contactName ?? 'them'} with your time${(allowedWindows ?? candidateSlots).length > 1 || allowedWindows ? ' options' : ''}.` }
```

- [ ] **Step 6: Run the tool tests + verify build**

Run: `npx vitest run src/domain/manager/coordination-tools.test.ts && npm run build`
Expected: PASS for the tests; `npm run build` PASS.

- [ ] **Step 7: Commit**

```bash
git add src/domain/manager/coordination-tools.ts src/domain/manager/coordination-tools.test.ts
git commit -m "feat(coordination): accept customer counterparty, windows arg, identification persistence"
```

---

## Task 8: Routing-first interception + Branch-4 non-interference (TDD)

**Files:**
- Modify: `src/routes/webhook.ts`
- Test: `tests/routes/coordination-interception.test.ts`

- [ ] **Step 1: Add the `tryAdvanceActiveCoordination` helper (exported for testing)**

In `src/routes/webhook.ts`, add this exported function (place it just above `routeContactMessage`). It is gated to non-owner senders so the manager/delegated hot path is untouched, builds the coordination `BusinessCtx` with the resolved introducer, and returns whether it handled the message:

```ts
// Routing-first interception: while a coordination is active, the counterparty's inbound
// belongs to that coordination — regardless of their role (customer or contact). Returns
// true if the message was handled (caller must then return). Gated to non-owner senders so
// the manager/delegated path is never touched. One indexed read; null for ~all customers.
export async function tryAdvanceActiveCoordination(
  msg: InboundMessage,
  identity: ResolvedIdentity,
  business: Business,
): Promise<boolean> {
  if (identity.role === 'manager' || identity.role === 'delegated_user') return false
  const active = await findActiveByContact(db, business.id, identity.id)
  if (!active) return false

  const lang: Lang = (identity.preferredLanguage ?? (business.defaultLanguage as Lang | null | undefined)) ?? 'he'
  const waCredentials = business.whatsappPhoneNumberId && business.whatsappAccessToken
    ? { accessToken: business.whatsappAccessToken, phoneNumberId: business.whatsappPhoneNumberId }
    : undefined
  const [mgr] = await db
    .select({ name: identities.displayName })
    .from(identities)
    .where(and(eq(identities.businessId, business.id), eq(identities.role, 'manager'), isNull(identities.revokedAt)))
    .limit(1)
  const introducer = resolveOutreachIntroducer({
    mode: (business.outreachIdentityMode as 'business' | 'owner_name' | null) ?? null,
    businessName: business.name,
    ownerName: mgr?.name ?? null,
    lang,
  })
  const calendar = createCalendarClient({
    accessToken: '',
    refreshToken: business.googleRefreshToken ?? process.env['GOOGLE_REFRESH_TOKEN'] ?? '',
    calendarId: business.googleCalendarId,
    businessId: business.id,
    calendarMode: business.calendarMode,
    lang,
  })
  const ctx: BusinessCtx = { businessId: business.id, businessName: business.name, lang, timezone: business.timezone, waCredentials, introducer }
  await advanceFromContact(db, calendar, active, msg.body, ctx)
  return true
}
```

- [ ] **Step 2: Add the import for the introducer resolver**

In `src/routes/webhook.ts`, add to the imports (next to the existing coordination imports ~line 55):

```ts
import { resolveOutreachIntroducer } from '../domain/coordination/introducer.js'
```

- [ ] **Step 3: Call the interception before the role branch**

In `processInboundMessage`, immediately before the `if (identity.role === 'manager' || identity.role === 'delegated_user')` block (~line 209), add:

```ts
  // Routing-first: an active coordination owns its counterparty's inbound (fixes the
  // customer-as-counterparty hijack). Falls through for everyone else.
  if (await tryAdvanceActiveCoordination(msg, identity, business)) return
```

- [ ] **Step 4: Write the failing Branch-4 non-interference test**

Create `tests/routes/coordination-interception.test.ts`:

```ts
import { vi } from 'vitest'

vi.mock('../../src/db/client.js', () => {
  // mgr displayName lookup → returns one row
  const chain = { from: () => chain, where: () => chain, limit: () => Promise.resolve([{ name: 'Dana' }]) }
  return { db: { select: () => chain } }
})
vi.mock('../../src/domain/coordination/repository.js', () => ({ findActiveByContact: vi.fn() }))
vi.mock('../../src/domain/coordination/handler.js', () => ({ advanceFromContact: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../../src/adapters/calendar/client.js', () => ({ createCalendarClient: vi.fn().mockReturnValue({}) }))

import { describe, it, expect, beforeEach } from 'vitest'
import { tryAdvanceActiveCoordination } from '../../src/routes/webhook.js'
import { findActiveByContact } from '../../src/domain/coordination/repository.js'
import { advanceFromContact } from '../../src/domain/coordination/handler.js'

const business = {
  id: 'biz1', name: 'Studyoga', timezone: 'Asia/Jerusalem', defaultLanguage: 'he',
  whatsappPhoneNumberId: 'wa', whatsappAccessToken: 'tok', googleRefreshToken: 'r',
  googleCalendarId: 'cal', calendarMode: 'internal', outreachIdentityMode: 'business',
} as never

const msg = { messageId: 'm1', fromNumber: '+972522858870', toNumber: '+972509999999', body: 'Wednesday at 10' } as never
const activeRow = { id: 'coord1', contactId: 'eyal_1', allowedWindows: [], candidateSlots: [], status: 'awaiting_counterparty' } as never

describe('tryAdvanceActiveCoordination — Branch-4 safety', () => {
  beforeEach(() => vi.clearAllMocks())

  it('a CUSTOMER with an active coordination is intercepted (advanceFromContact called, returns true)', async () => {
    vi.mocked(findActiveByContact).mockResolvedValue(activeRow)
    const customer = { id: 'eyal_1', role: 'customer', preferredLanguage: null } as never
    const handled = await tryAdvanceActiveCoordination(msg, customer, business)
    expect(handled).toBe(true)
    expect(advanceFromContact).toHaveBeenCalledOnce()
  })

  it('a normal CUSTOMER with NO coordination is NOT intercepted (returns false, booking path proceeds)', async () => {
    vi.mocked(findActiveByContact).mockResolvedValue(null)
    const customer = { id: 'cust_2', role: 'customer', preferredLanguage: null } as never
    const handled = await tryAdvanceActiveCoordination(msg, customer, business)
    expect(handled).toBe(false)
    expect(advanceFromContact).not.toHaveBeenCalled()
  })

  it('a MANAGER is never intercepted and never triggers the lookup', async () => {
    const manager = { id: 'owner_1', role: 'manager', preferredLanguage: null } as never
    const handled = await tryAdvanceActiveCoordination(msg, manager, business)
    expect(handled).toBe(false)
    expect(findActiveByContact).not.toHaveBeenCalled()
    expect(advanceFromContact).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 5: Run the routing test + verify build**

Run: `npx vitest run tests/routes/coordination-interception.test.ts tests/routes/contact-routing.test.ts && npm run build`
Expected: PASS — interception + existing contact routing both green; build clean.

- [ ] **Step 6: Commit**

```bash
git add src/routes/webhook.ts tests/routes/coordination-interception.test.ts
git commit -m "feat(coordination): routing-first interception (customer counterparty); Branch-4 untouched"
```

---

## Task 9: Orchestrator — prompt hardening, tool args, outreach-identity context

**Files:**
- Modify: `src/adapters/llm/orchestrator.ts`

This task has no unit test (the system prompt is internal and exercised by the quality harness). It is verified by `npm run build` and a careful read; behavior is graded by `npm run test:quality:smoke` (optional, network-dependent).

- [ ] **Step 1: Extend the `coordinateMeeting` tool declaration**

In `src/adapters/llm/orchestrator.ts`, replace the `coordinateMeeting` entry in `MANAGER_TOOLS` with (adds `windows`, `identifyAs`, `ownerName`; relaxes `required` to `['title']`; clarifies windows vs primary):

```ts
  {
    name: 'coordinateMeeting',
    description: 'Coordinate a NEW meeting with someone on the owner\'s behalf — only when the owner has NOT already agreed a time and wants the PA to reach out. The counterparty may be a brand-new person OR an existing customer. First confirm the owner wants you to coordinate (vs. they already set it). Provide EITHER a primary time + one or two fallbacks (discrete times) OR day/time "windows" (ranges like "Tue 10–16, Wed 11–15") plus durationMinutes. Report all dates/times as structured pieces — NEVER an absolute/ISO date. If the owner has not told you how to introduce yourself when reaching out (and there is no saved preference shown in context), ask them first and pass identifyAs (and ownerName if they choose their own name). For a meeting whose time is already agreed, use createCalendarEvent instead.',
    parameters: { type: Type.OBJECT, properties: {
      contactName: { type: Type.STRING, description: 'Name of the person to meet, if given.' },
      phoneNumber: { type: Type.STRING, description: 'Their phone in E.164 — required to reach someone new (an existing customer can be matched by this too).' },
      title: { type: Type.STRING, description: 'What the meeting is about (e.g. "Meeting with the accountant").' },
      date: DATE_PIECES_SCHEMA,
      startTime: timeSchema('Primary start clock time the owner said, 24-hour (discrete-times path)'),
      endTime: timeSchema('Primary end clock time, 24-hour. Provide this OR durationMinutes.'),
      durationMinutes: { type: Type.NUMBER, description: 'Meeting length in minutes. REQUIRED when using windows; otherwise provide this OR endTime.' },
      fallbacks: { type: Type.ARRAY, description: 'One or two backup discrete times to offer if the primary does not work.', items: { type: Type.OBJECT, properties: { date: DATE_PIECES_SCHEMA, startTime: timeSchema('Fallback start time, 24-hour') }, required: ['date', 'startTime'] } },
      windows: { type: Type.ARRAY, description: 'Day/time RANGES the owner is available within (e.g. "Tue 10–16, Wed 11–15"). Use this when the owner gives ranges rather than exact times. Each window has a date and a start..end clock time. Requires durationMinutes.', items: { type: Type.OBJECT, properties: { date: DATE_PIECES_SCHEMA, startTime: timeSchema('Window start clock time, 24-hour'), endTime: timeSchema('Window end clock time, 24-hour') }, required: ['date', 'startTime', 'endTime'] } },
      identifyAs: { type: Type.STRING, enum: ['business', 'owner_name'], description: 'How to introduce yourself in the outreach: as the business, or as the owner\'s assistant. Pass this once the owner has answered; it is then saved.' },
      ownerName: { type: Type.STRING, description: "The owner's real name, when they choose to be identified by name and you don't already have it. It will be saved." },
    }, required: ['title'] },
  },
```

- [ ] **Step 2: Add the prompt hard rules (never invent names; route coordination correctly)**

In `buildSystemPrompt`, in the `## Tool usage rules` section, replace the `coordinateMeeting:` bullet with the following two bullets (the second tightens `messageCustomer`/`createCalendarEvent` against freelancing):

```ts
- coordinateMeeting: use ONLY when the owner wants you to reach out and arrange a meeting whose time is NOT yet agreed — with anyone, INCLUDING an existing customer. First ask, in ONE question, whether they already set a time (then use createCalendarEvent) or want you to coordinate. When coordinating, capture either a primary time + one or two fallbacks, OR day/time windows (ranges) + how long the meeting runs. ALL meeting coordination goes through this tool — never improvise a coordination with messageCustomer + createCalendarEvent. NEVER invent or guess a person's name (the owner's or anyone else's). If you don't know how to introduce yourself for outreach and no preference is shown under "Outreach identity" below, ask the owner once: whether to say you're from {business name} or {owner}'s assistant — and if they pick their own name and you don't have it, ask for it; pass identifyAs (and ownerName) to save it.
- messageCustomer is for a SINGLE one-off ping the owner dictates (e.g. "let Dana know class is cancelled") — never for negotiating a meeting time, and never to work around coordinateMeeting. Do not use createCalendarEvent to book a meeting you coordinated; confirm it with resolveMeetingCoordination instead.
```

- [ ] **Step 3: Inject the outreach-identity state into the prompt**

(a) Add a parameter to `buildSystemPrompt`'s params object type and destructure: add `outreachIdentity: string` to the params type (next to `activeCoordinations: string`) and to the destructuring line.

(b) In the returned template, immediately after the `${activeCoordinations ? ... : ''}` line, add:

```ts
${outreachIdentity ? `\n## Outreach identity\n${outreachIdentity}` : ''}
```

- [ ] **Step 4: Build the outreach-identity string in the loop and pass it through**

In `runManagerOrchestratorLoop`, immediately after the `activeCoordinations` block is built (after the `coordRows` mapping), add:

```ts
  const [mgrName] = await db
    .select({ name: identities.displayName })
    .from(identities)
    .where(and(eq(identities.businessId, businessId), eq(identities.role, 'manager')))
    .limit(1)
    .catch(() => [undefined as { name: string | null } | undefined])
  const [bizRow] = await db
    .select({ mode: businessesTable.outreachIdentityMode })
    .from(businessesTable)
    .where(eq(businessesTable.id, businessId))
    .limit(1)
    .catch(() => [undefined as { mode: 'business' | 'owner_name' | null } | undefined])
  const ownerNameOnFile = mgrName?.name && mgrName.name.trim().toLowerCase() !== 'owner' ? mgrName.name.trim() : null
  const outreachIdentity = bizRow?.mode === 'business'
    ? `When reaching out on the owner's behalf, introduce yourself as "${businessName}".`
    : bizRow?.mode === 'owner_name' && ownerNameOnFile
      ? `When reaching out on the owner's behalf, introduce yourself as "${ownerNameOnFile}'s assistant".`
      : `Not set yet — before your first outreach on the owner's behalf, ask whether to identify as "${businessName}" or the owner's assistant. Owner's name on file: ${ownerNameOnFile ?? '(placeholder — ask for it if they choose to be named)'}.`
```

(c) Add the imports needed: at the top, extend the existing `drizzle-orm` import to include `and`, and extend the schema import. Change:

```ts
import { desc, eq } from 'drizzle-orm'
import { managerMemory } from '../../db/schema.js'
```

to:

```ts
import { and, desc, eq } from 'drizzle-orm'
import { managerMemory, identities, businesses as businessesTable } from '../../db/schema.js'
```

(d) Pass `outreachIdentity` into the `buildSystemPrompt({...})` call (add `outreachIdentity,` next to `activeCoordinations,`).

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/llm/orchestrator.ts
git commit -m "feat(coordination): prompt hardening, windows/identifyAs args, outreach-identity context"
```

---

## Task 10: Migration applier + full verification

**Files:**
- Modify: `scripts/apply-coordination-migration.ts`

- [ ] **Step 1: Extend the applier to run + verify the new migration**

In `scripts/apply-coordination-migration.ts`, change the `MIGRATIONS` array to include the new file:

```ts
const MIGRATIONS = ['0024_meeting_coordination.sql', '0025_coordination_windows_identity.sql']
```

Then, after the existing `meeting_coordinations present ✓` verification block and before the `EXPECTED_TABLES` block, add a column-existence check:

```ts
    // Verify the round-1 columns exist (the actual guarantee for the fixes deploy).
    const cols = await sql<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name = 'businesses' AND column_name = 'outreach_identity_mode')
          OR (table_name = 'meeting_coordinations' AND column_name = 'allowed_windows'))`
    const haveCols = new Set(cols.map((c) => `${c.table_name}.${c.column_name}`))
    const wantCols = ['businesses.outreach_identity_mode', 'meeting_coordinations.allowed_windows']
    const missingCols = wantCols.filter((c) => !haveCols.has(c))
    if (missingCols.length > 0) {
      console.error(`VERIFICATION FAILED — missing columns: ${missingCols.join(', ')}`)
      process.exit(1)
    }
    console.log(`verification OK — columns present: ${wantCols.join(', ')}`)
```

- [ ] **Step 2: Type-check the script**

Run: `npx tsc --noEmit scripts/apply-coordination-migration.ts` (or `npm run build`)
Expected: PASS. (The script is run against prod during deploy per the runbook; do NOT run it here — no deploy.)

- [ ] **Step 3: Run the FULL test suite**

Run: `npm test`
Expected: PASS — all previously-passing tests plus the new coordination/window/routing/introducer/tool tests. Investigate and fix any regression before continuing.

- [ ] **Step 4: Full build**

Run: `npm run build`
Expected: PASS (no type errors anywhere).

- [ ] **Step 5: Commit**

```bash
git add scripts/apply-coordination-migration.ts
git commit -m "chore(coordination): apply+verify 0025 columns in migration script"
```

---

## Final acceptance check (manual review against the spec)

Confirm each acceptance criterion from the design doc maps to delivered work:

- [ ] **No invented names** — `resolveOutreachIntroducer` never emits the placeholder (Task 4); prompt forbids fabricating names + asks the identification question (Task 9); preference persists to `businesses`/`identities` (Task 7).
- [ ] **Customer-as-counterparty end-to-end** — refusal removed, customer accepted, role unchanged (Task 7); their inbound advances the coordination, not the booking flow (Task 8).
- [ ] **Boundary enforcement** — `allowed_windows` column + window-aware classify + out-of-window deviation surfaced to owner; bookable only on explicit owner confirm (Tasks 1–3, 6).
- [ ] **Single booking path** — coordination books via the handler (`paType='meeting'`, existing); prompt forbids `createCalendarEvent`/`messageCustomer` freelancing (Task 9).
- [ ] **Branch-4 untouched** — interception gated to non-owner senders, returns false for normal customers, never touches booking sessions (Task 8 + tests). All existing tests pass (Task 10).

**Do NOT deploy.** Stop here; the owner runs `/update-agent` after reviewing the branch.
```
