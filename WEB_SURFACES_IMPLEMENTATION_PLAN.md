# Web & App Surfaces — Implementation Plan

**Status:** Plan (pre-build). System live at **v1.0.79**.
**Trigger:** execution begins when the **MiddleMan root domain is registered** and `GATE-1` is flipped. The plan is structured so that day-1 after the domain lands is pure execution — no open design decisions.
**Companion to:** [WEB_SURFACES_DESIGN.md](WEB_SURFACES_DESIGN.md) (the *what*/*why*). This doc is the *how*.
**Governance:** [DEV_OPERATING_MODEL.md](DEV_OPERATING_MODEL.md) — Dev A owns everything except `src/skills/` (`dev/system/*`); Dev B owns `src/skills/` (`dev/skills/*`); `src/shared/` needs both. CI (TS + ESLint + tests) gates every merge; CODEOWNERS enforces at PR.

> Placeholder: `middleman.app` stands in for the real root domain.

---

## 0. The Binding Invariant — Mirror Compliance (every part)

Every surface built here is a **UX mirror over the one internal brain** (CLAUDE.md Principle #3). This is not a slogan — it is a **per-task acceptance gate**. For the two stateful domains:

- **Calendar mirror.** No surface writes scheduling state directly. Every create/move/cancel/reschedule/availability change goes through the deterministic core — `requestBooking()` (`src/domain/booking/engine.ts`) for bookings, the manager apply pipeline (`src/domain/manager/apply.ts`, `orchestrator-tools.ts`) for owner mutations. Reads are projections over the internal DB. Google Calendar stays a co-equal mirror via existing write-through + `inbound-sync.ts`.
- **Payment mirror.** No surface invents payment logic. Charges go through `createCharge` (`src/domain/payments/service.ts`) → Grow hosted pay-link; confirmation is **only** ever the Grow webhook → `reconcilePayment` → `finalizePaidBooking`. Refund/request stay owner-gated via existing tools. The web adds a *thin checkout path*, never a second money core.

**Every task below carries a one-line "Mirror" note. A task is not "done" until its Mirror note is satisfied and demonstrated.**

---

## 1. Architecture Shape (recap)

One multi-tenant Cloud Run app behind one HTTPS load balancer + wildcard cert. Three host classes:

| Host | Surface | Part |
|---|---|---|
| `middleman.app` (apex) | B2 MiddleMan site + onboarding entry | (B2 site = parallel; **provisioning seam = Part B**) |
| `app.middleman.app` | B3 owner PWA | Part C |
| `{slug}.middleman.app` | B4 customer site (static + dynamic) | Part A |

---

## 2. Foundations (cross-cutting — gate the three parts)

These three foundations are shared infrastructure. **F1 and F2 are the critical path** and unlock Parts A/B/C. They are independent of each other (routing vs. auth) and can be built in parallel.

### F0 — Serving substrate (ops; domain-gated go-live)
- Cloud DNS zone; wildcard `*.middleman.app` + apex records → load balancer.
- Global external HTTPS LB → serverless NEG → existing Cloud Run service.
- Managed cert: apex SAN **+** `*.middleman.app` wildcard (wildcard does **not** cover the bare apex — list both).
- New env: `ROOT_DOMAIN`, `APP_HOST` (e.g. `app.middleman.app`).
- **Mirror:** N/A (pure transport).
- **Acceptance:** `https://x.middleman.app` and `https://middleman.app` reach the app with valid TLS.
- **Can be staged now; only go-live needs the domain.**

### F1 — Tenancy routing (Dev A · `src/routes` / new `src/domain/tenancy`)
- **F1.1** Add `slug` (unique, not null) to `businesses` (`src/db/schema.ts`); generation rule from name + collision suffix; backfill migration; `slug → businessId` resolver with cache.
- **F1.2** Host→tenant middleware: read `Host`, classify (apex / `app.` / `www` / `{slug}`), resolve `businessId`, attach to request context; unknown subdomain → 404. Registered in `src/server.ts`.
- **F1.3** Static serving: map `{slug}` → GCS prefix, serving the website-builder output at the subdomain root (replaces public `BUCKET_URL/{workflowId}`).
- **Mirror:** read-only; resolver reads business identity, writes nothing.
- **Acceptance:** existing generated sites load at `{slug}.middleman.app`; unknown host 404s. Testable **now** via a forced `Host` header locally — no domain required.

### F2 — Auth & session layer (Dev A · new `src/domain/auth` + `src/routes/session`)
This is the **first human login in the product** (none exists today). One mechanism, two role flavors.
- **F2.1** OTP issue/verify: phone → 6-digit code, delivered over WhatsApp via the existing sender (`src/adapters/whatsapp/sender.ts`); Redis-backed code store with TTL + attempt limits.
- **F2.2** Session: signed, httpOnly cookie carrying `identityId · role · businessId`; expiry + refresh; **revocation honored** (when `revokeAllDelegatedPermissions` runs, kill sessions).
- **F2.3** Tenant-isolation guard: every authenticated handler scopes queries to the session `businessId` — same guarantee as the API-key→businessId model (`src/routes/public-api/auth.ts`).
- New env: `SESSION_SIGNING_SECRET`, `OTP_TTL_SECONDS`.
- **Mirror:** identity resolution only; no scheduling/payment writes.
- **Acceptance:** owner and customer can both OTP-login; session scopes to the right business; a session for business A cannot read business B. Testable **now** (no domain).

---

## 3. Part A — Subdomain mechanism + full B4 customer site

**Goal:** each business's customers, on `{slug}.middleman.app` (business-branded), can discover, book (calendar mirror), pay if required (payment mirror), and self-serve their bookings — all over the internal brain.

**Depends on:** F1 (routing/serving), F2 (customer auth).

- **A1 — Static site at subdomain + AEO correctness** (Dev A `build-site` + Dev B `website-builder`)
  - Set per-business `siteUrl = https://{slug}.middleman.app` (drives JSON-LD `url`, sitemap, llms.txt).
  - **Add `rel="canonical"`** to the renderer (`src/routes/build-site/renderer.ts`) — none exists today.
  - Regenerate sites so all AEO signals carry the real URL (not the bucket path).
  - **Mirror:** site content is a generated projection of business data; no scheduling state.
- **A2 — Customer OTP session** (Dev A) — F2 applied to the `customer` role; per-business identity (`identities` keyed by `(businessId, phoneNumber)`). Phone-only from the customer's side.
  - **Mirror:** identity only.
- **A3 — Web booking + thin Grow checkout** (Dev A · extend `src/routes/public-api/bookings.ts` + a session-auth customer endpoint)
  - Booking endpoint (session- or OTP-gated, secret key never in browser) → `requestBooking`. **(Calendar mirror.)**
  - For `post_payment` businesses: call `createCharge` with `successUrl`/`cancelUrl` (already supported by `CreatePaymentProcessParams`, never passed) and **return `paymentUrl`** in the response → redirect to Grow hosted page. **(Payment mirror — no money-core change.)**
  - Add a **payment-state read endpoint** (`public-api/reads.ts`) so the site shows "confirmed" after the webhook lands (confirmation stays the webhook → `finalizePaidBooking`).
  - **Mirror:** booking via `requestBooking`; payment via `createCharge` + webhook reconcile; never a direct state write.
- **A4 — "My bookings" view** (Dev A) — list upcoming bookings for this business; self-serve cancel/reschedule gated by existing `CUSTOMER_ACTIONS` (`booking.cancel_own`, `booking.reschedule_own`) and policy, all through the core.
  - **Mirror:** mutations via the booking core; reads are projections.
- New env: `successUrl`/`cancelUrl` base derived from `ROOT_DOMAIN`.
- **Acceptance:** end-to-end on a test subdomain — `immediate` business books with zero payment; `post_payment` business is redirected to Grow, pays, and the booking flips to `confirmed` via webhook; "My bookings" cancel/reschedule respects policy; all writes traced to the core.

---

## 4. Part B — B2 → provisioning seam (onboarding stands up the B4 site)

**Goal:** completing MiddleMan onboarding (B2) automatically provisions the business's live B4 site — slug minted, site generated, URL live. The "connection" is this hand-off.

**Depends on:** F1 (slug + serving), Dev B website-builder build trigger.

- **B1 — Provisioning step** (Dev A `src/domain/flows/provider-onboarding.ts` + Dev B `src/skills/website-builder`)
  - On onboarding completion (`onboardingCompletedAt`): mint `slug` (F1.1), invoke the website-builder to generate + publish the site, set `businesses.websiteUrl = https://{slug}.middleman.app`.
  - Idempotent + re-runnable (re-provision / regenerate on later edits).
  - Cross-ownership: the flow seam is Dev A; the build invocation is the Dev B skill; any new shared contract goes in `src/shared/` (both approve).
  - **Mirror:** writes business config + a generated site (a projection); creates **no** scheduling/payment state.
- **B2-site (parallel, no dependency):** the MiddleMan apex marketing pages + "Get started" entry into onboarding. Holds no brain state; can ship anytime.
- **Acceptance:** a freshly onboarded test business has a working, business-branded site at its subdomain with correct AEO, with no manual steps.

---

## 5. Part C — B3 owner PWA application

**Goal:** one MiddleMan-branded installable PWA at `app.middleman.app` where owners (and delegated staff) run their business — calendar management (calendar mirror), the owner data dashboard (calendar + payment mirror), all over the brain. No LLM in the write path.

**Depends on:** F2 (owner auth). **C2 is an early refactor** — schedule it before heavy Part A booking work to avoid domain-layer merge conflicts.

- **C1 — Owner login + business switcher** (Dev A) — F2 for `manager`/`delegated_user`; enumerate every business where the phone holds a role; active `businessId` scopes everything.
  - **Mirror:** identity only.
- **C2 — Extract manager tool handlers into a transport-agnostic service** (Dev A · refactor `src/domain/manager/orchestrator-tools.ts`)
  - Factor the calendar/booking/settings handlers so **both** the LLM orchestrator (WhatsApp) and the web controllers call identical logic. No duplicate write path.
  - **Mirror:** this *is* the calendar-mirror enforcement — web writes reuse the same apply pipeline.
- **C3 — Calendar & booking management UI** (Dev A · server-rendered + progressive JS) — read availability/bookings/rosters; create/move/delete events, change availability, cancel/reschedule, edit class sessions — each via C2.
  - **Mirror:** every mutation through C2 → core → Google write-through.
- **C4 — Data-analyst dashboard** (Dev A) — add **`analytics.view`** to the `Action` union (`src/domain/authorization/check.ts`), manager-default + grantable to staff; server-side reads (secret never in browser) for net income (`pricing/resolver`), # sessions, sessions per instructor, bookings over time, no-show/cancellation, utilization, retention, customer-volume ("traffic" = throughput, **not** web hits). Owner payment actions reuse existing Grow owner tools.
  - **Mirror:** dashboard is read-only projections over the brain; payment actions via existing `executeRequestPayment`/`executeRefundPayment`.
- **C5 — PWA shell** (Dev A) — web manifest + service worker (offline shell + install); optional web-push.
  - **Mirror:** N/A (shell only).
- **Acceptance:** owner installs the PWA, logs in via OTP, switches businesses, manages the calendar (changes appear in WhatsApp + Google — proving one brain), views their dashboard; a delegated user sees only granted actions; revoked staff lose access immediately.

---

## 6. Dependency Graph

```
                 ┌────────── F0 substrate (ops, domain-gated go-live) ──────────┐
                 │                                                              │
   F1 routing ───┼───────────────┐                          F2 auth ───────────┤
   (slug+resolver)               │                          (OTP+session)      │
        │                        │                               │             │
        ▼                        ▼                               ▼             │
   A1 static/AEO          B1 provisioning seam            C1 owner login        │
        │                  (needs Dev-B build hook)        C2 manager extract   │
   A2 customer auth ◄── F2          │                       │                   │
   A3 booking+checkout ◄── core/Grow│                      C3 calendar UI ◄── C2│
   A4 my-bookings                   │                      C4 dashboard+analytics
        │                           │                      C5 PWA shell         │
        └──────────── all converge → integration → go-live (flip F0 on domain) ─┘
```

Critical path: **F1 ∥ F2 → (A · B · C in parallel) → integration → domain go-live.**

---

## 7. Execution Strategy — Subagents & Sessions

The aim is maximum safe parallelism while respecting the ownership boundary and avoiding file collisions. Use **git worktrees** (one per workstream) so parallel sessions never touch the same working tree, and the **writing-plans → executing-plans / subagent-driven-development** flow inside each.

### 7.1 Ownership routing (who/which branch)
- **Dev A (`dev/system/*`):** F0, F1, F2, A1(renderer half), A2, A3, A4, B1(flow half), C1–C5.
- **Dev B (`dev/skills/*`):** A1(`site-schema` half), B1(`website-builder` invocation).
- **`src/shared/` (both approve):** any new context/contract the provisioning seam or web controllers need.

### 7.2 Recommended waves & sessions

| Wave | Sessions (parallel within a wave) | Worktree | Owner | Gated by |
|---|---|---|---|---|
| **0 — Prep (now, no domain)** | Write three per-part `PLAN.md` (writing-plans); draft schema migrations (slug, sessions); 2 recon subagents (see 7.3); stage F0 runbook | main + scratch | A | — |
| **1 — Foundations** | **S1a:** F1 routing · **S1b:** F2 auth | `wt-tenancy`, `wt-auth` | A | Wave 0 |
| **2 — Parallel build** | **S2:** Part A (A1–A4) · **S3:** C2 extract + C1 login · **S4 (Dev B):** A1 skill half + B1 build hook | `wt-b4`, `wt-owner-core`, `wt-skills` | A, A, **B** | Wave 1 |
| **3 — Compose** | **S5:** Part B provisioning seam · **S6:** Part C UI/dashboard/PWA (C3–C5) | `wt-provision`, `wt-owner-ui` | A | S2/S3/S4 |
| **4 — Integrate + go-live** | Integration session: cross-surface E2E, then F0 flip when domain lands | main | A | all + domain |

**Why this shape:** F1/F2 are independent → parallel. C2 (the domain-layer refactor) is isolated in its own worktree in Wave 2 so it doesn't collide with Part A's booking/payment edits. The single Dev-B worktree owns *all* `src/skills` touches (A1 schema half + B1 build hook) to keep skill changes on one branch under one CODEOWNERS approval. Parts A/B/C then converge.

### 7.3 Where subagents earn their keep
- **Wave 0 recon (2 Explore/general-purpose subagents, read-only):**
  1. *Manager-tools extraction surface* — map every handler in `orchestrator-tools.ts`, its core calls, and the cleanest transport-agnostic seam (feeds C2). Avoids a blind refactor.
  2. *Onboarding insertion point* — trace `provider-onboarding.ts` completion + the website-builder invocation contract (feeds B1).
- **Per-wave verification subagent:** after each part, a `requesting-code-review` / `gsd-code-reviewer` pass scoped to that worktree's diff (mirror-compliance is an explicit review criterion).
- **Keep subagents read-or-scoped:** research subagents are read-only; implementation stays in the owning session's worktree. Don't fan out writes across agents on shared domain files.

### 7.4 Coordination rules
- One worktree owns each file path for the duration of a wave; cross-wave merges land to `main` via PR before the next wave starts on top.
- `src/shared/` and `src/skills/` changes are batched onto their owning branch and need the matching CODEOWNERS approval — plan them as discrete PRs, not sprinkled.

---

## 8. Domain-Day Readiness Checklist (definition of ready)

Everything below is achievable **without** the domain, so day-1 is execution, not design:
- [ ] Three per-part `PLAN.md` written and reviewed.
- [ ] Schema migrations drafted: `businesses.slug`; session store; `analytics.view` action.
- [ ] F1/F2 buildable and unit-testable locally via forced `Host` header + local OTP.
- [ ] Env inventory finalized: `ROOT_DOMAIN`, `APP_HOST`, `SESSION_SIGNING_SECRET`, `OTP_TTL_SECONDS`, Grow `successUrl`/`cancelUrl` base.
- [ ] F0 substrate runbook staged (DNS/LB/cert steps) pending the domain.
- [ ] Recon subagent findings (7.3) captured in the C2 and B1 plans.

**Only these need the domain:** F0 DNS/cert go-live, real-subdomain E2E, and flipping `GATE-1`. Optional: most of Parts A/B/C can be **built and tested before the domain** (forced Host header), then switched live the day DNS resolves — if you want to start ahead of acquisition.

---

## 9. Open Decisions / Risks

- **Payments scope (resolved-small):** money core complete; only the thin web checkout (A3) is new. `immediate` businesses launch with zero payment work.
- **`analytics.view`:** trivial addition, must not be skipped (capabilities come from the authorization layer).
- **Cross-business customer account:** out of scope — per-business identity only.
- **B2 marketing site content/design:** parallel track, no dependency; not on the critical path.
- **PWA push notifications:** optional in C5; WhatsApp remains the primary notification channel.
