# ONBOARDING_DESIGN — Business Provisioning Design

> Authoritative reference for how new businesses are onboarded onto the platform.
> Covers case taxonomy, detection logic, per-case procedures, and the agentic/manual duality.
> All conversation text produced by the MiddleMan flow must comply with CHAT_LEVEL_LAWBOOK.md §5.2.

---

## 1. Purpose

This document defines:
- The product target state a business must reach to be fully operational
- The principles governing the coexistence of PA automation and manager manual control
- The taxonomy of onboarding cases based on the joining business's existing WhatsApp setup
- The detection logic that identifies which case applies during the MiddleMan onboarding conversation
- The procedure each case follows to reach the product target state

---

## 2. Product Target State

A business is considered fully operational on the platform when all of the following are true:

1. A WhatsApp Cloud API number is registered and connected to a WABA under the business's Meta Business Manager
2. The platform webhook is receiving and processing messages for that number
3. The PA is responding autonomously to customer messages in Branch 4
4. The manager can view all conversations live via Meta Business Suite or the WhatsApp Business App (coexistence)
5. The manager can trigger manual takeover of a specific conversation via Branch 3
6. The PA retains full awareness of all messages in a conversation, including those sent manually by the manager

Any business that does not meet all six conditions is not considered fully provisioned.

---

## 3. The Agentic / Manual Duality

The platform is designed so that the PA handles conversations autonomously by default, while the manager retains the ability to observe and intervene at any time. Both operate on the same Cloud API number — the customer sees one continuous conversation regardless of who is replying.

### 3.1 Live Monitoring

The manager can read all active customer conversations at any time via Meta Business Suite (business.facebook.com or the Meta Business Suite mobile app). No action is required from the system — Business Suite provides a live inbox for all Cloud API numbers. This requires no code changes.

For Case 2 (coexistence), the manager can additionally monitor and reply from the WhatsApp Business App directly. The coexistence feature means both the app and the Cloud API receive and can send messages on the same number simultaneously.

### 3.2 Manager-Triggered Pause

The manager can instruct the PA via Branch 3 to stop responding to a specific customer conversation for a defined period. During the pause window, Branch 4 is silent for that conversation. The manager handles the customer manually via Business Suite or the WhatsApp Business App. When the window expires, automation resumes.

Implementation requires:
- A pause flag on the conversation or identity record
- A pause tool registered in the Branch 3 orchestrator
- A guard at the entry point of the Branch 4 handler that checks the flag before processing

### 3.3 PA-Triggered Escalation

The PA can autonomously detect defined edge cases mid-conversation, stop responding, and proactively notify the manager in Branch 3 with the conversation details. The manager either confirms an action or takes over manually.

This feature is acknowledged here but its specification — including the edge case taxonomy and trigger conditions — is out of scope for this document and will be addressed in a separate design.

### 3.4 PA Awareness of Manual Messages

**Requirement:** The PA must have full context of everything said in a conversation, including messages sent manually by the manager during a pause window.

**Open technical item:** Verification is required to confirm whether the Meta webhook delivers the full content of messages sent via Meta Business Suite back to the platform webhook. If it does not, an alternative mechanism must be implemented (e.g. a custom internal inbox that logs all outbound messages, or a manager debrief step before automation resumes). This must be resolved before the pause feature is built.

---

## 4. Infrastructure Requirement

All cases described below converge on one requirement: the business must operate on the **WhatsApp Cloud API**. This is non-negotiable. The Cloud API is the only product that allows webhook-based automation and manual intervention to coexist on the same number.

The **WhatsApp Business App** (the mobile app) is a separate product. It does not support webhooks by default. However, Meta's **coexistence** feature allows a WhatsApp Business App number to run simultaneously on the Cloud API — the owner keeps full access to the familiar app while the PA operates via the API on the same number. This is the preferred path for owners who already have an active WhatsApp Business App number.

**Meta Business Suite** is the manual inbox for Cloud API numbers. It allows the manager to read and reply to conversations without going through the PA. For Cases 1 and 3a, Business Suite setup is part of onboarding completion. For Case 2 (coexistence), the manager's existing WhatsApp Business App serves this purpose — Business Suite is not required.

---

## 5. Case Taxonomy

There are four defined onboarding cases.

