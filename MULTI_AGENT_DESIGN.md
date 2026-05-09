# Multi-Agent PA Upgrade — Implementation-Ready Design Document

**Source reference:** "I Built the Ultimate Team of AI Agents in n8n" (Nate Herk | AI Automation, 23:45)  
**Prepared for:** PA_4_Business — WhatsApp + Gemini 2.5 Flash on GCP Cloud Run  
**Date:** 2026-05-09  
**Status:** IMPLEMENTED — all Phase 1–3 items complete. See implementation notes inline.  
**Revision:** v3 — updated to reflect implementation status; deferred items marked; 6 known gaps listed at bottom

### Implementation status (v3 update — 2026-05-09)

**Implemented ✅**
- Branch 3 orchestrator: full Gemini function-calling loop (`src/adapters/llm/orchestrator.ts`)
- All 7 tool executors (`src/domain/manager/orchestrator-tools.ts`)
- Orchestrator wired into webhook.ts, replacing classify→apply for post-onboarding manager messages
- Calendar sub-agent: `listEvents()`, `createPersonalEvent()` on both calendar implementations
- `deleteCalendarEvent` tool with customer booking guard
- Web search sub-agent: Tavily adapter (`src/adapters/search/client.ts`)
- Contact sub-agent: `lookupCustomer`, `saveContactNote`, `business_contacts` table
- Manager cross-session memory: `manager_memory` table, `generate-manager-summary` worker, injected into orchestrator system prompt
- Business knowledge injected into orchestrator system prompt
- `sendTemplateMessage()` + `canSendFreeForm()` in sender.ts; wired into reminder and waitlist workers
- `daily-briefing` BullMQ cron worker
- Orchestrator system prompt includes "offer to notify, don't act" proactivity rule
- Branch 1: `operator_session_notes` table, `generate-operator-summary` worker, `managerPhoneNumber` in CompactBusinessSummary, session notes injected into `answerOperatorQuestion`
- Branch 2: calendar preview after OAuth callback, richer import summary with `duplicatesSkipped`
- `CHAT_LEVEL_LAWBOOK.md` created

**Deferred to V2.1 ⏸**
- `content-creator` workflow skill (`src/skills/content-creator/`)
- `sendDocument()` in WhatsApp sender
- `anomaly-alert` worker
- `generated_content` table

**Known gaps (to fix before first provisioning) ⚠️**
1. `loadTranscript` depth for manager: webhook.ts line ~445 loads 8 turns — must raise to 20
2. Concurrency lock (`concurrency-lock.ts`) exists but is not called in `webhook.ts`
3. Language switch persistence: detected language change does not write back to `identities.preferredLanguage`
4. `managerMemorySummaries?: string[]` not yet in `src/shared/skill-types.ts`
5. WhatsApp formatting block not yet added to `PA_PERSONA_TEMPLATE` in `client.ts`
6. Branch 4 inquiry enrichment: `recentBookingCount` + `nextAvailableSlot` not yet injected

---

## Preamble: What the Video Actually Shows

The video demonstrates an n8n workflow ("Ultimate Personal Assistant") built on Telegram + GPT-4o. Its architecture:

- **Orchestrator ("Ultimate Assistant"):** A single GPT-4o agent with a short system prompt whose only job is to decide which tools to call using native LLM function calling. It does not produce a structured classification — it operates in a tool-calling loop: receive message → call tool(s) → receive tool results → produce final reply.
- **Sub-agents (separate n8n workflows called as tools):** Email Agent, Calendar Agent, Contact Agent, Content Creator Agent. Each receives a plain-language query string from the orchestrator and returns a plain-language response. The Contact Agent's sole job is resolving names to email addresses so other agents can address their outputs.
- **Direct tools on the orchestrator:** Tavily (web search), Calculator.
- **Memory:** Window Buffer Memory (last N conversation turns, in-session only).
- **Voice input:** Telegram voice notes → downloaded → transcribed via OpenAI Whisper → fed as text to orchestrator.
- **Proactive behavior:** After the manager said "reschedule the team sync," the video's orchestrator autonomously sent a follow-up email — emergent behavior from its tool-calling loop. **Our system does not replicate this.** Instead, after completing an action with customer-facing effects, the orchestrator offers to notify affected customers and waits for manager confirmation before sending anything.

**The critical architectural point:** The video's orchestrator does not classify intent and route to handlers. The LLM itself calls tools, receives results, and decides what to do next. It is an agentic loop, not a classifier.

**What the video does NOT cover:** WhatsApp, Gemini, two distinct user types, the 24-hour messaging window, and the existing deterministic booking core. These constraints drive significant departures from the video's design.

---

## 0. BRANCHES 1 AND 2 — TARGETED UPGRADES

### 0.1 Scope Clarification

Branches 1 and 2 do not receive the full multi-agent orchestrator pattern. They do receive targeted upgrades in three areas: chat level, calendar access, and contact access. These upgrades are narrower than those in Branches 3 and 4, because both channels have fundamentally different purposes and user types.

### 0.2 Branch 1 (Operator Channel) — Targeted Upgrades

**Channel purpose:** Internal platform administration. The operator (platform owner) manages all businesses — views status, reviews escalations, pushes cross-business updates. The current handler (`handleOperatorMessage`) already uses LLM reasoning with full business data injected (`answerOperatorQuestion`). It has Redis-backed session memory (`loadOperatorSession`, `appendOperatorTurn`).

**Chat Level Upgrade:**

The operator today uses text commands (STATUS, ESCALATIONS, UPDATE ALL, etc.) and falls through to natural language for anything else. The upgrade:

1. **Cross-session operator memory:** The existing Redis session expires per session. Add lightweight persistence: after each operator session, generate a one-paragraph summary of what was discussed (which businesses were reviewed, what instructions were pushed, any anomalies noted) and store it in a new `operator_session_notes` table. Inject the last 3 summaries into the `answerOperatorQuestion` system prompt. This lets the operator reference things from days ago ("which business was I asking about on Tuesday?") without the PA losing context.

2. **No orchestrator, no tool-calling loop:** The operator's queries are administrative reads and narrow writes (UPDATE ALL). The current `answerOperatorQuestion` function with rich business data injected is already sophisticated enough. Adding a tool-calling loop for the operator channel would be scope creep — the cost/benefit is wrong for a single internal user with well-defined commands.

**Calendar Access Upgrade (Branch 1):**

The operator does not manage individual business calendars. Calendar access for Branch 1 is metadata-level, not event-level:

- Add `calendarAuthStatus` to the `CompactBusinessSummary` struct passed to `answerOperatorQuestion`. This is already partially captured via `googleCalendarConnected`. Extend it to include: last successful calendar sync time, whether the OAuth token has expired, and which businesses are in internal-calendar mode.
- The operator can then ask: "Which businesses have expired calendar auth?" and get a direct answer from the injected data without any new calendar API calls.
- The operator does NOT get access to individual business calendar events. That would be a significant privacy/trust boundary violation and is not needed for platform administration.

**Contact Access Upgrade (Branch 1):**

The operator needs to contact business managers directly — outside the PA channel — when escalating platform issues or onboarding problems.

