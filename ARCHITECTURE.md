# PA_4_Business — System Architecture
**Status: Active — updated to reflect implemented system.**
**Last updated: 2026-04-30**

---

## What This Document Is

This is the authoritative design reference for the WhatsApp-based PA system.
It covers runtime architecture only — how the system behaves in production.
Development process, team roles, and build workflows are in [DEV_OPERATING_MODEL.md](DEV_OPERATING_MODEL.md).

---

## Part 1 — Product Identity and Core Principles

### What This System Is

A B2B personal assistant product for local businesses. One PA instance per business. Customers and the business manager interact exclusively through WhatsApp. The system manages real operational workflows — primarily booking, scheduling, and calendar management. It is not a chatbot. Conversational fluency is a secondary concern.

**Two-number architecture:**
The platform operates two categories of WhatsApp numbers:

1. **Provider number** — one central number owned by us (the platform operator). Used exclusively during Step 0 onboarding to register new business customers. Once a business is live, they never use this number again.
2. **PA number** — one dedicated number per business, registered under their existing WhatsApp Business API account. This is the number their customers message to book, and the number the business owner messages to manage the PA.

These two numbers share the same webhook endpoint. Incoming messages are routed by `to_number`: provider number → provider onboarding flow; any other number → business-specific flow.

### Core Principles

**1. Operational correctness over conversational fluency**
The system must produce correct outcomes. A grammatically awkward reply with the right booking state is better than a smooth reply with an inconsistent one.

**2. The LLM is interpretive, not authoritative**
The LLM extracts intent and produces structured output. It never directly mutates system state. Every action it proposes must pass through the deterministic core before taking effect.

**3. Deterministic core**
All state-changing actions pass through, in order:
- Identity and authorization check
- Policy check
- Scheduling and availability logic
- Calendar validation
- Safe write with conflict detection

No step may be skipped. No shortcut paths.

**4. Identity always known**
Every inbound message carries a resolved identity before processing begins:
- `customer` — member of the public
- `manager` — business owner / operator
- `delegated_user` — explicitly granted elevated permissions

Messages where identity cannot be resolved are rejected before reaching business logic.

**5. Explicit over implicit**
Vague input never produces a booking. Ambiguity must trigger a clarification request. The system must confirm before committing.

**6. Failure is explicit**
External systems fail. Calendar unavailability, WhatsApp delivery failure, and LLM errors each have defined handling. A failed operation must never be treated as a success. Partial state changes must be rolled back or flagged.

**7. Auditability**
Every state-changing action produces an audit record. No silent mutations. Logs must be able to answer: who requested it, what was the system state, what was the outcome, and why.

**8. Source-of-truth hierarchy**
The **internal system is the operational source of truth** for all scheduling primitives (bookings, holds, blocks, personal events, class instances), for every business, always — whether or not Google is connected. Google Calendar is a **bidirectional mirror**, not a competing authority: the PA write-throughs internal state changes outbound, and owner-originated edits in Google are ingested as input events and reconciled into the internal record (**internal-as-hub**). When sources conflict, this ordering is authoritative:

| Source | Truth domain |
|---|---|
| Internal system | Schedule reality, policy, permissions, booking state — the operational source of truth |
| Google Calendar | Bidirectional mirror — owner edits are inputs reconciled into the internal record, never an independent authority |
| WhatsApp | Interface only — never source of truth |
| State machine definitions | Valid transitions |
| This document | Design intent |

> **Note — inversion from V1.** Earlier revisions ranked "Google Calendar > internal system." That ordering is **inverted** by the local-calendar UX design: the internal DB is now the hub and Google is a mirror. See `CALENDAR_UX_DESIGN.md` §2 for the full model and reconciliation guarantees (eventually-consistent push + periodic full reconcile, owner-edits-win with a blast-radius gate).

---

## Part 2 — Domain Model

### Entities

#### Business
```
id
name
whatsapp_number           # PA number in E.164 — what customers message
whatsapp_phone_number_id  # Meta phone number ID for this PA number
whatsapp_access_token     # Meta system user token for this PA number
google_calendar_id
google_refresh_token
timezone
onboarding_step           # null when onboarding complete; tracks progress through Steps 1–6
onboarding_completed_at   # set when manager completes Step 6 (verify)
created_at
```

#### ProviderOnboardingSession
Tracks Step 0 progress for a business owner talking to the provider number. Keyed by the owner's personal phone number. Destroyed (marked completed) once the business row is created.
```
id
manager_phone             # E.164 — the business owner's personal number
step                      # enum: business_name | timezone | calendar | credentials
collected_data            # JSON — accumulates answers across turns
completed_at              # set when business is provisioned
created_at
updated_at
```

#### ImportToken
One-time signed tokens for the CSV data import page (Step 5 of business onboarding).
```
token                     # UUID, unguessable — acts as the secret
business_id
manager_phone             # who receives the WhatsApp confirmation on upload
expires_at                # 30 minutes from generation
used_at                   # null until upload completes (prevents reuse)
created_at
```

#### Identity
```
id
business_id
phone_number              # E.164 format
role                      # enum: manager | delegated_user | customer
display_name
granted_by                # identity id (null for manager)
granted_at
revoked_at                # null = active
```

#### ServiceType
```
id
business_id
name                      # e.g. "Haircut", "Consultation"
duration_minutes
buffer_minutes            # gap appended after the slot
requires_payment          # bool
payment_amount            # null if not required
is_active
```

#### Availability
```
id
business_id
provider_id               # identity id (or null = business-level)
day_of_week               # 0–6, null if date-specific
specific_date             # null if recurring
open_time                 # HH:MM
close_time                # HH:MM
is_blocked                # true = closure or block
reason                    # optional label
```

#### Booking
```
id
business_id
service_type_id
customer_id               # identity id
provider_id               # identity id (null = any)
requested_at              # ISO 8601
slot_start                # ISO 8601
slot_end                  # ISO 8601
state                     # see state machine below
hold_expires_at           # set when state = held
calendar_event_id         # Google Calendar event id (set on confirm)
payment_status            # enum: not_required | pending | paid | failed
cancellation_reason
rescheduled_from          # booking id (null if original)
created_at
updated_at
```

#### ConversationSession
```
id
business_id
identity_id
intent                    # enum: booking | rescheduling | cancellation | inquiry | manager_instruction | unknown
state                     # enum: active | waiting_confirmation | waiting_clarification | completed | expired | failed
context                   # JSON — accumulated structured data for current intent
last_message_at
expires_at                # sessions expire after inactivity
created_at
```

#### ManagerInstruction (raw ledger)
```
id
business_id
identity_id
raw_message               # exact WhatsApp message text, never modified
received_at
classified_as             # enum: availability_change | policy_change | service_change | permission_change | unknown
structured_output         # JSON — result of classification
applied_at                # null if pending or failed
apply_status              # enum: pending | applied | failed | requires_clarification
clarification_request     # what was asked back, if any
```

#### AuditLog
```
id
business_id
actor_id                  # identity id
action                    # string key, e.g. "booking.confirmed"
entity_type
entity_id
before_state              # JSON snapshot
after_state               # JSON snapshot
metadata                  # JSON — any additional context
created_at
```

#### SkillWorkflow
Durable state for Workflow Skills — multi-step operations that span multiple sessions (e.g. building a website). One active row per business × identity × skill at a time.
```
id
business_id
identity_id
skill_name                # stable kebab-case skill identifier
step                      # current step name within the workflow
state                     # JSON — accumulated workflow data (inputs, outputs, decisions)
status                    # enum: active | paused | completed | failed
version                   # integer, increments on every write — used for optimistic locking
created_at
updated_at
```

