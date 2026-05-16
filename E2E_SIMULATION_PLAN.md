# E2E Simulation Plan — MiddleMan1

**Created:** 2026-05-16  
**Purpose:** Hermetic pre-launch validation across all system layers. Identifies what can be run automatically, what must be verified manually, and what features are not yet built.  
**Working scenario:** "Wellness Institute" — a business with multiple services, multiple instructors, group classes, 1-on-1 sessions, and varying slot configurations.

---

## How to Read This Document

Each scenario has:
- **ID** — unique reference (e.g. `C1`, `SC2`, `NW3`)
- **Layer** — what is being tested (routing, booking engine, concurrency, etc.)
- **Automated?** — `YES` (covered by existing tests), `PARTIAL` (partially covered), `NO` (must be run manually or requires new test)
- **Scenario** — what happens
- **Expected result** — what the system must do
- **Verify** — how to confirm (for manual items: numbered steps)
- **Gap** — if something is missing or at risk

---

## Part 1: Status Summary

| Area | Auto-Covered | Partially | Not Covered |
|---|---|---|---|
| Routing (4 branches) | ✅ | | |
| 1-on-1 booking (hold → confirm) | ✅ | | |
| Group class booking (capacity) | ✅ | | |
| Cancellation cutoff policy | ✅ | | |
| Payment flow (post_payment) | ✅ | | |
| Session expiry | ✅ | | |
| Manager onboarding (all 9 steps) | ✅ | | |
| Operator admin commands | ✅ | | |
| Hebrew/English localization | ✅ | | |
| DB concurrency (slot conflicts) | ✅ | | |
| parseConfirmation Hebrew gaps | | ⚠️ 8 known skips (B2.1–B2.8) | |
| Waitlist edge cases | | ⚠️ basic flow only | |
| Redis queue under contention | | ⚠️ basic test only | |
| Calendar API failure → rollback | | | ❌ |
| Skill workflow version conflicts | | | ❌ |
| DST gap handling | | | ❌ |
| Multi-business isolation | | | ❌ |
| Operator action ≠ booking delete | | | ❌ |
| Recurring templates | | | ❌ NOT BUILT |
| Subscriptions / punch cards | | | ❌ NOT BUILT |
| Member pricing tiers | | | ❌ NOT BUILT |
| Subscription expiry / renewal | | | ❌ NOT BUILT |

---

## Part 2: E2E Simulation Scenarios

---

### SECTION C — Connectivity & Routing

These verify that messages reach the correct branch and the correct handler is invoked. Wrong routing = silent corruption.

---

**C1 — Customer reaches booking flow**  
Layer: Routing  
Automated: YES (booking.test.ts)  
Scenario: A customer sends "I want to book a yoga class" to the business WhatsApp number.  
Expected: Message routed to Branch 3 (customer booking flow); intent classified as `booking`; session created with intent=booking.  
Verify: Covered by existing integration tests.

---

**C2 — Manager reaches manager flow**  
Layer: Routing  
Automated: YES (manager.test.ts)  
Scenario: A manager sends a message to the business number.  
Expected: Routed to Branch 3 with role=manager detection; orchestrator invoked (not customer booking flow).  
Verify: Covered by existing integration tests.

---

**C3 — Operator reaches operator admin**  
Layer: Routing  
Automated: YES (operator.test.ts)  
Scenario: OPERATOR_PHONE sends a message to PROVIDER_WA_NUMBER.  
Expected: Routed to Branch 1 (handleOperatorMessage); operator commands available.  
Verify: Covered.

---

**C4 — Unknown number triggers onboarding**  
Layer: Routing  
Automated: YES  
Scenario: A new phone number (not OPERATOR_PHONE) messages PROVIDER_WA_NUMBER.  
Expected: Branch 0 (provider-onboarding) invoked; session step = `business_name`.  
Verify: Covered.

---

**C5 — Revoked customer is rejected at identity resolution**  
Layer: Routing + Identity  
Automated: NO  
Scenario: Customer whose `revokedAt` is non-null sends a message.  
Expected: `resolveIdentity` returns null/rejected; system sends rejection reply; no session created; no booking created.  
Verify:

1. In DB: find or create an identity row with `revokedAt = now()` for a test phone number.
2. Send a message from that phone number to the business WhatsApp.
3. Check `conversationSessions` — no new active session should exist for that identity.
4. Check `bookings` — no booking rows created.
5. Check WhatsApp reply — should receive a polite rejection (or no reply if that is the configured behavior).

Gap: No test exists for revoked identity. This is a critical security path — revoked customers should be silently blocked, not allowed to book.

---

**C6 — Deduplication: same messageId sent twice**  
Layer: Routing + Dedup  
Automated: PARTIAL (adversarial.test.ts mentions this)  
Scenario: WhatsApp delivers the same webhook payload twice (retry scenario).  
Expected: Second delivery is detected via `processedMessages` table; no second session created; no duplicate booking.  
Verify:

1. POST same webhook payload twice to `/webhook` within seconds.
2. Check `processedMessages` — only one row for that messageId.
3. Check `bookings` — only one booking if a booking was triggered.
4. Check `conversationMessages` — only one message record.

---

**C7 — Two different businesses: messages do not cross**  
Layer: Multi-tenant isolation  
Automated: NO  
Scenario: Business A and Business B both have active customer sessions. A customer of Business A sends a message at the same time as a customer of Business B.  
Expected: Each message resolves identity against its own `businessId`; contexts never bleed; replies are scoped to the correct business.  
Verify:

1. Seed two businesses (Business A: Wellness Institute, Business B: Barbershop) each with their own WhatsApp number.
2. Simultaneously send booking requests from two different customer phones, one per business.
3. Verify `conversationSessions` — each session has the correct `businessId`.
4. Verify `bookings` — each booking references its correct `businessId` and `serviceTypeId`.
5. Verify WhatsApp replies — each customer receives a reply referencing their own business's services, not the other's.

Gap: No isolation test exists. This is critical before provisioning multiple businesses.

---

### SECTION SC — Schedule Checks (Concurrent Slots)

The Wellness Institute scenario: multiple classes at the same time, each with a different instructor, different number of slots, different price, different session length.

---

**SC1 — Two group classes at the same time, different service types**  
Layer: Booking Engine  
Automated: PARTIAL  
Scenario: At 10:00 on Thursday, Business offers both "Yoga (45 min, 12 spots, 150 NIS)" and "Pilates (60 min, 8 spots, 200 NIS)". Alice books yoga; Bob books pilates. Both classes at the same time.  
Expected: Both bookings succeed independently. Alice's booking is for `serviceTypeId=yoga`; Bob's for `serviceTypeId=pilates`. Capacities are tracked separately. Neither booking blocks the other.  
Verify:

1. Seed: two service types (`yoga`, `pilates`) with different `maxParticipants` and `durationMinutes`.
2. Send booking request for yoga from Alice's phone → confirm booking → verify booking row: `serviceTypeId=yoga, state=confirmed`.
3. Send booking request for pilates from Bob's phone for the same time slot → confirm → verify booking row: `serviceTypeId=pilates, state=confirmed`.
4. Check `bookings` table: two rows, same `slotStart`, different `serviceTypeId`, both `confirmed`.
5. Check Google Calendar (if using google mode): two separate calendar events at 10:00.

Gap: No test covers two different service types at the exact same time. Existing tests use a single service type per scenario.

---

**SC2 — Same group class fills up; late-arrival is waitlisted**  
Layer: Booking Engine + Waitlist  
Automated: PARTIAL (basic capacity test exists; waitlist edge cases do not)  
Scenario: Yoga class has `maxParticipants=3`. Alice, Bob, and Carol each book. David tries to book — class is full.  
Expected: Alice, Bob, Carol: `state=confirmed`. David: rejected with "class is full"; David is offered waitlist entry.  
Verify:

1. Seed: `yoga` service with `maxParticipants=3`.
2. Book from Alice, Bob, Carol in sequence — all should confirm.
3. Book from David — should receive "class is full" reply.
4. Check `bookings` for David — no booking row, or row in `inquiry` state only.
5. Check `waitlist` — David's phone should have a pending waitlist entry.

---

**SC3 — Waitlist cascade: confirmed customer cancels, waitlisted customer is notified**  
Layer: Booking Engine + Workers (waitlist)  
Automated: PARTIAL (basic waitlist flow exists; edge cases missing)  
Scenario: Same yoga class above. Carol (confirmed) cancels. David (waitlisted) should be offered the spot.  
Expected: Carol's booking transitions to `cancelled`. Waitlist worker triggers, finds David's pending entry, sets status=`offered`, sends WhatsApp message to David with offer expiry.  
Verify:

1. Continue from SC2. Carol sends "cancel my booking."
2. Verify Carol's booking: `state=cancelled, cancelledByRole=customer`.
3. Verify `waitlist` row for David: `status=offered, offeredAt` is set, `offerExpiresAt = offeredAt + WAITLIST_OFFER_TTL_MINUTES`.
4. Verify WhatsApp message sent to David offering the spot.
5. David accepts (sends "yes") within TTL → David should get a confirmed booking.
6. Verify `waitlist` for David: `status=accepted`.

---

**SC4 — Waitlist offer expires: David doesn't respond; slot goes to next waitlisted customer**  
Layer: Workers (waitlist expiry)  
Automated: NO  
Scenario: David's waitlist offer expires (David does not respond within TTL). Eve is also on the waitlist.  
Expected: David's waitlist entry: `status=expired`. Eve's entry: `status=offered`, new WhatsApp message sent to Eve.  
Verify:

1. Add Eve to waitlist after David.
2. Let David's offer TTL pass (default 15 min — in test environment, manipulate `offerExpiresAt` directly in DB to a past timestamp).
3. Trigger waitlist worker manually (or wait for next run).
4. Verify David's waitlist: `status=expired`.
5. Verify Eve's waitlist: `status=offered`.
6. Verify WhatsApp: Eve received an offer message.

---

**SC5 — Customer already has a confirmed booking; tries to book same class again (double-booking prevention)**  
Layer: Booking Engine  
Automated: PARTIAL (mentioned in engine.ts; not a standalone integration test)  
Scenario: Alice is confirmed in the yoga class. Alice sends another booking request for the same class at the same time.  
Expected: System rejects with "You already have a booking for this class" (or equivalent). No duplicate booking created.  
Verify:

1. Alice has `state=confirmed` booking for yoga at 10:00 Thursday.
2. Alice sends: "Book me yoga on Thursday at 10."
3. Verify: system replies with a message indicating she's already booked.
4. Verify `bookings`: only one row for Alice + yoga + that slot. No second row.

---

**SC6 — Two customers try to book the last spot simultaneously (race condition)**  
Layer: Booking Engine + DB Concurrency  
Automated: YES (adversarial.test.ts covers race conditions)  
Scenario: Yoga class has 1 spot left. David and Eve simultaneously request to book.  
Expected: Exactly one succeeds; the other receives "class is full." No overbooking. DB transaction with count lock prevents both succeeding.  
Verify: Covered by adversarial.test.ts.

