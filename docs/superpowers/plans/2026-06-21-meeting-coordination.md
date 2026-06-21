# Meeting Coordination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Branch 3 (PA Manager Channel) an owner-only meeting-coordination capability: the PA verifies whether to reach out, captures fallback times, negotiates with an external counterparty until a match, and books only after one final owner confirmation.

**Architecture:** A bounded `src/domain/coordination/` module owns an explicit `meeting_coordinations` state machine (modeled on the reshuffle offer lifecycle). Counterparties are a new `contact` identity role, excluded from the CRM. Two Branch-3 orchestrator tools start and resolve coordinations; a new inbound route advances them when the contact replies. Pure functions decide state transitions and slot matching; the LLM only interprets free-text replies and phrases messages.

**Tech Stack:** TypeScript, Drizzle ORM (Postgres), Fastify webhook, Gemini function-calling orchestrator, BullMQ (existing), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-21-meeting-coordination-design.md`

---

## Conventions used throughout

- **Migrations are hand-applied** (`IF NOT EXISTS` / guarded), not via `drizzle-kit migrate`. Match `src/db/migrations/0023_integrity_sentinel.sql`.
- **Deterministic date resolution:** never compute absolute dates in the LLM. Use `resolveSlotRange(req, tz, now)` from `src/domain/availability/resolve-slot.ts`, with `toDateParts()` and `clarifyDate()` from `src/domain/manager/orchestrator-tools.ts`.
- **Grounding:** every state change writes `logAudit(db, entry)` from `src/domain/audit/logger.ts`. Never claim an action unless the tool returned ok.
- **Outbound messages:** `sendMessage({ toNumber, body }, waCredentials)` (`src/adapters/whatsapp/sender.ts`) for the literal text; `generateProactiveCustomerMessage({ businessName, language, situation, fallback, timeoutMs })` (`src/adapters/llm/client.ts`) to phrase owner/contact pings with an i18n fallback.
- **Run tests:** `npx vitest run <path>`. **Typecheck:** `npx tsc --noEmit`.

---

## File structure

| File | Responsibility |
|---|---|
| `src/db/schema.ts` (modify) | Add `'contact'` to `identities.role` enum; add `meetingCoordinations` table. |
| `src/db/migrations/0024_meeting_coordination.sql` (create) | Enum value + table, hand-applied. |
| `scripts/apply-coordination-migration.ts` (create) | Idempotent apply+verify (mirrors `scripts/apply-crm-migrations.ts`). |
| `src/domain/authorization/check.ts` (modify) | Add `'meeting.coordinate'` Action + manager capability. |
| `src/domain/coordination/types.ts` (create) | Status union, transition events, lite row type. |
| `src/domain/coordination/state.ts` (create) | Pure `classifyContactReply`, `nextCoordinationState`. |
| `src/domain/coordination/state.test.ts` (create) | Pure unit tests. |
| `src/domain/coordination/repository.ts` (create) | DB load/insert/update for coordinations. |
| `src/domain/coordination/interpret.ts` (create) | LLM call: free-text contact reply → structured intent. |
| `src/domain/coordination/handler.ts` (create) | `startCoordination`, `advanceCoordination` (impure orchestration). |
| `src/domain/coordination/handler.test.ts` (create) | Integration test of the negotiation loop. |
| `src/domain/calendar/event-content.ts` (modify) | Add `meeting` render kind. |
| `src/domain/calendar/event-content.test.ts` (modify) | Meeting render cases. |
| `src/domain/manager/coordination-tools.ts` (create) | `executeCoordinateMeeting`, `executeResolveMeetingCoordination`. |
| `src/adapters/llm/orchestrator.ts` (modify) | Tool declarations, dispatch, state-changing list, active-coordination context, prompt verify-gate. |
| `src/routes/webhook.ts` (modify) | `routeContactMessage` branch + handler. |
| `src/domain/i18n/t.ts` (modify) | Coordination strings (he/en). |

---

## Task 1: DB schema — contact role + meeting_coordinations table

**Files:**
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Add `'contact'` to the identities role enum**

In `src/db/schema.ts`, find the `identities` table `role` column and change:

```ts
role: text('role', { enum: ['manager', 'delegated_user', 'customer', 'provider'] }).notNull(),
```

to:

```ts
role: text('role', { enum: ['manager', 'delegated_user', 'customer', 'provider', 'contact'] }).notNull(),
```

- [ ] **Step 2: Add the `meetingCoordinations` table**

Append after the `reshuffleProposals` table definition (keep coordination near the other lifecycle tables):

```ts
/** One owner↔counterparty meeting negotiation. See docs/superpowers/specs/2026-06-21-meeting-coordination-design.md. */
export const meetingCoordinations = pgTable(
  'meeting_coordinations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    businessId: uuid('business_id').notNull().references(() => businesses.id),
    ownerId: uuid('owner_id').notNull().references(() => identities.id),
    contactId: uuid('contact_id').notNull().references(() => identities.id),
    title: text('title').notNull(),
    durationMinutes: integer('duration_minutes').notNull(),
    // [{ start: ISO, end: ISO }] — primary + fallbacks, resolved to absolute UTC.
    candidateSlots: jsonb('candidate_slots').notNull(),
    status: text('status', {
      enum: ['awaiting_counterparty', 'countered', 'awaiting_owner_confirm', 'confirmed', 'declined', 'expired', 'abandoned'],
    }).notNull().default('awaiting_counterparty'),
    agreedSlotStart: timestamp('agreed_slot_start', { withTimezone: true }),
    agreedSlotEnd: timestamp('agreed_slot_end', { withTimezone: true }),
    counterSlotStart: timestamp('counter_slot_start', { withTimezone: true }),
    counterSlotEnd: timestamp('counter_slot_end', { withTimezone: true }),
    calendarEventId: text('calendar_event_id'),
    googleEtag: text('google_etag'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // "find the active coordination for this contact" — at most one non-terminal at a time.
    index('meeting_coordinations_contact_idx').on(t.businessId, t.contactId, t.status),
    index('meeting_coordinations_business_idx').on(t.businessId, t.status),
  ],
)
```

Ensure `jsonb` and `integer` are already imported at the top of `schema.ts` (they are used elsewhere — confirm, add to the `drizzle-orm/pg-core` import if missing).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no usages yet beyond the schema).

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts
git commit -m "feat(coordination): schema — contact role + meeting_coordinations table"
```

---

## Task 2: Migration SQL + idempotent apply script

**Files:**
- Create: `src/db/migrations/0024_meeting_coordination.sql`
- Create: `scripts/apply-coordination-migration.ts`

- [ ] **Step 1: Write the migration SQL**

