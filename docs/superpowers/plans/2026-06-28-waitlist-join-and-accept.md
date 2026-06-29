# Waitlist — Join & Accept (the missing front door)

> **Status:** PLAN ONLY — no code yet. Author: design session 2026-06-28.
> **Hard constraint:** this work must not perturb the in-flight `pa-hardening-master-plan.md`
> (WS1–WS9). It touches two of the most-serialized hot files in that plan
> (`customer-booking.ts`, `client.ts`) and therefore **sequences AFTER** the hardening
> hot-file chain — it does not run concurrently with it. See "Coherence with hardening" below.

---

## 1. The gap (verified 2026-06-28)

The waitlist **consumption** side is fully built and is being hardened right now:

- Table `waitlist` (schema.ts:702) already stores everything the feature needs: `customerId`
  (→ name via `identities.displayName`, phone via `identities.phoneNumber`), `serviceTypeId`,
  `slotStart`/`slotEnd`, `status ∈ {pending, offered, accepted, expired}`, FIFO `createdAt`,
  unique `(businessId, slotStart, customerId)`.
- FIFO offer/expire worker (`workers/waitlist.ts`), atomic CAS promotion (T1.6), cold-fill cascade.
- Freed-slot trigger wired into cancel (`engine.ts` → `handleFreedSlot`), owner-approval gate
  (`ask`/`auto`/`never` via `freedSlotApprovals`), manager approve/decline/set-policy tools.
- Durable send (T1.10) for all initiation messages.

**Missing — confirmed by grep (zero hits):**

1. **JOIN** — nothing inserts into `waitlist`. No customer can get onto a list.
2. **ACCEPT** — nothing binds a customer's "yes" to their outstanding `offered` row, flips it to
   `accepted`, or creates the booking. The TTL "hold" is notional — the freed slot is not actually
   reserved during the offer window, so it can be taken by anyone in those 15 minutes.

This plan builds only those two paths. Everything downstream is reused as-is.

---

## 2. Scope (V1)

**In scope**
- Customer asks to (or is offered to) join the waitlist for a **specific, concrete slot** that is
  full — a fully-booked class instance, or a taken appointment time.
- Capture: name + phone (already on the identity), desired service + slot, position is FIFO by
  `createdAt`.
- Accept: a customer who receives an offer can take it conversationally ("yes", "I'll take it").
- Confirmations: "you're on the list / position kept", "the spot is yours", "the window passed".
- Owner visibility: owner can see who is waiting for a slot (read-only) via Branch 3.

**Out of scope (V1 — defer)**
- **Flexible / fuzzy waitlists** ("any Tuesday evening", "the next free haircut"). V1 is per-concrete-slot
  only — that is what the table models. Fuzzy matching is a V2 schema + matcher problem.
- Cross-slot auto-migration ("waitlist for 18:00, accept 19:00").
- Paid waitlists / deposits to hold a place (PAY* is out of scope per owner).
- Owner-initiated "add this person to the waitlist" from Branch 3 (nice-to-have, fold in later).

---

## 3. The two paths

### Path A — JOIN (customer → waitlist row)

**Trigger surfaces (two ways in, one code path):**
1. **Prompted** — when the booking flow determines the requested concrete slot/class is genuinely
   full, the lead-protection helper offers the waitlist as the *escalation terminus* (see coherence
   note: this is the `T2.3` "substitute or escalate, never dead-end" hand-off). PA: *"That class is
   full — want me to keep your place in line and message you the moment a spot opens?"*
2. **Explicit** — customer says "put me on the waitlist" / "תכניס אותי לרשימת המתנה". Detected as a
   new intent flag (`joinWaitlist`), resolved against the slot in context.

**Resolution rules:**
- Must resolve to one concrete `(serviceTypeId, slotStart, slotEnd)`. If the customer hasn't named a
  concrete full slot, the PA asks which session — reuse the normal day/slot resolution, then confirm
  *"this one?"* before inserting. No fuzzy rows.
- The slot must actually be full. Re-check capacity at insert time (fresh spine) — never waitlist a
  slot that has open seats; book it instead.
- Identity: the customer already has an identity row (Branch 4 guarantees it). If `displayName` is
  null, capture the name first (reuse the existing name-capture path) so the owner has a name to see.

