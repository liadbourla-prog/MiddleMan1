# Website Data Plug-in — Design

**Date:** 2026-06-18
**Status:** Approved design → ready for implementation plan
**Owner domain:** Developer A (`src/routes`, `src/domain`, `src/adapters`, `src/db`; NOT `src/skills`)
**Builds on:** `CRM_STANDARD.md` (the canonical hub + §6.3 website projection rules), the Tier-A build
(price resolver, `loadSessionRoster`), and the Step-1 booking-engine fixes.

---

## 1. Goal

Expose the internal CRM hub as a **clean, embeddable, authenticated JSON API** that **any** website —
ours or a customer's existing WordPress/Wix/custom site — can consume to show the **live** schedule,
instructors, prices, and availability, and to **create bookings**. The website is a third projection of
the one internal model (`CRM_STANDARD.md` §0/§6.3): it shares the canonical reads and the `requestBooking`
write seam, so WhatsApp, Google Calendar, and the website always show the same thing **by construction**,
not by sync.

**Non-goals:** no UI/widget (JSON only — the consuming site renders it); no new data store; no new
confirmation path; no membership/eligibility (Tier-B); no payments capture (the existing
`confirmationGate`/`paymentStatus` model is unchanged).

---

## 2. Architecture & placement

- A new Fastify route group **`src/routes/public-api/`**, mounted at **`/api/v1/*`**. Core, not a skill.
- A **thin transport** over existing primitives. It introduces **no new data path**:
  - reads call the canonical functions (`resolveServicePrice`, `loadInstructorRoster` /
    `loadTeachingSchedule`, `getOpenSlots`, `loadSessionRoster`);
  - the one write calls **`requestBooking`** (the same engine, with the Step-1 capacity/resolver fixes).
- Every response is **structured JSON, never prose** (`CRM_STANDARD.md` §8.1) — the API cannot emit
  customer-facing wording, so it can't bypass the chat/voice lawbook. Customer-facing wording stays with
  the PA's existing WhatsApp confirmation.

```
customer's website ──HTTP──> /api/v1/* (src/routes/public-api)
                               │  auth (api key) → resolve business + scope
                               │  rate-limit (Redis) + idempotency (Redis)
                               ▼
        reads → canonical read fns        write → requestBooking (engine)
                               │                         │
                               ▼                         ▼
                       internal DB (hub) ──── outbound Google mirror (existing)
                                              ──── PA WhatsApp confirmation (existing)
```

## 3. Per-business API keys

New table **`business_api_keys`**:

| Column | Notes |
|---|---|
| `id` uuid pk | |
| `businessId` uuid fk | |
| `type` enum | `publishable` \| `secret` |
| `keyHash` text | sha256 of the full key (we never store the raw key) |
| `prefix` text | display/debug prefix, e.g. `pk_live_a1b2` / `sk_live_a1b2` |
| `label` text null | human label ("studio site") |
| `isActive` boolean | default true |
| `createdAt` / `revokedAt` | revocation without delete |

- Key format: `pk_live_<random>` (publishable) / `sk_live_<random>` (secret). The raw key is shown **once**
  at mint time; only `keyHash` + `prefix` persist.
- Lookup: on each request, sha256 the presented key and select by `keyHash` + `isActive` + null `revokedAt`.
- **Minting:** `scripts/mint-api-key.ts <businessId> <type> [label]` for now (prints the raw key once). A
  Branch-3 orchestrator tool to mint/rotate keys conversationally is a deferred follow-up.
- A table (not columns on `businesses`) gives rotation, multiple keys, and revocation for free.

Migration: hand-written idempotent `0020_business_api_keys.sql` (this repo applies migrations manually with
`IF NOT EXISTS` guards — see `0018`/`0019`).

## 4. Endpoints & scope

Auth: `Authorization: Bearer <key>`. Publishable keys → **read-only public** scope. Secret keys → full
scope. Scope is enforced in one auth pre-handler; wrong scope → `403 forbidden_scope`.

| Method · Path | Backing read/write | Key scope |
|---|---|---|
| `GET /api/v1/services` | services + price via `resolveServicePrice` (default tier) | publishable |
| `GET /api/v1/instructors` | `loadInstructorRoster` + `loadTeachingSchedule` | publishable |
| `GET /api/v1/schedule?from&to` | upcoming class instances (with `spotsLeft`/`capacity` **counts**, no names) + open 1-on-1 slots via `getOpenSlots` | publishable |
| `GET /api/v1/availability?serviceTypeId&from&to` | `getOpenSlots` for one service | publishable |
| `GET /api/v1/sessions/:serviceTypeId/:slotStartISO/roster` | `loadSessionRoster` (participant **names** = PII) | **secret** |
| `POST /api/v1/bookings` | find-or-create identity → `requestBooking` | **secret** |

Public/PII split (the §3 sub-decision, resolved): the public `/schedule` exposes **counts only**
(`spotsLeft`, `capacity`) so a site can show "2 spots left"; participant **names** require the secret key
via `/roster`.

`from`/`to` are ISO timestamps; `slotStartISO` is the occurrence's `slotStart` in ISO. All times returned
in ISO 8601 UTC plus the business timezone, so the consuming site can localize.

## 5. Booking data flow (`POST /api/v1/bookings`)

Request: `{ serviceTypeId, slotStart, slotEnd, name, phone, providerHint? }` + headers
`Authorization: Bearer sk_…` and `Idempotency-Key: <uuid>`.