Current state: `CompactBusinessSummary` includes business name and phone (the business's WhatsApp number). The manager's personal phone number (used to set up the PA) is in the `identities` table but not surfaced to the operator via the LLM.

Upgrade: Extend `CompactBusinessSummary` with `managerPhoneNumber: string | null` (the phone of the identity with `role = 'manager'` for that business). Surface this in `answerOperatorQuestion` data so the operator can ask "What's the manager's number for Salon Noa?" and get an answer.

This is a read-only addition to existing operator data — no new tables, no pipeline impact.

### 0.3 Branch 2 (MiddleMan Onboarding) — Targeted Upgrades

**Channel purpose:** A new business owner is being walked through the onboarding steps (business_name → services → hours → cancellation_policy → payment → escalation_policy → calendar → customer_import → verify). It is a linear step-by-step flow with LLM-driven question generation and answer parsing.

**Chat Level Upgrade:**

1. **Better explanation mode:** Branch 2 already has an explanation mode for confused users (`explainOnboardingConcept`). The upgrade is ensuring this function is triggered proactively when the user's message contains question words or uncertainty signals ("what does that mean?", "I don't understand", "מה זאת אומרת?"). The existing code has this logic partially — verify it fires consistently across all steps.

2. **No orchestrator:** Onboarding is intentionally linear. Multi-agent orchestration would break the step-by-step guarantee. The LLM's role in onboarding remains: generate the next question, parse the answer.

**Calendar Access Upgrade (Branch 2):**

The onboarding flow has a `calendar` step where the business owner connects Google Calendar via OAuth. Today: the PA sends them an OAuth link and waits. When the callback fires, onboarding advances.

Upgrade — calendar preview after connection:

After the OAuth callback succeeds (in `src/routes/oauth.ts` or wherever the callback is handled), immediately call `listEvents` for the next 7 days on the newly connected calendar and send the business owner a preview:

```
Calendar connected! Here's what I can see for the next week:

Mon 12 May — 3 events
Tue 13 May — 1 event
Wed–Sun — nothing yet

Customers booking through your PA will automatically appear here. Ready to continue?
```

This confirmation has two values: it proves the connection worked (the owner sees their own data), and it sets expectations for how the calendar integration will look. If `listEvents` returns zero events, respond with "Calendar connected! It looks empty right now — that's fine, bookings will appear here as they come in."

**What this requires:** The OAuth callback handler needs access to the new `listEvents` adapter method. This is a Developer A change — extend the OAuth callback to call `calendarClient.listEvents()` immediately after token storage and send the summary message.

**Contact Access Upgrade (Branch 2):**

The `customer_import` onboarding step lets business owners upload a CSV of existing customers. Today: they get an upload link, upload the file, and the system processes it (count imported, any errors).

Upgrade — post-import contact summary:

After the import processes, instead of just "X customers imported," send a richer summary:

```
Import complete!

47 customers added
— 12 have service preferences on record
— 3 were already in the system (merged)
— 0 errors

Want to review any of them before going live?
```

This is a read-only query against the just-imported data — no new pipeline, just richer feedback.

Additionally, during the `customer_import` step, if the owner says "I don't have a list" or similar, the PA should proactively confirm: "No problem — customers will be added automatically as they book." This currently exists as the `ob_import_skip` i18n string — verify it reads naturally in both Hebrew and English with the current string content.

---

## 1. THE ARCHITECTURAL UPGRADE

### 1.1 What It Is and What Problem It Solves

Today, each branch has a flat single-LLM pipeline:
- Branch 3 (manager): message → `classifyManagerInstruction` → `applyInstruction` → `generateManagerReply`
- Branch 4 (customer): message → `extractCustomerIntent` → booking state machine → `generateCustomerReply`

The classification approach in Branch 3 handles five instruction types. "Unknown" gets a conversational fallback. There is no path for the manager to query the calendar, search the web, create content, or look up customer data conversationally. Any capability not covered by the five types hits a dead end.

The upgrade replaces the classification call in Branch 3 with a **native Gemini function-calling loop** — the same architectural pattern shown in the video. The LLM receives available tools, decides which to call, receives results, and continues until it produces a final reply. The deterministic apply pipeline is preserved: it becomes the implementation of the state-change tool, not a separate routing step before the LLM.

### 1.2 Which Branches Change

| Branch | Change |
|--------|--------|
| 1 (Operator) | Targeted upgrades only: voice transcription, cross-session memory, calendar health metadata, manager phone in contact data. No orchestrator. |
| 2 (Onboarding) | Targeted upgrades only: voice transcription, calendar preview post-OAuth, richer import summary. No orchestrator. |
| 3 (PA Manager) | **Full tool-calling orchestrator upgrade.** Manager accesses all sub-agents. |
| 4 (PA Customer) | **Selective upgrade.** Booking core deterministic. Non-booking paths get richer LLM handling. Customers never access sub-agents. |

### 1.3 How the Architecture Changes (Branch 3)

**Before:**
```
WhatsApp webhook
  → identity resolution → session hydration
  → dispatchSkill()   ← first-match skill wins, or null
  → if null: classifyManagerInstruction → applyInstruction → generateManagerReply
```

**After:**
```
WhatsApp webhook
  → identity resolution → session hydration
  → voice transcription (if audio — new)
  → dispatchSkill()   ← skills still run first; if skill claims it, done
  → if no skill claimed: Branch 3 Orchestrator tool-calling loop
      ├─ LLM receives: message + history + available tools
      ├─ LLM calls tool(s) in sequence as needed
      │     each tool either reads data OR wraps the deterministic pipeline
      ├─ LLM receives tool results, calls next tool if needed
      └─ LLM produces final reply text → sendMessage
```

**Key invariant:** `applyInstruction` is the only function that writes business configuration to the database. It lives inside the `manageBusinessSettings` tool executor. The LLM cannot bypass it — the tool is the only available interface for configuration changes.

### 1.4 The Orchestrator — True Gemini Function-Calling Loop

**This replaces the typed `OrchestratorAction` enum design from v1. The LLM does not produce a structured classification; it calls tools.**

**Location:** New function `runManagerOrchestratorLoop()` in `src/adapters/llm/client.ts`.

**How Gemini function calling works in `@google/genai` (the SDK already used):**

```typescript
// 1. Build tool definitions
const tools = [{
  functionDeclarations: [
    { name: 'listCalendarEvents', description: '...', parameters: { ... } },
    { name: 'manageBusinessSettings', description: '...', parameters: { ... } },
    // ...
  ]
}]

// 2. Initial call — LLM sees the message and available tools
let contents: Content[] = [{ role: 'user', parts: [{ text: message }] }]

while (iterations < MAX_ITERATIONS) {
  const result = await ai.models.generateContent({
    model: MODEL,
    contents,
    config: {
      systemInstruction: systemPrompt,
      tools,
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      thinkingConfig: { thinkingBudget: 0 },
    }
  })

  const part = result.candidates?.[0]?.content?.parts?.[0]
  if (!part) break

  if (part.functionCall) {
    // 3. LLM called a tool — execute it
    const toolResult = await toolExecutors[part.functionCall.name](part.functionCall.args)
    
    // 4. Add call + result to conversation, continue loop
    contents.push({ role: 'model', parts: [{ functionCall: part.functionCall }] })
    contents.push({ role: 'user', parts: [{ functionResponse: {
      name: part.functionCall.name,
      response: { result: toolResult }
    }}] })
    
    iterations++
  } else if (part.text) {
    // 5. LLM produced a text reply — loop ends
    return part.text
  }
}
// Safety: if loop exhausted, return graceful error message
return lang === 'he' ? 'אירעה שגיאה בעיבוד הבקשה.' : 'Something went wrong processing your request.'
```

**MAX_ITERATIONS = 5.** This prevents runaway loops. A legitimately complex request (e.g., search + check calendar + create content) takes at most 3 tool calls. If the loop reaches 5, return an error.

### 1.5 Tool Definitions (Branch 3 Orchestrator)

Each tool has a name, description (what the LLM reads to decide when to use it), and a parameter schema. The descriptions are part of the system — write them carefully.

```typescript
const MANAGER_TOOLS: FunctionDeclaration[] = [
  {
    name: 'listCalendarEvents',
    description: 'Read the business calendar — list upcoming events, check availability, or see what a specific day looks like. Use this when the manager asks about their schedule, upcoming bookings, or free slots. Do NOT use for changing availability — use manageBusinessSettings for that.',
    parameters: {
      type: 'OBJECT',
      properties: {
        intent: {
          type: 'STRING',
          enum: ['list_today', 'list_week', 'list_range', 'check_free_slots'],
          description: 'What calendar data to retrieve'
        },
        dateFrom: { type: 'STRING', description: 'Start date ISO 8601 (for list_range)' },
        dateTo: { type: 'STRING', description: 'End date ISO 8601 (for list_range)' },
      },
      required: ['intent']
    }
  },
  {
    name: 'createCalendarEvent',
    description: 'Create a personal or business event on the calendar (team meetings, blocks, personal appointments). This is for non-customer events. To block time from customer bookings, use manageBusinessSettings instead.',
    parameters: {
      type: 'OBJECT',
      properties: {
        title: { type: 'STRING' },
        startDatetime: { type: 'STRING', description: 'ISO 8601 in business timezone' },
        endDatetime: { type: 'STRING', description: 'ISO 8601 in business timezone' },
        notes: { type: 'STRING' }
      },
      required: ['title', 'startDatetime', 'endDatetime']
    }
  },
  {
    name: 'manageBusinessSettings',
    description: 'Change business configuration: hours, services, booking policies, or staff permissions. Use this when the manager wants to change what customers can book, when they can book, what services are offered, pricing, or who has access. Pass the manager\'s exact instruction.',
    parameters: {
      type: 'OBJECT',
      properties: {
        instruction: {
          type: 'STRING',
          description: 'The manager\'s exact words describing what they want to change'
        }
      },
      required: ['instruction']
    }
  },
  {
    name: 'searchWeb',
    description: 'Search the internet for current information the manager needs — competitor research, pricing trends, local events, regulatory changes, supplier information, etc.',
    parameters: {
      type: 'OBJECT',
      properties: {
        query: { type: 'STRING', description: 'Search query in the manager\'s language or English' },
        depth: { type: 'STRING', enum: ['basic', 'advanced'], description: 'basic = fast (5 results), advanced = comprehensive (use sparingly)' }
      },
      required: ['query']
    }
  },
  {
    name: 'lookupCustomer',
    description: 'Find a customer by name or phone number, view their booking history, or query a segment of customers (e.g. inactive customers, frequent visitors).',
    parameters: {
      type: 'OBJECT',
      properties: {
        queryType: { type: 'STRING', enum: ['find_by_name', 'find_by_phone', 'booking_history', 'segment'] },
        identifier: { type: 'STRING', description: 'Name, phone number, or identityId depending on queryType' },
        segmentFilter: { type: 'OBJECT', description: 'For segment queries: { serviceTypeId?, inactiveSinceDays?, hasBooking? }' }
      },
      required: ['queryType']
    }
  },
  {
    name: 'saveContactNote',
    description: 'Save a note about a customer or business contact. Use for customer preferences, instructions, or any information the manager wants to remember.',
    parameters: {
      type: 'OBJECT',
      properties: {
        targetType: { type: 'STRING', enum: ['customer', 'business_contact'] },
        identifier: { type: 'STRING', description: 'identityId for customers, name for business contacts' },
        note: { type: 'STRING' }
      },
      required: ['targetType', 'identifier', 'note']
    }
  },
  {
    name: 'deleteCalendarEvent',
    description: 'Delete a personal or business event from the calendar. Only for events the manager created (meetings, blocks, personal appointments). Never use this to cancel a customer booking — use manageBusinessSettings for booking cancellations.',
    parameters: {
      type: 'OBJECT',
      properties: {
        eventId: {
          type: 'STRING',
          description: 'Google Calendar event ID, as returned by listCalendarEvents or createCalendarEvent'
        },
        confirmationHint: {
          type: 'STRING',
          description: 'Brief description of the event being deleted, for confirmation message generation'
        }
      },
      required: ['eventId']
    }
  },
  // createContent is deferred to v2.1 — not in current scope
]
```

### 1.6 The Orchestrator System Prompt (Branch 3)

```
You are the PA admin assistant for {businessName}. Today is {currentDateTime} in {timezone}.

The manager is texting you on WhatsApp. You have access to tools. Use them when the manager needs information or action. For straightforward questions you can answer from context, reply directly without calling any tool.

## Language
Reply entirely in {language}. All WhatsApp formatting rules apply:
- No HTML. No markdown except *bold* and line breaks.
- Numbered lists for sequences. Line break separation between items.
- URLs on their own line.

## Tool usage rules
- manageBusinessSettings: ALWAYS use this for any change to hours, services, pricing, policies, or staff access. Never handle these as conversational replies.
- listCalendarEvents: use for schedule questions. Do not call it unless the manager is asking about their calendar.
- createCalendarEvent: personal/business events only. Do not use for blocking customer booking slots — that is manageBusinessSettings.
- deleteCalendarEvent: only for personal/business events the manager created. NEVER use for customer bookings — use manageBusinessSettings with a cancellation instruction for those.
- searchWeb: only when the manager explicitly needs external information.
- lookupCustomer / saveContactNote: only for customer or contact management requests.

## Business knowledge
{businessKnowledge}

## After completing actions
If the action you just completed has downstream effects on customers (cancellations, schedule changes), end your reply with a brief offer to notify them. Do not notify customers automatically — ask first.

## Memory
Recent conversation history is included below. Cross-session context:
{managerMemorySummaries}

## Recent conversation
{conversationHistory}
```

**`{businessKnowledge}` injection spec:**

The `{businessKnowledge}` placeholder is replaced at orchestrator construction time with the business's knowledge base, if populated. The content is sourced from the `businessKnowledge` row for the business (populated by the Business Knowledge Setup skill). Injection format:

```
Business description: {businessKnowledge.description}
Brand voice: {businessKnowledge.brandVoice}
Communication style: {communicationStyleSummary}
FAQs:
- Q: {faq.question}
  A: {faq.answer}
(... up to 10 FAQs)
```

If `businessKnowledge` is null (not yet set up), replace the placeholder with an empty string — do not inject a placeholder label or "not configured" message. The system prompt still functions correctly without it.

**`communicationStyleSummary`** is a one-line text summary constructed from `BusinessCommunicationStyle` fields, e.g. `"Formal tone, no emojis, use customer's first name."` — not the raw JSON.

### 1.7 Tool Executors and the Apply Pipeline Boundary

This section defines what each tool's TypeScript executor does internally, and specifically where the deterministic pipeline sits.

**The unified rule:**
> A tool executor can write directly to the database if and only if the write is (a) metadata that does not affect what customers can book or when, and (b) authorized by a manager identity check. Any write that affects scheduling availability, service configuration, booking policy, or staff permissions must pass through `classifyManagerInstruction → applyInstruction`.

**Four levels of pipeline involvement:**

---

**Level 0 — Read-only and external calls (no pipeline, no DB write)**

These tools call read functions or external APIs. No database writes occur. No authorization pipeline needed beyond the caller being manager-role (enforced at the flow entry point, not inside the tool).

| Tool | What it does |
|------|-------------|
| `listCalendarEvents` | Calls `calendarClient.listEvents()` + formats |
| `searchWeb` | Calls Tavily API + formats results |
| `lookupCustomer` (find/segment) | Reads `identities`, `customerProfiles`, `bookings` |

---

**Level 1 — Soft metadata writes (identity check only, no pipeline)**

These write metadata that a manager can freely set, with no effect on what customers can book, when they can book, or how bookings are processed.

| Tool | What it writes | Authorization |
|------|---------------|---------------|
| `saveContactNote` (customer note) | `customerProfiles.notes` | Manager role check (in flow entry) |
| `saveContactNote` (business contact) | `business_contacts` table | Manager role check (in flow entry) |

Pipeline involvement: none. These are direct `db.insert/update` calls.

---

**Level 2 — Calendar events (identity check + conflict check, no configuration pipeline)**

Creating a personal calendar event blocks time on Google Calendar, which affects `checkAvailability` results. This is intentional — the manager is deliberately blocking time. But it must not silently override a confirmed customer booking.

`createCalendarEvent` executor:
```typescript
async function executeCreateCalendarEvent(args, context) {
  // 1. Caller is already verified as manager (flow entry point)
  
  // 2. Check for confirmed booking conflicts in the requested slot
  const conflicts = await db.select(...)
    .from(bookings)
    .where(/* slot overlap AND state IN ['confirmed', 'held'] */)
  
  if (conflicts.length > 0) {
    return {
      success: false,
      message: `That slot has ${conflicts.length} confirmed booking(s). Creating the event anyway would show as double-booked. Do you want to cancel the booking(s) first, or choose a different time?`
    }
  }
  
  // 3. Create the event directly via calendar adapter
  const result = await calendarClient.createConfirmedEvent({
    start: new Date(args.startDatetime),
    end: new Date(args.endDatetime),
    summary: args.title,
    description: args.notes ?? '',
  })
  
  return { success: result.status === 'confirmed', eventId: result.eventId }
}
```

This does NOT go through `classifyManagerInstruction` or `applyInstruction`. Those functions handle business configuration — services, hours, policies, permissions. Creating a calendar event is a calendar operation, not a configuration change.

---

**Level 3 — Business configuration changes (full deterministic pipeline)**

`manageBusinessSettings` is the only tool at this level. Its executor calls the existing pipeline exactly as today:

```typescript
async function executeManageBusinessSettings(args, context) {
  // 1. Classify the natural-language instruction (same as today)
  const classified = await classifyManagerInstruction(
    args.instruction,
    { businessId: context.businessId, timezone: context.timezone },
    context.lang
  )
  
  if (!classified.ok) return { success: false, error: 'Classification failed' }
  if (classified.data.ambiguous) {
    return { success: false, clarificationNeeded: classified.data.clarificationNeeded }
  }
  
  // 2. Save instruction record (same as today)
  const [saved] = await db.insert(managerInstructions).values({ ... }).returning({ id: ... })
  
  // 3. Apply through the deterministic pipeline (same as today)
  const result = await applyInstruction(
    db, saved.id, context.businessId, context.identityId,
    classified.data.instructionType,
    classified.data.structuredParams,
    context.lang
  )
  
  if (!result.ok) return { success: false, error: result.reason }
  return { success: true, confirmation: result.confirmationMessage }
}
```

The LLM receives `{ success: true, confirmation: 'Tuesday afternoons are now blocked.' }` or `{ success: false, clarificationNeeded: 'Did you mean block just this Tuesday, or every Tuesday?' }`. If clarification is needed, the LLM sees this in the tool result and asks the manager in its next reply — no extra code needed.

---

**Level 4 — Booking engine operations (booking pipeline)**

No orchestrator tool exposes direct booking manipulation. The manager can cancel bookings, but this is handled via `manageBusinessSettings` (the instruction "cancel David's booking tomorrow" flows through `applyInstruction` which calls the booking engine). The orchestrator never calls `requestBooking`, `confirmBooking`, or `cancelBooking` directly.

---

**Summary table:**

| Tool | Level | Pipeline involvement |
|------|-------|---------------------|
| `listCalendarEvents` | 0 | None |
| `searchWeb` | 0 | None |
| `lookupCustomer` | 0 | None |
| `saveContactNote` | 1 | Identity check only (flow entry) |
| `createCalendarEvent` | 2 | Identity check + booking conflict check |
| `deleteCalendarEvent` | 2 | Identity check + customer booking guard |
| `manageBusinessSettings` | 3 | `classifyManagerInstruction → applyInstruction` |

### 1.8 How the Architecture Changes (Branch 4 — Selective)

Branch 4 customers retain the existing full deterministic booking state machine. The upgrade is additive: the `inquiry` and `unknown` paths get richer handling by drawing on business knowledge more deeply before escalating.

**What changes:**
- `inquiry` intent: the LLM receives FAQs, brand voice, and service narratives as structured context (already partially implemented). Upgrade: also receives `recentBookingCount` and `nextAvailableSlot` so it can give more specific answers.
- `unknown` intent after 2 occurrences: before escalating, the LLM makes one more attempt using the full FAQ set. Only if still unable to classify, escalate.

**What customers cannot access:**
- Web search, content creation, contact management, calendar read — none of these are exposed in Branch 4.
- The orchestrator tool-calling loop does not run for Branch 4. The existing state machine continues to handle booking/cancellation/rescheduling paths. The inquiry/unknown paths get an enhanced single LLM call with richer context, not a tool-calling loop.

### 1.9 Memory Architecture

**In-session (unchanged):** `conversationSessions` + `conversationMessages` tables. Branch 3 has 4-hour session expiry.

**Cross-session manager memory (new):**

New table: `manager_memory`
```sql
CREATE TABLE manager_memory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  identity_id uuid NOT NULL REFERENCES identities(id),
  period_start timestamp with time zone NOT NULL,
  period_end timestamp with time zone NOT NULL,
  summary text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
```

After each Branch 3 session completes, a BullMQ job generates a 2–3 sentence summary of key decisions, requests, and preferences discussed, and stores it. The orchestrator system prompt receives the last 3 summaries.

**SkillContext extension:** `managerMemorySummaries?: string[]`

**Open question for human decision:** Retention policy — how many days of summaries? Recommendation: 30 days rolling.

### 1.10 Sub-Agent Isolation: Confirmed In-Process

**Open question answer:** Sub-agents (skills and tool executors) are TypeScript functions called synchronously within the same Cloud Run request. This is confirmed by reading `src/skills/index.ts`:

```typescript
export async function dispatchSkill(ctx: SkillContext): Promise<SkillOutcome | null> {
  for (const skill of registry) {
    if (skill.canHandle(ctx)) {
      const outcome = await skill.handle(ctx)  // ← direct await, no network
      // ...
      return outcome
    }
  }
  return null
}
```

There is no HTTP call, no worker queue, no separate process. Skills and tool executors are imported into the main process at startup and run in the same Node.js event loop.

**This is correct and should stay this way.** Rationale:
- Skills are already isolated at the code level via ESLint import boundaries (no `src/domain`, `src/adapters`, `src/db` imports from within `src/skills/`). This enforces the isolation contract without process separation.
- In-process calls have zero network overhead — a sub-agent "call" is a function invocation, typically < 1ms excluding external API calls.
- Cloud Run handles horizontal scaling by running multiple instances. Within a single request, the tool-calling loop is sequential by nature (the LLM can only call one tool at a time and must receive results before continuing).

**Parallelism:** The video shows calendar and email agents running simultaneously. In our system, the Gemini function-calling API returns one `functionCall` part per response turn. True parallel tool execution within a single loop turn would require calling multiple external APIs in parallel after receiving one function call — this is a valid optimization but the Gemini API does not currently support multi-tool calls in a single turn in a standard way. Design for sequential tool calls in V2; optimize if latency becomes a problem.

**Risk — hanging external API calls:** If a tool's external API call hangs (Tavily timeout, Google Calendar timeout), it blocks the request thread until Cloud Run's request timeout (typically 60s). Mitigation: each tool executor must set its own `AbortController` timeout of 8–10s and return a clean error to the LLM if it fires. The LLM can then reply gracefully ("The web search timed out — try again in a moment").

**Separate services (when to consider):** If a tool needs to run genuinely long operations (e.g., video generation that takes 2 minutes), move that tool to a Cloud Tasks queue and use a polling pattern. For V2 content types (scripts, posts, blogs), all generation completes in < 5s — no queue needed.

### 1.11 Key Design Decisions Made

1. **True function calling, not classification.** The orchestrator uses Gemini's native `functionDeclarations` API. The LLM decides which tools to call based on tool descriptions, not on a switch table in the engine.

2. **The deterministic pipeline lives inside `manageBusinessSettings`.** It is not a separate routing step before the LLM. The LLM calls the tool; the tool enforces the pipeline. The LLM cannot bypass `applyInstruction` because the only path to configuration changes is through this tool.

3. **Sub-agents are TypeScript functions in-process.** No separate Cloud Run services. Code-level isolation enforced by ESLint.

4. **Level 0–3 pipeline rule.** Read-only and metadata writes are free. Calendar event creation needs a conflict check. Configuration changes need the full pipeline. This rule covers all current and planned tools.

5. **Skills still run before the orchestrator.** `dispatchSkill()` fires first. If a skill claims the message (website builder, business knowledge setup, content creator as a workflow skill), the orchestrator does not run. This preserves backward compatibility with existing skills and avoids competing claim logic.

### 1.12 Constraints and Risks

- **Latency:** A 3-tool-call loop with one external API (e.g., Tavily search + calendar read + content generation) could take 4–6 seconds. Send an acknowledgement message ("On it...") via `sendMessage` before starting the loop for any non-trivial request, then send the final reply. This requires two WhatsApp sends per multi-step turn.
- **Tool description quality:** Gemini decides which tool to call based on its description. Poor descriptions cause wrong tool selection. Invest time in the description strings — treat them like prompt engineering.
- **Loop safeguard:** If Gemini enters a clarification → tool → result → clarification cycle, MAX_ITERATIONS = 5 prevents infinite loops. Log every iteration count > 3 for monitoring.
- **Token cost:** The conversation contents array grows with each iteration (message + function call + function response). For a 5-tool loop, this is ~3–5k tokens of context per request. Well within Gemini 2.5 Flash's context window.

### 1.13 Open Questions for Human Decision

1. Should the "On it..." acknowledgement be sent for all orchestrated requests, or only when the estimated tool count exceeds 1?
2. What is the manager memory retention period?
3. Should existing skills (website builder, business knowledge setup) be exposed as tools in the orchestrator's tool list, or should they continue to be invoked exclusively via `dispatchSkill()`? (Recommendation: leave them as skills; the orchestrator's `skill_dispatch` capability is handled by the fact that skills run first.)
4. Should `thinkingBudget: 0` be kept for the orchestrator, or should some thinking be enabled to improve multi-step reasoning? (Budget 0 reduces latency; a small budget may improve correctness for complex multi-step requests.)

