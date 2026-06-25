# Owner-Configurable Service Mode & Calendar Color (via PA chat)

**Date:** 2026-06-25
**Branch target:** Developer A (`dev/system/*`)
**Status:** Approved design → ready for implementation

## Problem

Owners cannot tell the PA (Branch 3) whether a service is a **class** (group, schedule-driven) or **1-on-1** (private appointment), nor set per-service **Google Calendar colors**. Today:
- `manageBusinessSettings` → `applyServiceChange` sets `maxParticipants` but NOT `scheduling_mode` or `color_id`.
- `scheduleRecurringClasses` auto-promotes a service to `scheduling_mode='class'` + capacity + a distinct color when classes are created (Bug E fix, shipped v1.0.83).
- The only way to (re)configure an existing service's mode/color was a manual SQL backfill (done once for סטודיוגה Pilates/Yoga). That must become an owner-facing conversational capability.

`scheduling_mode` (`'appointment'|'class'`, default `'appointment'`) and `color_id` (int, Google colorId 1–11) columns already exist on `service_types` (migration `0043`, deployed).

## Decisions (locked)

1. **Per-service model.** Each service is individually `class` or `appointment`. A business can be mixed (group Yoga/Pilates + 1-on-1 physio/שיקום).
2. **Guard + confirm on consequential switches** (see Apply logic).
3. **Colors:** owner says a color word → map to nearest of Google's 11 fixed colors → set `color_id` → **re-mirror that service's existing Google events** so the color actually shows. Any service can have a color. Explicit owner color overrides auto-assignment.
4. **Scope:** anytime conversational config only. Onboarding asking class-vs-1-on-1 up front is a SEPARATE follow-up spec (not this one).
5. **Approach A:** extend the existing `manageBusinessSettings` / `applyServiceChange` path + a pure `color-vocab` module + a re-mirror trigger. No new tools.

## Architecture

Owner message → orchestrator `manageBusinessSettings(instruction)` → `classifyManagerInstruction` (LLM, `client.ts`) → typed `serviceChangeSchema` → `applyServiceChange` (`src/domain/manager/apply.ts`).

### 1. Parse layer
Add to `serviceChangeSchema` (`apply.ts` ~line 145) three optional fields:
- `schedulingMode: z.enum(['class','appointment']).nullable().optional()`
- `color: z.string().nullable().optional()` — the owner's raw color word (e.g. "blue", "כחול")
- `confirm: z.boolean().optional()` — LLM sets `true` when the owner confirms a previously-warned destructive switch (it reads this from session/conversation history).

Update the `classifyManagerInstruction` service-change prompt (`client.ts`) to recognize:
- *"X is a group class for N" / "make X a class" / "X is 1-on-1" / "switch X to private/appointments"* → `schedulingMode` (+ `maxParticipants` when a number is given).
- *"make X blue" / "give Yoga a different color" / "color X red"* → `color`.

### 2. Color vocabulary — new pure module `src/domain/manager/color-vocab.ts`
Google Calendar event colors (the only 11 available):
`1 Lavender · 2 Sage · 3 Grape · 4 Flamingo · 5 Banana · 6 Tangerine · 7 Peacock · 8 Graphite · 9 Blueberry · 10 Basil · 11 Tomato`

`export function colorWordToGoogleId(word: string): number | null` — case/whitespace-insensitive, English + Hebrew + common synonyms:
- red/אדום → 11 · orange/כתום → 6 · yellow/צהוב → 5 · green/ירוק → 10 (light green/sage → 2) · blue/כחול → 7 (dark blue/navy/כחול כהה → 9) · teal/turquoise/טורקיז → 7 · purple/סגול → 3 (lavender/light purple → 1) · pink/ורוד → 4 · gray/grey/אפור → 8.
- Unmappable → `null` (PA lists the available palette / asks). Pure + fully unit-tested.

### 3. Apply logic (`applyServiceChange`)
After the existing `updates` block (~line 680):
- **`color` provided:** `colorWordToGoogleId(color)`; if null → `{ ok:false, reason: <ask which color, list palette> }`. Else set `updates.colorId` AND flag a re-mirror (see §4).
- **`schedulingMode='class'`:**
  - Set `scheduling_mode='class'`. Capacity: if `maxParticipants` given use it; else if current ≤ 1, ask for capacity (don't silently keep 1 — a class needs ≥2). Reuse the existing `schedule_private_service_needs_capacity` guard wording where sensible.
  - If the service has NO active `class_series` → succeed but the confirmation message nudges: "set — now tell me when the classes run" (it's class-mode but unbookable until a schedule exists).
  - If active `class_series` exist → just activate (the backfill case).
- **`schedulingMode='appointment'`:**
  - If active `class_series` OR future class bookings exist AND `!confirm` → return `{ ok:false, reason: <warn: weekly classes will stop; N people are booked; ask to confirm> }`. The PA relays; owner says yes → LLM re-calls with `confirm:true`.
  - On confirm (or nothing to warn about): set `scheduling_mode='appointment'`, `max_participants=1`, **deactivate** the service's active `class_series` (stop future materialization). Existing bookings REMAIN valid (they simply become individual appointments at those times — non-destructive to the customer).

### 4. Re-mirror trigger (color changes only)
When `color_id` changes for a service, the already-mirrored Google events keep their old color until re-pushed. Enqueue, for that service:
- every `calendar_blocks` (type `'class'`, future horizon) → `enqueueBlockMirror(businessId, blockId)`
- every future confirmed `bookings` row → `enqueueBookingMirror(businessId, bookingId)`
Both from `src/workers/calendar-mirror.ts`. Best-effort, dynamic import to keep Redis/BullMQ out of `apply.ts`'s static graph if needed (mirror the pattern in `scheduling/series.ts`).

## Testing
- **Unit (must run, `npm test` excludes integration):** `color-vocab` mapping (English, Hebrew, synonyms, case, unmappable → null). Any existing classifier parse tests extended for the new intents.
- **Apply transitions:** ideally integration, but the integration suite needs a Postgres test DB. **CI runs only `build + lint + unit` (no DB)**, and the only DB reachable from a dev machine is **production** — so do NOT run `tests/integration/**` locally. Cover the apply logic with focused unit tests where possible; rely on `tsc` + unit + careful review otherwise.
- Baseline: `npm run build` clean, `env -u DATABASE_URL npx vitest run` → 820 passing (pre-change).

## Boundaries
- `color-vocab.ts` — pure, isolated, fully testable.
- `applyServiceChange` extension — within existing `apply.ts`.
- re-mirror — reuse existing `enqueueBlockMirror` / `enqueueBookingMirror`.
- parse schema + classifier prompt — `apply.ts` schema + `client.ts` prompt.

## Out of scope (follow-up specs)
- Onboarding asking class-vs-1-on-1 per service up front.
- Arbitrary hex / brand-color matching (Google supports only the 11 fixed colors).
