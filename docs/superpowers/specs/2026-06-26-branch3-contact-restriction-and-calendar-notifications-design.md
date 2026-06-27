# Branch 3 — Contact Restriction & Per-Movement Calendar Notifications

**Date:** 2026-06-26
**Status:** Approved design — ready for implementation plan
**Owner:** Developer A (`dev/system/*`) — touches core engine, routes, schema, workers; nothing in `src/skills/`.
**Context:** Pre-soft-launch hardening. Both features must exist fully before launch.

---

## 1. Goals

Two manager-configurable capabilities, both driven through Branch 3 (the PA Manager Channel / Gemini function-calling orchestrator):

1. **Contact restriction (allowlist):** the manager can put the PA into a mode where it only communicates with an explicit set of phone numbers. Anyone not on the list is silently ignored as far as the sender is concerned, and the manager is told about the attempt.
2. **Per-movement calendar notifications:** the manager is notified for every movement in the calendar — customer cancellations, customer reschedules, owner edits ingested from Google Calendar, and PA-initiated changes — with control over which events ping live, which are muted, and which are batched into a digest.

Non-goals: customer-facing UI; any change to the four-branch routing model; any new identity role; allowlist management from any surface other than Branch 3.

---

## 2. Current state (what exists today)

- **No contact gating.** `src/routes/webhook.ts` (~line 267) resolves the inbound identity and auto-registers any unknown number as a `customer` via `registerCustomer`. The only phone-level gate is per-identity revocation (`identities.revokedAt`) and a global `messagingOptOut`. The PA replies to anyone.
- **Notification-rules engine already exists.** `src/domain/initiations/notification-rules.ts` defines `NotificationEvent` (includes `cancellation`, `reschedule`), `NotificationAction` (`notify | notify_with_actions | handle_silently`), and `resolveNotificationAction(...)`. It already defaults `cancellation`/`reschedule` to `notify`. Rules persist in `businesses.notificationRules` (jsonb) and layer over legacy `businesses.notificationPreferences`.
- **Owner-notify pattern exists.** `src/domain/initiations/booking-notify.ts` has `notifyOwnerNewBooking(...)` — loads the manager identity, resolves the action, and sends via the initiation spine (`dispatchInitiation` + `enqueueMessage`). This is the template the new emitters follow.
- **Customer-facing change emitter exists and is widely wired.** `notifyBusinessBookingChange(...)` is already called at every booking-mutation site: `booking/engine.ts:868`, `booking/approval.ts:183`, `manager/apply.ts` (×3), `scheduling/session-cancellation.ts:81`, `calendar/inbound-sync.ts:385`. These are the exact seams the owner-facing twin hooks into.
- **`configureNotifications` tool exists.** `executeConfigureNotifications` (`orchestrator-tools.ts:1880`), registered in `orchestrator.ts:564`/`846`, already lets the manager set rules per event.
- **Daily-briefing worker exists.** `src/workers/daily-briefing.ts`, gated by `businesses.dailyBriefingEnabled` / `dailyBriefingTime`. Reused for the digest.

**Gap:** there is no owner-facing emitter for customer cancel/reschedule/PA-initiated changes (the rules are defined but nothing fires them to the manager), the Google-sync notifications are bespoke rather than rules-gated, there is no contact allowlist anywhere, and there is no batched-digest action.

---

## 3. Feature 1 — Contact restriction (allowlist)

### 3.1 Decisions

- **Opt-in mode**, default OFF. When OFF, behavior is byte-for-byte identical to today.
- **Strict list only** — no grandfathering. When ON, existing customers not on the list are also blocked; the manager must add them explicitly.
- **Never gated:** `manager`, `delegated_user`, and `contact` identities always pass, regardless of the list.
- **Blocked-sender behavior:** silent to the sender (no reply, no identity created), and the manager is notified ("forward to manager") with a one-tap-style way to allow the number.

### 3.2 Storage

Two new columns on `businesses` (schema + migration):

```
contactRestrictionEnabled  boolean   not null default false
allowedContacts            jsonb              -- [{ phone: E164, label?: string, addedAt: ISO }]
```

`allowedContacts` is null/empty by default. Phone numbers are stored normalized to E.164 (same normalization the resolver uses for `identities.phoneNumber`).

### 3.3 The gate

In `src/routes/webhook.ts`, after identity resolution and **before** `registerCustomer` (~line 267–289):

```
if (!business.contactRestrictionEnabled) -> proceed as today (no change)
else:
  - if identity found AND role in {manager, delegated_user, contact} -> proceed
  - else (customer or unknown number):
      - normalize fromNumber; if in allowedContacts -> proceed
      - else -> BLOCK:
          * do NOT registerCustomer
          * do NOT reply to the sender
          * fire notifyOwnerUnlistedContact(...) (best-effort, deduped)
          * return
```

