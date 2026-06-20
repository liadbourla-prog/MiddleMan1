# Calendar & CRM Bulletproofing Plan — First Live Business

**Status:** Pre-launch (days out). **Reference business:** single solo physiotherapist.
**Mission:** drive the probability of any calendar mistake toward zero. Every mistake
(double-book, lost booking, ghost/orphan, wrong time, booked into a break) is a
business-killing event for this customer.

This plan is grounded in a code audit performed on 2026-06-20. File references are to
the state of the repo at that time.

---

## 0. Reference reality (the operating envelope)

- One physiotherapist, one room, **truly solo** (no second resource).
- Hours: **Sun–Thu 08:00–20:00**, **Fri 08:00–16:00**, **Sat off**. Israel timezone (DST applies).
- **60-minute sessions, back-to-back, no inter-appointment gap** (confirmed).
- ~60 appointments/week ⇒ ~60 parallel WhatsApp relationships. Booked 1–4 weeks out.
- Same customer usually not twice a week. Constant cancels, reschedules, owner-initiated shuffles.
- Launch in **`google` calendar mode** (bidirectional sync ON).

---

## 1. Source-of-truth model (recap)

Internal system is the operational source of truth. Google Calendar is a **bidirectional
mirror**: PA write-throughs outbound; owner edits in Google are ingested inbound and
reconciled (internal-as-hub). WhatsApp is an interface, never a source of truth.

### Already guaranteed in code (the floor — verified)

| Guarantee | Where |
|---|---|
| Double-book PA-vs-PA (private): `SELECT … FOR UPDATE` overlap check in a txn | `src/domain/booking/engine.ts:212` |
| Double-book PA-vs-PA (group): `pg_advisory_xact_lock` per slot | `src/domain/booking/engine.ts:387` |
| Double-book PA-vs-owner-Google: live free/busy probe at write time (fails open) | `src/domain/booking/engine.ts:179` |
| Holds expire (15 min) + hold-expiry worker | `src/workers/hold-expiry.ts` |
| Atomic failure: calendar write failure → `failed`, never silent confirm | `src/domain/booking/engine.ts:820` |
| Reschedule (customer): deferred-cancel — old slot freed only after new commits | `src/domain/flows/customer-booking.ts:1142` |
| Reshuffle (owner): approval-required gate; nothing written until approve | `src/domain/reshuffle/gate.ts` |
| Reshuffle: moved-customer confirmation; hedge never becomes a yes | `src/domain/reshuffle/outreach.ts:50` |
| Reshuffle: atomic apply with stale-plan re-validation | `src/domain/reshuffle/executor.ts:58` |
| Inbound Google sync machinery (route, watch, renewal, etag loop-prevention, blast-radius gate) — **built, flag-gated OFF** | `src/domain/calendar/inbound-sync.ts`, `src/routes/calendar-webhook.ts` |
| Per-conversation pause/resume (owner takeover primitive) | `src/adapters/llm/orchestrator.ts:303`, `src/domain/flows/customer-booking.ts:371` |
| Full audit trail of every state change | `src/domain/audit/logger.ts` |

---

## 2. Failure-Mode Catalog (the spine)

