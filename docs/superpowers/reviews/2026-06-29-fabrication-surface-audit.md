# Fabrication-Surface Audit — Generalized Anti-Fabrication Sweep

**Status:** complete · **Type:** read-only audit (no code changed) · **Date:** 2026-06-29 · **Owner:** Developer A
**Method:** doctrine prime (`ANTI_FABRICATION.md`, the hardening master plan, the three-symptom plan) + 5 parallel read-only research sweeps over Branch 4 (`customer-booking.ts`, the three gates), Branch 3 (`orchestrator.ts`, `client.ts`, `reply-guard.ts`), the escalation/relay round-trip, business-fact grounding, and every worker/proactive/initiation/i18n send path.
**Companion:** extends `2026-06-29-three-symptom-remediation-plan.md` (S1/S2/S3) and `2026-06-28-pa-hardening-master-plan.md`. The three confirmed symptoms are instances of the disease swept here; this audit maps the rest of the surface.

---

## 0. The disease, restated

> The conversational/LLM layer is permitted, in some paths, to **assert a fact, an availability state, or a completed/promised action that the deterministic core never produced and cannot verify.** Wherever a reply can state something as true or done without a deterministic source backing it — or a prompt instructs the model to promise/claim such a thing — that is a fabrication hole, even if no current test trips it.

The existing doctrine ships **three output gates, all in Branch 4's `makeGenReply`**, plus a Branch-3 action-claim auditor:

- **Gate 1** — phantom booking-claim (`assertsBookingConfirmed`, `reply-guard.ts:46`).
- **Gate 2** — fabricated clock time (`findUnbackedTimes`, `slot-fabrication-guard.ts:134`).
- **Gate 3** — occupancy/fullness (`assertsNoAvailability` + fresh-spine, `slot-fabrication-guard.ts:125` + `customer-booking.ts:802`).
- **Branch-3 L2 auditor** — `auditReplyClaims → detectActionClaims` (`orchestrator.ts:1002`, `reply-guard.ts:102`), four action-claim classes only.

**The asymmetry this audit exploits:** no gate anywhere covers **actions-taken beyond booking** (cancelled / waitlisted / relayed / escalated / messaged), **schedule-empty availability**, **business-fact/knowledge claims**, **third-party claims**, or **future commitments**. Branch 3 has **no availability gate at all**. Every worker/proactive send bypasses all gates. The voice gate is monitor-only (`voice-guard.ts:221` returns the draft byte-for-byte). Those uncovered cells are where the holes live.

---

## 1. Hole register (confirmed holes only)

Assertion classes: **A** action-taken · **B** availability/calendar · **C** business-fact/knowledge · **D** third-party · **E** future-commitment · **F** state/continuity.
Levers (per `ANTI_FABRICATION.md` §7): **source-truth** (grounding/re-read) · **output gate** · **new capability**.