---

**SC7 — Manager queries booking count; query does not modify data**  
Layer: Manager Flow + No-Overwrite Invariant  
Automated: NO — this is the core no-overwrite check requested  
Scenario: Manager sends: "How many bookings do we have for Thursday's yoga class?" System should return the count and nothing else. No bookings should be modified, cancelled, or deleted as a side effect.  
Expected: Manager receives a count and list of booked customers. All `booking` rows remain unchanged. No `cancelledAt`, no state transitions, no `auditLog` write-mutation entries.  
Verify:

1. Set up: 3 confirmed bookings for Thursday yoga class.
2. Snapshot `bookings` table (record all row states, `updatedAt` values).
3. Manager sends the query: "How many people are booked in Thursday's yoga?"
4. Verify the reply contains the count (3) and names/phones.
5. Re-read `bookings` table — all rows must be byte-for-byte identical to snapshot (same states, same `updatedAt`, no new rows).
6. Check `auditLog` — no mutation entries (INSERT/UPDATE/DELETE) for booking rows in this time window.

Gap: Critical invariant with no dedicated test. If the LLM orchestrator accidentally triggers a cancellation or expiry when the manager asks "how many bookings," that is silent data loss.

---

**SC8 — Manager cancels one booking; sibling bookings in same class are untouched**  
Layer: Manager Flow + No-Overwrite  
Automated: NO  
Scenario: Yoga class has Alice, Bob, Carol confirmed. Manager sends: "Cancel Carol's booking for Thursday yoga." Only Carol's booking should be cancelled.  
Expected: Carol's booking → `cancelled`. Alice and Bob remain `confirmed`. Google Calendar event remains (other participants still enrolled).  
Verify:

1. Set up: Alice, Bob, Carol all confirmed for Thursday yoga.
2. Manager sends cancellation instruction for Carol.
3. Verify Carol's booking: `state=cancelled, cancelledByRole=manager`.
4. Verify Alice's booking: `state=confirmed` — unchanged.
5. Verify Bob's booking: `state=confirmed` — unchanged.
6. Verify Google Calendar: event still exists with Alice and Bob as participants; Carol removed (or event preserved for remaining participants).
7. Check `auditLog`: one cancellation entry for Carol's booking; zero mutations for Alice and Bob.

---

**SC9 — Two sessions in the same year: each session has independent data**  
Layer: Booking Engine + Data Isolation  
Automated: NO  
Scenario: Business runs "Spring Yoga Retreat" (May) and "Summer Yoga Retreat" (August). Same service type, different instances. Each has different instructors (if/when instructor-per-booking is implemented), different prices (different `serviceTypes` rows), different participant counts.  
Expected: Bookings for each retreat are completely independent. Cancelling a retreat-A booking does not affect retreat-B. Viewing retreat-B's bookings does not include retreat-A's.  
Verify:

1. Create two `serviceType` rows: `yoga_spring_retreat` (price 300, max 10) and `yoga_summer_retreat` (price 350, max 12).
2. Book 3 customers into spring retreat and 3 different customers into summer retreat.
3. Cancel one spring retreat booking.
4. Verify: only that spring retreat booking is cancelled; all summer retreat bookings remain confirmed; spring retreat has 2 confirmed, summer has 3 confirmed.
5. Manager queries "how many booked for summer retreat" — returns 3, not 2, not 5.

---

### SECTION NW — No-Overwrite / State Preservation Invariants

These are the "read must never equal write" checks. No query, status check, or reporting action should have a side effect on booking state.

---

**NW1 — `list_bookings` intent does not mutate any booking**  
Layer: Customer Flow + No-Overwrite  
Automated: NO  
Scenario: Customer sends "Show me my upcoming bookings." System lists their bookings.  
Expected: All booking rows unchanged after the query.  
Verify:

1. Customer has 2 upcoming confirmed bookings.
2. Snapshot `bookings` for this customer.
3. Customer sends: "What are my upcoming appointments?"
4. System replies with a list.
5. Re-query `bookings` — no state changes, no `updatedAt` changes, no new rows.

---

**NW2 — `inquiry` intent does not mutate any booking**  
Layer: Customer Flow + No-Overwrite  
Automated: NO  
Scenario: Customer asks "What's the cancellation policy?" — a pure inquiry. No booking should be touched.  
Verify: Same pattern as NW1 — snapshot before, compare after.

---

**NW3 — Operator STATUS command does not mutate any business data**  
Layer: Operator Flow + No-Overwrite  
Automated: NO  
Scenario: Operator sends "STATUS Wellness Institute."  
Expected: Operator receives a business summary. No rows modified in `businesses`, `bookings`, `identities`, or `serviceTypes`.  
Verify:

1. Snapshot `businesses`, `bookings`, `serviceTypes` for Wellness Institute.
2. Operator sends "STATUS Wellness Institute."
3. Re-read all tables — no changes.
4. Check `auditLog` — no mutation entries in this time window (read-only reads should not log).

---

**NW4 — Hold check does not extend or reset expiry**  
Layer: Booking Engine  
Automated: NO  
Scenario: A booking is in `held` state with `holdExpiresAt = T+5min`. Manager sends "how many holds do we have?" The held booking's `holdExpiresAt` must not change.  
Verify:

1. Create a held booking, note `holdExpiresAt`.
2. Manager queries "show me pending holds."
3. Re-read `bookings` — `holdExpiresAt` must be the same value.

---

### SECTION BE — Booking Engine Deep Paths

