# Proactive Messaging — Per-Customer Data Gaps & Implementation Plan

**Date:** 2026-06-24
**Scope:** Branches 3/4 outbound. The data a customer carries that proactive initiators (win-back, cold-fill, value model, phrasing) read.
**Owner:** Developer A (`src/domain/crm`, `src/db`) + shared sign-off from Developer B on `src/shared/skill-types.ts`.
**Status:** Plan — no code yet.

---

## 0. The one-paragraph problem

Proactive targeting funnels through a **single reader** — `queryCustomerSegment` / `loadCustomerProfile`
([segment-repository.ts](../../../src/domain/crm/segment-repository.ts)) — which derives a `CustomerProfile`
from a customer's bookings ([customer-profile.ts](../../../src/domain/crm/customer-profile.ts)) and emits a
`CustomerSummary` ([skill-types.ts:158](../../../src/shared/skill-types.ts)). Every initiator (win-back,
cold-fill, value scoring, phrasing) sees **only what that struct contains**. The raw `bookings` table is rich
and retained forever, but the profile pipeline projects away three things proactive messaging needs. The
biggest is the **instructor** the customer actually went to.

---

## 1. What is missing — precisely

| # | Missing | It exists in raw data? | Why proactive messaging needs it | Symptom today |
|---|---|---|---|---|
| **A** | **Instructor affinity** (`preferredProviderId` + per-instructor counts) | ✅ `bookings.providerId` ([schema.ts:291](../../../src/db/schema.ts)), `class_series.providerId`, `calendar_blocks.providerId` — all populated | In yoga/pilates/salon, loyalty is to a *person*. Targeting "lapsed customers of Dana" and phrasing *"Dana has a Tue 6pm opening"* is the highest-converting framing, and instructor-fit is a top term in the value model. | `ProfileBooking` selects only `{slotStart, state, serviceTypeId}` → `providerId` is dropped at the first hop. Profile, `SegmentFilter`, `CustomerSummary` have no provider field. The PA **cannot** target by instructor or name the instructor in copy. |
| **B** | **Birthday** (nullable `date`) | ❌ not stored anywhere | The birthday initiator is in the catalog (design §8.3) and §7.6/§12 call for a "cheap nullable birthday field." | No `identities.birthday` column → the initiator can't fire at all. |
| **C** | **Lifetime spend / per-visit amount** | 🟡 only `bookings.paymentStatus` (paid/pending); the *amount* lives on `serviceTypes`/price-tiers and can drift | The value gate (design §0.3) ranks sends by expected value; "high-LTV lapsed customer" must be computable and historically accurate. | No amount pinned to the booking → spend isn't reconstructable after a price change; profile computes no spend. |
| **D** | **Free-text customer prefs/notes** | ❌ (`intakeNotes` is on *serviceTypes*, not the customer) | Explicit prefs the derived profile can't infer ("mornings only", "prefers Dana", allergies). | No customer-level notes field. |

**Retention is not a gap.** There is no purge/TTL/retention job in the tree (only `held` bookings expire);
identities + bookings persist indefinitely, so **none of the fixes below need a backfill** — the history is
already there. (Separately, you may *want* a deliberate retention policy for opted-out/dormant customers later;
out of scope here.)

---

## 2. How the fixes map to the gaps

Each fix is "add the field at the raw layer (if not present) → derive it in the pure profile → surface it in the
shared summary → consumers use it for free." The pipeline is the same three layers every time:

```
RAW (bookings / identities)  →  PURE PROFILE (customer-profile.ts)  →  SHARED SUMMARY (skill-types.ts)  →  CONSUMERS
   already has the data           computeCustomerProfile()              CustomerSummary / SegmentFilter      winback.ts / cold-fill.ts / value model / phrasing
```

- **Gap A → Phase 1.** Stop projecting `providerId` away; derive `preferredProviderId`; resolve its display
  name once in the repository; add it to `SegmentFilter` + `CustomerSummary`. Consumers (`buildWinbackProposal`,
  `selectColdFillCandidates`) are pure functions over `CustomerSummary` — they get instructor data **with no
  plumbing change**, only copy/ranking edits.
- **Gap B → Phase 2.** Add `identities.birthday`; a birthday initiator can then be registered (initiator itself
  is follow-on work, but the data prerequisite is unblocked).
- **Gap C → Phase 3.** Snapshot `bookings.amount` at confirm time; derive `lifetimeSpend` in the profile; feed
  the value model.
- **Gap D → Phase 4 (optional).** Add `identities.notes`; surface in `CustomerSummary` and the Branch-3
  customer-lookup tool.

