# Proactive Initiations Engine — Design (v2, codebase-corrected)

**Date:** 2026-06-22
**Supersedes:** the `2026-06-22-proactive-initiations-engine-design-2.md` draft (built on a partner machine; its "what exists" claims were partly inaccurate — corrected here against the live tree at v1.0.76).
**Branches touched:** 1 (Operator), 3 (PA Manager), 4 (PA Customer) — outbound across all.
**Owner:** Developer A (`src/domain`, `src/adapters`, `src/db`, `src/workers`, `src/routes`) — not `src/skills`.
**Status:** Brainstorming → hardening. No code yet.

---

## 0. The North Star this design is judged against

> **Maximize bookings/week (the margin proxy) while driving the owner's *involuntary*
> attention to the CRM toward zero — payments, cancellations, booking movement, and
> calendar fill all handled by the PA under the owner's own, dynamically-set rules.**

This is a **bi-objective optimization problem**, and the discredited draft stated no
objective function at all. The engine is simultaneously a **growth engine** (it fills the
calendar) and an **attention sink to be drained** (it keeps the owner out of routine
chat). Written honestly:

> **maximize Σ bookings/week − λ · (involuntary OAU)**,
> subject to a per-customer annoyance budget and per-category consent.

Everything below is measured against *both* terms, not just "safe." Safety without a path
to autonomy does not reduce owner attention — it relocates it.

### 0.1 Metric 1 — bookings/week (the margin proxy)

Margin is operationalized as **calendar fill**. Every proactive loop carries a measurable
**fill-value** = the incremental bookings it generates. Three loops move this number and
are therefore **flagship initiators, not footnotes**:

- **Waitlist-on-cancellation** — a freed slot is re-sold automatically.
- **Cold-fill outreach** — profile-matched lapsed/spontaneous customers are invited to
  fill empty class capacity (yoga/pilates), based on their booking history.
- **Reschedule-retention** — a move request is absorbed without losing the booking.

The value gate (§4.3 step 7) is therefore concrete: *expected incremental bookings vs
expected opt-out cost* — not a vague "reputation vs annoyance."

### 0.2 Metric 2 — OAU, split into two kinds (they are NOT the same enemy)

An **Owner Attention Unit (OAU)** is any event that needs the owner to read or tap. It
splits in two, and conflating them is a design error:

- **Involuntary OAU** — the system *could not* resolve something and had to pull the owner
  in: an escalation, a managed-conversation hand-back, an ambiguous reply. **Pure waste.
  This is the term we drive to zero** (via the trust ratchet §5 and managed-conversation
  autonomy §6).
- **Voluntary OAU** — the owner *chose* to see it: "notify me on every cancellation /
  refund request." **Not waste — it is the owner's control dial**, and it is **dynamic**
  (per-cancellation sometimes, per-refund other times, changing week to week). The
  system's job is to (a) honor it exactly, (b) make it trivially reconfigurable in chat,
  and (c) *help the owner shrink it over time* — the trust ratchet applied to
  notifications: "you've approved 20 refunds unchanged — want me to handle these and flag
  only exceptions?"

**The north-star dashboard is two numbers per business:** bookings/week (push up) and
**involuntary** OAU/week (push to zero). Voluntary OAU is displayed and owner-controlled,
never minimized by us against the owner's wishes.

### 0.3 Send value / send cost