| Case | Starting State | Path to Target |
|---|---|---|
| **1** | No WhatsApp Business presence. Fresh number available. | Full setup via Embedded Signup widget. Coexistence offered after 7 days via deferred nudge. |
| **2** | Active WhatsApp Business App number (7+ days usage). | Coexistence via Embedded Signup — number stays on app, Cloud API added alongside. No migration. |
| **3a** | Cloud API WABA exists. Owner has Meta Business Manager admin access. | OAuth connection via Embedded Signup widget. |
| **3b** | Cloud API WABA exists but managed by a BSP or agency. | **Out of scope for soft launch.** Requires manual coordination with the BSP. Flow must detect this and exit gracefully with instructions. |

---

## 6. Detection Flow — MiddleMan Chat

Detection is embedded in the existing MiddleMan onboarding conversation. It occurs after the service step, before the Embedded Signup link is sent. All messages comply with CHAT_LEVEL_LAWBOOK.md §5.2: maximum 1–3 sentences, one question per message, no bullet points, no markdown.

### Step 1 — Existing number check

Asked after the service step is confirmed:

> *Hebrew:* האם יש לכם כבר מספר וואטסאפ עסקי?
>
> *English:* Do you already have a WhatsApp Business number for your business?

| Answer | Route |
|---|---|
| No / not yet | → Case 1 |
| Yes | → Step 2 |

### Step 2 — App vs Cloud API

> *Hebrew:* האם המספר הזה פועל דרך אפליקציית וואטסאפ ביזנס בטלפון, או שהוא כבר מחובר דרך Meta Business Manager?
>
> *English:* Is that number running through the WhatsApp Business App on your phone, or is it already connected through Meta Business Manager?

| Answer | Route |
|---|---|
| WhatsApp Business App / on my phone | → Case 2 (coexistence link sent immediately, no follow-up question) |
| Meta Business Manager / Cloud API / already set up | → Case 3a (or 3b — see Step 3) |
| Unclear / confused | → Explain: "וואטסאפ ביזנס אפ היא האפליקציה שמורידים לטלפון. Meta Business Manager היא מערכת מתקדמת יותר שמנהלים דרך האינטרנט." Then re-ask. |

### Step 3 — BSP check (Case 3a only)

> *Hebrew:* האם הגדרתם את החשבון בעצמכם, או שחברה חיצונית ניהלה את ההגדרה עבורכם?
>
> *English:* Did you set up the account yourselves, or did an external company manage the setup for you?

| Answer | Route |
|---|---|
| Set it up ourselves | → Case 3a |
| External company / agency | → Case 3b (out of scope — exit gracefully) |

---

## 7. Per-Case Procedure

### Case 1 — No WABA, fresh number

**Prerequisites the owner must have:**
- A phone number that can receive an SMS or call for verification (SIM or VoIP)
- A personal Facebook account

**What the MiddleMan conversation says:**
After detection confirms Case 1 and the Facebook warning is sent, the system sends the Embedded Signup link with the following message:

> *Hebrew:* מעולה. שימו לב — תצטרכו חשבון פייסבוק אישי כדי להתחבר. אם אין לכם, פתחו אחד ב-facebook.com לפני שתלחצו.
>
> *English:* Great. Note — you'll need a personal Facebook account to connect. If you don't have one, create one at facebook.com first.

**Embedded Signup configuration:** Full setup flow. Creates Meta Business Manager, creates WABA, registers the new number.

**What the system handles automatically post-callback:** Token exchange, WABA phone number retrieval, business provisioning, Business Suite setup message to manager, and a deferred coexistence nudge sent via the MiddleMan number.

**Deferred coexistence nudge:** After provisioning completes, the MiddleMan number sends the following message to the manager:

> *Hebrew:* טיפ לשבוע הבא: אחרי 7 ימים של שימוש במספר החדש, תוכלו לחבר אותו לאפליקציית וואטסאפ ביזנס ולראות את כל השיחות ישירות שם. כשתהיו מוכנים — שלחו לי "חיבור" בצ'אט הזה.
>
> *English:* Tip for next week: after 7 days of activity on your new number, you can connect it to the WhatsApp Business App and see all conversations directly there. When you're ready — reply "connect" in this chat.

When the owner replies to the MiddleMan with a coexistence trigger word (e.g. "חיבור", "ready", "coexistence") after provisioning is complete, the MiddleMan generates a new Embedded Signup link and sends it to enable coexistence.

---

### Case 2 — Coexistence (WhatsApp Business App, existing number)

**Prerequisites the owner must have:**
- WhatsApp Business App number that has been actively used for at least 7 days
- A personal Facebook account