Notes:
- The `processedMessages` insert (idempotency marker) still happens before the gate, so a blocked message is not reprocessed on retry.
- The revoked-identity branch is unchanged and takes precedence (a revoked known identity still gets the revocation message).
- Gate is evaluated per inbound message; no session is created for a blocked sender.

### 3.4 Forward-to-manager emitter

New function `notifyOwnerUnlistedContact(db, businessId, { fromNumber, messageText })` in `booking-notify.ts`, mirroring `notifyOwnerNewBooking`:
- Loads the active manager identity; resolves language from `businesses.defaultLanguage`.
- Sends a localized message naming the (last-4 or full) number, quoting a trimmed snippet of `messageText`, and instructing: reply **"allow <number>"** to let them in.
- Routed through `dispatchInitiation` with `dedupKey: unlisted_contact:<businessId>:<normalizedNumber>` and a **re-notify window** (default 4h) so a blocked number cannot spam the manager. Re-notify window is enforced via the initiation spine's dedup/time semantics (same mechanism `notifyOwnerNewBooking` relies on for one-notice-per-event).
- Best-effort; never throws.

### 3.5 Manager control via Branch 3 — `manageAllowedContacts` tool

New orchestrator tool (function declaration in `orchestrator.ts`, executor in `orchestrator-tools.ts`), gated to managers (and delegated users only if granted — consistent with other settings tools). Operations:

| op | effect |
|---|---|
| `enable` | set `contactRestrictionEnabled = true` |
| `disable` | set `contactRestrictionEnabled = false` |
| `add` (phone, label?) | normalize + upsert into `allowedContacts` (idempotent) |
| `remove` (phone) | remove from `allowedContacts` |
| `list` | return current mode + the list for the PA to read back |

- The "allow <number>" reply from a forward message maps to `add` (and, if the mode is somehow off, the PA confirms whether to also `enable`).
- Pure helpers for list mutation (`addAllowedContact`, `removeAllowedContact`) kept in a small module (e.g. `src/domain/manager/allowed-contacts.ts`) so they are unit-testable independent of the DB and the tool layer.
- All writes go through the deterministic apply path (no LLM direct mutation), consistent with the non-negotiable principles.

---

## 4. Feature 2 — Per-movement calendar notifications

### 4.1 Decisions

- **Events covered:** `cancellation` (customer self-cancel), `reschedule` (customer self-reschedule), Google-originated edits (ingest/reconcile), PA-initiated changes (coordination / auto-approval / PA-driven booking mutations).
- **Default ON, immediate** per-movement pings. The resolver already defaults `cancellation`/`reschedule` to `notify`; PA-initiated and Google-originated map to the same surface-by-default behavior.
- **Manager's own Branch-3 actions do NOT ping the manager** (they performed the action and already get an in-chat confirmation).
- **Batched digest** is offered as a per-event option: the manager can route any event to a once-daily digest instead of a live ping.

### 4.2 Owner-facing change emitter

New function `notifyOwnerBookingChange(db, businessId, change)` in `booking-notify.ts` — the owner-facing twin of `notifyBusinessBookingChange`. The `change` discriminated union carries `kind` (`cancelled | moved | confirmed`), the relevant ids, slot(s), and an `origin` tag (`customer | pa | google`) used only for message wording.

Behavior:
1. Resolve the `NotificationEvent` from `change.kind`/`origin` (`cancelled`→`cancellation`, `moved`→`reschedule`, PA/Google booking→`new_booking` semantics where applicable).
2. `action = resolveNotificationAction(rules, prefs, event)`:
   - `notify` / `notify_with_actions` → enqueue an immediate localized message to the manager via the spine (dedupKey per change).
   - `handle_silently` → return.
   - `digest` (**new**) → append the change to the digest buffer (§4.4) instead of sending.
3. Best-effort; never throws (fire-and-forget after the deterministic write commits).

### 4.3 Wiring (no new chokepoints)

Call `notifyOwnerBookingChange` at the existing `notifyBusinessBookingChange` sites, with these rules:

| Site | Event | Notify manager? |
|---|---|---|
| `booking/engine.ts` customer self-cancel / reschedule-release | cancellation / reschedule | **Yes** |
| `booking/approval.ts:183` | depends on actor | Yes if PA/customer-driven |
| `scheduling/session-cancellation.ts:81` | cancellation | Yes |
| `calendar/inbound-sync.ts:385` | google edit | **Yes** — replaces bespoke `calendar_owner_reconcile_applied` send with the unified rules-gated emitter; keeps the existing blast-radius confirm-gate for high-impact deletes |
| `manager/apply.ts` (×3) | manager-initiated | **No** — suppressed; manager already gets in-chat confirmation |
| coordination booking path | pa-initiated | Yes |

`origin` is set by the caller so the manager-suppression rule for `manager/apply.ts` is explicit (those sites simply do not call the owner emitter, or call it with a suppress flag — decided at plan time, but the manager must not be pinged for their own action).