Each customer-facing initiation has an expected value (incremental booking, recovered
payment × p, reactivated LTV × p) and an expected cost (annoyance → opt-out probability →
LTV destroyed). The gate's job is not only "is this allowed" but "is `E[value] −
E[annoyance] > 0`."

---

## 1. Problem & the corrected kernel

The product needs the PA to **start** conversations, not only answer them. We keep the
useful kernel from the earlier exploration — a 3-layer split by **trigger source** — and
reject the "Salesforce-grade 2,000-trigger / autonomous-AI-messages-customers" framing
(it violates CLAUDE.md Principle 1 and is operationally impossible under WhatsApp's
template limits, §4).

- **Layer A — Owner → (AI) → Customer(s).**
- **Layer B — Customer → (AI) → Owner.**
- **Layer C — Event / Time / External → (AI) → Customer or Owner.**

**Corrected key finding:** all three layers already run in production, each hand-written
in its own worker. There is no *functional* gap — there is a missing **unifying spine**.
But — and this is the correction to the prior draft — the **eligibility primitives are
NOT "missing / do not exist today."** They already exist, scattered and feature-local
(see §2). The real work is **consolidation + a metric + a path to autonomy**, not
green-field invention.

---

## 2. What actually exists at v1.0.76 (verified against the tree)

| Claim in prior draft | Reality in code | Verdict |
|---|---|---|
| `messageCustomer`, `coordinateMeeting` tools | `src/adapters/llm/orchestrator.ts:330,343` | ✅ correct |
| `reshuffle-campaign.ts` broadcast w/ negotiation | exists; rich config | ✅ correct |
| Escalation engine (keyword/emotional/unknown_intent) | `src/domain/escalation/engine.ts` | ✅ correct |
| `canSendFreeForm(identityId)` 24h guard | `src/adapters/whatsapp/sender.ts:34` | ✅ correct |
| `freedSlotApprovals` owner-confirm precedent | `src/db/schema.ts:542` | ✅ correct |
| `generateProactiveCustomerMessage({situation,fallback,timeoutMs})` | actually `{businessName, language, situation, fallback, timeoutMs}` | 🟡 signature wrong in draft |
| `logAudit`, worker registry in `server.ts` | all present (17 workers) | ✅ correct |
| **Eligibility Gate "does not exist today / genuinely missing"** | **FALSE — primitives exist, see below** | ❌ **wrong** |
| **VIP "🔴 needs VIP flag" + open question** | **`identities.vip` boolean EXISTS** (`schema.ts:99`) | ❌ **wrong — VIP exists** |
| Payment "🔴 needs payment integration" | booking-level payment state EXISTS (`pending_payment`, `paymentStatus`, `requiresPayment`, `paymentAmount`, `confirmationGate`); what's missing is an external **processor** + dunning sequence | 🟡 conflates "no model" with "no processor" |

**Eligibility primitives that already exist (the draft's biggest factual error):**

- **Consent / opt-out:** `identities.messagingOptOut` (`schema.ts:97`) + live Meta
  opt-out code handling (`WA_USER_OPT_OUT_CODE = 131026`, `sender.ts`). It is a *single
  boolean* (all-or-nothing) — that's the real gap, not "no consent."
- **Quiet hours:** `src/domain/reshuffle/config.ts` `QuietHours` (default 21:00–08:00).
- **Frequency / blast caps:** reshuffle `batchSize` (7), `maxOutreachPerCampaign` (21),
  `protectWindowHours`, `protectVip`, `protectRecentlyRescheduled`.
- **Dedup / idempotency:** `reminders` `uniqueIndex(bookingId, triggerType)`
  (`schema.ts:508`); `freedSlotApprovals.sourceBookingId`; `integrity_findings`
  open-dedup index.
- **Approval gate precedent:** `freedSlotApprovals` + reshuffle `approvalMode`.

**Therefore the spine is a generalization of the reshuffle config model**, lifted out of
one worker and made the single path for every initiation — not a new invention.

---

## 3. The hard constraint: WhatsApp's 24h window (unchanged, correct)

`canSendFreeForm` returns false >24h after the recipient's last message. Outside the
window only an approved **template** sends. Today `reminder.ts` falls back to a template;
`reshuffle-campaign.ts` silently skips. Every customer-facing initiator must declare
either `windowPolicy: { templateName }` or `windowPolicy: 'skip'` (explicit + logged).
This finite template set is the real reason a 2,000-trigger catalog is impossible.

**Add (new):** treat the open window as a **depletable, schedulable resource**. Every
inbound resets it; free-form is free, templates cost money per send. A proactive
scheduler that *sequences* eligible sends to land while the window is warm raises
margin and lowers rejection. Minor, but it is literally a margin lever and belongs in
the gate's send-time decision.

---

## 4. Architecture — the spine

```
DETECT → Initiator (registry entry) → ELIGIBILITY GATE → [VALUE GATE] → PHRASING (LLM) → SAFE SEND → [REPLY ROUTING if managed]
(3 homes)     (config object)        (consolidated)     (E[v]>E[cost])   (situation→text)  (tmpl/free)   (state machine)
```

### 4.1 Three axes (the draft had two of the three)

- **Source (A/B/C):** where detection lives.
- **Delivery:** `fire_and_forget` vs `managed` (state machine that routes replies). The
  biggest code fork — and, per §6, **the place where owner attention actually leaks.**
- **Autonomy:** `owner_commanded` / `owner_configured` / `ai_proposed`. **New:** autonomy
  is not a fixed label — it is a **state that ratchets** (§5). This is the single most
  important correction relative to the North Star.

### 4.2 The Initiator registry

```ts
interface Initiator {
  id: string                                  // 'reminder.24h', 'churn.winback_60d'
  layer: 'A' | 'B' | 'C'
  audience: 'customer' | 'owner' | 'operator' | 'contact'
  consentClass: 'transactional' | 'promotional'   // NEW — drives two-tier opt-out (§7)
  autonomy: 'owner_commanded' | 'owner_configured' | 'ai_proposed'
  delivery: 'fire_and_forget' | 'managed'
  detect: 'worker_tick' | 'inbound_hook' | 'orchestrator_tool' | 'external_webhook'
  windowPolicy: { templateName: string } | 'skip'
  priority: number                            // NEW — contention ranking for the budget allocator (§4.4)
  valueModel?: (ctx) => { expValue: number; annoyanceCost: number }  // NEW — value gate
  eligibility: EligibilityRule[]
  dedupKey: (ctx) => string                   // MUST include a time bucket for periodic sends (§4.5)
  phrasing: { situation: string; fallbackKey: string } | { templateOnly: true }
  blastBreaker?: { maxPerHour: number; abortIfOptOutRateOver: number }  // NEW — mass-send circuit breaker (§4.6)
  defaultEnabled: boolean
}
```

### 4.3 The Eligibility Gate (consolidate, don't invent)

One deterministic module. Order matters; each step is *lifted from an existing
implementation* and unified:

1. **Consent** — two-tier: `transactional` always allowed; `promotional` respects
   per-category opt-out (§7). (Generalizes the single `messagingOptOut` boolean.)
2. **24h-window resolution** — `canSendFreeForm` → free-form / template / skip.
3. **Quiet hours** — business timezone. (Lift `reshuffle/config.ts`.)
4. **Frequency** — see §4.4: NOT independent per-category caps; a single per-customer
   attention budget with priority.
5. **Dedup** — `dedupKey` with time bucket. (Generalize `reminders` unique index.)
6. **Autonomy** — `ai_proposed` + `audience:customer` → owner-confirm OR
   auto-promoted (§5). Never a silent direct send while still in probation.
7. **Value gate (NEW)** — `expValue − annoyanceCost > threshold`, else skip + log.
8. **Audit** — every decision (sent/skipped/blocked + reason) via `logAudit`.

### 4.4 Frequency capping is the wrong primitive — use an attention budget (NEW, important)

The draft's "≤N proactive msgs / 7 days, plus per-category cap" does not solve
**contention**. When birthday + win-back + review + dunning are all eligible for one
customer in one week, independent caps each pass yet together they spam — and they
**do not decide which to drop.** That is a knapsack/scheduling problem, not N
independent rate limiters.

Replace with: **one per-customer attention budget per rolling window** (transactional
exempt). Eligible promotional initiations compete; the gate admits them in `priority ×
expValue` order until the budget is spent; the rest are deferred or dropped with a
logged reason. This is the deterministic core honoring "failure is explicit": a dropped
send is a recorded decision, not a silent loss.

### 4.5 Dedup must be cross-initiator and time-decayed (NEW)

`uniqueIndex(bookingId, triggerType)` is exact-match, single-initiator. For
periodic/CRM sends the key must carry a **time bucket** (`winback:{cust}:{quarter}`) and
the gate must apply **cross-initiator suppression** (don't fire a win-back the same week
a reschedule negotiation touched the customer). The real spam risk is *overlapping
initiators*, which the draft's per-trigger dedup cannot catch.

### 4.6 Blast-radius circuit breaker (NEW, safety-critical)

Mass initiators (broadcast, segment win-back, dunning sweep) have blast radius. A bad
template or buggy segment can hit hundreds before anyone notices. Reshuffle already has
`batchSize` / `maxOutreachPerCampaign` — **generalize this to a mandatory campaign-level
breaker**: per-business send ceiling/hour, and **abort the campaign if the opt-out or
error rate in the first K sends exceeds a threshold.** Without this, "failure is
explicit" (Principle 5) is violated at scale.

### 4.7 Ownership & skills boundary (unchanged, correct)

Spine = core (Developer A). Insight **detectors** may live in `src/skills/` and
`proposeInitiation(...)` through a new `src/shared/skill-types.ts` field; the core
decides and sends. Skills never import the engine.

---

## 5. Graduated autonomy — the mechanism that actually reaches zero (NEW, the core idea)

**The contradiction in the prior draft:** it mandates that *every* `ai_proposed` +
`audience:customer` send clears an **owner-confirm gate** — "no initiator may message a
customer fully autonomously." But an owner-confirm gate **is an OAU**. If win-back,
dunning, and upsell each require a tap forever, the design *rebuilds the inbox* and
attention **asymptotes at a high floor.** That is the opposite of the North Star.

**Resolution — the trust ratchet.** The owner-confirm gate is *training wheels*, not a
permanent fixture. Each `(business, initiator-category)` pair carries a track record of
owner decisions (approve / edit / reject). The owner's reject/edit is **free labeled
training data.** When, over a minimum sample, the approval (precision) rate clears a
threshold, the category **auto-promotes** `ai_proposed → owner_configured` — moving from
"confirm each send" to "fire under the gate, surface only anomalies." The owner can veto
a promotion or demote on a bad streak. A demote-on-spike rule (opt-out/complaint) is the
safety backstop.

```
ai_proposed (confirm each)  ──precision≥θ over N decisions──▶  owner_configured (autonomous-under-gate)
        ▲                                                                 │
        └───────────── opt-out/complaint spike (auto-demote) ─────────────┘
