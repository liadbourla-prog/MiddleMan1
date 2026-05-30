# Calendar UX Design — Local & Google, Unified

**Status:** Approved design, implementation in progress.
**Owner:** Developer A (touches `src/domain`, `src/adapters`, `src/db` — not `src/skills`).
**Read alongside:** ARCHITECTURE.md (domain model, branches), MULTI_AGENT_DESIGN.md (Branch 3 orchestrator), CHAT_LEVEL_LAWBOOK.md (formatting).

---

## 1. Goal

Bring the **local (internal) calendar** to the highest possible level so that a business using no Google Calendar has a fully capable scheduling experience, and make the Google Calendar option a **faithful bidirectional mirror** rather than a separate, more-powerful engine.

The difference between the two options is **UI only**. Every scheduling action — weekly schedule, blocks, personal events, bookings, cancellations, group sessions — is a first-class internal capability available regardless of Google. Google, when connected, is a window onto that internal truth, kept in sync both ways.

---

## 2. The model (locked)

- **Internal DB is the single system of record** for all scheduling primitives, for every business, always.
- **Branch 3 (PA Manager Channel) is the universal control surface.** Every primitive must be invokable *and* readable back conversationally there. Identical whether or not Google is connected.
- **Google Calendar is a bidirectional mirror** when connected:
  - **Outbound:** the PA write-throughs every relevant state change into Google so the owner always sees a faithful reflection.
  - **Inbound:** when the owner edits Google directly, Google pings the PA so the internal record updates.
- **Internal-as-hub.** Owner edits in Google are *inputs to* the internal record, not a competing source of truth.

### Source-of-truth principle (rewrite required)

CLAUDE.md Principle 3 currently reads *"Google Calendar > internal system > WhatsApp."* This is **inverted** by this design:

> **Internal system is the operational source of truth.** Google Calendar is a bidirectional mirror; owner-originated edits in Google are ingested as input events and reconciled into the internal record. WhatsApp remains an interface, never a source of truth.

This doc is the authority for that change; CLAUDE.md and ARCHITECTURE.md are updated in Phase 1.

---

## 3. Locked decisions ledger

1. Internal DB = system of record for all scheduling primitives, every business.
2. Branch 3 = universal control surface; invoke **and** read back every primitive.
3. Google = bidirectional mirror when connected (outbound write-through + inbound push).
4. Source-of-truth Principle 3 inverted (internal authoritative; Google edits are inputs).
5. Sync guarantee = **eventually-consistent + periodic full reconcile**. Push is an optimization; reconcile is the real guarantee.
6. **Write-time freebusy guard:** in connected mode the PA checks Google before approving *any* meeting.
7. **Owner edits win**, with a **blast-radius gate** + a Branch 3 confirmation conversation (e.g. "I knew the class at 11, saw you moved it to 12 — confirm, and should I notify customers?").
8. **Mirror confirmed bookings only** — never holds.
9. **Loop prevention via etag/sequence tracking**, not provenance tags alone; linkage stored in **extended private properties**, not the event description.
10. **Owner-created Google events = opaque busy-blocks** (never auto-interpreted as services/classes); their titles never leak to customers.
11. **Guidance:** advise clients to drive changes through Branch 3 rather than editing Google directly, and to connect a **dedicated** (not personal) calendar.

---

## 4. Root problem this design fixes

"Time gets occupied" is currently split across three models that do not share one truth:

1. **`availability` table** — weekly hours + **whole-day** blocks, via `manageBusinessSettings` → `applyInstruction`. Blocks force `openTime/closeTime = null` (`src/domain/manager/apply.ts:236-257`), so **intra-day blocks cannot exist today**.
2. **`createCalendarEvent` personal events** (`src/adapters/llm/orchestrator.ts:60`) → written straight to the calendar client → **no-op in internal mode** (data silently lost); in Google mode they "block" only via freebusy. They never touch the availability model.
3. **`bookings`** — customer bookings.

Consequences:
- An internal-mode manager who blocks "2–4pm Tuesday" gets a success reply and **nothing is stored**; customers can still book.
- **Group sessions cannot be scheduled proactively** — a class only materializes when the first customer books; there is no Branch 3 tool to place a class on the calendar.
- Availability is checked differently per mode: Google = live `freebusy`; internal = `bookings` only. Working hours/blocks are enforced at slot level **only** when providers are assigned (`src/domain/provider/resolver.ts`), so solo businesses get no hours enforcement at all.

The fix: collapse all three into **one canonical availability spine** plus a dedicated store for time-ranged blocks.

---

## 5. Architecture

### 5.1 New table: `calendar_blocks`

Single home for intra-day blocks, personal events, and proactively-scheduled group sessions.