| id | branch | file:line | class | example false claim | backing? | severity | lever |
|---|---|---|---|---|---|---|---|
| **H1** | 3 (orchestrator) | `orchestrator.ts:1002-1044` (auditor) · phrasing at `:1245-1257`; prompt `:781` | B | "Tuesday 14:00 and 16:00 are free" / "you're fully booked Wednesday" / a stale time re-asserted from transcript — none spine-checked | **N** (no time/occupancy gate exists in Branch 3 at all) | **CRITICAL** | output gate (port Gate 2/3) + source-truth |
| **H2** | 4 + global | `client.ts:382`; `customer-booking.ts:874`; echoed `:1321`, `:2493` | A+E | "I don't have that — I'll check with the business / they'll get back to you," when no owner message is dispatched and no relay-back state exists (S3) | **N** | **HIGH** | new capability (relay round-trip) + source-truth (de-fabricate prompt) |
| **H3** | proactive/worker | `workers/waitlist.ts:312` (situation) · `:306`/`t.ts:624` (template) | B+A | "A spot just opened on Sun 13:00 — I'm holding it for you for 15 min," when the slot was retaken after the freeing event and **no hold was placed** | **N** (no `isSlotBookable`/capacity re-read in `processJob`; only the waitlist row is flipped `offered`) | **HIGH** | source-truth (fresh-spine re-validate before send) + new capability (real hold) |
| **H4** | 3 (coordination) | `orchestrator.ts:953-982` (no mapping) · `coordination-tools.ts:185` (`success:true, partial:true`) | A+D | "I texted Harel the times," when the send was deferred because the contact is outside the 24h window (`partial:true` would *back* the claim if mapped) | **N** | **HIGH** | output gate (extend `actionsFromToolResult`/`detectActionClaims`; `partial` must not back) |
| **H5** | 3 (coordination) | `orchestrator.ts:953-982` (no `resolveMeetingCoordination` map) · `coordination-tools.ts:214` (`{success:true}`); prompt-only guard `:811-812` | D | "He confirmed Tuesday 14:00, I've booked it," asserting the counterparty replied/agreed when no tool read their message this turn | **N** | **HIGH** | output gate (new third-party claim class) + source-truth |
| **H6** | 4 (Gate 3) | `slot-fabrication-guard.ts:107-124` (`NO_AVAILABILITY_RE`) | B | "There are no yoga classes on Sunday" (schedule-empty) when the day has classes — `assertsNoAvailability` matches only **capacity-full** phrasing, so Gate 3 never fires (S2) | **partial** (gate blind to this phrasing → fresh-spine never runs) | **HIGH** | output gate (broaden detector, windowed) |
| **H7** | 4 (`makeGenReply`) | `customer-booking.ts:770` (only Gate 1 runs); `reply-guard.ts:46` vs unused `:102` | A | "I cancelled your class" on the cancel-**failure** path (`:3199`) / no-bookings path (`:2857`); "I added you to the waitlist" — Gate 1 covers booking-made only; `detectActionClaims` (cancel/message/waitlist) is **never wired into Branch 4** | **N** | **HIGH** | output gate (Gate 4 — wire `detectActionClaims` into `makeGenReply`) |
| **H8** | proactive/worker | `i18n/t.ts:841-844` (`pa_paused_customer`) | E | "We're not available right now — we'll be in touch shortly," when a paused PA queues **no** task, creates **no** escalation, schedules **no** callback | **N** | **MED** | source-truth (correct/remove the claim) |
| **H9** | 3 (orchestrator) | `actionsFromToolResult:976-978` (collapsed to `cancelled`); `reply-guard.ts:102` (no settings patterns) | A | "I set the price to ₪200 / I made Yoga blue," emitted after a `manageBusinessSettings` `success:false`/`clarificationNeeded` result (`:1214`) | **N** (prompt-only guard `:802`) | **MED** | output gate (extend claim classes + tool-result map) |
| **H10** | 3 (orchestrator) | `actionsFromToolResult:958-962` (no `refundTransaction` map); `reply-guard.ts` (no refund/charge patterns) | A | "I refunded Dana ₪300," when `executeRefundPayment` returned `ok:false` | **N** (prompt-only `:793`) | **MED** | output gate |
| **H11** | 3 (orchestrator) | `executeBroadcastAnnouncement` (`orchestrator-tools.ts:2612`), unmapped; no detector | A | "I let all your customers know about the new hours" / inflated send count, when the broadcast partially failed | **N** (prompt-only `:449`) | **MED** | output gate |
| **H12** | proactive/worker | `i18n/t.ts:800-803` (`calendar_owner_reconcile_applied`) | A+D | "The affected customers have been notified," when the downstream notify sends are best-effort `.catch(()=>{})` (`booking-notify.ts:136`) and may have failed | **partial** (cancel count real; "notified" unverified) | **MED** | output gate (assert on confirmed dispatch count) |
| **H13** | 4 (`buildBusinessFacts`) | `customer-booking.ts:874` | C+E | unknown-instructor branch instructs "say you will check with the business" — a relay promise with no dispatch (the H2 inducer, instructor variant) | **N** | **MED** | new capability (relay) + source-truth (de-fabricate) |
| **H14** | 4 (bundled confirm) | `customer-booking.ts:2493` | E (+B) | "I'll check with the studio rather than guessing" on a bundled post-confirm side-question — relay never queued; availability vector un-focusDay'd for non-weekday questions (e.g. "next month") | **partial** (Gate 3 covers weekday-resolvable occupancy via `:2497` focusDay; relay claim ungated) | **MED** | new capability (relay) + output gate |
| **H15** | 4 (inquiry/FAQ) | `customer-booking.ts:850-880` (`buildBusinessFacts`), `:1419` | C | "Apparatus Pilates uses reformers; mat is floor-based," interpolated from general knowledge when the owner authored no FAQ — closed-world grounding blocks *new services/prices*, not *attributes of existing ones*; no class-C output gate | **N** (grounding partial; no gate) | **MED** | source-truth (extend grounding) + new capability (relay on gap) |
| **H16** | 3 (orchestrator) | `actionsFromToolResult:957-982` (no map); `advanceFromOwner` books on `confirm` | A | inverse hole: a **true** "I put it on your calendar" reads as unbacked (needless fallback) **and** a false "booked" after `abandon` is undetectable — both coordination outcomes return `{success:true}` | **N** | **MED** | output gate (map `confirm`→`booking_made`) |
| **H17** | 3 (orchestrator) | prompt `:805-806`; no detector | E | "I'll block the rest of the days later / I'll let you know when he replies," when no background job exists | **N** (prompt-only) | **LOW-MED** | output gate |
| **H18** | proactive/worker | `workers/waitlist.ts:106` (cold-fill situation), `:108-109` | B | lapsed-customer invite to "a spot just opened" that FIFO already failed to fill (runs *after* FIFO exhaustion, more time elapsed) | **N** (same no-revalidation as H3) | **MED** | source-truth (fresh-spine re-validate) |
| **H19** | 4 (inquiry) | `customer-booking.ts:1320-1336` | B | "There is nothing available," when `availabilityText` came back empty from a transient load failure / over-narrow constraint, on an **unscoped** inquiry with no `focusDay` (Gate 3 signal-a never runs; signal-b sees an empty situation) | **partial** (common case grounded; edge blind) | **LOW-MED** | output gate (focusDay on unscoped inquiry) + source-truth |
| **H20** | 3 (orchestrator) | `executeCheckCalendarIntegrity` (`orchestrator-tools.ts:1681`), unmapped; prompt `:655`,`:803` | A/B | "I checked, everything's correct," without calling the tool this turn | **N** (prompt-only) | **LOW** | output gate |

