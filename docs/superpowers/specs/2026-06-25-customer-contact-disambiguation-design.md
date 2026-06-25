# Customer Contact Resolution & Disambiguation — Design

**Date:** 2026-06-25
**Branch:** 3 (owner-initiated) → 4 (action on a customer)
**Owner:** Developer A (`src/domain`, `src/adapters`, `src/db`, `src/routes` — not `src/skills`)
**Status:** Approved design; ready for implementation plan.

---

## 1. Problem

When the owner asks the PA to act on a named customer — "reach out to Guy," "charge Guy," "set
a meeting with Guy" — the system can act on the **wrong person**, and has no reliable way to verify
identity with the owner first.

Three concrete defects exist today:

- **`messageCustomer`** ([orchestrator-tools.ts:1940](../../../src/domain/manager/orchestrator-tools.ts))
  detects multiple name matches but returns only a *count* (`reason: 'ambiguous_customer'`,
  "Several customers match"). It surfaces nothing the owner can use to pick the right person — no
  last name, no phone, no history. It also asks the owner to *supply* a phone rather than showing
  the candidates' numbers back for verification.
- **`coordinateMeeting`** ([coordination-tools.ts:149](../../../src/domain/manager/coordination-tools.ts))
  resolves a contact by name with `.limit(1)` and **no ambiguity check at all** — it silently
  contacts whichever row the database returns first.
- **`requestPayment`** ([orchestrator-tools.ts:1753](../../../src/domain/manager/orchestrator-tools.ts))
  resolves/registers a payment target by name with no disambiguation — charging the wrong customer
  is high-stakes.

Underlying data weakness: a customer is a single freeform `displayName`
([schema.ts:145](../../../src/db/schema.ts)) that is **often null** — the webhook registers a
brand-new customer with no name at all ([webhook.ts:287](../../../src/routes/webhook.ts)). There is
no structured last name. So even when disambiguation is attempted there is frequently nothing to
disambiguate *on*.

## 2. Goal

Make "the PA never acts on the wrong person, and verifies with the owner when unsure" a structural
guarantee for **every owner-initiated action that targets a customer or contact**.

1. **One deterministic gate.** A single shared resolver that every owner→target action tool must
   pass through before it touches a person in Branch 4. No tool resolves a name inline anymore.
2. **Disambiguate with verifiable data.** On a name collision the PA asks "which one?" and shows,
   per candidate: **last name, full phone number, and last booking (date + service)** so the owner
   can confirm they mean the same person.
3. **Give last names somewhere to come from.** Add a structured `lastName` and populate it through
   four mechanisms (backfill, opportunistic save, booking capture, owner edit) so disambiguation has
   real data over time.

### Non-goals (v1)

- Fuzzy/phonetic name matching (substring `ilike` only, as today).
- Merging duplicate customer records.
- A first-name column / restructuring `displayName` (we keep `displayName` and add `lastName` beside it).
- Disambiguation for inbound customer→PA traffic (Branch 4 identity is already keyed by phone).
- Touching `customerProfiles.displayName` (the redundant import-time copy is left as-is).

## 3. Approach

**One role-parameterized resolver in the deterministic core**, chosen over per-tool guards. Per-tool
patches would re-introduce the same class of bug in the next owner→target tool someone writes; a
single gate that every tool is required to route through enforces the invariant the way
identity/policy checks already do ("no step may be skipped"). The resolver is parameterized by role
so it serves both customer-targeting tools (`messageCustomer`, `requestPayment`) and the
contact-targeting tool (`coordinateMeeting`) without duplication.

## 4. Data model

### 4.1 Schema change — `identities`

Add one nullable column ([schema.ts:136](../../../src/db/schema.ts)):

```ts
lastName: text('last_name'),   // structured family name; used for matching + verification. Nullable.
```

`displayName` semantics are **unchanged** — it remains the name as captured/displayed (may be a
first name, a full name, or null). `lastName` sits beside it as structured disambiguation data.
No `firstName` column is added.

### 4.2 Migration — backfill `lastName`

A data migration derives `lastName` from existing `displayName`, **non-destructively** (it never
rewrites `displayName`):

- `displayName` trimmed and split on whitespace.
- ≥2 tokens → `lastName` = last token. (`"Guy Cohen"` → `lastName = "Cohen"`.)
- 0–1 tokens or null → `lastName` stays null. (`"Guy"`, `""`, null → no last name.)
- Applies to `role IN ('customer','contact')` rows only.

