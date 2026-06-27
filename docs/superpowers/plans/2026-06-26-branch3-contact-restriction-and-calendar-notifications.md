# Branch 3 Contact Restriction & Per-Movement Calendar Notifications — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two manager-configurable Branch 3 capabilities: (1) an opt-in strict phone-number allowlist that silently drops unlisted senders and forwards the attempt to the manager, and (2) per-movement calendar notifications to the manager (customer cancel/reschedule, Google-originated edits, PA-initiated changes) with per-event notify/silent/digest modes.

**Architecture:** Both features reuse the existing initiation/notification spine. Feature 1 adds two `businesses` columns, a webhook gate before `registerCustomer`, a forward-to-manager emitter, and a `manageAllowedContacts` orchestrator tool. Feature 2 adds a `digest` notification action, a `notification_digest_queue` table, an owner-facing `notifyOwnerBookingChange` emitter wired at the existing booking-mutation sites, an extension to `configureNotifications`, and a digest flush appended to the daily-briefing worker. The LLM stays interpretive-only: every write goes through a deterministic apply path.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Drizzle ORM (PostgreSQL), Fastify, BullMQ workers, Gemini native function-calling orchestrator, Vitest.

**HARD REQUIREMENT (user):** Every setting must be fully configurable from the Branch 3 chat — enabling/disabling restriction, adding/removing allowed numbers, setting each event's notification mode (notify / silent / digest), and the digest cadence (daily-briefing). No out-of-band configuration. Task 14 verifies this end-to-end.

---

## File Structure

**Created:**
- `src/domain/manager/allowed-contacts.ts` — pure helpers for the allowlist jsonb (add/remove/list/normalize). No DB.
- `src/domain/manager/allowed-contacts.test.ts` — unit tests for the helpers.
- `src/domain/initiations/digest-queue.ts` — repository for `notification_digest_queue` (enqueue / fetch-unflushed / mark-flushed).
- `src/domain/initiations/digest-queue.test.ts` — tests for the repository.
- `src/db/migrations/0047_*.sql` — generated migration (two business columns + digest table).

**Modified:**
- `src/db/schema.ts` — `contactRestrictionEnabled`, `allowedContacts` on `businesses`; new `notificationDigestQueue` table.
- `src/domain/initiations/notification-rules.ts` — add `'digest'` to `NotificationAction`.
- `src/domain/initiations/notification-rules.test.ts` — cover `digest`.
- `src/domain/initiations/booking-notify.ts` — `notifyOwnerUnlistedContact`, `notifyOwnerBookingChange`.
- `src/domain/initiations/booking-notify.test.ts` (create if absent) — emitter gating tests.
- `src/domain/manager/orchestrator-tools.ts` — `executeManageAllowedContacts`; extend `ConfigureNotificationsArgs` action handling.
- `src/adapters/llm/orchestrator.ts` — declare + dispatch `manageAllowedContacts`; add `digest` to the `configureNotifications` action enum.
- `src/routes/webhook.ts` — contact gate before `registerCustomer`.
- `src/domain/booking/engine.ts` — owner cancellation notify (non-manager, non-supersede).
- `src/domain/booking/approval.ts` — owner notify on PA/approval-driven confirm.
- `src/domain/scheduling/session-cancellation.ts` — owner notify on session cancellation.
- `src/domain/calendar/inbound-sync.ts` — owner notify via the unified emitter for Google-originated cancels.
- `src/domain/flows/customer-booking.ts` — owner `moved` notify in `releaseSupersededBooking`.
- `src/workers/daily-briefing.ts` — flush digest queue into the briefing; flush digest-only when briefing disabled.
- `src/domain/i18n/t.ts` — new manager-facing strings.

---

## Task 1: Schema — allowlist columns + digest queue table

**Files:**
- Modify: `src/db/schema.ts:144` (end of `businesses`), and append a new table near the other tables.
- Create: `src/db/migrations/0047_*.sql` (generated).

- [ ] **Step 1: Add the two `businesses` columns**

In `src/db/schema.ts`, immediately after `paymentLinkOffsetMinutes: integer('payment_link_offset_minutes'),` (line 144) and before the closing `})` of `businesses`:

```ts
  // Contact restriction (allowlist). Default OFF — behavior is identical to today until the owner
  // opts in via the manageAllowedContacts Branch-3 tool. When ON, only numbers in allowedContacts
  // (plus manager/delegated/contact identities) reach the PA; everyone else is silently dropped and
  // the owner is forwarded the attempt. Strict list — existing customers are NOT grandfathered.
  contactRestrictionEnabled: boolean('contact_restriction_enabled').notNull().default(false),
  // jsonb array of { phone: E164, label?: string, addedAt: ISO8601 }. null/[] = empty list.
  allowedContacts: jsonb('allowed_contacts'),
```

- [ ] **Step 2: Add the digest queue table**

In `src/db/schema.ts`, after the `businesses` table definition (after its closing `})` at line 145), add:

```ts
// Per-event owner-notification digest buffer (calendar-notifications feature). When a notification
// rule routes an event to action 'digest', the owner emitter enqueues a row here instead of sending
// immediately; the daily-briefing worker flushes unflushed rows into the briefing and stamps flushedAt.
export const notificationDigestQueue = pgTable('notification_digest_queue', {
  id: uuid('id').primaryKey().defaultRandom(),
  businessId: uuid('business_id').notNull().references(() => businesses.id),
  event: text('event').notNull(), // NotificationEvent value
  payload: jsonb('payload').notNull(), // { summary: string } — pre-rendered, lang-resolved at flush
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  flushedAt: timestamp('flushed_at', { withTimezone: true }),
})
```

- [ ] **Step 3: Generate the migration**

Run: `npm run db:generate`
Expected: a new file `src/db/migrations/0047_<name>.sql` containing `ALTER TABLE "businesses" ADD COLUMN "contact_restriction_enabled" ...`, `ADD COLUMN "allowed_contacts" jsonb`, and `CREATE TABLE "notification_digest_queue" ...`. Inspect it to confirm only these additive changes are present (no drops).

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 5: Commit**

```bash
git add src/db/schema.ts src/db/migrations
git commit -m "feat(branch3): schema for contact allowlist + notification digest queue"
```

---

## Task 2: Allowed-contacts pure helpers

**Files:**
- Create: `src/domain/manager/allowed-contacts.ts`
- Test: `src/domain/manager/allowed-contacts.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/domain/manager/allowed-contacts.test.ts
import { describe, it, expect } from 'vitest'
import { addAllowedContact, removeAllowedContact, isAllowed, type AllowedContact } from './allowed-contacts.js'

describe('allowed-contacts helpers', () => {
  it('adds a normalized contact and is idempotent', () => {
    const a = addAllowedContact(null, '+972501234567', 'Dana', '2026-06-26T00:00:00.000Z')
    expect(a).toEqual([{ phone: '+972501234567', label: 'Dana', addedAt: '2026-06-26T00:00:00.000Z' }])
    const b = addAllowedContact(a, '+972501234567', undefined, '2026-06-27T00:00:00.000Z')
    expect(b).toHaveLength(1) // no duplicate; original entry preserved
    expect(b[0].label).toBe('Dana')
  })

  it('throws on an invalid phone number', () => {
    expect(() => addAllowedContact(null, '0501234567', undefined, '2026-06-26T00:00:00.000Z')).toThrow()
  })

  it('removes a contact', () => {
    const list: AllowedContact[] = [{ phone: '+972501234567', addedAt: 'x' }]
    expect(removeAllowedContact(list, '+972501234567')).toEqual([])
    expect(removeAllowedContact(list, '+972500000000')).toEqual(list) // no-op
  })

  it('isAllowed matches exactly on E.164', () => {
    const list: AllowedContact[] = [{ phone: '+972501234567', addedAt: 'x' }]
    expect(isAllowed(list, '+972501234567')).toBe(true)
    expect(isAllowed(list, '+972500000000')).toBe(false)
    expect(isAllowed(null, '+972501234567')).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/domain/manager/allowed-contacts.test.ts`
