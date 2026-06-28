# Bug-Hunt Review — Branches 3 & 4, Calendar, Workers, Adapters

**Date:** 2026-06-28 · **Branch reviewed:** `fix/branch4-grounding-state-confirmation` (HEAD `d795525`) + workers/adapters tree
**Mechanism:** 6 parallel read-only audit subagents, orchestrated; CRITICAL/high-impact findings re-verified by hand against source. **No code was edited.**
**Goal:** find latent bugs that would break the "indistinguishable from a human / Claude-quality assistant" bar, before first provisioning. Two owner priorities: (1) zero conversational nonsense (forgetting / context loss / fabrication / contradiction); (2) zero calendar issues (double-booking / open-slot integrity).

> **In-flight work (treated as "claimed" but still reviewed):** this branch's committed grounding/state/confirmation fixes; the not-yet-started `escalation-and-restore` plan; the `dev/system/inbound-message-coalescing` worktree. Findings that overlap are tagged so you can route them without collision.

---

## TL;DR — the two answers you asked for

**1. Conversational reliability ("nonsense / forgetting"):** The *generative* voice and the anti-fabrication chokepoint (`makeGenReply`) are genuinely strong — near-indistinguishable in the happy path. The failures are **not** in wording; they cluster in two structural seams:
- **Concurrency & session lifecycle** — the per-identity lock exists on the customer path but (a) fails open after ~8s without protecting the session write, (b) is **entirely absent on the manager path**, and (c) is **bypassed by three background workers** that write the same rows. `loadActiveSession` also binds to the *oldest* open session. Together these are the real engine behind "the PA suddenly forgot what we were doing / swallowed my message / replied to the wrong turn."
- **Templated/transactional scaffolding** — the deterministic `i18n` templates and Branch-4 `situation:` strings still carry textbook bot-tells the Voice Bible was written to kill (numbered IVR menus, "Reply YES", split-gender Hebrew, bilingual fallback, grovel-apologies). The voice layer never reaches these.

**2. Calendar integrity — you are NOT fully there. One go/no-go blocker:**
- 🔴 **DOUBLE-BOOKING: AT-RISK for 1-on-1 services.** Group classes are protected by a correct `pg_advisory_xact_lock`. **Private bookings have no atomicity mechanism at all** — the conflict guard is a `SELECT … FOR UPDATE` that locks *zero rows* on a free slot, and there is **no unique/exclusion constraint** on the `bookings` table. Two concurrent requests for the same free private slot both commit. (Verified in `engine.ts:255-274`.) The integrity sentinel *detects* the collision but cannot auto-repair it, and **does not detect class capacity overruns at all**.
- 🟡 **OPEN-SLOT INTEGRITY: mostly solid, one real gap.** The canonical availability spine composes hours − blocks − bookings correctly for both modes, and timezone/DST/past-time guards are clean. But the **hold→confirm window does not re-validate against owner blocks** placed during the hold, so a slot the owner just closed can still confirm.

If you provision a business with **group classes only**, the calendar core is materially safer (the studio under test is class-based). If any **1-on-1 service** is live, the private-booking race is a blocker.

---

## Severity legend
- **CRITICAL** — lost/corrupted booking, money, capacity breach, a dropped/ghosted message, or a hard self-contradiction.
- **HIGH** — forgets context / wrong info to a customer / drops a confirmed intent / a guaranteed bot-tell every time.
- **MEDIUM** — degraded UX or voice under specific conditions.
- **LOW** — polish / hygiene.

Each finding: `path:line` · symptom · root cause · trigger · fix direction · confidence · overlap.

---

## A. Calendar integrity (the go/no-go)

### A1. [CRITICAL] Private/1-on-1 booking has a check-then-write race — `FOR UPDATE` on a zero-row SELECT locks nothing ✅ verified
- **Location:** `src/domain/booking/engine.ts:253-298` (`requestPrivateBooking`); schema `src/db/schema.ts:418` (`bookings_slot_idx` is non-unique).
- **Symptom:** two customers (or customer + owner-via-Branch-3) reserve the same private slot; two `held`/`confirmed` rows on one slot.
- **Root cause:** `SELECT id … WHERE <overlap> AND state IN(held,pending_payment,confirmed) FOR UPDATE LIMIT 1` returns zero rows for a free slot → `FOR UPDATE` locks nothing → under READ COMMITTED both txns see no conflict and both INSERT. The in-code comment ("eliminating the TOCTOU window") is wrong for the empty case. No unique/exclusion constraint backs it. The group path (`engine.ts:481`) does this correctly with `pg_advisory_xact_lock`.
- **Trigger:** two near-simultaneous `requestBooking` for the same private service+slot.
- **Fix direction:** serialize the private insert with a `pg_advisory_xact_lock` keyed on `(businessId, providerId/serviceTypeId, slotStart)` exactly like the group path, and/or add a Postgres `EXCLUDE USING gist` (btree_gist) on businessId + tstzrange so the DB rejects the second overlapping write.
- **Confidence:** High · **Overlap:** none

### A2. [HIGH] Class capacity rests entirely on an advisory lock keyed off the *request's* stringified timestamp, with no DB backstop
- **Location:** `src/domain/booking/engine.ts:471-544` (`requestGroupClassBooking`).
- **Symptom:** if the resolved booking `slotStart` ever diverges from the canonical class-block `startTs` (sub-second, format, or a class moved mid-flight), two bookers hash to different lock keys, the mutex silently fails, and N+1 confirm into an N-seat class.
- **Root cause:** lock key = `` `${businessId}:${serviceTypeId}:${slotStart.toISOString()}` `` derived from the *request*, not from the class-block row re-read in-txn. No unique seat ledger / constraint enforces capacity if the lock is bypassed.
- **Trigger:** any future change to slot resolution, or a class edited via `updateBlock` while a booker is mid-flight on the old time.
- **Fix direction:** derive the lock key from the canonical block `startTs` (re-read inside the txn) and add a capacity-safe DB construct (per-seat unique index or checked counter).
- **Confidence:** Med (works in the common path; the risk is key-derivation fragility) · **Overlap:** none

### A3. [HIGH] Collisions are detected but never repaired; class capacity overrun isn't detected at all
- **Location:** `src/domain/audit/integrity.ts:113-140` (INV-1 `double_book`); `src/workers/integrity-sentinel.ts`.
- **Symptom:** after a race, both customers still believe they're booked until a human intervenes (`autoRemediable: false`). A 9th booking in an 8-seat class produces **zero findings** — INV-1 `continue`s on `sameClassInstance` and there is no `capacity_exceeded` invariant.
- **Fix direction:** add an invariant comparing active-booking count per `(serviceTypeId, slotStart)` to the block `maxParticipants`; consider an auto-remediable cancel-newest-excess path with customer notice.
- **Confidence:** High · **Overlap:** none

### A4. [HIGH] Hold→confirm does not re-validate against owner blocks created during the hold
- **Location:** `src/domain/booking/engine.ts:655-709` (`confirmBooking`).
- **Symptom:** customer holds 14:00–15:00; owner blocks 14:00–16:00 in Branch 3; customer confirms within the hold window → booked into closed time. (Sentinel INV-4 only catches it after the fact.)
- **Root cause:** `confirmBooking` re-checks only `state==='held'` + `holdExpiresAt`, never re-runs `isSlotBookable` (blocks).
- **Fix direction:** re-run the canonical spatial guard (block types) inside `confirmBooking` before flipping held→confirmed.
- **Confidence:** High · **Overlap:** none

### A5. [MEDIUM] Class duplicate-self-booking guard misses `pending_payment`
- **Location:** `src/domain/booking/engine.ts:506-522`.
- **Symptom:** for a payment-gated class, the same customer can hold two seats (capacity count at `:492` includes `pending_payment`, but the duplicate guard at `:515` checks only `requested|confirmed`).
- **Fix direction:** add `pending_payment` to the duplicate-customer guard's state set.
- **Confidence:** High · **Overlap:** none

### A6. [LOW] Internal-mode `placeHold` freebusy probe is a non-transactional read after the insert already committed
- **Location:** `src/adapters/calendar/client.ts:52-99` + `engine.ts:303-313`. Advisory only; cannot prevent A1. Keep as a Google-lag backstop once A1 is fixed. · **Confidence:** Med · **Overlap:** none

**What is SOLID (verified clean):** timezone/DST/midnight math (`compute.ts`, `resolve-slot.ts` DST-gap fails closed); past-time/buffer/max-days guards before every write; open-slot composition (hours − all block types − occupying bookings) for both modes; class-XOR-private routing in `day-options.ts`; `block-around-classes` idempotency; holds never mirrored to Google; write-time freebusy guard enforced at the private approval seam.