---

## 3. Implementation plan

### Phase 1 — Instructor thread-through (the core fix; do first)

Highest leverage, no migration, no backfill. Strictly additive.

1. **Pure profile** — [customer-profile.ts](../../../src/domain/crm/customer-profile.ts)
   - Add `providerId: string | null` to `ProfileBooking`.
   - Add to `CustomerProfile`: `preferredProviderId: string | null` (modal provider over visit-state bookings)
     and optionally `providerCounts: Record<string, number>` for value-model weighting.
   - Compute via the existing `modal()` helper, mirroring `preferredServiceTypeId`. Ignore null providerIds
     (solo operators / unscoped bookings).
   - Add `preferredProviderId?: string` to `SegmentMatchFilter` and a membership check in `matchesSegment`.
2. **I/O reader** — [segment-repository.ts](../../../src/domain/crm/segment-repository.ts)
   - Add `providerId: bookings.providerId` to both selects (`loadCustomerProfile`, `queryCustomerSegment`).
   - Resolve provider **display name** once: one `identities` lookup over the distinct `preferredProviderId`s
     in the result set (role `provider`), build an id→name map, attach `preferredProviderName` to each
     `CustomerSummary`. (Phrasing needs the name, not the UUID.)
   - Pass `preferredProviderId` from `SegmentFilter` into `SegmentMatchFilter`.
3. **Shared contract** — [skill-types.ts](../../../src/shared/skill-types.ts) *(Developer B sign-off)*
   - `CustomerSummary`: add `preferredProviderId?: string | null`, `preferredProviderName?: string | null`.
   - `SegmentFilter`: add `preferredProviderId?: string`.
4. **Consumers (copy/ranking only — signatures unchanged)**
   - [winback.ts](../../../src/domain/crm/winback.ts): when `preferredProviderName` is present, name the
     instructor in `situation`/`fallback`/`ownerSummary` ("…with Dana").
   - [cold-fill.ts](../../../src/domain/crm/cold-fill.ts): add instructor-match as a ranking term (a candidate
     whose `preferredProviderId` == the freed slot's provider ranks above a generic recency match).
   - Branch-3 orchestrator `customerSegmentQuery` ([orchestrator-tools.ts](../../../src/domain/manager/orchestrator-tools.ts)):
     accept "instructor" in segment phrasing so the owner can say "invite Dana's regulars."

**Tests:** extend `customer-profile.test.ts` (modal provider, null handling, filter match) and
`winback.test.ts` / `cold-fill.test.ts` (instructor present vs absent). All existing tests must pass unchanged.

### Phase 2 — Birthday field

5. Migration: `identities.birthday date` (nullable). Add to schema + `identities` insert/update paths and the
   Branch-3 contact-notes / customer-edit tool so the owner can set it conversationally.
   *(The birthday initiator/worker is separate follow-on; this phase only lands the data prerequisite.)*

### Phase 3 — Spend snapshot & LTV

6. Migration: `bookings.amount numeric(10,2)` (nullable). Write it at confirm time from the resolved
   service/tier price so it's pinned even if prices later change.
7. Profile: add `lifetimeSpend` to `CustomerProfile`/`CustomerSummary` (sum over visit-state bookings).
8. Feed `lifetimeSpend` + instructor-fit into the value model (design §0.3) for send prioritization.
   *(Historical bookings keep `amount = null`; LTV is forward-accurate from rollout — acceptable, no backfill.)*

### Phase 4 — Free-text prefs (optional)

9. Migration: `identities.notes text` (nullable). Surface in `CustomerSummary` + Branch-3 customer-lookup tool.

---

## 4. Sequencing & ownership

- **Order:** Phase 1 → 2 → 3 → 4. Phase 1 stands alone and delivers the instructor capability you flagged.
- **Migrations:** Phases 2–4 each add one nullable column (next free number after `0034`). Phase 1 needs **no
  migration**.
- **CODEOWNERS:** Phase 1 step 3 and any `CustomerSummary` change touch `src/shared/` → **both developers must
  approve**. Everything else is Developer A within `src/domain/crm` + `src/db`.
- **Backfill:** none required in any phase (raw data already retained).

---

## 5. Definition of done (Phase 1)

- Profile derives `preferredProviderId`; repository attaches `preferredProviderName`.
- A segment query can filter by instructor; a win-back/cold-fill message can name the instructor.
- `customer-profile.test.ts`, `winback.test.ts`, `cold-fill.test.ts` cover instructor-present and
  instructor-absent (solo-operator) paths; full suite green.
</content>
</invoke>