```

This is the single addition that converts a *safe* system into a *zero-attention* one.
Without it, §5 of the old draft caps the achievable OAU reduction. **Owner-only digests
stay autonomous-to-owner from day one** (no outside party touched — already allowed).

---

## 6. The attention leak is in MANAGED conversations, not fire-and-forget (NEW)

The North Star names **payments, cancellations, booking movement** — precisely the
`managed` initiators (reshuffle, coordination, dunning negotiation). Fire-and-forget is
trivial to make autonomous. The drain is: autonomous message → customer replies
off-script → state machine can't resolve → **hands back to owner.** *Every* managed
conversation has a fallback-to-owner edge, and **that edge is the OAU.**

So the metric that matters for managed initiators is **resolution autonomy**: the
fraction of negotiations that close (booked / paid / declined) **without** an owner
hand-back. Instrument the dead-letter rate per managed initiator and drive *it* down —
not the send count. Concretely: widen what the reshuffle/coordination state machines can
resolve themselves (counter-offers, partial-pay, "can we do Tuesday instead"), and only
escalate true ambiguity. This is where the bulk of remaining owner attention will live
after fire-and-forget is automated.

---

## 7. Two-tier consent (correction to single-boolean opt-out)

`messagingOptOut` is all-or-nothing today. A customer who opts out of marketing must
**still** receive booking confirmations and reminders, or the system either spams the
opted-out or silences essential transactional sends. Split consent into:

- **transactional** (confirmation, reminder, reschedule ack, payment due) — always sent.
- **promotional** (win-back, review request, birthday, promo, upsell) — per-category
  opt-out, honored by the gate.

This is also a WhatsApp-policy and consumer-law point, not just UX.

---

## 7.5 The fill cascade — the margin engine (one named loop)

Calendar fill is the margin metric (§0.1), so the moves that fill slots must be **one
first-class cascade**, not scattered catalog rows. When a slot frees (cancellation) or a
class is under-booked, a single cascade runs, each rung gated by the eligibility/value
gate:

```
slot freed / class under capacity
   └─▶ 1. WAITLIST MATCH        (exact want)   — waitlist.ts (✅)
        └─▶ 2. FREED-SLOT OFFER (near match)   — freedSlotApprovals (✅)
             └─▶ 3. COLD-FILL OUTREACH (profile match) — NEW, §7.6 profile
                  └─▶ 4. expire + log (owner sees it only as a digest, never a hand-back)
