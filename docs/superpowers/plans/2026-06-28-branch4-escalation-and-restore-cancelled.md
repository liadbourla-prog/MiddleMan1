# Branch-4 — Owner Escalation for Unfulfillable Requests (P3) & Restore-Just-Cancelled (P4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task. The tasks are mostly independent (P3 and P4 share no functions) and map cleanly onto parallel subagents *after* the prerequisite rebase (Task 0). Each task is TDD: failing test → implement → green → commit.

**Goal:** Close two Branch-4 capability gaps surfaced in the live סטודיוגה chat with הראל (+972546372400) on 2026-06-28:
- **P3** — When a customer asks for something the catalog structurally can't express (a *private* version of a group class, a *group* booking beyond a 1-on-1 service's capacity, or an explicitly *out-of-hours* session), the PA must **notify the business owner and tell the customer it's been passed on** — never flatly reject and loop. Today it rejects ("the workshop is 1-on-1", "Monday is full") with no owner awareness.
- **P4** — When a customer asks to **undo a cancellation** ("give me back the class we just cancelled"), the PA must recognise it and re-offer/re-book the **exact cancelled slot**. Today the cancelled slot is forgotten the instant `completeSession` runs, so a follow-up "restore it" is mis-classified as a reschedule and lists *other* bookings.

**These are NEW work — not covered by the parallel `fix/branch4-grounding-state-confirmation` branch** (which owns occupancy fabrication, the lost-confirmation bug, `parseConfirmation`, the per-identity lock, instructor roster, and the phone-nudge gating). The occupancy "Monday is full" lies and the premature phone-nudge seen in the same transcript are theirs; **do not touch occupancy gating, `makeGenReply`, `rebuildOnSlotPivot`, the nudge, or `buildBusinessFacts`.**

---

## ⛔ Prerequisite — do not start until the parallel branch lands

`fix/branch4-grounding-state-confirmation` rewrites `customer-booking.ts` heavily (`makeGenReply`, `rebuildOnSlotPivot`, `handleHoldConfirmation`, `handleCancellationConfirmation`, `buildBusinessFacts`, the nudge). Every line anchor below is from the **pre-merge** tree and **will shift**. Task 0 re-anchors after that branch merges to `main`. Starting P3/P4 in parallel on the same hot file = guaranteed conflicts.

**Architecture (two roots, both additive):**
- **P3 = unfulfillable-request escalation.** The LLM flags the *request shape* (`specialArrangementRequest`); the deterministic core confirms *unfulfillability* (party-size > capacity, or out-of-hours insistence). Only when both hold do we escalate to the owner — keeping the doctrine intact (LLM interpretive, core decides). The escalation reuses the existing `dispatchInitiation` → `enqueueMessage` → `escalatedTasks` spine that `checkOwnerEscalationRules` already uses; we add one initiator, one i18n pair, one engine function, and gated call-sites.
- **P4 = durable last-cancellation memory.** A `completed` session is never reloaded (`loadActiveSession` only returns `active`/`waiting_confirmation`/`waiting_clarification`), and the restore arrives in a *fresh* session — so the cancelled slot must persist **cross-session** on `customer_profiles` (alongside the existing `lastBookingId`). The LLM flags `restorePrevious`; the flow re-fills a draft from the snapshot and routes through the normal booking path (re-validating availability, exactly like the reschedule synthetic-intent path).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Drizzle ORM (Postgres), Vitest, Gemini via `extractCustomerIntent` / `generateCustomerReply`. Business under test: סטודיוגה `d3c0c1e7-5c75-4b93-aca5-cc4b2bf941de`, tz `Asia/Jerusalem`.