Every catastrophic outcome maps to **(a)** a preventive guard, **(b)** a Sentinel
invariant that detects it after the fact, and **(c)** a pre-launch test that proves it.
This catalog is the contract — finalize it with the owner (open item #9).

| # | Failure mode | Preventive guard | Sentinel invariant | Pre-launch test |
|---|---|---|---|---|
| F1 | Double-book (PA vs PA) | FOR UPDATE / advisory lock ✓ | INV-1 overlap | concurrent same-slot race |
| F2 | Double-book (PA vs owner's Google edit) | write-time free/busy ✓ + inbound sync (WS-A) | INV-3 orphan/collision | owner creates event in Google, then customer books |
| F3 | Ghost (confirmed in PA, gone from Google) | inbound sync owner-wins reconcile (WS-A) | INV-2 ghost | owner deletes a PA event in Google |
| F4 | Orphan (in Google, PA blind to it) | inbound sync imports as busy-block (WS-A) | INV-3 orphan | owner creates personal event in Google |
| F5 | Wrong time told to customer | tz snapshot at creation ✓ | INV-5 time-match | owner drags an event in Google |
| F6 | Booked into a break / day off | spatial `isSlotBookable` ✓ + break blocks (WS-E) | INV-4 hours/break | try to book during the modeled break |
| F7 | Reminder for a cancelled/moved slot | `cancelReminders` on cancel ✓ | INV-6 reminder-validity | cancel, then inspect pending reminders |
| F8 | Stuck hold blocking a real booking | hold-expiry worker ✓ | INV-7 stuck-hold | abandon a booking mid-hold |
| F9 | Reschedule loses both / keeps both | deferred-cancel ✓ | INV-8 reschedule-residue | reschedule onto an already-taken slot |
| F10 | Lost booking (silent failure) | `markFailed` rollback ✓ | audit scan for `failed` | force a calendar-API failure |
| F11 | Wrong-person attribution (session for a child) | beneficiary field (WS-D) | n/a (CRM) | book "for my daughter Noa" |
| F12 | Unapproved offer sent to a customer | owner-approval gate (WS-C) | audit scan | cancel a slot with someone waitlisted |

Legend: ✓ = exists today. WS-x = workstream below.

---

## 3. Workstreams

Priority: **P0** = before go-live. **P1** = first update. **P2** = fast-follow.

### WS-A · Turn Google bidirectional sync ON (P0)

The machinery is built; this is ops + verification, not new feature code.

1. **Verify the receiving domain with Google** (Search Console + authorized domain on
   the GCP project). This is the long-pole gate — start immediately.
2. Set `CALENDAR_WEBHOOK_ADDRESS` to the live Cloud Run URL + `/calendar/webhook`.
3. Set `CALENDAR_INBOUND_SYNC_ENABLED=1`.
4. **Confirm at server startup**: `calendar-webhook` route is registered, and the
   `calendar-sync-renewal` 6h cron is scheduled. (Audit task — verify in the bootstrap.)
5. Register/refresh the watch channel for the connected business (auto on OAuth connect;
   for an already-connected business call `registerWatchChannel`).
6. **Validate the owner-wins blast-radius gate** (`BLAST_RADIUS_THRESHOLD = 2`): a bulk
   owner change touching >2 bookings must *ask before cancelling*, not auto-cascade.
7. Confirm etag loop-prevention (our own write-backs don't re-trigger as inbound edits).

Closes/strengthens: F2, F3, F4, F5.

### WS-B · Integrity Sentinel — live verification layer (P0)

A cron worker running **every 2 hours** that independently proves no calendar mistake
exists. It is the second, independent observer — it catches the case where inbound sync
*itself* silently failed (dropped push, expired token, reconcile error). Sync corrects;
the Sentinel verifies the correction happened. Defense in depth.

**Build:**
- New worker `src/workers/integrity-sentinel.ts` (pattern: `calendar-sync-renewal.ts`),
  `REPEAT_EVERY_MS = 2h`, iterate live businesses.
- New table `integrity_findings` (open/resolved tracking for dedup + the on-demand report).
- Per business, load internal bookings + blocks + availability spine for `[now−1d, now+90d]`
  and the matching Google events; run the invariants:

| Invariant | Check | Catches |
|---|---|---|
| INV-1 | no two active bookings overlap (solo) | F1 |
| INV-2 | every confirmed booking's `calendarEventId` resolves to a live Google event at the same time | F3 ghost |
| INV-3 | every Google event in working hours maps to a PA booking or a known block | F2/F4 orphan/collision |
| INV-4 | no active booking outside availability or inside a break block | F6 |
| INV-5 | booking `slotStart/End` exactly matches the Google event start/end | F5 |
| INV-6 | every pending reminder points at a still-active booking at its current time | F7 |
| INV-7 | no `held`/`pending_payment` past expiry still occupying a slot | F8 |
| INV-8 | no booking with `rescheduledFrom` whose source row is still active | F9 |

**Action by severity:**
- **Auto-remediate the safe ones** silently + log (expire stuck holds, cancel orphaned reminders).
- **Alert BOTH owner and operator (Branch 1)** on dangerous findings (double-book, ghost,
  orphan collision, time mismatch) with a specific human-readable description + suggested action.
- **Auto-quarantine the specific contested slot** on a live collision: block *new* bookings
  into that exact slot while awaiting a human. **Never auto-cancel** — cancellation always
  goes to a human.
- **Dedup:** only notify on *new* or *resolved* findings; never re-spam the same issue every 2h.
- **Powers the on-demand "is everything correct right now?" command** (WS-F) — that command
  reads the latest Sentinel state rather than recomputing.

Closes/detects: F1–F10 (detection layer for the whole catalog).

### WS-C · Owner-approval gate on freed-slot offers (P0)

Today `cancelBooking` auto-fires the waitlist (`engine.ts:701 → triggerWaitlistForSlot`)
with no owner approval. Required behavior:

1. On a slot freeing (cancel / switch), the PA does **not** auto-offer.
2. **First time** this situation occurs for a business, the PA asks the owner **both**:
   "Want me to offer this freed slot to the waitlist?" *and* "Want me to handle these
   automatically from now on?"
3. Persist the answer as a **per-business standing preference** (gate = default until he
   opts into automatic). Reuse the reshuffle approval-gate pattern (`reshuffle/gate.ts`)
   and a preference store (e.g. `managerMemory` / business config).
4. Reshuffle/switch path already has this gate — align the two so the behavior is uniform.

Closes: F12. Implements: #6/#8.

### WS-D · Beneficiary attribution (P1)

"This session is for my daughter Noa" must be recognized, remembered, and surfaced.

1. Add a structured beneficiary field at the booking level (and/or per-contact via
   `businessContacts`).
2. The customer must declare it ("not for me"); the PA stores it.
3. Inject the beneficiary name into reminders and confirmations ("Reminder: Noa's
   appointment tomorrow at 10:00").

Closes: F11. Implements: #7.

### WS-E · Calendar reality at provisioning (P0 — config, not code)

1. Model working hours: Sun–Thu 08:00–20:00, Fri 08:00–16:00, Sat off.
2. **Break time**: the owner tells the PA his break; it becomes a recurring `calendar_block`
   so the engine's spatial guard refuses bookings into it (F6).
3. Confirm 60-min back-to-back, **no inter-appointment buffer**.
4. Confirm DST handling for Israel across the booking window.

### WS-F · Takeover & verification hardening (P1)

1. **Proactive handoff**: when a customer is clearly frustrated or asks for a human, the PA
   offers/performs the handoff and notifies the owner — takeover shouldn't depend on the
   owner watching. (Escalation rules exist; make the handoff active.)
2. **On-demand integrity command**: a one-tap "is everything correct right now?" answered
   from the latest Sentinel state.
3. **Launch path = Meta Business Suite inbox** + `conversationPausedUntil` pause to prevent
   the PA and the human talking over each other.

### WS-G · Launch-day initial state (P0)

1. Load the existing ~60 appointments into the internal system (owner-supplied).
2. Reconcile against Google so internal and Google agree on day one.
3. Run the Sentinel once to certify a **clean baseline** before the first customer message.

### WS-H · Proactive outreach scope (P1)

In-scope at launch: **waitlist fill** (gated, WS-C) and **switch assistance** (reshuffle,
already gated). Add: per-customer **frequency cap** (never spam) and **opt-out**. Reminders
already exist; this layer is the proactive re-engagement on top.

### WS-I · Coexistence enablement (P1 — "first update")

Coexistence requires being a **Meta Tech Provider** (confirmed against Meta docs, June 2026).
Work:
1. **Meta Business Verification** (bureaucratic lead time — start now). Lifts onboarding cap
   from 10→200 customers / 7 days after verification + app review + access verification.
2. **Embedded Signup (coexistence variant)** via Facebook Login for Business — new build; the
   owner pairs his existing WhatsApp Business App number to our Cloud API app.
3. **Extra webhook subscriptions**: `smb_app_state_sync` (contacts) and `smb_message_echoes`.
4. **Wire `smb_message_echoes` into auto-pause**: when the owner replies from his own WhatsApp,
   the PA auto-silences for that conversation — "human jumped in, PA backs off" with no manual
   command. This is a *safety* upgrade, not just UX.
5. Onboarding constraints to document: Business App ≥ 2.24.17; owner must open the Business App
   ≥ once / 13 days to keep sync alive; unofficial integrations get disabled on onboarding.

---

## 4. Pre-launch test gauntlet (P0)

Run against staging before go-live. Each scenario maps to a failure mode; all must pass.

1. **Concurrent same-slot race** (F1) — two customers confirm the same slot simultaneously.
2. **Owner creates event in Google, then customer books that slot** (F2).
3. **Owner deletes a PA-booked event in Google** (F3) → reconcile + owner alert.
4. **Owner creates a personal event in Google** (F4) → imported as busy-block.
5. **Owner drags an event to a new time in Google** (F5) → internal time updated / flagged.
6. **Book during the modeled break** (F6) → refused.
7. **Cancel, then inspect pending reminders** (F7) → none point at the cancelled slot.
8. **Abandon a booking mid-hold** (F8) → hold expires, slot frees.
9. **Reschedule onto an already-taken slot** (F9) → original kept, replacement refused.
10. **Force a calendar-API failure during confirm** (F10) → booking → `failed`, customer told.
11. **Book "for my daughter Noa"** (F11) → attribution stored + surfaced in reminder.
12. **Cancel a slot with someone waitlisted** (F12) → owner asked first, no auto-offer.
13. **Cancel within the 24h cutoff** → refused with the configured message.
14. **DST boundary booking** (Israel) → correct wall-clock time preserved.
15. **Sentinel end-to-end**: inject each defect directly in the DB/Google and confirm the
    Sentinel detects, alerts both parties, auto-quarantines the slot, and dedups.

---

## 5. Sequence (days before launch)

1. **Day 1 (now):** start Meta Business Verification (WS-I), start Google domain verification
   (WS-A). Both have external lead time.
2. **Build P0:** WS-B Sentinel, WS-C approval gate. Verify WS-A wiring at startup.
3. **Provision (WS-E) + load initial state (WS-G).**
4. **Flip WS-A flags** once domain verified; register watch channel.
5. **Run the full gauntlet (§4).** All green.
6. **Run the Sentinel once for a clean baseline (WS-G.3).**
7. **Go live.** WS-D, WS-F, WS-H, WS-I land in the first update.

---

## 6. Open items

- **#9 — finalize the Failure-Mode Catalog (§2)** with the owner: confirm F1–F12 is complete
  and nothing is missing. This catalog is the contract every guard/invariant/test answers to.
- **Coexistence go/no-go for the first update** (WS-I) once Business Verification timeline is known.
- Confirm whether the owner ever needs an inter-appointment buffer later (currently none).