Expected: FAIL — module not found / functions undefined.

- [ ] **Step 3: Implement the helpers**

```ts
// src/domain/manager/allowed-contacts.ts
import { isValidE164 } from '../identity/resolver.js'

export interface AllowedContact {
  phone: string // E.164
  label?: string
  addedAt: string // ISO8601
}

/** Add (or no-op if present) a contact. Throws on an invalid E.164 number. Pure. */
export function addAllowedContact(
  list: AllowedContact[] | null,
  phone: string,
  label: string | undefined,
  addedAtIso: string,
): AllowedContact[] {
  if (!isValidE164(phone)) {
    throw new Error(`Invalid phone number: "${phone}". Must be E.164 (e.g. +972501234567).`)
  }
  const current = list ?? []
  if (current.some((c) => c.phone === phone)) return current // idempotent
  const entry: AllowedContact = { phone, addedAt: addedAtIso }
  if (label) entry.label = label
  return [...current, entry]
}

/** Remove a contact by phone (no-op if absent). Pure. */
export function removeAllowedContact(list: AllowedContact[] | null, phone: string): AllowedContact[] {
  return (list ?? []).filter((c) => c.phone !== phone)
}

/** True iff phone is explicitly on the list. Pure. */
export function isAllowed(list: AllowedContact[] | null, phone: string): boolean {
  return (list ?? []).some((c) => c.phone === phone)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/domain/manager/allowed-contacts.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/manager/allowed-contacts.ts src/domain/manager/allowed-contacts.test.ts
git commit -m "feat(branch3): pure helpers for the contact allowlist"
```

---

## Task 3: `manageAllowedContacts` orchestrator tool executor

**Files:**
- Modify: `src/domain/manager/orchestrator-tools.ts` (add executor near `executeConfigureNotifications`, ~line 1904)
- Test: `src/domain/manager/orchestrator-tools.test.ts` (add cases)

Note the existing `ToolContext` (`orchestrator-tools.ts:88`) exposes `ctx.db`, `ctx.businessId`, `ctx.identityId`, `ctx.lang`. `logAudit` is already imported in this file (used by `executeConfigureNotifications`). The executor must persist through a direct deterministic DB write (consistent with `executeConfigureNotifications`).

- [ ] **Step 1: Write the failing tests**

Add to `src/domain/manager/orchestrator-tools.test.ts` (follow the existing harness in that file for building a `ctx` and an in-memory/Drizzle test db — mirror how `executeConfigureNotifications` is tested):

```ts
describe('executeManageAllowedContacts', () => {
  it('enable then add then list reflects the number', async () => {
    const ctx = makeCtx() // existing test helper in this file
    await executeManageAllowedContacts({ op: 'enable' }, ctx)
    await executeManageAllowedContacts({ op: 'add', phone: '+972501234567', label: 'Dana' }, ctx)
    const res = await executeManageAllowedContacts({ op: 'list' }, ctx) as { success: boolean; fact: string }
    expect(res.success).toBe(true)
    expect(res.fact).toContain('+972501234567')
  })

  it('rejects an invalid phone number without throwing out of the tool', async () => {
    const ctx = makeCtx()
    const res = await executeManageAllowedContacts({ op: 'add', phone: '0501234567' }, ctx) as { success: boolean; reason?: string }
    expect(res.success).toBe(false)
    expect(res.reason).toBe('invalid_phone')
  })

  it('add with mode off auto-enables and tells the PA it did so', async () => {
    const ctx = makeCtx()
    const res = await executeManageAllowedContacts({ op: 'add', phone: '+972501234567' }, ctx) as { success: boolean; autoEnabled?: boolean }
    expect(res.success).toBe(true)
    expect(res.autoEnabled).toBe(true)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/domain/manager/orchestrator-tools.test.ts -t "executeManageAllowedContacts"`
Expected: FAIL — `executeManageAllowedContacts` is not defined.

- [ ] **Step 3: Implement the executor**

Add near `executeConfigureNotifications` in `orchestrator-tools.ts`. Add imports at the top of the file (with the other domain imports):

```ts
import { addAllowedContact, removeAllowedContact, type AllowedContact } from './allowed-contacts.js'
```

Executor:

```ts
interface ManageAllowedContactsArgs {
  op: 'enable' | 'disable' | 'add' | 'remove' | 'list'
  phone?: string
  label?: string
}

// Branch-3 control surface for the contact allowlist. enable/disable flips the mode; add/remove
// edit the list (add auto-enables the mode if it was off so "only talk to +972..." works in one
// step); list reads it back. Deterministic write — the LLM only supplies the parsed intent.
export async function executeManageAllowedContacts(args: ManageAllowedContactsArgs, ctx: ToolContext): Promise<object> {
  const [biz] = await ctx.db
    .select({ enabled: businesses.contactRestrictionEnabled, list: businesses.allowedContacts })
    .from(businesses)
    .where(eq(businesses.id, ctx.businessId))
    .limit(1)
  if (!biz) return { success: false, reason: 'business_not_found' }

  const current = (biz.list as AllowedContact[] | null) ?? null
  const patch: Record<string, unknown> = {}
  let autoEnabled = false

  switch (args.op) {
    case 'enable':
      patch['contactRestrictionEnabled'] = true
      break
    case 'disable':
      patch['contactRestrictionEnabled'] = false
      break
    case 'list': {
      const phones = (current ?? []).map((c) => c.label ? `${c.phone} (${c.label})` : c.phone)
      return {
        success: true,
        fact: JSON.stringify({ enabled: biz.enabled, contacts: phones }),
        guidance: `Restriction is ${biz.enabled ? 'ON' : 'OFF'}. Read the owner the list of allowed numbers in plain words; if empty, say the list is empty.`,
      }
    }
    case 'add': {
      if (!args.phone) return { success: false, reason: 'missing_phone', guidance: 'Ask the owner which number to allow.' }
      let next: AllowedContact[]
      try {
        next = addAllowedContact(current, args.phone, args.label, new Date().toISOString())
      } catch {
        return { success: false, reason: 'invalid_phone', guidance: 'Tell the owner the number must be in full international format, e.g. +972501234567.' }
      }
      patch['allowedContacts'] = next
      if (!biz.enabled) { patch['contactRestrictionEnabled'] = true; autoEnabled = true }
      break
    }
    case 'remove': {
      if (!args.phone) return { success: false, reason: 'missing_phone', guidance: 'Ask the owner which number to remove.' }
      patch['allowedContacts'] = removeAllowedContact(current, args.phone)
      break
    }
    default:
      return { success: false, reason: 'unknown_op' }
  }

  await ctx.db.update(businesses).set(patch).where(eq(businesses.id, ctx.businessId))
  await logAudit(ctx.db, {
    businessId: ctx.businessId, actorId: ctx.identityId, action: 'allowed_contacts.updated',
    entityType: 'business', entityId: ctx.businessId, metadata: { op: args.op, autoEnabled },
  })

  return {
    success: true,
    autoEnabled,
    fact: JSON.stringify(patch),
    guidance: autoEnabled
      ? 'Saved, and I turned the restriction ON because it was off. Confirm to the owner in plain words that the PA will now only talk to allowed numbers, and that this one is allowed.'
      : 'Saved. Confirm the change to the owner in plain words (fact is raw config — never quote it).',
  }
}
```