**Live evidence (2026-06-28, today = Sunday):**
- 13:35 "private breathing workshop at 11pm tomorrow" → offered standard Friday class slots (ignored "private"); 13:36 "private workshop outside hours" → "no room Monday"; 13:36:47 "private workshop for a **group of 5** outside hours" → "the workshop is 1-on-1. Monday is full." No owner notified. *(The "Monday" is the carried `slotDraft.dateStr` from "מחר"/tomorrow = Mon 29; the "full" lie is the parallel branch's domain.)*
- 13:43 cancels Tue 30 Jun 14:00 pilates → 13:44 "give me back the class we cancelled" → PA lists **three unrelated** bookings (Sun 28 / Mon 29 / Wed 1) and asks "which?"; 13:46 "restore the Tuesday one we cancelled" → "which day should I check?" — cancelled slot fully lost.

**Test commands:** single file `npx vitest run <path>`; full suite `npm test`; typecheck `npx tsc --noEmit`; lint `npx eslint src/domain src/adapters src/routes`.

---

## File Structure

| File | Responsibility | Change | Root |
|---|---|---|---|
| `src/adapters/llm/types.ts` | `CustomerIntentOutput` — add `specialArrangementRequest`, `restorePrevious` | Modify | P3+P4 |
| `src/adapters/llm/client.ts` | `customerIntentSchema` + extractor prompt: flag special arrangements & restore intent | Modify | P3+P4 |
| `src/adapters/llm/client.test.ts` *(or nearest extractor test)* | extractor flag tests | Modify/Create | P3+P4 |
| `src/db/schema.ts` | `escalatedTasks.escalationType` enum += `'unfulfillable'` (app-level text enum — no SQL); `customer_profiles` += `lastCancelledBooking` jsonb + `lastCancelledAt` | Modify | P3+P4 |
| `src/db/migrations/0048_customer_last_cancelled.sql` | add the two `customer_profiles` columns | Create | P4 |
| `src/domain/initiations/registry.ts` | add `escalation.unfulfillable` initiator | Modify | P3 |
| `src/domain/i18n/t.ts` | `escalation_manager_notify_unfulfillable` + reuse `escalation_customer_passed` | Modify | P3 |
| `src/domain/escalation/engine.ts` | `escalateUnfulfillableRequest()` | Modify | P3 |
| `src/domain/escalation/engine.test.ts` | escalation function test | Create | P3 |
| `src/domain/flows/customer-booking.ts` | gated escalation at party-size & out-of-hours branches (P3); persist snapshot on cancel + restore handler (P4) | Modify | P3+P4 |
| `src/domain/flows/customer-booking.test.ts` | restore-draft + escalation-gate unit tests | Modify | P3+P4 |
| `src/domain/profile/*` (wherever `customer_profiles` is written) | snapshot setter + getter | Modify | P4 |
| `ARCHITECTURE.md` / Branch-4 doc | document escalation + restore behaviours | Modify | docs |

**Sequencing:** Task 0 (rebase) → P3 (Tasks 1–5) and P4 (Tasks 6–9) in parallel → Task 10 (full suite + docs). Within P3, extractor flag (Task 1) before the engine (Task 3) before the wiring (Task 4). Within P4, schema/migration (Task 6) before the snapshot write (Task 7) before the restore handler (Task 8).

---

## Task 0: Rebase & re-anchor (BLOCKING — do first)

- [ ] **Step 1:** Confirm `fix/branch4-grounding-state-confirmation` is merged to `main`. If not, STOP — this plan cannot run cleanly yet.
- [ ] **Step 2:** `git checkout main && git pull && git checkout -b fix/branch4-escalation-and-restore`.
- [ ] **Step 3:** Re-locate every anchor below — they shifted. Re-grep before each edit:
  - Party-size 1-on-1 branch: `grep -n "is a private, one-on-one session" src/domain/flows/customer-booking.ts`
  - Over-capacity branch: `grep -n "holds at most" src/domain/flows/customer-booking.ts`
  - Out-of-hours branch: `grep -n "outsideHours" src/domain/flows/customer-booking.ts`
  - Cancel completion: `grep -n "Booking successfully cancelled" src/domain/flows/customer-booking.ts`
  - Reschedule synthetic-intent pattern (the re-book template to copy): `grep -n "Synthetic intent: the slot is already in the draft" src/domain/flows/customer-booking.ts`
- [ ] **Step 4:** `npm test && npx tsc --noEmit` green on a clean checkout before touching anything.

---

## Task 1: P3 — extractor flag `specialArrangementRequest`

**Problem:** Nothing in the intent output distinguishes "book me a yoga class" from "book me a *private out-of-hours* session for *5 people*." The flow can't tell a routine party-size clarification from a genuine special request, so it can't decide to escalate.

**Design:** Add a boolean the LLM sets when the customer asks for an arrangement the standard catalog can't express. Keep it conservative and shape-based (the deterministic core still confirms unfulfillability before any escalation fires).

- [ ] **Step 1 — failing test.** In the extractor test file, assert:
```ts
it('flags a private/group/out-of-hours arrangement', async () => {
  const r = await extractCustomerIntent('אני רוצה סדנת נשימות פרטית לקבוצה של 5 אנשים מחוץ לשעות הפעילות', {}, 'Asia/Jerusalem', ['סדנת נשימות'])
  expect(r.value?.specialArrangementRequest).toBe(true)
})
it('does NOT flag an ordinary class booking', async () => {
  const r = await extractCustomerIntent('אפשר פילאטיס ביום שלישי ב-14:00?', {}, 'Asia/Jerusalem', ['פילאטיס'])
  expect(r.value?.specialArrangementRequest).toBe(false)
})
```
*(If the extractor test harness mocks the LLM, instead assert the schema accepts/defaults the field and add the prompt rule; live-LLM assertions belong in `test:quality`.)*

- [ ] **Step 2 — type.** In `src/adapters/llm/types.ts` `CustomerIntentOutput`, add:
```ts
  // True when the customer asks for an arrangement the standard catalog can't express:
  // a PRIVATE version of a group class, a GROUP booking beyond a 1-on-1 service's
  // capacity, an explicitly OUT-OF-HOURS session, or a bespoke event. Shape-only signal;
  // the deterministic core confirms unfulfillability before any owner escalation.
  specialArrangementRequest?: boolean
```

- [ ] **Step 3 — schema.** In `customerIntentSchema` (client.ts:54), add before the closing `})`:
```ts
  specialArrangementRequest: z.boolean().default(false).catch(false),
```

- [ ] **Step 4 — prompt rule.** Add to the `Rules:` block in `extractCustomerIntent` (client.ts), after `participantsHint`:
```
- specialArrangementRequest: true ONLY when the customer asks for something the standard service list can't provide as-is — a PRIVATE/one-off version of a normally-group class, a GROUP/party booking larger than a service allows, an explicitly OUTSIDE-OPENING-HOURS session, or a custom event ("private workshop", "just for my group", "after you close", "סדנה פרטית", "מחוץ לשעות הפעילות", "אירוע פרטי"). false for an ordinary booking, a normal party size, or merely asking about a time that happens to be unavailable. When in doubt, false.
```

- [ ] **Step 5:** `npx vitest run <extractor test>` green; `npx tsc --noEmit` green.
- [ ] **Step 6 — commit:** `feat(branch4): extractor flags special-arrangement (private/group/out-of-hours) requests`

---

## Task 2: P3 — initiator + i18n for owner notification

- [ ] **Step 1 — registry.** In `src/domain/initiations/registry.ts`, after `escalation.platform` (line ~50), add:
```ts
  'escalation.unfulfillable': {
    id: 'escalation.unfulfillable',
    layer: 'B',
    audience: 'owner',
    consentClass: 'transactional',
    autonomy: 'owner_configured',
    delivery: 'fire_and_forget',
    windowPolicy: 'skip',
    defaultEnabled: true,
  },
```
Add `'escalation.unfulfillable'` to the `InitiatorId` union if it's a manually-maintained type (grep `type InitiatorId`).

- [ ] **Step 2 — i18n.** In `src/domain/i18n/t.ts`, mirror `escalation_manager_notify` (line ~316) with a variant that frames it as a request the PA couldn't fulfil:
```ts
  escalation_manager_notify_unfulfillable: {
    he: (customerPhone: string, request: string) =>
      `📩 לקוח (${customerPhone}) ביקש משהו שה-PA לא יכול לסגור לבד:\n"${request}"\nכדאי לחזור אליו ישירות.`,
    en: (customerPhone: string, request: string) =>
      `📩 A customer (${customerPhone}) asked for something the PA can't book on its own:\n"${request}"\nWorth reaching out directly.`,
  },
