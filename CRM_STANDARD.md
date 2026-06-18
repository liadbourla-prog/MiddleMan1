# CRM_STANDARD.md — The CRM Contract

**Status:** Approved scope (owner sign-off 2026-06-18). Authority for Step-1 verification and the
Step-2 website data plug-in.
**Owner:** Developer A (`src/domain`, `src/adapters`, `src/db`, `src/routes`). Skills reach this
model only through `SkillContext` (`src/shared/skill-types.ts`) — never by importing core.
**Read alongside:** `CALENDAR_UX_DESIGN.md` (source-of-truth + Google mirror), `MULTI_AGENT_DESIGN.md`
(§1.7 apply seam), `ARCHITECTURE.md` (domain model, four branches), `CHAT_LEVEL_LAWBOOK.md` (any new
PA reply must comply), and the two studio specs in `docs/superpowers/specs/`.

This document **locks in the CRM contract**: the canonical entities, the per-channel projection rules,
and the invariants the PA must never violate. It does not re-derive the calendar architecture — that is
`CALENDAR_UX_DESIGN.md`. It sits on top of it and defines *the business CRM* (sessions, classes,
instructors, prices, rosters, attendance) as one internal model that WhatsApp, Google Calendar, and a
website all project.

---

## 0. The one rule everything else serves

> **There is exactly one source of truth: the internal database.** WhatsApp, Google Calendar, and the
> website are *projections* of it. No channel holds data the internal model does not. No channel writes
> state except through the deterministic apply seam (§5). A projection may be stale; it may never be
> authoritative.

This is the operational restatement of CALENDAR_UX_DESIGN.md §2 ("internal-as-hub"), extended from the
calendar to the whole CRM. The website is **not** a new data store — it is a third projection, kept in
sync by the exact same write-through / inbound-reconcile pattern already used for the Google mirror.

---

## 1. Canonical entities

Tables that already exist are marked **[live]**; Tier-A additions in this round are marked **[A]**;
Tier-B seams defined here but not built this round are marked **[B-seam]**.

### 1.1 Business & people
- **`businesses`** [live] — tenant root: timezone, currency, booking policy, calendar mode
  (`google` | `internal`), Google linkage.
- **`identities`** [live] — one row per phone per business; `role ∈ {manager, delegated_user,
  customer, provider}`. **Instructors are `role='provider'` identities** (name-only allowed via a
  synthetic placeholder phone + `messagingOptOut=true`, per the instructor-management spec).
- **`provider_assignments`** [live] — instructor ↔ service-type ("who *can* teach what"). Toggled
  `isActive`, never hard-deleted.
- **`customer_profiles`** [live] — booking-derived facts per customer (totalBookings, lastBookingAt,
  preferredServiceTypeId, notes). **`tags` is a future field** [B-seam] — segmentation today is the
  derived `customerSegmentQuery` (service / recency / has-booking).

### 1.2 What is offered
- **`service_types`** [live] — the catalog entry. `max_participants` is the **type discriminator**:
  - `max_participants = 1` ⇒ this service is delivered as a **1-on-1 SESSION**.
  - `max_participants > 1` ⇒ this service is delivered as a **CLASS** (group).
  - Carries the **base price**: `requiresPayment` + `paymentAmount` (per the business `currency`).
- **`service_price_tiers`** [A] — **new.** Zero or more named price tiers per service type
  (`tier ∈ {drop_in, member, ...}`, `amount`, `currency`). This is the *seam* for membership pricing:
  a `member` tier can exist now (drop-in vs member rate) even though membership *eligibility* (who is a
  member) is not built this round. Absent tiers ⇒ the service base price applies.

### 1.3 When things happen (the schedule)
The schedule sits **above** the canonical availability spine (CALENDAR_UX_DESIGN.md §5). Three shapes:

- **1-on-1 session occurrence** — has **no instance row.** It exists only as a `bookings` row against a
  `max_participants=1` service. The "slot" is the booking's `slotStart`/`slotEnd`.