Drizzle migration generated via the standard flow; the backfill runs as a SQL `UPDATE` in the same
migration. Idempotent (only fills rows where `last_name IS NULL`).

## 5. The resolver — `src/domain/identity/customer-resolver.ts` (new)

A new core module. Single entry point:

```ts
type TargetRole = 'customer' | 'contact'

interface ResolveInput {
  role: TargetRole
  name?: string          // matched as substring against displayName
  lastName?: string      // optional narrowing supplied by the owner at disambiguation time
  phoneNumber?: string   // E.164; takes precedence over name when valid
}

interface CandidateView {
  id: string
  displayName: string | null
  lastName: string | null
  phoneNumber: string          // full number (owner's own customer/contact data)
  lastBooking: { date: string; service: string | null } | null
}

type CustomerResolution =
  | { status: 'resolved';      target: CandidateView }
  | { status: 'ambiguous';     query: string; candidates: CandidateView[] }   // 2..N (capped at 5)
  | { status: 'not_found';     query: string }
  | { status: 'phone_unknown'; phoneNumber: string }   // valid phone, not on file → caller may register

async function resolveTargetForOwnerAction(
  db: Db, businessId: string, input: ResolveInput,
): Promise<CustomerResolution>
```

### 5.1 Resolution logic

1. **Phone given and valid E.164** → direct lookup by `(businessId, phoneNumber)`.
   - found → `resolved`
   - not found → `phone_unknown` (caller decides whether to register-and-send, preserving today's
     `messageCustomer` phone path)
2. **Else name given** → `WHERE businessId = ? AND role = ? AND displayName ILIKE %name%`,
   additionally `AND lastName ILIKE %lastName%` when `lastName` is supplied. Limit 5.
   - 0 rows → `not_found`
   - 1 row → `resolved`
   - >1 rows → `ambiguous` with `candidates[]`
3. **Neither** → throws/returns a `not_found`-style error the caller maps to "ask who to contact."

`lastBooking` per candidate is built by reusing the `booking_history` query shape already in
`executeLookupCustomer` ([orchestrator-tools.ts:1002](../../../src/domain/manager/orchestrator-tools.ts))
— extracted into a small shared helper (`latestBookingFor(db, identityId)`) so both call sites share
one query. For `role: 'contact'`, `lastBooking` is always null (contacts don't book).

### 5.2 What the resolver does NOT do

- It never writes. Registration of a new phone-only target stays in the calling tool.
- It never sends messages or charges. It only classifies and returns verification data.
- It performs no authorization — callers already sit behind their tool's auth action.

## 6. Tool integration (Branch 3)

Each tool replaces its inline name lookup with a `resolveTargetForOwnerAction` call and maps the
result to guidance the orchestrator LLM relays to the owner.

### 6.1 `messageCustomer` ([orchestrator-tools.ts:1904](../../../src/domain/manager/orchestrator-tools.ts))

- Accepts an optional new `lastName` arg in its declaration ([orchestrator.ts:368](../../../src/adapters/llm/orchestrator.ts)).
- Phone path: on `phone_unknown`, register-and-send exactly as today (no behavior change).
- Name path: call resolver with `role: 'customer'`.
  - `ambiguous` → return `{ ok: false, reason: 'ambiguous_customer', candidates, guidance }` where
    `guidance` instructs the PA to ask which one, **listing each candidate's last name, full phone,
    and last booking**, e.g. *"Two customers named Guy: Guy Cohen (+972…4821, last booked Tue 14:00
    haircut) or Guy Levi (+972…9930, last booked 3 Mar). Which one — or give me the number?"* and to
    **re-call `messageCustomer` with the chosen `lastName` or `phoneNumber`.**
  - `not_found` → unchanged guidance (ask for the phone).
  - `resolved` → proceed to the existing send pipeline (window check, template fallback, audit log).

### 6.2 `coordinateMeeting` ([coordination-tools.ts:86](../../../src/domain/manager/coordination-tools.ts))

- Remove the `.limit(1)` contact lookup; call resolver with `role: 'contact'`.
- `ambiguous` → `{ success: false, reason: 'ambiguous_contact', candidates, guidance }` (same
  disambiguation shape, no `lastBooking`); the LLM asks which contact and re-calls with
  `lastName`/`phoneNumber`.
- `resolved` → proceed. `not_found` / `phone_unknown` map to the existing "need phone" path.

### 6.3 `requestPayment` ([orchestrator-tools.ts:1753](../../../src/domain/manager/orchestrator-tools.ts))

