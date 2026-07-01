# Google Inbound Translator — Owner-Direct Calendar Edits Told Truthfully

**Status:** DESIGN LOCKED (design conversation 2026-06-30/07-01) — ready to build in phased TDD sessions.
**Scope:** Make the PA answer truthfully when an owner edits Google Calendar **directly** (never through Branch 3), in **both** polarities — owner *adds* a class/slot, owner *frees* a booked slot — while keeping the **internal DB the single source of truth**.
**Baseline:** v1.0.108 = 1700 tests / 158 files green. No code written in the planning session.
**Sibling doc:** `plans/2026-06-30-branch4-root-fix-plan.md` (P1/P2/P3 — a *different* seam; do not conflate).

> ### REGRESSION RED-TEAM — what changed (4 parallel code investigations, 2026-07-01)
> A hard regression review found **3 regressions the plan-as-written would introduce** and **2 pre-existing latent bugs**. All folded into the tasks below. Read before building.
> - **[R1 · DESIGN — LOCKED with owner 2026-07-01] Certainty-gated auto-open.** Auto-open a booking-without-approval **only at 100% per-case certainty** (template/pattern match, or a structured description marker — never free-text guessing); short of certainty, **occupy the slot and relay to the owner via Branch 3** to confirm real availability. Occupancy is **always** counted internally — a description's "2/8 booked" is a reason to ask the owner, never to trust a head-count. Makes private/tentative/invite-only classes safe by construction. See T1.2.
> - **[R2 · DATA-LOSS] Branch-4 reconcile-on-read would hard-DELETE valid blocks on a successful-but-stale Google response, on every customer turn, for all customers.** Reversed: the customer path is **additions-only** (fold in owner-added events; **never diff-delete** from a passive read). Deletion stays on the gated/manager/tick path. See T2.1.
> - **[R3 · FALSE GUARANTEE] The A2 freshness backstop relied on windowed full-reconcile, which does NOT reliably catch standalone booking deletions** (no tombstone in a `singleEvents` window; no booking-diff on that path). Redesigned: the tick uses **incremental sync (live syncToken)** which DOES catch tombstones, PLUS a **booking-diff** with a completeness guard. See T2.2.
> - **[PRE-EXISTING BUG A] Dropped push + token expiry strands a freed booking as `confirmed` forever** — the windowed reconcile can never see it. Independent of this feature; fixed by T2.2's booking-diff.
> - **[PRE-EXISTING BUG B] The existing manager/web callers of `reconcileScheduleWindowOnRead` can already lose valid blocks on a stale-OK Google response, and no Google call has any timeout.** Fixed centrally: see the new **Cross-cutting C0**.
> - **[R4 · MINOR] Imported class with `providerId=null` is silently dropped from the teaching-schedule FAQ** (INNER JOIN at `provider/roster.ts:101`). Low severity (visibility only, not booking/availability). See T1.5.
> - **CLEARED:** booking INTO an imported class works end-to-end, source-agnostic, null-provider handled (availability, roster, reminders, capacity, integrity-sentinel INV-9/INV-4 all safe). The mirror-loop risk is fully guarded by `source='google_import'` (`calendar-mirror.ts:105`).

---

## Cross-cutting C0 (PREREQUISITE, shared by Phase 2) — make diff-deletion safe & Google calls bounded

**Two pre-existing latent bugs that Phase 2 would otherwise amplify — fix centrally, first.**

**C0.1 — completeness guard on ALL diff-based deletion.** Both the block diff (`reconcileScheduleWindowOnRead`, `inbound-sync.ts:562-592`) and the new booking diff (T2.2) infer "deleted" from *absence* in Google's returned set. A successful-but-eventually-consistent/empty Google page must **never** be treated as "everything was deleted." Guard: treat a window as authoritative for deletion **only** when the fetch completed fully (all pages drained, HTTP ok) **and** the returned set is not implausibly empty relative to what we hold internally (e.g. Google returned 0 events while we hold N mirrored rows in-window ⇒ abort the diff, log, do not delete). This also repairs the existing manager/web data-loss exposure.
**C0.2 — timeout on Google calls.** There is **no timeout anywhere** in `adapters/calendar/client.ts` / `adapters/google/native-fetch.ts`. Add an `AbortController` deadline to `incrementalSync` so a hanging Google call can never stall a caller (a customer reply, the tick). Mandatory before T2.1/T2.2.
**Done when:** a simulated stale/empty-but-200 response deletes nothing; a hanging Google call aborts within the deadline and the caller proceeds on the internal record.