Create `src/db/migrations/0024_meeting_coordination.sql`:

```sql
-- Meeting coordination (Branch 3). See docs/superpowers/specs/2026-06-21-meeting-coordination-design.md.
-- Hand-applied (IF NOT EXISTS / guarded) — re-runs are safe.

-- 1. Allow the new identity role. The role column is a plain text column with a
--    Drizzle-level enum (no Postgres enum type), so no ALTER TYPE is needed; this
--    block is a no-op guard documenting the new allowed value.
--    (If a CHECK constraint on identities.role is added later, widen it here.)

-- 2. Coordination table.
CREATE TABLE IF NOT EXISTS meeting_coordinations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  owner_id uuid NOT NULL REFERENCES identities(id),
  contact_id uuid NOT NULL REFERENCES identities(id),
  title text NOT NULL,
  duration_minutes integer NOT NULL,
  candidate_slots jsonb NOT NULL,
  status text NOT NULL DEFAULT 'awaiting_counterparty'
    CHECK (status IN ('awaiting_counterparty','countered','awaiting_owner_confirm','confirmed','declined','expired','abandoned')),
  agreed_slot_start timestamptz,
  agreed_slot_end timestamptz,
  counter_slot_start timestamptz,
  counter_slot_end timestamptz,
  calendar_event_id text,
  google_etag text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meeting_coordinations_contact_idx
  ON meeting_coordinations (business_id, contact_id, status);
CREATE INDEX IF NOT EXISTS meeting_coordinations_business_idx
  ON meeting_coordinations (business_id, status);
```

- [ ] **Step 2: Write the apply+verify script**

Create `scripts/apply-coordination-migration.ts`, mirroring `scripts/apply-crm-migrations.ts` (read that file first for the exact `postgres`/`sql.unsafe` pattern and error-code skipping). It must: read `src/db/migrations/0024_meeting_coordination.sql`, split on `;`, run each via `sql.unsafe(stmt)` skipping `42701`/`42P07`/`42710` (already-exists), then assert the table exists:

```ts
const [{ exists }] = await sql`
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_name = 'meeting_coordinations'
  ) AS exists`
if (!exists) { console.error('meeting_coordinations missing'); process.exit(1) }
console.log('meeting_coordinations present ✓')
```

- [ ] **Step 3: Commit (apply happens at deploy time via the runbook)**

```bash
git add src/db/migrations/0024_meeting_coordination.sql scripts/apply-coordination-migration.ts
git commit -m "feat(coordination): migration 0024 + idempotent apply script"
```

---

## Task 3: Authorization action

**Files:**
- Modify: `src/domain/authorization/check.ts`

- [ ] **Step 1: Write the failing test**

Create `src/domain/authorization/meeting-coordinate.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { authorize } from './check.js'

describe('authorize meeting.coordinate', () => {
  it('allows a manager', () => {
    expect(authorize({ role: 'manager' }, 'meeting.coordinate').allowed).toBe(true)
  })
  it('denies a customer', () => {
    expect(authorize({ role: 'customer' }, 'meeting.coordinate').allowed).toBe(false)
  })
  it('denies a delegated_user without the grant', () => {
    expect(authorize({ role: 'delegated_user', delegatedPermissions: new Set() }, 'meeting.coordinate').allowed).toBe(false)
  })
  it('allows a delegated_user with the grant', () => {
    expect(authorize({ role: 'delegated_user', delegatedPermissions: new Set(['meeting.coordinate']) }, 'meeting.coordinate').allowed).toBe(true)
  })
})
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx vitest run src/domain/authorization/meeting-coordinate.test.ts`
Expected: FAIL (type error / `'meeting.coordinate'` not assignable to `Action`).

- [ ] **Step 3: Add the action**

In `src/domain/authorization/check.ts`:
1. Add `| 'meeting.coordinate'` to the `Action` union.
2. Add `'meeting.coordinate',` to the manager capability set array (the array enumerated around lines 28–33).
3. Do **not** add it to the delegated default-granted set — delegated users get it only via an explicit grant (already the default behavior of the `delegated_user` branch).

- [ ] **Step 4: Run it — expect PASS**

Run: `npx vitest run src/domain/authorization/meeting-coordinate.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/authorization/check.ts src/domain/authorization/meeting-coordinate.test.ts
git commit -m "feat(coordination): add meeting.coordinate authorization action"
```

---

## Task 4: Pure types + state machine

**Files:**
- Create: `src/domain/coordination/types.ts`
- Create: `src/domain/coordination/state.ts`
- Test: `src/domain/coordination/state.test.ts`

- [ ] **Step 1: Write the types**

Create `src/domain/coordination/types.ts`:

```ts
export type CoordinationStatus =
  | 'awaiting_counterparty'
  | 'countered'
  | 'awaiting_owner_confirm'
  | 'confirmed'
  | 'declined'
  | 'expired'
  | 'abandoned'

export interface Slot { start: Date; end: Date }

// What the contact's reply resolved to (produced by interpret.ts + classify).
export type ContactReplyClass =
  | { kind: 'accept'; candidateIndex: number }   // picked one of the offered candidate slots
  | { kind: 'counter'; slot: Slot }              // proposed a time outside the candidates
  | { kind: 'decline' }
  | { kind: 'unclear' }

// Owner decisions arriving via resolveMeetingCoordination.
export type OwnerDecision =
  | { kind: 'confirm' }                          // book the agreed/countered slot
  | { kind: 'counter_offer'; slot: Slot }        // offer the contact a new time
  | { kind: 'abandon' }

// The side effect the orchestration layer must perform after a transition.
export type SideEffect =
  | { kind: 'message_contact_candidates' }       // (re)send candidate times to the contact
  | { kind: 'message_contact_new_candidate'; slot: Slot }
  | { kind: 'ping_owner_confirm'; slot: Slot }   // "X is good for <slot> — book it?"
  | { kind: 'relay_counter_to_owner'; slot: Slot }
  | { kind: 'relay_decline_to_owner' }
  | { kind: 'book_and_notify'; slot: Slot }      // write calendar event + tell contact "you're set"
  | { kind: 'notify_owner_expired' }
  | { kind: 'none' }
```

- [ ] **Step 2: Write the failing tests**

