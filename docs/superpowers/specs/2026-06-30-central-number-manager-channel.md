# Central-number manager channel (Branch 3 on the MiddleMan number)

**Date:** 2026-06-30
**Status:** Approved design — ready to implement
**Scope (this spec):** Case 1 only — many owners, **one** central-managed business each. One owner owning multiple central-managed businesses is explicitly out of scope here (see "Deferred").

---

## 1. Goal

Let an opted-in business have its owner manage the PA (Branch 3) through the **central MiddleMan number** (`PROVIDER_WA_NUMBER`), while its customers (Branch 4) still reach the business on its **own** WhatsApp number.

## 2. Governing principle (from CLAUDE.md)

There is exactly **one Branch 3** — the orchestrator at `src/adapters/llm/orchestrator.ts`. The central number is a **second ingress** to it. Branch 3 is keyed on **(resolved business + manager-role sender)**, never on the inbound phone number. On the central number the business is resolved from the **sender's identity** instead of the inbound number. We **never** re-implement Branch 3 capabilities inside the onboarding flow (Branch 2).

## 3. Why this is small

`routeManagerMessage(msg, identity, business, app)` (`src/routes/webhook.ts:891`) is already fully parameterized by `business` + `identity`. The orchestrator, the 4h session (keyed by `identity.id`, `webhook.ts:1110`), the per-business lock, and dedup all key off `business.id` / `identity.id` — never off the inbound number. So once we hand the manager path the right `business`, everything works. The single thing tied to the inbound number is the **outbound reply credentials**.

---

## 4. Changes

### Change 1 — Config flag (schema + migration)

Add to the `businesses` table (`src/db/schema.ts`, alongside `calendarMode` at line 54):

```ts
// Where the owner manages the PA: their own PA number (default) or the central MiddleMan number.
managerChannel: text('manager_channel', { enum: ['own_number', 'central'] })
  .notNull()
  .default('own_number'),
```

- Generate the Drizzle migration (`drizzle-kit generate`) and verify it adds the column with the `'own_number'` default and a NOT NULL constraint — backfilling all existing rows to `'own_number'` (no behavior change for current businesses).
- Migration is applied via the standard `/update-agent` deploy runbook.

### Change 2 — Central-number dispatch restructure (`webhook.ts`)

Today `processInboundMessage` (`webhook.ts:218`) short-circuits **all** central-number traffic into provider onboarding at line 220. Replace that block with a precedence ladder. Operator still wins; the owner lookup sits between operator and onboarding.

```
if (PROVIDER_WA_NUMBER && msg.toNumber === PROVIDER_WA_NUMBER) {
    // 1. Operator → unchanged. handleProviderOnboarding internally routes OPERATOR_PHONE
    //    to the operator admin handler (provider-onboarding.ts:56). Keep that path intact.
    if (msg.fromNumber === OPERATOR_PHONE) { ...existing onboarding/operator call...; return }

    // 2. Known owner of a central-managed business?
    const ownerBiz = await findCentralManagedBusinessForOwner(msg.fromNumber)
    if (ownerBiz) {
        // Fall into the SAME pipeline used for PA-number traffic, but:
        //   - business is the resolved ownerBiz (not found-by-number)
        //   - replyCredentials = central (PROVIDER_WA_*) creds
        // Run: dedup (processedMessages, business.id) → resolveIdentity(business.id, fromNumber)
        //      → contact-gate / opt-out / audit (unchanged) → dispatchToRole(..., replyCredentials)
        return
    }

    // 3. Unknown sender → Branch 2 onboarding (existing image + text handling). UNCHANGED.
    ...existing handleProviderOnboarding path...
    return
}
```

Notes:
- The **image-bounce** logic currently in the central block (`webhook.ts:224`) must move into arm 3 (onboarding only). Owners on the central number get the manager path's own image handling (managers may send images for website-builder etc., `webhook.ts:1135`).
- Lift `OPERATOR_PHONE` into `webhook.ts` (env read, mirroring `PROVIDER_WA_NUMBER` at `webhook.ts:216`) so the ladder can check it before the owner lookup.