```

- The spine already exists for rungs 1–2 (`waitlist.ts`, `freedSlotApprovals`). **Rung 3
  (cold-fill) is the new growth rung** — invite profile-matched lapsed/spontaneous
  customers (e.g. "Tuesday-evening yoga regulars who've lapsed ~3 weeks") to take the
  open capacity.
- Reschedule-retention is the *defensive* half of the same engine: a move request is
  absorbed (offer alternative slots automatically) rather than cancelled, keeping the
  booking. Only genuine "can't make any of these" ambiguity escalates.
- **The whole cascade must close without involuntary OAU.** A failed fill is a *logged
  digest line*, not an owner hand-back. This is the §6 resolution-autonomy principle
  applied to the fill loop specifically.

## 7.6 Per-customer behavioral profile (the genuinely new data need)

Cold-fill targeting and waitlist matching need a per-customer profile. **Raw history
already exists** — the `bookings` table carries `customerId`, `serviceTypeId`,
`slotStart`, `state`, `paymentStatus`, `cancellationReason`, `rescheduledFrom`. What is
missing is a **queryable derived profile** and a **richer segmentation surface**:

- **Mostly derivable (aggregate over `bookings`), expose as a profile view:**
  cadence (median days between bookings), preferred service/class type, preferred
  day-of-week and time-of-day band, recency (`lastBookingAt`), no-show rate, lifetime
  bookings, lifetime spend, VIP (`identities.vip` — already exists).
- **Genuinely new, cheap-nullable fields:** birthday, explicit stated preferences/notes.
- **Extend `SegmentFilter`** (today only `serviceTypeId` / `inactiveSinceDays` /
  `hasBooking`) and **`CustomerSummary`** (today only `totalBookings` / `lastBookingAt`)
  so the orchestrator and the fill engine can express targeting like "lapsed yoga
  regulars who usually book Tue/Thu evenings." Current types cannot express this — that is
  the real gap, not "no history."

This profile is also the substrate for the **value model** (§0.3): "expected incremental
booking from inviting customer X to slot Y" is a function of cadence, recency, and
slot-fit. Build it as a read-model/aggregation (optionally materialized for performance);
it captures almost no new data, it *organizes* data that already exists.

## 7.7 Dynamic owner notification rules (the voluntary-OAU control dial)

Voluntary OAU (§0.2) is configured here, and today's surface is too rigid:
`NotificationPreferences` is six static booleans; `EscalationRule` triggers only on
keyword/unknown/emotional. Neither expresses the owner's real, *dynamic* intent ("notify
me per refund request this week, but stop telling me about every cancellation").

Needed: a small **owner notification rule model** — `when {event + optional condition}
→ {notify | notify-with-action-buttons | handle-silently}` — that the owner edits
**conversationally through the Branch-3 orchestrator** ("only tell me about cancellations
inside 24h", "stop the per-booking pings"). Rules are data, evaluated by the same gate.
Tie it to the **trust ratchet**: a rule sitting at "notify" with a long unbroken
approve-streak prompts the owner to promote it to "handle-silently." This is how
voluntary OAU shrinks *with the owner's consent*, never behind his back.

## 8. The curated trigger catalog (status corrected)

✅ exists · 🟡 partial · 🔴 new. "Tmpl?" = needs an approved Meta template out-of-window.

### 8.1 Layer A — Owner → Customer(s)
| Initiator | Autonomy | Delivery | Status |
|---|---|---|---|
| One-off free-text to a named customer | owner_commanded | fire_and_forget | ✅ `messageCustomer` |
| Broadcast to a segment | owner_commanded | fire_and_forget | 🟡 `customerSegmentQuery` exists; broadcast send new |
| Reschedule/cancel ripple | owner_commanded | managed | 🟡 reshuffle covers move; mass-cancel notify new |
| Coordinate meeting w/ external contact | owner_commanded | managed | ✅ `coordinateMeeting` |
| Broadcast announcement (hours/address/promo) | owner_commanded | fire_and_forget | 🔴 |
| Follow-up campaign (review/survey to today's customers) | owner_commanded | fire_and_forget | 🟡 review template exists; runner new |
| **Cold-fill outreach (invite profile-matched lapsed/spontaneous customers to fill a class/slot)** | owner_configured → ratchet | managed | 🔴 **flagship growth loop (§7.5/§7.6); needs profile + richer SegmentFilter** |

### 8.2 Layer B — Customer → Owner
| Initiator | Autonomy | Status |
|---|---|---|
| Ask for a human / owner | owner_configured | ✅ escalation (keyword) |
| Angry / threatens to leave | owner_configured | ✅ escalation (emotional) |
| Refund / billing dispute | owner_configured | 🟡 add escalation category |
| Hot sales lead | ai_proposed → ratchet | 🔴 detector + owner alert |
| VIP messaged / VIP returned after gap | owner_configured | 🟡 **`identities.vip` EXISTS** — wire it, no new field |
| AI unsure / unusual request | owner_configured | ✅ escalation (unknown_intent) |
| New-booking / first-time / cancel / reschedule / no-show | owner_configured | ✅ `NotificationPreferences` |
| Upsell opportunity in chat | ai_proposed → ratchet | 🔴 detector + owner alert |

### 8.3 Layer C — Event / Time / Calendar / Payment / CRM / External
| Group | Initiator | Audience | Tmpl? | Status |
|---|---|---|---|---|
| Time-before | 24h / 1h reminder | customer | yes | ✅ `reminder.ts` |
| Time-before | week-before (long treatments) | customer | yes | 🔴 |
| Time-before | subscription renewal | customer | yes | 🔴 needs subscription model |
| Time-after | post-appt thank-you | customer | yes | 🟡 post_appointment template |
| Time-after | review request (1d after) | customer | yes | 🟡 review_request template |
| Periodic | birthday/holiday | customer | yes | 🔴 needs cheap nullable birthday field |
| Periodic | "time for periodic treatment" | customer | yes | 🔴 |
| Calendar | confirmation / reschedule / cancel ack | customer | yes | ✅ flows + config |
| Calendar | no-show follow-up | customer | yes | 🟡 no_show template |
| Calendar | freed slot → waitlist | customer | yes | ✅ waitlist + `freedSlotApprovals` |
| Calendar | empty/overbooked-day alert | owner | n/a | 🟡 daily-briefing |
| **Payment** | **dunning (1st/2nd/final) on internal `pending_payment`** | customer | yes | 🟡 **buildable NOW — state exists; needs sequence + template. High value, low annoyance. Promote to early phase.** |
| Payment | payment received / large deal | owner | n/a | 🔴 needs processor webhook |
| CRM | win-back 30/60/90d inactive | customer | yes | 🔴 (`customerSegmentQuery.inactiveSinceDays` exists) |
| CRM | referral thank-you | customer | yes | 🔴 |
| CRM | crossed-spend / N-purchases → VIP | owner | n/a | 🟡 set `identities.vip` |
| External | site form / abandoned cart | owner/customer | yes | 🔴 webhook ingest |
| External | Meta lead / Shopify / Stripe-fail / Google review | owner | n/a | 🔴 integrations |
| Owner digest | "5 empty hours tomorrow", "revenue −18%", "4 likely churns" | owner | n/a | 🔴 detectors → **owner-only, autonomous from day one** |

### 8.4 Out of scope (unchanged)
2,000-trigger library; any customer-facing AI send with no owner ever in the loop *and*
no track record; employee/inventory/emergency triggers; AI making pricing/marketing
decisions (advisory only).

---

## 9. Governance = moat (extended)

Per-initiator on/off · two-tier per-category consent · **attention budget** (not naive
caps) · quiet hours · **blast-radius breaker** · **trust-ratchet thresholds (owner can
veto promotion)** · full `logAudit` trail · **OAU + resolution-autonomy dashboards** so
the owner (and we) can *see* attention trending to zero.

---

## 10. Corrected build order

1. **Spine + both metrics, no new triggers.** Eligibility Gate + Initiator registry +
   types, **plus bookings/week and involuntary-OAU instrumentation from line one** (§0).
   Migrate reminder + escalation + one reshuffle path onto it; behavior unchanged, code
   consolidated, *both* objectives now measured.
2. **Customer profile read-model + richer `SegmentFilter`/`CustomerSummary`** (§7.6).
   Cheap — mostly aggregation over existing `bookings`. Unlocks targeting for everything
   downstream; do it before any cold-fill or win-back work.
3. **The fill cascade** (§7.5): wire waitlist → freed-slot → **cold-fill outreach** into
   one loop, plus reschedule-retention. This is the bookings/week engine — highest margin
   impact. Two-tier consent ships here.
4. **High-value fire-and-forget detectable today, safest annoyance profile:** payment
   dunning on internal state (high margin, expected, low opt-out risk), no-show
   follow-up, review request, win-back 30/60/90.
5. **Owner control surface** = the dynamic notification rule engine (§7.7) + attention
   budget + quiet hours + consent + audit/OAU views + **blast-radius breaker**.
6. **AI-proposed layer + trust ratchet** (§5). Owner-only digests first (safe,
   autonomous). Customer-facing proposals and notification rules **auto-promote on
   precision**.
7. **Managed-conversation autonomy** (§6). Widen reshuffle/coordination/dunning state
   machines to resolve counter-offers without hand-back; drive the involuntary-OAU
   dead-letter rate down.
8. **External integrations** (webhooks: site forms, Meta/Shopify/Stripe/Google) last.

---

## 11. Verification (when code runs)

- **Gate truth table** — in/out window, transactional vs promotional opt-out, budget
  exhausted, quiet hours, dedup collision (incl. cross-initiator), value-gate negative →
  assert decision + audit row.
- **Contention test (NEW)** — 4 eligible promotional initiators, budget = 1 → assert the
  highest `priority × expValue` wins and the other 3 are logged-deferred, never silently
  dropped.
- **Trust-ratchet test (NEW)** — simulate N owner approvals → assert auto-promotion;
  inject opt-out spike → assert auto-demotion.
- **Blast breaker (NEW)** — feed a segment with high early opt-out → assert campaign
  aborts before the ceiling.
- **Migration parity** — existing reminder/escalation tests pass unchanged.
- **Template fallback** — out-of-window → template or explicit `skip`+log, never a
  rejected free-form send.
- **Resolution-autonomy (NEW)** — managed initiator with an off-script reply → assert it
  resolves without an owner OAU where the state machine can, and that hand-backs are
  counted.

---

## 12. Open questions (corrected)

1. ~~VIP~~ **VIP exists (`identities.vip`)** — wire it, no new field. **Birthday:** add a
   cheap nullable field. **Subscriptions:** defer (no model; bigger lift).
2. **External integrations** — park *ingest*; but build internal-state **dunning now**
   (no processor needed).
3. **Attention budget defaults** — don't pick a magic "N/7d." Implement the budget; ship
   a conservative interim default (≈1 promotional / 7d, transactional unlimited) and
   **tune from measured opt-out/OAU**, per business.
4. **Ratchet thresholds** — what precision θ and minimum sample N gate auto-promotion,
   and what spike auto-demotes? (Needs first-business data; start strict.)
5. **Profile read-model: materialized vs on-the-fly?** Start on-the-fly aggregation over
   `bookings`; materialize only if cold-fill targeting queries get slow. Which preference
   fields are derived vs explicitly captured (birthday, stated prefs)?
6. **Cold-fill annoyance ceiling.** Inviting lapsed customers to fill classes is the
   highest-volume promotional send — it most needs the attention budget + per-category
   opt-out. What's a sane default cold-fill rate per customer (e.g. ≤1 invite / 2 weeks)?
7. **Notification rule expressiveness.** How rich does the `when {event+condition}` model
   need to be for v1 — a fixed event enum with simple conditions, or free-form? (Start
   with an enum the orchestrator can edit conversationally; avoid a mini-DSL.)