Create `src/domain/coordination/state.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { classifyContactReply, nextCoordinationState } from './state.js'
import type { Slot } from './types.js'

const c0: Slot = { start: new Date('2026-06-25T12:00:00Z'), end: new Date('2026-06-25T13:00:00Z') }
const c1: Slot = { start: new Date('2026-06-26T09:00:00Z'), end: new Date('2026-06-26T10:00:00Z') }
const candidates = [c0, c1]

describe('classifyContactReply', () => {
  it('maps an exact candidate-start match to accept', () => {
    const r = classifyContactReply({ start: new Date('2026-06-26T09:00:00Z'), end: new Date('2026-06-26T10:00:00Z') }, candidates)
    expect(r).toEqual({ kind: 'accept', candidateIndex: 1 })
  })
  it('treats a non-candidate proposed time as a counter', () => {
    const r = classifyContactReply({ start: new Date('2026-06-27T15:00:00Z'), end: new Date('2026-06-27T16:00:00Z') }, candidates)
    expect(r).toEqual({ kind: 'counter', slot: { start: new Date('2026-06-27T15:00:00Z'), end: new Date('2026-06-27T16:00:00Z') } })
  })
})

describe('nextCoordinationState — contact events', () => {
  it('accept → awaiting_owner_confirm + ping owner', () => {
    const r = nextCoordinationState('awaiting_counterparty', { type: 'contact_reply', reply: { kind: 'accept', candidateIndex: 0 }, candidates })
    expect(r.status).toBe('awaiting_owner_confirm')
    expect(r.effect).toEqual({ kind: 'ping_owner_confirm', slot: candidates[0] })
    expect(r.agreedSlot).toEqual(candidates[0])
  })
  it('counter → countered + relay to owner', () => {
    const slot = { start: new Date('2026-06-27T15:00:00Z'), end: new Date('2026-06-27T16:00:00Z') }
    const r = nextCoordinationState('awaiting_counterparty', { type: 'contact_reply', reply: { kind: 'counter', slot }, candidates })
    expect(r.status).toBe('countered')
    expect(r.effect).toEqual({ kind: 'relay_counter_to_owner', slot })
  })
  it('decline → declined + relay', () => {
    const r = nextCoordinationState('awaiting_counterparty', { type: 'contact_reply', reply: { kind: 'decline' }, candidates })
    expect(r.status).toBe('declined')
    expect(r.effect).toEqual({ kind: 'relay_decline_to_owner' })
  })
  it('unclear → no transition, no effect', () => {
    const r = nextCoordinationState('awaiting_counterparty', { type: 'contact_reply', reply: { kind: 'unclear' }, candidates })
    expect(r.status).toBe('awaiting_counterparty')
    expect(r.effect).toEqual({ kind: 'none' })
  })
})

describe('nextCoordinationState — owner decisions', () => {
  it('confirm from awaiting_owner_confirm → confirmed + book', () => {
    const r = nextCoordinationState('awaiting_owner_confirm', { type: 'owner_decision', decision: { kind: 'confirm' }, agreedSlot: candidates[0], candidates })
    expect(r.status).toBe('confirmed')
    expect(r.effect).toEqual({ kind: 'book_and_notify', slot: candidates[0] })
  })
  it('confirm from countered → confirmed + book the countered slot', () => {
    const slot = { start: new Date('2026-06-27T15:00:00Z'), end: new Date('2026-06-27T16:00:00Z') }
    const r = nextCoordinationState('countered', { type: 'owner_decision', decision: { kind: 'confirm' }, agreedSlot: slot, candidates })
    expect(r.status).toBe('confirmed')
    expect(r.effect).toEqual({ kind: 'book_and_notify', slot })
  })
  it('counter_offer → awaiting_counterparty + send new candidate', () => {
    const slot = { start: new Date('2026-06-28T11:00:00Z'), end: new Date('2026-06-28T12:00:00Z') }
    const r = nextCoordinationState('countered', { type: 'owner_decision', decision: { kind: 'counter_offer', slot }, candidates })
    expect(r.status).toBe('awaiting_counterparty')
    expect(r.effect).toEqual({ kind: 'message_contact_new_candidate', slot })
  })
  it('abandon → abandoned', () => {
    const r = nextCoordinationState('countered', { type: 'owner_decision', decision: { kind: 'abandon' }, candidates })
    expect(r.status).toBe('abandoned')
    expect(r.effect).toEqual({ kind: 'none' })
  })
})

describe('nextCoordinationState — expiry', () => {
  it('expiry from awaiting_counterparty → expired + notify owner', () => {
    const r = nextCoordinationState('awaiting_counterparty', { type: 'expire' })
    expect(r.status).toBe('expired')
    expect(r.effect).toEqual({ kind: 'notify_owner_expired' })
  })
})
```

- [ ] **Step 3: Run — expect FAIL**

Run: `npx vitest run src/domain/coordination/state.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `state.ts`**

Create `src/domain/coordination/state.ts`:

```ts
import type { CoordinationStatus, ContactReplyClass, OwnerDecision, SideEffect, Slot } from './types.js'

const SLOT_MATCH_MS = 5 * 60 * 1000 // a start within 5 min of a candidate counts as that candidate

export function classifyContactReply(
  proposed: Slot,
  candidates: Slot[],
): ContactReplyClass {
  const idx = candidates.findIndex(
    (c) => Math.abs(c.start.getTime() - proposed.start.getTime()) <= SLOT_MATCH_MS,
  )
  if (idx >= 0) return { kind: 'accept', candidateIndex: idx }
  return { kind: 'counter', slot: proposed }
}

export type CoordinationEvent =
  | { type: 'contact_reply'; reply: ContactReplyClass; candidates: Slot[] }
  | { type: 'owner_decision'; decision: OwnerDecision; candidates: Slot[]; agreedSlot?: Slot }
  | { type: 'expire' }

export interface Transition {
  status: CoordinationStatus
  effect: SideEffect
  agreedSlot?: Slot       // persist to agreed_slot_* when present
  counterSlot?: Slot      // persist to counter_slot_* when present
}