- Before charging, resolve the named target with `role: 'customer'`.
- `ambiguous` → refuse with the candidate list and ask which one (high-stakes: never charge on a
  collision). `resolved` → proceed. Phone path / register-new unchanged.

### 6.4 Disambiguation re-entry

No new state machine. Branch 3 already has multi-turn session memory
(`MULTI_AGENT_DESIGN.md`), so the owner's follow-up ("Guy Cohen" / "the one ending 4821" / a number)
re-invokes the same tool with the narrowing argument and the resolver re-resolves. Each tool's
`guidance` string explicitly tells the LLM to re-call with the disambiguator it just learned.

## 7. Name capture (four mechanisms)

1. **Backfill** — the §4.2 migration. One-time, best-effort.
2. **Opportunistic save at disambiguation** — when the owner resolves an ambiguity by giving a
   `lastName` the matched identity didn't have stored, the resolving tool writes it to
   `identities.lastName` for that id (best-effort; never fails the action). Names improve through use.
3. **Booking capture (Branch 4)** — in `customer-booking.ts`
   ([customer-booking.ts](../../../src/domain/flows/customer-booking.ts)), a brand-new customer whose
   `displayName` is null is asked their name (including last name) and it is persisted to
   `displayName` + `lastName`. Name remains **non-blocking** for booking — if the customer skips it,
   booking still completes. Implemented as a light prompt addition + a persistence step on first
   successful booking, not a new required flow stage.
4. **Owner set/correct (Branch 3)** — the owner can set or fix a customer's name. Extend the existing
   customer/contact-notes tooling
   ([orchestrator-tools.ts `lookupCustomer`/notes path](../../../src/domain/manager/orchestrator-tools.ts))
   with a `setCustomerName` capability (first/display name + last name) that writes
   `identities.displayName` / `identities.lastName`. Routed through the standard deterministic write.

## 8. Authorization

No new authorization actions. Each tool keeps its current auth gate:
- `messageCustomer` / `requestPayment` — existing manager/delegated-user gates.
- `coordinateMeeting` — existing `meeting.coordinate` action.
- `setCustomerName` — same gate as the existing customer-management tooling it extends.

The resolver itself performs no auth (callers are already gated).

## 9. Files touched

| File | Change |
|---|---|
| `src/db/schema.ts` | add `lastName` to `identities` |
| `src/db/migrations/*` | generated migration + backfill `UPDATE` |
| `src/domain/identity/customer-resolver.ts` | **new** — resolver + `CandidateView`/`CustomerResolution` types |
| `src/domain/identity/resolver.ts` | optional: `registerCustomer`/`registerContact` accept `lastName` |
| `src/domain/manager/orchestrator-tools.ts` | `messageCustomer`, `requestPayment` route through resolver; extract `latestBookingFor`; `lookupCustomer` returns `lastName`; add `setCustomerName` |
| `src/domain/manager/coordination-tools.ts` | `coordinateMeeting` routes through resolver (drop `.limit(1)`) |
| `src/adapters/llm/orchestrator.ts` | tool declarations: `lastName` arg on `messageCustomer`/`coordinateMeeting`; new `setCustomerName` declaration; description updates |
| `src/domain/flows/customer-booking.ts` | first-booking name capture (non-blocking) |

## 10. Testing

- **Resolver unit tests** (`customer-resolver.test.ts`): 0 / 1 / N matches; `lastName` narrowing
  collapses N→1; phone `resolved` vs `phone_unknown`; `role: 'contact'` path; candidate `lastBooking`
  populated for customers and null for contacts.
- **Migration test**: `"Guy Cohen"` → `lastName "Cohen"`; `"Guy"` / `""` / null → null; `displayName`
  never mutated; idempotent re-run.
- **`messageCustomer` integration**: two same-name customers → `ambiguous` with full candidate data →
  re-call with `lastName` → `resolved` → message sends; opportunistic `lastName` save persisted.
- **`coordinateMeeting` integration**: two same-name contacts → `ambiguous` (no silent first-pick).
- **`requestPayment` integration**: name collision → refuses to charge, asks which one.
- **Booking capture**: new null-name customer is asked for and stored with first/last name; skipping
  it still books.

## 11. Rollout

Single PR on a `dev/system/*` branch. Migration is additive + idempotent backfill — safe to deploy
ahead of the code. No data loss risk (`displayName` untouched). Deploy via `/update-agent`.