**Insert (idempotent):**
- `INSERT INTO waitlist (...) VALUES (...) ON CONFLICT (businessId, slotStart, customerId) DO NOTHING`
  — the unique index already exists; a repeat "add me" is a no-op, PA replies "you're already on it,
  position N." Status starts `pending`.
- Audit `waitlist.joined`.
- Confirm via `enqueueMessage` (durable, per T1.10), in the customer's language, voice-gate compliant.

**No schema change required for Path A.** The table already has every column.

### Path B — ACCEPT (offer → booking)

This is the real engineering. Today an offer flips the row to `offered` and sends a message, but the
customer's "yes" has nothing to bind to, and the slot isn't held.

**Binding the "yes" — reuse the hardening's pending-decision primitive (`T3.2`).**
When the offer is sent, set a `pendingDecision { kind: 'waitlist_offer', waitlistId, slotStart,
serviceTypeId }` on the customer's booking-flow context (or resolve it on the next turn by looking up
the customer's live `offered` row whose `offerExpiresAt > now`). On the customer's next turn, *before*
fresh intent extraction, a yes/no-shaped reply binds to that offer:
- **Accept** → claim path below.
- **Decline / silence** → leave to the existing `expire_offer` job; optionally flip to `expired`
  immediately on an explicit "no thanks" and cascade to the next in line right away.

**The claim must go through the real booking engine — never a side-write.** A waitlist accept is just
a booking, so it must inherit every WS1 atomicity guarantee:
- Take the canonical-block advisory lock (group) / private advisory lock (`T1.1a`/`T1.2`).
- Re-validate the slot is bookable (`isSlotBookable`, capacity) inside the lock (`T1.5` semantics).
- Create the booking through the normal engine entry, not a bespoke insert.
- On success: `UPDATE waitlist SET status='accepted' WHERE id=? AND status='offered' RETURNING` (CAS,
  mirrors `T1.6`); only the row that flips proceeds. Audit `waitlist.accepted`.
- On capacity-lost race (someone else took the seat in the window): tell the customer warmly it just
  went, and **re-offer to keep them on the list / cascade to next** — never a dead-end.

**The "hold" model — DECIDED: genuine hold (B2).** When an offer goes out, the offered customer's
seat is *actually reserved* for the window — the PA's "I'm holding it for you 15 minutes" is true.

- On offer, create a real `held` booking for the offered customer (state `held`,
  `holdExpiresAt = offerExpiresAt`) so the seat is reserved for them during the window. This is
  created in the **same transaction / under the same lock** that flips `waitlist pending→offered`,
  so the offer is never sent for a seat we failed to reserve, and the seat is never reserved without
  the row flipping (mirror the T1.6 CAS + T1.10 "ledger only on confirmed reservation" discipline).
- **Accept** = confirm the hold (`held → confirmed` via the `T1.5` CAS, re-validating blocks/capacity)
  + flip `waitlist offered → accepted` (CAS). Both flip or neither does.
- **Expire / decline** = the existing hold-expiry worker frees the `held` booking (`T1.7` CAS, which
  already refuses to clobber a confirming booking); the `expire_offer` job flips the waitlist row and
  cascades to the next in line. The two expiries must be reconciled so the seat is freed exactly once
  and the cascade fires once (see Q5 / WL-7 acceptance).

This reuses the *entire* hold machinery WS1 just made bulletproof rather than inventing a parallel
reservation concept. Cost, accepted: the offer path now writes a `held` booking, so the freed-slot
and owner-approval flows must create the hold at offer time, and the offer worker
(`workers/waitlist.ts`) gains a booking write under the canonical-block lock.

---

## 4. Coherence with the hardening plan (do-no-harm)

This is the part that matters most. Every point below is a constraint, not a preference.

1. **`customer-booking.ts` is single-writer through Phase 1.** Both Path A's offer/explicit-join
   branch and Path B's accept-binding live here. **This work starts only after the Phase-0 hot-file
   chain (WS2 → WS3 → WS-VOICE) and the Phase-1 `customer-booking.ts` tasks (T6.x/T9.3) have landed.**
   Running concurrently guarantees merge conflicts and risks regressing the determinism/voice gates.