---

## 2. CHAT LEVEL UPGRADE

### 2.1 What It Is and What Problem It Solves

The video's PA feels fluid: voice notes are accepted, memory spans the conversation, the manager can ask anything and get a complete response. Our current system is functional but has rough edges. The chat upgrade addresses: voice input, session memory depth, removal of unnecessary confirmation gates, multi-step single-turn execution, and WhatsApp-specific formatting discipline.

### 2.2 Session Memory Depth

**Current state:** Branch 3 has a 4-hour session. Branch 4 operates on booking-session lifecycle.

**Branch 3 upgrade:** Extend conversation history in the orchestrator to the last 20 turns (verify current hydration limit and raise if needed). Add cross-session summaries via `manager_memory` table (Section 1.9).

**Branch 4 (unchanged):** Customers interact transactionally. Within-session memory already works correctly. `customerProfiles` provides returning-customer context — this is sufficient.

### 2.3 Removal of Unnecessary Confirmation Gates

**Branch 3 post-onboarding:** Remove double-confirmation for unambiguous manager instructions. If `manageBusinessSettings` returns `{ success: true }`, apply directly and confirm in the reply. Keep confirmation only for: destructive operations (cancelling all bookings), permission changes.

**Implementation:** The `manageBusinessSettings` executor (Section 1.7) already handles this correctly — it applies directly if not ambiguous and returns a confirmation string. The orchestrator includes this confirmation in its final reply without prompting the manager to confirm again.