| Column | Notes |
|---|---|
| `id` uuid pk | |
| `businessId` uuid fk | |
| `startTs` timestamptz | absolute start |
| `endTs` timestamptz | absolute end |
| `type` enum | `block` \| `personal` \| `class` |
| `title` text | label (e.g. "Dentist", "Vinyasa Flow") |
| `reason` text null | optional |
| `serviceTypeId` uuid null | for `class` type → links to the group service |
| `maxParticipants` int null | for `class` type |
| `providerId` uuid null | optional owner/staff scoping |
| `googleEventId` text null | mirror linkage (Google mode) |
| `googleEtag` text null | last-written etag for loop prevention |
| `source` enum | `internal` \| `google_import` (provenance) |
| `createdAt` / `updatedAt` | |

Recurrence is **out of scope for v1** (single instances only); recurring classes/blocks are a later enhancement.

### 5.2 Canonical availability service — `src/domain/availability/`

Exposes:
- `isSlotBookable(businessId, slot, opts)` → composes: working hours (`availability`) − blocks (`calendar_blocks`) − conflicting bookings − (Google mode) **live freebusy write-time guard**.
- `getOpenSlots(businessId, range, serviceDurationMinutes, opts)` → enumerates bookable gaps for proactive suggestion.

**Every branch calls this**: booking engine, Branch 3 read-back, Branch 4 customer flow. No other code computes availability independently.

Timezone correctness is owned here (fixes the server-local-time bug at `src/domain/provider/resolver.ts:104-106`).

---

## 6. Phased plan

### Phase 0 — Foundation (the spine)
- `calendar_blocks` table + migration.
- `src/domain/availability/` service with `isSlotBookable` + `getOpenSlots` (internal composition first; freebusy guard wired in Phase 2).
- Timezone fix centralized in the service.

### Phase 1 — Internal to full parity + proactive slots
- Booking engine consults the availability service for **both** modes, independent of provider assignment (`src/domain/booking/engine.ts` currently checks timing only).
- Unify personal events/blocks: `createCalendarEvent` and `manageBusinessSettings` blocks both write to `calendar_blocks` (eliminate internal-mode data loss).
- Intra-day blocks supported end to end.
- **Proactive slot suggestion**: real `getOpenSlots`, wired into Branch 4 and Branch 3 `check_free_slots`.
- **Group-session scheduling** as a Branch 3 primitive (place a class instance on the calendar).
- Branch 3 read-back completeness for schedule/blocks/classes/cancellations.
- Rewrite CLAUDE.md Principle 3 + ARCHITECTURE.

*Phase 1 delivers the highest-level local calendar UX with zero Google dependency.*

### Phase 2 — Outbound mirror
- Durable outbound sync queue (worker) mirroring **confirmed bookings + blocks only** into Google.
- etag/sequence tracking + **extended private properties** for linkage (replace owner-editable description JSON at `src/adapters/calendar/client.ts:217`).
- Idempotency keys + divergence alert to the manager when the mirror falls behind.
- **Write-time freebusy guard** enforced at booking approval.

### Phase 3 — Inbound sync
- Google **watch channels** + new webhook route + incremental sync (syncToken) with **full-reconcile fallback** (the real guarantee).
- Channel-renewal cron (new stateful per-business layer).
- Loop prevention via etag compare (incoming == last-written ⇒ echo, ignore).
- **Blast-radius gate** + Branch 3 owner-wins reconcile conversation.
- Owner-created Google events ingested as opaque busy-blocks (`source = google_import`).
- **Ops prerequisite:** Google domain verification + public HTTPS callback (provision early).

---

## 7. Failure modes & mitigations (worked through during design)

| Risk | Mitigation |
|---|---|
| "Always updated" is unachievable — channels expire, notifications drop, sync tokens expire | Periodic **full reconcile** is the guarantee; push is an optimization. |
| Lag window: customer books a slot the owner just blocked in Google before ingest | **Write-time freebusy guard** in connected mode (decision 6). |
| Owner-wins fires mass customer cancellations from one gesture (e.g. vacation over a full week) | **Blast-radius gate**: if >1–2 bookings affected, summarize and ask before acting. |
| Loop / echo (PA write triggers push that looks like an owner edit) | **etag compare**, not tags alone (decision 9). |
| Outbound mirror diverges on Google outage/quota | Durable queue + retries + idempotency + divergence alert. |
| Metadata fragility (owner edits description holding bookingId) | **Extended private properties** for linkage. |
| Hold churn flickering in owner's calendar | **Mirror confirmed only**, never holds (decision 8). |
| Personal-calendar leak | Treat owner events as opaque blocks; never surface titles; recommend dedicated calendar. |
| Recurring events / free-form owner entries unmappable | v1: single instances only; owner events ingested as opaque blocks. |

---

## 8. Out of scope (v1)
- Recurrence for blocks/classes (single instances only).
- Rendering working hours into Google (hours stay internal-only by decision).
- Auto-interpreting owner-created Google events as services/classes.