2. **Build ON `T2.3`, not beside it.** WS2-T2.3 creates the single lead-protection helper
   ("substitute or escalate, never dead-end") whose final rung is explicitly *"then waitlist/owner
   hand-off when truly empty."* Path A's *prompted* join hooks into **that** escalation terminus.
   Do not add a competing "is it full?" branch — extend T2.3's helper. **Hard dependency: T2.3 must
   land first.**

3. **Intent flag follows the `T3.1` discipline.** Adding `joinWaitlist` to the extractor means:
   add the Zod field, **add it to the JSON output template at `client.ts:150-172`** (the documented
   root-cause omission), and **branch on `undefined` not silent-false** (no `.default(false)`).
   `client.ts` is serialized (T3.1 before WS5) — sequence this after T3.1.

4. **Accept binding reuses `T3.2`'s `pendingDecision`.** Do not build a parallel waitlist mini-state
   machine in the flow. The `waitlist_offer` decision kind is one more entry in the typed
   pending-decision union T3.2 introduces. **Hard dependency: T3.2 must land first.**

5. **All sends are durable (`T1.10`).** Join confirmation, accept confirmation, "it just went" — all
   via `enqueueMessage`, never raw `sendMessage().catch()`.

6. **The accept booking goes through the hardened engine** (advisory lock + CAS + re-validate:
   T1.1a/T1.2/T1.5). A waitlist accept must not be a back-door write that bypasses capacity atomicity.
   If B2 (genuine hold) is chosen, it reuses T1.5/T1.7 directly.

7. **Voice gate (WS-VOICE) applies** to every new customer-facing string (join offer, confirmation,
   "spot is yours", "window passed", "it just went"). No IVR menus, one question, always a next step,
   He+En golden assertions. If WS-VOICE has landed, these strings must pass its detectors; if T-V.5
   lands, they're linted in CI.

8. **Migration discipline (`A2`).** Path A needs **no** schema change. Path B (genuine hold) needs no
   new table — it reuses `bookings.state='held'` — but **does need a provenance link** so accept can
   find the right held booking and so the new capacity-overrun invariant (INV-11, already committed)
   doesn't misread a waitlist hold as an overrun: add `waitlistId` (FK → `waitlist.id`) on `bookings`,
   or symmetrically `heldBookingId` on `waitlist`. This is one nullable column, no backfill of
   existing rows needed (all existing rows are simply null), but it still **serializes behind the
   one-migration-at-a-time rule** (A2) — generate it when no other WS1/Phase-1 migration is mid-flight,
   commit before the next. Verify the addition against the read-only prod snapshot first.

**Net:** Path A is almost entirely additive and low-risk. Path B leans on WS1's hold/CAS work (and adds
one nullable provenance column), which is the *reason* to wait for it to land rather than fight it.

---

## 5. Decisions (resolved — defaults applied, owner may veto Q2–Q5)

- **Q1 — Hold model. DECIDED: genuine hold (B2).** "We're holding it 15 min" actually reserves the
  seat via a real `held` booking. See §3 Path B and WL-7.
