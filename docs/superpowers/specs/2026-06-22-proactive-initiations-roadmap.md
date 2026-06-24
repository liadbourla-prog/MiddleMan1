# Proactive Initiations Engine — Build Roadmap (execution tracker)

**Design:** `2026-06-22-proactive-initiations-engine-design.md`
**Branch:** `dev/system/proactive-initiations-spine` (Developer A core; skills work tagged for Developer B)
**Mission-complete definition:** code reaches the level described in the design doc — the
curated catalog (design §8), the gate + budget + consent + ratchet governance (§4–7), the
fill cascade (§7.5), the profile (§7.6), and the notification engine (§7.7) are implemented,
tested, and behavior is preserved for everything migrated. External integrations (§8.3 "External")
are the one explicitly-deferrable group.

This is a multi-PR program. Each phase below is a self-contained, verifiable unit; build in
order (dependencies noted). `[ ]` = not started, `[~]` = in progress, `[x]` = done.

---

## Status board

| Phase | Title | Depends on | Status |
|---|---|---|---|
| 1 | Spine + ledger + migrate 3 initiators + migration-tooling fix | — | **[x] done** |
| 2 | Customer behavioral profile + unified segmentation | 1 | **[x] done** |
| 3a | Cold-fill rung (waitlist-exhausted → invite lapsed) | 2 | **[x] done** |
| 3b | Reschedule-retention (offer alternates before cancel) | 2 | **[x] done** |
| 6a | **Owner-confirm gate** (ai_proposed → propose to owner → send on approve) | 1 | **[x] done** (infra; needs detector + approve tool to be live) |
| 4a | Autonomous event-driven: review-request, no-show-followup (owner_configured) | 1 | **[x] done** (gated on automatedMessagesConfig) |
| 4b | Win-back detector (ai_proposed → owner-confirm via 6a) | 6a, 2 | **[x] detector done** (needs Branch-3 approve/decline tool for the owner to act) |
| 6b | Branch-3 approve/decline tool (owner acts on proposals in chat) | 6a | **[x] done — win-back is now end-to-end** |
| 4b-dunning | Payment dunning sequence (internal pending_payment) | 1 | **[x] done** |
| 4c | Subscriptions model + renewal reminders (`subscription.renewal_{7d,1d}`) | 1 | **[x] done** |
| 5 | Owner control surface: notification rules, attention budget, two-tier consent, quiet hours, blast breaker, OAU/bookings views | 1,2 | **[x] done** (5.1–5.6) |
| 6 | AI-proposed layer + trust ratchet (owner-confirm; detectors as skills) | 1,5 | **[x] done** (6.1–6.4) |
| 7 | Managed-conversation autonomy (reshuffle/coordination resolve more without hand-back) | 1 | **[x] done** (7.1–7.2) |
| 8 | External integrations (Meta/Shopify/Stripe/Google webhooks) | 5 | [ ] **gated — product decision** |

---

## 3b — Reschedule-retention (offer alternates before cancel)  `[x] done`

**Shipped:** behavior change in the Branch-4 cancellation flow (`src/domain/flows/customer-booking.ts`):
on a GENUINE confirmed cancel, `maybeEnterRetentionOffer` offers up to 3 open alternate slots
(next 14d) for the same service BEFORE releasing the booking; `handleRetentionResponse` converts
an accepted slot into a reschedule (reusing the existing `rescheduledFrom` deferred-cancel path)
and cancels as-before on decline. Pure `parseRetentionReply` in `flows/types.ts` (+15 tests in
`types.test.ts`). Migration `0030_reschedule_retention_flag.sql` + `businesses.rescheduleRetentionEnabled`.
632 tests green; tsc + eslint clean; dry-run parses.

**Key decisions:**
- **NOT a proactive initiator** — it's an in-session, reactive flow behavior (the customer just
  messaged), so NO registry entry / worker / dispatchInitiation. The in-window reply is a normal
  `genReply`.
- **Flag-gated, default OFF** (`businesses.rescheduleRetentionEnabled`, winback precedent). When
  OFF the cancellation flow is byte-for-byte unchanged — the existing cancellation/session tests
  pass untouched, proving preservation.