- **Class instance** — **`calendar_blocks` with `type='class'`** [live]: a concrete dated occurrence of a
  group service, carrying `serviceTypeId`, `maxParticipants` (capacity for **that instance**),
  `providerId` (the instructor teaching it), `startTs`/`endTs`. Customers book **into** this instance.
- **Recurring class definition** — **`class_series`** [live]: a weekly template (`dayOfWeek`, `startTime`,
  `durationMinutes`, `maxParticipants`, `providerId`, `startDate`/`endDate`, `timezone`). A materializer
  expands it into `calendar_blocks(type='class', seriesId=…)` occurrences; **`class_series_exceptions`**
  [live] are EXDATE-style cancellations the materializer must never re-create.
- **`calendar_blocks` with `type ∈ {block, personal}`** [live] — owner-occupied time / opaque busy blocks
  (incl. Google-imported `source='google_import'`). Not bookable, never a class.

### 1.4 Who booked, and what happened
- **`bookings`** [live] — one row per participant per occurrence. For a class booking, `providerId` is
  **inherited from the class instance** (studio spec D1); `serviceTypeId` + `slotStart` identify the
  occurrence. State machine: `inquiry → requested → held → pending_payment → confirmed → cancelled |
  expired | failed`.
  - **[A] Attendance terminal states.** Extend the lifecycle with post-occurrence outcomes:
    `attended` and `no_show`, settable only **from `confirmed`** and only **after `slotEnd`**. These are
    the CRM's record of what actually happened; they are *not* projected to Google (the event already
    occurred) and feed later analytics / instructor pay.
- **`waitlist`** [live] — pending/offered/accepted/expired interest in a full slot. Built; cited here for
  completeness.

### 1.5 Tier-B entities (defined, not built this round)
- **`memberships` / `membership_credits`** [B-seam] — a membership grants a customer eligibility for the
  `member` price tier (§1.2) and, later, class-credits/punch-cards that a class booking decrements.
  Defined so the price chain (§4) and roster reads don't need a breaking migration when built.
- **`invoices` / `deposits`** [B-seam] — today payment is a status on the booking
  (`paymentStatus ∈ {not_required, pending, paid, failed}`) plus `confirmationGate=post_payment` and the
  business `cancellationFee`. Full invoicing/deposits are later.
- **`service_policies`** [B-seam] — per-service cancellation/late-cancel windows; today policy is
  business-level (`cancellationCutoffMinutes`, `cancellationFeeAmount`).

---

## 2. Relationships (the shape that must stay coherent)

```
businesses 1─* service_types ─1─* service_price_tiers        [A]
service_types ──(max_participants) determines──> SESSION (1) | CLASS (>1)
service_types 1─* class_series ─(materialize)─* calendar_blocks(type='class')
identities(role=provider) *─* service_types  (via provider_assignments)
calendar_blocks(type='class').providerId ──> identities(role=provider)
bookings.serviceTypeId ──> service_types
bookings.providerId  ──(class: inherited from instance)──> identities(role=provider)
bookings (confirmed, for a class instance) ── form the ROSTER of that instance
bookings.state ∈ {…confirmed} ──(after slotEnd)──> {attended, no_show}   [A]
```

**Canonical reads (the contract surface Step-2 builds on):**
- `loadSessionRoster(businessId, occurrence)` **[A, new]** — given a class instance (by `seriesId`+date
  or block id) **or** a 1-on-1 slot, return `{ instance: {service, instructor, start, end, capacity},
  participants: [{customerId, displayName, state, paymentStatus, attendance}] , spotsLeft }`. The single
  authoritative "who booked this session" read. No projection computes this independently.
- `loadInstructorRoster` / `loadTeachingSchedule` **[live, `src/domain/provider/roster.ts`]** — "who can
  teach what" and the live "who teaches what, when" instructor weekly view. Formalized here as the
  canonical instructor-schedule read; Step-2's instructor page projects this.
- `getOpenSlots` / `isSlotBookable` **[live, `src/domain/availability/`]** — the only availability
  computation. Every channel (booking engine, Branch 3/4, website) calls it; none re-derives it.

---

## 3. The hard invariants (the PA must never violate these)

