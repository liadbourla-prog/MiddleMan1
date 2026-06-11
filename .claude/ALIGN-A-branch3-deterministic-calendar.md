# Session A — Branch 3 Deterministic Calendar Core

**Owner:** Developer A · **Risk:** High (data integrity) · **Prereq reading:** `CLAUDE.md`,
`CHAT_LEVEL_LAWBOOK.md`, `ARCHITECTURE.md` Part 16, `CALENDAR_UX_DESIGN.md`.
**Per-phase git commits are MANDATORY** — commit each discrete step.

---

## Why

Branch 3's manager orchestrator lets the **LLM compute calendar datetimes** and writes them to the
calendar. The tools take `startDatetime` / `endDatetime` / `dateFrom` as *"ISO 8601 in business
timezone"* and do `new Date(args.startDatetime)`:

- `executeCreateCalendarEvent` — `src/domain/manager/orchestrator-tools.ts:162`
- `executeScheduleGroupSession` — `src/domain/manager/orchestrator-tools.ts:238`
- `executeListCalendarEvents` (`list_range`) — `src/domain/manager/orchestrator-tools.ts:59–64`

This is the exact non-determinism Branch 4 eliminated with `src/domain/availability/resolve-slot.ts`.
The LLM resolving "tomorrow" / "next Tuesday" / "the 9th" / "10.01" itself reintroduces the
wrong-weekday and past-year ("2016") bug classes — and because Branch 3 **writes**, the result is a
corrupt calendar entry, not just a bad reply. It violates non-negotiable Principle #1: *the LLM never
does calendar arithmetic.*

**Decision (locked):** full Branch-4 parity. Past-year, impossible-date, ambiguous-week, and DST-gap
each force a clarification turn **before any write**.

---

## Outcome

Manager calendar-write tools receive **structured date/time pieces** (not ISO strings). The executors
resolve them deterministically via the existing `resolve-slot.ts` primitives, apply the same guards as
Branch 4, and return a structured "needs clarification" result on failure so the orchestrator asks
instead of writing a wrong date.

---

## Plan

### Step 1 — Shared date-pieces contract
- Reuse `RequestedDateParts` and `RequestedTime` from `src/domain/availability/resolve-slot.ts`
  (already exported). Do **not** invent a parallel shape.
- The reusable resolution already exists: `resolveRequestedDate(parts, tz, now)` →
  `{ok:true,dateStr}` | `{ok:false,reason}`, and `resolveSlotStart(dateStr, time, tz)` → `Date`.
- Note `DateResolutionReason` covers `no_date | ambiguous_date | impossible_date | past_year`. For a
  manager *event* you also need an end time. Add a small helper (in `resolve-slot.ts`, pure, tested)
  `resolveSlotRange(dateParts, startTime, endTime|durationMinutes, tz, now)` returning either
  `{ok:true, start:Date, end:Date}` or `{ok:false, reason}` — reason also covering `end_before_start`
  and a DST-gap check (reuse the `checkDSTGap` logic; consider lifting `checkDSTGap` out of
  `customer-booking.ts` into `resolve-slot.ts` so both branches share one implementation).

### Step 2 — Rewrite the tool *declarations* (orchestrator.ts)
In `src/adapters/llm/orchestrator.ts` `MANAGER_TOOLS`, replace the ISO datetime params on
`createCalendarEvent` and `scheduleGroupSession` with structured pieces, mirroring
`customerIntentSchema` in `client.ts`:

```
date: { relativeDay?, weekday?(0–6), explicitDate?{year?,month,day} }   // classify only
startTime: { hour(0–23), minute(0–59) }
endTime:   { hour, minute }            // OR durationMinutes for scheduleGroupSession
```

Update each tool `description` and the system-prompt "## Tool usage rules" block to instruct the model:
**"Report the date/time pieces the manager said — never compute or output an absolute/ISO date; a
deterministic system resolves them."** Mirror the wording already in `client.ts`
`extractCustomerIntent` ("DATE/TIME — CLASSIFY ONLY, NEVER COMPUTE").