- **Insertion point:** the genuine-cancel path in `handleCancellationConfirmation` (after the
  `isReschedulingFlow` block, before `cancelBooking`). `maybeEnterRetentionOffer` returns `null` →
  caller cancels exactly as today.
- **Accept = reschedule:** strips retention/cancellation ctx keys, seeds `slotDraft` from the chosen
  slot via `localParts`, sets `rescheduledFrom`, and hands to `handleBookingIntent` with a synthetic
  booking intent — identical argument order to the existing reschedule accept block. Deferred-cancel
  means the old booking is released only once the new slot is secured (no stranding).
- **v1 scope: private/1-on-1 only.** Group classes (`maxParticipants > 1`) and the no-open-slots case
  fall through to normal cancel — no owner hand-back (the cascade closes without involuntary OAU,
  §7.5). Class-session retention is a follow-up. Window/maxSlots (14d / 3) tunable in Phase 5.
- Audit: `reschedule_retention.{offered,accepted,declined}` for the fill/OAU metrics.

## 4c — Subscriptions model + renewal reminders  `[x] done`

**Shipped:** new `subscriptions` table (migration `0029_subscriptions.sql` + Drizzle table +
`Subscription` type; added to `apply-all-migrations.ts` EXPECTED_TABLES) + pure
`src/domain/crm/subscription-renewal.ts` (window/tier math, 16 truth-table tests) +
`src/workers/subscription-renewal.ts` (daily tick, mirrors dunning) + 2 registry entries
`subscription.renewal_{7d,1d}`; wired into `server.ts`. 617 tests green; tsc + eslint clean;
`npm run db:apply --dry-run` parses.

**Subscriptions model:** `subscriptions(business_id, customer_id, service_type_id?, plan_name,
status[active|paused|cancelled|expired], interval_unit[week|month|year], interval_count,
renews_at, auto_renew, price_amount, price_currency, …)`. `renews_at` is the scan anchor;
partial index on `renews_at WHERE status='active'` keeps the daily scan cheap. **No external
processor — informational + reminder-driving only** (no auto-charge, no auto-advance), per the
deferred-processor decision. A population/management surface (owner creating subscriptions) is a
follow-up (Phase 5 or a separate effort); the worker no-ops on an empty table.

**Renewal initiators:** `subscription.renewal_7d` / `subscription.renewal_1d` — layer C,
customer, **transactional** (time-before reminder family alongside reminder.24h/1h → bypasses
opt-out/quiet hours), owner_configured, fire_and_forget, windowPolicy:'skip'. Disjoint bands by
`renewsAt`: 7d rung `[now+6d, now+7d]`, 1d rung `[now, now+1d]` (gap between). dedupKey
`subscription.{tier}:{subscriptionId}:{renewsAt YYYY-MM-DD}` — the date bucket gives each renewal
cycle a fresh reminder (design §4.5).

**Gating — boundary correction (important precedent):** the renewal switch is a new
`businesses.subscriptionRenewalEnabled` boolean (default OFF), **NOT** an `AutomatedMessagesConfig`
key. Adding *any* key to `AutomatedMessagesConfig` widens its `keyof`, which breaks the
`Record<keyof AutomatedMessagesConfig, …>` mapped type in the `business-knowledge-setup` skill
(Developer B). 4a/4b reused *pre-existing* config keys (review_request/payment_request), so they
were safe; a *new* capability must follow the 4b winback precedent (a dedicated boolean column on
`businesses`). Rule going forward: new proactive-initiator opt-ins = a `businesses` boolean, not a
config key, until Phase 5 builds the real control surface.

## 4b-dunning — Payment dunning over internal `pending_payment`  `[x] done`

**Shipped:** `src/domain/crm/dunning.ts` (pure tier math — `dunningActiveWindow`,
`dunningTierForAge`, `initiatorIdForTier`, 12 truth-table tests) + `src/workers/dunning.ts`
(hourly tick, mirrors `post-appointment.ts`) + 3 registry entries `payment.dunning_{1,2,final}`;
wired into `server.ts`. 601 tests green; tsc + eslint clean.

