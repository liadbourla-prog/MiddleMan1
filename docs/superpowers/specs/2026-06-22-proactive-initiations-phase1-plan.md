# Proactive Initiations — Phase 1 Implementation Plan (the spine)

**Branch:** `dev/system/proactive-initiations-spine` (Developer A)
**Design:** `2026-06-22-proactive-initiations-engine-design.md`
**Status:** ✅ **BUILT** (see §8 for what actually shipped vs this plan).
**Goal of Phase 1:** build the spine and prove it by migrating existing initiators onto it
**with zero behavior change** — net code consolidated, the `initiation_log` ledger now
recording every send. No new customer-facing triggers in this phase.

---

## 1. Scope (as built — behavior-preserving)

**Built in this slice:**
1. `src/domain/initiations/` module — `types.ts`, `registry.ts`, `gate.ts` (pure),
   `dispatch.ts` (I/O), `gate.test.ts`.
2. `initiation_log` table + hand-authored idempotent migration `0026_initiation_log.sql`
   (dedup ledger; skips/dedups recorded via `logAudit`).
3. Migrate **all three** existing initiators onto the spine (the owner chose the larger
   slice over reminder-only): `reminder.24h` / `reminder.1h` (customer/transactional),
   `escalation.owner_rule` (owner) + `escalation.platform` (operator), and `reshuffle.probe`
   (customer/promotional, managed). Behavior identical.
4. Instrumentation: every actual send writes an `initiation_log` row; skips/dedups go to
   `audit_log`; reminder's existing `booking.reminder_sent` audit is preserved (now gated
   on an actual send decision).
5. **Migration tooling overhaul** (done as part of this slice — see §8): retired the
   silently-skipping `drizzle-kit migrate` in favor of `scripts/apply-all-migrations.ts`
   (`npm run db:apply`), wired into `cloudbuild.yaml`; resynced the Drizzle baseline so
   `db:generate` is a correct diff aid again.

