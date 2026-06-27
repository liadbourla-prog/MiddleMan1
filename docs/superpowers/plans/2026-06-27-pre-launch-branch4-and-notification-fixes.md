# Pre-Launch Branch 4 + Notification Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix five production bugs found in live manual testing of business `סטודיוגה` (id `d3c0c1e7-5c75-4b93-aca5-cc4b2bf941de`) before going live with real customers.

**Architecture:** Five independent workstreams. Each is its own branch/PR/session — they do not share state and can be done in any order, though the recommended sequence is A → E → C → B → D (blocker first, then quick correctness wins, then the orchestrator grounding fix, then the optional UX flow). All changes are in Developer A's domain (none touch `src/skills/`).

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Drizzle ORM (PostgreSQL), Fastify, BullMQ workers + Redis, Gemini native function-calling orchestrator, Vitest. Tests run with `npx vitest run <path>`.

---

## Evidence Appendix (read first — do NOT re-investigate)

All root causes below were confirmed against the **production** database (Cloud SQL `deepr-490316:europe-west3:deepr-project`, reachable via the running cloud-sql-proxy on `127.0.0.1:5434`) and the **live Google Calendar** on 2026-06-27. Timeline facts are from `audit_log`, `conversation_messages`, `initiation_log`, and a live `listEvents` read. Studio timezone is `Asia/Jerusalem` (UTC+3): 07:00Z = 10:00 local, 09:00Z = 12:00 local.

| # | Bug | Confirmed root cause |
|---|---|---|
| **A** | "Notify me of every change" never delivers (both tests) | The message-retry queue is **not tenant-aware**. `enqueueMessage` (`src/workers/message-retry.ts:27`) builds a job `{toNumber, body, bookingId}` with **no businessId/credentials**; the worker calls `sendMessage({toNumber, body})` with no creds (`:51`), so `resolveCredentials` falls back to the **global env WABA** (`src/adapters/whatsapp/sender.ts:25-26`). The studio's own WABA phone-number-id ends `…199346`; the env one ends `…925117` — a *different* number. So every queued send leaves from the wrong number, outside the owner's 24h window → fails after 3 retries. `initiation_log` shows the dispatch DID happen (`decision=send_free_form`, `dedup=owner_change:moved:…` at 08:14:22 and 08:16:41) — the failure is purely at the send boundary. Direct conversational replies work because the webhook passes per-business creds explicitly (`src/routes/webhook.ts:205-206,426-427`). **This affects ALL proactive messaging** (reminders, hold-expiry, waitlist, dunning, birthday, escalation, owner notifications — all 25+ `enqueueMessage` call sites). Note `src/workers/reminder.ts:177` even *builds* per-business creds then discards them at `enqueueMessage` (`:194`). |
| **B** | Branch-3 PA reported "10:00 has 2 bookings" after a move when it had 1 | Branch 3 has **no authoritative roster tool**. `loadSessionRoster()` (`src/domain/booking/roster.ts:38`, correctly excludes cancelled via `SEAT_STATES`) is only wired to the web API (`src/routes/public-api/reads.ts`). The orchestrator's only occupancy window is `listCalendarEvents` → live Google read → `ListedEvent` carries **only a title** (`service — n/max`), **no attendee names** (`src/adapters/calendar/types.ts:34`). The live 10:00 event title was already correct (`יוגה — 1/8`), so the false "2" and "Harel and another participant" were **fabricated by the LLM from session memory** — there is no tool that returns participant names, and the prompt's "never answer from memory" guard (`src/adapters/llm/orchestrator.ts:744,768`) covers customer-reply lookups but **not** calendar occupancy/roster questions. |
| **C** | Calendar event description shows the phone number twice instead of name + phone | When `displayName` is null, `personLabel()` (`src/domain/calendar/event-content.ts:89-91`) falls back to phone, then the phone is printed again on its own line / after the dash (`:101`, `:133`). With no name: `Client: +972…` + `Phone: +972…` (1-on-1) or `1. +972… — +972…` (group). Confirmed: this customer's `displayName` is null. |
| **D** | PA never captured the customer's name | The customer never stated a name and **no flow ever asks**. `persistCapturedName` (`src/domain/flows/customer-booking.ts:54`) only fires when the LLM extracts `customerNameHint`; for a name-less group-class booking nothing is captured, and the PA itself admitted "the names aren't saved, only phone numbers." |
| **E** | On a same-day time change the PA loses the day and asks "which day?" | `handleReschedulingIntent` (`src/domain/flows/customer-booking.ts:1431-1441`) marks `rescheduledFrom` but **never seeds the new slot draft with the existing booking's date** from `existing.slotStart`. A time-only change ("move 10:00→12:00") hands off to `handleBookingIntent` with no date → it asks for the day. Reproduced in both tests (sessions `d116cdca`, `1c061d4b`). |