#### BusinessFAQ
Manager-defined FAQ entries for the business. Resolved into `SkillContext.businessKnowledge.faqs` at dispatch time.
```
id
business_id
question
answer
is_active
created_at
updated_at
```

---

## Part 3 — State Machines

### Booking State Machine

```
inquiry
  └─(slot selected + available)──────────────► requested
                                                   │
                                      (hold placed, timer set)
                                                   │
                                                   ▼
                                                 held ──(hold expires)──► expired
                                                   │
                              ┌────────────────────┤
                              │                    │
                   (payment not required)   (payment required)
                              │                    │
                              ▼                    ▼
                          confirmed         pending_payment
                              ▲                    │
                              │         (payment received)
                              └────────────────────┘
                                                   │
                                           (any state, authorized)
                                                   │
                                                   ▼
                                              cancelled
                                                   │
                                    (system error / unrecoverable)
                                                   │
                                                   ▼
                                                failed
```

**Transition rules:**
- `inquiry` → `requested`: requires specific slot, identity resolved, policy check passed
- `requested` → `held`: calendar hold placed atomically; if Calendar unavailable → fail to `failed`, do not advance
- `held` → `expired`: triggered by background job when `hold_expires_at` passes
- `held` → `confirmed`: requires explicit user confirmation message
- `held` → `pending_payment`: requires explicit user confirmation + service requires payment
- `pending_payment` → `confirmed`: requires payment webhook confirmation
- `pending_payment` → `cancelled`: payment timeout (configurable) or explicit cancellation
- `confirmed` → `cancelled`: authorized actor only; triggers Calendar event deletion
- `confirmed` → `held` (reschedule path): old event held pending new confirmation
- Any → `failed`: unrecoverable system error; always logged

**Idempotency rule:** A transition attempted on a booking already in the target state is a no-op, not an error.

### ConversationSession State Machine

```
active
  ├─(clarification needed)──► waiting_clarification ──(reply received)──► active
  ├─(action proposed)────────► waiting_confirmation ──(confirmed)────────► active
  │                                                   └─(rejected)────────► active
  ├─(intent completed)───────► completed
  ├─(unrecoverable)──────────► failed
  └─(inactivity timeout)─────► expired
```

Sessions are scoped to a single intent. A new message from the same identity after `completed`, `failed`, or `expired` starts a new session.

---

## Part 4 — Runtime Components

```
                    ┌─────────────────────────────────────────────────────┐
                    │               WHATSAPP ADAPTER                      │
                    │  Receives raw webhook · verifies HMAC signature     │
                    │  Normalizes to InboundMessage · deduplicates        │
                    └──────────────────────┬──────────────────────────────┘
                                           │ InboundMessage
                                           ▼
                    ┌─────────────────────────────────────────────────────┐
                    │               WEBHOOK ROUTER                        │
                    │  Branches on msg.toNumber                           │
                    └───────┬──────────────────────────────┬──────────────┘
                            │                              │
              (to = PROVIDER_WA_NUMBER)      (to = any business PA number)
                            │                              │
                            ▼                              ▼
          ┌─────────────────────────────┐  ┌──────────────────────────────────────┐
          │  PROVIDER ONBOARDING FLOW   │  │         IDENTITY RESOLVER            │
          │  (Step 0)                   │  │  Maps phone → Identity · role        │
          │                             │  └──────────────────┬───────────────────┘
          │  · 4-step conversation       │                     │
          │  · Collects: name, tz,       │                     ▼
          │    calendar, WABA creds      │  ┌──────────────────────────────────────┐
          │  · Validates creds via       │  │        CONVERSATION ROUTER           │
          │    Meta API                  │  │  Role + onboarding state → handler   │
          │  · Creates Business +        │  └────────┬──────────────┬──────────────┘
          │    Identity rows             │           │              │
          │  · Sends owner to PA number  │    (manager,      (manager,
          └─────────────────────────────┘   onboarding       onboarding
                                             incomplete)       complete)
                                                │                │
                                                ▼                ▼
                                  ┌──────────────────┐  ┌────────────────────────┐
                                  │ BUSINESS ONBOARD │  │  MANAGER INSTRUCTION   │
                                  │ FLOW (Steps 1–6) │  │  HANDLER               │
                                  │                  │  │                        │
                                  │ · Name display   │  │ · STATUS command       │
                                  │ · Services setup │  │ · LLM classification   │
                                  │ · Hours setup    │  │ · Ambiguity detection  │
                                  │ · Calendar OAuth │  │ · Apply instruction    │
                                  │ · CSV import     │  └────────────┬───────────┘
                                  │ · Verify         │               │
                                  └──────────────────┘               ▼
                                                       ┌──────────────────────────┐
                                         (customer)    │      BOOKING ENGINE      │
                                              │        │  · Slot validation       │
                                              ▼        │  · Conflict detection    │
                                  ┌───────────────────┐│  · Hold lifecycle        │
                                  │ CUSTOMER FLOW     ││  · State transitions     │
                                  │ HANDLER           ││  · Audit log             │
                                  │ · LLM extraction  │└──────────────┬───────────┘
                                  │ · Session context │               │
                                  │ · Booking flow    │               ▼
                                  └───────────────────┘  ┌───────────────────────┐
                                                          │   CALENDAR ADAPTER    │
                                                          │  · Availability check │
                                                          │  · Hold / confirm /   │
                                                          │    delete events      │
                                                          └───────────────────────┘
```

**Component boundaries — what each component must NOT do:**
- WhatsApp Adapter: no business logic, no LLM calls
- Identity Resolver: no booking or policy logic
- Conversation Router: no direct Calendar access
- Customer/Manager Handlers: no direct Calendar writes
- Booking Engine: no WhatsApp message construction
- Calendar Adapter: no booking state management

---

## Part 5 — Integration Contracts and Failure Handling

### WhatsApp (inbound)

Every inbound message is normalized to:
```
InboundMessage {
  message_id        # deduplication key
  from_number       # E.164
  to_number         # business number
  body              # raw text
  timestamp         # ISO 8601
  raw_payload       # original webhook body, stored
}
```

**Deduplication:** Message IDs are stored. A duplicate `message_id` is acknowledged (200 OK to WhatsApp) but not processed.

**Signature verification:** Webhook signature must be verified before any processing. Invalid signature → 401, no processing.

### WhatsApp (outbound)

All outbound messages go through a single send function. Failures are logged and retried up to a configurable limit. If delivery fails after retries, the booking is NOT rolled back — the system state is correct; a delivery failure alert is raised for operator attention.

### Google Calendar

All Calendar operations go through the Calendar Adapter. The adapter must:
- Return typed results: `Available | Occupied | Error(reason)`
- Never throw unhandled exceptions into the Booking Engine
- On `Error`: Booking Engine transitions booking to `failed`, logs the error, notifies user that the slot could not be confirmed due to a system issue

**Hold mechanism:** A hold is implemented as a Calendar event with a `HOLD` prefix and the `hold_expires_at` timestamp. On confirmation, the event is updated. On expiry, a background job deletes it. On Calendar API failure during hold placement, the booking does not advance past `requested`.

### LLM

All LLM calls use structured output (JSON schema enforced). The adapter must:
- Define the expected schema for each call type
- Validate the response against the schema before passing it downstream
- On invalid output: retry once, then fail the session with an explicit error
- Never pass raw LLM text directly into business logic

LLM call types in production (post-multi-agent upgrade):
- `extractCustomerIntent` → `{ intent, slot_request, service_type, raw_entities }` — Branch 4 only
- `classifyManagerInstruction` → `{ instruction_type, structured_params, ambiguous, clarification_needed }` — Branch 2 only (onboarding), and inside the `manageBusinessSettings` tool executor
- `runManagerOrchestratorLoop` — Branch 3 post-onboarding: Gemini native function-calling loop with 7 tools, MAX_ITERATIONS=5
- `answerOperatorQuestion` — Branch 1: data-augmented natural language answer with live business list
- `generateCustomerReply` — Branch 4: phrasing-only LLM call for transactional and conversational replies
- `generateOnboardingReply` / `parseOnboardingAnswer` / `explainOnboardingConcept` — Branch 2 onboarding steps