---

**BE1 — Full 1-on-1 booking lifecycle: inquiry → held → confirmed**  
Layer: Booking Engine  
Automated: YES (booking.test.ts)

---

**BE2 — Hold expiry: held booking auto-expires after TTL**  
Layer: Booking Engine + Workers  
Automated: PARTIAL  
Scenario: Customer initiates a booking, gets a hold. Customer never confirms. `holdExpiresAt` passes. Hold-expiry worker runs.  
Expected: Booking transitions `held → expired`. WhatsApp message sent to customer ("Your hold has expired"). Calendar hold removed.  
Verify:

1. Create a held booking. Set `holdExpiresAt` to 2 minutes from now in DB.
2. Wait for hold-expiry worker to run (runs every 60s).
3. Verify `bookings`: `state=expired`.
4. Verify `auditLog`: transition logged.
5. Verify WhatsApp: customer received expiry notification.
6. Verify calendar (if google mode): hold event deleted.

Gap: The hold grace period (default 60s) means the worker only fires 60s after `holdExpiresAt`. Test must account for this.

---

**BE3 — Post-payment confirmation flow**  
Layer: Booking Engine  
Automated: YES (booking.test.ts)  
Scenario: Business uses `confirmationGate=post_payment`. Customer requests booking → `pending_payment`. Manager confirms payment received → `confirmed`.

---

**BE4 — Cancellation cutoff enforced for customer**  
Layer: Booking Engine  
Automated: YES (booking.test.ts)  
Scenario: Business has `cancellationCutoffMinutes=120`. Customer tries to cancel 60 minutes before slot.  
Expected: Rejected with "Too late to cancel" reply.

---

**BE5 — Calendar failure during booking → booking rolled back**  
Layer: Booking Engine + Calendar Adapter  
Automated: NO  
Scenario: Google Calendar API returns an error when creating the calendar hold.  
Expected: Booking is NOT created (or if inserted in DB, its state is rolled back to `failed`). Customer receives error reply. No orphaned booking row in `held` state with no calendar event.  
Verify:

1. Configure test to simulate calendar API failure (e.g., temporarily revoke OAuth token or point to invalid calendar ID).
2. Attempt a 1-on-1 booking.
3. Verify `bookings` table: no row in `held` state. If a row was inserted, it must be in `failed` state.
4. Verify `auditLog`: failure logged.
5. Restore calendar access. New booking attempt succeeds.

Gap: No calendar failure test exists. This is a real production risk — if calendar holds fail silently, customers believe they are booked when they are not.

---

**BE6 — Rescheduling: old booking cancelled, new slot conflict-checked**  
Layer: Booking Engine  
Automated: YES (booking.test.ts)  
Scenario: Customer reschedules from Thursday 10:00 to Friday 11:00. Old slot must be cancelled cleanly before new booking is created.  
Expected: Thursday booking → `cancelled`. New Friday booking → `confirmed`. If Friday slot is already taken, rescheduling rejected.

---

**BE7 — Group class: calendar event created on first participant, reused by subsequent, deleted only on last cancel**  
Layer: Booking Engine + Calendar  
Automated: NO  
Scenario: 3 participants in a yoga class. First participant triggers calendar event creation. Second and third reuse it. Second and third cancel, leaving only one participant. Last participant cancels — event should be deleted.  
Verify:

1. Book Alice into yoga class → verify calendar event created.
2. Book Bob → verify same calendar event referenced (not a new event).
3. Book Carol → same.
4. Carol cancels → verify event still exists (Alice and Bob remain).
5. Bob cancels → verify event still exists (Alice remains).
6. Alice cancels → verify event deleted from calendar.

Gap: Critical for group class cleanup. No test for this full lifecycle.

---

### SECTION MI — Manager Instruction Safety

---

**MI1 — Availability query does not modify availability**  
Layer: Manager Flow + No-Overwrite  
Automated: NO  
Scenario: Manager asks "When is Mickey available this week?"  
Expected: System returns Mickey's availability window. No `availability` rows modified.  
Verify:

1. Snapshot `availability` for Mickey's identity.
2. Manager sends the query.
3. Re-read `availability` — identical.

---

**MI2 — Availability change (add hours) does not affect existing bookings**  
Layer: Manager Instructions + No-Overwrite  
Automated: NO  
Scenario: Manager adds "Saturday 10:00–14:00" to availability. Existing confirmed bookings for other days must not be touched.  
Verify:

1. Snapshot `bookings` for business.
2. Manager instruction: "Add Saturday availability 10 to 2."
3. Verify `availability`: new row for dayOfWeek=6.
4. Re-read `bookings` — no changes, no state transitions, no `updatedAt` changes.

---

**MI3 — Blocking a day does not retroactively cancel existing bookings**  
Layer: Manager Instructions  
Automated: NO  
Scenario: Manager blocks Thursday (setting availability to closed). There are existing confirmed bookings on Thursday.  
Expected: `availability` updated (Thursday blocked). Existing `bookings` for Thursday remain `confirmed` — no automatic cancellation. Manager should be notified that there are existing bookings on that day (if that is the designed behavior).  
Verify:

1. Create 2 confirmed bookings on Thursday.
2. Manager: "Block Thursday, no availability."
3. Verify `availability`: Thursday blocked.
4. Verify `bookings`: both Thursday bookings still `confirmed`. No state change.
5. Verify manager reply: should mention "Note: you have X existing bookings on Thursday that are still confirmed."

Gap: The system does not currently define this behavior explicitly. This needs a design decision: auto-cancel existing bookings when day is blocked, or leave them and warn? This is a CRITICAL UX decision before launch.