### 2.4 Multi-Step Single-Turn Execution

The tool-calling loop naturally handles multi-step requests. The manager says one thing; the LLM calls tools in sequence; the LLM produces one final reply with all results.

**WhatsApp formatting for multi-step replies:**
```
*Thursday afternoon blocked* ✅
13:00–18:00 is now unavailable.

*Instagram story draft*
[caption text]
#tag1 #tag2

Want me to notify customers with bookings in that window?
```

The orchestrator system prompt instructs the LLM to use `*bold*` headers per action when reporting multiple results.

### 2.5 WhatsApp Formatting Rules

All conversational formatting standards — message length, bold usage, emoji rules, list formatting, URL placement, and language rules — are defined in **CHAT_LEVEL_LAWBOOK.md**. That document is authoritative and must be consulted when writing or modifying any LLM prompt.

The single architectural implementation note: add a WhatsApp formatting rule block (derived from the lawbook) to `PA_PERSONA_TEMPLATE` in `src/adapters/llm/client.ts` so the rules are injected into every LLM call automatically.

---

## 3. CALENDAR SUB-AGENT

### 3.1 What It Is and What Problem It Solves

The existing calendar adapter handles: checkAvailability, placeHold, confirmHold, deleteEvent, createConfirmedEvent — all write operations from the booking engine. What is missing: a read path.