---

## 0. The one principle this plan must never violate

> **Google Calendar is an inbound *translator*, never a source of truth. Every owner edit in Google is translated into an internal state change; the PA reads only the internal record.**

This plan **widens what the inbound translator can produce** — from `{opaque busy-block}` to `{opaque block | bookable class | booking-cancellation}` — and **guarantees freshness** so the translated state is present by the time a customer asks. It adds **no** new authority to the LLM and makes **no** change to the booking engine. Internal-as-hub (CALENDAR_UX_DESIGN.md §2, locked decisions #1–#4) stands unchanged.

### Why this is clean (the two load-bearing facts, verified in code)
1. **The engine already treats `type='class'` `calendar_blocks` as bookable class instances, with NO `source` filter** — `availability/day-options.ts:116`, `availability/blocks.ts:178` (`findClassBlockProviderForSlot`), `booking/engine.ts:210-222`. A `google_import` row with `type='class'` is therefore *automatically* answerable and bookable, indistinguishable from a Branch-3-scheduled class. **⇒ zero booking-engine changes.**
2. **`service_types` already carries the classifier's inputs** — `name`, `schedulingMode ('class'|'appointment')`, `maxParticipants` (default capacity). **⇒ the matcher needs no new schema.**

The entire change lives at **one seam**: the inbound translator (`domain/calendar/inbound-sync.ts`).

---

## 1. The two cases and their (different) inbound paths

| Case | Owner does in Google | Existing path | This plan |
|---|---|---|---|
| **G1/G2** | *Adds* a Pilates class (e.g. Sun 19:00) | `reconcileOwnerEvent` → **opaque block** (title discarded) | **NEW: classifier** materializes a bookable `type='class'` block on a service match |
| **A2** | *Frees* a booked 1v1 (deletes the mirrored event) | `reconcileManagedEvent` → `applyOwnerCancellations` → booking `cancelled` (**already correct**) | **NO code change to the path**; add a **freshness backstop** so it's correct within minutes, not up to 6h |

**Key asymmetry (must be respected, not "fixed"):**
- G1/G2 is **read-safe** (materializing a class has no outbound side effect) ⇒ it may also run at **read-time** (Branch-4 reconcile-on-read).
- A2 is **destructive + notifying** (cancelling a booking sends the customer a WhatsApp) ⇒ it must **never** run from a passive customer read (`inbound-sync.ts:536-538` exclusion is correct). Its freshness comes from **push + a time-driven reconcile tick**, never from the read path.

---

## Phase 0 (PREREQUISITE) — classifier + reconcile telemetry

**Why first:** the same X1 gap that blocked the P2 red-team (no queryable gate/decision logs in prod) will blind this. A mis-classified event (personal "Pilates" workout opened as a public class, or a real class left opaque) is invisible without a decision log.

**T0.1 — structured inbound-decision log line.** In `runInboundSync` / `reconcileOwnerEvent`, emit one structured line per reconciled event: `{ businessId, googleEventId, decision: 'class_materialized'|'block_opaque'|'weak_pending_confirm'|'booking_cancelled'|'echo_ignored', matchedServiceTypeId|null, matchTier|null, viaTrigger: 'push'|'tick'|'read' }`. **No event titles/bodies** (privacy — the whole point of decision #10).
**T0.2 — queryable in prod.** Same logger-level fix as the P-plan's X1 (app logs currently filtered below Fastify). Default ON at info.
**Done when:** a Cloud Logging query for a known owner edit returns its decision line, distinguishing "left opaque" from "materialized as class."

> **PHASE 0 REVIEW:** confirm no title/PII in logs; confirm the line distinguishes all five decisions.

---

## Phase 1 (CORE) — the add-a-class translator (G1/G2)

**Symptom:** owner adds Pilates Sun 19:00 in Google; PA's series model shows 9/11/14/18; customer asks "class at 19?" and is wrongly told "no, last class is 18:00."

### T1.1 — title→service matcher (pure, unit-testable)
**File:** new `domain/calendar/service-match.ts`.
**Approach:** normalize `ev.summary` (trim, lowercase, strip punctuation, fold Hebrew niqqud/whitespace) and match against the business's `service_types.name` (+ an optional alias list — start with exact-normalized match only; defer fuzzy). Return `{ serviceTypeId, schedulingMode, defaultCapacity } | null`.
**Failing tests first:** `"פילאטיס"` / `"Pilates"` / `"פילאטיס ערב"` → matches the Pilates service; `"דנטיסט"` / `"lunch"` / `""` → `null`.
**Regression guard:** returns `null` on any non-service title — this is the **privacy gate** that preserves decision #10 (a personal event never becomes a class because its title never matches a defined service name).

### T1.2 — tiered classification inside `reconcileOwnerEvent`
**File:** `domain/calendar/inbound-sync.ts:308-344` (the branch that today always writes `type='block', title=null`).
**Approach:** run T1.1, then:
| Tier | Condition | Action |
|---|---|---|
| **Certain-bookable (auto-open)** | **100% per-case certainty** it is a genuine, public, open class — via a **certainty signal** (below) | `createBlock({ type:'class', serviceTypeId, maxParticipants: certainCapacity, providerId: null, source:'google_import', googleEventId, googleEtag })` — **bookable immediately** + T1.3 owner note |
| **Uncertain class (occupy-and-ASK)** | title matches a `class`-mode service but **no** certainty signal (e.g. bare "Pilates class") | **opaque `type='block'`** (occupies, so the PA never says "free"/"nothing there") + **relay to owner via Branch 3**; Branch-4 reply: *"there's a class here — let me confirm with the studio it's actually open for booking."* Becomes bookable ONLY on owner confirm |
| **Appointment-mode / weak** | matches an `appointment`-mode service, or partial | opaque `type='block'` + owner relay |
| **None** | `null` match | opaque `type='block'` — **exactly today's behavior** (decision #10 preserved) |

**Decision LOCKED (R1, owner 2026-07-01): certainty-gated auto-open, ask-the-owner otherwise.** The PA auto-opens a booking-without-approval **only at 100% per-case certainty**; short of certainty it **occupies the slot** (so it never denies the class exists) and **relays to the owner via Branch 3** to confirm real availability. This makes private/tentative/invite-only classes safe by construction (owner rejects), and reframes decision #10 to *"auto-interpret as **bookable** only at per-case certainty; otherwise occupy-and-ask."*

**Certainty signals (a case is "certain" iff at least one holds):**
1. **Template/pattern match (primary, safest):** the event matches a class series the business already runs — same service (title→service match) **and** aligned weekday/time-band. No phantom-booking risk: it's a class we already manage. *(This is the literal G1 case — a 5th Pilates on a Sunday already running Pilates.)*
2. **Structured marker (secondary):** the description hits a **machine-readable convention we define** (e.g. `class: <service>; capacity: <n>`), not free-text prose. Free-text NLP guessing is explicitly **NOT** certainty.

**Occupancy stays 100% internal (hard rule — do NOT regress SoT):** the description may be used to **classify** and to read a **capacity**, but **never** to trust a current head-count. A description implying **pre-existing external bookings we don't hold** ("2/8 booked") is a reason to **ask the owner** (so those bookings are reconciled or the true remaining capacity is confirmed) — **not** a green light to auto-open. `certainCapacity` = service default or a structured-marker capacity; occupancy is always counted from the internal `bookings` table. *(The per-business `dedicatedCalendar` flag is demoted: per-case certainty is stricter and supersedes it — a private class on a dedicated calendar must still not auto-open.)*

**Pending-confirmation state (build must add):** while awaiting the owner, the slot stays **occupied** (no double-book) and the **waiting customer is re-notified** when the owner confirms it opened — reuses the Branch-3 `pending_owner_questions` relay + a re-engage note (both code templates, Gate-4 owns phrasing).
**`providerId=null` and no invented capacity beyond the service default** — the PA states the class exists but never fabricates an instructor (G6-safe).
**Mirror-loop guards (CLEARED-with-conditions, R-mirror):** the row MUST carry `source:'google_import'` (trips the outbound skip at `calendar-mirror.ts:105`), the materialization path MUST **not** call `enqueueBlockMirror`, and `mirrorToGoogle` stays at its default `true` (forcing `false` would break inbound diff-deletion detection). Mirror exactly the existing `reconcileOwnerEvent` insert pattern.
**Failing tests first:** (a) certainty signal present (template match — Pilates 19:00 on a Sunday already running Pilates) → a `type='class'` block exists with `source='google_import'`, `findClassBlockProviderForSlot` returns it, Branch-4 "class at 19?" answers yes and it's bookable. (b) bare "Pilates class", no certainty signal → `type='block'`, occupies the slot, **NOT bookable**, Branch-4 says "let me confirm with the studio", owner relayed. (c) description "2/8 booked" → **not** trusted for occupancy; ask-owner path (phantom-booking repro), and no offer computes availability from Google text. (d) None-match → `type='block'`, never surfaced as a class. (e) private class titled "Pilates" → occupy-and-ask, **never auto-booked** (the R1 leak repro).
**Regression guard:** echo of our own outbound class still routes via `reconcileManagedEvent` (paManaged), **not** here — no double-import; existing opaque-import tests for personal events stay green; no outbound mirror job enqueued for imported rows.

### T1.3 — owner-confirm note (code template, owner-wins)
**Files:** i18n catalog (new `calendar_owner_class_imported` + `calendar_owner_class_confirm`), enqueue via the existing `enqueueMessage` spine.
**Approach:** on **strong** materialize → informational note ("I saw you added *Pilates, Sun 19:00* in your calendar and opened it for booking with N spots — reply to change capacity/instructor, or if this isn't a class."). On **weak** → a question, slot stays occupied-not-bookable until answered.
**Both are code templates** (Gate-4 owns phrasing) — no new LLM fabrication surface.
**Regression guard:** rules-gated like `notifyOwnerBookingChange` (an owner who muted this class of note isn't double-pinged).

### T1.4 — imported-class update/delete in Google
**File:** `inbound-sync.ts` — the existing update branch (`326-330`) and the cancelled branch (`316-321`).
**Approach:** when the owner later moves the imported event, patch the class block's `startTs/endTs` by `googleEventId` (extend the block-only update to carry class fields). When the owner deletes it: if the class block has **no** bookings → delete it; if it **has** bookings → route through the **blast-radius gate** (owner-wins, `applyOwnerCancellations`-style), never a silent drop (this is G5).
**Failing tests first:** move imported class 19:00→20:00 → single class block moves, no orphan; delete an imported class with 1 booking → blast-radius path, customer notified; delete with 0 bookings → clean removal.
**Regression guard:** owner-deleting a plain opaque block still just removes it (unchanged).

### T1.5 — imported-class visibility in the teaching-schedule FAQ (R4, minor)
**File:** `src/domain/provider/roster.ts:~101` (`loadTeachingSchedule` INNER JOIN on `providerId`).
**Root:** the INNER JOIN silently drops a `type='class'` block whose `providerId` is null — so an imported class with no instructor never appears in the "who teaches what" FAQ.
**Approach:** either LEFT JOIN + surface "instructor TBD", or leave the omission but make it **explicit and commented** ("imported classes without an assigned instructor are not listed until the owner assigns one"). Low severity — booking/availability are unaffected; this is visibility only. Decide in build; do not block Phase 1 on it.
**Regression guard:** internal classes with a provider still list unchanged.

> **PHASE 1 REVIEW — 2 reviewers:** verify the None **and Ambiguous-class** tiers preserve decision #10 (personal/tentative/private events never become *bookable* classes); verify the R1 leak repro (personal "Pilates" on a non-dedicated calendar) stays occupy-and-confirm; verify no booking-engine change; verify capacity/instructor never fabricated; verify no outbound mirror job on the import path.

---

## Phase 2 — freshness so the translated state is present when the customer asks

### T2.1 — Branch-4 reconcile-on-read, ADDITIONS-ONLY (R2 — do NOT diff-delete on the customer path)
**Files:** the Branch-4 availability/inquiry read path (`domain/flows/customer-booking.ts`); a **new additions-only** entry point (do NOT call `reconcileScheduleWindowOnRead` unchanged — its diff-deletion is the data-loss risk).
**Root of the amendment (R2):** `reconcileScheduleWindowOnRead` hard-`DELETE`s any mirrored block absent from Google's returned set (`inbound-sync.ts:581-583`) with only a transport-error guard — a successful-but-stale/empty Google response would **permanently delete a valid class/block for ALL customers**, and running it per customer message maximizes the exposure. It is also awaited, uncached, and un-timed.
**Approach:** add a **fold-in-only** variant that runs `reconcileOwnerEvent` for owner-*added* events in the window and **performs NO diff-deletion**. Requirements, all mandatory:
- **connected-Google mode only**; a non-Google business is a no-op.
- **throttle/cache** per business+window (a `lastReadReconcileAt` short TTL, e.g. ≤1 pull per business per focus-day per 60-120s) — the customer path is the first high-frequency caller, so this gate is new work.
- **bounded by C0.2 timeout**; on timeout/error → serve the internal record, never block or error the reply.
- **narrow window** — scope to the specific inquiry's focus day, not the full 14-day availability horizon.
- deletion is **out of scope here** — owner-deletions of blocks are caught by push + the tick (T2.2) + the gated manager path, never a passive customer read.
**Failing tests first:** (a) owner adds Sun 19:00 Pilates (extends-series), no push delivered → additions-only read materializes the class → PA answers yes. (b) Google returns a stale/empty-but-200 response → **no block is deleted** (the R2 repro). (c) second customer message within the TTL → no second Google call (throttle repro).
**Regression guard:** never deletes a block on the customer path; a business not on Google is a no-op; the reply is never blocked (timeout-bounded); existing manager/web callers keep their own (now C0.1-guarded) behavior.

### T2.2 — short-cadence reconcile tick + booking-diff (R3 / PRE-EXISTING BUG A — the windowed path silently misses freed bookings)
**Files:** new tiny worker `workers/calendar-reconcile-tick.ts`, **separate from** `calendar-sync-renewal.ts` (that job is *channel expiry* at 6h, not *freshness*); plus a **new booking-diff** in `inbound-sync.ts`.
**Root of the amendment (R3):** incremental sync with a **live syncToken** DOES catch booking deletions (Google returns a `status:'cancelled'` tombstone; `showDeleted:true` at `client.ts:512`). BUT the **windowed** path (`opts.full` / after 410 expiry) does **not** reliably return a standalone deleted booking event, and there is **no booking-diff** on that path (the only diff, `reconcileScheduleWindowOnRead`, is blocks-only and excludes bookings). ⇒ a dropped push + token expiry strands a freed booking as `confirmed` **forever** (pre-existing bug A). Relying on the windowed reconcile for A2 (as the plan first did) is a false guarantee.
**Approach:**
- The tick runs `runInboundSync(businessId)` using the **stored incremental syncToken** (returns deltas incl. tombstones — near-zero cost when nothing changed). This is the primary A2 catch.
- **Add booking-diff deletion detection** for the windowed/full path: compare PA-managed bookings expected in the window that carry a `googleEventId` against the IDs Google actually returned; a booking whose mirror event is absent → owner-deleted → route through the existing **gated `applyOwnerCancellations`** (blast-radius + customer/owner notify). This closes pre-existing bug A for good.
- **Guarded by C0.1** — the booking-diff may treat an event as deleted ONLY when the window was fetched completely and the returned set is not implausibly empty; otherwise abort (a partial response must NEVER mass-cancel real bookings and fire wrong cancellation WhatsApps). This guard is the single most dangerous thing in the whole plan — a bug here spams customers with false cancellations.
- Backend job only — the booking-diff runs owner-wins **notifications**, so it must **never** be on a passive customer read (that's why T2.1 is additions-only).
- `CALENDAR_RECONCILE_TICK_MS` (default **10 min**, single tunable env knob; disable by unsetting).
**Failing tests first:** (a) owner frees a booked 1v1, push dropped, token still valid → tick's incremental pull → tombstone → booking `cancelled` → slot open. (b) owner frees a booking, push dropped, token **expired** → windowed pull + booking-diff detects the absent mirror → gated cancel → slot open (the pre-existing-bug-A repro). (c) Google returns empty-but-200 for a window holding 5 mirrored bookings → **zero cancellations** (the C0.1 catastrophe repro). Within-window assertions use a mocked clock/tick.
**Regression guard:** gated by `isInboundSyncEnabled()` (no-op when off); syncToken reuse (no full-scan storm); blast-radius gate still fires for multi-booking frees; the C0.1 guard prevents partial-response mass-cancellation.

> **PHASE 2 REVIEW — 2 reviewers + Phase-0 telemetry:** confirm from the decision log (not inference) that G1/G2 close via read-reconcile and A2 closes via the tick; confirm no notification ever fires from the Branch-4 read path.

---

## Phase 3 — repro lock-in (the transcript-encoding tests that can never silently regress)

One failing-first repro per canonical case, each asserting **engine ground truth** (the internal record), never a live Google read:
- **G1** owner-adds Sun 19:00 Pilates → answerable + bookable class.
- **G2** owner-adds a class on an otherwise-empty day → day no longer reported empty.
- **A2** owner-frees a booked 1v1 → slot open, PA says open (via tick under dropped push).
- **PRIVACY** owner-adds "dentist"/personal event → stays opaque block, never surfaced as a class, title never leaked.
- **WEAK** owner-adds a title matching an appointment-mode service → occupies but not auto-bookable; owner-confirm enqueued.
- **ECHO** our own mirrored class comes back on the next pull → ignored (etag/paManaged), not double-imported.

---

## Non-negotiables (carried from the design conversation)

- **Internal DB stays the single source of truth.** Google is only ever an inbound translator; the PA reads the internal record at answer time. No read path may claim a slot's state that diverges from the booking/blocks record.
- **Decision #10 preserved.** Owner-created events surface **only** as a service the business already defined (via the title→service match); a personal event that matches no service stays an opaque block and its title never leaks.
- **No booking-engine change.** Materialized classes ride the existing `type='class'` block path.
- **No new LLM authority.** All owner notes / confirms are code templates (Gate-4 owns phrasing).
- **No notification side effect from a passive read.** Booking cancellation (A2) stays on push + the backend tick, never on Branch-4 reconcile-on-read.
- **Verification asserts engine truth as of the event** (audit_log + record reconstruction), never a present-time SELECT; never trust a code-trace claim without confirming it in schema/data.

## Build order
1. **Phase 0** (telemetry) — unblocks verification of the rest.
2. **Phase 1** (classifier + class materialization) — the core capability (G1/G2).
3. **Phase 2** (read-reconcile for G1/G2, tick for A2) — freshness guarantees.
4. **Phase 3** (repro lock-in) — folded into each phase's TDD, consolidated here.

Each phase is a separate build session with its own review gate; no phase merges to `main` with a red suite or an unreviewed gate change. Deploy via `/update-agent` only after Phase reviews pass.

## Open items the build must resolve (not blockers)
1. Confirm the exact normalization needed for Hebrew service-title matching against real `service_types.name` values (niqqud, spacing, "ערב"/"בוקר" suffixes) before locking T1.1's matcher; keep it exact-normalized first, defer fuzzy behind its own tests.
2. Confirm the default capacity source for a strong-match import: service `maxParticipants` vs. the modal capacity of that service's existing class instances — pick one, document it.
3. Tune `CALENDAR_RECONCILE_TICK_MS` (default 10 min) against Google API quota once a real connected business exists; the knob is a single env var so cadence is ops-tunable without a deploy of logic.