1. **1-on-1 ≠ class — never conflated.** Type is decided by `service_types.max_participants` and nothing
   else. A 1-on-1 service is never materialized into a `calendar_blocks(type='class')`; a class is never
   booked as a 1-on-1. Reads, replies, and the website must label each correctly.
2. **Capacity is enforced per INSTANCE, atomically.** A class's capacity is `calendar_blocks.maxParticipants`
   for *that occurrence* (or the series default), never the service type's. Enforcement is the existing
   `requestGroupClassBooking` `SELECT … FOR UPDATE` count — every booking path (incl. the website) goes
   through it. No projection may admit a booking that exceeds instance capacity.
3. **A class booking attributes the class's instructor.** `bookings.providerId` for a class is **inherited
   from `calendar_blocks.providerId`** of the instance booked (studio spec D1), not re-resolved. "Book yoga
   with Dana" and "book the Monday-10:00 yoga" must attribute the same instructor row.
4. **Price-resolution order is fixed** (§4). Every channel resolves price the same way, in the same order.
5. **One source of truth.** No projection writes authoritative state. Every state change passes the §5 seam:
   identity → policy/authorization → scheduling logic → calendar validation → safe write. No step skipped.
6. **Attendance only after the fact.** `attended`/`no_show` are reachable only from `confirmed` and only
   after `slotEnd`; they never resurrect a `cancelled`/`expired` booking and are never written by an
   inbound Google sync.
7. **Failure is explicit.** A failed write is never reported as success; partial writes roll back or flag
   (CLAUDE.md Principle 5). Applies to every projection, including the website API.

---

## 4. Price resolution (fixed order)

For any bookable occurrence, resolve the price by walking this chain and stopping at the first hit:

1. **Customer eligibility tier** — if the customer is eligible for a tier (today: only via an explicit
   `member` flag once memberships exist [B]; until then this step is inert) **and** the service has a
   matching `service_price_tiers` row ⇒ that tier's amount.
2. **Instance/series override** — a price set on the specific class instance or series, if present
   [A, optional column; honored if set].
3. **Service base price** — `service_types.paymentAmount` (with `requiresPayment`) in the business
   `currency`. **[live]**
4. **None** — `requiresPayment=false` and no amount ⇒ "price on request" / free, phrased per
   `CHAT_LEVEL_LAWBOOK.md`.

The website price column and the WhatsApp price phrasing **must both call this one resolver** — never read
`paymentAmount` directly. This closes gap #3 from the mission (price was per-service-type only).

---

## 5. The write seam (every channel, no exceptions)

All authoritative writes flow through the **§1.7 apply seam** (`MULTI_AGENT_DESIGN.md`):

- **Configuration / scheduling / policy / staff writes** (services, prices, hours, classes, instructors,
  permissions) → `manageBusinessSettings` → `classifyManagerInstruction → applyManagerInstruction`
  (deterministic, idempotent). This is **Level 3**.
- **Bookings** → the booking engine (`requestBooking` / `requestGroupClassBooking` / `confirmBooking` /
  `cancelBooking`), which itself enforces identity → policy → availability (`isSlotBookable`) → calendar
  validation → safe write, then enqueues the outbound mirror.
- **Soft metadata** (customer notes, contact notes) → Level 1 direct writes, manager-identity-checked.

**The website plug-in (Step 2) introduces no new write path.** A website booking calls the *same*
`requestBooking`/`requestGroupClassBooking`; a website-originated config change (if ever allowed) calls the
*same* apply seam. The plug-in is an authenticated transport in front of existing seams, nothing more.

---

## 6. Per-channel projection rules

All three channels derive from the internal model. Each is defined by **what it shows (read)** and **how it
writes back (if at all)**.

### 6.1 WhatsApp (interface, never source of truth)
- **Read:** Branch 3 (manager) and Branch 4 (customer) render the model via the orchestrator/flows. Reads
  use the canonical reads in §2 — roster, instructor schedule, open slots, price resolver. Replies comply
  with `CHAT_LEVEL_LAWBOOK.md`.
- **Write:** only through §5. WhatsApp holds no state of its own.