### Change 3 — `findCentralManagedBusinessForOwner(fromNumber)`

New lookup (suggested home: a small helper in `webhook.ts`, or `src/domain/identity/`). Returns the business (or null) for which `fromNumber` is an active manager AND `managerChannel = 'central'`:

```sql
SELECT businesses.*
FROM identities
JOIN businesses ON businesses.id = identities.business_id
WHERE identities.phone_number = :fromNumber
  AND identities.role = 'manager'        -- strictly manager (+ delegated_user only if intended); NEVER customer/contact
  AND identities.revoked_at IS NULL
  AND businesses.manager_channel = 'central'
LIMIT 2;   -- LIMIT 2 so we can detect the >1 case and HARD-REFUSE
```

- **Case 1:** exactly one row → return that business.
- **0 rows:** return null → falls through to Branch 2 onboarding.
- **>1 rows → HARD REFUSE.** Do **not** `.limit(1)` and silently pick a tenant — that is the single way case-1 safety degrades into a cross-tenant bind (audit H1/H5). Return a sentinel that makes the dispatch send the owner a "you manage multiple businesses on this number — say which one" message (or, until the multi-business spec lands, an explicit error), and log it. The active-business resolution is the deferred spec.
- Strictly filter `role='manager'` (and `delegated_user` only if we decide to allow delegated management on the central number) AND `managerChannel='central'`. A customer/contact row must never match on the central path.

### Change 4 — Thread reply credentials through the manager path

`routeManagerMessage` derives `waCredentials` from the business at `webhook.ts:897`. Add an optional `replyCredentials` parameter, threaded `dispatchToRole → routeManagerMessage`, and prefer it when present:

```ts
async function dispatchToRole(msg, identity, business, app, replyCredentials?) { ... }
async function routeManagerMessage(msg, identity, business, app, replyCredentials?) {
  const waCredentials = replyCredentials ?? (business.whatsappPhoneNumberId && business.whatsappAccessToken
    ? { accessToken: business.whatsappAccessToken, phoneNumberId: business.whatsappPhoneNumberId }
    : undefined)
  ...
}
```

- On the central path, `replyCredentials = { accessToken: PROVIDER_WA_ACCESS_TOKEN, phoneNumberId: PROVIDER_WA_PHONE_NUMBER_ID }` (same creds onboarding sends with, `webhook.ts:239`).
- On the normal PA-number path, `replyCredentials` is omitted → behavior is byte-for-byte unchanged.
- **Critical scoping:** `waCredentials` here governs only the reply **to the owner** (keyword-command replies + the final orchestrator reply). PA→customer sends (`messageCustomer`, broadcasts) are built independently inside the orchestrator tools from the **business's** creds — so they correctly continue to go from the business's own number. Do **not** plumb `replyCredentials` into the orchestrator tools.

---

## 5. What stays untouched

- **`orchestrator.ts` and all 44 tools** — inherited verbatim via `business.id`.
- **Branch 2 onboarding** — now strictly the unknown-sender arm.
- **Branch 1 operator** — precedence preserved.
- **Signature verification** — already correct: central payloads carry the provider `phone_number_id`, which `resolveAppSecret` maps to the global secret (`webhook.ts:494`). No change.
- **Sessions / dedup / per-business lock** — key off `identity.id` / `business.id`; isolated across owners on the shared number with no change.

## 6. Verification plan

1. **Unit:** `findCentralManagedBusinessForOwner` — returns the business for an active central-managed manager; null for a customer, a revoked manager, an `own_number` business, and an unknown number; detects the >1 case.
2. **Unit:** `routeManagerMessage` uses `replyCredentials` when provided, falls back to business creds otherwise (no regression on the standard path).
3. **Integration / manual:** With a business set to `managerChannel='central'`:
   - Owner messages the central number → gets a full Branch 3 reply **from the central number**; orchestrator tools work (calendar read/write, settings).
   - Owner tells PA to message a customer → customer receives it **from the business's own number**.
   - A stranger messaging the central number → still gets Branch 2 onboarding.
   - Operator messaging the central number → still gets the operator handler.
   - A customer messaging the business's own number → unaffected Branch 4.
