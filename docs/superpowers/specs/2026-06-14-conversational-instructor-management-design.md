# Conversational Instructor Management (Branch 3) — Design

**Date:** 2026-06-14
**Branch:** 3 (PA Manager Channel — orchestrator)
**Owner domain:** Developer A (`src/domain`, `src/adapters/llm`, `src/routes`; NOT `src/skills`)
**Status:** Approved design → ready for implementation plan

---

## 1. Goal & boundaries

The business owner manages their teaching team by chatting with the PA — e.g.
*"Add Dana as a yoga instructor, she works Mon/Wed 9–13."* This creates an instructor,
assigns them to one or more services, and sets their weekly hours, so the **already-built**
booking engine can resolve *"book yoga with Dana"*, respect her hours, and prevent
double-booking.

Per-instructor scheduling is confirmed **in scope** for launch (yoga studio סטודיוגה).

### What is already built (do NOT rebuild)
The read/resolve/enforce side is complete and wired:
- `src/domain/provider/resolver.ts` — `resolveProvider()` reads `provider_assignments`,
  matches by `displayName`/phone hint, checks per-instructor availability via
  `isProviderAvailable()`, and rejects conflicting bookings.
- `src/domain/booking/engine.ts` — honors an explicit `providerId` or resolves via hint;
  persists `providerId` on individual **and** group-class bookings.
- `src/domain/flows/customer-booking.ts` — threads `providerHint` from customer intent
  through to the engine.

### The gap this design closes
**No flow writes `provider_assignments` or per-provider `availability`.** There is no
conversational, onboarding, or script path to create an instructor. The engine would
handle instructors correctly — it simply never receives the data.

### Hard boundaries
- **Do not touch the availability compute seam** (`src/domain/availability/compute.ts`).
  Per CLAUDE.md / the bulletproofing plan, that seam is canonical. Per-instructor hours
  are enforced at **resolution time only** (resolve-time gating), not inside compute.
- **Writes go through the §1.7 apply seam** (`MULTI_AGENT_DESIGN.md`). No direct tool
  writes; all mutations flow through `manageBusinessSettings` → classifier → deterministic
  `applyManagerInstruction`.
- **No onboarding changes** — instructor setup is orchestrator-only for launch.
- **No skills-boundary impact** — all work is Developer A domain.

---

## 2. Data model

No new tables. No migration. Everything reuses existing schema.

- **`identities.role`** gains the value `'provider'`. This is a Drizzle `text('role', {enum})`
  column — TypeScript-level only, with **no DB check constraint** (verified), so adding the
  value is a pure code change. (Implementation step must re-verify no check constraint exists
  before relying on this.)
- **Name-only instructors (default).** When the owner gives no phone number:
  - synthesize a unique, non-null placeholder phone (e.g. `provider:<uuid>@local`) to satisfy
    the `identities` NOT-NULL constraint and the `(businessId, phoneNumber)` unique index;
  - set `messagingOptOut = true` (instructor receives no WhatsApp notifications);
  - resolution works because `resolveProvider` matches on `displayName`.
  - The owner can attach a real phone number later (future; not required for launch).
- **Assignments:** `provider_assignments` rows, idempotent on the existing
  `(identityId, serviceTypeId)` unique index; toggled active/inactive rather than deleted.
- **Per-instructor hours:** `availability` rows with `providerId` set (column already exists),
  `dayOfWeek` + `openTime`/`closeTime`. Business-level hours remain the rows with
  `providerId IS NULL`; the two never mix in compute (compute reads business-level only).

---

## 3. Write path — the `provider_change` instruction

Obeys the §1.7 apply seam. A standalone `manageInstructors` tool that writes directly is
**rejected** — it would bypass the deterministic apply pipeline.

### 3.1 Classifier (`src/adapters/llm/client.ts`)
- Add `'provider_change'` to the `managerInstructionSchema` `instructionType` enum.
- Add a prompt section describing instructor operations and the `structuredParams` shape:
  ```
  action: 'add' | 'set_hours' | 'assign_service' | 'unassign_service' | 'remove'
  instructorName: string            // display name, e.g. "Dana"
  phone?: string | null             // optional; name-only if absent
  serviceNames?: string[]           // services to assign/unassign (by name)
  weeklyHours?: { dayOfWeek: 0-6, startTime: 'HH:MM', endTime: 'HH:MM' }[]
  ```
- Routing intent: "Add Dana as a yoga instructor", "Dana also teaches pilates",
  "change Dana's hours", "remove Dana" → `provider_change`.

### 3.2 Apply handler (`src/domain/manager/apply.ts`)
Add `case 'provider_change': result = await applyProviderChange(...)` to the switch, plus a
`providerChangeSchema` (zod) and the handler. Behavior by `action`:

| action | behavior |
|---|---|
| `add` | find-or-create `provider` identity by name within the business; insert `provider_assignments` for each named service (idempotent); insert weekly `availability` rows for `weeklyHours`. One-shot create + assign + hours. |
| `set_hours` | locate provider by name; replace that provider's weekly `availability` rows (delete existing `providerId` weekly rows, insert new). |
| `assign_service` / `unassign_service` | set `provider_assignments.isActive` true/false for the named service(s); create the row if assigning and none exists. |
| `remove` | set all of the provider's `provider_assignments.isActive = false`. Soft — existing bookings retain their `providerId`. Identity row is kept (optionally `revokedAt` set; default keep). |