**Key decisions (confirmed against the schema):**
- **No migration / no schema change.** Runs over the existing `pending_payment` booking state,
  the existing `automatedMessagesConfig.payment_request.enabled` owner flag, and the existing
  `initiation_log` ledger. (hold-expiry only touches `state='held'`, so `pending_payment`
  bookings persist indefinitely → a real multi-day aging window.)
- **Anchor = `bookings.createdAt`** (immutable; requested→pending_payment is synchronous in
  `requestBooking`, so createdAt ≈ payment-due moment; `updatedAt` would drift).
- **consentClass `transactional`** (design §7 lists "payment due" as always-sent → bypasses
  opt-out/quiet hours, correct for an owed payment). `owner_configured`, `fire_and_forget`,
  `windowPolicy:'skip'` (in-window only until a Meta template exists).
- **Cadence (baked-in, tunable in Ph5), by age bands:** tier 1 `[2h,24h)`, tier 2 `[24h,72h)`,
  final `[72h,96h)`, give up ≥96h. Dedup `payment.dunning:{bookingId}:{tier}` → one send per
  booking per rung. Gated on `payment_request.enabled` (mirrors 4a review/no_show gating).
- Escalating-but-polite he/en copy per rung; all sends via `dispatchInitiation`.

## Phase 2 — Customer behavioral profile + unified segmentation  `[x] done`

**Shipped:** `src/domain/crm/customer-profile.ts` (pure, 13 tests) + `segment-repository.ts`
(the one reader); `SegmentFilter`/`CustomerSummary` extended in `skill-types.ts`; both callers
(context-builder + orchestrator-tools `segment`) unified onto it; fixed the zero-returning stub.
551 tests green. Follow-up (Ph3/5): expose `lapsed`/`preferredDay` filters to the manager LLM
tool schema (kept internal for now to avoid changing Branch-3 behavior).

**Why first after the spine:** cheap (mostly aggregation over `bookings`), fixes a live bug,
and unlocks cold-fill (Ph3), win-back (Ph4), and value scoring (Ph5/6).

**Current state (bugs to fix):**
- `queryCustomerSegment` in `src/domain/skills/context-builder.ts` is a STUB — returns every
  customer with `totalBookings: 0, lastBookingAt: null`, ignoring the filter.
- A second, partial segment path lives in `executeLookupCustomer` (`orchestrator-tools.ts`,
  `queryType: 'segment'`) — only post-filters `inactiveSinceDays`.

**Build:**
1. `src/domain/crm/customer-profile.ts` — PURE: `computeCustomerProfile(bookings, now)` →
   `{ lifetimeBookings, attendedCount, lastBookingAt, cadenceDays, preferredServiceTypeId,
   preferredDayOfWeek, preferredTimeBand, noShowRate }`; `matchesSegment(profile, filter, now)`.
2. `src/domain/crm/segment-repository.ts` — the ONE DB reader: `queryCustomerSegment(db,
   businessId, filter)` and `loadCustomerProfile(db, businessId, identityId)`. Fetch bookings
   once, apply the pure functions.
3. Extend `SegmentFilter` + `CustomerSummary` in `src/shared/skill-types.ts` (co-owned —
   Developer B sign-off): add `vip?`, `preferredDayOfWeek?`, `preferredTimeBand?`,
   `serviceTypeId?` (already), `lapsedCadence?` (lapsed = now − lastBooking > k×cadence);
   `CustomerSummary` gains `cadenceDays`, `preferredServiceTypeId`, `preferredDayOfWeek`,
   `preferredTimeBand`, `vip`, `noShowRate`.
4. Wire BOTH callers (context-builder + orchestrator-tools `segment`) to the one repository.
5. Tests: `customer-profile.test.ts` truth tables (cadence median, preferred day/time bands,
   lapsed detection, no-show rate, empty history).

**Acceptance:** tsc+lint+vitest green; segment query returns real counts/profile, not zeros;
both segment paths use the shared reader; no skills-boundary import.

---

## Phase 3 — Fill cascade + reschedule-retention  `[ ]`

