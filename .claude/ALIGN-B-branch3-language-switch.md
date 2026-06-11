# Session B — Branch 3 Language-Switch Protocol + Greet-Once Parity (B1/B2)

**Owner:** Developer A · **Risk:** Medium · **Prereq reading:** `CLAUDE.md`, `CHAT_LEVEL_LAWBOOK.md`
§3.4, Branch 4 reference in `src/domain/flows/customer-booking.ts`.
**Per-phase git commits are MANDATORY.**

---

## Part 1 — Branch 3 language-switch protocol (primary)

### Why
Lawbook §3.4 mandates the language-switch protocol for **Branches 3 & 4**. Branch 4 implements it
fully; Branch 3 does not. The manager `lang` is hard-pinned to `business.defaultLanguage`
(`src/routes/webhook.ts:470`) — no per-message detection, no inline switch offer, no persistence.

### Reference (Branch 4 — copy the shape, not the file)
- Detect language per message (`extractCustomerIntent` returns `detectedLanguage`).
- `shouldOfferSwitch = !override && detected !== default` — `customer-booking.ts:378`.
- Append inline offer once per turn — `customer-booking.ts:520–527`.
- Handle YES/NO to a pending offer; persist `identities.preferredLanguage` — `:256–284`.
- Switch offer wording is already specified in lawbook §3.4 and the Branch 4 suffix strings.

### Plan
1. **Detect** the manager message language. The orchestrator does not currently classify language.
   Two options — pick the simpler that fits:
   - (Preferred) Add a lightweight language-detect step before the loop in
     `runManagerOrchestratorLoop` (a tiny Flash `callWithSchema` returning `{detectedLanguage}` or a
     deterministic heuristic — Hebrew-script presence is a strong signal and avoids an extra LLM call).
   - Reuse an existing detector if one exists in `src/domain/i18n/`.
2. **Resolve `lang`** for the turn as `override ?? detected ?? business.defaultLanguage`. Thread the
   detected language into the orchestrator system prompt's "Reply entirely in {language}" line.
3. **Inline switch offer:** when `detected !== default` and no override is locked for the identity,
   append the one-line switch offer (§3.4 wording) to the orchestrator's final reply. Do this in the
   webhook manager handler after `runManagerOrchestratorLoop` returns, OR inside the loop's final
   reply assembly — keep it append-once, never bilingual mid-reply.
4. **Persist preference:** when the manager replies YES to a pending offer, write
   `identities.preferredLanguage` (same as `customer-booking.ts:264`). Track the
   "offer pending" state on the manager session context (mirror `languageSwitchOfferPending` /
   `languageOverride` in `src/domain/flows/types.ts` — add equivalent fields to the manager session
   context type).
5. The manager session already loads `identity.preferredLanguage` upstream
   (`webhook.ts:269` pattern for customers) — make the manager path honor a stored
   `preferredLanguage` as the override, falling back to `business.defaultLanguage`.

### Guardrails
- One appended offer per turn. No bilingual interruption (§3.4.3).
- Don't re-offer once an override is set or the manager already answered.

---

## Part 2 — Greet-once parity for Branches 1 & 2 (optional polish)

### Why
Branch 4 has a **hard** greet-once guarantee (`greeted` flag + `isFirstMessage`,
`customer-booking.ts:382`, `webhook.ts:290`). Branches 1 (operator) and 2 (onboarding) rely only on
the voice-core "don't re-introduce yourself" instruction. Lower risk (operator = persistent admin
session; onboarding = explicit state machine), but not a guarantee.

### Plan (do only if Part 1 is comfortably done)
- **Operator (B1):** the operator session is long-lived; add a `greeted` flag to its session context
  and inject a `firstMsgPrefix`-style line into `answerOperatorQuestion` / `generateOperatorReply`
  only on the genuine first message, mirroring `customer-booking.ts` `mayGreet`.
- **Onboarding (B2):** `provider-onboarding.ts` is already state-driven (`welcome` → `ask_business_name`
  → …) so a greeting is structurally bounded to the `welcome` step. Verify no later step re-greets;
  if any do, gate the greeting on the welcome state only. Likely a no-op confirmation, not new code.

### Note
This part is genuinely optional and explicitly lower priority than Part 1. If time is tight, ship
Part 1 alone and leave a one-line TODO referencing this file.

---

## Verification
- `npx tsc --noEmit` clean; `npm test` green.
- Trace a manager messaging in English to a Hebrew-default business: reply comes back in English with a
  single appended Hebrew→English-style switch offer; replying "כן"/"yes" persists preference and stops
  further offers.

## Files
- `src/adapters/llm/orchestrator.ts` (detected language threading; offer assembly)
- `src/routes/webhook.ts` (manager lang resolution; offer append; YES/NO handling)
- `src/domain/flows/types.ts` (manager session context: add switch-offer fields)
- (optional) `src/domain/flows/operator.ts`, `src/domain/flows/provider-onboarding.ts`,
  `src/adapters/llm/client.ts` (greet-once parity)