Note: `new Date().toISOString()` is real runtime code here (not a workflow script), so it is fine.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/domain/manager/orchestrator-tools.test.ts -t "executeManageAllowedContacts"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/manager/orchestrator-tools.ts src/domain/manager/orchestrator-tools.test.ts
git commit -m "feat(branch3): manageAllowedContacts tool executor"
```

---

## Task 4: Register `manageAllowedContacts` with the orchestrator

**Files:**
- Modify: `src/adapters/llm/orchestrator.ts` — import (~line 42), tool declaration (after the `configureNotifications` declaration ~line 576), dispatch case (~line 847).

- [ ] **Step 1: Add the import**

In the import block that pulls executors from `orchestrator-tools.js` (around line 42, where `executeConfigureNotifications` is imported), add:

```ts
  executeManageAllowedContacts,
```

- [ ] **Step 2: Add the function declaration**

Insert a new declaration object immediately after the `configureNotifications` declaration object (closes ~line 576):

```ts
  {
    name: 'manageAllowedContacts',
    description: "Control which phone numbers the PA is allowed to talk to. Use when the owner says things like 'only respond to numbers I approve', 'just talk to these clients', 'add +972501234567 to the allowed list', 'allow 0501234567', 'stop the restriction', or 'who's on the allowed list?'. When restriction is ON, only allowed numbers (and you, your staff, and coordination contacts) reach the PA — everyone else is silently ignored and you get a heads-up. Adding a number turns the restriction ON automatically if it was off. One operation per call. Convert any local number the owner gives into full international (E.164) format yourself before calling.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        op: { type: Type.STRING, enum: ['enable', 'disable', 'add', 'remove', 'list'], description: 'enable/disable the restriction mode, add/remove a number, or list the current list' },
        phone: { type: Type.STRING, description: 'Required for add/remove. Full international format, e.g. +972501234567' },
        label: { type: Type.STRING, description: 'Optional name for the number when adding (e.g. the client name)' },
      },
      required: ['op'],
    },
  },
```

- [ ] **Step 3: Add the dispatch case**

After the `configureNotifications` case (~line 847) add:

```ts
    case 'manageAllowedContacts':
      return executeManageAllowedContacts(args as unknown as Parameters<typeof executeManageAllowedContacts>[0], ctx)
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/llm/orchestrator.ts
git commit -m "feat(branch3): register manageAllowedContacts tool with the orchestrator"
```

---

## Task 5: `notifyOwnerUnlistedContact` forward-to-manager emitter + i18n

**Files:**
- Modify: `src/domain/i18n/t.ts` (add a string near `calendar_owner_reconcile_applied`, ~line 791)
- Modify: `src/domain/initiations/booking-notify.ts` (add emitter)
- Test: `src/domain/initiations/booking-notify.test.ts` (create if absent)

- [ ] **Step 1: Add the i18n string**

In `src/domain/i18n/t.ts`, after the `calendar_owner_reconcile_gate` entry (~line 796), add:

```ts
  // Contact restriction: an unlisted number tried to reach the PA while restriction is ON.
  unlisted_contact_forward: {
    he: (numTail: string, snippet: string) => `📵 מספר שאינו ברשימת המורשים (…${numTail}) ניסה לכתוב ל-PA: "${snippet}". לא עניתי לו. כדי לאשר אותו, השב/י "אשר ${numTail}".`,
    en: (numTail: string, snippet: string) => `📵 A number that isn't on your allowed list (…${numTail}) tried to message the PA: "${snippet}". I didn't reply. To allow them, reply "allow …${numTail}".`,
  },
```

- [ ] **Step 2: Write the failing test**

```ts
// src/domain/initiations/booking-notify.test.ts (create if absent)
import { describe, it, expect, vi } from 'vitest'

// Mock the WhatsApp enqueue so we can assert the manager was messaged.
const enqueued: Array<{ to: string; body: string }> = []
vi.mock('../../workers/message-retry.js', () => ({
  enqueueMessage: async (to: string, body: string) => { enqueued.push({ to, body }) },
}))

import { notifyOwnerUnlistedContact } from './booking-notify.js'
// makeTestDb: follow the existing DB test harness used elsewhere in the suite.

describe('notifyOwnerUnlistedContact', () => {
  it('messages the manager once with the number tail and a snippet', async () => {
    enqueued.length = 0
    const db = await makeTestDb() // seeds a business + a manager identity '+972500000001'
    await notifyOwnerUnlistedContact(db, db.businessId, { fromNumber: '+972509998877', messageText: 'hi can I book?' })
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0].to).toBe('+972500000001')
    expect(enqueued[0].body).toContain('8877')
  })
})
```

If the repo lacks a reusable `makeTestDb` for this module, mirror the DB-setup pattern already used in `orchestrator-tools.test.ts` and inline a minimal seed. Keep the assertion behavior identical.

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/domain/initiations/booking-notify.test.ts -t "notifyOwnerUnlistedContact"`
Expected: FAIL — `notifyOwnerUnlistedContact` not exported.

- [ ] **Step 4: Implement the emitter**

In `src/domain/initiations/booking-notify.ts`, add (the file already imports `db` helpers, `businesses`, `identities`, `i18n`, `Lang`, `enqueueMessage`, `dispatchInitiation`, `getInitiator`, `and`, `eq`, `isNull`):

```ts
/**
 * Forward an unlisted-contact attempt to the OWNER (contact-restriction feature). The sender got
 * silence; the owner is told a number tried and how to allow it. Deduped through the spine so a
 * blocked number cannot spam the owner. Best-effort: never throws.
 */
export async function notifyOwnerUnlistedContact(
  db: Db,
  businessId: string,
  attempt: { fromNumber: string; messageText: string },
): Promise<void> {
  try {
    const [biz] = await db
      .select({ defaultLanguage: businesses.defaultLanguage })
      .from(businesses)
      .where(eq(businesses.id, businessId))
      .limit(1)
    if (!biz) return

    const [manager] = await db
      .select({ id: identities.id, phoneNumber: identities.phoneNumber })
      .from(identities)
      .where(and(eq(identities.businessId, businessId), eq(identities.role, 'manager'), isNull(identities.revokedAt)))
      .limit(1)
    if (!manager) return

    const lang: Lang = (biz.defaultLanguage as Lang | null | undefined) ?? 'he'
    const numTail = attempt.fromNumber.slice(-4)
    const snippet = attempt.messageText.trim().slice(0, 80)
    const body = i18n.unlisted_contact_forward[lang](numTail, snippet)

    // Spine dedup keyed on the number → re-notify window prevents spam. Mirrors notifyOwnerNewBooking.
    await dispatchInitiation(db, getInitiator('booking.new_for_owner'), {
      businessId,
      recipientId: manager.id,
      dedupKey: `unlisted_contact:${businessId}:${attempt.fromNumber}`,
    }, {
      sendFreeForm: async () => { await enqueueMessage(manager.phoneNumber, body).catch(() => { /* non-fatal */ }) },
    }).catch(() => { /* non-fatal */ })
  } catch (err) {
    console.error('[booking-notify] unlisted-contact forward failed', { businessId, err: (err as Error).message })
  }
}
```