### 6.2 Google Calendar (bidirectional mirror, when connected)
Unchanged from CALENDAR_UX_DESIGN.md — restated as the **pattern the website reuses**:
- **Outbound write-through:** confirmed bookings + blocks + class instances mirror to Google via a durable
  queue; linkage in extended private properties; loop prevention by etag compare. **Holds are never
  mirrored.** Attendance states (§1.4) are **not** mirrored (the event already happened).
- **Inbound reconcile:** owner edits in Google arrive via watch-channel push, are reconciled into the
  internal record as inputs (owner-wins with a blast-radius gate + Branch-3 confirmation), with periodic
  **full reconcile** as the real guarantee. Owner-created events ⇒ opaque `source='google_import'` blocks.

### 6.3 Website (new projection — ✅ IMPLEMENTED 2026-06-18, same pattern)
**Built as the `/api/v1/*` JSON API** (`src/routes/public-api/`, plan
`docs/superpowers/plans/2026-06-18-website-data-plugin.md`): two-key auth (`business_api_keys`, migration
`0020`) — publishable keys for public reads, secret keys for roster names + booking writes; per-key rate
limiting; Redis idempotency on writes. Reads call the canonical functions; `POST /api/v1/bookings` calls
`requestBooking` (find-or-create the phone-keyed identity first). No new data path.
- **Read (live):** an authenticated read API exposes exactly the canonical reads — current schedule
  (classes + open 1-on-1 slots via `getOpenSlots`), instructors (`loadInstructorRoster`/
  `loadTeachingSchedule`), prices (via the §4 resolver), per-instance availability/spots-left, and a class
  roster summary where authorized (`loadSessionRoster`). **The website never queries tables directly** and
  never caches authoritative state; it reads the projection live (with short TTL caching allowed, clearly
  non-authoritative).
- **Write (booking) — same seam:** a website booking call goes through `requestBooking` /
  `requestGroupClassBooking` exactly as WhatsApp does, including capacity (`FOR UPDATE`), availability,
  policy, and the outbound Google mirror. A website-created confirmed booking therefore appears in WhatsApp
  reads and the Google mirror with **no extra reconciliation** — they are the same rows.
- **Coherence guarantee:** because the website shares the read functions and the write seam, the three
  channels are coherent **by construction**, not by sync. There is no website-specific copy to drift.