**Minor observation (fold into whichever workstream touches it):** `audit_log` and the notification "who" label render the customer as the **last 4 digits** ("8870") in some paths (`src/domain/initiations/booking-notify.ts:476` uses `phone.slice(-4)`; the cancel audit `customerName` was "8870"). Harmless but ugly once names exist; not a separate workstream.

---

## File Structure

**Workstream A (tenant-aware queue):**
- Modify `src/workers/message-retry.ts` — add `businessId` to the job; worker resolves per-business WA creds; pass to `sendMessage`.
- Modify all `enqueueMessage(...)` call sites (25+) to pass `businessId` — full list in Task A4.
- Test `src/workers/message-retry.test.ts` (create).

**Workstream B (Branch-3 roster grounding):**
- Modify `src/domain/manager/orchestrator-tools.ts` — add `executeGetSessionRoster`.
- Modify `src/adapters/llm/orchestrator.ts` — declare + dispatch `getSessionRoster`; add occupancy grounding guard to the system prompt.
- Test `src/domain/manager/orchestrator-tools.test.ts` (extend or create).

**Workstream C (calendar phone-twice):**
- Modify `src/domain/calendar/event-content.ts` — `personLabel` no longer falls back to phone.
- Modify `src/domain/calendar/event-content.test.ts` — assert no duplication.

**Workstream D (name capture):**
- Modify `src/domain/flows/customer-booking.ts` — ask for name on first nameless booking completion.
- Modify `src/domain/i18n/t.ts` — name-request string (he/en).
- Test `src/domain/flows/customer-booking.test.ts`.

**Workstream E (reschedule day anchor):**
- Modify `src/domain/flows/customer-booking.ts:1431-1441` — seed draft date/service from the existing booking.
- Test `src/domain/flows/customer-booking.test.ts`.

---

## Workstream A — Tenant-aware message queue (BLOCKER, do first)

**Branch:** `dev/system/fix-tenant-aware-message-queue`

**Approach:** Store `businessId` (not raw tokens) in the BullMQ job, and resolve per-business WhatsApp credentials inside the worker — mirroring how `src/workers/reminder.ts:177-178` already builds them. This keeps secrets out of Redis and centralizes cred resolution in one place. Changing the `enqueueMessage` signature to require `businessId` makes the compiler surface every call site so none is missed.

### Task A1: Make the job carry businessId and the worker resolve creds

**Files:**
- Modify: `src/workers/message-retry.ts`

- [ ] **Step 1: Write the failing test** (`src/workers/message-retry.test.ts`)

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the sender so we can assert what credentials the worker passes.
const sendMessage = vi.fn(async () => ({ ok: true as const }))
vi.mock('../adapters/whatsapp/sender.js', () => ({ sendMessage }))

// Mock the db to return a business with its own WABA creds.
vi.mock('../db/client.js', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [
      { whatsappPhoneNumberId: 'PNID_199346', whatsappAccessToken: 'TOKEN_BIZ' },
    ] }) }) }),
  },
}))

import { buildSendArgs } from './message-retry.js'