For `listCalendarEvents` `list_range`: accept the same structured `dateFrom`/`dateTo` pieces (or keep
read-only ISO but resolve through `resolveRequestedDate` and **clamp** rather than block — reads are
lower-stakes; pick clamp-to-valid, document the choice in a comment).

### Step 3 — Rewrite the executors (orchestrator-tools.ts)
For `executeCreateCalendarEvent` and `executeScheduleGroupSession`:
- Replace `new Date(args.startDatetime)` with `resolveSlotRange(...)` using `ctx.timezone` and
  `new Date()` as `now`.
- On `{ok:false, reason}` return a structured clarification result (do NOT write):
  ```ts
  return { success: false, reason, needsClarification: true,
           guidance: '<plain-language instruction telling the model to ask the manager for a
                       workable day/time WITHOUT echoing the unusable date> — phrase it yourself.' }
  ```
  Map each reason to guidance the way `customer-booking.ts` `sanitiseReason` + the bad-date branch do
  (past_year → "that date looks like it's already passed"; ambiguous_date → "ask which day they
  mean"; impossible_date → "that date isn't on the calendar"; dst_gap → "that exact time doesn't
  exist that day"). Keep raw reason codes internal; the model phrases.
- Keep the existing booking-conflict guards (`conflicts_with_bookings`, etc.) — they run *after*
  successful resolution, unchanged.
- Everything downstream (`createBlock`, `enqueueBlockMirror`, capacity/service linking) is unchanged.

### Step 4 — System-prompt + guidance consistency
- The orchestrator already has strong no-echo discipline ("Tool results are raw data — never echo
  them"). Ensure the new `needsClarification` results flow through that same phrasing contract.
- Confirm the loop in `runManagerOrchestratorLoop` naturally re-prompts on a `success:false +
  needsClarification` result (it will — the model sees the function response and asks). Add a short
  note in the system prompt that a `needsClarification` tool result means "ask the manager, don't
  retry the tool with a guessed date."

### Step 5 — Tests
- Add `src/domain/availability/resolve-slot.test.ts` cases for `resolveSlotRange` (mirror the existing
  `resolveRequestedDate` tests): past-year, impossible (30 Feb), ambiguous week, DST gap,
  end-before-start, happy path across DST boundaries and TZs.
- Add executor-level tests (or extend existing manager tool tests if present) asserting that a
  past-year / ambiguous request returns `needsClarification` and performs **no** `createBlock` write.

---

## Guardrails
- Do **not** loosen Branch 4. Reuse its primitives; don't fork date logic.
- Do **not** touch `src/skills/`.
- `manageBusinessSettings` already routes through `classifyManagerInstruction` → deterministic
  `applyInstruction` — leave it alone; it does not let the LLM compute calendar instants.
- Keep all raw reason codes internal (Principle: §7.3 / no-leak). The model phrases every failure.

## Verification (must pass before commit-complete)
- `npx tsc --noEmit` clean.
- `npm test` green (existing 186 + new).
- Manually trace: "schedule a yoga class next Tuesday 11–12, 10 spots" → pieces → `resolveSlotRange`
  → write; "...on the 31st of February" → `needsClarification`, no write.

## Files
- `src/domain/availability/resolve-slot.ts` (add `resolveSlotRange`, lift `checkDSTGap`)
- `src/domain/availability/resolve-slot.test.ts`
- `src/adapters/llm/orchestrator.ts` (tool declarations + prompt)
- `src/domain/manager/orchestrator-tools.ts` (executors)
- (maybe) `src/domain/flows/customer-booking.ts` (if `checkDSTGap` is lifted — re-import it)

## Handoff to Session B
Once merged, Branch 3 calendar writes are deterministic. Session B adds the language-switch protocol.