- **Q2 — Auto-offer default for full classes. DEFAULT: always offer the waitlist** when a slot/class
  is genuinely full (it's the non-dead-end escalation rung of T2.3). Joining a list is the customer's
  choice and is *not* governed by `freedSlotOfferPolicy`; that policy still governs only whether a
  *freed* slot is offered back out (ask/auto/never).
- **Q3 — Position transparency. DEFAULT: tell them their position on join** ("you're 2nd in line"),
  do not promise it stays fixed. No live position-tracking surface in V1.
- **Q4 — Appointment slots. DEFAULT: exact requested time only.** For private appointments the slot
  is the exact requested time, not a range. Ranges = the deferred fuzzy-waitlist (V2).
- **Q5 — Decline handling. DEFAULT: cascade immediately on explicit decline.** An explicit "no thanks"
  flips the offer row `expired` now and releases the `held` booking + cascades to next, rather than
  waiting out the TTL. Silence falls through to the existing `expire_offer` timer.

---

## 6. Proposed task breakdown (TDD, after the hardening hot-file chain)

> Sequence: **only after** WS2-T2.3, WS3-T3.1, WS3-T3.2, and the Phase-1 `customer-booking.ts`
> tasks have merged. These run serially on the hot files, same discipline as the hardening plan.

- [ ] **WL-1 — `joinWaitlist` intent flag.** Zod field + JSON output template (`client.ts:150-172`) +
  `undefined`-branching consumer. Follows T3.1 pattern. TEST-FIRST: an explicit "add me to the
  waitlist" extracts the flag; omission ≠ silent false. *(after T3.1)*
- [ ] **WL-2 — Join resolution + insert (domain).** New `domain/waitlist/join.ts`: resolve concrete
  full slot → fresh-spine capacity re-check → `ON CONFLICT DO NOTHING` insert → audit `waitlist.joined`.
  Capture name if missing. TEST-FIRST: full slot inserts pending; open slot routes to booking instead;
  duplicate join is a no-op. *(no schema change)*
- [ ] **WL-3 — Wire prompted join into T2.3's helper.** The "truly full/empty" escalation rung offers
  the waitlist and, on accept-to-join, calls WL-2. TEST-FIRST + VOICE GATE (He+En golden). *(after T2.3)*
- [ ] **WL-4 — Wire explicit join into the flow.** `intent.joinWaitlist` → confirm slot → WL-2.
  TEST-FIRST + VOICE GATE. *(hot-file slot)*
- [ ] **WL-5 — Genuine hold at offer time (B2 core).** In `workers/waitlist.ts`, the `pending→offered`
  flip also creates a `held` booking (`holdExpiresAt = offerExpiresAt`) for the offered customer under
  the canonical-block advisory lock, in the same atomic unit as the CAS flip — offer is sent only once
  the seat is reserved (T1.6 + T1.10 discipline). The freed-slot/owner-approval entry (`handleFreedSlot`,
  manager approve) feeds this same path. TEST-FIRST: a walk-in cannot book the seat during the window;
  if the hold can't be placed, no offer is sent and the row stays `pending`. *(serialize any schema
  touch per A2 — see below; likely a `source='waitlist'`/`waitlistId` provenance link)*
- [ ] **WL-6 — Accept binding via `pendingDecision`.** Add a `waitlist_offer` kind to T3.2's union; on
  the offer turn set it, on the next turn bind yes/no before fresh intent extraction. TEST-FIRST:
  "yes" after an offer binds to the offered row, not a new booking request. *(after T3.2)*
- [ ] **WL-7 — Accept = confirm the held booking + CAS flip.** Accept confirms the `held` booking
  (`held→confirmed` via T1.5 CAS, re-validating blocks/capacity) AND flips `waitlist offered→accepted`
  (CAS) — both or neither. On a lost race (hold already expired/clobbered), warm "it just went" +
  keep them listed / cascade. Reconcile the two expiry sources (hold-expiry T1.7 vs `expire_offer`) so
  the seat frees exactly once and the cascade fires once. TEST-FIRST: two accepts for one seat → one
  confirms, the other gets the warm fallback; expiry frees + cascades exactly once. VOICE GATE.
- [ ] **WL-8 — Explicit decline → immediate release + cascade (Q5).** "No thanks" flips offer
  `expired`, releases the held booking, cascades now. TEST-FIRST. VOICE GATE.
- [ ] **WL-9 — Owner read-side (Branch 3).** A manager tool / answer for "who's on the waitlist for
  X?" (read-only over `waitlist` + `identities`). TEST-FIRST. VOICE GATE.
- [ ] **WL-10 — Voice golden set + non-bypass.** He+En shape assertions for all new strings; if T-V.5
  exists, register them in the CI bot-tell lint.

---

## 7. One-paragraph summary for the owner

A customer who hits a full class or taken time can say "keep my place" (or the PA offers it); we store
their name, number, and the exact session they want, first-come-first-served. The moment that seat
frees up, the existing system already messages the first person in line and holds it briefly — this
plan adds the two missing halves: getting *onto* the list, and turning their "yes" into a real booking
safely. It changes no money flows, needs little-to-no new database structure, and is deliberately
sequenced to land *after* the current reliability hardening so it inherits those guarantees instead of
working around them.
