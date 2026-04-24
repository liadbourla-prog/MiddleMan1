# PA_4_Business — System Architecture
**Status: Active — updated to reflect implemented system.**
**Last updated: 2026-04-23**

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
When sources conflict, this ordering is authoritative:

| Source | Truth domain |
|---|---|
| Google Calendar | Schedule reality (what is actually occupied) |
| Internal system | Policy, permissions, booking state |
| WhatsApp | Interface only — never source of truth |
| State machine definitions | Valid transitions |
| This document | Design intent |

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

LLM call types in V1:
- `extract_customer_intent` → `{ intent, slot_request, service_type, raw_entities }`
- `classify_manager_instruction` → `{ instruction_type, structured_params, ambiguous, clarification_needed }`

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

When a customer requests an out-of-scope feature, the system responds that it is not available.

---

## Part 10 — Database Schema (V1, PostgreSQL)

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
  bot_persona TEXT NOT NULL DEFAULT 'neutral',
  onboarding_step TEXT,                        -- null when onboarding complete
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
  requires_payment BOOLEAN NOT NULL DEFAULT FALSE,
  payment_amount NUMERIC(10,2),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  rescheduled_from UUID REFERENCES bookings(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Conversation sessions
CREATE TABLE conversation_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  identity_id UUID NOT NULL REFERENCES identities(id),
  intent TEXT CHECK (intent IN (
    'booking','rescheduling','cancellation','inquiry',
    'manager_instruction','unknown'
  )),
  state TEXT NOT NULL CHECK (state IN (
    'active','waiting_confirmation','waiting_clarification',
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

-- Deduplication table for inbound WhatsApp messages
CREATE TABLE processed_messages (
  message_id TEXT PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id),
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_bookings_business_state ON bookings(business_id, state);
CREATE INDEX idx_bookings_slot ON bookings(business_id, slot_start, slot_end);
CREATE INDEX idx_bookings_hold_expires ON bookings(hold_expires_at) WHERE state = 'held';
CREATE INDEX idx_sessions_identity ON conversation_sessions(identity_id, state);
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

## Part 13 — First Implementation Milestones

**M1 — Foundation (no external integrations)**
- Database schema applied and migrated
- Identity resolution logic + role table
- WhatsApp webhook receiver (signature verification + deduplication)
- InboundMessage normalization
- ConversationSession create/load/expire
- Audit log writer

**M2 — Booking engine (no Calendar yet)**
- ServiceType CRUD (manager-only)
- Availability rule CRUD (manager-only)
- Booking state machine (all transitions, tested in isolation)
- Authorization check function
- Availability query against internal rules (without Calendar)

**M3 — Calendar integration**
- Calendar Adapter with typed result model
- Hold placement and release
- Event confirmation and deletion
- Failure handling for all Calendar error cases
- Booking engine wired to Calendar Adapter

**M4 — WhatsApp message flows**
- LLM adapter with schema validation
- Customer intent extraction
- Booking flow end-to-end (inquiry → held → confirmed)
- Cancellation flow
- Clarification loop

**M5 — Manager instruction handling**
- Manager instruction handler
- LLM classification
- Ambiguity detection and clarification path
- Apply to availability, policy, service types
- Raw message ledger

**M6 — Hardening**
- Hold expiry background job
- Retry queues for outbound messages
- End-to-end integration tests for all core flows
- Failure scenario tests (Calendar down, LLM invalid output, duplicate message)

**M7 — Business onboarding (implemented)**
- Provider number (Step 0): 4-step WhatsApp conversation, WABA credential validation via Meta API, automatic phone number fetch, Business + Identity provisioning
- Business onboarding (Steps 1–6): guided WhatsApp flow for name, services, hours, Calendar OAuth, optional CSV import, verification
- `npm run provision` CLI as fallback for direct provisioning
- STATUS command (on-demand PA health report)
- Error alerts pushed to manager on unhandled failures
- Per-business WhatsApp credentials (overrides global env vars)

---

*This document reflects the implemented system. Changes to scope or architecture require explicit decision and a version bump.*