The Calendar Sub-Agent (implemented as tool executors in the Branch 3 orchestrator, not as a skill) adds:
- Read: list events, check free slots
- Write: create personal/business events (Level 2 — not through `applyInstruction`)

### 3.2 New Adapter Methods (Developer A — `src/adapters/calendar/client.ts`)

```typescript
// Add to both Google and internal implementations

listEvents(from: Date, to: Date): Promise<CalendarEventSummary[]>

createPersonalEvent(params: {
  title: string
  start: Date
  end: Date
  description?: string
}): Promise<ConfirmResult>

interface CalendarEventSummary {
  id: string
  title: string          // sanitized — [HOLD] prefix stripped, internal IDs removed
  start: Date
  end: Date
  isHold: boolean
  isCustomerBooking: boolean
  customerName?: string  // from description if booking event
}
```

**Internal calendar mode fallback for `listEvents`:** No Google Calendar to query. Read from `bookings` table WHERE `businessId = X AND slotStart BETWEEN from AND to AND state IN ('confirmed', 'held')`. Return as `CalendarEventSummary[]`.

### 3.3 Tool Executor — `listCalendarEvents`

```typescript
async function executeListCalendarEvents(args, context) {
  const { intent, dateFrom, dateTo } = args
  const tz = context.timezone
  
  let from: Date, to: Date
  
  switch (intent) {
    case 'list_today':
      from = startOfDayInTz(new Date(), tz)
      to = endOfDayInTz(new Date(), tz)
      break
    case 'list_week':
      from = startOfDayInTz(new Date(), tz)
      to = endOfDayInTz(addDays(new Date(), 7), tz)
      break
    case 'list_range':
      from = new Date(dateFrom)
      to = new Date(dateTo)
      break
    case 'check_free_slots':
      from = startOfDayInTz(new Date(dateFrom ?? new Date()), tz)
      to = endOfDayInTz(new Date(dateTo ?? dateFrom ?? new Date()), tz)
      break
  }
  
  const events = await calendarClient.listEvents(from, to)
  // Cap at 50 events
  return {
    events: events.slice(0, 50).map(e => ({
      title: e.title,
      start: formatDateTime(e.start, tz),
      end: formatDateTime(e.end, tz),
      isCustomerBooking: e.isCustomerBooking,
    })),
    timezone: tz,
    rangeLabel: formatRange(from, to, tz)
  }
}
```

