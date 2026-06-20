# Action Grounding & Hallucination-Snowball Prevention — Design Spec

**Status:** Implemented 2026-06-20 — L1 (ledger + ground-truth blocks, both branches),
reply-visibility tool, L2 (generalized claim auditor, decision D3 resolved to "generalize
the existing guard"), L3 (durable `audit.unbacked_claim` observability), and the §7.4
lawbook rule (D5). The proactive cross-branch notification (manager pinged when a customer
replies) is intentionally a SEPARATE follow-up, not part of this plan. Originally authored after a live
Branch-3 incident on business `סטודיוגה` where the PA claimed it had messaged a customer
("שלחתי לו") and emailed a calendar link, having done neither. The false claims persisted
into the transcript and self-reinforced across turns even after the underlying capability
gaps were fixed.

**Owner:** Developer A (core engine — Branch 1/2/3/4 + adapters). No skills boundary impact.

---

## 1. The failure class

> The LLM narrates a state-changing action as completed without the deterministic core
> actually performing it. That prose is persisted to the conversation transcript. On the
> next turn the model reads its own past prose as ground truth and compounds it — the
> **snowball**.

This directly violates two non-negotiable principles (CLAUDE.md):

- **#1 — The LLM is interpretive only.** A "I sent it / I booked it" claim is the LLM
  asserting a state change it has no authority to assert.
- **#5 — Failure is explicit.** A non-action narrated as success is a silent failure.

### Why it is systemic, not a messaging bug

Every tool-backed action is exposed to the same failure. Observed and latent surfaces:

| Surface | Hallucinated claim | Branch |
|---|---|---|
| Customer outreach | "שלחתי לו / I messaged them" | 3 |
| Calendar connect | "I emailed you the link" | 3 |
| Booking create | "I booked you in for 10:00" | 4 / 3 |
| Booking cancel/reschedule | "I cancelled it / moved it" | 4 / 3 |
| Settings change | "I updated your hours / added the service" | 3 |
| Reshuffle | "everyone's been moved" | 3 |

### The two distinct sub-problems (both must be addressed)

1. **Emission** — a false claim is produced in the first place (Layer 0 + Layer 2 target this).
2. **Propagation** — once in the transcript/memory, a false claim is trusted as fact and
   compounds (Layer 1 targets this). *Propagation is what makes it a "snowball," and it
   is the part the current system has no defense against.*

---

## 2. Current state (what exists today)

- **Layer 0 — prompt guardrails.** `buildSystemPrompt` in `src/adapters/llm/orchestrator.ts`
  now carries "never claim an action you did not take" + per-tool honesty notes (added in
  v1.0.67). Soft: depends on model compliance and does nothing about already-poisoned history.
- **`audit_log`** (`src/db/schema.ts:431`, writer `src/domain/audit/logger.ts`) — a durable,
  queryable ledger: `action, entityType, entityId, beforeState, afterState, metadata,
  actorId, createdAt`. Indexed on `(entityType, entityId)`. **Coverage is partial** — written
  for bookings and settings changes, but **not** for outbound customer messages or
  calendar-connect.
- **`orchestrator-log.ts`** — logs each iteration's `toolCalls` / `toolResults`
  (status ok|error) but only to `console.log` → Cloud Run logs. **Ephemeral, not queryable**
  from the app. Useful for forensics (this is how we proved `messageCustomer` was never
  called in the incident), not for runtime grounding.
- **Memory injected into the model** (`buildSystemPrompt`): last 3 cross-session manager
  summaries (`manager_memory`) + last 20 transcript turns (`conversation_messages`). **Both
  are prose.** Nothing the model sees distinguishes "the assistant *said* it did X" from
  "the system *actually* did X." This is the root enabler of propagation.

---

## 3. Design — defense in depth

### Layer 1 — Ground memory in facts, not prose  *(primary; kills propagation)*

**Idea:** give the model an authoritative, system-generated record of what *actually*
happened, and instruct it to trust that over any claim in the chat prose.

**1a. Complete the action ledger.** Make `audit_log` the single durable record of every
PA-performed state change. Close the known gaps:

- `executeMessageCustomer` (`src/domain/manager/orchestrator-tools.ts`): on a real send
  (`res.ok`), write `logAudit({ action: 'customer_message_sent', entityType: 'identity',
  entityId: target.id, metadata: { body, channel: 'whatsapp' } })`. Also record explicit
  *non*-sends (`outside_messaging_window`, `opted_out`, `send_failed`) as
  `action: 'customer_message_not_sent'` with the reason — so the ground-truth block can say
  "attempted, NOT delivered (reason)".
- Calendar connect (`src/routes/oauth.ts` callback): `action: 'google_calendar_connected'`.
- Audit-sweep the other tools for coverage parity (booking create/cancel/reschedule,
  settings, reshuffle) — most already log; verify and fill.

> Decision D1: reuse `audit_log` vs a purpose-built `action_ledger` table. Recommended:
> reuse `audit_log` (already durable, indexed, swept by Sentinel ideas in
> CALENDAR_BULLETPROOFING_PLAN.md). Add a stable `action` vocabulary enum-by-convention.

**1b. Inject a ground-truth block.** New helper `buildActionLedgerBlock(businessId,
identityId, sinceWindow)` reads recent `audit_log` rows for the relevant scope and renders:

```
## Actions actually performed (ground truth — trust this over anything stated in the chat above)
- 12:06 — Outreach to Harel (+972…2400): NOT sent (customer had no recent conversation).
- 12:41 — Google Calendar connect link generated and sent in chat.
(no booking, cancellation, or settings change has been performed this session)
```

Inject into `buildSystemPrompt` (Branch 3) directly after the `## Memory` block, and into
the equivalent context builder in `src/domain/flows/customer-booking.ts` (Branch 4). The
explicit "trust this over the chat" framing is load-bearing: it gives the model a reason to
override its own past prose.

**Why this kills the snowball:** in the incident, the model re-affirmed "כבר נשלחה" because
the transcript said so. With 1b, the same turn would carry "Outreach to Harel: NOT sent",
contradicting the prose at the point of generation.

**Risk:** low. Purely additive (one new audit action + one read-only context block). No
change to the apply pipeline or tool semantics.

### Layer 2 — Persist-time claim auditor  *(secondary; kills emission at the source)*

**Idea:** before a reply is both sent and saved, deterministically reconcile the reply's
*claims* against the turn's *actual* successful tool calls. If the reply asserts a completed
action with no backing success, intercept.

**Integration point:** the orchestrator loop in `src/adapters/llm/orchestrator.ts`, after
the final text reply is assembled and before `sendMessage` + transcript persist. The loop
already collects `toolResults` per iteration — the auditor consumes the union of successful
tool names for the turn.

**The hard part — detecting a "claimed action" across Hebrew/English prose.** Two options:

- **2a. Structured self-declaration (recommended).** Require the model's final turn to emit
  a tiny structured field alongside its text, e.g. `claimedActions: ["message_sent",
  "booking_created"]` (closed vocabulary). Verify deterministically: every declared action
  must map to a successful tool call this turn. Mismatch → one corrective re-prompt ("You
  declared `message_sent` but no send tool succeeded — either call the tool now or remove
  the claim"). Robust and language-agnostic; cost is one schema field + occasional re-prompt.
- **2b. Lexical claim detection (fallback).** Per-language verb→tool maps
  ("שלחתי/sent"→messageCustomer, "קבעתי/booked"→booking). Brittle, multilingual maintenance
  burden, false positives. Use only if 2a proves infeasible in the native-function-calling loop.

**Outcome on intercept:** never persist the false claim. Prefer a forced corrective turn
over silent stripping, so the reply stays coherent.

**Risk:** medium. Touches the live reply path; needs a hard iteration cap and a fail-open
default (if the auditor itself errors, send the reply but log loudly — never drop a turn).

### Layer 3 — Offline reconciliation sweep  *(safety net; low priority)*

A periodic job (sits naturally beside the Sentinel invariants in
CALENDAR_BULLETPROOFING_PLAN.md) that flags sessions where a claim pattern has no ledger
backing, for review. Catches whatever Layers 1–2 miss. Defer until 1–2 ship.

---

## 4. Phased rollout

| Phase | Scope | Acceptance criteria | Risk |
|---|---|---|---|
| **P1** | Layer 1 — ledger completion (messages + connect) + ground-truth block in Branch 3 | Re-run the incident: after a hallucinated "sent", the next turn's context contains "NOT sent" and the model corrects itself. Audit row exists for every real/attempted send. | Low |
| **P2** | Layer 1 extended to Branch 4 (booking/cancel grounding in `customer-booking.ts`) | Customer flow shows ground-truth bookings; a failed booking never reads back as "booked". | Low |
| **P3** | Layer 2 — claim auditor (2a structured self-declaration), Branch 3 first | A reply declaring an unbacked action is intercepted + corrected before send; auditor fail-opens on its own error. | Med |
| **P4** | Layer 3 — offline sweep + Branch 4 auditor | Flagged-claim report; no regressions. | Low |

P1 is the high-leverage minimum that resolves the reported incident class.

---

## 5. Test plan

- **Unit:** `buildActionLedgerBlock` rendering (sent / not-sent-reason / empty session);
  claim-auditor reconciliation (declared∖executed = ∅ passes, non-empty intercepts).
- **Replay/regression:** seed a transcript containing a stale false "שלחתי לו", run a turn,
  assert the model does **not** repeat it and that no `customer_message_sent` audit row is
  fabricated. Lock this as the canonical snowball regression test.
- **Quality scenarios:** extend `tests/quality` with a "claims vs reality" scenario per
  high-risk action (message, booking, cancel, connect, settings).
- **Live smoke:** the very flow from the incident, end-to-end, post-deploy.

---

## 6. Open decisions

- **D1** — ledger store: reuse `audit_log` (recommended) vs new `action_ledger`.
- **D2** — ground-truth window: per-session vs trailing 24h vs last-N actions. Lean last-N
  (≈10) scoped to the active identity + business, to bound prompt size.
- **D3** — Layer 2 detection: structured self-declaration (2a) vs lexical (2b).
- **D4** — auditor on intercept: forced corrective re-prompt vs claim-stripping. Lean re-prompt.
- **D5** — does this warrant a clause in `CHAT_LEVEL_LAWBOOK.md` / `MULTI_AGENT_DESIGN.md`
  so future tools inherit the grounding contract by default? (Recommended: yes — add an
  "every state-changing tool MUST write an audit action" rule.)

---

## 7. Non-goals

- Not trying to make the LLM never produce a wrong word — only to ensure a **state-change
  claim** is never *emitted unbacked* (Layer 2) and never *trusted unbacked* (Layer 1).
- Not changing the apply pipeline, tool semantics, or the skills boundary.