**Deferred to later phases (per the design's build order):**
- Attention budget, value gate, trust ratchet, cold-fill, profile, notification engine →
  Phases 2–8 (tracked in `2026-06-22-proactive-initiations-roadmap.md`).

**Why all three (not reminder-only):** the three cover the distinct audiences and delivery
shapes — customer transactional (reminder), owner/operator operational (escalation), and
customer promotional/managed (reshuffle probe) — so the gate contract is exercised across
its full surface in one consolidation pass.

---

## 2. The gate is a PURE function (mirrors `coordination/state.ts`)

The gate does **no I/O**. The dispatcher gathers facts and passes them in; the gate
returns a decision descriptor; the dispatcher executes it. This is the project's
signature pattern (`nextCoordinationState` returns an `effect`, the handler runs it) and
is what makes the gate a unit-testable truth table.

```ts
// types.ts
export type ConsentClass = 'transactional' | 'promotional'

export interface Initiator {
  id: string                                  // 'reminder.24h'
  layer: 'A' | 'B' | 'C'
  audience: 'customer' | 'owner' | 'operator' | 'contact'
  consentClass: ConsentClass
  autonomy: 'owner_commanded' | 'owner_configured' | 'ai_proposed'
  delivery: 'fire_and_forget' | 'managed'
  windowPolicy: { templateName: string } | 'skip'
  defaultEnabled: boolean
  // Phase 1 leaves these optional; later phases populate them:
  priority?: number
  // valueModel?, blastBreaker? — added in their phases
}

export interface GateInput {
  initiator: Initiator
  now: Date
  windowOpen: boolean            // from canSendFreeForm — fact gathered by dispatcher
  recipientOptedOut: boolean     // identities.messagingOptOut
  quietHours: { start: string; end: string } | null
  businessTimezone: string
  dedupSeen: boolean             // dispatcher pre-checked initiation_log for the dedupKey
  enabled: boolean               // per-business on/off (Phase 1: defaultEnabled)
}

export type SkipReason =
  | 'disabled' | 'opted_out' | 'dedup_hit'
  | 'quiet_hours' | 'outside_window_no_template'

export type GateDecision =
  | { kind: 'send_free_form' }
  | { kind: 'send_template'; templateName: string }
  | { kind: 'skip'; reason: SkipReason }
// (route_owner_confirm added in the AI-proposed phase, not now)
```

### Gate decision order (Phase 1 subset of design §4.3)

```
1. enabled?            no  → skip:disabled
2. dedupSeen?          yes → skip:dedup_hit
3. consentClass:
     transactional → SKIP checks 4 & 5 (essential + time-anchored; e.g. reminders)
     promotional   → run them
4. recipientOptedOut?  yes → skip:opted_out          (promotional only)
5. quiet hours now?    yes → skip:quiet_hours         (promotional only)
6. window resolution:
     windowOpen        → send_free_form
     else windowPolicy={templateName} → send_template
     else (='skip')    → skip:outside_window_no_template
7. (value gate, budget, owner-confirm → later phases)
```

**This is exactly why reminder migrates with zero behavior change:** reminder is
`consentClass: 'transactional'`, so it bypasses opt-out and quiet-hours (which reminder
does not check today), and its window fork (`send_free_form` vs `appointment_reminder_*`
template) reproduces `reminder.ts:137-162` line for line.

---

## 3. `initiation_log` table (dedup + decision audit)

Models the `reminders` unique-index dedup discipline (`schema.ts:508`) and the
`freedSlotApprovals` audit shape.

```ts
export const initiationLog = pgTable('initiation_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull().references(() => businesses.id),
  initiatorId: text('initiator_id').notNull(),        // 'reminder.24h'
  recipientId: uuid('recipient_id').references(() => identities.id),
  dedupKey: text('dedup_key').notNull(),              // 'reminder.24h:{bookingId}'
  // As built: the ledger records SENDS only. Skips/dedups go to audit_log (so the unique
  // index stays a clean one-send-per-dedupKey ledger), hence no 'skip' enum / skipReason.
  decision: text('decision', {
    enum: ['send_free_form', 'send_template'],
  }).notNull(),
  audience: text('audience').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('initiation_log_dedup_idx').on(t.businessId, t.dedupKey),
  index('initiation_log_recipient_idx').on(t.recipientId, t.createdAt), // future freq-cap reads
])
```

- The `uniqueIndex(businessId, dedupKey)` **is** the dedup mechanism: the dispatcher
  attempts an insert with the decision; a unique-violation = "already fired" = idempotent
  no-op. (Same trick `reminders` uses.)
- `recipient_idx` is laid down now so the future attention-budget can count recent sends
  per recipient cheaply — no migration later.
- Migration is **hand-authored** (`0026_initiation_log.sql`, `IF NOT EXISTS`) and applied by
  `npm run db:apply` (`scripts/apply-all-migrations.ts`). `drizzle-kit migrate`/`db:generate`
  are NOT the apply path — see §8 and `src/db/migrations/README.md`.

---

## 4. Dispatcher (`dispatch.ts`) — the only I/O

```
dispatchInitiation(db, initiator, ctx):
  1. dedupKey = initiator.dedupKey(ctx)
  2. gather facts: windowOpen = canSendFreeForm(recipientId)
                   recipientOptedOut, quietHours, timezone (one read each)
                   dedupSeen = exists in initiation_log(businessId, dedupKey)
  3. decision = runGate({ ...facts })          // PURE
  4. write initiation_log row (the unique index also guards races)
  5. execute decision:
       send_free_form → enqueueMessage(...)    (LLM phrasing via generateProactiveCustomerMessage)
       send_template  → sendTemplateMessage(...)
       skip           → nothing (already logged)
  6. preserve initiator-specific logAudit (reminder keeps booking.reminder_sent.*)
```

`reminder.ts` shrinks: `processReminder` keeps its data-loading (booking/customer/
service/business + i18n strings + `situation`), then hands a built `InitiationContext`
to `dispatchInitiation` instead of doing the window fork + send inline. The two reminder
initiators are declared in `registry.ts`.

---

## 5. Tests (mirror `coordination/state.test.ts`)

- **`gate.test.ts` — truth table.** For each decision-order branch: disabled, dedup hit,
  transactional-bypasses-optout/quiet, promotional opted-out, promotional quiet-hours,
  window-open→free-form, window-closed+template→template, window-closed+skip→skip. Assert
  exact `GateDecision`.
- **Migration parity.** Existing reminder behavior: add/keep a test asserting
  window-open→free-form path and window-closed→`appointment_reminder_24h` template path
  produce the same sends as before.
- **Dedup idempotency.** Dispatch the same reminder dedupKey twice → second is a no-op
  (unique-violation swallowed), one `initiation_log` row.

---

## 6. Acceptance criteria — ✅ met

- [x] `tsc` + `eslint` + `vitest` all green (538 tests + 9 new gate tests).
- [x] Reminder 24h/1h sends byte-identical to pre-change (free-form and template).
- [x] Every actual send leaves exactly one `initiation_log` row; re-runs are idempotent
      (unique `(business_id, dedup_key)` + `onConflictDoNothing`).
- [x] No import from `src/skills/` and no skills boundary touched (pure core).
- [x] `gate.ts` has zero I/O imports (pure); all I/O in `dispatch.ts`.
- [x] Migration hand-authored, idempotent, applied via `npm run db:apply` (dry-run verified).

---

## 7. Decisions (resolved)

1. **Slice size — RESOLVED: all three** (`reminder`, `escalation` owner+platform,
   `reshuffle.probe`), not reminder-only. Covers every audience/delivery shape in one pass.
2. **Transactional bypass of opt-out/quiet-hours — RESOLVED: yes.** Reminders + operational
   escalations are essential/time-anchored; the gate bypasses opt-out & quiet hours for
   `transactional` consent and for `owner`/`operator` audiences.
3. **Metric surfacing — RESOLVED: defer.** Phase 1 only *writes* `initiation_log`;
   OAU/bookings dashboards land with the control-surface phase (Phase 5).

---

## 8. What actually shipped (deltas from the original plan)

- **All three initiators migrated**, not reminder-only (decision §7.1).
- **Ledger records sends only.** `initiation_log.decision` is `send_free_form |
  send_template`; skips and dedups are recorded via `logAudit` (`initiation.skipped` /
  `initiation.deduped`), keeping the unique index a clean one-send-per-key ledger. The
  pure gate never emits `dedup_hit` — dispatch returns it after a ledger-insert collision.
- **Dispatcher decides-then-inserts** (race-safe via `onConflictDoNothing`) rather than the
  pre-check-`dedupSeen` sketch in §4; dedup is therefore not a pure-gate concern.
- **Inbound non-fatal guard.** The two escalation dispatch calls are `.catch`-wrapped so a
  ledger/notify hiccup can't break the synchronous inbound message flow.
- **Migration-tooling overhaul (new, unplanned but necessary).** Discovered the Drizzle
  journal froze at `0006`, making `drizzle-kit migrate` silently skip everything after it.
  Retired it: `scripts/apply-all-migrations.ts` (`npm run db:apply`) now applies *all*
  migrations idempotently + verifies, wired into `cloudbuild.yaml`; the Drizzle baseline was
  resynced so `db:generate` is a correct diff aid. Per-feature `apply-*.ts` scripts removed.
  See `src/db/migrations/README.md`.