The LLM receives this structured object and formats it as a WhatsApp message.

### 3.4 Branch Availability

| Capability | Branch 1 | Branch 2 | Branch 3 | Branch 4 |
|-----------|---------|---------|---------|---------|
| Calendar health metadata | ✅ (in admin data) | ❌ | N/A | N/A |
| Calendar preview post-OAuth | N/A | ✅ (one-time) | N/A | N/A |
| List calendar events | ❌ | ❌ | ✅ | ❌ |
| Check free slots | ❌ | ❌ | ✅ | ❌ |
| Create personal event | ❌ | ❌ | ✅ | ❌ |
| List own bookings | N/A | N/A | N/A | ✅ (existing) |

### 3.5 Error Handling

- **Google auth error:** Existing `withTokenRefresh` logic handles. If refresh fails, the manager already receives a "calendar auth expired" WhatsApp message from the existing adapter code. The tool executor returns `{ success: false, error: 'calendar_auth_expired' }` and the LLM informs the manager.
- **No events:** Return `{ events: [], message: 'No events in that period.' }` — never return empty/null.
- **Event conflict on create:** Return conflict details and let the LLM ask for a different time.

### 3.6 Open Questions for Human Decision

1. Should creating a personal calendar event be blocked (not just warned) if it conflicts with confirmed bookings? (Recommendation: warn and ask, not hard block — the manager may intend to cancel the booking separately.)
2. Should the manager be able to delete a personal calendar event via the PA? (Recommendation: yes, add `deleteCalendarEvent` tool in V2.1.)

---

## 4. CONTACT SUB-AGENT

### 4.1 What It Is and What Problem It Solves

The video's Contact Agent: resolves names to email addresses. We have no email. The sub-agent is redesigned from scratch.

In our WhatsApp-only system, "contacts" means: customer intelligence (lookup, history, notes), customer segment queries, and a business contacts directory (vendors, partners). This is **Branch 3 only** — managers can query contacts; customers cannot.

### 4.2 Backend

**Customer data:** Existing `identities` + `customerProfiles` + `bookings` tables. No new tables needed for customer operations.

**Business contacts directory:** New table.
```sql
CREATE TABLE business_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  name text NOT NULL,
  phone_number text,
  role text,
  notes text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX business_contacts_business_idx ON business_contacts(business_id);
```

### 4.3 Implementation as a Skill vs Tool Executor

The contact sub-agent is implemented as **tool executors in the orchestrator** (not a skill) for `lookupCustomer` and `saveContactNote`. Rationale:
- These are single-step operations: query in → data out, note saved.
- No multi-turn workflow state needed.
- The orchestrator already has these as registered tools.

The **content-creator** remains a Workflow Skill (multi-turn, persisted state) — see Section 6.

### 4.4 Tool Executors

**`lookupCustomer` executor:**
```typescript
async function executeLookupCustomer(args, context) {
  switch (args.queryType) {
    case 'find_by_name':
      const customers = await db.select(...)
        .from(identities)
        .where(and(eq(identities.businessId, context.businessId), ilike(identities.displayName, `%${args.identifier}%`)))
      return { customers: customers.map(formatCustomerSummary) }
    
    case 'find_by_phone':
      const customer = await db.select(...).from(identities)
        .where(and(eq(identities.businessId, context.businessId), eq(identities.phoneNumber, args.identifier)))
        .limit(1)
      return { customer: customer[0] ? formatCustomerSummary(customer[0]) : null }
    
    case 'booking_history':
      const history = await db.select(...)
        .from(bookings)
        .where(and(eq(bookings.customerId, args.identifier), eq(bookings.businessId, context.businessId)))
        .orderBy(desc(bookings.slotStart))
        .limit(10)
      return { bookings: history.map(formatBookingSummary) }
    
    case 'segment':
      // Use existing customerSegmentQuery pattern
      return { customers: await querySegment(db, context.businessId, args.segmentFilter) }
  }
}
```

**`saveContactNote` executor:**
```typescript
async function executeSaveContactNote(args, context) {
  if (args.targetType === 'customer') {
    await db.update(customerProfiles)
      .set({ notes: sql`COALESCE(notes, '') || ${'\n' + new Date().toISOString() + ': ' + args.note}` })
      .where(eq(customerProfiles.identityId, args.identifier))
    return { success: true }
  }
  
  if (args.targetType === 'business_contact') {
    const existing = await db.select().from(businessContacts)
      .where(and(eq(businessContacts.businessId, context.businessId), ilike(businessContacts.name, args.identifier)))
      .limit(1)
    
    if (existing[0]) {
      await db.update(businessContacts).set({ notes: args.note, updatedAt: new Date() })
        .where(eq(businessContacts.id, existing[0].id))
    } else {
      await db.insert(businessContacts).values({ businessId: context.businessId, name: args.identifier, notes: args.note })
    }
    return { success: true }
  }
}
```

### 4.5 WhatsApp Output Format

The LLM formats tool results. Example orchestrator reply after `lookupCustomer`:

```
*Rachel Cohen* (+972501234567)
First visit: 12 Jan 2026
Total bookings: 8
Last service: Haircut — Thu 1 May 2026
Note: Prefers 10am slots.
```

Segment result:
```
*Inactive customers (90+ days)* — 14 found

Rachel C., David K., Sarah M., Ahmed T., Noa R.
... and 9 others

Want to send them a message?
```

### 4.6 Error Handling

- Customer not found by name: "Couldn't find a customer named [X]. Try their phone number instead."
- Multiple name matches: return all with last-booking date for disambiguation.
- Segment query returns 0: confirm explicitly.
- Note save fails: report failure.

### 4.7 Open Questions for Human Decision

1. Should `saveContactNote` append (with timestamp) or replace? (Recommendation: append with timestamp — never lose previous notes.)
2. Should the manager be able to delete a business contact via the PA? (Recommendation: V2.1.)
3. Should customer phone numbers be shown in full to managers? (Recommendation: yes — managers own the customer relationship.)

---

## 5. WEB SEARCH SUB-AGENT

### 5.1 What It Is and What Problem It Solves

A direct orchestrator tool (not a skill) that gives the manager access to current internet information. Use cases: competitor research, pricing trends, local event research, supplier information.

**Branch 3 only.** Customers cannot trigger web searches.

### 5.2 API Choice

**Recommended: Tavily AI Search API** (`https://api.tavily.com/search`)
- Purpose-built for AI agents — returns clean structured results
- `search_depth: 'basic'` for fast results (5 results, ~0.5s), `'advanced'` for comprehensive
- Simple REST API, single environment variable `TAVILY_API_KEY`

**New file:** `src/adapters/search/client.ts`

**Environment variable:** `TAVILY_API_KEY` — stored in GCP Secret Manager, injected as Cloud Run env var.

### 5.3 Tool Executor

```typescript
async function executeSearchWeb(args, context) {
  const response = await tavilySearch({
    query: sanitizeUserInput(args.query),
    searchDepth: args.depth ?? 'basic',
    maxResults: 5,
    includeAnswer: true,
  })
  
  if (!response.results?.length) {
    return { noResults: true, query: args.query }
  }
  
  return {
    answer: response.answer ?? null,
    results: response.results.map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.content.slice(0, 200),
    })),
    query: args.query,
  }
}
```

The LLM formats this into WhatsApp text. The formatting LLM prompt instructs: plain text, numbered results, URL on own line, total under 800 characters.

**Example output:**
```
*Wellness trends Israel 2026*

1. *Longevity clinics growing fast* — New longevity-focused clinics opening in Tel Aviv and Haifa, driven by demand from 40+ demographic.
wellness-news.co.il/trends

2. *Sound healing gaining mainstream* — Sound bath sessions now offered at 35% of Israeli spas, up from 12% in 2024.
spa-industry.il/report

Searched: "wellness trends Israel 2026"
```