**What the MiddleMan conversation says:**
After `_wabaType === 'app'` is confirmed, the system immediately sends the coexistence link with no additional question:

> *Hebrew:* מעולה — המספר שלכם יישאר פעיל בוואטסאפ ביזנס ויתחבר גם ל-PA. תצטרכו חשבון פייסבוק אישי. לחצו: [url] חשוב: כדי לשמור על החיבור, פתחו את אפליקציית וואטסאפ ביזנס לפחות פעם בשבועיים.
>
> *English:* Great — your number will stay active in the WhatsApp Business App and connect to the PA as well. You'll need a personal Facebook account. Tap: [url] Important: to keep the connection active, open the WhatsApp Business App at least once every two weeks.

The 14-day activity requirement is embedded in the link message itself. No separate reminder is sent.

**Embedded Signup configuration:** Standard Embedded Signup flow. Meta auto-detects the existing app number and activates coexistence. No migration occurs. Number remains active on the WhatsApp Business App.

**What the system handles automatically post-callback:** Token exchange, phone number retrieval, business provisioning. No additional post-provisioning message is sent (14-day reminder already delivered with the link).

**Operational requirement:** Owner must open the WhatsApp Business App at least once every 13–14 days. Failing this breaks the coexistence connection and requires re-onboarding.

---

### Case 3a — Cloud API WABA exists, owner has admin access

**Prerequisites the owner must have:**
- Admin access on the Meta Business Manager that owns the WABA
- A personal Facebook account (the one linked to that Business Manager)

**What the MiddleMan conversation says:**

> *Hebrew:* מצוין. לחצו על הקישור כדי לחבר את החשבון הקיים שלכם. תצטרכו להיכנס עם הפייסבוק שמקושר ל-Meta Business Manager שלכם.
>
> *English:* Great. Click the link to connect your existing account. You'll need to log in with the Facebook account linked to your Meta Business Manager.

**Embedded Signup configuration:** OAuth connection flow. Does not create new accounts — authenticates against the existing WABA and retrieves the phone number.

**What the system handles automatically post-callback:** Token exchange, WABA phone number retrieval, business provisioning, Business Suite setup message to manager.

---

### Case 3b — Cloud API WABA exists, BSP-managed (out of scope)

This case is out of scope for the soft launch. When detected, the flow exits gracefully:

> *Hebrew:* במקרה הזה צריך לתאם את החיבור ישירות עם החברה שהגדירה את החשבון. פנו אליהם וביקשו שיחברו את המספר ל-PA. כשזה מסודר — חזרו אלינו.
>
> *English:* In this case the connection needs to be coordinated directly with the company that set up the account. Reach out to them and ask them to connect the number to the PA. Once that's done, come back to us.

No link is sent. The onboarding session is left open so the owner can return.

---

## 8. Meta Business Suite Setup

After provisioning completes for Cases 1 and 3a, the following message is sent to the manager via the new PA number:

> *Hebrew:* עוד דבר — כדי לצפות בשיחות ולהשתלט עליהן ידנית אם צריך, הורידו את *Meta Business Suite* לטלפון או היכנסו ל-business.facebook.com. שם תראו את כל השיחות עם הלקוחות בזמן אמת.
>
> *English:* One more thing — to view conversations and step in manually when needed, download *Meta Business Suite* or go to business.facebook.com. You'll see all customer conversations there in real time.

**Note:** This message is only sent for Cases 1 and 3a. Case 2 owners use their existing WhatsApp Business App as the monitoring interface — Business Suite is not needed and the message is not sent.

---

## 9. Open Technical Items

| Item | Status | Blocking |
|---|---|---|
| Embedded Signup JS widget implementation | Required — current raw `dialog/oauth` redirect is insufficient for Cases 1 and 2 | Yes — blocks all non-3a cases |
| Webhook delivery of Business Suite outbound messages | Needs verification against Meta documentation — determines PA awareness implementation approach | Yes — blocks pause feature build |
| Manager pause tool (Branch 3 orchestrator) | Not yet implemented | No — can be built independently |
| Branch 4 pause guard | Not yet implemented | No — can be built independently |
| Case 3b handling | Out of scope for soft launch | No |
| PA-triggered escalation feature | Spec deferred to separate design document | No |
| Case 3a + coexistence compatibility | Whether coexistence can be added to an existing Cloud API number requires verification. If re-onboarding is required, a dedicated flow must be designed. | No — does not affect soft launch |