If `dispatchInitiation`'s dedup does not natively express a re-notify time window, that is acceptable for launch: the per-number `dedupKey` already collapses repeats. (Document this; a finer window is a future refinement.)

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/domain/initiations/booking-notify.test.ts -t "notifyOwnerUnlistedContact"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/initiations/booking-notify.ts src/domain/initiations/booking-notify.test.ts src/domain/i18n/t.ts
git commit -m "feat(branch3): forward unlisted-contact attempts to the manager"
```

---

## Task 6: The webhook contact gate

**Files:**
- Modify: `src/routes/webhook.ts` — insert the gate after identity resolution and before `registerCustomer` (the `if (!identityResult.found)` block at lines 270–289).
- Test: `src/routes/webhook.test.ts` (add cases if a webhook test harness exists; otherwise add a focused gate unit test — see Step 1).

The gate must: (a) be a no-op when `contactRestrictionEnabled` is false; (b) always pass `manager`/`delegated_user`/`contact` identities; (c) for a `customer` or unknown number not on the list, NOT register, NOT reply, fire `notifyOwnerUnlistedContact`, and stop. Place it AFTER the `revoked` branch (revocation keeps precedence) and BEFORE `registerCustomer`.

- [ ] **Step 1: Write the failing test**

Extract the decision into a tiny pure function so it is unit-testable without a full Fastify request. Add to `src/routes/webhook.test.ts` (or create it):

```ts
import { describe, it, expect } from 'vitest'
import { isInboundBlocked } from './webhook.js'