### 5.4 Error Handling

- Tavily API unavailable: `{ error: 'search_unavailable' }` → LLM replies "Web search is unavailable right now."
- No results: `{ noResults: true }` → LLM asks for rephrasing.
- Query sanitization: the existing `sanitizeUserInput()` from `src/adapters/llm/client.ts` must be applied to the search query before sending to Tavily.

### 5.5 Constraints and Risks

- `basic` search: ~0.5–1s. `advanced`: 2–5s. Default to `basic`.
- Hebrew query quality: Tavily is English-dominant. If Hebrew query returns no results, the tool can try an English transliteration. Design this as a simple fallback in the executor, not a separate LLM call.
- Monitor Tavily usage per business and add rate limiting if needed at scale.

---

## 6. CONTENT CREATOR SUB-AGENT

### 6.1 What It Is and What Problem It Solves

Generates written content for local business managers: social posts, Reel scripts, newsletters, service descriptions, promotional copy, blog articles, video scripts. **Branch 3 only.**

The video's Content Creator uses Claude 3.5 Sonnet + Tavily and outputs HTML blog posts delivered as email drafts. Our version uses Gemini 2.5 Flash, no HTML, delivers via WhatsApp message or uploaded document.

### 6.2 Architecture: Workflow Skill

The Content Creator is a **Workflow Skill** in `src/skills/content-creator/`, running via `dispatchSkill()` before the orchestrator. When the manager says "write an Instagram post about our new pilates class," the skill's `canHandle()` claims it and the orchestrator never sees the message. This is consistent with how existing skills (website builder, business knowledge setup) work.

Rationale for skill over orchestrator tool:
- Multi-turn: manager may request revisions across turns
- Persistent state: tracks what was generated, revision count, workflow step
- Clean separation: content generation is a self-contained workflow, not a single-step tool call

### 6.3 Workflow Steps

```
requirements-gather → [research (optional)] → generate → deliver → [revision]
```

1. **requirements-gather:** Extract content type, topic, tone, target audience from the manager's message. If any required field is unclear, ask one clarifying question.
2. **research (optional):** If content type is `blog` or `video_script`, call `tavilySearch` to gather sources. Store source URLs in workflow state.
3. **generate:** Call Gemini 2.5 Flash with a content-type-specific prompt. Store generated content in workflow state.
4. **deliver:** Send as WhatsApp message (short) or uploaded document (long). Mark `sessionComplete: false` to allow revision requests.
5. **revision (optional):** If manager requests changes ("make it shorter", "change the tone"), re-run `generate` with revision context. Max 3 revisions, then mark workflow complete.

### 6.4 Content Type — Reel Script WhatsApp Format

```
*Reel Script — [Topic]*

*HOOK (0–3 sec)*
[Opening line — punchy, stops the scroll]

*BODY (3–25 sec)*
[Key point 1]
[Key point 2]
[Key point 3]

*CTA (25–30 sec)*
[Clear call to action]

---
*Caption:*
[Caption text]
[hashtags]
```

### 6.5 Delivering Content Over WhatsApp

| Content length | Delivery method |
|---------------|----------------|
| < 1,000 chars | WhatsApp text message |
| 1,000–5,000 chars | WhatsApp document (.txt) |
| > 5,000 chars | WhatsApp document (.txt) |

**Document delivery requires extending `src/adapters/whatsapp/sender.ts`:**

```typescript
export async function sendDocument(params: {
  toNumber: string
  content: string
  filename: string
  caption: string
  credentials?: WaCredentials
}): Promise<SendResultWithOptOut>
```

Implementation: write content to a temp file → upload to WhatsApp Media API (`POST .../media`) → receive `media_id` → send document message with `type: 'document'`.

### 6.6 canHandle Rules

```typescript
canHandle(ctx: SkillContext): boolean {
  if (ctx.caller.role === 'customer') return false

  if (ctx.workflowState?.skillName === 'content-creator') return true

  const text = ctx.message.text.toLowerCase()
  return [
    'content', 'post', 'write', 'create', 'generate', 'draft',
    'blog', 'article', 'reel', 'script', 'caption', 'newsletter',
    'instagram', 'facebook', 'social', 'promo', 'promotion',
    'תוכן', 'פוסט', 'כתוב', 'צור', 'סקריפט', 'ריל', 'ניוזלטר',
  ].some(k => text.includes(k))
}
```

### 6.7 LLM Choice

Gemini 2.5 Flash. The video used Claude 3.5 Sonnet for content quality; the system prompt and formatting rules compensate for model differences. If content quality becomes a concern after launch, the skill is isolated in `src/skills/` and can be updated to call any model API without affecting other components.

### 6.8 Error Handling

- Research step fails: proceed without sources; inform manager. "Couldn't search the web, so this is based on general knowledge."
- Generated content fails Zod validation: retry up to 3 times; if all fail, return error and `fail()` workflow.
- Revision count > 3: "I've made 3 revisions. If you'd like something different, start a new request."
- `sessionComplete`: set to `true` after delivery with no pending revision, or after 3rd revision.

### 6.9 Constraints and Risks

- Temp files on Cloud Run have ephemeral storage. Delete temp file after successful upload to WhatsApp Media API.
- WhatsApp document types supported: txt, pdf, docx. Plain text (.txt) is simplest; use it as the default.
- Brand voice and communication style must be populated (via Business Knowledge Setup skill) for content to be on-brand. If `businessKnowledge.brandVoice` is null, proceed with generic professional tone and note this in the reply.

### 6.10 Open Questions for Human Decision

1. Should generated content be saved in a `generated_content` table for later retrieval? (Recommendation: yes, last 5 pieces per business.)
2. Should the manager be able to send the generated content directly to their customers as a broadcast from within the PA? (This is a separate "broadcast" capability — flag for V3.)
3. Should video script generation include a timestamps/teleprompter format option? (Recommendation: yes — add as a delivery format option when `contentType = 'video_script'`.)

---

## 7. PROACTIVE BEHAVIOR

### 7.1 What It Is and What Problem It Solves

The video's standout moment: manager says "push the team sync back an hour" → the orchestrator autonomously sends a follow-up email to the attendee. This emerged from the tool-calling loop.

**Our system does not replicate autonomous customer-facing sends.** After completing an action with downstream effects on customers, the orchestrator ends its reply with a brief offer to notify them. The manager confirms ("yes, let them know"), triggering a new orchestrator turn that calls `manageBusinessSettings` with the notification instruction — only then does a message go out. This is enforced both by the system prompt rule and by the WhatsApp 24-hour window constraint.

In our system, proactivity must navigate the WhatsApp 24-hour customer service window, which has no equivalent in Telegram.

### 7.2 The 24-Hour Window Constraint

- Free-form messages to a customer: only within 24 hours of that customer's last message to the business.
- After 24 hours: only pre-approved Meta template messages can be sent.
- Violation: message delivery failure, risk of WhatsApp Business API suspension.

This applies to Branch 4 customers only. The manager (Branch 3) messages daily — their 24h window is almost always open.

### 7.3 How Proactivity Works Within the Tool-Calling Loop (Branch 3)

In the orchestrator's system prompt (Section 1.6): "If the action you just completed has downstream effects on customers, end your reply with a brief offer to notify them. Do not notify customers automatically — ask first."

This means the orchestrator's final reply naturally includes the offer. Example:

Manager: "Block Tuesday 12 May entirely."
Orchestrator calls `manageBusinessSettings` → blocks Tuesday.
Orchestrator final reply:
```
*Tuesday 12 May is now fully blocked* ✅

No customer bookings will be accepted that day.

3 customers have existing bookings on that day. Want me to notify them and cancel their appointments?
```