---

## Part 6 — Authorization Model

### Role Capabilities

| Action | customer | delegated_user | manager |
|---|---|---|---|
| Request booking | ✓ | ✓ | ✓ |
| Cancel own booking | ✓ | ✓ | ✓ |
| Cancel any booking | — | configurable | ✓ |
| Reschedule own booking | ✓ | ✓ | ✓ |
| Reschedule any booking | — | configurable | ✓ |
| View availability | ✓ | ✓ | ✓ |
| Set availability / hours | — | configurable | ✓ |
| Modify service types | — | — | ✓ |
| Manage permissions | — | — | ✓ |
| Change booking policy | — | — | ✓ |

`configurable` means the manager can grant or restrict that specific permission per delegated user.

### Authorization Check

Every action in the Booking Engine and Policy Engine calls `authorize(identity, action, resource)` before executing. This function:
1. Resolves the identity's role
2. Checks the capability table
3. For `delegated_user`: checks the specific permission grant
4. Returns `Allowed | Denied(reason)`

Denied actions are logged and return a clear message to the user.

---

## Part 7 — Conversation State and Session Design

Sessions are stored in the database, not in memory. This means:
- Multiple server instances can handle messages from the same user
- Sessions survive restarts
- Session state is auditable

**Session expiry:** Sessions expire after 30 minutes of inactivity (configurable). Expired sessions are soft-deleted. A new message from the same identity always creates a new session.

**Context accumulation:** As a multi-message flow progresses (e.g. "I want to book" → "what's available?" → "Tuesday at 3pm" → "confirm"), the session `context` field accumulates structured data. Each LLM call receives the current context plus the new message.

**Clarification handling:** When the system cannot proceed due to ambiguity, it sends a clarification request and sets session state to `waiting_clarification`. The next message from the same identity is interpreted as the answer to that clarification, not as a new intent.

---

## Part 8 — Business Onboarding Architecture

Onboarding is split into two phases served by two different WhatsApp numbers.

### Phase 0 — Provider onboarding (central provider number)

Handled exclusively on `PROVIDER_WA_NUMBER`. No business record exists yet.

The business owner texts the provider number once. A `ProviderOnboardingSession` row is created keyed to their personal phone number. A 4-step conversation collects:

| Step | Collected |
|---|---|
| `business_name` | Display name for the business |
| `timezone` | IANA timezone (plain-language input also accepted) |
| `calendar` | Google Calendar ID, or "skip" |
| `credentials` | WABA `phone_number_id` + `access_token` |

On receiving WABA credentials:
1. Credentials are validated live against the Meta Graph API (`GET /{phone_number_id}?fields=display_phone_number`)
2. The real phone number is fetched automatically — the owner does not type it
3. `Business` row created with `onboarding_step = 'business_name'`
4. `Identity` row created for the owner's personal phone with `role = 'manager'`
5. Owner receives: *"Your PA is ready at [PA number]. Text it from your personal WhatsApp to complete setup. You won't need this number again."*
6. `ProviderOnboardingSession.completed_at` is set

**The provider number is never used again after Step 0 completes.**

### Phase 1 — Business onboarding (PA number, Steps 1–6)

After Step 0, the business owner texts their PA number. All messages from the manager are intercepted by the business onboarding flow until `businesses.onboarding_completed_at` is set.

| Step | ID | What happens |
|---|---|---|
| 1 | `business_name` | Owner sets the display name customers will see |
| 2 | `services` | Owner lists services; parsed via LLM → `service_types` rows created |
| 3 | `hours` | Owner sets working hours; parsed via LLM → `availability` rows created |
| 4 | `calendar` | PA sends OAuth link; step advances when `/oauth/google/callback` fires; owner sees browser success page |
| 5 | `customer_import` | Optional CSV upload (contacts, booking history, service catalog) via one-time signed URL; "skip" advances immediately |
| 6 | `verify` | Any message marks `onboarding_completed_at`; PA confirms it is live |

Steps 2 and 3 route through the existing manager instruction classifier and apply pipeline — the same code path used for ongoing management. The only difference is the onboarding wrapper advances the step on success.

Step 4 is the only step that does not advance from a WhatsApp message — it advances from the OAuth callback HTTP call.

**After Step 6, normal operation resumes.** The manager's messages route to the standard manager instruction handler. The `STATUS` command is always available.

### Manual intervention during onboarding (manager)

The business owner retains full visibility of all PA conversations through **Meta Business Suite** (mobile app + browser at `business.facebook.com/inbox`). They can manually read and reply to customer messages there at any time, including during onboarding. The WhatsApp Business App for the PA number is not available once the number is on the Cloud API.

### Ongoing manager verification — STATUS command

At any point after onboarding, the manager can text `STATUS` to the PA number and receive an instant health report:
```
✅ PA is live
📅 Calendar: Connected
👥 Customers: 142
📋 Last confirmed booking: 23 Apr 2026, 14:30
🕐 Last message processed: 2 min ago
```
Subsystems with problems show ❌.

### Error alerts

If an unhandled error occurs while processing a customer message, the manager is immediately notified via WhatsApp with the customer's phone number and a brief error description.

---

## Part 9 — V1 Scope Boundaries

The following are explicitly **out of scope for V1** and must not be partially implemented:

- Payment processing (the `requires_payment` field exists in the schema for future use; in V1 all bookings behave as `requires_payment: false`)
- Multi-provider scheduling (provider_id exists but V1 treats the business as a single provider)
- Recurring bookings
- Customer-facing booking history
- Analytics or reporting
- Full web dashboard (two minimal browser touchpoints exist: the Google OAuth callback success page and the CSV import upload page — these are single-purpose screens, not a dashboard)
- Live CRM sync (HubSpot, Salesforce, etc.) — V1 supports one-time CSV import only
- Provisioning a new WhatsApp Business API number for a business — V1 requires the business to bring their own existing WABA number
- Inbound calls or media messages
- All skills listed in Part 15 (website builder, AEO optimizer, FAQ responder, campaigns, analytics, review collector, intake form, social content, upsell) — these are V2 scope built on the skills layer

When a customer requests an out-of-scope feature, the system responds that it is not available.

---

## Part 10 — Database Schema (V1, PostgreSQL)

`src/db/schema.ts` is the authoritative source of truth. This section mirrors it for reference — if there is ever a discrepancy, the Drizzle schema wins.

