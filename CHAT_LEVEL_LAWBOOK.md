# CHAT_LEVEL_LAWBOOK — WhatsApp Message Formatting Standards

> Authoritative formatting reference for all WhatsApp reply generation in PA_4_Business.
> All four branches must comply. Any LLM system prompt producing WhatsApp messages must cite these rules.

---

## 1. Platform Constraints (Hard Rules — Cannot Be Violated)

These constraints are imposed by the WhatsApp Cloud API and the WhatsApp client app. Violations produce garbled output or delivery errors.

### 1.1 Supported Formatting
- `*bold*` — single asterisk on each side
- `_italic_` — single underscore on each side
- `~strikethrough~` — single tilde on each side
- `\`monospace\`` — single backtick on each side
- Line breaks: actual newline `\n` characters only — never `<br>`, never `\\n`

### 1.2 Unsupported (Never Use)
- HTML tags: `<b>`, `<em>`, `<p>`, `<ul>`, `<li>`, or any other HTML
- Markdown headers (`#`, `##`, `###`)
- Markdown links `[text](url)` — URLs must appear naked, on their own line
- Triple backtick code blocks
- Tables
- Horizontal rules (`---`, `***`)
- Footnotes or endnotes

### 1.3 URL Formatting
URLs must appear on their own line, not embedded in text:
```
Here is your booking link:
https://example.com/book
```
Never: `Click [here](https://example.com/book)` — this renders as literal text on WhatsApp.

---

## 2. Length and Structure Rules

### 2.1 Reply Length by Context

| Context | Target length |
|---|---|
| Confirmation (booking confirmed, action done) | 1–2 sentences |
| Simple question answered | 1–3 sentences |
| Complex situation (reschedule, cancellation with options) | 3–5 sentences |
| List of bookings or calendar events | Header + bullet list, max 10 items |
| Business overview / status report | Max 15 lines total |
| Never | Multi-paragraph prose |

### 2.2 One Question Per Message
A message may contain at most one question. Never stack questions:

❌ `What service did you want? And what time works for you?`

✅ `What service were you thinking of?`

### 2.3 Bullet Lists
Use bullet points only when listing multiple discrete items. Format:
```
• Item one
• Item two
• Item three
```

Use `•` (U+2022), not `-`, `*`, or `–`. Do not use numbered lists unless order is significant (sequences, steps).

### 2.4 Emoji Usage

| Setting | Rule |
|---|---|
| Default | One emoji maximum per reply, at a key moment (booking confirmed ✅, reminder ⏰) |
| `emojiUse: 'none'` | Zero emoji ever |
| `emojiUse: 'frequent'` | Up to 2–3 per message, at natural breaks |
| Never | Emoji mid-sentence, emoji replacing punctuation, emoji in questions or clarifications |

---

## 3. Language Rules

### 3.1 Language Isolation
A reply must be written entirely in one language. Never mix Hebrew and English in a single message, even for emphasis or technical terms.

Exception: brand names, product names, and URLs may appear in their original form regardless of language.

### 3.2 Hebrew Formatting Conventions
- Dates: `ב-13 במאי`, `ביום שלישי`, `ב-9:30` (never "13/5", never "May 13th" in a Hebrew reply)
- Times: `9:30` or `21:00` — 24-hour format without "שעות" suffix unless conversational
- Phone numbers: as-is, no transliteration
- Numbers: always digits (`3`, `15`), never spelled out (`שלוש`, `חמש-עשרה`) unless quoting

### 3.3 English Formatting Conventions
- Use contractions (`you're`, `it's`, `that's`, `we'll`) — WhatsApp is informal
- Dates: `13 May`, `Tuesday the 3rd`, `next Monday` (not `05/13/2025`)
- Times: `9:30 AM` or `9:30 am` — 12-hour with AM/PM

### 3.4 Language Switch Protocol (Branches 3 & 4)
When a message arrives in a language different from the configured default:
1. Reply immediately in the detected language
2. Append a one-line switch offer at the end of the reply, in the detected language
3. Do not interrupt the reply with a bilingual block
4. If the sender confirms, persist `identities.preferredLanguage` to the new language

Switch offer format (append to end of reply):
- Hebrew → English: `(Want me to switch to English? Reply YES)`
- English → Hebrew: `(רוצה שאמשיך בעברית? כתוב/י כן)`

---