If the manager replies "yes" — that is a new message, a new orchestrator turn, which calls `manageBusinessSettings` with the cancellation instruction and `saveContactNote` with notification records.

If the manager replies "no" — the session continues normally.

This pattern (offer → explicit confirmation → action) is deliberately different from the video's auto-send, because sending messages to customers is a visible external action with real consequences that the manager must consciously authorize.

### 7.4 Proactivity Toward the Manager — Async (Branch 3)

**Daily briefing (opt-in):** A BullMQ recurring job fires at a configured time (e.g., 8:00 AM business timezone). Builds a short summary from the DB and sends via `sendMessage`.

```
*Good morning — Thursday 9 May*

Today: 6 appointments
10:00 Yael Cohen — Haircut
11:30 David Katz — Manicure
13:00 Sarah Levy — Manicure
... +3 more

No open escalations.
```

If manager hasn't messaged in >24h: either skip (recommended for V2) or send via a pre-approved manager briefing template.

**Anomaly alerts:** Optional threshold-triggered alerts (spike in escalations, customer unable to book, etc.). Design thresholds as configurable per business. High false-positive risk — implement conservatively.

### 7.5 Proactivity Toward Customers — Async (Branch 4)

**The window check function (required for every proactive customer message):**

```typescript
async function canSendFreeForm(db, customerId, businessId): Promise<boolean> {
  const lastMsg = await db
    .select({ createdAt: conversationMessages.createdAt })
    .from(conversationMessages)
    .innerJoin(conversationSessions, eq(conversationMessages.sessionId, conversationSessions.id))
    .where(and(
      eq(conversationSessions.identityId, customerId),
      eq(conversationSessions.businessId, businessId),
      eq(conversationMessages.role, 'customer')
    ))
    .orderBy(desc(conversationMessages.createdAt))
    .limit(1)

  if (!lastMsg.length) return false
  return (Date.now() - lastMsg[0].createdAt.getTime()) < 24 * 60 * 60 * 1000
}

// Usage in every proactive worker:
if (await canSendFreeForm(db, customerId, businessId)) {
  await sendMessage({ toNumber: phone, body: freeFormBody })
} else {
  await sendTemplateMessage({ toNumber: phone, templateName: ..., variables: [...] })
}
```

**Template message infrastructure:**

`src/adapters/whatsapp/sender.ts` must be extended with `sendTemplateMessage()`:

```typescript
export async function sendTemplateMessage(params: {
  toNumber: string
  templateName: string
  language: 'he' | 'en'
  variables: string[]
  credentials?: WaCredentials
}): Promise<SendResultWithOptOut>
```

This sends `type: 'template'` with `template.name`, `template.language.code`, and `template.components[0].parameters`.

**Required templates (submit to Meta for approval — blocker if not done):**

| Template name | Variables | Used when |
|--------------|-----------|-----------|
| `booking_reminder_24h_he/en` | customerName, serviceName, date, time | 24h pre-appointment |
| `booking_reminder_1h_he/en` | customerName, serviceName, time | 1h pre-appointment |
| `post_appointment_he/en` | customerName, serviceName | Post-appointment follow-up |
| `waitlist_offer_he/en` | serviceName, date, time | Slot opened on waitlist |
| `cancellation_notice_he/en` | customerName, serviceName, date, time | Manager-cancelled booking |

**Critical open question:** Has Meta template approval been initiated for the reminder templates? The existing reminder workers (`workers/reminders.ts`) likely send free-form messages for all reminders. This works only when customers have messaged within 24h — for any reminder firing > 24h after last customer message, the message silently fails today. This is a production bug regardless of the orchestrator upgrade. It must be addressed.

### 7.6 Proactive Summary

| Trigger | Recipient | Window | Implementation |
|---------|-----------|--------|---------------|
| Orchestrator completes action affecting customers | Manager (offer to notify) | N/A | Orchestrator system prompt |
| Manager confirms notification | Customers | Check: free-form or template | New orchestrator tool turn |
| Daily briefing | Manager | Usually open; skip if >24h | BullMQ recurring job |
| Anomaly alert | Manager | Usually open | BullMQ threshold job |
| Booking confirmed | Customer | Within session ✅ | Existing |
| 24h/1h reminder | Customer | Always template | Existing workers + template fix |
| Post-appointment | Customer | Always template | Workers + templates |
| Waitlist offer | Customer | Usually template | Existing worker + template fix |
| Manager-cancelled booking | Customer | Check | New notification path |

---

## CROSS-CUTTING CONCERNS

### Required SkillContext Extensions (Developer A — `src/shared/skill-types.ts`)

```typescript
managerMemorySummaries?: string[]
```

Note: calendar read and contact write capabilities are implemented as orchestrator tool executors (not in SkillContext).

### Required New Adapter Functions (Developer A)

| File | New function(s) |
|------|----------------|
| `src/adapters/calendar/client.ts` | `listEvents()`, `createPersonalEvent()`, `deleteEvent()` (guard added) |
| `src/adapters/whatsapp/sender.ts` | `sendTemplateMessage()` |
| `src/adapters/search/client.ts` | New file — `searchWeb()` via Tavily |
| `src/adapters/llm/client.ts` | `runManagerOrchestratorLoop()` — new function |

### Required New Skills (Developer B)

```
src/skills/content-creator/    — workflow skill for content generation (v2.1 — deferred)
```

### Required New Database Tables (Developer A)

```sql
manager_memory          — cross-session manager conversation summaries
business_contacts       — non-customer contacts (suppliers, partners, staff)
operator_session_notes  — cross-session operator memory (Branch 1 upgrade)
-- generated_content: deferred to v2.1 with content-creator skill
```

### Required New Workers (Developer A)

```
src/workers/daily-briefing.ts   — opt-in daily manager summary
src/workers/anomaly-alert.ts    — threshold-triggered manager alerts (V2.1)
```

### New Environment Variable

```
TAVILY_API_KEY    — in GCP Secret Manager, injected as Cloud Run env var
```

### Build Sequence

**Phase 1 — Foundation (Developer A)**
1. Tavily search adapter (`src/adapters/search/`)
2. `listEvents()` + `createPersonalEvent()` + `deleteCalendarEvent` guard in CalendarClient
3. `sendTemplateMessage()` in WhatsApp sender + `canSendFreeForm()` utility
4. `manager_memory` + `business_contacts` tables

**Phase 2 — Orchestrator (Developer A)**
6. `runManagerOrchestratorLoop()` in `src/adapters/llm/client.ts`
7. Tool executors: `executeListCalendarEvents`, `executeCreateCalendarEvent`, `executeManageBusinessSettings`, `executeSearchWeb`, `executeLookupCustomer`, `executeSaveContactNote`
8. Wire orchestrator into Branch 3 flow (replace `classifyManagerInstruction → generateManagerReply` with orchestrator loop when no skill claims message)

**Phase 3 — Branch 1/2 Upgrades (Developer A)**
9. `operator_session_notes` + cross-session summary for Branch 1
10. Manager phone number in `CompactBusinessSummary`
11. Calendar preview after OAuth callback (Branch 2)
12. Richer customer import summary (Branch 2)

**Phase 4 — Skills (Developer B)**
14. `content-creator` workflow skill (v2.1 — deferred)

**Phase 5 — Proactivity (Developer A)**
15. Proactive offer appended in orchestrator system prompt (included in Phase 2)
16. `daily-briefing` worker
17. `canSendFreeForm()` utility + template message infrastructure
18. Audit all existing reminder workers to add template fallback

---

*Document v2. Updated: corrected orchestrator to use Gemini native function calling; added apply pipeline boundary levels (0–3); added Branch 1 and 2 targeted upgrades; confirmed sub-agent isolation model as in-process TypeScript functions.*