- **Any website (ours or the customer's existing site):** the API is embeddable and auth'd per business, so
  a site we did not build consumes the same projection. It is a client of the hub, not a second hub.

---

## 7. Scope locked this round (owner sign-off 2026-06-18)

**Tier A — ✅ BUILT (2026-06-18, plan `docs/superpowers/plans/2026-06-18-crm-tier-a.md`):**
1. ✅ Per-instance / tiered pricing + the §4 price resolver (`src/domain/pricing/resolver.ts`,
   `service_price_tiers` table via migration `0019`). The skills knowledge layer now resolves price through
   it — no channel reads `payment_amount` directly (§8.2). A `member` tier resolves; eligibility is inert
   until memberships exist (Tier-B).
2. ✅ `loadSessionRoster` (`src/domain/booking/roster.ts`) — the canonical "who booked this session" read
   (class instance **and** 1-on-1).
3. ✅ Attendance: `attended` / `no_show` terminal states + guarded `markAttendance`
   (`src/domain/booking/attendance.ts`) — only from `confirmed`, only after `slotEnd`; audited; not mirrored
   to Google. No migration (text column, no DB check constraint).
4. ✅ Instructor weekly-schedule read — already live (`src/domain/provider/roster.ts`:
   `loadTeachingSchedule` / `loadInstructorRoster`); locked here as the canonical instructor view.
5. ✅ Per-instance capacity — enforced from the class block's `maxParticipants` via the advisory-locked gate
   (Step-1 fix, commit `a7e549e`); roster management is read #2 + invariant 2.

**Tier-A follow-ups (deliberately deferred):**
- A Branch-3 orchestrator tool to *set* attendance conversationally ("mark the 10:00 — everyone showed
  except Yossi") — needs a `test:quality` pass, deferred with the paid-LLM work.
- The instance/series `price_override` **column** referenced by §4 step 2 — the resolver already honors an
  `instanceOverride` param, but no column is wired yet; add when a UI needs per-instance overrides.

**Tier B — seam defined here, engine built later:** memberships/credits/punch-cards, full
payments/invoicing/deposits, per-service cancellation policies, customer tags.

**Tier C — deferred (derive from A+B):** instructor pay/commission, reporting/analytics
(occupancy/revenue/retention).

**Already shipped, cited not rebuilt:** customer profiles + booking history, waitlist, recurring/one-off
class scheduling (`scheduleRecurringClasses` / `scheduleGroupSession` / `editClassSession`), the Google
mirror, the §1.7 apply seam.

---

## 8. Cross-cutting guarantees (binding on every change to this matter)

These two guarantees bind **all** future work touching the CRM model, on every channel.

### 8.1 Voice & chat law compliance (non-negotiable)
Every PA-emitted string introduced or modified by CRM work — price phrasing, roster answers, attendance
prompts ("did everyone show up?"), capacity-full refusals, and **any website-triggered confirmation that
routes back through WhatsApp** — MUST comply with `CHAT_LEVEL_LAWBOOK.md` and the per-branch stance
(Branch 4 stays reactive about instructors; transactional replies get sanitized situation strings, never
raw engine codes). No new reply ships without a `test:quality` judgment against the lawbook. The website
API returns **structured data, not prose** — it never hand-rolls customer-facing wording; any wording it
needs comes from the same lawbook-governed phrasers.

### 8.2 Anti-staleness — the system must not drift from itself
"It's written down" is not a guarantee; a *mechanism* is. The model stays coherent because we **derive,
never snapshot**, and because **drift is caught, not hoped against**:

1. **Derive, don't freeze.** Schedule, roster, instructor-teaches-what, prices, and availability are
   always computed live from the canonical reads (§2) and the price resolver (§4) — never stored as a
   typed-once paragraph or a cached copy treated as truth. (This is the instructor-FAQ lesson from the
   studio spec: a frozen paragraph goes stale the moment the schedule changes; a derived read cannot.)
2. **One reader, one writer per fact.** Each fact has exactly one canonical read and one write seam (§5).
   No channel re-implements availability, capacity, roster, or price. A `member` price must come from the
   §4 resolver; reading `service_types.paymentAmount` directly anywhere outside the resolver is a defect.
3. **Enforce the single-path rule in CI, not by convention.** A lint/guard test asserts no code outside the
   resolver reads `paymentAmount`, no booking path bypasses `requestGroupClassBooking`'s `FOR UPDATE`
   capacity check, and skills never import core (existing ESLint boundary). Convention rots; a failing
   build does not.
4. **Reconcile is the guarantee, push is the optimization.** For the Google mirror, the periodic full
   reconcile is what makes "always updated" true (CALENDAR_UX_DESIGN.md §7). The website needs no reconcile
   because it reads the projection **live** and writes through the same seam — it has no copy to drift.
5. **Verification asserts reply == rows.** Every CRM scenario test (Step 1 and forever after) asserts the
   PA's claim matches the actual rows. A green "said-done" with no row is a failing test, by definition.
6. **The doc tracks the code.** Any schema/flow change to this matter updates CRM_STANDARD.md in the same
   PR; CODEOWNERS routes it for review. A change that silently diverges from this document is incomplete.

## 9. How Step-1 verification uses this document

Step 1 proves the PA manages the five end-to-end with **no said-done-but-didn't**: drive each scenario from
WhatsApp, then inspect the live rows and assert the reply matches the data, against the invariants in §3 and
the entity contract in §1–2. A reply that claims a class was scheduled with Dana must produce a
`calendar_blocks(type='class', providerId=Dana)` row; a booking into it must carry that `providerId`; a
capacity-full instance must refuse the next booking; a stated price must equal the §4 resolver output.
Only once §3's invariants hold end-to-end does Step 2 (the website projection) begin — coherence before
exposure.