```
Reuse the existing `escalation_customer_passed` for the customer-facing reply (no new customer template needed).

- [ ] **Step 3:** `npx tsc --noEmit` green.
- [ ] **Step 4 — commit:** `feat(branch4): escalation.unfulfillable initiator + owner i18n`

---

## Task 3: P3 — `escalateUnfulfillableRequest` engine function

**Files:** `src/domain/escalation/engine.ts` (+ test).

- [ ] **Step 1 — failing test.** Create `src/domain/escalation/engine.test.ts` mocking `db`, `enqueueMessage`, and `dispatchInitiation`; assert: (a) the manager identity is looked up and a message enqueued to their phone; (b) a row is inserted into `escalatedTasks` with `escalationType: 'unfulfillable'`; (c) a non-null customer reply is returned; (d) a missing manager does NOT throw (best-effort). Model it on the call shapes in `checkOwnerEscalationRules`.

- [ ] **Step 2 — schema enum.** In `src/db/schema.ts`, extend `escalatedTasks.escalationType` enum to `['platform', 'owner_rule', 'unfulfillable']`. This is a drizzle **text** column (enum enforced app-side only) — **no SQL migration required**; verify the column type is `text(...)` not a PG enum before relying on this.

- [ ] **Step 3 — implement.** Add to `engine.ts`, mirroring `checkOwnerEscalationRules` (manager lookup → `dispatchInitiation(getInitiator('escalation.unfulfillable'), …)` → `enqueueMessage` → `escalatedTasks` insert), but driven by an explicit call (no rule matching):
```ts
export async function escalateUnfulfillableRequest(
  db: Db,
  business: Business,
  customerPhone: string,
  requestText: string,
  customerLang: Lang = 'he',
): Promise<{ customerReply: string | null }> {
  const [managerIdentity] = await db
    .select({ id: identities.id, phoneNumber: identities.phoneNumber })
    .from(identities)
    .where(and(eq(identities.businessId, business.id), eq(identities.role, 'manager'), isNull(identities.revokedAt)))
    .limit(1)

  if (managerIdentity) {
    const managerLang: Lang = (business.defaultLanguage as Lang | null | undefined) ?? 'he'
    const managerMessage = i18n.escalation_manager_notify_unfulfillable[managerLang](customerPhone, requestText.slice(0, 300))
    await dispatchInitiation(db, getInitiator('escalation.unfulfillable'), {
      businessId: business.id,
      recipientId: managerIdentity.id,
      dedupKey: `escalation.unfulfillable:${business.id}:${customerPhone}:${Date.now()}`,
    }, {
      sendFreeForm: async () => { await enqueueMessage(business.id, managerIdentity.phoneNumber, managerMessage).catch(() => {}) },
    }).catch(() => { /* non-fatal */ })
  }

  await db.insert(escalatedTasks).values({
    businessId: business.id,
    customerPhone,
    messageBody: requestText.slice(0, 300),
    receivedAt: new Date(),
    escalationType: 'unfulfillable',
    forwardedAt: new Date(),
  }).catch(() => { /* non-fatal */ })

  // Customer-facing: "passed to the studio, someone will be in touch."
  const customerReply = await generateProactiveCustomerMessage({
    businessName: business.name,
    language: customerLang,
    situation: `The customer asked for a special arrangement we can't book automatically. Tell them warmly it's been passed to ${business.name} and someone will be in touch shortly — do NOT reject them or say it's impossible.`,
    fallback: i18n.escalation_customer_passed[customerLang](business.name),
    timeoutMs: 2500,
  })
  return { customerReply }
}
```
*(Optional, flag to owner — also insert a `deferredFeatureRequests` row so the request lands in the owner's feature backlog. Keep behind a one-line `.catch(() => {})`; out of scope if it widens review.)*

- [ ] **Step 4:** `npx vitest run src/domain/escalation/engine.test.ts` green; `npx tsc --noEmit` green.
- [ ] **Step 5 — commit:** `feat(branch4): escalateUnfulfillableRequest — notify owner, record, graceful customer reply`

---

## Task 4: P3 — wire gated escalation into the booking flow

**Problem:** The party-size branches and the out-of-hours branch currently reject/loop. When the request is a genuine special arrangement, they must escalate instead. Gate once per session so we don't re-notify the owner every turn.

**Design:** Add a session guard `specialRequestEscalated?: boolean` to `BookingFlowContext` (types.ts). At each unfulfillable branch, if `intent.specialArrangementRequest === true && !ctx.specialRequestEscalated && business`, call `escalateUnfulfillableRequest`, set the guard, and return the escalation reply; otherwise keep today's clarification behaviour verbatim.

- [ ] **Step 1 — context flag.** In `src/domain/flows/types.ts` `BookingFlowContext`, add `specialRequestEscalated?: boolean`.

- [ ] **Step 2 — helper.** Near the top of `customer-booking.ts`, add a small local:
```ts
async function maybeEscalateSpecial(
  db: Db, business: Business | undefined, ctx: BookingFlowContext, session: ActiveSession,
  identity: ResolvedIdentity, intent: CustomerIntentOutput, messageText: string, lang: 'he' | 'en',
): Promise<FlowResult | null> {
  if (!business || !intent.specialArrangementRequest || ctx.specialRequestEscalated) return null
  const { customerReply } = await escalateUnfulfillableRequest(
    db, business, identity.phoneNumber, intent.summary ?? messageText, lang,
  )
  await completeSession(db, session.id)
  return { reply: customerReply ?? '', sessionComplete: true, escalated: true }
}
```
Import `escalateUnfulfillableRequest` from `../escalation/engine.js`. Confirm `FlowResult` carries `escalated?` (it does — see the owner-rule escalation return at the unknown branch); if not, add it.

- [ ] **Step 3 — call-sites.** Insert a guard at the **top** of each branch, before today's reject/clarify reply:
  - Party-size 1-on-1 (`is a private, one-on-one session`): `const esc = await maybeEscalateSpecial(...); if (esc) return esc`
  - Over-capacity (`holds at most`): same.
  - Out-of-hours (`if (timingError || outsideHours)` — but only the `outsideHours` case, not a past/buffer `timingError`): gate so it fires only when `outsideHours && intent.specialArrangementRequest`. A plain bad-time-but-would-take-an-in-hours-slot request keeps today's "here are real openings" behaviour.

- [ ] **Step 4 — typecheck + trace.** `npx tsc --noEmit` green. Document in the commit: Harel 13:36:47 "private workshop for 5 outside hours" → party-size branch → `specialArrangementRequest=true` → owner notified once, customer told "passed to the studio."

- [ ] **Step 5 — commit:** `fix(branch4): escalate genuine special-arrangement requests to the owner instead of rejecting`

---

## Task 5: P3 — guard against false escalation (tests)

- [ ] **Step 1:** Unit-test `maybeEscalateSpecial` indirectly: a party-size mismatch WITHOUT `specialArrangementRequest` still hits the existing clarification (no escalation); WITH the flag → escalation path. Mock `escalateUnfulfillableRequest`.
- [ ] **Step 2:** Assert the per-session guard: a second special-arrangement turn in the same session does NOT re-notify (guard set).
- [ ] **Step 3 — commit:** `test(branch4): special-arrangement escalation gating (flag + once-per-session)`

---

## Task 6: P4 — durable last-cancellation memory (schema + migration)

**Problem:** `completeSession` after a cancel discards the slot; the restore lands in a fresh session that can't see it.

**Design:** Persist a small snapshot on `customer_profiles` (per-identity, already holds `lastBookingId`).

- [ ] **Step 1 — schema.** In `src/db/schema.ts` `customerProfiles`, add:
```ts
  lastCancelledBooking: jsonb('last_cancelled_booking').$type<{
    bookingId: string; serviceTypeId: string; serviceName: string; slotStartIso: string
  } | null>(),
  lastCancelledAt: timestamp('last_cancelled_at', { withTimezone: true }),