export function nextCoordinationState(
  current: CoordinationStatus,
  event: CoordinationEvent,
): Transition {
  if (event.type === 'expire') {
    if (current === 'awaiting_counterparty' || current === 'countered') {
      return { status: 'expired', effect: { kind: 'notify_owner_expired' } }
    }
    return { status: current, effect: { kind: 'none' } }
  }

  if (event.type === 'contact_reply') {
    const r = event.reply
    if (r.kind === 'accept') {
      const slot = event.candidates[r.candidateIndex]!
      return { status: 'awaiting_owner_confirm', effect: { kind: 'ping_owner_confirm', slot }, agreedSlot: slot }
    }
    if (r.kind === 'counter') {
      return { status: 'countered', effect: { kind: 'relay_counter_to_owner', slot: r.slot }, counterSlot: r.slot }
    }
    if (r.kind === 'decline') {
      return { status: 'declined', effect: { kind: 'relay_decline_to_owner' } }
    }
    return { status: current, effect: { kind: 'none' } } // unclear
  }

  // owner_decision
  const d = event.decision
  if (d.kind === 'confirm' && event.agreedSlot) {
    return { status: 'confirmed', effect: { kind: 'book_and_notify', slot: event.agreedSlot }, agreedSlot: event.agreedSlot }
  }
  if (d.kind === 'counter_offer') {
    return { status: 'awaiting_counterparty', effect: { kind: 'message_contact_new_candidate', slot: d.slot } }
  }
  if (d.kind === 'abandon') {
    return { status: 'abandoned', effect: { kind: 'none' } }
  }
  return { status: current, effect: { kind: 'none' } }
}
```

- [ ] **Step 5: Run — expect PASS**

Run: `npx vitest run src/domain/coordination/state.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add src/domain/coordination/types.ts src/domain/coordination/state.ts src/domain/coordination/state.test.ts
git commit -m "feat(coordination): pure state machine + slot classification"
```

---

## Task 5: Meeting render kind in event-content

**Files:**
- Modify: `src/domain/calendar/event-content.ts`
- Test: `src/domain/calendar/event-content.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `event-content.test.ts`)

```ts
describe('renderBookingEvent — meeting', () => {
  const base = {
    kind: 'meeting' as const,
    title: 'Meeting with the accountant',
    contact: { name: 'Harel Cohen', phone: '+972521112233' },
  }
  it('title is "meeting title — contact"', () => {
    expect(renderBookingEvent(base, 'en').title).toBe('Meeting with the accountant — Harel Cohen')
  })
  it('description lists contact + phone', () => {
    expect(renderBookingEvent(base, 'en').description).toBe('With: Harel Cohen\nPhone: +972521112233')
  })
  it('renders Hebrew labels', () => {
    expect(renderBookingEvent({ ...base, contact: { name: 'הראל', phone: '+972521112233' } }, 'he').description)
      .toBe('עם: הראל\nטלפון: +972521112233')
  })
})
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run src/domain/calendar/event-content.test.ts`
Expected: FAIL (`'meeting'` not assignable to the content union).

- [ ] **Step 3: Implement the meeting kind**

In `src/domain/calendar/event-content.ts`:

1. Add labels to **both** `LABELS.he` and `LABELS.en`:
   - he: `with: 'עם',` (client/phone already exist — reuse `phone`).
   - en: `with: 'With',`
2. Add the interface and extend the union:

```ts
export interface MeetingEventContent {
  kind: 'meeting'
  title: string
  contact: EventPerson
}

export type BookingEventContent = OneOnOneEventContent | GroupEventContent | MeetingEventContent
```

3. In `renderBookingEvent`, add a branch (before the group branch is fine):