### 4.4 Batched digest

- Add `'digest'` to `NotificationAction` in `notification-rules.ts`. `resolveNotificationAction` returns it when a matching rule says so; no event defaults to `digest` (opt-in per event).
- **Buffer:** new table `notification_digest_queue` (`id, businessId, event, payload jsonb, createdAt, flushedAt nullable`). Chosen over a jsonb column on `businesses` so concurrent appends don't race on a single row.
- **Flush:** extended `daily-briefing.ts` worker appends a "Changes since your last update" section listing buffered changes, then marks them `flushedAt`. Digest cadence at launch = the daily briefing cadence (`dailyBriefingTime`). Finer cadence is a documented future option (YAGNI for launch). If `dailyBriefingEnabled` is false but a manager has digest rules, the worker still flushes a minimal digest-only message (so opting into digest does not silently swallow events).

### 4.5 Manager control via Branch 3

`configureNotifications` already drives this resolver. Extend its accepted `action` arg to include `'digest'`. The manager can then say e.g. "batch reschedule notifications" → rule `{ event: 'reschedule', action: 'digest' }`, or "stop telling me about cancellations" → `handle_silently`, or "tell me the moment anyone cancels" → `notify`. No new tool needed.

---

## 5. Data flow summary

**Inbound (Feature 1):**
`webhook` → find business → mark processed → resolve identity → **contact gate** → (blocked → `notifyOwnerUnlistedContact`, return) / (allowed → existing flow).

**Calendar movement (Feature 2):**
deterministic write commits → existing `notifyBusinessBookingChange` (customer) → **new `notifyOwnerBookingChange`** (manager) → resolve action → immediate send | silent | enqueue to `notification_digest_queue` → daily-briefing worker flushes digest.

Both features keep the LLM interpretive-only: the orchestrator tools translate manager intent into deterministic apply calls; all sends are best-effort and post-commit.

---

## 6. Error handling

- All new emitters are best-effort and never throw; a notification failure never rolls back the underlying write (consistent with existing emitters).
- The contact gate fails **open only when the flag is off**; when on and the manager-notify fails, the sender is still silently dropped (the block is the safety-critical behavior; the manager-notify is best-effort).
- Digest flush is idempotent via `flushedAt`; a crashed flush re-attempts unflushed rows on the next run.
- Tool writes go through the deterministic apply path; invalid phone numbers in `manageAllowedContacts` are rejected with a clear PA-readable error rather than stored malformed.

---

## 7. Testing

**Feature 1**
- Gate unit tests: flag off = open (unchanged); on + listed number = pass; on + unlisted = blocked, no identity created, no reply, emitter fired; manager/delegated/contact bypass; revoked precedence preserved.
- Dedup: second message from the same blocked number within the window does not re-notify.
- `allowed-contacts.ts` pure helpers: add/remove/normalize/idempotency.
- `manageAllowedContacts` tool: enable/disable/add/remove/list; "allow <number>" path.

**Feature 2**
- `notifyOwnerBookingChange` per event: `notify` sends, `handle_silently` does not, `digest` enqueues.
- Manager-initiated change (`manager/apply.ts`) does **not** notify the manager.
- Google-sync path routes through the unified emitter and preserves the blast-radius confirm-gate.
- Digest: buffered rows flush into the daily briefing and are marked `flushedAt`; digest-only flush works when `dailyBriefingEnabled` is false.
- Integration: a customer cancellation produces a manager ping end-to-end.

---

## 8. Migration & rollout

- One Drizzle migration: `businesses.contactRestrictionEnabled`, `businesses.allowedContacts`, and `notification_digest_queue` table. All additive; defaults preserve current behavior (restriction off, no digest rules).
- No backfill required. Existing businesses are unaffected until a manager opts in.
- Deploy via `/update-agent` (handles versioning, Cloud Build, migration verification).

---

## 9. Files touched (anticipated)

- `src/db/schema.ts` + new migration — columns + digest table.
- `src/routes/webhook.ts` — contact gate.
- `src/domain/initiations/booking-notify.ts` — `notifyOwnerUnlistedContact`, `notifyOwnerBookingChange`.
- `src/domain/initiations/notification-rules.ts` — `'digest'` action.
- `src/domain/manager/allowed-contacts.ts` (new) — pure list helpers.
- `src/domain/manager/orchestrator-tools.ts` — `manageAllowedContacts` executor; extend `configureNotifications` action enum.
- `src/adapters/llm/orchestrator.ts` — register `manageAllowedContacts`; extend `configureNotifications` declaration.
- `src/domain/booking/engine.ts`, `booking/approval.ts`, `scheduling/session-cancellation.ts`, `calendar/inbound-sync.ts`, coordination path — call the owner emitter.
- `src/workers/daily-briefing.ts` — digest flush.
- i18n strings for the new manager messages.
- Tests across the above.
