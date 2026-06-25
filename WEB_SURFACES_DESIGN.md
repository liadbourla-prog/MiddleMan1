# Web & App Surfaces — UX & Functional Design

**Status:** Design (pre-build). System live at **v1.0.79**.
**Date:** 2026-06-24
**Read alongside:** [ARCHITECTURE.md](ARCHITECTURE.md) Part 16 (the Four Chat Branches), [CALENDAR_UX_DESIGN.md](CALENDAR_UX_DESIGN.md) (source-of-truth hierarchy), [MULTI_AGENT_DESIGN.md](MULTI_AGENT_DESIGN.md) (Branch-3 orchestrator), [CRM_STANDARD.md](CRM_STANDARD.md).

> **Placeholder:** `middleman.app` is used throughout as a stand-in for the real MiddleMan root domain (not yet registered — gated behind `GATE-1` in the website-builder).

---

## 0. The Lead Principle — Everything Is a UX Mirror

There is exactly **one brain: the internal engine.** It is the operational source of truth for every scheduling primitive, for every business, always (per [CLAUDE.md](CLAUDE.md) Principle #3 and CALENDAR_UX_DESIGN.md §2).

**Every surface in this document — the MiddleMan website, the owner application, and the customer websites — is a UX mirror over that brain. None of them is a source of truth. None of them mutates state directly.**

This is the *same* relationship Google Calendar already has with the system:

- Google Calendar is a **bidirectional mirror** — the PA write-throughs internal state outbound, and owner edits in Google are ingested as input events and reconciled (`src/domain/calendar/inbound-sync.ts`).
- The web/app surfaces are mirrors in exactly the same sense: a read renders internal state; a write is a **request** that passes through the deterministic core (identity → policy → scheduling → calendar validation → safe write) before it takes effect.

```
                 ┌─────────────────────────────────────────────┐
                 │            THE BRAIN (internal)              │
                 │  deterministic core + DB (source of truth)   │
                 │  requestBooking() · manager apply pipeline   │
                 └───────────────▲───────────────▲──────────────┘
                                 │               │
            requests / reads     │               │   write-through + ingest
        ┌────────────────────────┼───────┐   ┌───┴──────────────┐
        │        UX MIRRORS              │   │  GOOGLE CALENDAR  │
        │  WhatsApp (B1–B4)              │   │   (bidirectional  │
        │  MiddleMan website   (B2)      │   │      mirror)      │
        │  Owner application   (B3-equiv)│   └───────────────────┘
        │  Customer websites   (B4-equiv)│
        └────────────────────────────────┘
```

**The one law that governs this entire document:** the calendar and booking mechanism in *every* website and application MUST call the internal engine. A surface may render cached/projected state for speed, but a mutation is never anything more than a request into the core. If the core says no, the surface shows no. A booking made on a customer website is the *same* booking, through the *same* `requestBooking()`, as one made over WhatsApp.

---

## 1. The Surfaces at a Glance

We extend the **branch** vocabulary (ARCHITECTURE.md Part 16) from WhatsApp to web/app. A surface is the "X-equivalent" of a branch when it exposes the **same capabilities over the same core**, even though the *mechanism* differs (web UI / structured controls instead of an LLM conversation).

| Branch | WhatsApp surface (live) | Web/App equivalent (this doc) | Audience | Brand | Host |
|---|---|---|---|---|---|
| **B1** Operator | `flows/operator.ts` | — (internal ops; out of scope here) | MiddleMan operator | MiddleMan | — |
| **B2** MiddleMan Onboarding | `flows/provider-onboarding.ts` | **The MiddleMan website** | Prospective business owners | **MiddleMan** | apex: `middleman.app` |
| **B3** PA Manager Channel | `flows/manager-onboarding.ts` + orchestrator | **The Owner Application** (one app, all owners) | Business owners + their staff | **MiddleMan** | `app.middleman.app` |
| **B4** PA Customer Channel | `flows/customer-booking.ts` | **The Customer Websites** (one per business) | Each business's customers | **The business** (never MiddleMan) | `{slug}.middleman.app` (subdomain) |

**Critical branding rule:** B2 and B3 are **MiddleMan-branded** (the owner has a relationship with MiddleMan). B4 sites are **business-branded** — a customer of "Dana Yoga" sees Dana Yoga and never sees the word MiddleMan, even though the site is served from a `middleman.app` subdomain. The shared root domain is a hosting detail, not a brand statement.

---

## 2. Branch 2 — The MiddleMan Website

**Role:** MiddleMan's own marketing + acquisition front door, and the web entry point to the onboarding funnel that today runs over WhatsApp (`flows/provider-onboarding.ts`).

**Host:** the apex, `middleman.app` (+ `www`).

**Brand:** MiddleMan.

**Source-of-truth status:** none. It is pure marketing/funnel content plus a hand-off into onboarding. It holds no scheduling state.

**Functionality (v1):**
- Marketing pages: what the product is, who it's for, pricing/plans.
- "Get started" → kicks off provider onboarding (deep-link to WhatsApp `wa.me/<provider number>`, or a web lead form that seeds onboarding).
- Links to legal (privacy policy already exists at `docs/privacy-policy.html`).

**Explicitly NOT here:** customer booking, owner dashboards. Those live on B3/B4 surfaces. The MiddleMan website is the only surface that is *not* a mirror over the brain — it has nothing to mirror.

**Dependency note:** the MiddleMan website is **independent** of the subdomain mechanism and the owner app. The only thing it shares with them is the registered domain + the serving substrate (§6). It can ship before, after, or in parallel — it is **not** a prerequisite for the others.

---

## 3. Branch 3-equivalent — The Owner Application

**Role:** the web/app equivalent of the WhatsApp Manager Channel — where an owner (and their delegated staff) run their business: see their data, manage their calendar, manage bookings and settings.

**Host:** `app.middleman.app` — **one multi-tenant application serving all owners.** Not one app per business.

**Brand:** MiddleMan.

**Mechanism vs. WhatsApp B3:** the WhatsApp manager channel is an LLM orchestrator (`src/adapters/llm/orchestrator.ts`). The application is **structured UI controls** that call the same deterministic domain functions directly. **There is no LLM in the write path** — which is strictly safer (nothing to misinterpret). An embedded assistant/chat panel is a possible later addition, not part of v1.

**Delivery — installable web app (PWA), not a native download (DECIDED).** Build it as a responsive web app at `app.middleman.app`, made installable as a **Progressive Web App**: the owner taps "Add to Home Screen" and gets an app icon, full-screen chrome, an offline shell, and push notifications — the *feel* of a downloaded app **without** app-store review, native codebases (iOS + Android / React Native), signing, store fees, or a release-gated update cycle. One codebase, instant updates, lands on the shared substrate (§6.1). The owner app is structured CRUD over the core — a web app does this perfectly; going native first is premature for ~10–100 businesses. A native shell (or full native app) can wrap the same app later *if* a real need appears (deep device integration). **Net-new note:** this also introduces the product's first-ever human login (§3.1) — today there is no web session/cookie/JWT anywhere; auth is only the WhatsApp phone identity + machine API keys.

### 3.1 Authentication & tenancy
- **Login = phone OTP**, delivered over WhatsApp from the operator/PA number the owner already trusts. No passwords.
- The session is a signed token carrying **`identityId` + `role` + `businessId`**.
- **Multi-business owners:** one human can be a `manager` in several businesses (the `identities` table is keyed by `(businessId, phoneNumber)`). After login, the app enumerates every business where this phone is `manager`/`delegated_user` and shows a **business switcher**. The active `businessId` scopes every query.
- **Staff ride the same app for free.** A `delegated_user` logs into the *same* app and sees a reduced capability set per their granted actions (`delegated_permissions`). The app is really a *business-operator* app — design for owner **and** staff from day one; never hardcode "manager".
- **Revocation is honored:** when staff access is revoked (`revokeAllDelegatedPermissions`, `src/domain/authorization/permissions.ts`), their live sessions die.

### 3.2 Capabilities = the existing authorization actions
The app exposes **no new powers** — it surfaces the same `Action` set already enforced in `src/domain/authorization/check.ts`:
`booking.*`, `schedule.set_availability`, `service.modify`, `policy.change`, `staff.manage`, `permission.manage`, `meeting.coordinate`.
Every action in the UI is gated by `authorize(ctx, action)` server-side, exactly as the orchestrator gates the WhatsApp manager.

> **New action required:** the data-analyst dashboard (§3.4) needs a read capability that doesn't exist yet — add **`analytics.view`** to the `Action` union. Manager-by-default; grantable to a `delegated_user`.

### 3.3 Calendar & booking management (the mirror law in B3)
The owner manages the calendar through the app, and **every mutation goes through the same apply pipeline the WhatsApp orchestrator uses** (`src/domain/manager/orchestrator-tools.ts`, `src/domain/manager/apply.ts`). The web controllers must call that shared core — **not** reimplement scheduling logic.
- Read: render availability, bookings, class rosters from internal state.
- Write: create/move/delete events, change availability, cancel/reschedule bookings, edit class sessions, change services/policy — each routed through the deterministic core, which write-throughs to Google Calendar like any other mirror.
- **Action item:** factor the orchestrator's tool handlers into a transport-agnostic service layer so both the LLM (WhatsApp) and the web controllers invoke identical logic. No duplicate write paths.

### 3.4 The Data-Analyst Dashboard (owner-only)
The original ask: a dedicated, owner-only analytics page.
- **Access:** gated by `analytics.view`. The page is server-rendered/served only to a session whose `businessId` matches and whose role/grant includes the action. The browser never holds a secret API key — all analytics reads happen **server-side** within the session.
- **Content (owner's own business only):**
  - **Net income** — sum over completed/paid bookings via `pricing/resolver` (`bookings.state`, currency from `businesses.currency`).
  - **Number of sessions** — count of sessions/classes in a period.
  - **Sessions per instructor** — grouped by `providerAssignments` / class roster instructor.
  - **Bookings over time**, **no-show / cancellation rates** (`bookings.state`, attendance), **utilization** (booked vs. capacity per service/instructor), **waitlist & reshuffle outcomes**, **customer retention** (CRM_STANDARD.md).
  - **Customer volume / "traffic"** — how many customers and sessions flow through the business over a period (busy vs. quiet), derived from bookings/sessions. *(Business throughput — NOT website page-views; web-analytics/site-visit tracking is explicitly out of scope and will not be built.)*
- **Source:** a single stream — read-only projections over the internal DB, scoped to the active `businessId`. A mirror over the brain, never a separate analytics store of record.

---

## 4. Branch 4-equivalent — The Customer Websites

**Role:** the web equivalent of the WhatsApp Customer Channel — where a business's customers discover services and **book**, coherently with the internal calendar (and therefore with WhatsApp and Google Calendar).

**Host:** `{slug}.middleman.app` — one per business, **business-branded** (§5 explains the architecture).

**Composition — two layers on one host:**
1. **Static marketing pages** (already generated today by the `website-builder` skill → `src/routes/build-site/renderer.ts`, stored in GCS). SEO/AEO-optimized (`aeo-layer.ts`: JSON-LD, `llms.txt`, sitemap).
2. **Dynamic booking + light account** (new) — cannot be static; auth + live availability + writes. App-served, business-branded.

### 4.1 Customer booking (the mirror law in B4)
This already exists at the API level: `POST /api/v1/bookings` (`src/routes/public-api/bookings.ts`) → `registerCustomer` → `requestBooking(db, calendar, identity, …)` → the deterministic core → Google write-through → WhatsApp confirmation + Redis idempotency. **A website booking is already the same booking as a WhatsApp booking.** The remaining work is the front-of-house, not the engine:
- The browser must **never hold the secret API key** (writes are secret-scoped). So the **app itself** (server-side, holding the key or calling the core directly) exposes a **customer-facing booking endpoint** that the business site calls. Anti-abuse: rate limiting (`public-api/rate-limit.ts` already exists) + phone-OTP verification before the write.
- Read endpoints (services, availability, schedule) are publishable-scope and already exist (`public-api/reads.ts`).
- **Payment (`post_payment` businesses):** the Grow money core is already complete and confirmation is processor-/initiator-agnostic — a Grow webhook flips the booking `pending_payment → confirmed` (`reconcilePayment` → `finalizePaidBooking`) no matter how the charge was created. Today the pay-link is only ever created by an owner/worker and delivered over **WhatsApp**. For web booking, the only missing piece is a **thin web checkout path**: for a `post_payment` business, call `createCharge` with `successUrl`/`cancelUrl` (already supported by `CreatePaymentProcessParams`, just never passed) and **return the `paymentUrl` in the booking response** so the site can redirect the customer to Grow's hosted page, plus a small **read endpoint to poll the booking's payment state** so the site can show "confirmed" after the webhook lands. **No change to the money core.** `immediate` businesses need none of this.

### 4.2 Customer authentication — phone-only, minimal friction
Per decision: **per-business identity, kept as close to phone-number-only as possible.**
- Flow: customer enters phone → 6-digit OTP via WhatsApp from **the business's own PA number** (a channel they may already be chatting in) → enter code → session. That's it. No password, no email, no profile setup.
- The **same OTP that authorizes a booking also establishes the light account session** — one mechanism, not two.
- **Identity is per-business** (matches `identities` keyed by `(businessId, phoneNumber)`). The same person booking at three businesses simply re-verifies their phone at each. **No cross-business consumer account** — that is explicitly out of scope (see §7).

### 4.3 The "light account" — what login buys the customer
Booking itself needs only the OTP. The persisted session adds a minimal **"My bookings"** view:
- See upcoming bookings at *this* business.
- Self-serve **cancel / reschedule** — gated by the existing `CUSTOMER_ACTIONS` (`booking.cancel_own`, `booking.reschedule_own`) and the business's cancellation policy, all enforced by the core.
- Nothing heavier (no saved payment, no loyalty) in v1.

---

## 5. The Subdomain Architecture — Explained

> You asked to fully understand this. Here is the whole mechanism end to end.

### 5.1 The shape
- The MiddleMan website lives at the **apex**: `middleman.app`.
- Each business gets a **subdomain**: `danayoga.middleman.app`, `joescuts.middleman.app`, … The `slug` (`danayoga`) is a new per-business field; the subdomain is its public home.
- These are **siblings on one registered domain**, not parent/child pages. "Under the Branch-2 website" is true only in the DNS-root sense — to the customer, `danayoga.middleman.app` is Dana Yoga's site, fully business-branded.

### 5.2 The three moving parts (set up once, then free per business)
1. **Wildcard DNS.** One record, `*.middleman.app`, points every subdomain at the serving layer. Adding business #101 needs **no new DNS** — the wildcard already resolves it. (The apex `middleman.app` is its own record.)
2. **Wildcard TLS certificate.** One cert for `*.middleman.app` secures *every* subdomain (HTTPS) — Google-managed or Let's Encrypt, auto-renewed, **free**. (The apex needs its own SAN — a wildcard does **not** cover the bare apex.) Adding business #101 needs **no new cert**.
3. **Host→tenant resolver.** A single fronting layer (HTTPS load balancer → the Cloud Run app) reads the incoming `Host` header, maps `{slug}` → `businessId`, and serves that tenant's content (the GCS prefix for static pages; the core for dynamic booking). Unknown host → 404.

### 5.3 A request, end to end
```
Customer opens  https://danayoga.middleman.app/book
        │
        ▼
DNS: *.middleman.app  ──► the load balancer's IP        (1 wildcard record)
        │
        ▼
TLS: handshake secured by the *.middleman.app cert      (1 wildcard cert)
        │
        ▼
LB / app reads  Host: danayoga.middleman.app
        │  resolves slug "danayoga" ──► businessId
        ▼
   ┌──────────────── route by path ────────────────┐
   │ static page (/, /services)  →  GCS prefix       │  ← marketing (website-builder output)
   │ booking/account (/book, /me) →  internal core   │  ← requestBooking(), scoped to businessId
   └─────────────────────────────────────────────────┘
        │
        ▼
Page renders, business-branded. Any booking = a request into the brain.
```

### 5.4 Why subdomain (vs. subdirectory)
- **Independence & branding:** `danayoga.middleman.app` reads as Dana Yoga's own namespace; `middleman.app/danayoga` reads as a MiddleMan sub-page.
- **AEO:** answer engines treat subdomains as semi-separate entities, isolating each business's reputation; a subdirectory pools all businesses under one entity and risks Google's "site-reputation-abuse" treatment at scale.
- **Cost:** the mechanism is **flat** — ~$20–30/mo of substrate (LB + DNS; certs free) whether you have 1 or 1,000 businesses, with **zero marginal ops per business**.

### 5.5 Custom-domain upgrade (later, not v1)
A business that wants `danayoga.com` can later point it at the same substrate. This is the only model with per-tenant cost (its own cert + DNS + renewal monitoring), so it's a **paid upgrade** — only businesses who opt in (and pay) incur that ops overhead. The serving layer already keys off the `Host` header, so a custom domain is just another host mapped to the same `businessId`. **Canonical-URL discipline (§6.3) makes this safe.**

---

## 6. Shared Serving Substrate, Auth, and AEO

### 6.1 One substrate for all three surfaces
All hosts ride the same load balancer + cert setup:

| Host | Surface | Cert |
|---|---|---|
| `middleman.app` | B2 MiddleMan website | apex SAN |
| `app.middleman.app` | B3 owner application | covered by `*.middleman.app` |
| `{slug}.middleman.app` | B4 customer sites | covered by `*.middleman.app` |

Standing up this substrate is the **one shared prerequisite**. Once it exists, B2 / B3 / B4 proceed independently. **This is why the substrate + subdomain mechanism should be built now** — the owner app (`app.middleman.app`) lands on it later with no new routing/cert work.

### 6.2 Unified authentication
One OTP→signed-session mechanism serves both owners and customers; the session carries `role` + `businessId`. Differences:
- **Owner/staff:** OTP via operator/PA number; multi-business switcher; capabilities = manager/delegated actions.
- **Customer:** OTP via the business's PA number; single business; capabilities = `CUSTOMER_ACTIONS`.
- **Tenant isolation (non-negotiable):** every query is filtered by the session's `businessId`. A session for business A can never read business B — the same guarantee the API-key→`businessId` model gives today (`src/routes/public-api/auth.ts`), now on a larger surface.

### 6.3 AEO (required regardless of model)
Every AEO signal is anchored to one `siteUrl` (`src/routes/build-site/aeo-layer.ts`: `LocalBusiness.url`, `WebSite`, sitemap, `llms.txt`). Therefore:
1. Make `siteUrl` the business's **stable subdomain** (or custom domain), not today's `BUCKET_URL/{workflowId}`.
2. **Add `rel="canonical"`** to the renderer, pointing at the one chosen host (custom domain if present, else subdomain) — prevents duplicate-content dilution when a site is reachable at multiple hosts.
3. Keep NAP + `googleBusinessProfileUrl` (`sameAs`) consistent between the site and the Google Business Profile.

---

## 7. Open Decisions & Known Gaps

- **Payments — mostly a non-gap (audited).** The **Grow** integration (`src/domain/payments/*`, `src/adapters/grow/*`, branch `dev/system/grow-payments`) is fully built: hosted pay-link via `createPaymentProcess` (no card data ever touches the system), webhook reconcile that confirms the booking (`reconcilePayment` → `finalizePaidBooking`), idempotency, dunning, owner-commanded request/refund. The confirmation backbone is **agnostic to who created the charge**, and web bookings already land in `pending_payment` through the same engine. The *only* missing piece for customer self-pay on a website is the thin web checkout path described in §4.1 (return `paymentUrl` with `successUrl`/`cancelUrl`; add a payment-state read endpoint). The money core needs no rework. `immediate`-confirmation businesses can launch B4 booking with zero payment work.
- **Cross-business consumer account.** Explicitly **out of scope.** Customer identity is per-business. Revisit only if a "one login, all my bookings everywhere" consumer product is ever greenlit (a new identity layer + data-model change).
- **Embedded assistant in the owner app.** The orchestrator could later be surfaced as a chat panel inside B3. Optional; not v1.
- **Real domain.** `middleman.app` is a placeholder; registration + registrar/hosting integration is gated behind `GATE-1` (website-builder). `PUBLIC_BASE_URL` already exists in env.

---

## 8. Build Sequencing (no rework)

1. **Shared substrate** — register domain; stand up LB + wildcard cert (`middleman.app` apex SAN + `*.middleman.app`) + Cloud DNS wildcard. (~1 day ops.)
2. **Subdomain mechanism** — `slug` per business; `Host`→tenant resolver; serve existing generated sites at `{slug}.middleman.app`; add `canonical` + stable `siteUrl`. *(Highest leverage — upgrades the already-live customer-facing product off the weak bucket URL.)*
3. **B4 dynamic layer** — customer phone-OTP session; customer booking endpoint (server-side, secret key never in browser) → `requestBooking`; "My bookings" view.
4. **B3 owner application** — installable web app (PWA) at `app.middleman.app`; OTP login + business switcher; calendar/booking management via the shared apply pipeline; **add `analytics.view`** + the data-analyst dashboard. *(First human login in the product.)*
5. **B2 MiddleMan website** — apex marketing/onboarding content (parallel, no dependency).
6. **Later** — custom-domain upgrade; payments; optional embedded assistant.

---

## 9. Invariants (the short version)

1. **One brain.** The internal engine is the only source of truth. Every surface is a mirror.
2. **No surface mutates state directly.** Booking/calendar writes are requests into the deterministic core (`requestBooking`, the manager apply pipeline) — same as WhatsApp, same as Google Calendar's ingest.
3. **One app for owners, one site per business for customers.** Owner app = MiddleMan-branded, multi-tenant. Customer sites = business-branded subdomains.
4. **Capabilities come from the authorization layer**, not invented per surface. Web actions are gated by the same `authorize()` checks (+ new `analytics.view`).
5. **Tenant isolation always.** Every query scoped to the session's `businessId`.
6. **The subdomain mechanism is buildable now** — independent of the MiddleMan website; the only shared prerequisite is the domain + serving substrate.