```sql
-- Businesses
CREATE TABLE businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  whatsapp_number TEXT NOT NULL UNIQUE,        -- PA number (E.164)
  whatsapp_phone_number_id TEXT,               -- Meta phone number ID (per-business)
  whatsapp_access_token TEXT,                  -- Meta system user token (per-business)
  google_calendar_id TEXT NOT NULL,
  google_refresh_token TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  min_booking_buffer_minutes INT NOT NULL DEFAULT 30,
  max_booking_days_ahead INT NOT NULL DEFAULT 365,
  cancellation_cutoff_minutes INT NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'ILS',
  bot_persona TEXT NOT NULL DEFAULT 'neutral' CHECK (bot_persona IN ('female','male','neutral')),
  brand_voice TEXT,                              -- free-text tone descriptor surfaced in SkillContext.businessKnowledge
  confirmation_gate TEXT NOT NULL DEFAULT 'immediate' CHECK (confirmation_gate IN ('immediate','post_payment')),
  payment_method TEXT,
  available_247 BOOLEAN NOT NULL DEFAULT TRUE,
  calendar_mode TEXT NOT NULL DEFAULT 'google' CHECK (calendar_mode IN ('google','internal')),
  paused BOOLEAN NOT NULL DEFAULT FALSE,
  default_language TEXT NOT NULL DEFAULT 'he' CHECK (default_language IN ('he','en')),
  escalation_rules JSONB NOT NULL DEFAULT '[]',  -- [{trigger, value?, threshold?, customerMessage, customText?}]
  onboarding_step TEXT,                          -- null when onboarding complete
  onboarding_completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Provider onboarding sessions (Step 0 — one row per business owner, lives on provider number)
CREATE TABLE provider_onboarding_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manager_phone TEXT NOT NULL UNIQUE,          -- owner's personal number (E.164)
  step TEXT NOT NULL DEFAULT 'business_name',
  collected_data JSONB NOT NULL DEFAULT '{}',
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Import tokens (one-time signed URLs for CSV data import during onboarding Step 5)
CREATE TABLE import_tokens (
  token UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  manager_phone TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Identities
CREATE TABLE identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  phone_number TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('manager', 'delegated_user', 'customer')),
  display_name TEXT,
  granted_by UUID REFERENCES identities(id),
  granted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  messaging_opt_out BOOLEAN NOT NULL DEFAULT FALSE,
  preferred_language TEXT CHECK (preferred_language IN ('he','en')),  -- null = use business default
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, phone_number)
);

-- Service types
CREATE TABLE service_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  name TEXT NOT NULL,
  duration_minutes INT NOT NULL,
  buffer_minutes INT NOT NULL DEFAULT 0,
  category TEXT,
  max_participants INT NOT NULL DEFAULT 1,
  requires_payment BOOLEAN NOT NULL DEFAULT FALSE,
  payment_amount NUMERIC(10,2),
  color_id INT,                                  -- Google Calendar colorId (1–11) or null for default
  intake_required BOOLEAN NOT NULL DEFAULT FALSE, -- if true, intake-form skill runs before booking confirms
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  deactivated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Provider assignments (which staff handle which service types)
CREATE TABLE provider_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  identity_id UUID NOT NULL REFERENCES identities(id),
  service_type_id UUID NOT NULL REFERENCES service_types(id),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (identity_id, service_type_id)
);

-- Availability rules
CREATE TABLE availability (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  provider_id UUID REFERENCES identities(id),
  day_of_week INT CHECK (day_of_week BETWEEN 0 AND 6),
  specific_date DATE,
  open_time TIME,
  close_time TIME,
  is_blocked BOOLEAN NOT NULL DEFAULT FALSE,
  reason TEXT,
  CONSTRAINT day_or_date CHECK (
    (day_of_week IS NOT NULL AND specific_date IS NULL) OR
    (day_of_week IS NULL AND specific_date IS NOT NULL)
  )
);

-- Bookings
CREATE TABLE bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  service_type_id UUID NOT NULL REFERENCES service_types(id),
  customer_id UUID NOT NULL REFERENCES identities(id),
  provider_id UUID REFERENCES identities(id),
  requested_at TIMESTAMPTZ NOT NULL,
  slot_start TIMESTAMPTZ NOT NULL,
  slot_end TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'inquiry','requested','held','pending_payment',
    'confirmed','cancelled','expired','failed'
  )),
  hold_expires_at TIMESTAMPTZ,
  calendar_event_id TEXT,
  payment_status TEXT NOT NULL DEFAULT 'not_required' CHECK (payment_status IN (
    'not_required','pending','paid','failed'
  )),
  cancellation_reason TEXT,
  cancelled_by_role TEXT CHECK (cancelled_by_role IN ('customer','manager','system')),
  slot_tz_at_creation TEXT,                      -- timezone at booking time (for display)
  rescheduled_from UUID REFERENCES bookings(id),
  rebooking_requested BOOLEAN NOT NULL DEFAULT FALSE,  -- set when manager bulk-cancels and agrees to help rebook
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Conversation sessions
CREATE TABLE conversation_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  identity_id UUID NOT NULL REFERENCES identities(id),
  intent TEXT CHECK (intent IN (
    'booking','rescheduling','cancellation','inquiry','list_bookings',
    'manager_instruction','unknown'
  )),
  state TEXT NOT NULL CHECK (state IN (
    'active','waiting_confirmation','waiting_clarification','waiting_language_confirmation',
    'completed','expired','failed'
  )),
  context JSONB NOT NULL DEFAULT '{}',
  last_message_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Manager instructions (raw ledger)
CREATE TABLE manager_instructions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  identity_id UUID NOT NULL REFERENCES identities(id),
  raw_message TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  classified_as TEXT CHECK (classified_as IN (
    'availability_change','policy_change','service_change',
    'permission_change','unknown'
  )),
  structured_output JSONB,
  applied_at TIMESTAMPTZ,
  apply_status TEXT NOT NULL DEFAULT 'pending' CHECK (apply_status IN (
    'pending','applied','failed','requires_clarification'
  )),
  clarification_request TEXT
);

-- Audit log
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  actor_id UUID REFERENCES identities(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  before_state JSONB,
  after_state JSONB,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Customer profiles (enriched summary per customer per business)
CREATE TABLE customer_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  identity_id UUID NOT NULL UNIQUE REFERENCES identities(id),
  display_name TEXT,
  preferred_service_type_id UUID REFERENCES service_types(id),
  last_booking_id UUID,
  last_booking_at TIMESTAMPTZ,
  total_bookings INT NOT NULL DEFAULT 0,
  notes TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Conversation messages (per-session message log)
CREATE TABLE conversation_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES conversation_sessions(id),
  role TEXT NOT NULL CHECK (role IN ('customer','assistant')),
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reminders (sent before/after bookings)
CREATE TABLE reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id UUID NOT NULL REFERENCES bookings(id),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('24h','1h','confirmation','cancellation')),
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (booking_id, trigger_type)
);

-- Waitlist
CREATE TABLE waitlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  service_type_id UUID NOT NULL REFERENCES service_types(id),
  slot_start TIMESTAMPTZ NOT NULL,
  slot_end TIMESTAMPTZ NOT NULL,
  customer_id UUID NOT NULL REFERENCES identities(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','offered','accepted','expired')),
  offered_at TIMESTAMPTZ,
  offer_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, slot_start, customer_id)
);

-- Deduplication table for inbound WhatsApp messages
CREATE TABLE processed_messages (
  message_id TEXT PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id),
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tasks escalated to the operator when a customer asks something no PA handles
CREATE TABLE escalated_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  customer_phone TEXT NOT NULL,
  message_body TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  escalation_type TEXT NOT NULL CHECK (escalation_type IN ('platform','owner_rule')),
  trigger_rule TEXT,
  forwarded_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Business FAQ entries (surfaced in SkillContext.businessKnowledge.faqs)
CREATE TABLE business_faqs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Skill workflow state (durable multi-step operations spanning multiple sessions)
CREATE TABLE skill_workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  identity_id UUID NOT NULL REFERENCES identities(id),
  skill_name TEXT NOT NULL,
  step TEXT NOT NULL,
  state JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('active','paused','completed','failed')),
  version INT NOT NULL DEFAULT 1,              -- optimistic locking: increment on every write
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (identity_id, skill_name, status) -- enforced at app level: only one active per identity per skill
);

-- Per-step audit trail for workflow debugging and replay
CREATE TABLE workflow_step_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL REFERENCES skill_workflows(id),
  step_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SUCCESS','RETRYABLE','FATAL','PAUSED')),
  input_snapshot JSONB,                        -- capped at ~10KB; large payloads stored as summary
  output_snapshot JSONB,
  latency_ms INT,
  retry_count INT NOT NULL DEFAULT 0,
  error_context JSONB,                         -- {code, message, recoverable} on failure
  tokens_used INT,                             -- LLM token count for cost tracking, null if no LLM call
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Log of operator-triggered bulk updates pushed to all agents
CREATE TABLE agent_update_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  update_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  applied_to_count INT NOT NULL DEFAULT 0
);

-- Cross-session manager memory (Branch 3 orchestrator — added post-V1)
CREATE TABLE manager_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  identity_id UUID NOT NULL REFERENCES identities(id),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX manager_memory_identity_idx ON manager_memory(identity_id, created_at);

-- Non-customer business contacts directory (Contact sub-agent tool — added post-V1)
CREATE TABLE business_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  name TEXT NOT NULL,
  phone_number TEXT,
  role TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX business_contacts_business_idx ON business_contacts(business_id);

-- Cross-session operator memory summaries (Branch 1 upgrade — added post-V1)
CREATE TABLE operator_session_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  summary TEXT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_bookings_business_state ON bookings(business_id, state);
CREATE INDEX idx_bookings_slot ON bookings(business_id, slot_start, slot_end);
CREATE INDEX idx_bookings_hold_expires ON bookings(hold_expires_at) WHERE state = 'held';
CREATE INDEX idx_sessions_identity ON conversation_sessions(identity_id, state);
CREATE INDEX idx_messages_session ON conversation_messages(session_id, created_at);
CREATE INDEX idx_provider_assignments_business ON provider_assignments(business_id, is_active);
CREATE INDEX idx_waitlist_status ON waitlist(business_id, status);
CREATE INDEX idx_escalated_tasks_business ON escalated_tasks(business_id, resolved_at);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
```