---

**MI4 — Service change (price update) does not affect already-confirmed bookings**  
Layer: Manager Instructions + No-Overwrite  
Automated: NO  
Scenario: Manager changes yoga price from 150 to 180 NIS. Existing confirmed yoga bookings should keep the price they were booked at (150).  
Verify:

1. Snapshot all confirmed yoga bookings with their `paymentStatus`.
2. Manager: "Change yoga price to 180 shekels."
3. Verify `serviceTypes`: durationMinutes or cost field updated (if cost is stored per serviceType).
4. Verify `bookings`: no changes to existing confirmed rows.

Note: If pricing is not stored on the booking row (only on the serviceType), this creates a retroactive price change risk. The schema currently stores no price on `bookings`. This is a gap — historical bookings lose their original price context.

---

### SECTION OP — Operator Admin Safety

---

**OP1 — Operator "UPDATE ALL" bulk instruction applies per-business without overwriting**  
Layer: Operator Flow + No-Overwrite  
Automated: YES (operator.test.ts covers basic bulk update)  
Scenario: Operator sends "UPDATE ALL: Closed on Memorial Day." Each business gets the instruction applied independently.  
Expected: Each business's `availability` is updated for that specific date. No business's unrelated settings are changed. `agentUpdateLog` records count of applied businesses.

---

**OP2 — Operator RETRIGGER does not create duplicate active skill workflows**  
Layer: Operator Flow + Skill Workflows  
Automated: NO  
Scenario: Operator sends "RETRIGGER Wellness Institute website-builder." Business already has an active website-builder workflow.  
Expected: Retrigger is rejected with "Workflow already active" message. No second active workflow created. Partial unique index `(identityId, skillName) WHERE status='active'` enforces this.  
Verify:

1. Ensure `skillWorkflows` has an active row for website-builder for Wellness Institute.
2. Operator sends RETRIGGER command.
3. Verify operator receives "already active" reply.
4. Verify `skillWorkflows`: still only one active row.

---

**OP3 — Operator escalation resolution does not affect booking state**  
Layer: Operator Flow + No-Overwrite  
Automated: NO  
Scenario: An escalated customer complaint is resolved by operator. The customer's existing bookings should not change.  
Verify:

1. Customer has a confirmed booking. An escalation row exists for this customer.
2. Operator marks escalation resolved (if that command exists).
3. Verify `bookings`: customer's confirmed booking unchanged.
4. Verify `escalatedTasks`: `resolvedAt` set.

---

### SECTION WK — Workers & Background Jobs

---

**WK1 — Reminder worker: 24h and 1h reminders sent exactly once**  
Layer: Workers  
Automated: NO  
Scenario: A booking is confirmed. Reminder worker schedules two jobs (24h before, 1h before). Both fire. The `reminders` table has a unique constraint `(bookingId, triggerType)` preventing duplicates.  
Verify:

1. Confirm a booking for a future slot (e.g., 26 hours from now in test time).
2. Verify two jobs queued in BullMQ for this booking.
3. After 24h-reminder fires: verify `reminders` row exists with `triggerType=24h, sentAt` set.
4. After 1h-reminder fires: verify second row with `triggerType=1h`.
5. Verify no third or fourth reminder row for this booking.

---

**WK2 — Session expiry worker transitions sessions and enqueues summaries**  
Layer: Workers  
Automated: YES (silent.test.ts covers expiry)

---

**WK3 — Daily briefing worker fires in correct timezone**  
Layer: Workers + Timezone  
Automated: NO  
Scenario: Business has `timezone=Asia/Jerusalem`. Daily briefing should fire at the configured local morning time, not UTC.  
Verify:

1. Set business `dailyBriefingEnabled=true`.
2. Observe worker firing time — should match local business timezone morning, not UTC morning.
3. Verify manager receives the briefing WhatsApp at the expected local time.

---

**WK4 — Hold expiry worker: grace period respected**  
Layer: Workers  
Automated: NO  
Scenario: A hold's `holdExpiresAt` has passed, but the confirm-booking call arrives within the `HOLD_GRACE_PERIOD_SECONDS` window (default 60s). The hold should still be confirmable.  
Verify:

1. Create a held booking. Manually set `holdExpiresAt = now - 30s` (within 60s grace).
2. Attempt `confirmBooking` — should succeed.
3. Verify `bookings`: `state=confirmed`.
4. Repeat with `holdExpiresAt = now - 120s` (outside grace) → should fail with "Hold expired."

---

### SECTION SK — Skills

---

**SK1 — Skill canHandle is side-effect-free**  
Layer: Skills Boundary  
Automated: NO  
Scenario: All three skills' `canHandle()` functions are called for a message. None should modify DB, send messages, or call external APIs.  
Verify: Code review + trace — each `canHandle` must only read `ctx` (pure function). File: `src/skills/*/index.ts`.

---

**SK2 — Skill workflow version conflict: concurrent advance rejected**  
Layer: Skills + Optimistic Locking  
Automated: NO  
Scenario: Two concurrent messages attempt to advance the same skill workflow step simultaneously.  
Expected: First advance succeeds (version incremented). Second advance sees stale version → throws `WorkflowVersionConflictError`. No double-step-advance. Partial unique index + version check enforces this.  
Verify:

1. Create an active skill workflow at step `S1`, version `3`.
2. Simultaneously call `advanceWorkflow(workflowId, "S2", state, 3)` from two concurrent requests.
3. Verify exactly one succeeds. The other throws `WorkflowVersionConflictError`.
4. Verify `skillWorkflows`: `step=S2`, `version=4`.