```ts
if (content.kind === 'meeting') {
  const who = personLabel(content.contact, L.noName)
  const lines: string[] = [`${L.with}: ${who}`]
  const phone = clean(content.contact.phone)
  if (phone) lines.push(`${L.phone}: ${phone}`)
  return { title: `${content.title} — ${who}`, description: lines.join('\n') }
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run src/domain/calendar/event-content.test.ts`
Expected: PASS (existing 11 + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/domain/calendar/event-content.ts src/domain/calendar/event-content.test.ts
git commit -m "feat(coordination): meeting render kind for calendar events"
```

---

## Task 6: Coordination repository

**Files:**
- Create: `src/domain/coordination/repository.ts`

- [ ] **Step 1: Implement the repository**

Create `src/domain/coordination/repository.ts`. It encapsulates all `meeting_coordinations` DB access so the handler stays readable.

```ts
import { and, eq, inArray, lt } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { meetingCoordinations } from '../../db/schema.js'
import type { Slot } from './types.js'

const ACTIVE = ['awaiting_counterparty', 'countered', 'awaiting_owner_confirm'] as const

export interface CoordinationRow {
  id: string
  businessId: string
  ownerId: string
  contactId: string
  title: string
  durationMinutes: number
  candidateSlots: Slot[]
  status: typeof ACTIVE[number] | 'confirmed' | 'declined' | 'expired' | 'abandoned'
  agreedSlotStart: Date | null
  agreedSlotEnd: Date | null
  expiresAt: Date
}

function hydrate(row: typeof meetingCoordinations.$inferSelect): CoordinationRow {
  const raw = (row.candidateSlots as Array<{ start: string; end: string }>)
  return {
    id: row.id, businessId: row.businessId, ownerId: row.ownerId, contactId: row.contactId,
    title: row.title, durationMinutes: row.durationMinutes,
    candidateSlots: raw.map((s) => ({ start: new Date(s.start), end: new Date(s.end) })),
    status: row.status as CoordinationRow['status'],
    agreedSlotStart: row.agreedSlotStart, agreedSlotEnd: row.agreedSlotEnd, expiresAt: row.expiresAt,
  }
}

export async function insertCoordination(db: Db, input: {
  businessId: string; ownerId: string; contactId: string; title: string;
  durationMinutes: number; candidateSlots: Slot[]; expiresAt: Date
}): Promise<string> {
  const [row] = await db.insert(meetingCoordinations).values({
    businessId: input.businessId, ownerId: input.ownerId, contactId: input.contactId,
    title: input.title, durationMinutes: input.durationMinutes,
    candidateSlots: input.candidateSlots.map((s) => ({ start: s.start.toISOString(), end: s.end.toISOString() })),
    status: 'awaiting_counterparty', expiresAt: input.expiresAt,
  }).returning({ id: meetingCoordinations.id })
  return row!.id
}

export async function findActiveByContact(db: Db, businessId: string, contactId: string): Promise<CoordinationRow | null> {
  const [row] = await db.select().from(meetingCoordinations)
    .where(and(
      eq(meetingCoordinations.businessId, businessId),
      eq(meetingCoordinations.contactId, contactId),
      inArray(meetingCoordinations.status, ACTIVE as unknown as string[]),
    )).limit(1)
  return row ? hydrate(row) : null
}

export async function findById(db: Db, businessId: string, id: string): Promise<CoordinationRow | null> {
  const [row] = await db.select().from(meetingCoordinations)
    .where(and(eq(meetingCoordinations.businessId, businessId), eq(meetingCoordinations.id, id))).limit(1)
  return row ? hydrate(row) : null
}

export async function updateCoordination(db: Db, id: string, patch: {
  status: string; agreedSlot?: Slot; counterSlot?: Slot; calendarEventId?: string; googleEtag?: string | null
}): Promise<void> {
  await db.update(meetingCoordinations).set({
    status: patch.status,
    ...(patch.agreedSlot ? { agreedSlotStart: patch.agreedSlot.start, agreedSlotEnd: patch.agreedSlot.end } : {}),
    ...(patch.counterSlot ? { counterSlotStart: patch.counterSlot.start, counterSlotEnd: patch.counterSlot.end } : {}),
    ...(patch.calendarEventId !== undefined ? { calendarEventId: patch.calendarEventId } : {}),
    ...(patch.googleEtag !== undefined ? { googleEtag: patch.googleEtag } : {}),
    updatedAt: new Date(),
  }).where(eq(meetingCoordinations.id, id))
}

export async function findExpired(db: Db, now: Date): Promise<CoordinationRow[]> {
  const rows = await db.select().from(meetingCoordinations)
    .where(and(
      inArray(meetingCoordinations.status, ['awaiting_counterparty', 'countered'] as unknown as string[]),
      lt(meetingCoordinations.expiresAt, now),
    ))
  return rows.map(hydrate)
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/domain/coordination/repository.ts
git commit -m "feat(coordination): meeting_coordinations repository"
```

---

## Task 7: Contact reply interpretation (LLM)

**Files:**
- Create: `src/domain/coordination/interpret.ts`

- [ ] **Step 1: Implement the interpreter**

Create `src/domain/coordination/interpret.ts`. It turns a contact's free-text reply into a structured intent, resolving any proposed time deterministically. Read `src/adapters/llm/client.ts` for the existing `callWithSchema`-style helper used by other classifiers (e.g. the classifier used in customer-booking) and follow that exact call pattern; do not invent a new LLM entry point.

```ts
import { resolveSlotRange } from '../availability/resolve-slot.js'
import type { Slot } from './types.js'
// Reuse the project's structured-output LLM helper. Match the pattern already used
// by other classifiers in src/adapters/llm/client.ts.
import { classifyWithSchema } from '../../adapters/llm/client.js' // confirm the actual exported name; align with existing classifiers

export type ContactIntent =
  | { kind: 'accept' | 'counter' | 'decline' | 'unclear'; slot?: Slot }

// The LLM only extracts structured pieces; it NEVER computes an absolute date.
interface RawContactIntent {
  intent: 'accept' | 'counter' | 'decline' | 'unclear'
  // present only for 'counter': structured date/time pieces, same shape as DATE_PIECES_SCHEMA
  date?: { relativeDay?: string; weekday?: number; explicitDate?: { year?: number; month?: number; day?: number } }
  startTime?: { hour: number; minute: number }
}

export async function interpretContactReply(opts: {
  replyText: string
  candidateSummaries: string  // human description of the offered times, for the LLM's context
  durationMinutes: number
  timezone: string
  lang: 'he' | 'en'
}): Promise<ContactIntent> {
  const raw = await classifyWithSchema<RawContactIntent>({
    /* system + user prompt: "A contact was offered these meeting times: <candidateSummaries>.
       Classify their reply as accept (one of the offered times), counter (a different time —
       report the date/time pieces, NEVER an absolute date), decline, or unclear." */
    // ...follow existing classifier call signature...
  } as never)

  if (raw.intent === 'counter' && raw.date && raw.startTime) {
    const resolved = resolveSlotRange(
      { date: {
          relativeDay: (raw.date.relativeDay as never) ?? null,
          weekday: raw.date.weekday ?? null,
          explicitDate: raw.date.explicitDate
            ? { year: raw.date.explicitDate.year ?? null, month: raw.date.explicitDate.month ?? null, day: raw.date.explicitDate.day ?? null }
            : null,
        },
        startTime: raw.startTime,
        endTime: null,
        durationMinutes: opts.durationMinutes,
      },
      opts.timezone,
      new Date(),
    )
    if (resolved.ok) return { kind: 'counter', slot: { start: resolved.start, end: resolved.end } }
    return { kind: 'unclear' }
  }
  if (raw.intent === 'accept') return { kind: 'accept' }
  if (raw.intent === 'decline') return { kind: 'decline' }
  return { kind: 'unclear' }
}
```

> **Implementer note:** the exact LLM helper name/signature (`classifyWithSchema` above is a placeholder for whatever `src/adapters/llm/client.ts` actually exports for schema-constrained classification) MUST be reconciled with the real export before writing code. Find the helper the customer-booking classifier uses and copy its call shape. For `accept`, the precise candidate index is decided deterministically by `classifyContactReply` in the handler using the resolved slot — so when the LLM says `accept` but gives no slot, the handler re-derives the match from the reply; if it can't, it treats it as `unclear` and asks one clarifying question.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS once the real helper name is wired.

- [ ] **Step 3: Commit**

```bash
git add src/domain/coordination/interpret.ts
git commit -m "feat(coordination): contact reply interpreter (deterministic time resolution)"
```

---

## Task 8: Coordination handler (start + advance)

**Files:**
- Create: `src/domain/coordination/handler.ts`
- Test: `src/domain/coordination/handler.test.ts`

- [ ] **Step 1: Implement `handler.ts`**

Create `src/domain/coordination/handler.ts`. It wires repository + state machine + interpret + side effects. Keep all messaging through `sendMessage` and owner/contact phrasing through `generateProactiveCustomerMessage` with i18n fallbacks (Task 12). Every transition writes `logAudit`.

Key functions:

```ts
import type { Db } from '../../db/client.js'
import type { CalendarClient } from '../../adapters/calendar/client.js'
import { nextCoordinationState, classifyContactReply } from './state.js'
import { interpretContactReply } from './interpret.js'
import * as repo from './repository.js'
import type { Slot } from './types.js'
import { renderBookingEvent } from '../calendar/event-content.js'
import { logAudit } from '../audit/logger.js'
// + sendMessage, generateProactiveCustomerMessage, identities/businesses lookups, i18n

// Called by executeCoordinateMeeting (Task 9): contact already registered, slots resolved.
export async function startCoordination(db: Db, calendar: CalendarClient, input: {
  businessId: string; ownerId: string; contactId: string; contactPhone: string;
  title: string; durationMinutes: number; candidateSlots: Slot[]; lang: 'he' | 'en';
  businessName: string; waCredentials: { accessToken: string; phoneNumberId: string } | undefined;
}): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
  // 1. availability guard: drop any candidate the owner's calendar isn't free for.
  //    (calendar.checkAvailability per slot; if NONE free, return ok:false 'no_free_candidates'.)
  // 2. insert row (expiresAt = now + COORDINATION_EXPIRY_HOURS).
  // 3. send the candidate times to the contact (sendMessage). If send fails (outsideWindow),
  //    keep the row 'awaiting_counterparty' and return ok:false 'contact_unreachable' so the
  //    tool reports the truth to the owner.
  // 4. logAudit 'coordination.started'.
}

// Called by routeContactMessage (Task 11).
export async function advanceFromContact(db: Db, calendar: CalendarClient, row: repo.CoordinationRow, replyText: string, businessCtx: BusinessCtx): Promise<void> {
  const intent = await interpretContactReply({ replyText, candidateSummaries: describe(row.candidateSlots, businessCtx), durationMinutes: row.durationMinutes, timezone: businessCtx.timezone, lang: businessCtx.lang })
  const replyClass = intent.kind === 'counter' && intent.slot
    ? classifyContactReply(intent.slot, row.candidateSlots)        // a "counter" that matches a candidate is really an accept
    : intent.kind === 'accept'
      ? { kind: 'unclear' as const }                                // accept w/o a slot → ask which time (handled by 'unclear')
      : { kind: intent.kind } as ContactReplyClass
  const t = nextCoordinationState(row.status, { type: 'contact_reply', reply: replyClass, candidates: row.candidateSlots })
  await applyTransition(db, calendar, row, t, businessCtx, { fromContactUnclear: replyClass.kind === 'unclear' })
}

// Called by executeResolveMeetingCoordination (Task 9).
export async function advanceFromOwner(db: Db, calendar: CalendarClient, row: repo.CoordinationRow, decision: OwnerDecision, businessCtx: BusinessCtx): Promise<void> {
  const agreedSlot = row.agreedSlotStart && row.agreedSlotEnd
    ? { start: row.agreedSlotStart, end: row.agreedSlotEnd }
    : row.status === 'countered' ? counterSlotFromRow(row) : undefined
  const t = nextCoordinationState(row.status, { type: 'owner_decision', decision, candidates: row.candidateSlots, agreedSlot })
  await applyTransition(db, calendar, row, t, businessCtx, {})
}
```

`applyTransition` performs `t.effect`:
- `ping_owner_confirm` → `updateCoordination(status, agreedSlot)`, send owner a phrased confirm prompt, soft-ack the contact ("let me confirm and lock it in"), `logAudit 'coordination.contact_replied'`.
- `relay_counter_to_owner` → `updateCoordination(status, counterSlot)`, relay to owner, audit.
- `relay_decline_to_owner` → update + tell owner, audit.
- `message_contact_new_candidate` → append the new slot to `candidateSlots` (so a later accept matches), update status, message contact, audit.
- `book_and_notify` → `checkAvailability` once more; if busy, tell owner and **do not** book (leave status as-is, audit `coordination.book_conflict`); else create the calendar event using `renderBookingEvent({ kind: 'meeting', title: row.title, contact })`, store `calendarEventId`, set status `confirmed`, tell the contact "you're set", `logAudit 'coordination.booked'`.
- `notify_owner_expired` → update + tell owner, audit.
- `none` with `fromContactUnclear` → ask the contact one clarifying question (no state change).

Add `const COORDINATION_EXPIRY_HOURS = parseInt(process.env['COORDINATION_EXPIRY_HOURS'] ?? '72', 10)`.

- [ ] **Step 2: Write the integration test**

Create `src/domain/coordination/handler.test.ts`. Mock `db`, `calendar` (`checkAvailability` → available, `upsertMirrorEvent`/event create → ok), the LLM interpreter, and `sendMessage`. Drive: start → contact counters → owner counter_offer → contact accepts new candidate → owner confirms → booked. Assert status at each step and that `book_and_notify` created an event and messaged the contact. (Follow the mocking style in `tests/booking/attendance.test.ts`.)

- [ ] **Step 3: Run — expect PASS**

Run: `npx vitest run src/domain/coordination/handler.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/domain/coordination/handler.ts src/domain/coordination/handler.test.ts
git commit -m "feat(coordination): negotiation handler (start + advance)"
```

---

## Task 9: Branch 3 tool handlers

**Files:**
- Create: `src/domain/manager/coordination-tools.ts`

- [ ] **Step 1: Implement the two tool executors**

Create `src/domain/manager/coordination-tools.ts`. Both gate on `authorize(ctx, 'meeting.coordinate')` first.

```ts
import { authorize } from '../authorization/check.js'
import { registerCustomer } from '../identity/resolver.js' // see note below
import { resolveSlotRange } from '../availability/resolve-slot.js'
import { startCoordination, advanceFromOwner } from '../coordination/handler.js'
import { findById, findActiveByContact } from '../coordination/repository.js'
import type { ToolContext } from './orchestrator-tools.js'
// + identities/businesses lookups, toDateParts/clarifyDate equivalents, i18n

interface CoordinateMeetingArgs {
  contactName?: string
  phoneNumber?: string
  title: string
  date: DatePieces
  startTime: TimePieces
  endTime?: TimePieces
  durationMinutes?: number
  fallbacks?: Array<{ date: DatePieces; startTime: TimePieces }>
}

export async function executeCoordinateMeeting(args: CoordinateMeetingArgs, ctx: ToolContext): Promise<object> {
  const auth = authorize({ role: ctx.role ?? 'manager', ...(ctx.delegatedPermissions ? { delegatedPermissions: ctx.delegatedPermissions } : {}) }, 'meeting.coordinate')
  if (!auth.allowed) return { success: false, reason: 'not_authorized', guidance: 'Only the owner can have me coordinate a meeting.' }

  // 1. Resolve primary slot via resolveSlotRange (end via endTime OR durationMinutes).
  //    On failure → clarifyDate(reason).
  // 2. Resolve each fallback to a slot (duration = primary duration). Skip unresolved.
  // 3. Require a phone number to reach a new contact, or match an existing 'contact' by name.
  //    Register a NEW contact: see registration note. Reuse an existing contact identity if present.
  // 4. startCoordination(...). Return ok / honest failure (no_free_candidates, contact_unreachable).
}

interface ResolveMeetingCoordinationArgs {
  coordinationId: string
  action: 'confirm' | 'counter_offer' | 'abandon'
  counterTime?: { date: DatePieces; startTime: TimePieces }
}

export async function executeResolveMeetingCoordination(args: ResolveMeetingCoordinationArgs, ctx: ToolContext): Promise<object> {
  const auth = authorize({ role: ctx.role ?? 'manager', ...(ctx.delegatedPermissions ? { delegatedPermissions: ctx.delegatedPermissions } : {}) }, 'meeting.coordinate')
  if (!auth.allowed) return { success: false, reason: 'not_authorized' }
  const row = await findById(ctx.db, ctx.businessId, args.coordinationId)
  if (!row) return { success: false, reason: 'not_found' }
  // For counter_offer: resolveSlotRange(counterTime, duration) → slot; else clarifyDate.
  // advanceFromOwner(...). Return ok.
}
```

> **Registration note:** `registerCustomer` hard-codes `role: 'customer'`. Add a sibling `registerContact(db, businessId, phone, displayName)` in `src/domain/identity/resolver.ts` that is identical but inserts `role: 'contact'` (DRY: extract a private `registerIdentity(db, businessId, phone, role, displayName)` and have both call it). Use `registerContact` here — NOT `registerCustomer` — so counterparties never enter the CRM.

- [ ] **Step 2: Add `registerContact` (TDD)**

Create `src/domain/identity/register-contact.test.ts` asserting a freshly registered contact has `role: 'contact'`, then implement `registerContact` / the shared `registerIdentity` helper.

Run: `npx vitest run src/domain/identity/register-contact.test.ts`
Expected: FAIL → implement → PASS.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/domain/manager/coordination-tools.ts src/domain/identity/resolver.ts src/domain/identity/register-contact.test.ts
git commit -m "feat(coordination): Branch 3 tool handlers + registerContact"
```

---

## Task 10: Orchestrator registration + prompt verify-gate

**Files:**
- Modify: `src/adapters/llm/orchestrator.ts`

- [ ] **Step 1: Declare the two tools**

Add to `MANAGER_TOOLS` (the `functionDeclarations` array), following the existing `createCalendarEvent` shape and using `DATE_PIECES_SCHEMA` / `timeSchema(...)`:

```ts
{
  name: 'coordinateMeeting',
  description: 'Coordinate a NEW meeting with someone on the owner\'s behalf — only when the owner has NOT already agreed a time and wants the PA to reach out. First confirm with the owner that they want you to coordinate (vs. they already set it), and capture a primary time AND one or two fallback times. Report all dates/times as structured pieces — NEVER an absolute/ISO date. For a meeting whose time is already agreed, use createCalendarEvent instead.',
  parameters: { type: Type.OBJECT, properties: {
    contactName: { type: Type.STRING, description: 'Name of the person to meet, if given.' },
    phoneNumber: { type: Type.STRING, description: 'Their phone in E.164 — required to reach someone new.' },
    title: { type: Type.STRING, description: 'What the meeting is about (e.g. "Meeting with the accountant").' },
    date: DATE_PIECES_SCHEMA,
    startTime: timeSchema('Primary start clock time the owner said, 24-hour'),
    endTime: timeSchema('Primary end clock time, 24-hour. Provide this OR durationMinutes.'),
    durationMinutes: { type: Type.NUMBER, description: 'Meeting length in minutes; provide this OR endTime.' },
    fallbacks: { type: Type.ARRAY, description: 'One or two backup times to offer if the primary does not work.', items: { type: Type.OBJECT, properties: { date: DATE_PIECES_SCHEMA, startTime: timeSchema('Fallback start time, 24-hour') }, required: ['date', 'startTime'] } },
  }, required: ['title', 'date', 'startTime'] },
},
{
  name: 'resolveMeetingCoordination',
  description: 'Act on an in-progress meeting coordination after the counterparty replied — confirm the agreed time (books it), offer a different time, or abandon it. The active coordination id is given to you in context. Report any counter time as structured pieces, never an absolute date.',
  parameters: { type: Type.OBJECT, properties: {
    coordinationId: { type: Type.STRING, description: 'Id of the coordination from context.' },
    action: { type: Type.STRING, enum: ['confirm', 'counter_offer', 'abandon'] },
    counterTime: { type: Type.OBJECT, description: 'For counter_offer: the new time to offer.', properties: { date: DATE_PIECES_SCHEMA, startTime: timeSchema('New offer start, 24-hour') }, required: ['date', 'startTime'] },
  }, required: ['coordinationId', 'action'] },
},
```

- [ ] **Step 2: Add dispatch cases**

In the dispatch `switch` (alongside the existing cases ~560–602):

```ts
case 'coordinateMeeting':
  return executeCoordinateMeeting(args as unknown as Parameters<typeof executeCoordinateMeeting>[0], ctx)
case 'resolveMeetingCoordination':
  return executeResolveMeetingCoordination(args as unknown as Parameters<typeof executeResolveMeetingCoordination>[0], ctx)
```

Add the import: `import { executeCoordinateMeeting, executeResolveMeetingCoordination } from '../../domain/manager/coordination-tools.js'`.

- [ ] **Step 3: Mark them state-changing**

Add `'coordinateMeeting'` and `'resolveMeetingCoordination'` to the state-changing tool list (the `case` block near line 626 that the existing `messageCustomer`/`createCalendarEvent` are in).

- [ ] **Step 4: Inject active coordinations into context**

Where the Branch 3 system context is assembled (the grounding/context block), add a short rendered list of this business's active `meeting_coordinations` (id, contact name, status, the agreed/counter time) so the model can call `resolveMeetingCoordination` with the right id. Query via `findActiveByContact` is per-contact; add a `findActiveByBusiness(db, businessId)` to the repository for this read, returning the non-terminal rows. Render e.g.: `Active meeting coordinations: [<id>] with Harel — awaiting your confirm for Thu 25 Jun 15:00.`

- [ ] **Step 5: Add the verify-gate prompt guidance**

In the Branch 3 system prompt, add a short rule near the calendar-tools guidance:

```
- Setting a meeting with someone: if the owner has ALREADY agreed a time with that person, just put it on the calendar (createCalendarEvent). If they have NOT, and want you to reach out, use coordinateMeeting — first ask (one question) whether they've arranged it or want you to coordinate, and ask for a primary time plus one or two fallback times. Never message the other person before the owner has asked you to coordinate.
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/adapters/llm/orchestrator.ts src/domain/coordination/repository.ts
git commit -m "feat(coordination): register Branch 3 tools + verify-gate prompt + active-coordination context"
```

---

## Task 11: Inbound routing for contacts

**Files:**
- Modify: `src/routes/webhook.ts`

- [ ] **Step 1: Add the routing branch**

At the role dispatch (`src/routes/webhook.ts:207`), change:

```ts
if (identity.role === 'manager' || identity.role === 'delegated_user') {
  await routeManagerMessage(msg, identity, business, app)
} else {
  await routeCustomerMessage(msg, identity, business, app)
}
```

to:

```ts
if (identity.role === 'manager' || identity.role === 'delegated_user') {
  await routeManagerMessage(msg, identity, business, app)
} else if (identity.role === 'contact') {
  await routeContactMessage(msg, identity, business, app)
} else {
  await routeCustomerMessage(msg, identity, business, app)
}
```

- [ ] **Step 2: Implement `routeContactMessage`**

Add the function near `routeCustomerMessage`. It loads the active coordination and advances it, or relays a stray message to the owner:

```ts
async function routeContactMessage(msg: InboundMessage, identity: ResolvedIdentity, business: BusinessRow, app: FastifyInstance): Promise<void> {
  const row = await findActiveByContact(db, business.id, identity.id)
  const businessCtx = buildBusinessCtx(business, identity) // tz, lang, waCredentials, businessName
  if (!row) {
    // No active coordination — relay to the owner so nothing is dropped, then return.
    await relayStrayContactMessage(db, business, identity, msg.text)
    return
  }
  const calendar = await buildCalendarClient(business) // same construction used by the manager/customer routes
  await advanceFromContact(db, calendar, row, msg.text, businessCtx)
}
```

Reuse the calendar-client construction and business-context helpers already used by `routeCustomerMessage`/`routeManagerMessage` (read those to match exact argument shapes — do not duplicate credential logic). For `relayStrayContactMessage`, reuse the existing owner-notification path (the `generateProactiveCustomerMessage` + `sendMessage` to the manager pattern from `outreach-reply-notify.ts`).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Add a routing test**

Create `tests/routes/contact-routing.test.ts`: a `contact` inbound with a stubbed active coordination calls `advanceFromContact`; with none, calls the relay and never `routeCustomerMessage`. (Mock the repository + handler.)

Run: `npx vitest run tests/routes/contact-routing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/webhook.ts tests/routes/contact-routing.test.ts
git commit -m "feat(coordination): route contact inbound to the coordination handler"
```

---

## Task 12: i18n strings

**Files:**
- Modify: `src/domain/i18n/t.ts`

- [ ] **Step 1: Add the fallback strings**

Add entries to the `strings` object (both `he` and `en`), following the existing `outreach_reply_notify` shape. Each is a function returning the literal fallback used when `generateProactiveCustomerMessage` times out:

```ts
coordination_offer_to_contact: {
  he: (businessName: string, times: string) => `שלום, מ${businessName} — רוצים לקבוע פגישה. מתאים לך אחד מהמועדים: ${times}? אפשר גם להציע זמן אחר.`,
  en: (businessName: string, times: string) => `Hi, this is ${businessName} — we'd like to set up a meeting. Do any of these work: ${times}? Or suggest another time.`,
},
coordination_confirm_to_owner: {
  he: (contact: string, time: string) => `${contact} פנוי ל${time}. לקבוע?`,
  en: (contact: string, time: string) => `${contact} is good for ${time}. Want me to book it?`,
},
coordination_counter_to_owner: {
  he: (contact: string, time: string) => `${contact} הציע ${time} במקום. לאשר, או להציע זמן אחר?`,
  en: (contact: string, time: string) => `${contact} suggested ${time} instead. Take it, or offer another time?`,
},
coordination_decline_to_owner: {
  he: (contact: string) => `${contact} לא יכול במועדים שהצענו.`,
  en: (contact: string) => `${contact} can't make the times we offered.`,
},
coordination_soft_ack_to_contact: {
  he: () => `מעולה — אאשר ואחזור אליך לסגור.`,
  en: () => `Great — let me confirm and I'll get back to you to lock it in.`,
},
coordination_booked_to_contact: {
  he: (time: string) => `סגור — נקבענו ל${time}. נתראה!`,
  en: (time: string) => `You're set — ${time}. See you then!`,
},
coordination_expired_to_owner: {
  he: (contact: string) => `לא קיבלתי תשובה מ${contact} על הפגישה. רוצה שאנסה שוב?`,
  en: (contact: string) => `I didn't hear back from ${contact} about the meeting. Want me to try again?`,
},
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/domain/i18n/t.ts
git commit -m "feat(coordination): i18n fallback strings (he/en)"
```

---

## Task 13: Expiry worker hook (lightweight)

**Files:**
- Modify: an existing periodic worker (e.g. the reminder/sweep cron) — find where periodic sweeps run (`src/workers/`), and add a coordination expiry sweep.

- [ ] **Step 1: Add the sweep**

Find the existing scheduled sweep (look for `setInterval`/cron-style worker startup in `src/workers/`). Add a step that calls a new `expireStaleCoordinations(db, calendar)`:

```ts
// src/domain/coordination/handler.ts — add:
export async function expireStaleCoordinations(db: Db, /* per-business calendar factory */): Promise<void> {
  const rows = await repo.findExpired(db, new Date())
  for (const row of rows) {
    const businessCtx = await loadBusinessCtx(db, row.businessId)
    const t = nextCoordinationState(row.status, { type: 'expire' })
    await applyTransition(db, /* calendar for business */, row, t, businessCtx, {})
  }
}
```

- [ ] **Step 2: Typecheck + test**

Run: `npx tsc --noEmit && npx vitest run src/domain/coordination`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/domain/coordination/handler.ts src/workers/<sweep-file>.ts
git commit -m "feat(coordination): expire stale coordinations on the periodic sweep"
```