Wire one cascade (design §7.5): waitlist match → freed-slot offer → **cold-fill outreach**
(new `coldfill.invite` initiator, audience customer, promotional, managed) targeting
profile-matched lapsed customers via the Ph2 reader; reschedule-retention offers alternates
before cancelling. All sends via `dispatchInitiation`. Cold-fill default ceiling: ≤1 invite /
customer / 14d (design open-Q6 default; tunable in Ph5). Needs a `coldfill_*` Meta template or
`windowPolicy:'skip'`.

## Phase 4 — Fire-and-forget initiators  `[ ]`

Declare + detect: `payment.dunning_{1,2,final}` (internal `pending_payment` state),
`booking.no_show_followup`, `review.request` (1d after attended), `churn.winback_{30,60,90}`
(Ph2 lapsed segments), and `subscription.renewal_{7d,1d}` (needs the new **subscriptions
model** — owner approved). Each: registry entry + a worker/tick detector. **All declare
`windowPolicy:'skip'`** (owner decision — in-window-only until Meta templates exist); flip to
`{templateName}` per-initiator once registered. **Birthday/holiday greeting: dropped** for now
(no birthday field). Subscriptions schema (new table + migration via `apply-all-migrations.ts`)
is a prerequisite sub-task here (or its own small PR).

## Phase 5 — Owner control surface  `[x]` done (all 6 units)