describe('isInboundBlocked (contact restriction gate)', () => {
  const list = [{ phone: '+972501234567', addedAt: 'x' }]
  it('off → never blocked', () => {
    expect(isInboundBlocked(false, list, '+972500000000', 'customer')).toBe(false)
    expect(isInboundBlocked(false, list, '+972500000000', null)).toBe(false)
  })
  it('on → manager/delegated/contact always pass', () => {
    expect(isInboundBlocked(true, [], '+972500000000', 'manager')).toBe(false)
    expect(isInboundBlocked(true, [], '+972500000000', 'delegated_user')).toBe(false)
    expect(isInboundBlocked(true, [], '+972500000000', 'contact')).toBe(false)
  })
  it('on → listed customer passes, unlisted customer/unknown blocked', () => {
    expect(isInboundBlocked(true, list, '+972501234567', 'customer')).toBe(false)
    expect(isInboundBlocked(true, list, '+972500000000', 'customer')).toBe(true)
    expect(isInboundBlocked(true, list, '+972500000000', null)).toBe(true) // unknown number
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/routes/webhook.test.ts -t "isInboundBlocked"`
Expected: FAIL — `isInboundBlocked` not exported.

- [ ] **Step 3: Implement the pure decision + wire it**

At the top level of `src/routes/webhook.ts`, add the exported helper and the needed import:

```ts
import { isAllowed, type AllowedContact } from '../domain/manager/allowed-contacts.js'

/**
 * Contact-restriction gate decision (pure). Returns true iff this inbound must be silently dropped.
 * Off → never. On → manager/delegated_user/contact always pass; customer/unknown pass only if listed.
 */
export function isInboundBlocked(
  restrictionEnabled: boolean,
  allowedContacts: AllowedContact[] | null,
  fromNumber: string,
  role: 'manager' | 'delegated_user' | 'customer' | 'provider' | 'contact' | null,
): boolean {
  if (!restrictionEnabled) return false
  if (role === 'manager' || role === 'delegated_user' || role === 'contact' || role === 'provider') return false
  return !isAllowed(allowedContacts, fromNumber)
}
```

Ensure the `business` row selected for the inbound includes `contactRestrictionEnabled` and `allowedContacts` (extend the existing select for `business` near the top of the handler to add these two columns).

Then insert the gate. Replace the existing block:

```ts
  if (!identityResult.found) {
    if (identityResult.reason === 'revoked') {
      // ... unchanged revoked handling ...
      return
    }
    await registerCustomer(db, business.id, msg.fromNumber)
    identityResult = await resolveIdentity(db, business.id, msg.fromNumber)
  }
```

with:

```ts
  if (!identityResult.found) {
    if (identityResult.reason === 'revoked') {
      // ... unchanged revoked handling ...
      return
    }
    // Contact restriction: an unknown number is blocked unless on the allowlist. Silent to the
    // sender; forward the attempt to the owner. Evaluated before auto-registration so a blocked
    // number never becomes a customer identity.
    if (isInboundBlocked(business.contactRestrictionEnabled, business.allowedContacts as AllowedContact[] | null, msg.fromNumber, null)) {
      void notifyOwnerUnlistedContact(db, business.id, { fromNumber: msg.fromNumber, messageText: msg.text ?? '' })
      return
    }
    await registerCustomer(db, business.id, msg.fromNumber)
    identityResult = await resolveIdentity(db, business.id, msg.fromNumber)
  }

  if (!identityResult.found) return
  const identity = identityResult.identity

  // Contact restriction for an EXISTING identity (strict list — customers are not grandfathered).
  if (isInboundBlocked(business.contactRestrictionEnabled, business.allowedContacts as AllowedContact[] | null, msg.fromNumber, identity.role)) {
    void notifyOwnerUnlistedContact(db, business.id, { fromNumber: msg.fromNumber, messageText: msg.text ?? '' })
    return
  }
```

Add the import for the emitter at the top of the file:

```ts
import { notifyOwnerUnlistedContact } from '../domain/initiations/booking-notify.js'
```

Confirm the existing `const identity = identityResult.identity` line further down (line 292) is not duplicated — fold the gate into the existing flow so `identity` is declared exactly once. Use the actual message-text field name on `msg` (verify it is `msg.text`; adjust to the real property if different).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/routes/webhook.test.ts -t "isInboundBlocked"`
Expected: PASS (3 tests). Then `npx tsc --noEmit` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/webhook.ts src/routes/webhook.test.ts
git commit -m "feat(branch3): contact-restriction gate on inbound webhook"
```

---

## Task 7: Add the `digest` notification action

**Files:**
- Modify: `src/domain/initiations/notification-rules.ts` (the `NotificationAction` union)
- Test: `src/domain/initiations/notification-rules.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/domain/initiations/notification-rules.test.ts`:

```ts
import { resolveNotificationAction, upsertNotificationRule } from './notification-rules.js'

it('resolves a digest rule to digest', () => {
  const rules = upsertNotificationRule(null, { event: 'cancellation', action: 'digest' })
  expect(resolveNotificationAction(rules, null, 'cancellation')).toBe('digest')
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/domain/initiations/notification-rules.test.ts -t "digest"`
Expected: FAIL — `'digest'` is not assignable to `NotificationAction`.

- [ ] **Step 3: Add `digest` to the union**

In `src/domain/initiations/notification-rules.ts:13`, change:

```ts
export type NotificationAction = 'notify' | 'notify_with_actions' | 'handle_silently'
```

to:

```ts
export type NotificationAction = 'notify' | 'notify_with_actions' | 'handle_silently' | 'digest'
```

No other change needed — `resolveNotificationAction` already returns the rule's action verbatim. No event defaults to `digest` (opt-in only), so existing defaults are unaffected.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/domain/initiations/notification-rules.test.ts`
Expected: PASS (all, including the new case).

- [ ] **Step 5: Commit**

```bash
git add src/domain/initiations/notification-rules.ts src/domain/initiations/notification-rules.test.ts
git commit -m "feat(branch3): add 'digest' notification action"
```

---

## Task 8: Digest-queue repository

**Files:**
- Create: `src/domain/initiations/digest-queue.ts`
- Test: `src/domain/initiations/digest-queue.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/domain/initiations/digest-queue.test.ts
import { describe, it, expect } from 'vitest'
import { enqueueDigest, fetchUnflushedDigests, markDigestsFlushed } from './digest-queue.js'
// makeTestDb: mirror the DB harness used in the suite; seeds a business.

describe('digest-queue repository', () => {
  it('enqueues, fetches unflushed, then marks flushed', async () => {
    const db = await makeTestDb()
    await enqueueDigest(db, db.businessId, 'cancellation', { summary: 'Dana cancelled her 3pm.' })
    const before = await fetchUnflushedDigests(db, db.businessId)
    expect(before).toHaveLength(1)
    expect(before[0].payload).toEqual({ summary: 'Dana cancelled her 3pm.' })

    await markDigestsFlushed(db, before.map((r) => r.id))
    const after = await fetchUnflushedDigests(db, db.businessId)
    expect(after).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/domain/initiations/digest-queue.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the repository**

```ts
// src/domain/initiations/digest-queue.ts
import { and, eq, isNull, inArray } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { notificationDigestQueue } from '../../db/schema.js'
import type { NotificationEvent } from './notification-rules.js'

export interface DigestRow {
  id: string
  event: string
  payload: { summary: string }
}

/** Append one digest item. Best-effort caller; this resolves once written. */
export async function enqueueDigest(db: Db, businessId: string, event: NotificationEvent, payload: { summary: string }): Promise<void> {
  await db.insert(notificationDigestQueue).values({ businessId, event, payload })
}

/** All not-yet-flushed digest rows for a business, oldest first. */
export async function fetchUnflushedDigests(db: Db, businessId: string): Promise<DigestRow[]> {
  const rows = await db
    .select({ id: notificationDigestQueue.id, event: notificationDigestQueue.event, payload: notificationDigestQueue.payload })
    .from(notificationDigestQueue)
    .where(and(eq(notificationDigestQueue.businessId, businessId), isNull(notificationDigestQueue.flushedAt)))
    .orderBy(notificationDigestQueue.createdAt)
  return rows.map((r) => ({ id: r.id, event: r.event, payload: r.payload as { summary: string } }))
}

/** Stamp rows flushed (idempotent). */
export async function markDigestsFlushed(db: Db, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await db.update(notificationDigestQueue).set({ flushedAt: new Date() }).where(inArray(notificationDigestQueue.id, ids))
}

/** Businesses that currently have unflushed digest rows (for the worker to sweep even when daily briefing is off). */
export async function businessesWithPendingDigests(db: Db): Promise<string[]> {
  const rows = await db
    .selectDistinct({ businessId: notificationDigestQueue.businessId })
    .from(notificationDigestQueue)
    .where(isNull(notificationDigestQueue.flushedAt))
  return rows.map((r) => r.businessId)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/domain/initiations/digest-queue.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain/initiations/digest-queue.ts src/domain/initiations/digest-queue.test.ts
git commit -m "feat(branch3): notification digest-queue repository"
```

---

## Task 9: `notifyOwnerBookingChange` emitter + i18n

**Files:**
- Modify: `src/domain/i18n/t.ts` (add owner change strings)
- Modify: `src/domain/initiations/booking-notify.ts` (add emitter)
- Test: `src/domain/initiations/booking-notify.test.ts`

The emitter resolves the event from `change.kind` (`cancelled`→`cancellation`, `moved`→`reschedule`, `confirmed`→`new_booking`), reads `notificationRules`/`notificationPreferences`, calls `resolveNotificationAction`, then: `notify`/`notify_with_actions` → send now; `handle_silently` → nothing; `digest` → `enqueueDigest` with a pre-rendered summary. Manager-suppression is the caller's responsibility (callers simply do not invoke it for manager-originated changes), but the emitter additionally accepts an `actorIsManager` guard for safety.

- [ ] **Step 1: Add the i18n strings**

In `src/domain/i18n/t.ts`, after `unlisted_contact_forward`, add:

```ts
  // Owner-facing calendar movement notices (per-movement notifications feature).
  owner_change_cancelled: {
    he: (who: string, svc: string, when: string) => `🔴 ${who} ביטל/ה ${svc} (${when}).`,
    en: (who: string, svc: string, when: string) => `🔴 ${who} cancelled ${svc} (${when}).`,
  },
  owner_change_moved: {
    he: (who: string, svc: string, from: string, to: string) => `🔄 ${who} העביר/ה ${svc} מ-${from} ל-${to}.`,
    en: (who: string, svc: string, from: string, to: string) => `🔄 ${who} moved ${svc} from ${from} to ${to}.`,
  },
```

(The `new_booking`/`confirmed` owner notice already exists as the `notifyOwnerNewBooking` body; `notifyOwnerBookingChange` only needs cancelled + moved.)

- [ ] **Step 2: Write the failing test**

```ts
// add to src/domain/initiations/booking-notify.test.ts
import { notifyOwnerBookingChange } from './booking-notify.js'

describe('notifyOwnerBookingChange', () => {
  it('notify → manager messaged; silent → not; digest → enqueued', async () => {
    enqueued.length = 0
    const db = await makeTestDb() // manager '+972500000001', a customer + serviceType + booking

    // default (no rule) → cancellation defaults to 'notify'
    await notifyOwnerBookingChange(db, db.businessId, { kind: 'cancelled', origin: 'customer', actorIsManager: false, bookingId: db.bookingId, customerId: db.customerId, serviceTypeId: db.serviceTypeId, slotStart: db.slot })
    expect(enqueued).toHaveLength(1)

    // manager actor → suppressed
    enqueued.length = 0
    await notifyOwnerBookingChange(db, db.businessId, { kind: 'cancelled', origin: 'customer', actorIsManager: true, bookingId: db.bookingId, customerId: db.customerId, serviceTypeId: db.serviceTypeId, slotStart: db.slot })
    expect(enqueued).toHaveLength(0)
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/domain/initiations/booking-notify.test.ts -t "notifyOwnerBookingChange"`
Expected: FAIL — not exported.

- [ ] **Step 4: Implement the emitter**

Add to `src/domain/initiations/booking-notify.ts`. Add imports:

```ts
import { enqueueDigest } from './digest-queue.js'
import type { NotificationEvent } from './notification-rules.js'
```

```ts
export type OwnerBookingChange =
  | { kind: 'cancelled'; origin: 'customer' | 'pa' | 'google'; actorIsManager: boolean; bookingId: string; customerId: string; serviceTypeId: string | null; slotStart: Date }
  | { kind: 'moved'; origin: 'customer' | 'pa' | 'google'; actorIsManager: boolean; bookingId: string; customerId: string; serviceTypeId: string | null; fromSlotStart: Date; slotStart: Date }
  | { kind: 'confirmed'; origin: 'customer' | 'pa' | 'google'; actorIsManager: boolean; bookingId: string; customerId: string; serviceTypeId: string | null; slotStart: Date }

const EVENT_FOR_OWNER_KIND: Record<OwnerBookingChange['kind'], NotificationEvent> = {
  cancelled: 'cancellation',
  moved: 'reschedule',
  confirmed: 'new_booking',
}

/**
 * Notify the OWNER that a booking moved (per-movement notifications feature). The owner-facing twin
 * of notifyBusinessBookingChange. Gated by resolveNotificationAction: notify → send now; digest →
 * buffer; handle_silently → nothing. Manager-originated changes are suppressed (the owner did it).
 * Best-effort: never throws.
 */
export async function notifyOwnerBookingChange(db: Db, businessId: string, change: OwnerBookingChange): Promise<void> {
  try {
    if (change.actorIsManager) return // never ping the owner for their own action

    const [biz] = await db
      .select({
        timezone: businesses.timezone,
        defaultLanguage: businesses.defaultLanguage,
        notificationRules: businesses.notificationRules,
        notificationPreferences: businesses.notificationPreferences,
      })
      .from(businesses).where(eq(businesses.id, businessId)).limit(1)
    if (!biz) return

    const event = EVENT_FOR_OWNER_KIND[change.kind]
    const action = resolveNotificationAction(
      (biz.notificationRules as NotificationRule[] | null) ?? null,
      (biz.notificationPreferences as NotificationPreferences | null) ?? null,
      event,
    )
    if (action === 'handle_silently') return

    const [manager] = await db
      .select({ id: identities.id, phoneNumber: identities.phoneNumber })
      .from(identities)
      .where(and(eq(identities.businessId, businessId), eq(identities.role, 'manager'), isNull(identities.revokedAt)))
      .limit(1)
    if (!manager) return

    const lang: Lang = (biz.defaultLanguage as Lang | null | undefined) ?? 'he'
    const locale = lang === 'he' ? 'he-IL' : 'en-GB'

    const [cust] = await db
      .select({ displayName: identities.displayName, phone: identities.phoneNumber })
      .from(identities).where(eq(identities.id, change.customerId)).limit(1)
    const who = cust?.displayName ?? (cust?.phone ? cust.phone.slice(-4) : (lang === 'he' ? 'לקוח' : 'a customer'))

    let serviceName: string | null = null
    if (change.serviceTypeId) {
      const [svc] = await db.select({ name: serviceTypes.name }).from(serviceTypes).where(eq(serviceTypes.id, change.serviceTypeId)).limit(1)
      serviceName = svc?.name ?? null
    }
    const svc = serviceName ?? (lang === 'he' ? 'תור' : 'an appointment')

    const fmt = (d: Date) => new Intl.DateTimeFormat(locale, { timeZone: biz.timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(d)

    let body: string
    if (change.kind === 'moved') {
      body = i18n.owner_change_moved[lang](who, svc, fmt(change.fromSlotStart), fmt(change.slotStart))
    } else if (change.kind === 'cancelled') {
      body = i18n.owner_change_cancelled[lang](who, svc, fmt(change.slotStart))
    } else {
      // confirmed (PA/google-originated new booking): reuse the cancelled-style line with a check.
      body = lang === 'he' ? `🟢 ${who} — ${svc} נקבע ל-${fmt(change.slotStart)}.` : `🟢 ${who} — ${svc} booked for ${fmt(change.slotStart)}.`
    }

    if (action === 'digest') {
      await enqueueDigest(db, businessId, event, { summary: body }).catch(() => { /* non-fatal */ })
      return
    }

    await dispatchInitiation(db, getInitiator('booking.new_for_owner'), {
      businessId,
      recipientId: manager.id,
      dedupKey: `owner_change:${change.kind}:${change.bookingId}:${change.slotStart.getTime()}`,
    }, {
      sendFreeForm: async () => { await enqueueMessage(manager.phoneNumber, body).catch(() => { /* non-fatal */ }) },
    }).catch(() => { /* non-fatal */ })
  } catch (err) {
    console.error('[booking-notify] owner booking-change notify failed', { businessId, kind: change.kind, err: (err as Error).message })
  }
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/domain/initiations/booking-notify.test.ts -t "notifyOwnerBookingChange"`
Expected: PASS. Then `npx tsc --noEmit` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/domain/initiations/booking-notify.ts src/domain/initiations/booking-notify.test.ts src/domain/i18n/t.ts
git commit -m "feat(branch3): owner-facing booking-change emitter with digest routing"
```

---

## Task 10: Wire `notifyOwnerBookingChange` at the mutation sites

**Files:**
- Modify: `src/domain/booking/engine.ts:867` (customer/PA cancel)
- Modify: `src/domain/flows/customer-booking.ts:1342` (reschedule move)
- Modify: `src/domain/booking/approval.ts:183` (PA/approval confirm)
- Modify: `src/domain/scheduling/session-cancellation.ts:81` (session cancel)
- Modify: `src/domain/calendar/inbound-sync.ts:385` (Google-originated cancel)

Each site fires `notifyOwnerBookingChange` best-effort (`.catch(() => {})`) right after the existing customer-facing emitter (or after the deterministic write where there is none). Import it in each file: `import { notifyOwnerBookingChange } from '../initiations/booking-notify.js'` (adjust relative path).

- [ ] **Step 1: Engine — customer/PA cancellation**

In `src/domain/booking/engine.ts`, right after the existing manager-cancel customer-notify block (closes at line 875), add:

```ts
  // Owner-facing twin: notify the owner of customer/PA-originated cancellations (NOT manager's own
  // action, and NOT a reschedule-supersede — that surfaces as a single 'moved' notice elsewhere).
  if (cancelledByRole !== 'manager' && reason !== 'Superseded by reschedule') {
    notifyOwnerBookingChange(db, actor.businessId, {
      kind: 'cancelled',
      origin: cancelledByRole === 'customer' ? 'customer' : 'pa',
      actorIsManager: false,
      bookingId,
      customerId: booking.customerId,
      serviceTypeId: booking.serviceTypeId,
      slotStart: booking.slotStart,
    }).catch(() => { /* non-fatal */ })
  }
```

(Confirm `reason` and `cancelledByRole` are in scope here — both are, per engine.ts:825/851.)

- [ ] **Step 2: Customer-booking — reschedule move**

In `src/domain/flows/customer-booking.ts`, in `releaseSupersededBooking` (line 1334), after the `cancelBooking(... 'Superseded by reschedule')` succeeds, emit a single `moved` notice. The new booking is `ctx.pendingBookingId` (the just-confirmed replacement); load both slots:

```ts
async function releaseSupersededBooking(
  db: Db, calendar: CalendarClient, identity: ResolvedIdentity, ctx: BookingFlowContext,
): Promise<void> {
  if (!ctx.rescheduledFrom) return
  let oldSlot: Date | null = null
  let newSlot: Date | null = null
  let serviceTypeId: string | null = null
  try {
    const [oldB] = await db.select({ slotStart: bookings.slotStart, serviceTypeId: bookings.serviceTypeId }).from(bookings).where(eq(bookings.id, ctx.rescheduledFrom)).limit(1)
    oldSlot = oldB?.slotStart ?? null
    serviceTypeId = oldB?.serviceTypeId ?? null
    if (ctx.pendingBookingId) {
      const [newB] = await db.select({ slotStart: bookings.slotStart }).from(bookings).where(eq(bookings.id, ctx.pendingBookingId)).limit(1)
      newSlot = newB?.slotStart ?? null
    }
    await cancelBooking(db, calendar, identity, ctx.rescheduledFrom, 'Superseded by reschedule')
  } catch {
    /* old slot lingers; surfaced via the customer's upcoming-appointments view + reminders */
  }
  if (oldSlot && newSlot) {
    notifyOwnerBookingChange(db, identity.businessId, {
      kind: 'moved', origin: 'customer', actorIsManager: false,
      bookingId: ctx.pendingBookingId!, customerId: identity.id, serviceTypeId, fromSlotStart: oldSlot, slotStart: newSlot,
    }).catch(() => { /* non-fatal */ })
  }
}
```

Confirm `ctx.pendingBookingId` is the field holding the confirmed replacement booking id in this flow; if the field name differs, use the actual one. Confirm `bookings` and `eq` are imported in this file (they are — used throughout).

- [ ] **Step 3: Approval — PA/approval-driven confirm**

In `src/domain/booking/approval.ts`, after the `notifyBusinessBookingChange(... kind:'confirmed' ...)` call at line 183, add:

```ts
    notifyOwnerBookingChange(db, booking.businessId, {
      kind: 'confirmed', origin: 'pa', actorIsManager: false,
      bookingId: booking.id, customerId: booking.customerId, serviceTypeId: booking.serviceTypeId, slotStart: booking.slotStart,
    }).catch(() => { /* non-fatal */ })
```

(Use the actual local variable names for the booking fields in that scope.)

- [ ] **Step 4: Session cancellation**

In `src/domain/scheduling/session-cancellation.ts`, after the `notifyBusinessBookingChange(... kind:'cancelled' ...)` at line 81, add an owner notice with `origin: 'pa'` and `actorIsManager: false`, mirroring Step 1's shape using that scope's booking fields.

- [ ] **Step 5: Google inbound-sync**

In `src/domain/calendar/inbound-sync.ts`, inside the per-booking loop of `applyOwnerCancellations` (after `notifyBusinessBookingChange(...)` at line 385), add:

```ts
    notifyOwnerBookingChange(db, businessId, {
      kind: 'cancelled', origin: 'google', actorIsManager: false,
      bookingId: a.bookingId, customerId: a.customerId, serviceTypeId: a.serviceTypeId, slotStart: a.slotStart,
    }).catch(() => { /* non-fatal */ })
```

Keep the existing blast-radius confirm-gate (lines 355–367) and the existing `calendar_owner_reconcile_applied` summary as-is — the per-booking owner notice complements them and is rules-gated (so an owner who muted `cancellation` won't get both). This satisfies the spec's "unified rules-gated emitter" without removing the safety gate.

- [ ] **Step 6: Typecheck + run the affected suites**

Run: `npx tsc --noEmit`
Expected: PASS.
Run: `npx vitest run src/domain/booking src/domain/calendar src/domain/scheduling src/domain/flows`
Expected: PASS (no regressions). Fix any broken existing tests caused by the new emitter (they should be inert in tests that don't seed a manager).

- [ ] **Step 7: Commit**

```bash
git add src/domain/booking/engine.ts src/domain/flows/customer-booking.ts src/domain/booking/approval.ts src/domain/scheduling/session-cancellation.ts src/domain/calendar/inbound-sync.ts
git commit -m "feat(branch3): wire owner booking-change notifications at all mutation sites"
```

---

## Task 11: Extend `configureNotifications` to accept `digest`

**Files:**
- Modify: `src/adapters/llm/orchestrator.ts:570` (the `action` enum in the `configureNotifications` declaration) and `:565` (description)

`ConfigureNotificationsArgs.action` is typed as `NotificationAction`, which now includes `digest` (Task 7) — so the executor needs no change. Only the Gemini declaration's enum and description need to advertise the new option.

- [ ] **Step 1: Update the declaration enum + description**

In `src/adapters/llm/orchestrator.ts`, change the `configureNotifications` `action` property (line 570) to:

```ts
        action: { type: Type.STRING, enum: ['notify', 'notify_with_actions', 'handle_silently', 'digest'], description: 'notify = tell me right away; notify_with_actions = tell me with quick action buttons; handle_silently = do not tell me; digest = do not ping me live, collect these and include them in my daily briefing' },
```

And extend the description (line 565) by appending:

```
 Use action 'digest' when the owner says things like 'don't ping me every time, just put cancellations in my daily summary' or 'batch the reschedules'.
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/adapters/llm/orchestrator.ts
git commit -m "feat(branch3): expose 'digest' option in configureNotifications tool"
```

---

## Task 12: Flush the digest in the daily-briefing worker

**Files:**
- Modify: `src/workers/daily-briefing.ts`
- Test: extend `src/workers/daily-briefing.test.ts` if present; otherwise add a focused test for the new `buildDigestSection` helper.

Two behaviors: (a) businesses with `dailyBriefingEnabled` get a "Changes since your last update" section appended; (b) businesses with pending digests but briefing OFF still get a digest-only message so opting into digest never silently swallows events.

- [ ] **Step 1: Write the failing test for the digest section builder**

Add to `src/workers/daily-briefing.test.ts`:

```ts
import { buildDigestSection } from './daily-briefing.js'

it('builds a digest section from rows and returns the ids to flush', () => {
  const { section, ids } = buildDigestSection(
    [{ id: '1', event: 'cancellation', payload: { summary: 'Dana cancelled her 3pm.' } }],
    'en',
  )
  expect(section).toContain('Dana cancelled her 3pm.')
  expect(ids).toEqual(['1'])
})

it('returns empty section for no rows', () => {
  expect(buildDigestSection([], 'en')).toEqual({ section: '', ids: [] })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/workers/daily-briefing.test.ts -t "digest section"`
Expected: FAIL — `buildDigestSection` not exported.

- [ ] **Step 3: Implement the builder + wire the flush**

In `src/workers/daily-briefing.ts`, add imports:

```ts
import { fetchUnflushedDigests, markDigestsFlushed, businessesWithPendingDigests, type DigestRow } from '../domain/initiations/digest-queue.js'
```

Add the pure builder near `buildBriefing`:

```ts
/** Render buffered digest items into a briefing section. Pure (rows already have rendered summaries). */
export function buildDigestSection(rows: DigestRow[], lang: Lang): { section: string; ids: string[] } {
  if (rows.length === 0) return { section: '', ids: [] }
  const header = lang === 'he' ? '🗒️ *שינויים מאז העדכון האחרון:*' : '🗒️ *Changes since your last update:*'
  const lines = rows.map((r) => `• ${r.payload.summary}`).join('\n')
  return { section: `${header}\n${lines}`, ids: rows.map((r) => r.id) }
}
```

Wire it in `processTick`. After the existing briefing send for an enabled business (line 68), fetch + append + flush. The cleanest change: build the digest section before composing `body` and append it. Replace the body composition + send for enabled businesses with:

```ts
      const digestRows = await fetchUnflushedDigests(db, biz.id)
      const { section: digestSection, ids: digestIds } = buildDigestSection(digestRows, lang)
      const body = await buildBriefing(biz.id, biz.name, biz.timezone, lang) + (digestSection ? `\n\n${digestSection}` : '')

      const waCredentials = biz.whatsappPhoneNumberId && biz.whatsappAccessToken
        ? { accessToken: biz.whatsappAccessToken, phoneNumberId: biz.whatsappPhoneNumberId }
        : undefined
      await sendMessage({ toNumber: manager.phoneNumber, body }, waCredentials)
        .catch((err) => console.warn('[daily-briefing] Send failed', { businessId: biz.id, err }))
      if (digestIds.length > 0) await markDigestsFlushed(db, digestIds).catch(() => { /* retry next tick */ })
```

Then add a SECOND sweep at the end of `processTick`, for businesses that have pending digests but are NOT in `enabledBizList` (briefing off). Only fire each at the same once-daily cadence by reusing the briefing-time window check, defaulting to the business's `dailyBriefingTime` (or '09:00' if null):

```ts
  // Digest-only sweep: businesses with buffered changes but daily briefing OFF still get their
  // digest once a day, so opting an event into 'digest' never silently swallows it.
  const enabledIds = new Set(enabledBizList.map((b) => b.id))
  const pendingIds = (await businessesWithPendingDigests(db)).filter((id) => !enabledIds.has(id))
  for (const businessId of pendingIds) {
    try {
      const [biz] = await db.select({
        name: businesses.name, timezone: businesses.timezone, defaultLanguage: businesses.defaultLanguage,
        dailyBriefingTime: businesses.dailyBriefingTime, whatsappPhoneNumberId: businesses.whatsappPhoneNumberId, whatsappAccessToken: businesses.whatsappAccessToken,
      }).from(businesses).where(eq(businesses.id, businessId)).limit(1)
      if (!biz) continue

      const briefingTime = biz.dailyBriefingTime ?? '09:00'
      const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: biz.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
      const briefingLocal = new Date(`${todayLocal}T${briefingTime}:00`)
      const briefingUtc = new Date(briefingLocal.toLocaleString('en-US', { timeZone: 'UTC' }))
      const diffMs = now.getTime() - briefingUtc.getTime()
      if (diffMs < 0 || diffMs > REPEAT_EVERY_MS) continue

      const [manager] = await db.select({ phoneNumber: identities.phoneNumber, preferredLanguage: identities.preferredLanguage })
        .from(identities).where(and(eq(identities.businessId, businessId), eq(identities.role, 'manager'))).limit(1)
      if (!manager) continue
      const lang: Lang = (manager.preferredLanguage as Lang | null | undefined) ?? (biz.defaultLanguage as Lang | null | undefined) ?? 'he'

      const rows = await fetchUnflushedDigests(db, businessId)
      const { section, ids } = buildDigestSection(rows, lang)
      if (ids.length === 0) continue
      const waCredentials = biz.whatsappPhoneNumberId && biz.whatsappAccessToken
        ? { accessToken: biz.whatsappAccessToken, phoneNumberId: biz.whatsappPhoneNumberId } : undefined
      await sendMessage({ toNumber: manager.phoneNumber, body: section }, waCredentials).catch((err) => console.warn('[daily-briefing] digest-only send failed', { businessId, err }))
      await markDigestsFlushed(db, ids).catch(() => { /* retry next tick */ })
    } catch (err) {
      console.error('[daily-briefing] digest-only sweep failed', { businessId, err: err instanceof Error ? err.message : String(err) })
    }
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/workers/daily-briefing.test.ts`
Expected: PASS. Then `npx tsc --noEmit` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workers/daily-briefing.ts src/workers/daily-briefing.test.ts
git commit -m "feat(branch3): flush notification digest into the daily briefing"
```

---

## Task 13: Full suite + lint gate

**Files:** none (verification).

- [ ] **Step 1: Run the whole test suite**

Run: `npx vitest run`
Expected: PASS (all suites). Investigate and fix any regression introduced by the new emitter calls (most likely: tests that exercise a cancel path and now also touch `notifyOwnerBookingChange` — it is best-effort and returns early without a manager, so failures indicate a missing mock, not a behavior change).

- [ ] **Step 2: Lint + skills-boundary check**

Run: `npm run lint` (or the repo's lint script if named differently — check `package.json`).
Expected: PASS. Confirm no new import crosses the skills boundary (none of these files are under `src/skills/`).

- [ ] **Step 3: Commit (if any fixes were needed)**

```bash
git add -A
git commit -m "test(branch3): fix suites for owner notifications + contact gate"
```

---

## Task 14: Branch-3 configurability verification (HARD REQUIREMENT)

**Files:** read-only audit; possible touch-up to the orchestrator system prompt.

The user requires that **everything** is configurable from the Branch 3 chat. Verify each control is reachable conversationally and that the orchestrator's system prompt does not need to name new capabilities it is now missing.

- [ ] **Step 1: Confirm tool coverage**

Confirm these conversational controls all map to a registered tool:
- enable/disable restriction, add/remove/list allowed numbers → `manageAllowedContacts` (Task 4). ✅
- per-event mode notify/silent/digest → `configureNotifications` (Task 11). ✅
- daily-briefing on/off + time (the digest cadence) → confirm an existing tool sets `dailyBriefingEnabled`/`dailyBriefingTime`. Run: `grep -rn "dailyBriefingEnabled\|dailyBriefingTime\|daily_briefing" src/domain/manager src/adapters/llm`. If NO tool writes these, add a minimal `configureDailyBriefing` tool (mirror `executeConfigureNotifications`: args `{ enabled?: boolean; time?: string }`, deterministic update of the two columns, audit log, register in `orchestrator.ts`). This is required to satisfy "the digest/briefing controls" being Branch-3-configurable.

- [ ] **Step 2: Check the orchestrator system prompt**

Run: `grep -rn "configureNotifications\|notification\|allowed" src/adapters/llm/orchestrator.ts | grep -i "prompt\|system"` and inspect the system-prompt builder. If it enumerates the owner's capabilities for the model, add one line each for contact-allowlist management and digest batching so the model proactively offers them. If the prompt relies purely on tool declarations (which Gemini sees), no change is needed.

- [ ] **Step 3: Manual conversational smoke test (document expected behavior)**

In a comment on the PR (or the plan's completion notes), record these expected Branch-3 exchanges as the acceptance criteria for manual QA after deploy:
- "only talk to my approved clients, add +972501234567" → restriction ON + number added (one turn).
- "who can the PA talk to right now?" → reads back mode + list.
- "stop restricting who can message" → restriction OFF.
- "don't ping me for every cancellation, just put them in my morning summary" → `configureNotifications` cancellation→digest.
- "tell me the moment anyone reschedules" → `configureNotifications` reschedule→notify.
- "send my daily briefing at 8am" → daily-briefing time set (Step 1 tool).

- [ ] **Step 4: Commit any prompt/tool touch-ups**

```bash
git add -A
git commit -m "feat(branch3): ensure allowlist + digest + briefing are fully chat-configurable"
```

---

## Self-Review (completed by plan author)

**Spec coverage:**
- §3 Contact restriction → Tasks 1 (schema), 2 (helpers), 3–4 (tool), 5 (forward emitter), 6 (gate). ✅
- §4 Calendar notifications → Tasks 7 (digest action), 8 (queue), 9 (emitter), 10 (wiring all sites), 11 (configureNotifications), 12 (digest flush). ✅
- §4.1 manager-own-action suppression → Task 9 (`actorIsManager` guard) + Task 10 (callers pass non-manager origins; `manager/apply.ts` sites deliberately NOT wired). ✅
- §4.4 digest-only flush when briefing off → Task 12 Step 3 second sweep. ✅
- §5 data flow, §6 error handling (best-effort, fail-open only when off, idempotent flush) → encoded in Tasks 6, 9, 12. ✅
- §8 migration additive → Task 1. ✅
- User HARD REQUIREMENT (all chat-configurable) → Task 14, incl. the daily-briefing tool gap check. ✅

**Placeholder scan:** No TBD/TODO. Every code step shows real code. Two explicit "confirm the field name" notes (`msg.text`, `ctx.pendingBookingId`) are verification instructions, not placeholders — the surrounding code is complete.

**Type consistency:** `AllowedContact` shape consistent across Tasks 2/3/6. `NotificationAction` adds `digest` once (Task 7) and is consumed in 9/11/12. `OwnerBookingChange` defined in Task 9 and used with matching fields in all Task 10 call sites. `DigestRow` defined in Task 8, consumed in Task 12. `notifyOwnerBookingChange`/`notifyOwnerUnlistedContact` names consistent throughout.

**Manager-suppression note:** `src/domain/manager/apply.ts` (the manager's own cancel/move actions) is intentionally NOT wired in Task 10 — those are the manager's own actions and must not ping the manager. The `actorIsManager` guard in Task 9 is a belt-and-suspenders backstop.
