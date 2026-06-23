# Inbound Message Coalescing (Debounce-Before-Processing) — Design

**Status:** Implementing
**Author:** Developer A (system)
**Date:** 2026-06-23
**Branch:** `dev/system/inbound-message-coalescing`
**Scope:** `src/routes/webhook.ts`, new `src/domain/flows/message-coalescer.ts`. Does **not** touch the proactive-initiations work (`src/domain/initiations/`, proactive workers) — that is owned by a parallel session.

---

## 1. Problem

Every inbound WhatsApp message is its own webhook POST and is processed as a standalone turn. When a person sends one thought across several quick messages, the PA answers each one separately — three messages in three seconds produce up to three replies for a single situation.

Reference case (real, sent to an owner over three messages, one request):

> אירית, מה נשמע? אני רשומה אצל מאי היום בשש, אבל תקועה בבית חולים …
> אני כבר לא יכולה לבטל ב-אפאפ אבל תשחררי את המקום אצלך, חבל…
> חושבת שאני יכולה לבוא לשיעור שלך בחמישי בשבע בבוקר במקום זה?

A human reads all three and replies **once**: frees the 6pm slot *and* offers the Thursday 7am move. The PA must do the same.

### Current behaviour by branch

- **Branch 4 (customer)** — `routeCustomerMessage` has **no concurrency control**. Rapid messages run in parallel: duplicate session creation, transcript races (a later message doesn't reliably see earlier ones), and concurrent booking-engine writes on overlapping state (a cancel racing a new booking). Result: multiple replies, possible inconsistency.
- **Branch 3 (manager)** — `routeManagerMessage` serializes via `withBusinessLock`, but the queued message is **never drained** (`dequeueForBusiness` is defined but unused), so a manager's 2nd rapid message is silently dropped after the 60s queue TTL. Latent bug, fixed implicitly by this work.

This violates the Voice Bible: §9.1 (would a sharp human actually text this?), §11 (anti-formula — repeated/fragmented replies are the loudest bot tell), §14 (conversational momentum).

---

## 2. Approach — debounce, then coalesce

Buffer a burst, wait for a short silence, then process the **whole burst as one logical turn → one reply → one LLM call**. This is how a person handles it: wait until they stop typing, then answer everything. Chosen over the "process-then-regenerate" alternative because it is cheaper (one LLM call, not 2–3), simpler (no double-send race), and matches human behaviour.

### Chokepoint

One insertion point in `processInboundMessage`, **after** dedup + identity resolution + `message.received` audit, and **after** the active-coordination interception (so coordination counterparties are untouched), **replacing** the role-routing `if/else`:

```
… dedup, identity, audit, tryAdvanceActiveCoordination …
                │
        ┌───────┴────────┐
        │ bypass?         │  image present, or manager keyword command (STATUS/PAUSE/…)
        │  → route now    │
        └───────┬────────┘
                │ no
        buffer message in Redis  (RPUSH + INCR seq, TTL 60s)
        schedule flush in DEBOUNCE_MS
                │
   (flush fires) atomically claim buffer iff seq unchanged
                │ claimed (this was the last message of the burst)
        combine buffered bodies → one synthetic InboundMessage
        run the same role-routing if/else once
```

Because dedup, identity, and `message.received` run **per message before** buffering, every individual inbound is still recorded once (WhatsApp retries stay deduped); only the *reply-generating* work is coalesced.

---

## 3. Mechanics

### 3.1 Redis state (per conversation = per `businessId:identityId`)

- `coalesce:buf:{businessId}:{identityId}` — Redis list, JSON-serialized `InboundMessage` per burst entry.
- `coalesce:seq:{businessId}:{identityId}` — monotonic counter, incremented per buffered message.

Both carry a 60s TTL as a self-cleaning safety net.

### 3.2 Enqueue (atomic)

`RPUSH buf <json>` → `INCR seq` (returns this message's sequence number `N`) → refresh TTLs. Return `N`. The caller schedules a flush keyed to `N`.

### 3.3 Flush (atomic, exactly-once via Lua)

A Lua script compares the stored seq to the expected `N`:

```lua
-- KEYS[1]=seq KEYS[2]=buf  ARGV[1]=expectedSeq
if redis.call('GET', KEYS[1]) == ARGV[1] then
  local items = redis.call('LRANGE', KEYS[2], 0, -1)
  redis.call('DEL', KEYS[2]); redis.call('DEL', KEYS[1])
  return items
else
  return {}      -- a newer message arrived; that message's flush owns the burst
end
```

If the current seq still equals `N`, this message was the last of the burst → atomically read-and-clear the buffer and return all entries. Otherwise return empty → do nothing. This is instance-agnostic: on Cloud Run, whichever instance handled the last message wins the CAS, regardless of which instances handled earlier ones (state lives in shared Redis, not process memory).

### 3.4 Combine

Parse the returned JSON entries (chronological order). Build one synthetic `InboundMessage` from the **last** entry (so `messageId` — used for the Branch-3 lock token and logging — is the most recent), with `body` = the entries' bodies joined by `\n`. Route it once through the existing `if/else`. The route handler saves this combined body as a single customer/manager transcript turn (multi-line, natural to read).

### 3.5 Trigger

In-process `setTimeout(DEBOUNCE_MS)`. The webhook already sends `200` first and processes asynchronously, and the server stays warm under traffic, so a short timer is safe and is the lowest-complexity option. The flush callback is wrapped in try/catch and reuses `notifyManagerOfError` on failure (same safety net as the per-message path). **Upgrade path** (noted, not built): move the trigger to a delayed queue (BullMQ delayed job / Cloud Tasks) if min-instances is 0 or burst volume grows — the Redis buffer + CAS flush stay identical; only the timer source changes.

### 3.6 Windows & bypass

- `DEBOUNCE_MS` — **6000ms** for customers, **8000ms** for managers (managers type longer multi-part instructions). Single constant module export, per-role value.
- **Bypass coalescing** (process immediately, current behaviour):
  - any message with `imageMediaId` (media flushes can't be concatenated meaningfully, and skills consume them one at a time),
  - manager **keyword commands** (`STATUS`, `PAUSE`, `RESUME`, `UPCOMING`, `BOOKINGS …`, `PAID …`, `HANDLED …`) — deliberate single actions that must answer instantly.
- **Out of scope (bypass by position):** active meeting-coordination counterparties and stray-contact messages — the coordination interception returns before the chokepoint, so they are never buffered.

---

## 4. Edge cases

| Case | Behaviour |
|---|---|
| Single message (the common case) | Buffered, flushes after one window. One extra `DEBOUNCE_MS` of latency, one reply. (Acceptable; see §6.) |
| WhatsApp retries a delivered message | Deduped before buffering — never enters the buffer twice. |
| Two messages, different intents | Both in one turn; the LLM sees the full context and answers once (this is the desired Irit behaviour). |
| Message arrives exactly as the flush fires | Lua CAS guarantees exactly one flush: either the new INCR bumps seq (old flush no-ops) or the flush clears first (new message starts a fresh burst). No double-processing, no lost message. |
| Manager keyword + free text in same burst | Keyword bypasses and answers now; the free text coalesces on its own window. |
| Buffer orphaned (crash before flush) | 60s TTL clears it; next message starts clean. |

---

## 5. Files

- **New:** `src/domain/flows/message-coalescer.ts` — `DEBOUNCE_MS`, `bufferInbound()`, `flushBurst()`, `combineInbound()`, `shouldBypassCoalescing()`. Self-contained, Redis-only, unit-testable with a mocked redis.
- **Edit:** `src/routes/webhook.ts` — replace the role-routing block in `processInboundMessage` with: bypass check → immediate route, else buffer + schedule flush; extract the existing `if/else` into a small `dispatchToRole(msg, identity, business, app)` helper reused by both the immediate and flushed paths.
- **Tests:** `tests/flows/message-coalescer.test.ts` — buffering returns increasing seq; flush returns all entries only when seq matches; stale-seq flush returns empty; combine joins bodies and keeps the last messageId; bypass predicate matches images + keyword commands.

The unused `dequeueForBusiness`/`enqueueForBusiness` queue in `concurrency-lock.ts` is left in place (out of scope to remove); the manager lock still serializes, and coalescing means a manager rarely hits it mid-burst now.

---

## 6. Trade-offs

- **Latency:** every reply now waits one debounce window (6–8s). For a chat assistant this reads as natural "typing" cadence, and it is the price of never fragmenting. Acceptable pre-launch; tunable via the single constant.
- **Timer durability:** `setTimeout` is process-local. Safe while the instance stays warm; the §3.5 upgrade path covers scale-to-zero without changing the buffer/flush contract.
- **Transcript shape:** a burst is stored as one multi-line turn rather than N turns. Reads naturally and keeps the LLM's view of "one turn = one reply" clean.