---

**SK3 — Skill cannot import from domain core (ESLint boundary)**  
Layer: Skills Boundary  
Automated: YES (ESLint CI)  
Scenario: Any file in `src/skills/` that imports from `src/domain/`, `src/adapters/`, `src/db/`, `src/workers/`, or `src/routes/` fails ESLint.  
Verify: Run `npm run lint` and confirm zero boundary violations.

---

**SK4 — Skill failure does not crash the booking flow**  
Layer: Skills + Error Isolation  
Automated: NO  
Scenario: A skill's `handle()` throws an unexpected exception. The customer flow should not crash; customer should receive a fallback reply.  
Verify:

1. Temporarily make a skill's `handle()` throw a `new Error("unexpected")`.
2. Send a message that would trigger that skill.
3. Verify: customer receives a fallback reply (not a crash response).
4. Verify: `workflowStepLogs`: FATAL entry logged.
5. Verify: no unhandled promise rejection crashes the process.

---

### SECTION LG — Language & Localization

---

**LG1 — Hebrew message gets Hebrew reply**  
Layer: Language  
Automated: YES (language.test.ts)

---

**LG2 — English message gets English reply**  
Layer: Language  
Automated: YES (language.test.ts)

---

**LG3 — Language switch mid-conversation**  
Layer: Language  
Automated: YES (language.test.ts)

---

**LG4 — parseConfirmation Hebrew gaps (B2.1–B2.8)**  
Layer: Language + Booking  
Automated: PARTIAL — 8 tests are marked `it.skip()` in booking.test.ts  
Scenario: Hebrew customers confirming bookings using natural-language variants ("כן, בסדר", "מאשר", etc.) that the parser does not currently recognize.  
Gap: These must be fixed before launch — a Hebrew customer who says "כן" and gets no confirmation is a critical UX failure.  
Action required: Resolve B2.1–B2.8 skipped tests before provisioning Hebrew-speaking businesses.

---

**LG5 — DST gap: booking slot that falls in daylight-saving transition hour**  
Layer: Language + Timezone  
Automated: NO  
Scenario: In Israel, clocks move forward 1 hour in late March. A customer tries to book at 02:30 which does not exist on that day.  
Expected: System detects the gap (via `checkDSTGap` in `customer-booking.ts`) and prompts for a valid time.  
Verify:

