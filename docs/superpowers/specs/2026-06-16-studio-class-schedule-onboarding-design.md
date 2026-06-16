# Studio Instructors ↔ Booking: week-to-week class scheduling — Design

**Date:** 2026-06-16
**Status:** Decisions confirmed (D1–D5 + model) — ready to turn into an implementation plan
**Relates to:** instructor-management (`provider_change`), recurring-class system (`class_series`),
group booking (`requestGroupClassBooking`)

---

## 1. The model (confirmed)

A studio is **session-based and managed week-to-week in the ongoing Branch-3 conversation** —
not a one-time onboarding capture. The owner schedules each week's classes conversationally
("schedule yoga Monday 10:00 with Dana, 12 spots"), and each class carries its **instructor** and
**capacity** and becomes bookable. Customers book **into a class**.

Confirmed decisions:
- **D1 — yes:** a booking into a class **inherits that class's instructor** (`providerId`).
- **Model — mostly week-to-week, ongoing** (one-off sessions); recurring series optional for any
  genuinely fixed classes (open-ended, **D5**).
- **Instructors — explicit add, then schedule:** the owner adds instructors first
  ("add Dana as a yoga instructor"), then references them when scheduling. A name typo can't
  silently create a phantom instructor.
- **D3 — keep the instructor FAQ and upgrade it** (see §4).
- **D4 — yes:** a class's length defaults to the linked service's `durationMinutes` when unstated.

Because the schedule lives in the weekly conversation, **onboarding needs no schedule capture**,
and **instructors need no separate availability windows** — an instructor's "schedule" *is* the
set of classes assigned to them.

## 2. What already exists (reuse)

- **Instructor creation** — `applyProviderChange('add')` makes a `provider` identity +
  `provider_assignments` ([manager/apply.ts]). Hours are optional and **omitted** for studio
  instructors (their classes are their schedule). Built already.
- **One-off class** — `scheduleGroupSession` → `createBlock(type='class', maxParticipants)`
  ([orchestrator-tools.ts:342]). `createBlock` **already accepts `providerId`** ([blocks.ts:30]).
- **Recurring class** — `recurring_class_change` → `createSeries(...)`; `createSeries` already
  accepts `providerId`; the materializer carries it into the session `calendar_blocks`.
- **Group booking** — `requestGroupClassBooking` enforces **per-class capacity** (FOR UPDATE).
- **Customers already see/book scheduled classes** ("day.classes" with remaining spots).

## 3. The gaps to close (small, additive)

1. **`scheduleGroupSession` doesn't attach an instructor.** It calls `createBlock` **without
   `providerId`** and has no instructor arg. → Add an `instructor` arg; resolve it to an existing
   `provider` (clarify if not found — "I don't have an instructor named Dana; add her first?");
   pass `providerId` to `createBlock`. Update the tool description + classifier so
   "…with Dana" is captured.
2. **`applyRecurringClassChange` ignores `providerHint`.** The schema parses `providerHint` but
   `createSeries` is called **without `providerId`**. → Resolve `providerHint` → provider, pass
   `providerId` to `createSeries`.
3. **Booking doesn't inherit the class's instructor (D1).** `requestBooking` resolves a provider
   via `provider_assignments`+`availability`, not the class block. → When booking into a class
   session, set the booking's `providerId` from the matched `calendar_blocks.providerId`. Then
   "book yoga with Dana" attributes Dana, and instructors need no availability rows.

## 4. Instructor FAQ upgrade (D3)

Today it's a **static paragraph** the owner typed once — it goes stale the moment the schedule
changes. Upgrade to **derived + dynamic**:
- Auto-generate "who teaches what" from the **live roster + upcoming scheduled classes**
  ("Dana teaches Yoga Mon 10:00 & Wed 18:00 this week"), refreshed as the schedule changes —
  not a frozen snapshot.
- Optionally capture a short **bio/specialty per instructor** ("Dana — prenatal-yoga specialist,
  10 yrs") for warmer answers when a customer asks about a specific instructor.
- Keep it answer-on-demand (Branch 4 stays reactive — it doesn't volunteer the roster unprompted,
  per the existing stance).

## 5. Bridge from onboarding-volunteered instructors

Per "explicit add," we do **not** auto-create instructors from the onboarding FAQ. Instead, after
the owner volunteers instructors during setup, the PA **nudges** once: "I noted your instructors —
want them bookable? Just say 'add Dana as a yoga instructor'." (A prompt, not silent creation.)
*(Optional; low-risk; can be dropped if you'd rather keep onboarding lean.)*

## 6. Scope / plan outline

1. **Engine (D1):** book-into-class inherits `calendar_blocks.providerId`. Unit + integration test
   (book a class with instructor → booking carries that instructor; capacity still enforced).
2. **`scheduleGroupSession` instructor:** tool arg + classifier + resolve-existing-provider +
   `providerId` to `createBlock`; clarify when the instructor doesn't exist.
3. **`recurring_class_change` instructor:** resolve `providerHint` → `providerId` into `createSeries`.
4. **FAQ upgrade (D3):** derive "who teaches what" from roster + upcoming classes; optional bio field.
5. **(Optional) onboarding nudge** to add volunteered instructors.
6. **Tests:** unit (provider resolution/clarify in scheduleGroupSession; recurring providerId),
   integration (schedule class with Dana → materialize/inherit → customer books → Dana attributed,
   capacity enforced), quality (the "schedule yoga Monday 10 with Dana" + "who teaches yoga?" turns).

## 7. Files (anticipated)
`src/domain/manager/orchestrator-tools.ts` (scheduleGroupSession instructor), `src/adapters/llm/orchestrator.ts`
(tool description/routing) + classifier if needed, `src/domain/manager/apply.ts`
(`applyRecurringClassChange` providerId), `src/domain/booking/engine.ts` (D1 inherit),
`src/domain/provider/roster.ts` or knowledge layer (derived FAQ), plus tests. **No new tables.**
Reuse `createBlock`/`createSeries`/`applyProviderChange`/resolver.