**Sliced into 6 sequential units** (owner-approved 2026-06-23): 5.1 two-tier consent → 5.2
business-level quiet hours → 5.3 attention budget → 5.4 blast-radius breaker → 5.5 dynamic
notification rules → 5.6 metric views. Resolved decisions: **A** = per-category promotional
opt-out (jsonb), coarse `all` = stop-all-promos; **B** = build the FULL knapsack allocator now
but **ledger-driven, no proposal queue** — `allocateBudget(candidates, alreadySpent, budget)`
ranks by `priority × expValue` (the §4.4 contention test) and is enforced as a priority-aware
rolling per-customer budget read from `initiation_log` (via `initiation_log_recipient_idx`);
`expValue` defaults to 1 (priority-only) until Phase 6 supplies `valueModel`s. The speculative
proposal-queue is deliberately NOT built (bounded by async eligibility arrival; holding a
customer's promo slot speculatively is worse UX — the rolling+allocator is the terminal design).
**C** = notification rules use a fixed event enum + simple conditions (no DSL). **D** = additive
over `NotificationPreferences` (old booleans as fallback) — a hard replacement would re-trigger
the 4c-style skills `keyof` break.

### 5.6 — Metric views (north-star dashboard)  `[x] done`
**Shipped:** pure `src/domain/initiations/metrics.ts` `northStarLines(bookingsWeek, oauWeek, lang)`
(he/en; zero-OAU celebrated, never shows "OAU" to the owner; 7 tests) appended to the daily
briefing. `daily-briefing.ts` computes **bookings/week** (bookings created in last 7d, state
confirmed|attended) + **involuntary OAU/week** (escalation `initiation_log` entries —
`escalation.owner_rule`/`escalation.platform` — the uniformly-logged "PA had to pull the owner in"
proxy; refined in Ph6/7). 689 tests green. No migration. (Also removed 6 pre-existing dead
vars/imports in daily-briefing.ts to keep the touched file lint-clean.)

### 5.5 — Dynamic notification rules  `[x] done`
**Shipped:** `businesses.notificationRules` jsonb (migration `0033_notification_rules.sql`); pure
`src/domain/initiations/notification-rules.ts` — `resolveNotificationAction(rules, legacyPrefs,
event, ctx)` (matching rule → legacy `NotificationPreferences` boolean → default `notify`),
`upsert/removeNotificationRule`, event enum {new_booking, first_time_customer, cancellation,
reschedule, no_show, refund_request, vip_return}, actions {notify, notify_with_actions,
handle_silently}, optional `withinHours` condition (no DSL — decision C). 15 tests. New Branch-3
`configureNotifications` orchestrator tool (declaration + dispatch + `executeConfigureNotifications`
handler mirroring `configureReshuffle`'s deterministic load→merge→persist). 682 tests green.
- **Additive (decision D):** layers over `NotificationPreferences` (untouched — no skills `keyof`
  break); legacy booleans are the fallback.
- **Deferred:** wiring `resolveNotificationAction` into live notify SITES — there is NO live
  consumer of `NotificationPreferences` today, so nothing to rewire. Notify-emission on booking
  events + the Phase-6 trust ratchet plug into this evaluator later.

### 5.4 — Blast-radius breaker  `[x] done`
**Shipped:** pure `src/domain/initiations/blast-breaker.ts` `evaluateBlastBreaker(tally, cfg)` →
`continue | ceiling_reached | abort_error_spike | abort_optout_spike` (ceiling first; after
`minSampleK`, error-spike before opt-out-spike) + `resolveBlastBreaker` (partial-over-defaults) +
`DEFAULT_BLAST_BREAKER` (maxPerRun 200, minSampleK 5, error>0.3, optOut>0.2). 9 tests incl. the
§4.6 headline (high error rate aborts BEFORE the ceiling) and the sub-sample guard (no premature
abort under K). `blastBreaker?` field on `Initiator`. **Wired into the cold-fill batch loop**
(`waitlist.ts`): per-iteration verdict check, send-failure tracked (no re-throw), tally
sent/optOuts/errors, `coldfill.aborted` audit on trip. 667 tests green. No migration.
- Follow-up: adopt the primitive in reshuffle / dunning-sweep / segment broadcast (cold-fill only
  this unit). Per-business breaker override → 5.5.

### 5.3 — Attention budget  `[x] done`
**Shipped:** pure `src/domain/initiations/budget.ts` `allocateBudget(candidates, alreadySpent,
budget)` — full priority×expValue knapsack, index-based admit set, stable ties, order-preserving
result (8 tests incl. the §4.4 contention test: 4 candidates, budget 1 → top-scorer admitted, 3
deferred). Enforced in the dispatcher as a **rolling per-customer promotional budget**: counts the
recipient's prior promotional sends in the window from `initiation_log` (recipient index), runs the
allocator with the single current candidate, on defer logs `initiation.deferred` + returns skip
`budget_exhausted`. No queue (decision B); `expValue`=1 until Phase 6. Defaults
`DEFAULT_PROMOTIONAL_BUDGET=1` / `PROMOTIONAL_BUDGET_WINDOW_DAYS=7` (tunable per-business in 5.5).
Priorities: reshuffle 80, coldfill 70, winback 60, no_show 50, review 30. 658 tests green.
- Placement = §4.3 order (consent→window→quiet→**budget**→dedup): runs only on a non-skip gate
  decision, before the ledger insert. Transactional exempt. Gate unchanged. No migration.
- winback sends via approvals.ts (not budget-checked) but its logged send counts toward `spent` —
  intended.

### 5.2 — Business-level quiet hours  `[x] done`
**Shipped:** `businesses.quietHours` jsonb (migration `0032_business_quiet_hours.sql`); pure
`src/domain/initiations/quiet-hours.ts` `isWithinQuietHours(now, tz, window)` (13 tests — normal,
wrap-around past midnight, start==end empty, malformed, tz-conversion); dispatcher now computes
`nowInQuietHours` for promotional outside-party sends from the window + business timezone (gate
already consumes it; `gate.ts` unchanged). null window → no suppression (behavior preserved).
650 tests green. Setter UX → 5.5. (Distinct from `reshuffleConfig.quietHours`, left intact.)

### 5.1 — Two-tier consent  `[x] done`
**Shipped:** `identities.promotionalOptOuts` jsonb (migration `0031_two_tier_consent.sql`); pure
`src/domain/initiations/consent.ts` `isPromotionalSuppressed(messagingOptOut, promotionalOptOuts,
category)` (5 tests); `category` field on the `Initiator` type set on every promotional initiator
(reshuffle→reshuffle, coldfill→coldfill, review→review, no_show→no_show, winback→winback);
consent **centralized in the dispatcher** (`dispatch.ts` now loads the recipient's two-tier opt-out
for promotional outside-party sends). 637 tests green; tsc+lint clean; dry-run parses.
- `messagingOptOut` stays the GLOBAL kill-switch (Meta platform opt-out, webhook.ts:583 — untouched).
- **Live gap fixed:** promotional workers never passed `recipientOptedOut` (defaulted false), so
  review/no-show/cold-fill never honored opt-out; the dispatcher now computes it. winback was
  already safe (checks directly in approvals.ts).
- **Setter UX deferred to 5.5** (customer "stop promos" intent / owner per-category toggles via the
  Branch-3 control surface). The column is honored now, populated in 5.5 — same precedent as the
  subscriptions table shipping before its population surface. Gate (`gate.ts`) unchanged.



- **Two-tier consent:** split `messagingOptOut` into transactional (always) vs per-category
  promotional opt-out (schema: `promotional_opt_outs` or a jsonb on identities).
- **Attention budget:** per-customer rolling promotional budget; eligible initiations compete
  by `priority × expValue`; deferred/dropped logged (design §4.4). Reads `initiation_log_recipient_idx`.
- **Quiet hours:** generalize `reshuffle/config.ts` to a business-level setting the gate reads.
- **Blast-radius breaker:** generalize reshuffle `maxOutreachPerCampaign` to a mandatory
  campaign-level breaker (per-hour ceiling + abort-on-opt-out-spike).
- **Dynamic notification rules (design §7.7):** `when {event+condition} → {notify | notify+actions
  | handle-silently}`, editable via the Branch-3 orchestrator; replaces static `NotificationPreferences`.
- **Metric views:** daily-briefing lines for bookings/week + involuntary OAU.

## Phase 6 — AI-proposed layer + trust ratchet  `[x]` done (all 4 units)

**Sliced into 4 units** (owner-approved): 6.1 autonomy state + pure ratchet → 6.2 ratchet wiring +
owner control → 6.3 proposeInitiation skills contract → 6.4 owner-only autonomous digests.
Decisions: **A** thresholds — promote at precision ≥0.8 over ≥5 decided proposals, demote on
opt-out spike (≥2 opt-outs AND >20% rate); **B** storage — `initiation_autonomy` table keyed
(business, category); **C** UX — auto-promote then notify with veto offer + `setInitiationAutonomy`
tool; **D** 6.4 — start with empty-hours + likely-churns digests only.
**Key fact:** the `autonomy` field was documentation-only (no runtime read) — the behavior split is
hard-coded by which path a worker takes (winback→`proposeInitiation`; owner_configured→
`dispatchInitiation`). The ratchet introduces a persisted, runtime-read autonomy state so a proven
category flips from propose → direct-send.

### 6.4 — Owner-only autonomous digests  `[x] done`
**Shipped:** pure `ownerDigestLines(bookingsTomorrow, likelyChurns, lang)` in `metrics.ts` (he/en;
churn line omitted when zero; 4 tests) appended to the daily briefing. `daily-briefing.ts` computes
**tomorrow's confirmed bookings** (tz-correct day bounds via `resolveSlotStart`/`addDaysToDateStr`/
`localParts`) + **likely churns** (Ph2 `queryCustomerSegment` lapsed count — the win-back loop's
input). Owner-only → autonomous, no approval. 704 tests green. (Decision D: started with these two;
delivered via the existing owner-only briefing channel rather than standalone initiators.)

### 6.3 — `proposeInitiation` skills contract  `[x] done`
**Shipped:** `ProposeInitiationInput`/`ProposeInitiationOutcome` types + a `proposeInitiation`
callback on `SkillContext` (skill-types.ts, co-owned) — injected by the core in `context-builder`
(closes over db + businessId, calls the real `approvals.proposeInitiation`). Matches the existing
injected-callback pattern (`customerSegmentQuery`/`saveX`) so **skills never import the engine** —
Developer B's churn/hot-lead/upsell detectors now propose via the shared contract. Updated the 2
skill test mocks for the new required field; removed a pre-existing dead `identities` import in
context-builder. 700 tests green. (Contract only; the detectors are Developer B's.)

### 6.2 — Ratchet wiring + owner control  `[x] done`
**Shipped:** thin-I/O `src/domain/initiations/ratchet-runner.ts` `runRatchet(db, business, category)`
— gathers the owner-decision track record (initiation_approvals) + post-promotion opt-out signal
(initiation_log ⋈ identities via `isPromotionalSuppressed`), runs `evaluateRatchet`, persists
promote/demote, notifies the owner (he/en; promotion offers veto) + `categoryForInitiator`. Wired
into `resolveInitiationProposal` (all 3 outcome branches, after status persisted) to catch PROMOTE
on decision, and into the win-back tick per business to catch DEMOTE. **Win-back proposer now
branches on `resolveAutonomy`**: `owner_configured` → `dispatchInitiation` (direct send under the
gate); `ai_proposed` → `proposeInitiation` as today. New Branch-3 `setInitiationAutonomy` tool
(auto/ask; 'ask' sets vetoed) mirroring `configureNotifications`. 700 tests green; no regression
(default `ai_proposed` → behavior unchanged).
- Note: this unit's subagent was interrupted mid-run; the orchestrator tool wiring + a tsc cast
  (`Object.values(INITIATORS) as Initiator[]`) were completed centrally.

### 6.1 — Autonomy state + pure trust ratchet  `[x] done`
**Shipped:** `initiation_autonomy` table (migration `0034`, in EXPECTED_TABLES) keyed
(business, category) with `state` (ai_proposed|owner_configured), `vetoed`, promoted/demoted_at;
pure `src/domain/initiations/ratchet.ts` `evaluateRatchet(state, vetoed, history, recentSends, cfg)`
→ promote|demote|hold (demote checked first as safety; veto blocks promotion; `DEFAULT_RATCHET`
minSample 5 / θ 0.8 / demote >20% & ≥2 opt-outs) — 11 tests (the §5 trust-ratchet test); thin-I/O
`autonomy.ts` (`resolveAutonomy` default ai_proposed, `setAutonomyState` upsert). 700 tests green.
No behavior change yet (6.2 wires it).


## Phase 7 — Managed-conversation autonomy  `[x]` done (both units)

**Sliced into 2 units** (owner-approved): 7.1 resolution-autonomy instrumentation → 7.2 reshuffle
counter-offer auto-resolution. Decisions: **A** refine the existing involuntary-OAU briefing number
to count managed dead-letters (+ a resolution-autonomy reader); **B** reuse the LLM-behind-a-guardrail
pattern from `coordination/interpret.ts` for counter-slot extraction; **C** counter-offer only
(partial-pay/dunning is fire-and-forget in our code, out of scope).
**Key facts:** coordination's owner-confirms are BY DESIGN (owner books their own meetings on final
confirm) → voluntary OAU, not dead-letters. The reshuffle reply handler already HAS a `counter`
branch (updates offer + re-kicks solver) but the classifier never produces it (inbound.ts:16-18
flags it as a follow-on) → off-script replies loop on `unclear` = the §6 dead-letter.

### 7.2 — Reshuffle counter-offer auto-resolution  `[x] done`
**Shipped:** `src/domain/reshuffle/interpret.ts` — pure `mapReplyToCounter(raw, {durationMin, tz,
now})` (LLM-extracted pieces → `counter` with a resolved slot via `resolveSlotRange`; decline →
decline; else unclear; 5 tests) + `buildOutreachClassifier` (yes/no fast-path, then
`interpretMeetingReply` LLM extraction). Swapped inbound.ts's deterministic-only classifier for it
(loads business tz + offered-slot duration). **The existing `counter` branch + solver were already
in place** — this filled the classifier gap the code itself flagged (inbound.ts:16-18), so an
off-script "can we do Tuesday at 3?" now auto-resolves (offer → countered → solver re-kick) instead
of looping on `unclear`. Guardrail unchanged: hedge / low-confidence / unusable-slot → still
`unclear` (never a false acceptance). 714 tests green. No migration. Reuses the proven
coordination/interpret.ts pattern (decision B).

### 7.1 — Resolution-autonomy instrumentation  `[x] done`
**Shipped:** pure `src/domain/initiations/resolution-autonomy.ts` `classifyManagedOutcome(action)`
→ resolved | dead_letter | other (RESOLVED: coordination.booked / reshuffle.applied; DEAD_LETTER:
coordination.book_conflict|book_failed|expired / reshuffle.failed) + `resolutionAutonomyRatio` +
`countManagedOutcomes` reader (5 tests). **Emitted the missing reshuffle audit:** `reshuffle.applied`
(executor success), `reshuffle.failed` (executor stale-plan + worker no-solution exhaustion) —
coordination already audited its outcomes. **Refined the daily-briefing involuntary-OAU number** to
add managed dead-letters to the escalation proxy (design §6 — now counts real hand-backs). 709 tests
green. No migration. (Also removed 4 pre-existing dead imports in reshuffle-campaign.ts.)



Widen reshuffle/coordination state machines to resolve counter-offers/partial replies without
owner hand-back; instrument + drive the involuntary-OAU dead-letter rate down (design §6).

## Phase 8 — External integrations  `[ ]` *(gated)*

Webhook ingest for Meta leads / Shopify / Stripe charge-failed / Google reviews → owner/customer
initiators. **Park unless the owner greenlights** (design open-Q2).

---

## Owner directive (2026-06-23): ai_proposed needs owner approval

> "Owner needs to approve a proactive move in certain cases. Example: a customer hasn't come
> for two weeks — the PA should KNOW that, but not message straight away; it should ask the
> owner first (maybe the customer is on a trip they told the owner about)."

So **win-back / lapsed re-engagement is `ai_proposed`**: detect → propose to owner → send ONLY
on owner approval (the `freedSlotApprovals` model). This pulls the **owner-confirm gate (6a)**
forward as a prerequisite for win-back (4b). Event-driven, expected sends (review after a visit,
no-show follow-up) stay `owner_configured` (4a) — no per-message approval. Cold-fill (3a) stays
gated on the explicit `freedSlotOfferPolicy:'auto'` blanket opt-in for now; can move to
`ai_proposed`/'ask' later if the owner wants per-batch approval.

## Product decisions — RESOLVED (owner, 2026-06-22)

1. **New schema fields:** ✅ **Add the subscriptions model** (new `subscriptions` table + renewal
   logic) — enables the subscription-renewal initiator in Ph4. ❌ **Birthday: deferred** (no
   `identities.birthday`; the birthday/holiday-greeting initiator is dropped from the active
   catalog for now). VIP already exists.
2. **Meta templates:** ✅ **Build in-window-only** — all new customer-facing initiators
   (dunning, no-show, review, win-back, cold-fill, subscription-renewal) declare
   `windowPolicy:'skip'`. They send only inside the 24h window for now; flip each to
   `windowPolicy:{templateName}` once templates are registered in Meta. No blocker.
3. **External integrations (Ph8):** ✅ **Parked.** Do not build webhook ingest now; revisit as a
   separate effort. Everything else still reaches "doc level."
4. **Tunable defaults (Ph5/6):** attention-budget ≈1 promotional/7d, cold-fill ceiling ≈1/14d,
   ratchet θ + sample N — sane defaults chosen in-code; owner can adjust later.

> Net effect on the catalog: birthday greeting → dropped (for now); subscription-renewal → in;
> Phase 8 → parked; every new customer-facing initiator → `windowPolicy:'skip'` until templates exist.

---

## Conventions for every phase

- Deterministic core: pure decision modules (return descriptors) + thin I/O, like
  `coordination/state.ts` and `initiations/gate.ts`. New customer-facing sends go through
  `dispatchInitiation` — never a bespoke send.
- Migrations: hand-authored `NNNN_*.sql` (`IF NOT EXISTS`) + add to `apply-all-migrations.ts`
  `EXPECTED_TABLES`. Never `drizzle-kit migrate`.
- Skills boundary: detectors/intelligence may live in `src/skills/` and `proposeInitiation`;
  the core decides + sends. No skills→core imports.
- Each phase ends green on `tsc` + `lint` + `vitest` with behavior preserved for migrated paths.