**Not holes (verified backed — reference baselines for "what backed looks like"):**
`escalateUnfulfillableRequest` "passed to {business}, someone will be in touch" (`engine.ts:112-155`, `t.ts:306-314`) — real `escalatedTasks` insert + manager notify + `HANDLED` relay surface. `reshuffle-campaign` "everyone already agreed" (`reshuffle-campaign.ts:129`) — backed by `reshuffleOffers` state machine. `dunning.ts:124`/`payment-request.ts:123` — the **only** worker-path deterministic output check (re-injects the verified `payUrl` if the LLM dropped it; the positive exemplar for a generalized gate). `provider_unavailable` reply (`customer-booking.ts:2612`) — engine-sourced name/hours. `booking_confirmed`/`payment_confirmed` templates (`t.ts:649-662`) — operate on a persisted booking row.

---

## 2. Prompt-induced fabrication (prompts that *instruct* an unbacked assertion)

These are the most dangerous because the model is *told* to make the claim — and the doctrine (§1, line 26) states prompt-only "never invent" instructions are "not a lever," so the inverse (a prompt that *induces* a claim) is reliably obeyed.

| # | file:line | scope | verbatim inducement | what's unbacked |
|---|---|---|---|---|
| P1 | `client.ts:382` | **global** Branch-4 persona | "...Say plainly you don't see that on offer and **you'll check with the business**, then steer back to what IS available." | promises a check on *any* unlisted-capability turn; no dispatch, no relay state (H2) |
| P2 | `customer-booking.ts:874` | every no-roster reply | "Instructors/staff: none on record... If the customer names one, **say you will check with the business**." | same relay promise, instructor variant (H13) |
| P3 | `customer-booking.ts:2493` | bundled post-confirm question | "If you don't have grounded info to answer, **say you'll check with the studio** rather than guessing." | honest-shaped but still an un-queued relay (H14) |
| P4 | `customer-booking.ts:1320-1321` | inquiry availability | "...If nothing is listed for what they asked, say plainly there is nothing available..." | licenses "nothing available" on an empty/failed load with no focusDay (H19) |
| P5 | `customer-booking.ts:1419` | mid-conversation unknown | "If a FAQ above answers it, answer directly..." | hands FAQ block + free rein → paraphrase/extension of a partially-stated policy (H15) |
| P6 | `orchestrator.ts:811-812` | Branch 3 coordination | "Never invent conversation history" (prompt-only) | the only guard on counterparty-reply fabrication (H5) |
| P7 | `orchestrator.ts:793` / `:802` / `:803` / `:805-806` / `:655` | Branch 3 actions | "Only say the refund went through if the tool returns ok:true" / "...don't claim you 'checked'..." (all prompt-only) | the only guard on refund/settings/integrity/future-commitment claims (H10, H9, H20, H17) |
| P8 | `orchestrator.ts:449` | Branch 3 broadcast tool desc | "...never inflate them" (prompt-only) | the only guard on broadcast send-count (H11) |