1. Set business timezone to `Asia/Jerusalem`.
2. Attempt to book a slot at 02:30 on a DST transition date (look up Israel's 2026 DST date).
3. Verify system rejects or redirects to a valid time.

Gap: `checkDSTGap` function exists but has no test.

---

### SECTION PR — Payment & Post-Payment Gate

---

**PR1 — post_payment flow: customer NOT confirmed until manager confirms payment**  
Layer: Booking Engine  
Automated: YES (booking.test.ts)

---

**PR2 — Multiple pending_payment bookings: confirming one does not affect others**  
Layer: Booking Engine + No-Overwrite  
Automated: NO  
Scenario: Alice and Bob both have `pending_payment` bookings. Manager confirms Alice's payment. Bob's booking must remain `pending_payment`.  
Verify:

1. Create two `pending_payment` bookings for Alice and Bob.
2. Manager: "Confirm payment received from Alice."
3. Verify Alice's booking: `state=confirmed, paymentStatus=paid`.
4. Verify Bob's booking: `state=pending_payment, paymentStatus=pending` — unchanged.

---

**PR3 — Payment confirmation for already-confirmed booking (idempotency)**  
Layer: Booking Engine  
Automated: NO  
Scenario: Alice's booking is already `confirmed`. Manager accidentally sends "Confirm payment from Alice" again.  
Expected: System rejects gracefully ("Booking is already confirmed"). No state change. No duplicate audit entry.

---

### SECTION AU — Authorization

---

**AU1 — Customer cannot cancel another customer's booking**  
Layer: Authorization  
Automated: YES (authorization/check.test.ts — unit level)  
Integration-level: NO  
Verify: Integration test where Alice sends a cancellation referencing Bob's booking ID should be rejected with authorization error.

---

**AU2 — Delegated user has only granted actions**  
Layer: Authorization  
Automated: YES (unit level)  
Integration-level: NO  
Scenario: A delegated user with `booking.request` permission tries to send a manager instruction.  
Expected: Authorization check fails. Instruction not applied.

---

### SECTION ED — Webhook & Route Security

---

**ED1 — Invalid webhook signature rejected**  
Layer: Routes  
Automated: NO  
Scenario: POST to `/webhook` with invalid or missing `X-Hub-Signature-256`.  
Expected: 403 response. No message processing.  
Verify:

1. Send POST to `/webhook` with no signature header.
2. Expect HTTP 403.
3. Check `processedMessages` — no new row.

---

**ED2 — Expired import token rejected**  
Layer: Routes  
Automated: NO  
Scenario: POST to `/import/<token>` where token's `expiresAt` has passed.  
Expected: 401 or 400 response. No customers imported.  
Verify:

1. Create an import token in DB with `expiresAt = now - 1 hour`.
2. POST to `/import/<token>` with a CSV body.
3. Expect error response.
4. Check `identities` — no new rows imported.

---

**ED3 — Simulation endpoint `/simulate` is not accessible in production**  
Layer: Routes + Security  
Automated: NO  
Verify: Confirm `/simulate` route is gated by an environment check (only available when `NODE_ENV=test` or similar). A production request to this endpoint should return 404.

Gap: If `/simulate` is exposed in production, it can be used to inject fake WhatsApp messages and trigger bookings/cancellations.

---

## Part 3: Manual Verification Checklist

These items cannot be automated because they require either real WhatsApp delivery, real calendar integration, real time progression, or production environment checks. Run these before first provisioning.

---

### MANUAL-01 — End-to-end booking via WhatsApp (real device)

1. Provision a test business (Wellness Institute) with `yoga` and `pilates` service types.
2. From a real WhatsApp number (not simulated), send: "I'd like to book a yoga class."
3. Follow the conversation to completion (service selection → date → time → confirm).
4. Verify in DB: `bookings` has a `confirmed` row.
5. Verify in Google Calendar: event appears on the business calendar.
6. Verify WhatsApp: customer received a confirmation message with booking details.
7. Wait 24 hours: verify reminder message sent.
8. Check: booking row is unchanged; `reminders` has a `24h` row with `sentAt`.

---

### MANUAL-02 — Manager books on behalf of customer

1. Manager sends: "Book a yoga class for +972XXXXXXXX on Thursday at 10."
2. Verify DB: booking created with `customerId` = the specified phone's identity, `cancelledByRole` is null.
3. Verify customer received a WhatsApp confirmation.
4. Verify manager received acknowledgement.

---

### MANUAL-03 — Google Calendar OAuth round-trip

1. Trigger onboarding for a new business.
2. At the calendar step, click the OAuth link.
3. Complete Google OAuth consent.
4. Verify `/oauth/google/callback` receives the token.
5. Verify `businesses.googleRefreshToken` is set.
6. Verify onboarding advances to next step.
7. Make a test booking → verify event appears in Google Calendar.

---

### MANUAL-04 — WhatsApp webhook signature verification (production mode)

1. In staging/production environment, POST to `/webhook` with a known-good payload signed with the correct `WHATSAPP_APP_SECRET`.
2. Expect 200 and message processed.
3. POST same payload with tampered signature → expect 403.

---

### MANUAL-05 — Multi-instructor scenario (if instructors are tracked per booking)

Note: The current schema stores `providerId` on bookings (nullable). This test verifies that two different instructors can run different classes at the same time.

1. Create two provider identities: Mickey (yoga instructor) and Dana (pilates instructor).
2. Assign Mickey to `yoga` service; Dana to `pilates` service (via `providerAssignments`).
3. Book Alice into yoga at 10:00 (providerId = Mickey).
4. Book Bob into pilates at 10:00 (providerId = Dana).
5. Verify: two booking rows, same `slotStart`, different `providerId`, different `serviceTypeId`.
6. Verify: Mickey's availability is consumed for that slot; Dana's availability is consumed independently.
7. Verify: cancelling Alice's yoga booking does not affect Bob's pilates booking or Dana's schedule.

---

### MANUAL-06 — Subscription expiry and renewal reminder (BLOCKED — feature not built)

See Part 4 for the feature specification that must be built before this can be tested.

---

### MANUAL-07 — Template sessions / skeleton classes (BLOCKED — feature not built)

See Part 4 for the feature specification that must be built before this can be tested.

---

## Part 4: Gap Feature Specifications

These features were described as requirements but do not exist in the current codebase. They must be designed and built before they can be tested. Each spec describes the intended behavior; the implementation approach is for Developer A to define.

---

### GAP-01 — Recurring Session Templates ("Skeleton Sessions")

**Intent:** Business owner defines a recurring class skeleton: service type, duration, max participants, price, fixed weekly time slot. The skeleton repeats every week but is incomplete until an instructor is assigned. The manager assigns the instructor conversationally ("Set up Thursday yoga, instructor Mickey"). If instructor is unknown at setup time, the system prompts the manager each week.

**Required new data:**
- `sessionTemplates` table: `businessId, serviceTypeId, dayOfWeek, startTime, durationMinutes, maxParticipants, requiresInstructorAssignment (bool)`
- `sessionOccurrences` table: `templateId, scheduledDate, providerId (nullable), slotStart, slotEnd, status (scheduled/active/cancelled)`

**Required new flows:**
- Manager can create a template: "Set up a weekly yoga class every Thursday at 10, 45 minutes, 12 spots."
- Weekly job creates occurrence rows for the upcoming week; if `requiresInstructorAssignment=true`, sends manager a prompt for each unfilled occurrence.
- Manager responds: "Thursday yoga — instructor is Mickey." → system fills `providerId` on the occurrence.
- Customers book against `sessionOccurrences`, not raw `serviceTypes`.

**Manager can also:**
- Ad-hoc: "Add a yoga class this Friday at 3, instructor Dana, same settings as the template."
- Override one occurrence: "Move Thursday yoga to 11:00 this week only."
- Override permanently: "From next month, Thursday yoga is at 11:00."

**Parameters that can be variable (manager decides at setup):**
- Instructor: required each week OR fixed
- Max participants: fixed in template OR asked each week
- Price: fixed in template OR variable

**Test scenarios to write once built:**
- Template created → occurrence auto-generated for next 4 weeks.
- Instructor prompt sent at configured lead time → manager assigns → occurrence becomes bookable.
- Customer books occurrence → `sessionOccurrences.bookedCount` incremented.
- Manager moves one occurrence → sibling occurrences unaffected.
- Manager cancels one occurrence → customers notified; other occurrences unaffected.

---

### GAP-02 — Subscriptions / Punch Cards / Memberships

**Intent:** Customers can purchase a membership or punch card that grants access to sessions. Sessions may be configured to accept: (a) only subscribers, (b) subscribers + pay-per-session, (c) everyone at the same price, (d) everyone, but subscribers get a discount.

**Required new data:**
- `membershipPlans` table: `businessId, name, punchCount (nullable), validityDays, price, autoRenew (bool)`
- `customerMemberships` table: `customerId, businessId, planId, purchasedAt, expiresAt, punchesRemaining (nullable), status (active/expired/cancelled)`
- `serviceTypes` additions: `accessPolicy (open|subscribers_only|mixed)`, `subscriberDiscountPercent (nullable)`, `subscriberCost (nullable)`

**Required new flows:**
- Customer purchases membership → `customerMemberships` row created.
- On booking: check customer's active membership; if session is `subscribers_only` and customer has no active membership → reject.
- If session is `mixed`: subscriber uses one punch (if punch card) or no extra charge (if unlimited); non-subscriber pays `serviceTypes.requiresPayment` price.
- If session has `subscriberDiscountPercent`: subscriber gets discounted price; non-subscriber pays full price.
- Expiry: job runs daily; memberships past `expiresAt` → status=`expired`.
- Reminder: at `expiresAt - N days` (configurable per business), send WhatsApp: "Your subscription expires in N days."
- Auto-renew: if `autoRenew=true` and payment method on file → auto-charge and create new membership.

**Test scenarios to write once built:**
- Active subscriber books a `subscribers_only` session → confirmed (no charge or one punch deducted).
- Expired subscriber tries to book `subscribers_only` → rejected with "Your subscription has expired."
- Non-subscriber books `subscribers_only` → rejected.
- Non-subscriber books `mixed` → charged full price.
- Active subscriber books `mixed` → charged discounted price or punch deducted.
- Subscription with 10 punches: 10 bookings → 10 punches used; 11th booking → rejected.
- `expiresAt - 5 days`: reminder message sent; verified sent exactly once (not every day).
- Auto-renew: membership renewed; new `customerMemberships` row created; no gap in coverage.
- Auto-renew fails (payment failure): customer notified; membership not renewed.

---

### GAP-03 — Instructor-per-Session Assignment (Enhancement to Existing Schema)

**Current state:** `bookings.providerId` is nullable. `providerAssignments` maps staff to service types. There is no per-occurrence or per-time-slot instructor assignment.

**Intent:** For group classes, the instructor is known per occurrence (per time slot), not per booking. All customers in the same class at the same time have the same instructor.

**Required change:**
- When provider is assigned to a session occurrence (from GAP-01), all bookings for that occurrence inherit the `providerId`.
- If instructor changes for an occurrence, update all bookings for that occurrence.
- This is a schema + engine change — Developer A must design the correct approach.

**Test scenarios:**
- Occurrence with instructor Mickey → 3 customer bookings; all have `providerId=Mickey`.
- Mickey is replaced by Dana for that occurrence → all 3 bookings updated to `providerId=Dana`.
- Mickey's other occurrences unaffected.

---

### GAP-04 — Subscription Pricing on Session Configuration (UI/UX Design Question)

**Decision needed:** When a manager creates or edits a service type, what are the pricing options presented? Proposed:

1. **Open (no membership required):** everyone pays `price`. Membership holders have no special benefit for this session.
2. **Mixed:** members pay `memberPrice` (or use a punch); non-members pay `price`.
3. **Members only:** non-members cannot book.
4. **Member discount:** members pay `price * (1 - discountPercent)`; non-members pay `price`.

This needs a product decision + manager onboarding flow update before it can be tested.

---

## Part 5: Pre-Launch Action Items (Prioritized)

Ordered by severity before first provisioning:

| Priority | Item | Type | Status |
|---|---|---|---|
| 🔴 CRITICAL | Resolve 8 parseConfirmation Hebrew skips (B2.1–B2.8) | Bug | Tests exist, marked skip — fix the code |
| 🔴 CRITICAL | Calendar failure → rollback test (BE5) | Gap | No test; real data-loss risk |
| 🔴 CRITICAL | Multi-tenant isolation test (C7) | Gap | No test; cross-business data bleed risk |
| 🔴 CRITICAL | Revoked identity block test (C5) | Gap | Security; revoked customers can still book |
| 🔴 CRITICAL | `simulate` endpoint production exposure (ED3) | Security | Must gate behind non-production env |
| 🟠 HIGH | Blocking day does not cancel existing bookings — design decision (MI3) | Design | No defined behavior |
| 🟠 HIGH | SC7 (query ≠ mutation) integration test | Invariant | No test for read-not-write invariant |
| 🟠 HIGH | SC8 (cancel one, siblings preserved) integration test | Invariant | No integration test |
| 🟠 HIGH | Waitlist edge cases (SC4, double-offer) | Gap | Known gap in code |
| 🟠 HIGH | Skill workflow version conflict test (SK2) | Gap | Optimistic locking untested end-to-end |
| 🟡 MEDIUM | DST gap test (LG5) | Gap | Function exists, not tested |
| 🟡 MEDIUM | BE7 (group class calendar lifecycle) | Gap | Complex lifecycle, no test |
| 🟡 MEDIUM | PR2/PR3 (payment multi-booking isolation) | Invariant | No integration test |
| 🟡 MEDIUM | ED1/ED2 (signature + token validation) | Security | No test |
| 🟢 FUTURE | GAP-01 through GAP-04 (templates, subscriptions, member pricing) | Feature | Must be designed + built before testing |

---

*End of E2E Simulation Plan v1. Review each section, prioritize the action items, and decide which gaps to close before first customer provisioning.*