---

## B. Concurrency & session lifecycle (the "it forgot / swallowed my message" engine)

> This is the single most important cluster — four independent auditors converged on it.

### B1. [CRITICAL] Manager path has NO per-identity lock — session read-modify-write straddles a business lock that *drops* contended turns ✅ verified
- **Location:** `src/routes/webhook.ts:980-988` (load/save/transcript) vs `:1116` (`withBusinessLock`, enqueue-and-drop on contention).
- **Symptom:** two owner messages that slip the coalescer → second turn re-reads stale `mgSession.context`/`mgTranscript`, last-write-wins clobbers language-switch state, and a queued-then-dropped turn has **already** saved its inbound to the transcript → an orphaned user message with no assistant reply; the next turn's LLM sees a dangling message.
- **Root cause:** no per-identity serialization (the customer path has `withIdentityLock`); the business lock wraps only the orchestrator call.
- **Fix direction:** wrap the whole `routeManagerMessage` body (load → save → orchestrate → persist) in `withIdentityLock(identity.id, …)`, transcript-save inside the lock.
- **Confidence:** High · **Overlap:** coalescing worktree (related, may not cover the lock)

### B2. [CRITICAL] Coalesced burst is permanently lost if the process restarts between dedup-insert and the debounce flush ✅ verified
- **Location:** `src/routes/webhook.ts:268-272` (mark processed) before `:350-362` (buffer + `setTimeout` flush).
- **Symptom:** customer message(s) silently dropped — no reply ever; the worst "didn't hear you" failure.
- **Root cause:** `processedMessages` is written *before* the in-process timer is scheduled. Cloud Run scale-to-zero/redeploy in the 6–8s window loses the timer; the Redis burst buffer expires (60s); WhatsApp's retry hits the dedup guard and returns early. Comment claims "safe against crash-restart double-processing" but it trades that for crash-before-flush message *loss*.
- **Fix direction:** mark processed only after flush dispatches, or persist the burst durably and reconcile on startup, so WhatsApp's retry re-drives an unflushed burst.
- **Confidence:** High · **Overlap:** coalescing worktree (their domain — flag, don't double-fix)

### B3. [HIGH] `withIdentityLock` fails open after ~8s and the in-lock session write is unguarded
- **Location:** `src/domain/flows/concurrency-lock.ts:111-122` (40×200ms poll then run unlocked); TTL `:88` (60s).
- **Symptom:** a Branch-4 turn that exceeds ~8s (intent extraction + up to two gate regenerations) lets the next queued turn run concurrently; both write `slotDraft` → interleaved replies or a clobbered in-flight booking.
- **Fix direction:** make the in-lock `updateSessionContext` an optimistic compare-and-set on a context version (a fail-open second turn can't overwrite newer state), and/or widen the poll budget toward the TTL.
- **Confidence:** Med · **Overlap:** grounding-state branch (introduced the lock) / coalescing worktree

### B4. [HIGH] `loadActiveSession` returns the OLDEST active session — a duplicate shadows the live one
- **Location:** `src/domain/session/manager.ts:41` (`orderBy(createdAt)` ASC, `limit(1)`).
- **Symptom:** if two open sessions ever coexist for one identity (from B1/B3 races, or concurrent unlocked manager `createSession`), every later turn binds to the *earliest* — new messages land in one row while history is read from another → "forgot the last few turns."
- **Fix direction:** order DESC (bind newest) and add a partial unique index allowing ≤1 non-terminal session per identity.
- **Confidence:** Med · **Overlap:** grounding-state branch

### B5. [HIGH] Customer-summary worker can read a still-live session → wrong/partial cross-session memory
- **Location:** `src/workers/session-expiry.ts:47-54` (enqueue summary *then* expire) + `src/workers/generate-customer-summary.ts:38-85`.
- **Symptom:** next conversation's injected "last-3 summaries" describes a conversation that wasn't over / missing its final turns → the PA "remembers" the wrong thread.
- **Fix direction:** state-transition the session to expired first, then enqueue the summary keyed to the now-terminal row.
- **Confidence:** Med · **Overlap:** none

### B6. [MEDIUM] Carried booking draft resurrects stale slot pieces into an unrelated new session
- **Location:** `src/domain/session/hydration.ts:197-204` → `webhook.ts:583`. 90-min temporal carryover with no topic/intent check; also a near-midnight relative date ("tomorrow") baked to an absolute `dateStr` can become the wrong calendar day after the day rolls over.
- **Fix direction:** carry the draft as *tentative last-time context the LLM must confirm* (not an active `slotDraft`); re-resolve relative dates against the current clock or invalidate when the local date changed.
- **Confidence:** Med · **Overlap:** escalation-restore plan

### B7. [MEDIUM] Carryover transcript can duplicate / mis-order turns across a session boundary
- **Location:** `src/routes/webhook.ts:625-628` (`[...carriedTurns, ...sessionTranscript]`), carryover `hydration.ts:160-213`. No de-dup between carried tail and the live transcript when the prior session was just completed.
- **Fix direction:** de-dup carried turns against the live transcript; only carry when prior session id differs.
- **Confidence:** Med · **Overlap:** escalation-restore plan

### B8. [LOW] Manager cross-session memory pruning is a no-op
- **Location:** `src/workers/generate-manager-summary.ts:104-105` — `eq(createdAt, cutoff)` never matches; should be `lt(...)` (customer worker does it right). Unbounded table growth only; injection is capped at `.limit(3)`. · **Confidence:** High · **Overlap:** none

---

## C. Branch 4 — customer booking flow

### C1. [HIGH] `yes_with_question` over-confirms a hold when the "question" is actually a slot revision
- **Location:** `src/domain/flows/types.ts:81-88` (`parseConfirmation`) + `customer-booking.ts:1888-1900` (`handleHoldConfirmation`).
- **Symptom:** at a hold for "Yoga Tue 18:00", "כן, אבל אפשר ביום אחר?" / "yes but anything Thursday?" → books Tuesday 18:00 and merely answers, instead of pivoting.
- **Root cause:** `parseConfirmation` rejects only a *clock time* (`hasClockTime`) as a revision signal; a weekday/relative-day revision carries no `HH:MM`, so it returns `yes_with_question` → mapped to `'yes'` → `rebuildOnSlotPivot` (only consulted when `!== 'yes'`) never runs.
- **Fix direction:** before the `yes_with_question → yes` collapse, run the remainder through pivot detection (weekday/relative-day/service tokens), not just a clock-time check.
- **Confidence:** Med · **Overlap:** grounding-state branch (verify the committed `yes_with_question` work — it does not cover weekday/relative-day revisions)

### C2. [HIGH] Top-of-turn batch-rejection can mark a just-confirmed slot as "rejected"
- **Location:** `customer-booking.ts:739-743` (unconditional `lastOfferedSlots → rejectedSlots` promotion) vs the hold-confirm `yes` path `:1939-1977` (no `removeRejectedSlot`, unlike the fresh-confirm path `:1726`).
- **Symptom:** customer picks an offered alternative, holds it, says "yes" → booked, but that time is now on `rejectedSlots`; a later mention of it is silently suppressed ("that's not available" for a slot they just booked).
- **Fix direction:** call `removeRejectedSlot` for the pending slot on the hold-confirm `yes` path, or skip the top-of-turn promotion while in `waiting_confirmation` for a hold.
- **Confidence:** Med · **Overlap:** grounding-state branch

### C3. [MEDIUM] `inferFocusService` adopts a PA-proposed service on a bare affirmative (multi-service)
- **Location:** `customer-booking.ts:1489-1518` + `service-resolution.ts:62-86`. The anti-laundering guard only nulls the service when it equals the *cross-session favourite*; a service the PA proposed **this** conversation (never affirmed by the customer) is still adopted on "sign me up for 12."
- **Fix direction:** gate adoption on `customerReferencedService` for the multi-service case generally, not only the remembered-favourite case.
- **Confidence:** Med · **Overlap:** grounding-state branch (committed fix covered the memory case only)

### C4. [MEDIUM] Side-question bundled into a hold confirmation bypasses all three output gates
- **Location:** `customer-booking.ts:1888-1891` + `:1968-1976` (confirm reply passes `bookingConfirmed: true` → `makeGenReply` returns at `:599` before gates 1–3). A fabricated availability claim inside "yes, btw is Sunday full?" is uncaught.
- **Fix direction:** answer a bundled side-question through a separate, *gated* `genReply` call and concatenate.
- **Confidence:** Med · **Overlap:** grounding-state branch

### C5. [MEDIUM] Redispatch after a hold side-question re-extracts intent twice
- **Location:** `customer-booking.ts:894-904` + `rebuildOnSlotPivot:1375-1383` → second `extractCustomerIntent` at `:934`. Latency/cost, plus the two extractions can disagree on language/avoid-constraints (second wins).
- **Fix direction:** thread the already-extracted intent back to the dispatcher.
- **Confidence:** Med · **Overlap:** grounding-state branch

### C6. [LOW] `nudgeAfterRepeatedTries` retains the service draft indefinitely within a long session — a much-later "ok yes" re-anchors a service the customer may have dropped (`customer-booking.ts:1531-1558`). · Med · none

---

## D. Branch 3 — manager orchestrator

### D1. [HIGH] Owner-approval booking gate is enforced only in `createCalendarEvent` — classes/series bypass it
- **Location:** `src/domain/manager/orchestrator-tools.ts:410` (gate) vs `executeScheduleGroupSession:606`, `executeScheduleRecurringClasses:1039`, `apply.ts:910` (no gate).
- **Symptom:** in an `owner_approval` business, "put a yoga class Tuesday 11:00" / "pilates every Monday" writes immediately, skipping the approval step that 1-on-1 events honor.
- **Fix direction:** apply the same proposal-then-confirm gate uniformly across group/recurring scheduling (factor into a shared pre-write check).
- **Confidence:** High · **Overlap:** none

### D2. [HIGH] The four most common calendar-write tools write no `audit_log` row → cross-session grounding is blind
- **Location:** `executeCreateCalendarEvent:389`, `executeScheduleGroupSession:606`, `executeEditClassSession:903`, `executeDeleteCalendarEvent:805` — none call `logAudit` (contrast `applyInstruction:267`, `executeBlockOpenTimeAroundClasses:767`). `createBlock`/`updateBlock`/`deleteBlockById` write no audit row either.
- **Symptom:** in-turn claims are still backed by tool results (safe same-turn), but once the live transcript rolls off, the L1 ground-truth ledger omits exactly the actions a studio owner performs most → a later "did you put that class on?" can't be grounded.
- **Fix direction:** emit `logAudit` rows in these executors (or in the block helpers) and add them to `REPORTABLE_ACTIONS`/`renderAction` in `ledger-block.ts`.
- **Confidence:** High · **Overlap:** grounding-state branch (shares the ledger surface — coordinate the `REPORTABLE_ACTIONS` edit)

### D3. [MEDIUM] L2 claim auditor maps EVERY successful `manageBusinessSettings` to a `cancelled` claim
- **Location:** `src/adapters/llm/orchestrator.ts:975-977` (`actionsFromToolResult`). The polymorphic tool returns `['cancelled']` on any `success:true`, so a color/hours/instructor change "backs" a cancellation-shaped sentence → a false "cancelled" claim can slip the guard.
- **Fix direction:** surface the resolved `instructionType` in the tool result and gate the `['cancelled']` mapping on it; `[]` for non-cancellation changes.
- **Confidence:** High · **Overlap:** grounding-state branch

### D4. [MEDIUM] No `booking_changed` claim class — reschedule/edit confirmations are ungrounded
- **Location:** `actionsFromToolResult:967-980` (no `editClassSession` entry); `reply-guard.ts:61` (`ActionClaim` lacks an edit class). A hallucinated "moved it to 17:00" (when the tool returned `has_active_bookings`) isn't cleanly caught.
- **Fix direction:** add a `booking_changed` claim class (HE/EN edit patterns) and map `editClassSession` success → `['booking_changed']`.
- **Confidence:** Med · **Overlap:** grounding-state branch

### D5. [MEDIUM] `manageBusinessSettings` applies ONE service per call — multi-service requests silently partial
- **Location:** tool desc `orchestrator.ts:308-319` + `applyServiceChange` `apply.ts:610`. "Make Pilates green and Yoga purple" relies entirely on the LLM splitting into two calls; if packed into one, the classifier returns a clarification and **nothing applies**, with no deterministic fan-out/post-check.
- **Fix direction:** accept an array of service changes, or have the classifier return all targets so the executor loops deterministically and reports exactly what applied.
- **Confidence:** Med · **Overlap:** none

### D6. [LOW] `pauseConversation`/`resumeConversation`/`setCustomerName` mutate state with no audit row (`apply.ts:1327,1364`, `:1520`). · High · none
### D7. [LOW] Manager transcript snapshot taken before `withBusinessLock` (`webhook.ts:988` vs `:1116`) — subsumed by B1's fix. · Med · coalescing worktree

---

## E. Background workers

### E1. [CRITICAL] Waitlist `offer_slot` can promote the same freed seat to two customers ✅ verified
- **Location:** `src/workers/waitlist.ts:230-255`. Plain `SELECT … status='pending' LIMIT 1` then a separate `UPDATE … WHERE id=:id` — no row lock, **no `AND status='pending'` guard on the update**, no transaction. Two `offer_slot` jobs (cascade after expiry, `attempts:2` retry, or two instances) both read the same entry → two "it's yours" offers for one seat.
- **Fix direction:** conditional atomic update `UPDATE … SET status='offered' WHERE id=:id AND status='pending' RETURNING`; send only if a row was actually flipped.
- **Confidence:** High · **Overlap:** none

### E2. [CRITICAL] Direct-send initiations lose the message if the process dies after the dedup ledger insert
- **Location:** `src/domain/initiations/dispatch.ts:153-184` — ledger row inserted/committed *before* the executor runs. Reminder/dunning enqueue onto the durable retry queue (safe); but `waitlist.ts:296`, `reshuffle-campaign.ts:83`, waitlist cold-fill `:118` call `sendMessage(...).catch(()=>{})` directly. A crash/transient error between insert and send burns the dedup key with no message sent → customer never contacted, no retry.
- **Fix direction:** route all initiation sends through the durable retry queue, or write the ledger row only after a confirmed enqueue.
- **Confidence:** High · **Overlap:** none

### E3. [HIGH] `queued-messages` worker runs the live booking flow WITHOUT the per-identity lock
- **Location:** `src/workers/queued-messages.ts:68-112` — `loadActiveSession`/`createSession`/`handleBookingFlow`/`completeSession` with no `withIdentityLock`, while the live path wraps the same in it (`webhook.ts:560`). A queued message racing a live inbound clobbers the session/draft.
- **Fix direction:** wrap the session+flow body in `withIdentityLock(identity.id, …)`.
- **Confidence:** High · **Overlap:** grounding-state branch / coalescing worktree

### E4. [HIGH] Hold-expiry can clobber a concurrently-confirming booking
- **Location:** `src/workers/hold-expiry.ts:23-94` vs `engine.ts:706-709`. `confirmBooking` updates `state='confirmed' WHERE id=:id` with **no `AND state='held'` guard**; the worker sets `state='expired'` after a slow `calendar.deleteEvent`. Neither takes the lock → a confirm whose Google call straddles `holdExpiresAt+grace` is told "booked" while the row flips toward expired and the mirror event is deleted.
- **Fix direction:** make both writes conditional compare-and-swaps on `state='held'`; or have expiry take the per-identity lock.
- **Confidence:** Med · **Overlap:** grounding-state branch / escalation-restore plan

### E5. [HIGH] `session-expiry` sweep can expire a session mid-live-turn
- **Location:** `src/workers/session-expiry.ts:18-57` + `session/manager.ts:144-160`. Blanket `UPDATE … state='expired' WHERE expiresAt < now …` with no coordination with `withIdentityLock`; a turn that began just before `expiresAt` and runs several LLM calls is expired out from under itself → next message starts fresh.
- **Fix direction:** skip/guard rows under an active identity lock, or re-confirm `expiresAt < now` inside the same lock; at minimum exclude sessions touched in the last few seconds.
- **Confidence:** Med · **Overlap:** grounding-state branch / coalescing worktree

### E6. [MEDIUM] `message-retry` can re-send after an ambiguous transient failure → duplicate delivery (`message-retry.ts:68-87`, no provider-message-id dedup before re-send). · Med · none
### E7. [MEDIUM] `expire_offer` cascade / reshuffle re-tick don't re-validate the slot is still free before re-offering (`waitlist.ts:218-226`, `reshuffle-campaign.ts:255-258`). · Med · escalation-restore plan
### E8. [LOW] `calendar-sync-renewal` relies solely on a 6h tick with no retry on a failed renewal near channel expiry (`calendar-sync-renewal.ts:11-31`). Mitigated by full-reconcile. · Low · none

**SOLID:** the proactive/promotional family (reminder, dunning, post-appointment, birthday, periodic-treatment, subscription-renewal, winback) — unique `(business_id, dedup_key)` ledger, timezone-aware date bucketing, verify-at-send-time state re-reads, durable retry queue.

---

## F. Voice, prompts, formatting & delivery

### F1. [CRITICAL] No 4096-char message splitting anywhere — long replies are silently dropped ✅ verified
- **Location:** `src/adapters/whatsapp/sender.ts:113-163` posts `body: message.body` raw; no splitter exists in `src/`.
- **Symptom:** a reply >4096 chars → Meta rejects (`#131009`) → `ok:false` → the customer/owner receives **nothing**. Reachable via operator STATUS dumps, long UPCOMING lists, verbose orchestrator replies.
- **Fix direction:** add a splitter in `sendMessage` that splits on the last paragraph/newline boundary under the limit and sends sequential parts — covers every caller.
- **Confidence:** High · **Overlap:** none

### F2. [HIGH] Branch-4 cancellation/reschedule `situation:` strings instruct a numbered "reply with its number" IVR menu ✅ verified
- **Location:** `customer-booking.ts:2393`, `:2702` (and `:2442,:2496,:2736`). The string literally says "numbered for easy reference … reply with its number" — the exact ❌ pattern the lawbook §10 and `voice.ts` ban.
- **Fix direction:** rewrite to list by day/service and ask in plain words ("which one — just say the day"), forbidding numbered/"reply with the number" phrasing.
- **Confidence:** High · **Overlap:** none

### F3. [HIGH] Gate-2 time-fabrication guard is blind to English am/pm — the studio is explicitly bilingual
- **Location:** `src/domain/flows/slot-fabrication-guard.ts:38` (`CLOCK_RE` 24h-only). An English customer can be offered a fabricated "5 PM" / "7pm class" the spine never surfaced, and the guard passes it.
- **Fix direction:** extend `extractClockTimes`/`extractMentionedTimes` with an am/pm normalizer → canonical `HH:MM`.
- **Confidence:** High · **Overlap:** grounding-state branch (touches this guard family)

### F4. [HIGH] Manager language-switch offer ships "Reply YES" + split-gender Hebrew
- **Location:** `src/domain/i18n/t.ts:12-16` (`managerSwitchOfferSuffix`): `(… Reply YES)` and `כתוב/י כן` — both banned (`voice.ts` BOT_TELLS / ADDRESSING). The customer-side equivalent (`customer-booking.ts:1268-1270`) was already fixed; the manager path was left on the old wording.
- **Fix direction:** mirror the customer fix — plain words, masculine singular.
- **Confidence:** High · **Overlap:** none

### F5. [MEDIUM] Bilingual non-text fallback reaches a customer regardless of language
- **Location:** `src/domain/i18n/t.ts:774-777` — `non_text_reply` returns the same `"… / I can only understand text messages."` for both `he` and `en` (used `webhook.ts:657,:218`, `adapters/whatsapp/webhook.ts:65`). Violates language isolation (§3.1).
- **Fix direction:** make it a proper per-language pair and pick by inbound language.
- **Confidence:** High · **Overlap:** none

### F6. [MEDIUM] Failure `situation:` strings still command a robotic "Apologise … contact the business" dead-end
- **Location:** `customer-booking.ts:1954,:2602,:2753` (and generic `:954`). Contradicts §12 / `voice.ts` ("matter-of-fact, forward-moving, pair the problem with the next step"). The better `:1547/:1568` strings already do it right.
- **Fix direction:** reword to no-grovel + a concrete next step.
- **Confidence:** Med · **Overlap:** escalation-restore plan (hand-off tone)

### F7. [MEDIUM] Several customer-facing Hebrew templates use formal-plural, not the mandated masculine singular
- **Location:** `i18n/t.ts:299` (`paused_msg` "צרו קשר"), `:837` (`pa_paused_customer`), `:791` (`hold_expired` "אתם מוזמנים"), `:913` (`approval_expired_customer`). Register jumps vs the LLM layer's singular → reads as two authors.
- **Fix direction:** normalize to masculine singular. · Med · none

### F8. [LOW] Emoji hard-coded into question-bearing templates, ignoring `emojiUse:'none'` (`i18n/t.ts:908,:910`; `templates.ts` 🙏/💛). · Med · none

**SOLID:** `voice.ts` itself faithfully distills the Voice Bible; the dynamic Branch-3/4 prompts inherit it well; the anti-fabrication chokepoint and Branch-3 claim auditor are genuinely robust within their known limits.

---

## G. Lead-protection & capacity verification (pass 2 — positive verification of 5 owner guarantees)

Targeted trace of five behaviors the owner asked to lock before fixing. Verdicts are code-evidenced.

| Guarantee | Verdict | Evidence / residual |
|---|---|---|
| **G1 — never reject a genuinely OPEN class / call it full** | ✅ **PASS** | The booking-request path never consults `rejectedSlots` (suppression is suggestion-only, `negotiation-constraints.ts:21-22`), so the C2 batch-rejection **cannot** block a fresh explicit request for an open class. The confirm path also un-suppresses the pursued slot (`:1766`). The occupancy backstop's `open` signal counts only `spotsLeft>0` (`:810`), so it can't false-full an open class. `classInstanceMissing` (`:470-479`) can't fire for a real class. |
| **G2 — never OFFER or book a FULLY-BOOKED class** | ⚠️ **AT-RISK (offer side)** | Booking side airtight (`engine.ts:500-503`). But **offer side leaks** — see G2-BUG below. |
| **G3 — offer a real SUBSTITUTE when truly full (don't drop the lead) — CLASSES** | ⚠️ **PARTIAL** | Works on the repeated-tries/nudge path (`suggestNextClassesText`, real openings, `:1557-1584`). But the **class-gate full-day branch can dead-end** — see G3-BUG below. |
| **G3b — substitute for a taken/unavailable 1-on-1 (appointment) slot** | ✅ **PASS (with a narrow empty-window residual)** | Taken/outside-hours/bad-time 1v1 requests offer `suggestOpenSlotsText` — a **14-day forward** spine search (hours+blocks+existing bookings honoured), up to 4 real openings (`:1804-1805` outside-hours, `:2199-2200` taken-at-confirm). Stronger than the class path (no same-day dead-end). **Residual:** when the 14-day search returns empty (booked-solid horizon, or a broad avoid-rule empties the page), the fallback (`:1819`, `:2236`) asks the customer to "pick another time" instead of widening/waitlisting/handing off — a soft dead-end (rare for 1v1). |
| **G4 — no mistakes in days/times** | ✅ **PASS** | Resolution fully deterministic + tz-anchored (`resolve-slot.ts:78-133`, `compute.ts:93-111`); weekday numbering consistent 0=Sun..6=Sat end-to-end; the customer-facing day label is always derived from the same resolved instant as the time (`:173-175`, `:1783-1784`) → a "Tuesday, 30 Jun" when 30 Jun is Monday is **unreachable**. LLM never does date math (`client.ts:436-458` supplies literal date facts). Only residual = B6 (cross-session draft *semantics*; the stored absolute date is never itself wrong). |
| **G5 — never invent a session/time/class not on the owner's calendar** | ✅ **PASS** | Every offered time/class is spine-sourced (`listDayOptions` filters `type='class'`; `suggestNextClassesText`; `buildDayOptionsText`). Gate 2 (`findUnbackedTimes`) + occupancy Gate 3 + `classInstanceMissing` close the loop; allowlist is leak-free (boundaries flagged non-bookable; prior-assistant turns untrusted, `:570`). Owner Google events are ingested opaque & title-less (`inbound-sync.ts:332-342`) and never surfaced as bookable. Only residual = F3 (am/pm is a *detection* gap for English model-fabrication, **not** a spine leak — production renders 24h `formatSlotTime` everywhere, exactly what `CLOCK_RE` matches). |

**Bottom line on the five:** G1, G4, G5 are **provisioning-ready as verified**. G2 and G3 each have one concrete MED bug (below) — both rooted in the *same* function and both squarely in your "don't offer a full class / don't drop a lead" concern.

### G2-BUG. [MEDIUM] Full classes leak into "offer ONLY these" situations
- **Location:** `buildDayOptionsText` `customer-booking.ts:393-401` (consumed at `:1617-1622`, `:1739-1748`, `:1199`, `:2104`).
- **Symptom:** on a day whose only instances of the requested service are at capacity, the situation string becomes e.g. `Yoga at 10:00 (full); Yoga at 12:00 (full)` under the instruction "Offer ONLY these and ask which they'd like" — so the PA can present a **full** class as a pickable time; the customer "picks" it and the engine rejects at `engine.ts:501` (offer→confirm→reject dead-loop).
- **Root cause:** `buildDayOptionsText` enumerates *all* classes with a `(full)` label and pushes them into `offered`, rather than filtering `spotsLeft<=0` the way `suggestNextClassesText` (`:445`) does. The only thing stopping a full-class offer is the LLM honoring the label — not a deterministic filter.
- **Fix direction:** split out an `offerable` variant that drops `spotsLeft<=0` before building the offer string (keep the full-inclusive variant only for the open-signal/grounding check, which legitimately needs to know about full classes).
- **Confidence:** High · **Overlap:** grounding-state branch (same file/functions — sequence after it merges)

### G3-BUG. [MEDIUM] Class-gate full-day branch dead-ends the lead instead of substituting a later real opening
- **Location:** `customer-booking.ts:1737-1756` (class-gate full/empty-day branch).
- **Symptom:** customer asks for a class time with no block on a day whose remaining classes are full/none → PA says "no more classes that day, want to check another day?" with **no concrete substitute** — the lead is asked to guess again.
- **Root cause:** this branch reads only the *same day* via `buildDayOptionsText`; it never falls back to `suggestNextClassesText` to surface the next real open class instance on a later day (the substitute behavior that already exists in `nudgeAfterRepeatedTries`).
- **Fix direction:** when same-day options are empty/all-full, call `suggestNextClassesText(...)` and offer the next real openings — making "never dead-end a lead" a shared path, not one branch's behavior.
- **Confidence:** High · **Overlap:** grounding-state branch

### G3b-BUG. [LOW–MEDIUM] Empty-window fallbacks dead-end the lead (classes AND 1-on-1)
- **Location:** `customer-booking.ts:1819` (outside-hours, `openSlotsText` null), `:2236` (taken slot, `openSlotsText` null), `:2229` (class-gate, `classTimesText` null).
- **Symptom:** when the substitute search returns nothing, the PA tells the customer to "pick a time within business hours" / "check another day" — pushing the work back on the lead rather than proactively widening the horizon, offering a waitlist, or handing off to the owner.
- **Fix direction:** route every null-suggestion fallback through one shared "never dead-end a lead" helper (widen horizon → waitlist → warm owner hand-off).
- **Confidence:** High · **Overlap:** grounding-state branch / waitlist worker (E1)

> **New idea (high-leverage, surfaced by this pass):** G2-BUG and G3-BUG trace to one root — `buildDayOptionsText` serves *two* purposes (the grounding/open-signal check, which needs full classes; and the customer-facing offer, which must exclude them) but is only correct for the first. **Splitting it into a full-inclusive grounding variant + a `spotsLeft>0` offerable variant that auto-falls-back to a substitute when the day is empty closes G2 and G3 in one change.** And G3b shows the *same* gap exists on the 1-on-1 empty-window path. So elevate it to a **doctrine-level invariant**: *any branch that tells a customer "full / taken / none then" must deterministically carry a real substitute or an explicit escalation — never bounce the choice back to the customer.* This is the Voice Bible's "always pair the problem with a next step," enforced in code for **both** classes and appointments, via one shared lead-protection helper (`suggestNextClassesText` for class-mode, `suggestOpenSlotsText` with a widened horizon for appointment-mode, then waitlist/owner hand-off when truly empty).

---

## H. Revision, same-day-first & ambiguous-day verification (pass 3)

Three more owner behaviors traced to verdicts.

| Behavior | Verdict | Evidence / gap |
|---|---|---|
| **C-PIVOT — mid-booking change of day / hour / service / all** | ✅ **PASS** | `rebuildOnSlotPivot` `hasNewSlot` (`customer-booking.ts:1398-1401`) fires on any axis; the merge (`:1598-1616`) overwrites only the revised field and **keeps the other two** (day-only keeps service+time, hour-only keeps service+day, service-only keeps day+time). A plain revision during a pending hold parses `'unclear'` → pivots **before** any confirm, releases the stale hold (`:1421-1423`), never books the old slot. Underspecified revision re-asks the missing piece (`:1699-1722`). Only watch-item = the already-known "yes, but Tuesday instead" phrasing (C1). |
| **C-SAMEDAY — offer other hours on the SAME day before moving on** | ⚠️ **PARTIAL** | Same-day-**later** appointments come first (chronological from request, `:276-284`); **classes** stay on-day correctly incl. earlier times (`buildDayOptionsText` for that day). **Gap:** appointments MISS same-day-**earlier** openings — see H1-BUG. |
| **C-AMBIG — ambiguous same-weekday-name (today vs next week) → clarify** | 🔴 **AT-RISK (not ready)** | A bare weekday equal to today silently resolves to **today** (`resolve-slot.ts:131`, `delta=(target−todayDow+7)%7 = 0`), and the extractor forces `dateAmbiguous=false` for named weekdays (`client.ts:186`). No clarification, no roll-to-next-week when today's sessions passed, no "today fully booked" message. See H2-BUG. |

### H1-BUG. [MEDIUM] `suggestOpenSlotsText` drops same-day-EARLIER appointment openings
- **Location:** `customer-booking.ts:277` (`from = requestedStart > now ? requestedStart : now`) + `compute.ts:202` (`effectiveFrom` clamp).
- **Symptom:** customer asks an appointment at 14:00 (taken); 10:00 the same day is open → 10:00 is **never offered**; the PA jumps past the day's earlier availability.
- **Root cause:** the search window floors at the requested clock time, not the start of the requested day.
- **Fix direction:** floor at `max(now, startOfDay(requestedStart))` so chronological "first 4" still surfaces same-day-earlier first; keep the past/now clamp. (Classes already correct — unaffected.)
- **Confidence:** High · **Overlap:** grounding-state branch / lead-protection helper (G-series)

### H2-BUG. [MEDIUM] Bare same-weekday-name silently resolves to today — no clarify / roll-forward / fully-booked message
- **Location:** `resolve-slot.ts:128-133` (`nextOccurrenceOfWeekday`, `delta=0` = today) + extractor `client.ts:186` (`dateAmbiguous=false` for named weekdays) + consumed at `customer-booking.ts:1608-1609`.
- **Symptom:** today is Sunday, customer says "Sunday" → PA books/offers **today** with no clarification, even when they meant next Sunday; if today's sessions all passed it says "nothing today" instead of rolling to next week; no "today is fully booked" message.
- **Root cause:** same-weekday resolves to delta 0 with no ambiguity signal; extractor classifies named weekdays as unambiguous; no roll-forward / fully-booked branch exists.
- **Fix direction (two parts):** (1) extractor emits an anchor flag distinguishing "today/this Sunday" from a bare "Sunday"; (2) flow branch: if `weekday === todayDow` and no anchor → if today's sessions remain, **ask** (today vs next week); if all passed, resolve to **next week**; if today is fully booked, **say so** and offer next.
- **Confidence:** High · **Overlap:** none (new behavior; touches extractor + flow — the one item here needing real new code)

> **Note for the plan:** H2 is the only one of your nine guarantees that needs genuinely *new* behavior (extractor field + a clarification branch), not just a fix to existing logic — scope it as its own small slice. H1 folds naturally into the lead-protection helper (G-series). C-PIVOT needs no work beyond the already-tracked C1.

---

## I. New-direction findings (pass 4 — identity, cancellation/state, payments, LLM resilience, Google sync, injection)

> **Activation note:** Payments (Grow) and the *push/cron* Google inbound path are **wired but inactive** until a merchant connects — those findings are pre-launch blockers, not live today. **`reconcileScheduleWindowOnRead` IS live** in Google-connected mode (Branch-3 + public reads). Identity, LLM-resilience, cancellation/state, and injection findings are **live now**.

### Identity / routing / authorization — *core is sound (no bypass, no cross-business, no misroute); risks are foot-guns + ordering*
| ID | Sev | Location | One-line |
|---|---|---|---|
| ID1 | HIGH | `manager/apply.ts:829-857` | A "grant access" to a number that's already the **manager** silently demotes them to `delegated_user` — owner can lock themselves out of admin. Guard: refuse to downgrade a manager. |
| ID2 | HIGH | `manager/apply.ts:860-873` | "Revoke <number>" can revoke the **manager**, locking the owner out with no in-band recovery. Guard: never revoke the last/active manager. |
| ID3 | MED | `webhook.ts:308-339` | Contact-restriction gate runs *before* coordination advance → a customer-counterparty's "yes that works" is dropped; coordination stalls. Reorder. |
| ID4 | MED | `webhook.ts:337-339` | While a coordination is active, **all** of that customer's inbound is hijacked into the coordination — they can't do a normal booking. Scope the interception. |
| ID5 | LOW | `webhook.ts:387-408` | A business with an empty `whatsappAppSecret` falls back to the global secret → signature fails → inbound silently dropped (PA looks dead). Treat empty as absent. |

### Cancellation / reschedule / booking state-machine — *happy paths reliable; failure/concurrency/elapsed edges leak*
| ID | Sev | Location | One-line |
|---|---|---|---|
| CX1 | **CRITICAL** | `booking/engine.ts:278-308`; reapers `hold-expiry.ts:39`, `integrity.ts:277` | A booking stuck **forever in `requested`** if the process dies between insert and hold-result — no reaper covers `requested` (no expiry key). Add a `requested` reaper / make insert+hold atomic. |
| CX2 | HIGH | `booking/engine.ts:484-503` | A stranded/abandoned `requested` **group** booking permanently **burns a class seat** (capacity counts `requested`, never reaped). |
| CX3 | HIGH | `booking/engine.ts:748-908` | `cancelBooking` has **no row lock and a non-conditional UPDATE** → concurrent double-cancel double-fires waitlist+notifications and can false-report failure. Make it a conditional CAS. |
| CX4 | HIGH | `customer-booking.ts:2443/1969/2556`; `attendance.ts:16` | Cancel/reschedule lists **never exclude PAST bookings**, and `markAttendance` is **dead code** → `confirmed` accumulates elapsed rows; a customer can "cancel" a class that already happened / it gets auto-targeted. Add `slotStart>=now` + wire attendance sweeping. |
| CX5 | MED | `reshuffle/executor.ts:85`; `reshuffle-campaign.ts:248` | Reshuffle **success is never confirmed** to the requester or the customers who agreed to move — they're left uninformed their time changed. |
| CX6 | MED | `customer-booking.ts:1899-1951` | Reschedule's old-slot release is best-effort in a **swallowed catch**; on failure the customer silently holds **two** slots, and the residue sentinel can't see it (`rescheduledFrom` not persisted on common paths). |
| CX7 | MED | `booking/engine.ts:769-786` | Cancellation cutoff is bypassable via reschedule, and the cutoff can also **block the supersede-release** → double-booked instead of cleanly blocked. Make the release a cutoff-exempt system action. |
| CX8 | LOW | `cancellation-match.ts:55-85` | Service-token matching can cross-contaminate services sharing a ≥3-char token and auto-select the wrong service's booking. |

### Payments — *wired, inactive; every item is a pre-Grow-launch blocker*
| ID | Sev | Location | One-line |
|---|---|---|---|
| PAY1 | **CRITICAL** | `routes/payment-webhook.ts:24`; `payments/service.ts:146` | **Forged webhook marks a booking paid+confirmed** — body never verified; the minted `webhookSecret` is **dead code**; reverify is bypassable by omitting `paymentSum`. HMAC-verify the body; make reverify mandatory. |
| PAY2 | **CRITICAL** | `booking/engine.ts:748-842` | **Cancelling a paid booking never refunds** — money kept silently, no flag. Auto-refund or write a `refund_due` flag on cancel-of-paid. |
| PAY3 | HIGH | `hold-expiry.ts:39`; `engine.ts:381` | `pending_payment` slots are **held on the calendar forever** — hold-expiry only scans `held`; dunning gives up at 96h without releasing. Add a payment-expiry sweep. |
| PAY4 | HIGH | `payments/service.ts:159-258` | **No row-lock/idempotency** on concurrent webhook deliveries → double-confirm + double-invoice. Conditional `UPDATE … WHERE status='created'`. |
| PAY5 | HIGH | `payments/service.ts:185-217` | Settled **amount never validated against the pinned price** — underpay/forged amount still confirms. |
| PAY6 | MED | `payments/service.ts:106` | Currency hardcoded `ILS` regardless of service/subscription currency. |
| PAY7 | MED | `db/schema.ts:1040`; `service.ts:61` | `dedupKey` has **no unique index** → payment-request + dunning race mints **two pay-links / Grow processes** for one booking. |
| PAY8 | MED | `booking/engine.ts:805-828` | Group "last participant" event-delete ignores `pending_payment` → a paying participant's event deleted out from under them. |
| PAY9 | LOW | `payments/service.ts:199-205` | `approveTransaction` ack failure only logged → customer maybe-not-actually-charged while marked paid. |
| PAY10 | LOW | `dunning.ts:160`; `subscription-renewal.ts:120` | Missed-webhook window lets dunning send a live pay-link for an already-paid slot (invites second payment). |

### LLM resilience — *fabrication is well-guarded; latency/hang + silent-degrade are not*
| ID | Sev | Location | One-line |
|---|---|---|---|
| LLM1 | **CRITICAL** | `llm/client.ts:30-52,1525`; `orchestrator.ts:83`; lock `concurrency-lock.ts:111` | **No timeout on interactive LLM calls** — a hung Vertex request **holds the per-identity lock and ghosts the customer** with no fallback ever emitted. Configure SDK `httpOptions.timeout` + wrap interactive calls. |
| LLM2 | HIGH | `client.ts:30-52`; `orchestrator.ts:83-104` | Sequential Pro→Flash fallback **doubles** (loops multiply) the hang window, inside the lock → lock-TTL lapse → concurrent turn. Bound a total time budget. |
| LLM3 | HIGH | `client.ts:1525-1589` → `customer-booking.ts:942` | Intent parse failure degrades to a generic "rephrase" — a real "cancel my class" / "restore it" is **lost**; one site `return null` silently drops the turn. Add a keyword backstop for cancel/restore. |
| LLM4 | MED | `client.ts:79,100,101` | `.catch(false)` on `restorePrevious`/`specialArrangementRequest`/`dateAmbiguous` **silently suppresses the intent** on per-field parse drift (restore → treated as new booking). Use nullable + detect unknown. |
| LLM5 | MED | `client.ts:1262-1267` | `withTimeout` doesn't abort the underlying call → dangling Vertex requests leak during a stall. Thread an `AbortSignal`. |
| LLM6 | LOW | `orchestrator.ts:1243-1267` | No-parts / safety-block response exits to a generic "try again" without inspecting `finishReason` → a content block looks like a hiccup. |
| LLM7 | LOW | `orchestrator.ts:1178-1270` | Loop-exhaustion fallback after tools already ran invites a retry that **double-executes** non-idempotent tools. Summarize what already happened. |

### Google inbound sync / settings↔booking races
| ID | Sev | Location | One-line |
|---|---|---|---|
| SYNC1 | **CRITICAL** (live in Google mode) | `calendar/inbound-sync.ts:534-553` | `reconcileScheduleWindowOnRead` (un-gated, runs on Branch-3 + public reads) presence-diff delete has **no `source`/`type` guard** → a transient stale `googleEventId` (after the mirror's own 404 self-heal re-insert) **hard-deletes a live internal class with bookings** → lost schedule + freed slot for double-book. Restrict deletion to `source='google_import'`. |
| SYNC2 | HIGH | `manager/apply.ts:455-512` | Shrinking **recurring** weekly hours keeps existing future bookings **out-of-hours silently** (conflict check only in the `specificDate` branch). |
| SYNC3 | HIGH | `manager/apply.ts:403-421` | `bulk_close` over a range blocks days but **never cancels/flags bookings** inside → orphaned active bookings on closed days. |
| SYNC4 | HIGH | `manager/apply.ts:695` | Reducing a service's `maxParticipants` below current bookings creates an **over-capacity class** with no guard. |
| SYNC5 | MED | `calendar/inbound-sync.ts:265-284` | Owner time-move of a PA booking isn't reconciled **and the etag isn't re-stamped** (docstring claims it is) → reprocessed every full reconcile. |
| SYNC6 | MED | `routes/calendar-webhook.ts:10-28` | Webhook validates token-only; `resourceId` never checked and a **null token bypasses auth** → forced-reconcile amplification. |
| SYNC7 | LOW | `manager/apply.ts:317,543` | Branch-3 block commands mass-cancel with **no blast-radius gate** (the gate exists only on the Google owner-wins path) — likely intentional, flagged for parity. |

### Input sanitization / prompt-injection / non-text
| ID | Sev | Location | One-line |
|---|---|---|---|
| INJ1 | **CRITICAL** | `manager/orchestrator-tools.ts:1413` → `orchestrator.ts:883`; `webhook.ts:611` | Customer's raw message text flows **verbatim into the *manager's* orchestrator** (mandatory `lookupCustomer/recent_messages`) → **cross-context stored injection** adjacent to tool-calling authority. Sanitize + fence as untrusted data. |
| INJ2 | **CRITICAL** | `llm/client.ts:481-486,513` | §7.1 sanitization is **not applied to `generateCustomerReply`** — raw prior customer turns + self-supplied name injected into the Branch-4 reply LLM → steered false-confirmation / persona break / facts leak. Sanitize at persistence + before every interpolation. |
| INJ3 | HIGH | `llm/client.ts:147` | Entire `sessionContext` JSON-stringified into the extractor prompt unsanitized → a planted hint re-injects every turn. |
| INJ4 | HIGH | `whatsapp/webhook.ts:62-68` | **Interactive button / list replies are dropped** (ghosted) — a customer's tap on a chip the PA itself sent gets "I only understand text." Parse `interactive.button_reply.title`/`list_reply.title`. |
| INJ5 | MED | `webhook.ts:107-108` | The non-text reply is sent from the **default WhatsApp number**, not the per-business PA number (cross-tenant misroute under multi-PA). |
| INJ6 | LOW | `whatsapp/webhook.ts:48`; `webhook.ts:640` | Image **caption** (a booking typed under a photo) is dropped, and unsanitized when an image skill is active. |

---

## J. Common ground — the root patterns behind the bugs (the synthesis for the plan)

Across all ~70 findings, the same **seven structural patterns** recur. The system is genuinely well-architected for the *single-threaded happy path* and for *LLM fabrication*; nearly every bug is a place where one of these seven doctrines is applied **incompletely** — present in one path, absent in its siblings. **Fixing the pattern (not the instance) is what makes this provisioning-grade.** Each pattern below lists the findings it unifies and the single discipline that closes the class.

### P1 — Check-then-act without atomicity *(the DB must be the arbiter, not a prior SELECT)*
Every concurrency bug is a read-then-write with no lock, no conditional write, and no DB constraint.
- **Unifies:** A1 (private-booking race), A2 (capacity lock key), CX3 (cancel no lock), CX1 (insert+hold not atomic), E1 (waitlist double-promote), PAY4/PAY7 (webhook/dedup idempotency), E4 (hold-expiry vs confirm), B3 (session context last-write-wins), and the `confirmBooking` missing `AND state='held'`.
- **The one discipline:** *every state transition is a conditional/atomic write* — `UPDATE … WHERE id=? AND state=?` (treat 0 rows = already-done), an advisory lock keyed off the canonical row, or a unique/exclusion constraint. The database decides; a prior SELECT never does.

### P2 — Non-terminal states with no reaper *(everything must move toward terminal)*
Abandoned/in-flight rows have no TTL+sweep, so they leak resources or accumulate.
- **Unifies:** CX1 (`requested` stranded forever), CX2 (burns a seat), PAY3 (`pending_payment` held forever), CX4 (`confirmed` accumulates past rows; `markAttendance` dead), B5/B-expiry (session expiry races), PAY10/dunning (gives up without releasing).
- **The one discipline:** *every non-terminal state (`requested`, `held`, `pending_payment`, open session) has a TTL and a reaper*, and a single stuck-state sentinel covers **all** of them — plus automatic attendance sweeping so `confirmed` self-terminates.

### P3 — Asymmetric serialization *(one lock discipline across every writer of a row)*
The per-identity lock exists on one path and is missing on its siblings.
- **Unifies:** B1 (manager path unlocked), E3/E4/E-expiry (workers write session/booking rows lock-free), B3 (lock fails open without protecting the write), B4 (`loadActiveSession` oldest-first amplifies any duplicate).
- **The one discipline:** *every writer of a given identity's/booking's rows — live customer, live manager, and all workers — shares the same lock*, the in-lock write is optimistic-CAS so fail-open can't clobber, and active-session selection is newest-first + unique-constrained.

### P4 — Trusting a stale snapshot instead of re-reading at the moment of action *(the anti-fabrication doctrine, generalized beyond LLM replies)*
The exact lever the occupancy work applied to LLM replies is missing in the deterministic paths.
- **Unifies:** the occupancy laundering (already fixed), B6 (carried draft staleness), A4 (hold→confirm doesn't re-check blocks), SYNC1 (presence-diff trusts a stale `googleEventId` → deletes a live class), E-reminder (reads state at schedule-time), E7 (reshuffle reads stale occupant), B5 (summary reads a live session).
- **The one discipline:** *re-ground against the source of truth at the instant of the side effect* — re-read the spine/row in the same transaction as the write; never act on a snapshot captured earlier or infer "absent ⇒ deleted" from a diff.

### P5 — Settings changes don't re-validate dependent records *(every mutation owns its blast radius)*
Business-config edits mutate the world out from under existing bookings.
- **Unifies:** SYNC2 (recurring-hours shrink), SYNC3 (`bulk_close` range), SYNC4 (capacity reduction), SYNC7/blast-radius asymmetry, and the 2 stale active services you're carrying.
- **The one discipline:** *every settings mutation scans the future bookings it affects and blocks / confirms / cascades* through one shared blast-radius gate — symmetric across Branch-3 commands and Google owner-wins.

### P6 — Untrusted input crosses a trust boundary unauthenticated/unsanitized *(authenticate + fence at every edge)*
External input reaches an LLM or a state change without verification.
- **Unifies:** INJ1 (customer text → manager LLM), INJ2 (reply generator unsanitized), INJ3 (raw sessionContext), PAY1 (forged payment webhook), SYNC6 (forged calendar webhook), ID5 (wrong app-secret).
- **The one discipline:** *authenticate every webhook (HMAC/secret/resource-id) and sanitize-then-fence every customer-authored string as data, never instruction, before any LLM interpolation* — at the persistence boundary and again at every prompt.

### P7 — The failure/edge path is less safe than the happy path *(fail loud and safe, never silent)*
Degraded mode silently drops messages, loses intent, double-executes, or speaks wrong.
- **Unifies:** LLM1 (hang ghosts the customer), LLM3/LLM4 (parse failure / `.catch(false)` lose intent), LLM7 (loop-exhaust double-execute), CX6 (swallowed catch → double-booked), F1 (4096 → dropped), E2 (direct-send loses message after ledger), B2 (coalescer ack-before-flush), INJ4 (interactive replies ghosted), INJ5 (wrong-number reply), the bilingual/grovel fallbacks (F5/F6), CX5 (reshuffle success never told).
- **The one discipline:** *every failure path degrades visibly and safely* — never silently drop an inbound, never lose an actionable intent, never double-execute on retry, always answer in the right language or escalate. (Its conversational twin is the **"never dead-end a lead"** invariant from G2/G3/G3b/H2 — always substitute, clarify, or hand off.)

### How this reshapes the plan
The five-cluster order below still holds, but **frame each fix as closing a pattern, not patching an instance** — e.g. don't just lock `requestPrivateBooking` (A1); adopt the P1 *conditional-write discipline* everywhere P1 is listed, in one sweep, with a shared helper + a test that asserts the invariant. Two patterns are *latent doctrine the codebase already has and just needs applied uniformly*: **P3** (the lock) and **P4** (re-ground-at-action, which is literally the anti-fabrication lever generalized). The cheapest provisioning-grade win is to make P1, P2, P3 a single "write-integrity" workstream, since they share the same machinery (conditional writes + reapers + one lock).

---

## K. Live-test symptoms (pass 5) — root-caused, mapped, and one NEW root (P8)

Four symptoms from manual testing (Branch-4 customer `+972 54-637-2400` / `+972 52-293-9125`; Branch-3 owner). **Reframe:** the working tree is on `main` with restore, special-arrangement escalation, and the occupancy backstop **all committed** — so these are *holes in shipped code* (or a stale deployed revision — confirm what Cloud Run is running), not missing features.

### The single highest-leverage discovery — K0
**K0. [CRITICAL] `restorePrevious` and `specialArrangementRequest` are missing from the LLM JSON output *template* — so the model omits them and `.catch(false)` silently disables BOTH features at once.**
- **Location:** `src/adapters/llm/client.ts:150-172` (the "Return a JSON object with EXACTLY this structure (all fields required)" template) vs the Zod schema `:100-101` and the prose rules `:193-194`.
- **Mechanism:** the two flags live in the schema and the prose rules but **not** in the exhaustive JSON template the model copies. Told "all fields required" and not seeing them, Gemini routinely omits them → `.default(false).catch(false)` coerces to `false` → **the whole-object parse still succeeds**, so the caller never knows. Result: `restorePrevious=false` (restore handler never fires → reschedule-mislist loop, Screenshot 1) **and** `specialArrangementRequest=false` (escalation never fires → private-group request ignored, Symptom A). One template omission disables two features.
- **Fix direction:** add both fields to the JSON template; change `.catch(false)` → nullable so "unparseable" is distinguishable from "false" (this is LLM4 generalized).
- **Why it's the headline:** it's a *two-line* fix that explains two of the four symptoms, and it's the cleanest possible example of root **P7** (a critical signal silently degraded to the unsafe default).

### Symptom-by-symptom
| Symptom | Root cause (cited) | Maps to |
|---|---|---|
| **1. Restore-cancelled loops** (lists upcoming bookings, ignores the customer's "Pilates Thursday" pick) | (a) K0 → `restorePrevious=false` → mis-classified as reschedule → `enterCancellationSelection` shows the *upcoming* list (`customer-booking.ts:1969`); (b) the selection-state is **mono-purpose** — only `awaitingConfirmationFor==='cancellation_selection'` with one `cancellationCandidates` list exists (`:889`, `:2519`); a pick that matches nothing re-asks the same list (`:2576`). No typed "which question is this answering" state. | **K0/P7** + **NEW P8** |
| **2. Occupancy "Sunday full" laundered, then 18:00→19:00 self-contradiction** | Backstop is committed but has **two holes**: (a) `assertsNoAvailability`/`NO_AVAILABILITY_RE` (`slot-fabrication-guard.ts:101-110`) **misses the Hebrew "no spots left" family** (`לא נשארו עוד מקומות`, bare `[יום] מלא`, `אזלו`) and English "no more spots" → Gate 3 never even enters; (b) the **inquiry-resolved focus day is never persisted** (`customer-booking.ts:1113-1115`), so the bare continuation turn ("I want to join") enters the `default` branch with `focusDay=undefined` (`:1203`) → no fresh spine read on the very turn that launders the stalest "full." Plus a **scope-confusion** facet: a single-time miss (19:00) collapses into a day-level "full" (`:1844-1849`). | **P4** (archetype) + new P4 sub-rule: *a negative must be scoped no broader than what was actually checked* |
| **3. Private-group request ignored (owner never pinged)** | Escalation IS built (`escalateUnfulfillableRequest`, `maybeEscalateSpecial` `customer-booking.ts:1461`), but: (a) K0 → `specialArrangementRequest=false` so it never triggers; (b) even when flagged, `maybeEscalateSpecial` is only called from **three post-slot-resolution branches** (party-size/over-capacity/outside-hours, `:1743/1755/1799`) — a "private group" with **no concrete date/time** is inquiry/clarification-shaped and **never reaches an escalation hook** → flat dead-end, no ping. | **P7** (should-escalate-but-dead-ends) + **NEW P8** (interpretive↔core flow seam) |
| **4. "13:00/15:00/17:00/19:00 July 5" offered as open hours** | ✅ **DB-CONFIRMED FABRICATION (2026-06-28).** Real July-5 class instances are Pilates 09/11/14/18 + Yoga 10/12/16 (all `class` mode, cap 8, **0 booked = all open**). The PA offered 13/15/17/19 — **none are real classes**; they are the **gaps *between* the class blocks**. Mechanism: "yoga" resolved to an **appointment-mode** service (the catalog has `yoga`/`שיעור יוגה` as `appointment` *and* `יוגה` as `class`), so `getOpenSlots` treated the real class blocks as busy and returned the empty 2-hour gaps (12→14 ⇒ 13:00, 14→16 ⇒ 15:00, 16→18 ⇒ 17:00, after 18 ⇒ 19:00). Gate 2 trusted them because they came from a *real* `getOpenSlots` call (§6 lesson: wrong source, not wrong gate). Compounded by a **service-catalog mess**: duplicate `שיעור יוגה`×7 / `תספורת`×7, an `appointment`/cap-5 "yoga", and a malformed NULL-mode row. | **P4** (wrong availability MODEL = source-truth) + **P5** (catalog config: same concept exists in two modes; `day-options.ts:62` routes on capacity not `schedulingMode`) |

### NEW ROOT — P8: the interpretive↔core *flow* seam (the anti-fabrication doctrine's flow-state twin)
> The LLM↔core seam is guarded for **factual claims** (anti-fabrication: the LLM can't assert a time/count/action the core didn't produce). It is **NOT** guarded for **conversational flow**: the LLM can ask a question, offer a capability, or drive a multi-turn selection that the deterministic core has no state or handler to bind, complete, or track. The answer then drops, dead-ends, or loops.
>
> **Sub-cases observed:** (a) **pending-decision binding** — the PA offers a list, the customer picks, but there's no typed `pendingDecision{kind, options, originatingIntent}`; the only such state (`cancellation_selection`) is mono-purpose, so any other list-question's answer matches nothing and re-asks (Symptom 1). (b) **capability coverage** — escalation/restore is bolted onto a few deterministic dead-ends, not onto "the LLM flagged something the catalog can't express," so the inquiry-shaped version dead-ends (Symptom 3). (c) **signal plumbing** — an intent flag exists in the schema/rules but not in the output template, so it silently defaults off (K0).
>
> **The one discipline:** every PA-posed question that expects a structured reply must persist a **typed pending-decision** the next turn dispatches on *before* any fresh intent re-extraction; every LLM-surfaced capability must have a deterministic handler/escalation hook on *every* path that can reach it (inquiry included), not just narrow post-resolution branches; and every intent signal must be present in template ∧ schema ∧ rules, with "unparseable" distinct from "false." P8 is to *flow* what anti-fabrication is to *facts*.

P8 is genuinely distinct from the existing seven: **P4** is re-reading state at action time; **P7** is the failure branch being unsafe; **P8** is the *nominal* branch mis-binding a question to its answer at the LLM↔core boundary.

### To verify Symptom 4 against real data (read-only)
`.env.local` has `DATABASE_URL=…@127.0.0.1/pa4business`. The authoritative check (Asia/Jerusalem = UTC+3 on that date):
```sql
SELECT cb.start_ts, st.name, st.scheduling_mode, cb.max_participants
FROM calendar_blocks cb JOIN service_types st ON st.id = cb.service_type_id
WHERE cb.type='class' AND cb.start_ts >= '2026-07-04 21:00:00+00' AND cb.start_ts < '2026-07-05 21:00:00+00'
ORDER BY cb.start_ts;
```
Rows at 13/15/17/19 local ⇒ legitimate classes. Empty/different ⇒ the PA leaked boundary/gap times (Gate 2 boundary-allowlist + the `day-options.ts:62` mode-vs-capacity bug). Also check `SELECT name, scheduling_mode, max_participants FROM service_types WHERE is_active` for any class-mode service with `max_participants<=1`.

---

## Recommended remediation order (and how to route it without regressions)

The strongest signal is that **a handful of root causes generate most of the findings**. Fix the roots, not the symptoms:

1. **🔴 Provisioning blockers (do before any business goes live):**
   - **A1** private-booking atomicity (advisory lock + exclusion constraint) — *the* calendar go/no-go.
   - **F1** 4096-char splitter in `sendMessage` — one-function fix, prevents silent message loss.
   - **E1** waitlist atomic promotion; **E2** ledger-before-direct-send ordering.
   - **B2** coalescer ack-before-flush — **coordinate with the coalescing worktree** (their file).

2. **🟠 The concurrency/lifecycle root (one coherent workstream — B1/B3/B4/E3/E4/E5):** unify serialization — give the manager path `withIdentityLock`, make the in-lock session write a compare-and-set, order `loadActiveSession` newest-first + a partial unique index, and bring `queued-messages`/`hold-expiry`/`session-expiry` under a compatible lock. Doing these together avoids whack-a-mole and is the biggest single win for "stops forgetting."

3. **🟠 The grounding/ledger root (D1/D2/D3/D4):** uniform owner-approval gate + audit-log rows on calendar tools + tighten the claim-auditor mappings. Coordinate the `REPORTABLE_ACTIONS` edit with this branch's in-flight ledger work.

4. **🟡 Voice/template scaffolding (F2/F4/F5/F6/F7/F8 + C-series):** mostly independent string/logic edits; safe to batch in one pass. Re-verify **C1/C2** against this branch's committed `yes_with_question`/rejection work first — they may be partially addressed.

**Collision-avoidance map:**
- `customer-booking.ts` is the hot file already owned by this branch and the escalation-restore plan — sequence C-series and F2/F6 *after* this branch merges (same re-anchor caveat the escalation plan already calls out).
- B2/D7 → coalescing worktree. E4/E7/F6/B6/B7 → escalation-restore plan overlap.
- A-series, E1/E2, F1, F3/F4/F5, D1/D5 are **clean** (no in-flight overlap) — good candidates for an immediate parallel fix session.

**Suggested mechanism for the fix phase:** one dedicated TDD session per root cluster (calendar-atomicity, concurrency-lifecycle, grounding-ledger, voice-scaffolding), each gated on `npm test` + `tsc` + targeted reproduction. The clean clusters (calendar-atomicity, delivery/worker-safety) can run in parallel worktrees now; the `customer-booking.ts`-touching clusters should land after the current branch merges.

---

*Verification note: A1, B1, B2, E1, F1, F2, and the manager-lock/coalescer ordering were re-read against source and confirmed. All other findings cite exact `path:line` from the audit pass; spot-checks matched the code precisely, but the unverified ones are marked with their confidence level above.*