---

## Task 14: Full verification

- [ ] **Step 1: Typecheck the whole project**

Run: `npx tsc --noEmit`
Expected: PASS (exit 0).

- [ ] **Step 2: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — all existing tests plus the new coordination, authorization, renderer, and routing tests.

- [ ] **Step 3: Update docs**

- Add a short "Meeting coordination" subsection under Branch 3 in `CLAUDE.md` (contacts are a Branch-3 outbound sub-case, not a fifth branch).
- Note the new `COORDINATION_EXPIRY_HOURS` env var (default 72) wherever env vars are documented.

```bash
git add CLAUDE.md
git commit -m "docs(coordination): document Branch 3 meeting coordination + env var"
```

- [ ] **Step 4: Deploy note**

Deployment runs migration `0024` via the runbook. After deploy, run `scripts/apply-coordination-migration.ts` against prod (Cloud SQL proxy) and confirm `meeting_coordinations present ✓`, per the deploy skill's migration-verification step. Do NOT deploy as part of plan execution unless the user asks.

---

## Notes for the implementer

- **LLM helper reconciliation (Task 7):** before writing `interpret.ts`, open `src/adapters/llm/client.ts` and find the schema-constrained classification helper the customer-booking classifier uses. The `classifyWithSchema` name in the plan is a stand-in. Match the real signature.
- **Business-context + calendar construction (Tasks 8, 11):** `routeManagerMessage` / `routeCustomerMessage` already build the per-business calendar client and resolve language/credentials. Extract or reuse those helpers — do not re-implement credential resolution.
- **One active coordination per contact:** `executeCoordinateMeeting` should check `findActiveByContact` first and, if one exists, return a result that tells the owner to resolve it before starting another.
- **Grounding:** the PA must not tell the owner "booked" or "messaged Harel" unless the corresponding tool/handler returned ok. The honest-failure return values (`contact_unreachable`, `no_free_candidates`, `book_conflict`) exist for exactly this.