---

## Part 11 — Recommended Tech Stack

| Concern | Choice | Reason |
|---|---|---|
| Runtime | Node.js + TypeScript | WhatsApp SDKs mature, async I/O fits messaging workload |
| Framework | Fastify | Low overhead, good TypeScript support |
| Database | PostgreSQL | Transactions for booking atomicity, JSONB for context/audit |
| ORM | Drizzle | Type-safe, close to SQL, no magic |
| Job queue | BullMQ (Redis) | Hold expiry, retries, outbound message queue |
| WhatsApp | WhatsApp Cloud API (Meta) | Official, no third-party middleware |
| Calendar | Google Calendar API v3 | Direct, no abstraction layer needed |
| LLM | Gemini 2.0 Flash via Vertex AI | GCP-native, ADC auth (no API key), reliable JSON output |
| Auth | Internal role table | No OAuth for V1; phone number is identity |
| Hosting | GCP Cloud Run (min-instances=1, private VPC) | Always-on for BullMQ workers, managed scaling, native GCP integration |
| Database hosting | Cloud SQL (PostgreSQL 16) | Managed, private IP via VPC, point-in-time recovery |
| Redis hosting | Memorystore (Redis 7) | Managed, private IP via VPC, no ops overhead |
| Container registry | Artifact Registry | GCP-native, integrated with Cloud Build and Cloud Run |
| Secrets | Secret Manager | Centralized rotation, audit trail, mounted as env vars |
| CI/CD | Cloud Build | Native GCP integration, trigger on main branch push |
| Testing | Vitest | Fast, TypeScript-native |

---

## Part 12 — Risk Points

| Risk | Severity | Mitigation |
|---|---|---|
| Calendar API down during booking | High | Fail booking to `failed` state, never assume success, alert operator |
| WhatsApp delivery failure after confirmation | Medium | Log, retry queue, do not roll back booking state |
| LLM returns invalid structured output | Medium | Schema validation, one retry, fail session with user-facing error |
| Double booking under concurrency | High | DB-level transaction with row lock on slot range at `held` transition |
| Hold never expires (job failure) | Medium | Hold expiry job with dead-letter queue; bookings stuck in `held` are detectable and alertable |
| Manager sends ambiguous instruction applied silently | High | Ambiguity detection mandatory before apply; `requires_clarification` path blocks application |
| Identity spoofing via phone number | Medium | In V1 phone number is trust anchor; WhatsApp webhook signature verification required |
| Session context grows unbounded | Low | Max context size enforced; oldest entries pruned if exceeded |

---

## Part 13 — Implementation Milestones

**All milestones through M8 are complete and live in v1.0.0.**

**M1 — Foundation** ✅
- Database schema applied and migrated
- Identity resolution logic + role table
- WhatsApp webhook receiver (signature verification + deduplication)
- InboundMessage normalization
- ConversationSession create/load/expire
- Audit log writer

**M2 — Booking engine** ✅
- ServiceType CRUD (manager-only)
- Availability rule CRUD (manager-only)
- Booking state machine (all transitions, tested in isolation)
- Authorization check function
- Availability query against internal rules

**M3 — Calendar integration** ✅
- Calendar Adapter with typed result model
- Hold placement and release
- Event confirmation and deletion
- Failure handling for all Calendar error cases
- Booking engine wired to Calendar Adapter

**M4 — WhatsApp message flows** ✅
- LLM adapter with schema validation
- Customer intent extraction
- Booking flow end-to-end (inquiry → held → confirmed)
- Cancellation flow
- Clarification loop

**M5 — Manager instruction handling** ✅
- Manager instruction handler
- LLM classification
- Ambiguity detection and clarification path
- Apply to availability, policy, service types
- Raw message ledger

**M6 — Hardening** ✅
- Hold expiry background job
- Retry queues for outbound messages
- End-to-end integration tests for all core flows
- Failure scenario tests (Calendar down, LLM invalid output, duplicate message)

**M7 — Business onboarding** ✅
- Provider number (Step 0): 4-step WhatsApp conversation, WABA credential validation via Meta API, automatic phone number fetch, Business + Identity provisioning
- Business onboarding (Steps 1–6): guided WhatsApp flow for name, services, hours, Calendar OAuth, optional CSV import, verification
- `npm run provision` CLI as fallback for direct provisioning
- STATUS command (on-demand PA health report)
- Error alerts pushed to manager on unhandled failures
- Per-business WhatsApp credentials (overrides global env vars)

**M8 — v1.0.0 Production Feature Set** ✅
- Escalation engine (platform escalations + owner-defined trigger rules)
- Business hours gate (PA pauses outside configured hours)
- i18n: Hebrew and English, per-customer language preference, bot persona
- Provider/staff assignments (which staff handle which service types)
- Reminder worker (24h + 1h pre-booking reminders, confirmation and cancellation notices)
- Queued messages worker (deferred outbound delivery with retry)
- Waitlist engine
- Conversation message log (`conversation_messages` table)
- Customer profiles (`customer_profiles` table)
- GCP Cloud Run deployment with Cloud Build CI/CD pipeline

**M9 — Skills Layer Foundation** ✅
- `src/shared/skill-types.ts` — typed contract (`SkillContext`, `SkillOutcome`, `Skill`)
- `src/skills/index.ts` — registry + `dispatchSkill()`
- ESLint import boundary enforcement
- GitHub Actions CI (tsc + lint + vitest on every PR)
- CODEOWNERS enforcing Developer A / Developer B split
- `website-builder` skill skeleton

**Next: First business provisioning, then skills infrastructure (M10), then first production skill.**

---

## Part 14 — Skills Layer

### What Skills Are

Skills are self-contained feature modules that extend the PA's capabilities beyond the V1 booking core. Where the core handles booking, scheduling, and calendar management deterministically, skills handle open-ended or feature-rich conversations that require their own logic, LLM calls, and multi-turn state.

Skills are built by Developer B and live exclusively in `src/skills/`. Developer A owns the interface contract they implement. Neither party may change `src/shared/skill-types.ts` without the other's review.

