# PA_4_Business — Development Operating Model
**Status: Active**
**Last updated: 2026-04-23**

---

## What This Document Is

This document covers how we build — team/agent roles, development workflows, tooling rules, and testing invariants. It is separate from the system architecture. For what the system does at runtime, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Part 1 — Development Roles

These are roles in the build process, not runtime system components.

### Implementation Planner
- Translates user requests into scoped development tasks
- Checks alignment with ARCHITECTURE.md before proposing work
- Identifies missing constraints or underspecified behavior
- Asks only necessary clarifying questions before defining a task

### Backend Architect
Owns:
- Domain model and database schema
- Booking engine and state machine
- Manager rule and policy systems
- Permission model
- Calendar Adapter
- Background job design

### Messaging Systems Architect
Owns:
- WhatsApp Adapter (inbound and outbound)
- Message normalization and deduplication
- Identity resolution
- Conversation routing and session management
- LLM Adapter (intent extraction, structured output)
- Customer and manager flow handlers

### Verifier
Owns:
- Invariant definitions (drawn from ARCHITECTURE.md Layer 6)
- Test coverage for booking logic, authorization, calendar integration, and core flows
- Edge case identification
- Regression prevention — every bug fix ships with a test

---

## Part 2 — Development Workflows

### Mission Intake
Before starting any task:
1. Restate the request in one sentence
2. Identify which ARCHITECTURE.md components are affected
3. Confirm alignment with stated principles and scope boundaries
4. Ask only blocking questions — do not ask for information that can be derived from the architecture doc or the code
5. Define the task with clear inputs, outputs, and acceptance criteria

### Implementation
1. Read ARCHITECTURE.md sections relevant to the change
2. Read existing code and tests in the affected area
3. Localize the change — identify the smallest correct modification
4. Implement, preserving component boundaries defined in Architecture Part 4
5. Write or update tests
6. Summarize what changed and why

### Debugging and Verification
1. Reproduce the failure with a test or log trace
2. Identify which layer and component the fault originates in
3. Inspect evidence before forming a hypothesis
4. Fix minimally — do not refactor surrounding code during a bug fix
5. Add a regression test
6. Summarize the root cause in one sentence

---

## Part 3 — Environment Variables

All secrets and config are injected as environment variables. In production, these are stored in GCP Secret Manager and mounted at runtime.

### Required for all environments
```
DATABASE_URL                    postgres://...
REDIS_URL                       redis://...

# Business PA number (global fallback — overridden per-business in DB)
WHATSAPP_ACCESS_TOKEN           System user permanent token
WHATSAPP_PHONE_NUMBER_ID        Meta phone number ID
WHATSAPP_WEBHOOK_VERIFY_TOKEN   Any string; must match Meta webhook config
WHATSAPP_APP_SECRET             For HMAC signature verification

# Provider onboarding number (our central number — Step 0 only)
PROVIDER_WA_NUMBER              E.164 phone number (e.g. +15550001234)
PROVIDER_WA_PHONE_NUMBER_ID     Meta phone number ID for provider number
PROVIDER_WA_ACCESS_TOKEN        System user token for provider number

# Google Calendar
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_REDIRECT_URI             https://<domain>/oauth/google/callback

# Vertex AI (LLM)
GOOGLE_CLOUD_PROJECT
VERTEX_AI_LOCATION              us-central1

# Server
PUBLIC_BASE_URL                 https://<domain>  (used in OAuth links and import URLs)
PORT                            3000
NODE_ENV                        production | development
SESSION_EXPIRY_MINUTES          30
HOLD_EXPIRY_MINUTES             15
```

### Per-business WhatsApp credentials (stored in DB, not env)

`WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` in `.env` are the global fallback. Once a business is provisioned (via the provider onboarding flow or `npm run provision`), per-business values are stored in `businesses.whatsapp_access_token` and `businesses.whatsapp_phone_number_id`. The sender uses DB values when present, falling back to env vars.

---

## Part 4 — Provisioning a New Business

There are two paths to register a new business in the system.

### Path A — Self-serve via provider WhatsApp number (primary)

1. Ensure `PROVIDER_WA_NUMBER`, `PROVIDER_WA_PHONE_NUMBER_ID`, and `PROVIDER_WA_ACCESS_TOKEN` are set
2. Business owner texts the provider number from their personal WhatsApp
3. The 4-step onboarding conversation runs automatically
4. On completion, Business and Identity rows are created; owner is directed to their PA number
5. Owner texts the PA number to continue with Steps 1–6

### Path B — Direct CLI provisioning (operator fallback)

```bash
PROVISION_WA_NUMBER=+...          \  # PA number (E.164)
PROVISION_MANAGER_PHONE=+...      \  # Owner's personal number
PROVISION_BUSINESS_NAME="..."     \  # Internal name
PROVISION_CALENDAR_ID="..."       \  # Google Calendar ID
PROVISION_TIMEZONE="Asia/Jerusalem" \
PROVISION_WA_PHONE_NUMBER_ID=...  \  # Meta phone number ID for PA number
PROVISION_WA_ACCESS_TOKEN=...     \  # Meta system user token for PA number
npm run provision
```

Output confirms created rows and prints the webhook setup checklist.

### Webhook setup (both paths)

Before a PA number can receive messages, its webhook must be configured in Meta Business Manager:
- **Callback URL:** `https://<domain>/webhook`
- **Verify token:** value of `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
- **Subscribed fields:** `messages`

This is done once per PA number in Meta Business Manager → WhatsApp → Configuration → Webhook.

---

## Part 5 — Tooling Rules

1. Always read ARCHITECTURE.md and relevant code before proposing changes.
2. All external systems must be accessed through their Adapter. Never call Google Calendar, WhatsApp API, or the LLM directly from business logic.
3. Normalize at the boundary. Data entering the system from external sources is normalized to internal types before it touches any business logic.
4. Never use `any` types in TypeScript. The LLM adapter must validate against a schema before returning structured output.
5. No silent catches. Every caught error is either handled and logged, or re-thrown.
6. Migrations are additive in V1. No destructive schema changes without explicit decision.

---

## Part 6 — Testing Invariants

These must never be broken. A failing test for any of these is a blocker.

### Booking invariants
- A booking cannot reach `confirmed` without having passed through `held`
- A booking cannot reach `held` without a valid, specific slot and a passed policy check
- Two bookings cannot both be `confirmed` or `held` for the same slot and provider
- A booking in a terminal state (`confirmed`, `cancelled`, `expired`, `failed`) cannot transition to any other state except `confirmed` → `cancelled`

### Authorization invariants
- No action executes without a resolved identity
- A `customer` cannot perform manager-only actions regardless of message content
- Delegated permissions are checked against the explicit grant, not inferred

### External system invariants
- A Calendar API error never results in a booking state advancing
- An LLM response that fails schema validation never reaches business logic
- A duplicate WhatsApp `message_id` is never processed twice

### Audit invariants
- Every booking state transition produces an audit log entry
- Every manager instruction application produces an audit log entry
- Audit entries are never deleted

### Onboarding invariants
- A message to the provider number never touches any Business row — it only reads/writes `provider_onboarding_sessions`
- A business's manager instruction handler is never reachable while `onboarding_completed_at` is null
- An import token can only be used once; a second upload attempt with the same token is rejected
- An import token cannot be used after `expires_at`
- Step 0 credential validation must call the Meta API before creating any DB rows — invalid credentials must not result in a Business record

---

*This document governs how we work. The system behavior is in ARCHITECTURE.md.*