Rules:
- Service names resolve to IDs against `service_types`; an **unknown service → clarify**
  (do not auto-create the service).
- **Name collision** (two instructors match the name) → clarify which one.
- Deterministic and idempotent (re-running "add Dana" does not duplicate).
- Returns a structured outcome (no pre-phrased customer string) per the structured-results
  convention; the orchestrator phrases the confirmation.

### 3.3 Authorization (`src/domain/authorization/check.ts`)
- Add a `staff.manage` action. `provider_change` requires it.
- Managers: unrestricted (existing behavior). `delegated_user`: denied unless `staff.manage`
  was granted (extends the 1C persisted-permission model). Customers/providers: denied.

---

## 4. Read-back — context injection (no new tool)

- New `src/domain/provider/roster.ts` → `loadInstructorRoster(db, businessId)` returns
  `{ name, services: string[], weeklyHours: {dayOfWeek, startTime, endTime}[] }[]`.
- Injected into the manager orchestrator's system prompt each turn, mirroring how
  `businessKnowledge` is already loaded in `src/routes/webhook.ts` and passed to
  `runManagerOrchestratorLoop`. The PA answers "who teaches yoga?" / "what are Dana's hours?"
  naturally with zero extra round-trips, and the roster sharpens its handling of edits.
- `src/adapters/llm/orchestrator.ts`: update the `manageBusinessSettings` tool description and
  the routing notes so instructor instructions route there.

---

## 5. Customer-facing alignment — strictly reactive

Replace the contradicting stance at `src/domain/flows/customer-booking.ts:524`
("We do not track individual staff members' personal schedules…").

**Governing principle: the PA is strictly reactive about instructors.** It never *initiates*
instructor-specific conversation with a customer:
- No "would you like a specific instructor?" prompts.
- No advertising or listing the roster to customers unprompted.
- No unsolicited mention of who teaches what.

The default customer booking flow stays **instructor-agnostic**: when the customer does not
name an instructor, the resolver silently auto-picks any available instructor — the customer
experience is unchanged.

Instructor specifics are engaged **only when the customer raises them first**:
- *"book yoga with Dana"* → the engine resolves Dana (by hint).
- If Dana is not free for the chosen slot, the transactional layer surfaces her teaching
  times reactively: *"Dana teaches Mon/Wed 9–13 — want one of those, or another instructor?"*
  This is permitted because the customer already named Dana.
- *"who teaches yoga?"* asked directly by the customer → answered plainly (no roster dump
  beyond what was asked).

Implementation note: the named-instructor-unavailable path must thread the instructor's hours
into the transactional phrasing (currently the engine returns a generic failure). This is the
only customer-side phrasing change.

---

## 6. Testing

- **Unit** (`vitest run`): `applyProviderChange` for all five actions; synthetic-phone
  creation for name-only; assignment idempotency; `set_hours` replace semantics;
  unknown-service and name-collision clarify; `staff.manage` authorization (manager allowed,
  ungranted delegated_user denied).
- **Integration (C-D / C-F)** (`test:integration`): classify→apply "add Dana" with hours;
  then book "yoga with Dana" and assert (a) per-instructor hours enforced (slot outside her
  hours is refused with the graceful fallback), (b) one instructor cannot be double-booked
  across two services at the same slot, (c) `remove` makes her no longer resolvable, (d)
  instructor-agnostic booking still auto-resolves.
- **Quality** (`test:quality`): add-instructor confirmation phrasing; the reactive
  "Dana isn't free then" fallback; verify the PA does **not** volunteer instructor info
  unprompted — all judged against `CHAT_LEVEL_LAWBOOK.md`.

---

## 7. Known limitation (flagged, not solved now)

A `provider` who has a **real** phone and messages the PA routes to the **customer** flow
(`routeManagerMessage` matches only `manager`/`delegated_user`; `provider` falls through to
`routeCustomerMessage`). Acceptable for launch — instructors are not expected to operate the
PA. Noted for a future pass.

---

## 8. Files touched

| File | Change |
|---|---|
| `src/db/schema.ts` | add `'provider'` to `identities.role` enum (TS only) |
| `src/adapters/llm/client.ts` | add `provider_change` to classifier enum + prompt |
| `src/domain/manager/apply.ts` | `providerChangeSchema` + `applyProviderChange` + switch case |
| `src/domain/authorization/check.ts` | new `staff.manage` action + mapping |
| `src/domain/provider/roster.ts` | **new** — `loadInstructorRoster` |
| `src/adapters/llm/orchestrator.ts` | tool description + routing notes + roster injection |
| `src/routes/webhook.ts` | load roster, pass into `runManagerOrchestratorLoop` |
| `src/domain/flows/customer-booking.ts` | replace :524 stance; reactive instructor fallback |
| tests | unit + integration (C-D/C-F) + quality |

**No migration. No new tables. No skills-boundary impact.**