### Runtime Position

Skills are dispatched at the entry point of the Customer Flow Handler, before LLM intent extraction. The sequence for every inbound customer message is:

1. Identity resolution (standard)
2. Business knowledge resolution — `businessKnowledge` fields loaded from DB and added to context
3. Active workflow lookup — if a `skill_workflows` row with `status = 'active'` exists for this identity, `workflowState` is added to context
4. **`dispatchSkill(ctx)`** — each registered skill's `canHandle(ctx)` is evaluated in order. If any returns `true`, that skill handles the message entirely. The standard pipeline does not run.
5. If no skill claims the message → LLM intent extraction → booking engine (standard)

Skills are first-class handlers, not a fallback path. A skill that claims a message owns it completely — including any LLM calls, state management, and reply construction.

### Two Skill Types

**Simple Skills** handle a single intent within a session. They are stateless beyond the `conversationHistory` passed in `SkillContext`. `sessionComplete: true` is returned when done.

**Workflow Skills** handle multi-step operations that span multiple sessions and potentially days (e.g. building a website). They use the `skill_workflows` table as their durable state store. On each incoming message:
- `canHandle` returns `true` if the message matches the skill's trigger OR if `ctx.workflowState?.skillName === this.name` (active workflow resumes)
- `handle` loads the current step from `workflowState`, executes the step's logic, advances or completes the workflow, and persists the new state to `skill_workflows`
- Each step is deterministic TypeScript code. LLM calls happen *within* steps (for interpretation or content generation), never *between* steps (for routing or sequencing)
- If a step fails, the workflow remains at that step and resumes on the next message
- Only one active workflow per identity per skill at a time

The booking engine is not a skill and is never replaced by a skill. Skills that need booking data read it from `SkillContext`. Skills must never directly trigger bookings — if a skill requires booking initiation as part of its flow, Developer A must provide a typed callback in `SkillContext`.

### The Contract

Defined in `src/shared/skill-types.ts`.

#### StepResult — what a Workflow Skill returns per step internally

```ts
type StepStatus = 'SUCCESS' | 'RETRYABLE' | 'FATAL' | 'PAUSED'

interface StepResult {
  status: StepStatus
  retryCount?: number
  errorContext?: { code: string; message: string; recoverable: boolean }
}
```

- `SUCCESS` — step completed; advance to next step
- `RETRYABLE` — transient external failure; retry up to 3× with exponential backoff; surface to user as "still working on it"
- `FATAL` — unrecoverable; mark workflow `failed`, store error in `state.error`, notify manager
- `PAUSED` — awaiting user input; workflow stays at current step until next message

This is an internal type used within Workflow Skill step logic. It does not appear in `SkillOutcome`.

#### SkillContext — what every skill receives

| Field | Type | Contents |
|---|---|---|
| `business.id` | `string` | Business UUID |
| `business.name` | `string` | Display name |
| `business.timezone` | `string` | IANA timezone |
| `business.defaultLanguage` | `'he' \| 'en'` | Fallback language |
| `business.botPersona` | `'female' \| 'male' \| 'neutral'` | Reply tone |
| `business.currency` | `string` | e.g. `'ILS'` |
| `caller.id` | `string` | Identity UUID |
| `caller.phoneNumber` | `string` | E.164 |
| `caller.role` | `'manager' \| 'delegated_user' \| 'customer'` | Authorization reference |
| `caller.displayName` | `string \| null` | |
| `caller.preferredLanguage` | `'he' \| 'en' \| null` | null = use business default |
| `message.text` | `string` | Raw inbound message text |
| `message.receivedAt` | `Date` | |
| `conversationHistory` | `SkillConversationTurn[]` | Last N turns `[{role, text}]` |
| `language` | `'he' \| 'en'` | Pre-resolved reply language — skills always use this field |
| `sessionId` | `string` | Current session UUID |
| `businessKnowledge.services` | `ServiceSummary[]` | Active service types: name, duration, price |
| `businessKnowledge.policies` | `PolicySummary` | Booking policy fields (buffer, cutoff, max days ahead) |
| `businessKnowledge.faqs` | `FAQ[]` | Manager-defined FAQ entries from `business_faqs` |
| `businessKnowledge.brandVoice` | `string \| null` | Free-text brand voice from `businesses.brand_voice` |
| `workflowState` | `WorkflowState \| null` | Active `skill_workflows` row for this identity, or null |
| `workflow.advance` | `(step, state) => Promise<void>` | Present only when `workflowState` is non-null. Advances step with optimistic lock. |
| `workflow.complete` | `() => Promise<void>` | Marks workflow `completed`. |
| `workflow.fail` | `(error) => Promise<void>` | Marks workflow `failed`, stores error, notifies manager. |
| `workflow.create` | `(skillName, firstStep) => Promise<WorkflowState>` | Creates a new workflow row. Present only when `workflowState` is null. |
| `recentCompletedBooking` | `CompletedBookingSummary \| null` | Most recently completed booking for this identity (needed by review-collector) |
| `customerSegmentQuery` | `(filter) => Promise<CustomerSummary[]>` | Manager-only: returns customers matching a segment filter (needed by campaign-sender) |

Skills receive a sanitized bundle. No DB handles, no access tokens, no internal engine state. Workflow callbacks (`workflow.*`) are implemented by the core and injected at dispatch time — skills call them without importing anything from `src/domain/`.

#### SkillOutcome — what every skill must return

```ts
// Skill handled the message:
{ handled: true;  reply: string; sessionComplete: boolean; skillName: string }

// Skill does not handle this message — pass through:
{ handled: false; skillName: string }
```

The core engine reads `handled`. If `true`, the reply is sent and the session is updated per `sessionComplete`. If `false`, the next registered skill is tried, then the standard pipeline runs.

### Import Boundary

Files under `src/skills/**` may only import from `src/shared/`. Importing from `src/domain/`, `src/adapters/`, `src/db/`, `src/workers/`, or `src/routes/` is a lint error that blocks CI.

Skills interact with the outside world through two mechanisms only:
1. The `SkillContext` bundle provided by the core engine
2. Direct external HTTP calls to third-party APIs within the skill