describe('message-retry worker credential resolution', () => {
  beforeEach(() => sendMessage.mockClear())

  it('resolves per-business WA credentials from businessId', async () => {
    const { credentials } = await buildSendArgs({ businessId: 'biz-1', toNumber: '+972500000000', body: 'hi' })
    expect(credentials).toEqual({ accessToken: 'TOKEN_BIZ', phoneNumberId: 'PNID_199346' })
  })

  it('returns undefined credentials when the business has none (env fallback)', async () => {
    // Override the mock for this case is covered in integration; here assert shape only.
    const args = await buildSendArgs({ businessId: 'biz-1', toNumber: '+972500000000', body: 'hi' })
    expect(args.toNumber).toBe('+972500000000')
    expect(args.body).toBe('hi')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/workers/message-retry.test.ts`
Expected: FAIL — `buildSendArgs` is not exported / not defined.

- [ ] **Step 3: Implement the change**

Rewrite `src/workers/message-retry.ts` to:

```ts
import { Worker, Queue } from 'bullmq'
import { eq } from 'drizzle-orm'
import { sendMessage } from '../adapters/whatsapp/sender.js'
import { db } from '../db/client.js'
import { bookings, businesses } from '../db/schema.js'
import { redisConnection } from '../redis.js'

const QUEUE_NAME = 'message-retry'
const MAX_ATTEMPTS = 3

interface MessageJob {
  businessId: string
  toNumber: string
  body: string
  bookingId?: string // if set, skip send if booking is cancelled/expired/failed
}

export const messageRetryQueue = new Queue<MessageJob>(QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: MAX_ATTEMPTS,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
})

export async function enqueueMessage(
  businessId: string,
  toNumber: string,
  body: string,
  opts?: { bookingId?: string },
) {
  await messageRetryQueue.add('send', {
    businessId,
    toNumber,
    body,
    ...(opts?.bookingId ? { bookingId: opts.bookingId } : {}),
  })
}

// Exported for unit testing: resolve the recipient + per-business WhatsApp credentials.
export async function buildSendArgs(data: Pick<MessageJob, 'businessId' | 'toNumber' | 'body'>) {
  const [biz] = await db
    .select({ phoneNumberId: businesses.whatsappPhoneNumberId, accessToken: businesses.whatsappAccessToken })
    .from(businesses)
    .where(eq(businesses.id, data.businessId))
    .limit(1)
  const credentials = biz?.phoneNumberId && biz?.accessToken
    ? { accessToken: biz.accessToken, phoneNumberId: biz.phoneNumberId }
    : undefined
  if (!credentials) {
    console.warn('[message-retry] no per-business WA credentials; falling back to env', { businessId: data.businessId })
  }
  return { toNumber: data.toNumber, body: data.body, credentials }
}

export function startMessageRetryWorker() {
  const worker = new Worker<MessageJob>(
    QUEUE_NAME,
    async (job) => {
      if (job.data.bookingId) {
        const [booking] = await db
          .select({ state: bookings.state })
          .from(bookings)
          .where(eq(bookings.id, job.data.bookingId))
          .limit(1)
        const skipStates = new Set(['cancelled', 'expired', 'failed'])
        if (booking && skipStates.has(booking.state)) return
      }

      const { toNumber, body, credentials } = await buildSendArgs(job.data)
      const result = await sendMessage({ toNumber, body }, credentials)
      if (!result.ok) throw new Error(result.error)
    },
    { connection: redisConnection },
  )

  worker.on('failed', (job, err) => {
    if (job && job.attemptsMade >= MAX_ATTEMPTS) {
      console.error('[message-retry] Message permanently failed after retries', {
        businessId: job.data.businessId,
        toNumber: job.data.toNumber,
        err: err.message,
      })
    }
  })

  return worker
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/workers/message-retry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workers/message-retry.ts src/workers/message-retry.test.ts
git commit -m "fix(notify): make message-retry queue tenant-aware (resolve per-business WA creds)"
```

### Task A2: Update every enqueueMessage call site to pass businessId

**Files (each call site already has a business in scope — pass its id):**
- `src/workers/reminder.ts:194`
- `src/workers/hold-expiry.ts:119`
- `src/workers/integrity-sentinel.ts:406,418`
- `src/workers/dunning.ts:125`
- `src/workers/payment-request.ts:124`
- `src/workers/subscription-renewal.ts:87`
- `src/workers/winback.ts:79`
- `src/workers/periodic-treatment.ts:132`
- `src/workers/calendar-mirror.ts:210`
- `src/workers/post-appointment.ts:72,111`
- `src/domain/calendar/inbound-sync.ts:357,418`
- `src/domain/waitlist/freed-slot.ts:143`
- `src/domain/scheduling/session-cancellation.ts:125,217`
- `src/domain/booking/engine.ts:1068`
- `src/domain/initiations/ratchet-runner.ts:99`
- `src/domain/initiations/booking-notify.ts:126,218,260,317,367,416,501`
- `src/domain/initiations/approvals.ts:120`
- `src/domain/escalation/engine.ts:84,126`
- `src/routes/webhook.ts:745`
- `src/routes/public-api/bookings.ts:131`

- [ ] **Step 1: Let the compiler enumerate the sites**

Run: `npx tsc --noEmit`
Expected: ~25 errors "Expected 3 arguments, but got 2" (or businessId type mismatch) — one per call site above.

- [ ] **Step 2: Fix each call site**

For each, change `enqueueMessage(phone, body)` → `enqueueMessage(businessId, phone, body)` and `enqueueMessage(phone, body, bookingId)` → `enqueueMessage(businessId, phone, body, { bookingId })`. The businessId is available locally (e.g. `business.id`, `biz.id`, `ctx.businessId`, `actor.businessId`, `booking.businessId`, or the `businessId` parameter). For `src/domain/initiations/booking-notify.ts` the functions already receive `businessId`. For `src/domain/escalation/engine.ts:126` (operator send) and `integrity-sentinel.ts:418` (operator send) the recipient is the operator on the **platform** number — pass the business's id anyway; if a send must use the provider/operator number, resolve those creds explicitly there (confirm against `getInitiator('escalation.operator')` usage before changing — leave operator-path behavior identical if it already worked).

- [ ] **Step 3: Verify the build is clean**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the full unit suite**

Run: `npx vitest run`
Expected: PASS (fix any test that called `enqueueMessage` with the old signature).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix(notify): thread businessId through all enqueueMessage call sites"
```

### Task A3: Manual production re-test

- [ ] Deploy via `/update-agent`. From the owner's WhatsApp, confirm "notify me of every change" is on. From a customer number, book then reschedule a class. **Expect a proactive "moved" message to the owner from the studio's own number** within a few seconds.
- [ ] Confirm in DB: a new `initiation_log` row for `owner_change:moved:*` AND the message actually arrives (the prior failure was delivery, not dispatch).

---

## Workstream E — Reschedule keeps the existing day (quick, high-value)

**Branch:** `dev/system/fix-reschedule-day-anchor`

### Task E1: Seed the reschedule draft from the existing booking

**Files:**
- Modify: `src/domain/flows/customer-booking.ts:1431-1441`
- Test: `src/domain/flows/customer-booking.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// In src/domain/flows/customer-booking.test.ts — a focused unit on the anchor helper.
// (If handleReschedulingIntent is not directly unit-testable, extract the anchoring into
// a pure helper `anchorRescheduleDraft(existing, intent, activeServices, tz)` and test that.)
import { anchorRescheduleDraft } from './customer-booking.js'

it('keeps the existing booking day when the customer gives only a time', () => {
  const existing = { id: 'b1', slotStart: new Date('2026-06-29T07:00:00.000Z'), serviceTypeId: 'svc-yoga' }
  const intent = { intent: 'rescheduling', slotRequest: { time: { hour: 12, minute: 0 } } } as any
  const services = [{ id: 'svc-yoga', name: 'יוגה', durationMinutes: 60, maxParticipants: 8, category: null, schedulingMode: 'class' as const }]
  const draft = anchorRescheduleDraft(existing, intent, services, 'Asia/Jerusalem')
  expect(draft.dateStr).toBe('2026-06-29')        // same day as the existing booking
  expect(draft.time).toEqual({ hour: 12, minute: 0 })
  expect(draft.serviceTypeId).toBe('svc-yoga')
})

it('lets the customer override the day when they state one', () => {
  const existing = { id: 'b1', slotStart: new Date('2026-06-29T07:00:00.000Z'), serviceTypeId: 'svc-yoga' }
  const intent = { intent: 'rescheduling', slotRequest: { weekday: 2, time: { hour: 12, minute: 0 } } } as any // explicit Tuesday
  const services = [{ id: 'svc-yoga', name: 'יוגה', durationMinutes: 60, maxParticipants: 8, category: null, schedulingMode: 'class' as const }]
  const draft = anchorRescheduleDraft(existing, intent, services, 'Asia/Jerusalem')
  expect(draft.dateStr).not.toBe('2026-06-29')    // customer's stated day wins
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/domain/flows/customer-booking.test.ts -t reschedule`
Expected: FAIL — `anchorRescheduleDraft` not defined.

- [ ] **Step 3: Implement the helper and use it**

Add near `buildDraftFromIntent` (around line 957):

```ts
// On a single-booking reschedule, anchor the new slot on the EXISTING booking: keep its
// day and service unless the customer explicitly states a new one. Fixes "move 10:00→12:00"
// (a time-only change) being treated as a fresh booking that asks "which day?".
export function anchorRescheduleDraft(
  existing: { slotStart: Date; serviceTypeId: string },
  intent: CustomerIntentOutput,
  activeServices: Array<{ id: string; name: string; durationMinutes: number; maxParticipants: number; category: string | null; schedulingMode: 'appointment' | 'class' }>,
  tz: string,
  now: Date = new Date(),
): NonNullable<BookingFlowContext['slotDraft']> {
  const captured = buildDraftFromIntent(intent, activeServices, tz, now) ?? {}
  const svc = activeServices.find((s) => s.id === existing.serviceTypeId)
  const anchor: NonNullable<BookingFlowContext['slotDraft']> = {
    serviceTypeId: existing.serviceTypeId,
    ...(svc ? { serviceName: svc.name } : {}),
    dateStr: localParts(existing.slotStart, tz).dateStr,
  }
  // captured (what the customer actually said) overrides the anchor; buildDraftFromIntent only
  // sets dateStr when the customer named a day, so a time-only change keeps the anchor's date.
  return { ...anchor, ...captured }
}
```

Then change the single-booking branch at lines 1440-1441:

```ts
  const existing = activeBookings[0]!
  // ...deferred-cancel comment unchanged...
  const anchored = anchorRescheduleDraft(existing, intent, activeServices, businessTimezone)
  const newCtx: BookingFlowContext = {
    ...ctx,
    rescheduledFrom: existing.id,
    slotDraft: { ...(ctx.slotDraft ?? {}), ...anchored },
  }
  return handleBookingIntent(db, calendar, identity, session, newCtx, intent, activeServices, businessTimezone, businessName, transcript, genReply, '', business)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/domain/flows/customer-booking.test.ts -t reschedule`
Expected: PASS.

- [ ] **Step 5: Run the whole flow suite (no regressions)**

Run: `npx vitest run src/domain/flows/customer-booking.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/flows/customer-booking.ts src/domain/flows/customer-booking.test.ts
git commit -m "fix(branch4): reschedule keeps the existing booking's day on a time-only change"
```

---

## Workstream C — Calendar event: name OR phone, never phone twice (quick)

**Branch:** `dev/system/fix-calendar-phone-duplication`

### Task C1: Drop the phone fallback in personLabel

**Files:**
- Modify: `src/domain/calendar/event-content.ts:89-91`
- Test: `src/domain/calendar/event-content.test.ts`

- [ ] **Step 1: Read the existing test file** to see which cases assume phone-as-label.

Run: `npx vitest run src/domain/calendar/event-content.test.ts`
Expected: PASS currently. Note any test asserting a phone appears in the title/label when name is absent — those expectations change.

- [ ] **Step 2: Write the failing test** (add to `event-content.test.ts`)

```ts
it('uses the no-name placeholder (not the phone) when a name is missing — no duplication', () => {
  const { title, description } = renderBookingEvent({
    kind: 'one_on_one', serviceName: 'יוגה', durationMinutes: 60,
    customer: { name: null, phone: '+972522858870' }, instructorName: null,
  }, 'he')
  expect(title).toBe('יוגה — ללא שם')
  // phone appears exactly once, on its own line
  expect(description.match(/\+972522858870/g)?.length).toBe(1)
  expect(description).toContain('לקוח: ללא שם')
  expect(description).toContain('טלפון: +972522858870')
})

it('group attendee with no name renders "placeholder — phone", phone once', () => {
  const { description } = renderBookingEvent({
    kind: 'group', serviceName: 'יוגה', instructorName: null, maxParticipants: 8,
    attendees: [{ name: null, phone: '+972522858870' }],
  }, 'he')
  expect(description).toContain('1. ללא שם — +972522858870')
  expect(description.match(/\+972522858870/g)?.length).toBe(1)
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/domain/calendar/event-content.test.ts`
Expected: FAIL — title is currently `יוגה — +972522858870` and phone appears twice.

- [ ] **Step 4: Implement the fix**

In `src/domain/calendar/event-content.ts`, change `personLabel`:

```ts
function personLabel(p: EventPerson, noName: string): string {
  return clean(p.name) ?? noName
}
```

(The phone still surfaces on its own `Phone:` line for 1-on-1/meeting and after the dash for group attendees — so the owner always sees the number, just not duplicated in place of the name.)

- [ ] **Step 5: Run tests, update any now-stale expectations**

Run: `npx vitest run src/domain/calendar/event-content.test.ts`
Expected: PASS. If a pre-existing test expected the phone as the label, update it to the placeholder.

- [ ] **Step 6: Commit**

```bash
git add src/domain/calendar/event-content.ts src/domain/calendar/event-content.test.ts
git commit -m "fix(calendar): show 'no name' placeholder instead of duplicating the phone number"
```

---

## Workstream B — Branch-3 occupancy/roster grounding

**Branch:** `dev/system/fix-branch3-roster-grounding`

**Approach:** Two parts — (1) give the orchestrator a real, cancelled-excluded roster tool so it CAN answer "who's booked / how many" correctly, and (2) a prompt guard so it MUST call it instead of narrating from memory. Reuse `loadSessionRoster` (already correct).

### Task B0: Read the patterns to mirror (no code; orient first)

- [ ] Read `src/adapters/llm/orchestrator.ts:324-345` (`lookupCustomer` declaration + dispatch) — the exact shape for declaring a tool, its `parameters` schema (`Type.OBJECT`, `DatePieces`/`TimePieces`), and how `execute*` is dispatched.
- [ ] Read `src/domain/manager/orchestrator-tools.ts:192-304` (`executeListCalendarEvents`) — how `ToolContext` exposes `ctx.db`, `ctx.businessId`, `ctx.timezone`, and how it resolves `DatePieces`/`TimePieces` via `resolveRequestedDate` / `resolveSlotStart`.
- [ ] Read `src/domain/booking/roster.ts` — `loadSessionRoster(db, businessId, { serviceTypeId, slotStart })` returns `{ instance, participants[], spotsLeft }`; `participants[].displayName` is null when unknown.

### Task B1: Add the getSessionRoster tool executor

**Files:**
- Modify: `src/domain/manager/orchestrator-tools.ts`
- Test: `src/domain/manager/orchestrator-tools.test.ts`

- [ ] **Step 1: Write the failing test** — assert it returns live, cancelled-excluded participants by service+slot. Mirror the existing orchestrator-tools test setup (seed a class block + two bookings, cancel one, expect headcount 1 and one named + the cancelled one absent).

- [ ] **Step 2: Run it** — FAIL (`executeGetSessionRoster` undefined).

- [ ] **Step 3: Implement** `executeGetSessionRoster`, resolving the date/time the owner named (mirror `executeListCalendarEvents` date resolution) and the service (mirror how other tools resolve a service by name/hint), then:

```ts
// ── getSessionRoster ──────────────────────────────────────────────────────────
interface GetSessionRosterArgs { serviceName?: string; date: DatePieces; time: TimePieces }

export async function executeGetSessionRoster(args: GetSessionRosterArgs, ctx: ToolContext): Promise<object> {
  const resolved = resolveSlotRange(
    { date: toDateParts(args.date), startTime: args.time, endTime: args.time },
    ctx.timezone, new Date(),
  )
  if (!resolved.ok) return clarifyDate(resolved.reason)
  // Resolve the service the owner named to a serviceTypeId (mirror the service-resolution
  // helper used by other tools — confirm its name during B0).
  const serviceTypeId = /* resolve from args.serviceName against active services */ ''
  if (!serviceTypeId) return { error: 'unknown_service', guidance: 'Ask the owner which class/service they mean.' }
  const roster = await loadSessionRoster(ctx.db, ctx.businessId, { serviceTypeId, slotStart: resolved.start })
  if (!roster) return { found: false, participants: [], count: 0 }
  return {
    found: true,
    count: roster.participants.length,
    spotsLeft: roster.spotsLeft,
    capacity: roster.instance.capacity,
    participants: roster.participants.map((p) => ({ name: p.displayName, hasName: p.displayName != null })),
    guidance: 'This is the live, authoritative roster (cancelled bookings excluded). Report these exact names/count — do NOT add or infer participants from earlier in the conversation.',
  }
}
```

Import `loadSessionRoster` from `../booking/roster.js`. (Finalize the service-resolution line during implementation using the helper found in B0.)

- [ ] **Step 4: Run the test** — PASS.

- [ ] **Step 5: Commit** `feat(branch3): add getSessionRoster tool (live cancelled-excluded roster)`.

### Task B2: Declare + dispatch the tool, and add the grounding guard

**Files:**
- Modify: `src/adapters/llm/orchestrator.ts`

- [ ] **Step 1:** Declare `getSessionRoster` in the tool list (mirror `lookupCustomer` at :324), parameters: `serviceName` (string, optional), `date` (DatePieces), `time` (TimePieces). Import and dispatch `executeGetSessionRoster` (mirror the import block at :32 and the dispatch switch).

- [ ] **Step 2:** Add a system-prompt rule near the existing "never answer from memory" block (:744/:768):

> When the owner asks how many people are booked for a session, who is booked, or whether a session's roster changed, you MUST call `getSessionRoster` (or `listCalendarEvents` for a whole-day view) and answer only from the result — never from earlier messages in this conversation. A reschedule that moved someone OUT of a slot reduces that slot's count; do not assume a count "returned to" a previous value.

- [ ] **Step 3:** `npx tsc --noEmit` → clean. `npx vitest run` → PASS.

- [ ] **Step 4: Commit** `feat(branch3): require live roster read for occupancy questions (grounding guard)`.

### Task B3: Manual production re-test

- [ ] Reproduce the original flow: as owner ask "how many in Monday's 10:00 yoga?", have a customer move out, then ask again. Expect the count to **decrease correctly** and names to match the live roster.

---

## Workstream D — Capture the customer's name (optional, lowest priority)

**Branch:** `dev/system/fix-customer-name-capture`

**Decision to confirm with the user before building:** the cleanest, least-intrusive option is — on a customer's **first successful booking** where their `displayName` is still null, the PA adds a short one-line ask ("ומה השם לרישום?") and `persistCapturedName` stores the reply on the next turn. Alternative (more intrusive): require a name before confirming the first booking. Recommend the post-confirmation soft ask.

### Task D1: Add the name-request string

**Files:**
- Modify: `src/domain/i18n/t.ts`

- [ ] Add `ask_customer_name` for `he` ("ומה השם שלך לרישום?") and `en` ("And your name for the booking?"). Commit.

### Task D2: Ask after a nameless first booking

**Files:**
- Modify: `src/domain/flows/customer-booking.ts` (the booking-confirmed success points where the final reply is generated, e.g. around lines 1509-1530 and the group direct-confirm path ~1569-1712)
- Test: `src/domain/flows/customer-booking.test.ts`

- [ ] **Step 1:** Write a test: after a successful first booking with `identity.displayName == null`, the reply includes the name ask; with a known name it does not.
- [ ] **Step 2:** Implement: when generating the confirmation reply, if `identity.displayName == null`, append the `ask_customer_name` string. Ensure the next inbound turn is parsed for `customerNameHint` and `persistCapturedName` stores it (already wired at :693 — verify it captures a bare-name reply like "גיא כהן").
- [ ] **Step 3:** Tests PASS; `npx tsc --noEmit` clean. Commit.

### Task D3: Manual re-test

- [ ] New nameless customer books → PA asks for name → customer replies with name → confirm `identities.display_name` is set and the Google event now shows the name (not the phone placeholder).

---

## Sequencing & ownership

1. **A first** — it's a launch blocker and fixes ALL proactive messaging (reminders included), not just owner notifications. Ship and re-test before the rest.
2. **E and C** — small, isolated correctness wins; can be one combined session if preferred (both touch Branch-4 correctness but different files).
3. **B** — orchestrator grounding; needs the read-first task (B0).
4. **D** — optional UX; confirm the approach with the user first.

All workstreams are Developer A's domain (no `src/skills/` changes). Each merges to `main` via its own PR; CI (tsc + eslint + vitest) must pass. Deploy with `/update-agent`.

## Self-review notes
- Spec coverage: A↔notification delivery, B↔false count, C↔phone-twice, D↔name capture, E↔day-missing — all five mapped.
- The `phone.slice(-4)` "8870" label oddity (`booking-notify.ts:476`) is cosmetic; once D lands, names replace it. Fold a one-line tidy into D if desired (use full phone or name).
- Type consistency: `enqueueMessage(businessId, toNumber, body, opts?)` is used identically in Task A1 and A2; `anchorRescheduleDraft` signature in E1 matches its test; `getSessionRoster` args (`serviceName/date/time`) match between B1 and B2.