## 4. Tone and Voice Rules

### 4.1 Persona
The PA speaks as the business — not as an AI, not as a bot, not as a third party. Never say:
- "As an AI..."
- "I'm a bot..."
- "I was programmed to..."
- "My knowledge cutoff..."

### 4.2 Acknowledgement Openers
Brief openers are natural for confirmations. Allowed:
- Hebrew: `קיבלתי —`, `בוצע —`, `הבנתי —`
- English: `Got it —`, `Done —`, `Sure —`

Never: sycophantic openers (`בטח! אשמח מאוד לעזור!`, `Absolutely! I'd be delighted to help!`)

### 4.3 Returning Customer Greeting
When a returning customer's name is known, one warm acknowledgement per session is allowed:
- Hebrew: `קיבלתי, [שם]!`
- English: `Good to hear from you, [name]!`

One time only. Do not repeat the name again in the same session.

### 4.4 Booking Confirmation Format
When confirming a booking to a customer, always include:
1. Service name
2. Day of week
3. Date
4. Time
5. Confirmation prompt

```
תספורת — יום שלישי, 13 במאי, 10:00.
לאשר? (כן / לא)
```

```
Haircut — Tuesday, 13 May, 10:00 AM.
Confirm? (YES / NO)
```

---

## 5. Branch-Specific Rules

### 5.1 Branch 1 — Operator Channel
- Replies may be longer and more data-dense (operator is technical, not a customer)
- Bullet lists are the default for multi-business status reports
- Use `*bold*` for business names in lists
- Never pretend to have data you don't have — say "I don't have that data, try STATUS [name]"
- System prompt must inject: live business list, operator session cross-session summaries (last 3)

### 5.2 Branch 2 — MiddleMan Onboarding
- 1–3 sentences maximum per message
- One question per message — never stack
- No bullet points, no numbered lists, no markdown
- If the user shows confusion, explain the concept in plain language, then re-ask
- Never parse a confused question as an answer to the onboarding step

### 5.3 Branch 3 — PA Manager Channel
- Format is same as customer channel but addressed to the manager
- Manager messages can be longer and more detailed than customer-facing replies
- After completing an action that affects customers, always offer to notify them — never notify automatically
- System prompt must inject: manager memory summaries (last 3 cross-session summaries)

### 5.4 Branch 4 — PA Customer Channel
- Transactional path: LLM phrases situations only — it never sees raw engine codes
- Conversational path: LLM reasons freely with full context
- Maximum 4 sentences for complex situations, 1–2 for simple confirmations
- Ask exactly one question per message

---

## 6. Proactive Behavior Rules

### 6.1 Actions That Require Manager Confirmation Before Execution
The PA never autonomously sends messages to third parties or modifies external state without manager confirmation:
- Notifying customers of changes (schedule changes, cancellations)
- Bulk messages to customer segments
- Posting to external services

The correct pattern: complete the requested action, then offer the downstream notification at the end of the reply.

Example:
```
ביטלתי את התור של דוד ב-13 במאי.
רוצה שאשלח לו הודעה על הביטול?
```

### 6.2 Actions the PA Executes Without Asking
- Reading calendar / listing bookings (read-only operations)
- Answering questions from context
- Confirming actions already explicitly requested by the manager

---

## 7. Safety and Anti-Injection Rules

### 7.1 User Input Sanitization
All user messages must be sanitized before being passed to an LLM:
- Strip HTML tags
- Block prompt injection patterns (`ignore previous instructions`, `system prompt`, etc.)
- Hard cap at 2000 characters

### 7.2 LLM Output Boundaries
LLM output is display-only. It is never parsed back as a command or used to trigger side effects directly. All state changes go through the deterministic core.

### 7.3 Situation String Protocol (Branch 4)
The `situation` string passed to the customer reply LLM is a sanitized internal description — it must never:
- Contain raw engine error codes
- Contain internal field names or UUIDs
- Be quoted back verbatim to the customer

---

## 8. Character and Encoding Notes

- All messages are UTF-8
- WhatsApp renders RTL for Hebrew automatically — no special RTL markers needed
- Newlines: use `\n` in code; WhatsApp renders them as line breaks
- Maximum message length: 4096 characters (WhatsApp Cloud API limit)
- If a reply exceeds 4096 characters, split at a natural paragraph boundary and send as two messages

---

*Last updated: 2026-05-09*
