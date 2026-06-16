# Studio Class Schedule + Instructor Onboarding — Design (DRAFT for review)

**Date:** 2026-06-16
**Status:** Draft — autonomous design pass; **needs user review on the marked decisions**
**Relates to:** instructor-management (provider_change), recurring-class system (class_series)

---

## 1. The problem, restated correctly

The owner described instructors during onboarding ("Dana & Noa teach yoga, Dana also
pilates, Mai & Gal pilates, Dan/Uri/Guy breathing"). Today that becomes an **FAQ**, not
bookable structure: `provider identities = 0`, `provider_assignments = 0`, `class_series = 0`.
So "book yoga with Dana" can't resolve Dana.

The deeper insight (from the owner): a studio is **session-based**, not appointment-based.
It doesn't run on "Dana is free 9–20"; it runs on **classes** — *Monday 10:00 Yoga, 60 min,
cap 12, taught by Dana*. Customers book **into a class**. So the unit to capture is the
**class schedule**, and the instructor is a property of the class — not a separate
availability window.

## 2. What already exists (reuse, do not rebuild)

The session model is already supported end-to-end:

- **`class_series`** (recurring weekly class): `serviceTypeId`, **`providerId`**, `dayOfWeek`,
  `startTime`, `durationMinutes`, **`maxParticipants`**, `startDate`, `endDate?`, `timezone`.
  `createSeries()` already accepts `providerId` ([series.ts]).
- **Materializer** turns a series into `calendar_blocks` (`type='class'`) carrying
  **`providerId`** + `maxParticipants` ([series.ts:167]).
- **Group booking** (`requestGroupClassBooking`, [engine.ts:347]) enforces **per-class
  capacity** via a `FOR UPDATE` count on the slot.
- **Instructors** are `provider` identities + `provider_assignments` (instructor↔service),
  created by `applyProviderChange` ([manager/apply.ts]).
- **Customers already see/book scheduled classes** ("day.classes" with remaining spots,
  [customer-booking.ts:252]).

So a session-based studio maps cleanly onto: **services → instructors (providers) →
class_series (the schedule, linking service + instructor + day/time + capacity)**.

## 3. The one real engine gap (must fix for correct attribution)

The booking engine resolves the provider **independently** of the class it's booking into:

```
const resolvedProvider = request.providerId
  ? { identityId: request.providerId, ... }
  : await resolveProvider(serviceTypeId, slot, hint)   // provider_assignments + availability
```

It does **not** read the `calendar_block.providerId` of the class being booked. So a class
that is "Dana's" (series.providerId = Dana) would attribute the booking to whatever
`resolveProvider` returns (often null, since instructors in the session model may have no
generic `availability` rows — their "availability" *is* their classes).

**Design decision (D1):** when a customer books into a specific **class** session, the booking
must **inherit that class's `providerId`** (from the `calendar_blocks`/series row), rather than
re-resolving. This makes "the Monday 10:00 yoga class is Dana's" true at booking time and means
**instructors need no separate availability windows** in the session model — their schedule is
their classes.

## 4. Proposed model & flow

### 4.1 Capture (onboarding) — dedicated step + auto-detect *(per earlier decision)*
- **Dedicated step**: after services, ask for the **class schedule**: *"What classes do you run,
  when, who teaches each, and how many spots?"* — e.g. "Yoga Mon & Wed 10:00 with Dana, 12 spots;
  Pilates Tue 18:00 with Mai, 10 spots."
- **Auto-detect**: if the owner volunteers instructor/class info at another moment (as happened),
  recognize it and offer to set it up.
- **Parse** the free text (LLM extraction) into structured rows:
  `{ serviceName, dayOfWeek, startTime, durationMinutes?, instructorName, maxParticipants }[]`.

### 4.2 Create (cross the skill boundary cleanly)
Skills can't import domain. Add to `SkillContext` (co-owned `skill-types.ts`), implemented in
`src/domain/skills/context-builder.ts` (which may import domain):

```ts
// skill-types.ts
saveStudioSchedule: (classes: Array<{
  serviceName: string
  instructorName: string
  dayOfWeek: number          // 0–6
  startTime: string          // 'HH:MM' local
  durationMinutes?: number   // default from the service
  maxParticipants: number
}>) => Promise<{ created: number; instructors: string[] }>
```

`context-builder` implementation, per class:
1. find-or-create the **service** (exists) and set its `maxParticipants` if grouped;
2. find-or-create the **instructor** (`provider` identity + `provider_assignments`) — reuse the
   `applyProviderChange('add')` core so there is **one** instructor-creation path;
3. create the **`class_series`** (`createSeries`) with `providerId` = that instructor, the day/time,
   capacity, and `timezone` = business tz; the materializer schedules the sessions.

### 4.3 Book (already works, plus the D1 fix)
Customer books a class → capacity enforced per session → booking inherits the class's instructor
(after D1). "Book yoga with Dana" resolves to Dana's classes.

## 5. Reconciliation with existing capabilities (no duplication)
- Instructor creation reuses the **`applyProviderChange` 'add'** core (one path).
- Class creation reuses **`createSeries`** (same as the orchestrator's `recurring_class_change`).
- The owner can still refine everything post-onboarding via the orchestrator
  ("move the Monday class to 11:00", "add Dana to pilates", "stop the Friday class").
- The onboarding FAQ capture ("who teaches what") can remain as a customer-facing answer *in
  addition* to the structured classes (decision D3 below).

## 6. Decisions needed from you

- **D1 — booking inherits the class's instructor** (recommended **yes**): fix the engine so a
  class booking attributes the class's `providerId`. Without it, session-model instructor
  attribution is unreliable. *(I recommend yes; it's the crux of the session model.)*
- **D2 — where the dedicated step lives**: (a) a new **manager-onboarding** step (Branch 3,
  before "go live"), or (b) inside the **business-knowledge-setup** skill (post-go-live, where the
  owner already volunteered instructors). The skill is more natural for the cross-boundary methods
  and matches where it happened; onboarding makes it part of first-run setup. *Your call.*
- **D3 — keep the instructor FAQ too?** Keep the auto-generated "who teaches what" FAQ for customer
  Q&A in addition to the structured classes, or replace it once classes exist?
- **D4 — duration default**: if the owner doesn't state a class length, default to the service's
  `durationMinutes`? *(recommended yes.)*
- **D5 — open-ended vs dated series**: create series as open-ended (no end date, rolls forward), or
  ask for a term? *(recommended open-ended; owner can stop a series later.)*

## 7. Scope & rough plan (after decisions)
1. **Engine (D1):** book-into-class inherits `calendar_block.providerId`. Unit + integration tests.
2. **Contract:** `SkillContext.saveStudioSchedule` in `skill-types.ts`; implement in
   `context-builder.ts` (reusing `applyProviderChange` core + `createSeries`).
3. **Capture:** LLM parser (free text → structured classes) + the dedicated step (D2) + auto-detect.
4. **Reconcile/refine:** ensure orchestrator edits still work on onboarding-created series.
5. **Tests:** parser unit; integration (capture schedule → classes materialize → book class →
   instructor attributed, capacity enforced); quality (the capture conversation).

## 8. Files (anticipated)
`src/shared/skill-types.ts` (method), `src/domain/skills/context-builder.ts` (impl),
`src/domain/booking/engine.ts` (D1 inherit), the capture parser (new, in adapters/llm or the
chosen flow), the dedicated step (manager-onboarding **or** business-knowledge-setup per D2),
plus tests. Reuse: `series.ts`, `manager/apply.ts` (provider add), resolver/engine read-side.

**No new tables expected** — the model reuses `class_series` / providers / `provider_assignments`.