4. **Regression:** an `own_number` business behaves exactly as before on every path.
5. CI green (tsc + eslint + tests).

## 6a. Tenant-isolation audit (2026-06-30)

Three adversarial read-only audits (substrate tool-scoping, outbound messaging, ingress/identity) were run against the live code. **Verdict: for case 1, the multi-tenant borders are sound by construction** — every session (`identityId`), lock (`business.id`), coalescer key (`business.id:identity.id`), outbound recipient query, sender-credential load, and (with one exception below) every orchestrator tool query is scoped by a business-bound id, and no downstream code re-resolves the tenant. The shared central number introduces **no new structural leak**, provided the resolution step ships with the mandatory guards below.

### Mandatory guards in the new code (isolation depends on these)

- **G1 — Unique-match enforcement (Change 3).** The `phone → central business` lookup MUST assert exactly one match; `>1` hard-refuses. Never a silent first-row pick. *(This is the only path where case-1 safety can break into a cross-tenant bind.)*
- **G2 — Strict role + central scoping (Change 3).** Match only `role='manager'` (+ `delegated_user` if intended) AND `managerChannel='central'`. Never a customer/contact row.
- **G3 — Routing precedence (Change 2).** Inside the `PROVIDER_WA_NUMBER` block: operator → central-manager resolution → onboarding fallback. Resolve the manager *before* the onboarding short-circuit (`webhook.ts:220`), or managers get swallowed by onboarding.
- **G4 — Per-business `ToolContext` (invariant).** The orchestrator's `ctx.calendar` and `ctx.businessId` must be freshly built per turn from the resolved business. NEVER cache or reuse a `ToolContext` (or its calendar client) across businesses on the shared number. Verify at the build site (`webhook.ts` manager handler / `orchestrator.ts`).

### Recommended hardening (defense-in-depth)

- **G5 — Composite dedup key.** `processed_messages` is keyed on `messageId` alone (`schema.ts:639`) and checked *before* business resolution (`webhook.ts:263`). Case 1 stays safe only via Meta `wamid` global uniqueness. Make the key `(messageId, businessId)` and move the dedup check to after resolution so the schema — not an external assumption — guarantees no cross-tenant suppression.

### Pre-existing defects surfaced (independent of this feature; the shared number raises the odds)

- **D1 — `executeSaveContactNote` customer branch IDOR** (`orchestrator-tools.ts:1463-1474`, confirmed by direct read). SELECT + UPDATE on `customer_profiles` by `identityId` with **no `businessId` filter** → cross-tenant note write/poison. The sibling `business_contact` branch (line 1491) is correctly scoped. **Fix:** add `eq(customerProfiles.businessId, ctx.businessId)` to both the SELECT and UPDATE. Low organic exploitability today; trivial fix; should land with this work.
- **D2 — Latent raw-id resolvers.** `resolveBookingApproval` / `resolveInitiationProposal` resolve by raw id with no businessId filter — safe today only by caller discipline (callers pre-scope the id). Add a `businessId` arg as defense-in-depth.
- **D3 — `sendMessage` global-creds fallback** (`sender.ts:96`). A business row with blank WA creds sends from the *global/MiddleMan* number — wrong-FROM, not a content leak. Consider failing closed for per-business customer sends.

## 7. Deferred (next spec)

- **One owner, multiple central-managed businesses.** Resolution returns >1; introduce an **active-business pointer** on the session (default last-used, explicit switch command, orchestrator surfaces which business it is acting as). The `LIMIT 2` detection and "candidate set" framing in Change 3 are the seam this builds on.