```

- [ ] **Step 2 — migration.** Create `src/db/migrations/0048_customer_last_cancelled.sql`:
```sql
ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS last_cancelled_booking jsonb;
ALTER TABLE customer_profiles ADD COLUMN IF NOT EXISTS last_cancelled_at timestamptz;
```
Update the drizzle `meta` snapshot via `npm run db:generate` if the repo tracks it (check `src/db/migrations/meta`); otherwise the hand-written SQL + `db:apply` path is fine — match whatever `0047` did.

- [ ] **Step 3:** `npx tsc --noEmit` green.
- [ ] **Step 4 — commit:** `feat(db): customer_profiles.last_cancelled_booking for restore-after-cancel`

---

## Task 7: P4 — persist the snapshot on a successful cancel

- [ ] **Step 1 — setter.** Wherever `customer_profiles` writes live (grep `customerProfiles` writes; likely a `profile` module), add:
```ts
export async function recordLastCancellation(
  db: Db, businessId: string, identityId: string,
  snap: { bookingId: string; serviceTypeId: string; serviceName: string; slotStartIso: string },
): Promise<void> {
  await db.insert(customerProfiles)
    .values({ businessId, identityId, lastCancelledBooking: snap, lastCancelledAt: new Date() })
    .onConflictDoUpdate({ target: customerProfiles.identityId, set: { lastCancelledBooking: snap, lastCancelledAt: new Date(), updatedAt: new Date() } })
}
```
(Match the existing upsert pattern in that module.)

- [ ] **Step 2 — call on cancel.** In `handleCancellationConfirmation`, in the **success** path (`result.ok`, just before `completeSession` at the `Booking successfully cancelled` reply), capture the slot snapshot. The booking row is needed: re-select `serviceTypeId`, `serviceName`, `slotStart` for `bookingId` (or thread them from `maybeEnterRetentionOffer`/the candidate row). Then `await recordLastCancellation(db, identity.businessId, identity.id, snap).catch(() => {})` (non-fatal). Do the same in the retention-offer **confirmed-cancel** path if it cancels without re-entering this function.

- [ ] **Step 3 — typecheck + commit:** `feat(branch4): snapshot the just-cancelled slot for restore`

---

## Task 8: P4 — extractor `restorePrevious` + restore handler

**Problem:** "תחזיר לי את השיעור שביטלנו" / "give me back the class we cancelled" is classified as `rescheduling`/`list_bookings`, listing unrelated bookings.

**Design:** LLM flags `restorePrevious`; a handler re-fills the draft from the snapshot and routes through the normal booking path (re-validating availability — if the slot was taken meanwhile, the customer is told and offered alternatives, which is correct).

- [ ] **Step 1 — extractor flag.** Mirror Task 1: add `restorePrevious?: boolean` to `CustomerIntentOutput`, `restorePrevious: z.boolean().default(false).catch(false)` to the schema, and a prompt rule:
```
- restorePrevious: true when the customer asks to UNDO a cancellation or bring back a booking they just cancelled ("restore it", "bring it back", "give me back the class we cancelled", "תחזיר לי את התור שביטלנו", "בא נחזיר את זה"). false otherwise.
```
Failing test first.

- [ ] **Step 2 — dispatch.** Early in the intent switch in `routeCustomerMessage`/`handleCustomerBooking` (before the `booking`/`rescheduling` cases — grep the `switch (intent.intent)` at customer-booking.ts:1008), add:
```ts
if (intent.restorePrevious) {
  const restored = await handleRestoreCancelled(db, calendar, identity, session, updatedCtx, intent, activeServices, businessTimezone, businessName, transcript, genReply, business)
  if (restored) return restored
  // else fall through to normal handling (no fresh snapshot → ask which/what day)
}
```

- [ ] **Step 3 — handler.** Add `handleRestoreCancelled(...)`: load `customer_profiles.lastCancelledBooking` + `lastCancelledAt`; bail (return `null`) if absent, older than `LAST_CANCEL_RESTORE_WINDOW_MINUTES` (default 120), or the snapshot's `slotStartIso` is in the past. Otherwise build a draft from the snapshot:
```ts
const lp = localParts(new Date(snap.slotStartIso), businessTimezone)
const slotDraft = { serviceTypeId: snap.serviceTypeId, serviceName: snap.serviceName, dateStr: lp.dateStr, time: { hour: Math.floor(lp.minutes / 60), minute: lp.minutes % 60 } }
const newCtx: BookingFlowContext = { ...updatedCtx, slotDraft }
await updateSessionContext(db, session.id, newCtx, 'active')
const synthetic: CustomerIntentOutput = { intent: 'booking', slotRequest: null, serviceTypeHint: null, providerHint: null, customerNameHint: null, participantsHint: null, summary: null, rawEntities: {}, detectedLanguage: lang, specialArrangementRequest: false, restorePrevious: false }
return handleBookingIntent(db, calendar, identity, { ...session, state: 'active', context: newCtx }, newCtx, synthetic, activeServices, businessTimezone, businessName, transcript, genReply, '', business)
```
This reuses the exact synthetic-intent re-book pattern already used by the reschedule path — `handleBookingIntent` runs the deterministic gate and confirmation ("Re-book your pilates Tuesday 30 Jun 14:00?"), so a taken slot is handled gracefully. Pass `activeServices` with full columns (the dispatch already has them).

- [ ] **Step 4 — tests.** Unit-test `handleRestoreCancelled`'s draft construction and freshness gating (fresh snapshot → draft built; stale/past/absent → `null`). Mock the profile read.

- [ ] **Step 5 — typecheck + trace.** Document: Harel 13:44 "give me back the class we cancelled" → `restorePrevious=true` → snapshot (Tue 30 Jun 14:00 pilates, 1 min old) → re-book confirmation for the exact slot.

- [ ] **Step 6 — commit:** `fix(branch4): restore a just-cancelled booking (restorePrevious + snapshot-driven re-book)`

---

## Task 9: P4 — end-to-end trace test

- [ ] **Step 1:** Add a flow-level test (or extend `customer-booking.test.ts`) that seeds a `lastCancelledBooking` snapshot and feeds a `restorePrevious` intent, asserting the reply confirms the **original** slot, not a "which day?" re-ask.
- [ ] **Step 2 — commit:** `test(branch4): restore-cancelled end-to-end draft + confirmation`

---

## Task 10: Full-suite + docs gate

- [ ] **Step 1:** `npm test` → all PASS.
- [ ] **Step 2:** `npx tsc --noEmit` → no errors.
- [ ] **Step 3:** `npx eslint src/domain src/adapters src/routes` → no new errors (no `src/skills` change → boundary lint unaffected).
- [ ] **Step 4 — docs.** In `ARCHITECTURE.md` Part 16 (Branch 4) — or the Branch-4 design doc — add: (a) **Owner escalation for unfulfillable requests** — LLM `specialArrangementRequest` + deterministic unfulfillability → `escalateUnfulfillableRequest` → owner notified, customer told "passed on," once per session; (b) **Restore-after-cancel** — `customer_profiles.lastCancelledBooking` snapshot + `restorePrevious` → snapshot-driven re-book through the normal gate, with a freshness window.
- [ ] **Step 5 — commit:** `docs(branch4): owner escalation for special requests + restore-after-cancel`

---

## Out of scope / explicitly NOT this plan

- **Occupancy "Monday is full" fabrication** and the **carried-`slotDraft` stale-day** assertion — owned by `fix/branch4-grounding-state-confirmation` (fresh-spine backstop). Do not touch occupancy gating.
- **Premature phone-nudge** on a legit "Tuesday pilates" — that branch's ROOT 6 (nudge gating). Do not touch `nudgeAfterRepeatedTries`.
- **`parseConfirmation` / side-question hold / per-identity lock / instructor roster** — all the parallel branch's.
- **A bespoke "private/group session" service type or pricing flow** — a product decision for the owner; this plan only routes the *request* to them.

## Self-review notes

- Symptom coverage: 2a (reject instead of escalate) → P3 (Tasks 1–5); 2b ("why Monday") → explained as carried `slotDraft` from "tomorrow" + the occupancy lie (parallel branch) — no new code here beyond P3 ending the dead-end; 3 (restore cancelled, Tuesday lost) → P4 (Tasks 6–9).
- Collision surface with the parallel branch: P3/P4 add a new engine function, a new initiator, an i18n pair, two `customer_profiles` columns, two extractor flags, and **localized inserts** at named branches in `customer-booking.ts`. No shared function bodies with the parallel branch's edits except same-file proximity — Task 0 rebase resolves anchors.
- Doctrine: LLM stays interpretive (flags request *shape*); deterministic core confirms unfulfillability and re-validates the restored slot before any state change.
- Durability: restore works across the session boundary (verified: live restore arrived in a fresh `waiting_clarification` session) because the snapshot is on `customer_profiles`, not session context.
