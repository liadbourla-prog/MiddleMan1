# Branch 3 & 4 Live-Test Bugfix Plan

> Source: live test in business **סטודיוגה** (`d3c0c1e7-5c75-4b93-aca5-cc4b2bf941de`) on 2026-06-25.
> Owner Liad (+972543503704), counterparty "Harel" (+972546372400, registered as a *customer*).
> All six fixes live in **Developer A** domain (`src/domain`, `src/adapters`, `src/db`, `src/workers`, `src/routes`). Branch prefix `dev/system/*`. No `src/skills/` changes.

Evidence for each bug was confirmed against the production DB (conversation transcripts, `class_series`, `calendar_blocks`, `bookings`, `audit_log`). Capacities/times verified.

---

## Bug A — Recurring-class instances never mirror to Google at creation; "synced" claim is false

**Evidence.** 39 series / 163 blocks created `11:44:39`; `google_event_id` stamped only `12:00:01–12:01:47` (the 2-hour integrity sentinel sweep), with 163 `integrity.unmirrored` findings at `12:00`. PA claimed *"מסונכרן… הכל תקין"* at `11:46` — false at that moment.

**Root cause.** `createSeries → materializeSeries` ([src/domain/scheduling/series.ts](src/domain/scheduling/series.ts)) inserts `calendar_blocks` but never calls `enqueueBlockMirror`. Every other block-creating path does ([orchestrator-tools.ts:309/556/750](src/domain/manager/orchestrator-tools.ts), [apply.ts:584](src/domain/manager/apply.ts#L584)). Only the sentinel ([workers/integrity-sentinel.ts:241](src/workers/integrity-sentinel.ts#L241)) eventually mirrors them.

**Fix.**
1. `materializeSeries` returns the inserted block IDs (add `.returning({ id })`).
2. After insert, `enqueueBlockMirror(businessId, blockId)` for each new instance (best-effort, matching existing call sites). Confirm `domain/scheduling → workers/calendar-mirror` import is allowed (it is for Developer A; orchestrator-tools already imports it).
3. Verify the **series roll-out / horizon-extension** path also flows through `materializeSeries` so future weeks mirror too (otherwise add the same enqueue there).
4. **Colors (owner asked for per-type colors):** `service_types.colorId` already exists and the mirror can use it. In `scheduleRecurringClasses`, when a service has no `colorId`, assign a distinct default per service so Pilates/Yoga render in different colors. Confirm the block→Google mirror payload sets `colorId`.

**Honesty guard.** The L2 claim auditor backs `scheduleRecurringClasses` as `booking_made` without checking the mirror. Lower-risk than calling it done: adjust the tool's `guidance` so the PA says classes are set up and **syncing to Google now (will appear shortly)** rather than asserting a completed sync. (Synchronous enqueue makes this true within seconds.)

**Verify.** Re-run a class creation in staging; assert `calendar_blocks.google_event_id` is non-null within seconds and `integrity.unmirrored` count stays 0.

---

## Bug B — PA refuses outbound to a known person, fabricating both the rule and CRM history

**Evidence.** Owner repeatedly asked to reach Harel. **Zero** `messageCustomer`/`coordinateMeeting` calls, zero `meeting_coordinations` rows — only `message.received`. PA invented *"must message first"*, *"24h window closed"*, *"messaged Monday"*, and *"this morning I spoke with Yoni and Eyal"* (both are **real customers** — fabricated a conversation over real names). Harel actually messaged `06:04` today → in-window; `messageCustomer` would have delivered.

**Root cause.** Behavioral, not tooling. `executeMessageCustomer` handles the 24h window with an honest template fallback; `executeCoordinateMeeting` already accepts an existing customer as counterparty ([coordination-tools.ts:145](src/domain/manager/coordination-tools.ts#L145)). The model never invoked either — it answered from imagination.

**Fix (orchestrator system prompt + tool guidance, `src/adapters/llm/orchestrator.ts`).**
1. **Never self-refuse outbound.** Add an explicit rule: when the owner asks to contact/notify/coordinate with a person, you MUST call `messageCustomer` (known customer / open question like "when are you coming?") or `coordinateMeeting` (negotiating a specific meeting time). Do not decide on your own that a message can't be sent — the tool enforces the real messaging-window rules and reports the truth. Refusing without calling the tool is a violation.
2. **Tool routing hint.** Owner's "find out when X is coming" → `messageCustomer`. "Set up / negotiate a meeting time with X" → `coordinateMeeting`. A number already on file as a customer is reachable via either.
3. **Anti-fabrication / grounding.** Add a hard rule: never claim you spoke to, or received a message from, anyone unless a tool result **this turn** shows it. To check whether someone wrote, call `lookupCustomer { mode: 'recent_messages' }` — never assert from memory. (Reinforces existing tool description at [orchestrator.ts:297](src/adapters/llm/orchestrator.ts#L297).)
4. **Optional (stretch):** extend the claim auditor's `detectActionClaims` to flag "I spoke with / they messaged me" style claims as needing a backing `lookupCustomer` result this turn.

**Verify.** Add an orchestrator test: owner says "message Harel, ask when he's coming" → asserts a `messageCustomer` tool call is emitted (not a prose refusal), and that an out-of-window case produces the honest template-fallback wording.

---

## Bug C — Session marked completed while offering alternatives → "forgot what they booked" amnesia

**Evidence.** Session `6e616885` set `completed` at `11:57:02` right after offering 17:00/19:00 alternatives. Next message `11:58:09` spawned a fresh session `2c36c6ac`; customer's "כן" (`booking.held` at `11:59`) drew *"רגע, עוד לא סגרנו את זה"* (`11:59:22`) → *"מה אתה מסתלבט"*.

**Root cause.** The "slot taken → offer concrete alternatives" branch ([customer-booking.ts:1326](src/domain/flows/customer-booking.ts#L1326)) calls `completeSession` and returns `sessionComplete: true` while it is *asking the customer to pick an alternative*. The next reply has no session to attach to.

**Fix.**
1. In that branch, **do not** `completeSession`. Instead `updateSessionContext(... 'waiting_clarification')` storing the service + date + the offered alternative slots in context, and return `sessionComplete: false` — mirroring the `outsideHours`/`timingError` branch just above ([customer-booking.ts:1046](src/domain/flows/customer-booking.ts#L1046)) which already does exactly this.
2. Audit the other `sessionComplete: true` + alternatives combinations (the reshuffle branch at 1311 is legitimately terminal; the bare unavailable branch is not).
3. Confirm the in-session confirmation handler treats a stored alternative selection ("let's do 5") as continuing the same draft, so the second YES commits without re-asking.

**Verify.** Flow test: book a taken slot → assert session stays `waiting_clarification` with alternatives in context → next message picking an alternative → single confirmation → booked, no re-ask.

---

## Bug D — Bold/asterisk spam

**Evidence.** Customer replies bold nearly every service name and time (`*יוגה*`, `*16:00*`, `*17:00*`).

**Root cause.** No bold-restraint rule in [CHAT_LEVEL_LAWBOOK.md](CHAT_LEVEL_LAWBOOK.md) or the `genReply`/orchestrator prompts; the model emphasizes routine words.

**Fix.**
1. Add a lawbook rule (§1 formatting): use `*bold*` sparingly — at most one genuinely key fact per message (e.g. a final confirmed time), never on every service name/time/date. Bold is for the one thing the eye should catch, not decoration.
2. Echo the rule in the Branch 4 transactional `genReply` system prompt and the Branch 3 orchestrator system prompt.

**Verify.** Spot-check generated replies; optionally a quality-test assertion capping bold runs per message.

---

## Bug E — Customer booked into a time with no class; class schedule invisible as bookable classes

**Evidence.** Booked a **private Pilates at 17:00** Wed Jul 1 — no Pilates class exists then (Pilates Wed = 09/11/14/18). `service_types.פילאטיס` and `יוגה` are `max_participants = 1` despite `class_series` cap 8.

**Root cause.** Class-vs-private is keyed off `service_types.max_participants`:
- `scheduleRecurringClasses` created series (cap 8) but never promoted the service → it stays private.
- [engine.ts:109](src/domain/booking/engine.ts#L109) `isGroupClass = maxParticipants > 1` → private path; [customer-booking.ts:1040](src/domain/flows/customer-booking.ts#L1040) treats class blocks as *busy time*, books arbitrary open gaps.
- Even in the group path, [engine.ts:126](src/domain/booking/engine.ts#L126) only sets capacity *if* a class block exists; otherwise falls back to service capacity ("legacy materialize-on-first-booking") and books a class at **any** open time.

**Decision (user):** add an explicit **per-service flag** — class services are instance-only; genuinely private services (physio, שיקום) keep any-open-time booking.

**Fix.**
1. **Schema/migration.** Add `service_types.scheduling_mode text not null default 'appointment'` with enum `'appointment' | 'class'` (Drizzle + SQL migration; update [schema.ts](src/db/schema.ts)).
2. **`scheduleRecurringClasses`.** When creating series for a service, set `scheduling_mode = 'class'` (and align `max_participants` to the class cap so capacity/headcount are consistent). Idempotent.
3. **Booking engine ([engine.ts](src/domain/booking/engine.ts)).**
   - Route to group path when `scheduling_mode = 'class'` (independent of the cap default).
   - For `'class'` services, **require** a `calendar_blocks type='class'` instance at the requested slot; if none, return `ok:false, reason: 'no_class_at_time'`. Remove the materialize-on-first-booking fallback for class-mode services (keep it only for legacy non-flagged group services if needed).
4. **Customer flow ([customer-booking.ts](src/domain/flows/customer-booking.ts)).** For `'class'` services, when the requested time has no class, enumerate that day/week's **actual class instances** for the service (a `listClassInstances(service, dateRange)` helper over `calendar_blocks`) and offer those — not `suggestOpenSlotsText`. Reuse the existing day-classes renderer ([customer-booking.ts:241/256](src/domain/flows/customer-booking.ts#L241)).
5. **Backfill.** One-off: set `scheduling_mode='class'` and align capacity for services that already have active `class_series` (e.g. סטודיוגה Pilates/Yoga). Clean up the erroneous 17:00 private booking + any other off-schedule bookings created during testing.

**Verify.** Flow test on a class-mode service: requesting a non-class time is refused with real class times offered; requesting a real class time joins the instance (headcount increments, no free-floating block); a private-mode service still books any open time.

---

## Sequencing & ownership

All Developer A. Suggested order (independent except where noted):

1. **C** and **D** — smallest, isolated, immediate UX wins.
2. **A** — mirror enqueue + colors; self-contained in scheduling/worker.
3. **E** — migration + engine + flow; largest; do after A so class blocks reliably exist in Google.
4. **B** — orchestrator prompt + tests; independent, can land any time.

Each as its own PR with tests; CI (TS + ESLint + tests) green before merge. Deploy via `/update-agent` (handles versioning + migration verification for E).

## Open questions / follow-ups (non-blocking)
- B-stretch claim-auditor extension for fabricated conversation history (could be a fast-follow).
- Whether `scheduling_mode` should also gate Branch 3 owner-side booking language (likely yes; verify owner views show class instances, not open slots).