**Pattern:** the global "you'll check with the business" (P1/P2) is the literal S3 inducer — it converts every knowledge/capability gap into an unbacked action+future-commitment claim. Every Branch-3 action beyond the four detected claim classes is "guarded" by prompt-only instructions (P7/P8), i.e. ungated by doctrine's own definition.

---

## 3. Gate-coverage matrix (assertion class × branch)

Cells: **gated[symbol]** = a deterministic post-check can catch a false claim · **partial** = covers some forms, misses others · **ungated** = no deterministic check (prompt/grounding only).

| class | Branch 4 (`makeGenReply`) | Branch 3 (orchestrator) | Proactive / Worker |
|---|---|---|---|
| **A** action-taken | **partial** — Gate 1 `assertsBookingConfirmed` (booking-made + "moved" only). Misses cancel-done, waitlist-added, most reschedule paraphrases. `detectActionClaims` **not wired here** (H7) | **partial** — `detectActionClaims` (4 classes: booking/message/calendar-connected/cancelled). Misses refund (H10), broadcast (H11), settings-edit (H9), both coordination tools (H4,H16) | **ungated** — none. Backed by a DB row where one exists; "notified" side-effects unverified (H12) |
| **B** availability/time | **gated** — Gate 2 `findUnbackedTimes` (HH:MM, 24h only; misses am/pm, bare hours, dates, counts, wrong-day-but-real-time) | **ungated** — **NONE.** No time allowlist, no occupancy signal (H1, CRITICAL) | **ungated** — none; waitlist "spot opened" never re-validated (H3, H18) |
| **B** fullness (occupancy) | **partial** — Gate 3 `assertsNoAvailability`+fresh-spine. Catches **capacity-full**; misses **schedule-empty** (H6). signal-a needs a `focusDay` (H19) | **ungated** — none | **ungated** — none |
| **C** business-fact/knowledge | **ungated** — grounding only (`buildBusinessFacts` closed-world services/prices/instructors). No gate; attribute/policy invention uncaught (H15) | **ungated** — weaker grounding (`buildActiveServicesBlock`; prices/policies not closed-world); no gate (F10) | **ungated** — none (broadcast `promo` interpolates owner free-text) |
| **D** third-party | **ungated** — roster grounding only; no gate for "a guide will reply"/"owner said" | **ungated** — none; counterparty-reply fabrication (H5) | **ungated** — none; "customers have been notified" (H12) |
| **E** future-commitment | **ungated** — none (voice-guard's forward-step check *rewards* handoff phrasing, opposite of gating) | **ungated** — none (H17) | **ungated** — none; `pa_paused_customer` (H8); backed only where a state machine exists (escalation/reshuffle/coordination) |
| **F** state/continuity | **ungated (output)** — handled upstream by state-integrity fixes (`parseConfirmation 'yes_with_question'`, hold-preservation, `withIdentityLock`); no reply-level gate | **ungated** — none | n/a |
| **Gate 7 (voice)** | **monitor-only** — `observeVoiceTells` logs, returns draft byte-for-byte (`voice-guard.ts:221`); `VOICE_REGEN_ENABLED` off. Gates **no** class. | **monitor-only** (same) | **warn-only** CI lint over i18n/templates (`voice-i18n-lint`); mutates nothing |

**One-line read:** Branch 4 gates A(partial)/B(time)/B(fullness, partial). Branch 3 gates A(partial) only — **B is wholly ungated (H1)**. Proactive/worker gates **nothing**. Classes **C, D, E** are ungated in *every* branch; class **A** is gated only for "booking made."

---

## 4. Top findings (ranked)

**1. H1 — Branch 3 has no availability gate whatsoever (CRITICAL).**
`auditReplyClaims` (`orchestrator.ts:1002-1044`) calls only `detectActionClaims`, which has zero time/occupancy logic. The allowlist machinery (`buildAllowedTimes`, `findUnbackedTimes`) lives in `customer-booking.ts` and is never imported. The manager orchestrator can state "Tuesday 14:00 is free," "you're fully booked Wednesday," or re-assert a stale time from the transcript on a follow-up turn — **the exact original Branch-4 bug class, unported.** Owner-facing scheduling answers are unverified. Doctrine §3/§10 acknowledges this asymmetry; it is now the single biggest hole.

**2. H2 — Fabricated escalation: "I asked the owner / they'll get back to you" (HIGH, confirmed S3).**
Three findings compose into one structural gap: (a) **no dispatch** — a plain knowledge question matches none of the three owner-notify gates (`checkOwnerEscalationRules` needs a configured rule; `escalateUnfulfillableRequest` needs `specialArrangementRequest`; `escalateToPlatform` notifies the operator after 2+ unknowns); the inquiry case calls `genReply` directly with no escalation call. (b) **no round-trip state** — `grep` confirms zero matches for `pendingOwnerQuestion`/`awaitingAnswer`; `escalatedTasks` (`schema.ts:1072-1094`) has no "answer"/"ownerReply" column and is read only by the operator dashboard (`operator.ts:383-397`); no consumer routes an owner's Branch-3 reply back to the customer. (c) **the prompt induces the claim anyway** (P1 `client.ts:382`, P2 `:874`). Result: an unbacked class-A + class-E fabrication on every knowledge gap.

**3. H3 — Waitlist "a spot just opened — I'm holding it" never re-validated (HIGH).**
`processJob`'s `offer_slot` branch (`workers/waitlist.ts:235-336`) flips the waitlist row pending→offered (CAS, `:262-266`) and sends the offer with **no** `isSlotBookable`/capacity re-read (grep: zero availability checks in the file). Between the freeing event that enqueued the job and the worker firing, the slot can be retaken (another customer, a class re-tile, an owner block) — yet the message asserts it is free **and** "I'm holding it for N minutes" when nothing places a hold (only the waitlist row is marked). Matches the remediation plan's "wires up no session state." Cold-fill (H18) repeats it with more elapsed time.

**4. H4 + H5 — Meeting-coordination outreach & counterparty-reply fabrication (HIGH, owner-trust-critical).**
Neither `coordinateMeeting` nor `resolveMeetingCoordination` is mapped in `actionsFromToolResult` (`orchestrator.ts:953-982`), and `detectActionClaims` has no counterparty patterns. Two false claims: (H4) "I texted Harel the options" when `executeCoordinateMeeting` returned `{success:true, partial:true}` (`coordination-tools.ts:185`) because the contact is outside the 24h window — `success:true` would *back* the claim if it were mapped; (H5) "He confirmed Tuesday 14:00" asserting the counterparty replied/agreed when no tool read their message this turn. Both rest on the prompt-only "Never invent conversation history" (P6).

**5. H6 — Gate 3 detects capacity-full but not schedule-empty (HIGH, confirmed S2).**
`NO_AVAILABILITY_RE` (`slot-fabrication-guard.ts:107-124`) is entirely capacity-keyed: `מלא`/`אין מקום`/`נתפסו`/`אזל…מקומות`/"fully booked"/"sold out". The one class token, `/אין\s*שיעורים\s*פנויים/`, still requires the *פנויים* (free) suffix. Bare `אין שיעורים ביום ראשון` ("no classes on Sunday"), "no class that day," "we don't run yoga on Mondays" — **none match**, so `assertsNoAvailability` returns false, Gate 3 never fires, and neither the fresh-spine backstop nor the situation signal runs. A false whole-day-empty claim passes untouched. (Broadening must be windowed/context-aware per the plan's T2.2 v3 note, or it launders a correct "full of classes.")

**6. H7 — Branch 4 has no action-claim gate beyond "booking made" (HIGH).**
`makeGenReply` runs only `assertsBookingConfirmed` (Gate 1), which omits the `*_CANCELLED` / `*_MESSAGE_SENT` / waitlist lists. `detectActionClaims` — which *does* cover cancel/message-sent — exists in `reply-guard.ts:102` but is **Branch-3 only**. So a Branch-4 reply "ביטלתי לך את התור" on the cancel-failure path (`:3199`) or "I added you to the waitlist" is ungated. This is the cross-cutting "Gate 4" the three-symptom plan proposes; the audit confirms its absence is systemic, not incidental.

**7. H9 + H10 + H11 — Branch-3 action under-detection: settings-edit, refund, broadcast (MED, aggregated).**
`actionsFromToolResult` collapses `manageBusinessSettings` and `deleteCalendarEvent` to `cancelled` only (`:976-978`), maps `requestPayment`→`message_sent` but not `refundTransaction` (`:958-962`), and never maps `executeBroadcastAnnouncement`. With no matching `detectActionClaims` pattern, a fabricated "done" after a `success:false`/`clarificationNeeded` settings result, a "refunded ₪300" after `ok:false`, or an inflated broadcast count all pass on prompt-only guards (P7/P8).

**8. H8 + H12 — Unbacked proactive commitments (MED).**
`pa_paused_customer` (`t.ts:843`) promises "we'll be in touch shortly" while a paused PA queues nothing (the voice-lint even allow-lists this string as a known forward-commitment). `calendar_owner_reconcile_applied` (`t.ts:802`) asserts "the affected customers have been notified" when those notifies are best-effort `.catch(()=>{})` and may have failed. Both flow through `generateProactiveCustomerMessage` (`client.ts:1274`) — the **universal ungated seam** every worker/proactive/escalation message passes through with zero output gate.

**9. H13 + H14 + H15 — Class-C/relay fabrication on the customer knowledge path (MED).**
The instructor no-roster branch (H13), the bundled-confirm side-question (H14), and the no-FAQ attribute question (H15, e.g. "mat vs apparatus") all either fake-escalate ("I'll check with the business," no dispatch) or risk un-gated semantic invention. `buildBusinessFacts` grounds services/prices/instructors closed-world but says nothing about *attributes* of those services, and there is no class-C output gate behind it.

**10. H16 + H17 + H19 + H20 — Residual MED/LOW edges.**
Coordination `confirm` books but is unmapped → a true "booked" reads as unbacked and a false "booked after abandon" is undetectable (H16). Branch-3 future commitments (H17) and "I checked, everything's fine" (H20) ride prompt-only guards. The unscoped-inquiry "nothing available" on a transient empty load has no focusDay so Gate 3 is blind (H19).

---

## 5. Where the levers point (no detailed fixes — lever names only)

- **Output gate (port/extend an existing chokepoint):** H1 (Branch-3 availability gate — port Gate 2/3), H6 (broaden `assertsNoAvailability`, windowed), H7 (wire `detectActionClaims` into `makeGenReply` = Gate 4), H4/H5/H9/H10/H11/H16/H20 (extend `actionsFromToolResult` + `detectActionClaims` claim classes; treat `partial:true` as not-backed), H12 (gate "notified" on a confirmed dispatch count).
- **Source-truth (grounding / fresh re-read):** H3/H18 (re-validate the slot fresh-spine before the waitlist/cold-fill send), H15 (extend grounding for service attributes), H19 (thread a focusDay onto unscoped inquiries), H8 (correct/remove the paused-PA claim).
- **New capability (build the backing the claim assumes):** H2/H13/H14 (the customer→owner question-relay round-trip — dispatch + `pending_owner_question` state + owner-reply→customer routing), H3 (a real hold behind "I'm holding it").

The two structural multipliers: **(1)** Branch 3 and the worker/proactive paths have *no* fabrication chokepoint — the doctrine's "one chokepoint, not per-path" rule was applied only to Branch 4's `makeGenReply`; **(2)** `generateProactiveCustomerMessage` (`client.ts:1274`) is the single seam through which every worker/proactive/escalation/coordination customer message flows ungated — the natural home for a generalized output gate, with `dunning.ts`'s link-reinjection as the positive precedent.

---

## 6. Method & limits

Read-only; no code modified. Every claim cites `file:line`; load-bearing conditionals/prompts quoted verbatim. Confirmed holes (a path that can demonstrably emit an unbacked assertion) are separated from theoretical/latent risk (e.g. Gate 2's am/pm blindness, latent until an English/12h business onboards; H19's transient-load edge). Coverage spanned Branch 4 (`customer-booking.ts`, `slot-fabrication-guard.ts`, `reply-guard.ts`, `voice-guard.ts`), Branch 3 (`orchestrator.ts`, `client.ts`, coordination tools), and the worker/proactive/initiation/i18n send paths (`workers/*`, `escalation/engine.ts`, `initiations/*`, `i18n/t.ts`). No detailed fixes proposed — levers named only, per the audit contract.