If a skill needs data not in `SkillContext`, the correct path is to extend `src/shared/skill-types.ts` (requires Developer A's review) — not to import from core.

### Skill Registry

Skills call `registerSkill(skill)` from `src/skills/index.ts`. The core engine calls `dispatchSkill(ctx)` once per inbound customer message. Skills are evaluated in registration order — first match wins.

### Component Boundary Additions (extends Part 4)

- **Skills:** no DB access, no Calendar access, no WhatsApp send, no LLM client from `src/adapters/`
- **Workflow Skills:** read/write `skill_workflows` table exclusively through a typed helper provided by Developer A — never raw DB queries
- **Core Customer Flow Handler:** calls `dispatchSkill` before LLM extraction; treats `SkillOutcome` as opaque — never inspects skill internals
- **Booking engine:** not a skill, not callable by skills — remains fully deterministic and unchanged

---

## Part 15 — Skills Roadmap (V2)

### Architecture note

All PA capabilities beyond the V1 booking core are implemented as **skills** — not as separate LLM agents. There is no Operations Agent, no Scheduling Agent, no Knowledge Agent as distinct processes. The existing system IS the orchestrator. Business knowledge is resolved from the DB at dispatch time and passed in `SkillContext.businessKnowledge`. Complex multi-step operations are implemented as Workflow Skills with deterministic step sequences.

### Infrastructure prerequisites (Developer A, lands before any V2 skill)

| Item | What it is |
|---|---|
| `businessKnowledge` in SkillContext | Resolved at dispatch time: services, policies, FAQs, brand voice |
| `workflowState` in SkillContext | Active `skill_workflows` row for the identity, or null |
| `skill_workflows` table | Durable state store for Workflow Skills |
| Workflow helper | Typed `loadWorkflow` / `saveWorkflow` / `advanceWorkflow` functions exposed to skills via `src/shared/` |

### Simple Skills

| Skill | Caller | Description |
|---|---|---|
| `faq-responder` | Customer | Answers questions about services, prices, policies, hours using `businessKnowledge` |
| `business-analytics` | Manager | Booking counts, revenue, top customers, busiest periods — formatted summary from DB data |
| `review-collector` | System / Manager | Post-appointment Google review request; manager can also trigger manually |
| `campaign-sender` | Manager | WhatsApp broadcast to a customer segment; LLM drafts, manager confirms before send |
| `intake-form` | Customer | Pre-appointment questions defined per service type; answers stored for manager |
| `upsell-assistant` | Customer | Suggests complementary service after booking confirmation |

### Workflow Skills

| Skill | Description |
|---|---|
| `website-builder` | E2E website creation: requirements → structure confirmation → content generation → AEO pass → manager review → domain registration → deployment → handoff |
| `aeo-optimizer` | Standalone AEO pass against an existing site URL; produces structured improvement report and optionally applies changes to PA-deployed sites |
| `social-content-generator` | Multi-turn content creation for social posts; output is text for manager to copy — no posting API in V1 of this skill |

### Build order

| Priority | Skill | Type | Dependency |
|---|---|---|---|
| 1 | `faq-responder` | Simple | `businessKnowledge` in SkillContext |
| 2 | `business-analytics` | Simple | SkillContext segment extension (Developer A) |
| 3 | `website-builder` | Workflow | Full infra prereqs + external APIs (domain registrar, hosting) |
| 4 | `aeo-optimizer` | Simple/Workflow | Shares AEO logic with `website-builder` Step 4 |
| 5 | `review-collector` | Simple | `recentCompletedBooking` SkillContext extension |
| 6 | `campaign-sender` | Simple | Customer segment query extension |
| 7 | `intake-form` | Simple | `intake_required` flag on service_types schema |
| 8 | `social-content-generator` | Workflow | None beyond base infra |
| 9 | `upsell-assistant` | Simple | Booking event hook from Developer A |

---

---

## Part 16 — Conversational Interface Architecture (The Four Chat Branches)

Every inbound WhatsApp message in this system belongs to exactly one of four chat branches. Each branch has a distinct audience, LLM interaction model, and quality contract. This separation is architectural — not stylistic. Any session working on LLM behaviour, reply quality, or conversational experience must understand which branch it is operating in.

### The Four Branches

```
PROVIDER_WA_NUMBER ──┬── sender = OPERATOR_PHONE  ──► Branch 1: Operator Channel
                     └── sender ≠ OPERATOR_PHONE  ──► Branch 2: MiddleMan Onboarding

ANY PA NUMBER ───────┬── identity.role = 'manager' ─► Branch 3: PA Manager Channel
                     └── identity.role ≠ 'manager' ─► Branch 4: PA Customer Channel
```

---

### Branch 1 — Operator Channel (MiddleMan → Platform Operator)

**Audience:** The platform operator (us) only. One person, full system trust.

**Entry point:** `src/domain/flows/operator.ts → handleOperatorMessage()`

**Session model:** **True multi-turn session memory.** The operator's conversation with MiddleMan must maintain context across messages within a session window. References to "they", "that business", "the one we just discussed" must resolve correctly. The LLM receives the full session transcript and must reason over it.

**LLM interaction model:**
- Keyword / regex matching first (zero-latency commands: STATUS, ESCALATIONS, UPDATE ALL, etc.)
- LLM classification (`classifyOperatorMessage`) as fallback for ambiguous or freeform input
- LLM free-form conversation (`general_qa`) for anything that isn't a command — with full transcript context

**Quality contract:** The operator can ask anything about the platform state, discuss a specific business across multiple turns, issue bulk instructions, and get intelligent conversational responses. The experience is closer to an admin assistant than a command line.

**What the LLM must NOT do:** Mutate state. All state changes still go through the deterministic pipeline. The LLM can reason, explain, and discuss — it cannot apply instructions without the apply pipeline.

---

### Branch 2 — MiddleMan Onboarding Channel (MiddleMan → New Business Owner, Step 0)

**Audience:** A new business owner going through their first contact with the platform. They may not know technical concepts (WhatsApp Business API, phone_number_id, access_token, Meta Business Suite).

**Entry point:** `src/domain/flows/provider-onboarding.ts → handleProviderOnboarding()`

**Session model:** Stateful step machine (`ProviderOnboardingSession`). Steps are sequential and must complete in order.

**LLM interaction model:**
- Onboarding question generation: `generateOnboardingReply()` — LLM phrases each step's ask conversationally
- **Explanation mode:** When the current input reads as a question or expression of confusion (not an answer to the active step), the LLM must explain the concept being asked about (e.g. "what's a phone_number_id?", "where do I find my access token?", "what's a WhatsApp Business Account?"), then re-ask the step. Re-ask only when the person shows clear signs of understanding or provides a valid answer.
- Parsing: regex for credentials, `classifyManagerInstruction` for services

**Quality contract:** No business owner should ever be stuck because they didn't understand a technical term. The system must explain — clearly, in plain language — any concept it asks for. Explanations are not static strings; they are LLM-generated and contextual.

**What the LLM must NOT do:** Accept a question as an answer to the current step. If the input is clearly a question or confusion, enter explanation mode — do not try to parse it as step data.

---

### Branch 3 — PA Manager Channel (PA → Business Owner, post-provisioning)

**Audience:** The business owner managing their PA. They are trusted (role = `manager`) and operationally sophisticated, but they speak in natural language, not structured commands.

**Entry point:** `src/domain/flows/manager-onboarding.ts` (during onboarding) → after onboarding: `routeManagerMessage()` in `src/routes/webhook.ts`

**Session model:** Full multi-turn session with 4-hour expiry (`conversationSessions` table). The orchestrator receives the last 20 conversation turns plus up to 3 cross-session memory summaries from the `manager_memory` table.

**LLM interaction model — Gemini native function-calling orchestrator:**

The old `classifyManagerInstruction → applyInstruction → generateManagerReply` pipeline has been replaced with a native Gemini function-calling loop (`src/adapters/llm/orchestrator.ts`).

```
WhatsApp webhook
  → identity check → session hydration
  → dispatchSkill()   ← skills run first; if a skill claims it, orchestrator is skipped
  → runManagerOrchestratorLoop()
      ├─ LLM receives: message + history (last 20) + manager memory summaries + available tools
      ├─ LLM calls tool(s) in sequence (MAX_ITERATIONS = 5)
      │     tool results returned to LLM, loop continues
      └─ LLM produces final reply text → sendMessage
```

**Available tools (Branch 3 only):**

| Tool | Level | Pipeline involvement |
|------|-------|---------------------|
| `listCalendarEvents` | 0 — read-only | None |
| `searchWeb` | 0 — external API | None |
| `lookupCustomer` | 0 — read-only | None |
| `saveContactNote` | 1 — metadata write | Identity check (flow entry) |
| `createCalendarEvent` | 2 — calendar write | Booking conflict check |
| `deleteCalendarEvent` | 2 — calendar write | Customer booking guard |
| `manageBusinessSettings` | 3 — config change | `classifyManagerInstruction → applyInstruction` |

**Key invariant:** `applyInstruction` is still the only function that writes business configuration (hours, services, policies, staff permissions, booking cancellations). It lives inside the `manageBusinessSettings` tool executor — the LLM cannot bypass it.

**Cross-session memory:** After each manager session expires, a BullMQ job (`generate-manager-summary` worker) generates a 2–3 sentence summary and writes it to the `manager_memory` table. The orchestrator injects the last 3 summaries into its system prompt.

**Proactive behavior:** After completing an action with customer-facing effects, the orchestrator ends its reply with a brief offer to notify affected customers. It never sends messages to customers autonomously — manager confirmation is required.

**WhatsApp formatting:** All formatting rules are defined in `CHAT_LEVEL_LAWBOOK.md`. The orchestrator system prompt enforces: no HTML, `*bold*` only, URLs on own line, reply entirely in the manager's language.

**Quality contract:** A manager can use natural language for everything — commands, questions, and calendar operations. The deterministic apply pipeline is enforced for all configuration changes.

**What the LLM must NOT do:** Bypass `manageBusinessSettings` for configuration changes. Notify customers without explicit manager confirmation. Produce HTML or markdown beyond `*bold*`.

---

### Branch 4 — PA Customer Channel (PA → End Customer)

**Audience:** Members of the public contacting a business to book, reschedule, cancel, or ask questions.

**Entry point:** `src/domain/flows/customer-booking.ts → handleBookingFlow()`

**Session model:** `ConversationSession` in DB. Full transcript stored in `conversation_messages`. The LLM receives the last N turns.

**LLM interaction model — the split:**

This branch uses a strict two-layer model:

**Layer A — Transactional replies** (booking, cancellation, reschedule, hold confirmation, slot unavailability, listing bookings):
- The deterministic state machine runs first and produces a factual `situation` string describing exactly what happened.
- The LLM's job is **phrasing only** — it takes the situation and produces a natural reply. It does not reason about availability, policy, or booking state.
- Situation strings must never contain internal implementation language (error codes, field names, engine reasons). They must be customer-facing descriptions.

**Layer B — Conversational replies** (unknown intents, FAQ answers, first-message welcome for new customers, meta-questions about the business, explanations, follow-ups):
- The LLM reasons freely over the full session transcript + business knowledge (FAQs, services, policies, brand voice).
- There is no situation string — the LLM receives the raw message and context and generates a response.
- The LLM may ask clarifying questions, make suggestions, or answer questions about the business.

**Quality contract:** Transactional replies are always factually correct (guaranteed by the deterministic core). Conversational replies are contextually intelligent (handled by the LLM with full context). The customer never receives a reply that exposes internal system state or error language. A new customer's first message always receives a warm, oriented welcome.

**What the LLM must NOT do in Layer A:** Make any claim about availability, booking state, or policy beyond what the `situation` string provides. **What the LLM must NOT do in Layer B:** Make any transactional claim (confirm, cancel, check availability) — if a conversational turn leads to a transactional intent, it re-enters the standard intent-extraction pipeline.

**Owner escalation for unfulfillable requests (P3):** When a customer asks for an arrangement the catalog can't express — a *private* version of a group class, a *group* booking beyond a 1-on-1 service's capacity, or an explicitly *out-of-hours* session — the PA does not dead-end with a rejection. The extractor flags the request *shape* (`specialArrangementRequest`); the deterministic core confirms it's genuinely unfulfillable (party-size > capacity, or out-of-hours insistence); only then does `escalateUnfulfillableRequest` (`src/domain/escalation/engine.ts`) notify the business owner (via the `escalation.unfulfillable` initiator → `escalatedTasks`) and tell the customer it's been passed on. Fires at most **once per session** (`specialRequestEscalated` guard). LLM stays interpretive; the core decides.

**Restore-after-cancel (P4):** A successful cancellation records a snapshot of the cancelled slot on `customer_profiles` (`lastCancelledBooking` + `lastCancelledAt`) — durable across the session boundary, since the cancel session is completed and a fresh session handles the follow-up. When the customer asks to undo it ("give me back the class we cancelled" → extractor `restorePrevious`), the dispatch re-offers the **exact** cancelled slot through the normal booking gate (re-validating availability and asking to confirm) within a freshness window (`LAST_CANCEL_RESTORE_WINDOW_MINUTES`, default 120). The pure `buildRestoreDraft` gates staleness / past-slot / removed-service.

---

### Locked design decisions (applicable across branches)

#### First-message welcome (Branch 4)

When a customer sends their **first message** in a session:
- **Targeted intent** (e.g. "book a haircut for Tuesday at 3pm"): do not interrupt with a welcome. The reply must include a natural greeting before getting to the point ("Hi! Let me check that for you…"), then proceed immediately with the response.
- **Generic or ambiguous first message** (e.g. "hi", "hello", "I need help", "מה שעות הפתיחה?"): send a warm welcome message introducing the PA and the business, then ask a single clarifying question.

The distinction is made by intent extraction. A resolved booking/cancellation/rescheduling/list-bookings intent → targeted. `unknown` or `inquiry` without a specific question → generic.

#### Session memory and expiry by branch

All branches that require conversational memory use the same `ConversationSession` infrastructure and `conversation_messages` log. Session expiry is branch-specific:

| Branch | Expiry | Rationale |
|---|---|---|
| 1 — Operator | 24 hours from last message | Operator works across a full day; context must survive breaks |
| 2 — MM Onboarding | Step-scoped (no session; `ProviderOnboardingSession` drives state) | Linear flow, no free-form memory needed |
| 3 — PA Manager | 4 hours from last message | Non-continuous interaction pattern; commands within a work window should share context |
| 4 — PA Customer | 30 minutes from last message | Active booking flows are short; stale context causes confusion |

#### Situation string sanitisation (Branch 4 — Layer A)

All booking engine reasons and system error codes must be mapped to human-readable, customer-safe descriptions **before** they are passed to the LLM as `situation` strings. Engine codes (`past_slot`, `outside_hours`, `calendar_error`, `policy_violation`, etc.) are never passed raw. A mapping table lives in the customer flow handler. The LLM never sees an internal identifier.

#### Language detection and switch UX (Branches 3 and 4)

When an incoming message is in a **different language than the session's current language**:
1. The PA replies **entirely in the detected language** — no interruption, no bilingual offer, no state change yet.
2. At the **end of that reply**, the PA adds a brief inline question asking whether the user wants to continue in the new language (e.g. "Want me to continue in English going forward?").
3. If the user confirms → the language preference is persisted on the `identities` row as `preferredLanguage`, and all subsequent session replies use the new language.
4. If the user declines → the language reverts to the session default on the next turn.
5. If the user ignores the question and continues in the new language → the question is asked again at the end of the next reply (maximum once per turn, not every turn).

This replaces the current bilingual-offer mechanism entirely. The current `waiting_language_confirmation` session state and `bufferedMessage` context field are superseded by this inline approach.

---

### Cross-branch invariants

These apply to all four branches:

1. **The LLM never directly mutates state.** In every branch, state changes go through the deterministic pipeline. The LLM proposes, informs, and phrases — it never applies.
2. **Situation strings passed to the LLM must be customer/operator-safe.** No internal field names, error codes, or engine messages.
3. **Language — and Hebrew addressee gender — are always resolved before the LLM is called.** The branch resolves the reply language; the LLM enforces it strictly. Hebrew **addressee gender** (how the PA addresses the person in the 2nd person — masculine/feminine/unknown) is a sibling of language: resolved pre-LLM by `resolveAddresseeGender` and threaded into the single voice chokepoint `buildVoiceCore(channel, addresseeGender)`, never decided while the model writes. Unknown → masculine floor; never split-gender. This is orthogonal to `botPersona` (the PA's self-voice). See `CHAT_LEVEL_LAWBOOK.md §3.5`.
4. **Every LLM call has a defined fallback.** Schema validation failures and API errors always fall back gracefully — never to a blank reply or an exposed error.

---

*This document reflects the implemented system. Changes to scope or architecture require explicit decision and a version bump.*