1. **Auth** → resolve business from the secret key (publishable key → `403`).
2. **Idempotency** → if the `Idempotency-Key` was seen for this business (Redis, TTL 24h), return the
   stored result; never create a second booking.
3. **Identity** → find-or-create a phone-keyed `identities` row (`role='customer'`, the existing
   normalization), updating `displayName` if absent. This is the same identity a WhatsApp booking would
   use — a returning customer is the same row across channels.
4. **Write** → call **`requestBooking(db, calendar, actor, { serviceTypeId, slotStart, slotEnd,
   providerHint })`**. The engine runs identity → policy → availability (`isSlotBookable`) → capacity
   (advisory-locked) → safe write, exactly as for WhatsApp. The booking lands in whatever state the
   business's `confirmationGate` dictates (held/requested/confirmed).
5. **Confirmation** → the **existing** PA flow sends the WhatsApp confirmation to that phone (this both
   verifies the number and reuses the one confirmation path); the **existing** outbound Google mirror
   fires. No website-specific messaging.
6. **Response** → `{ booking: { id, state, slotStart, slotEnd, serviceName, providerName | null } }`, or a
   structured error (`slot_unavailable`, `class_full`, `validation_error`).

Result: a website booking produces the **same rows** as a WhatsApp booking and appears identically in
Branch-3 reads and the Google mirror, with **no extra reconciliation**.

## 6. Abuse hardening

- **Writes are secret-key-only** → server-side only, the strongest barrier against browser-originated spam.
- **Rate limiting:** reuse the **already-registered `@fastify/rate-limit` plugin** (`src/server.ts:35`)
  with per-route config and a custom `keyGenerator` keyed on the API key (falling back to IP). Tighter on
  `POST /bookings` than on public reads. Over-limit → `429 rate_limited` with `Retry-After`. (No
  hand-rolled limiter — follow the existing pattern.)
- **Idempotency** (§5 step 2): `Idempotency-Key` → bookingId in Redis (`src/redis.js` connection, TTL 24h).
  Composes with the advisory-lock capacity gate so concurrent retries can never double-book or over-fill a
  class.
- **Scope isolation:** publishable keys can never read roster names or write; a leaked publishable key
  exposes only already-public schedule/price data.
- **Input validation:** zod-validated bodies/queries; unknown service/slot → `validation_error`, never a
  partial write.

## 7. Error handling

Uniform envelope: `{ error: { code: string, message: string } }`. Codes: `unauthorized` (401),
`forbidden_scope` (403), `not_found` (404), `validation_error` (422), `rate_limited` (429),
`slot_unavailable` / `class_full` (409). A refused booking is **never** a 200 (Principle 5 / §3 invariant 7).
`message` is a developer-facing English string for the integrating site — **not** a customer-facing reply
(those remain the PA's job over WhatsApp), so the lawbook does not apply to these strings.

## 8. Testing (all $0, deterministic — isolated DB + Redis already running)

Integration tests under `tests/integration/public-api/` (skip-guarded on `DATABASE_URL`), each asserting
reply == rows:

- **Auth/scope:** no key → 401; publishable key on `/roster` or `POST /bookings` → 403; valid secret →
  allowed; revoked key → 401.
- **Reads:** `/services` price matches `resolveServicePrice`; `/schedule` lists the seeded class instance
  with correct `spotsLeft`; `/instructors` matches the roster; `/availability` matches `getOpenSlots`.
- **Roster:** `/roster` returns the seeded participants (secret key) and is forbidden with a publishable key.
- **Booking:** `POST /bookings` creates a real `bookings` row in the expected state attributed to the
  phone-keyed identity; booking into a full class → `409 class_full`; an out-of-policy slot → `409`.
- **Idempotency:** same `Idempotency-Key` twice → one booking, identical response.
- **Rate limit:** exceeding the window → `429`.

Unit tests: key hashing/verification (`tests/routes/api-key.test.ts`), the auth scope resolver.

## 9. Files (anticipated)

| File | Change |
|---|---|
| `src/db/schema.ts` | add `businessApiKeys` table + `BusinessApiKey` type |
| `src/db/migrations/0020_business_api_keys.sql` | **new**, idempotent |
| `src/routes/public-api/auth.ts` | **new** — key hash/lookup + scope pre-handler |
| `src/routes/public-api/rate-limit.ts` | **new** — Redis sliding-window + idempotency helpers |
| `src/routes/public-api/reads.ts` | **new** — services/instructors/schedule/availability/roster handlers |
| `src/routes/public-api/bookings.ts` | **new** — `POST /bookings` (find-or-create identity → requestBooking) |
| `src/routes/public-api/index.ts` | **new** — `publicApiRoutes` Fastify plugin registering the group at `/api/v1` |
| `src/server.ts` | `await app.register(publicApiRoutes)` alongside the existing route registrations (line ~68) |
| `scripts/mint-api-key.ts` | **new** — mint a key, print raw once |
| `tests/integration/public-api/*`, `tests/routes/api-key.test.ts` | tests |

## 10. Deferred follow-ups (noted, not built)

- Branch-3 tool to mint/rotate API keys conversationally.
- Per-instance `price_override` column (the resolver already accepts the param).
- Optional webhook/CORS allowlist per business for browser reads (publishable key + CORS origin pinning).
- Bot-protection beyond rate-limiting (CAPTCHA/turnstile) if write abuse appears in practice.
