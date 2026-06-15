# Tier-B: Plug Branch-3 Chat Abilities Into Onboarding — Design

**Date:** 2026-06-15
**Status:** Approved (pending spec review)
**Follows:** `docs/superpowers/plans/2026-06-15-onboarding-chat-alignment.md` (Tier A, shipped v1.0.53)

## Guiding principle

The chat-level abilities already exist and work in the live Branch-3 manager path and Branch-4 customer path. **We reuse them — we do not rebuild.** Onboarding is the one manager surface that bypasses this machinery; this work plugs onboarding into it.

## Problem

Branch-3 onboarding (`manager-onboarding.ts`, gated at `webhook.ts` `routeManagerMessage`) generates each reply through `generateOnboardingReply` in isolation: no transcript, no session, no language adaptivity. Two visible consequences (from the Tier-A sweep):

- **B1 — Repetition.** Every step opens "מעולה …" and reuses the same shapes, because the generator has no memory of prior turns to vary against (`buildVoiceCore` already carries the §11 anti-formula rule — the generator just can't honor it without context).
- **B2 — No language adaptivity.** Onboarding hardcodes `business.defaultLanguage`. An owner who writes in the other language is locked out of it for all ~9 steps. The live manager path already implements the §3.4 switch — onboarding simply doesn't call it.

Owner-gender capture is explicitly **out of scope** (deferred per prior decision).

## What already exists and gets reused (not rebuilt)

| Ability | Where it lives | How onboarding uses it |
|---|---|---|
| Session continuity | `loadActiveSession` / `createSession` (`session/manager.ts`), `SESSION_EXPIRY.manager` | Onboarding gate loads/creates the manager session, same call as `webhook.ts:608-612` |
| Transcript store | `saveMessage` / `loadTranscript` (`messages/repository.ts`) | Gate saves inbound+outbound, loads last 10 turns |
| Language-switch resolution | `webhook.ts:715-719` (currently inline) | **Extracted** into a shared helper both paths call |
| Switch-offer answer parse | `parseConfirmation` (`flows/types.ts`) | Reused directly |
| Switch-offer suffix | `managerSwitchOfferSuffix` (`i18n/t.ts`) | Reused directly |
| Language detection | `detectLang` (`i18n/t.ts`) | Reused via the shared resolver |
| Session language state | `ManagerFlowContext.languageOverride` / `.languageSwitchOfferPending` | Reused directly |

## Architecture

Both B1 and B2 hang off one change: **the onboarding gate is wrapped with the same session + language resolution the live manager path uses.** The only genuinely new code is a ~10-line language-signal guard and the prompt-injection of the transcript.

### New shared module: `src/domain/flows/language-switch.ts`

Extracts the pure language-resolution ability so both the live manager path and onboarding run the *same* code.

```ts
// Returns true only when the text carries a real language signal. Used to stop
// low-signal tokens onboarding constantly sees (24/7, Bit, GO, times, phone
// numbers, bare digits) from wrongly flipping the conversation language.
// Hebrew letter ⇒ signal. Otherwise needs ≥2 Latin word-tokens (≥2 letters each).
export function hasLanguageSignal(text: string): boolean

// The Branch-3 §3.4 resolution, extracted verbatim in behavior, plus the guard.
export function resolveTurnLanguage(input: {
  body: string
  defaultLang: Lang
  preferredLanguage: Lang | null      // identities.preferredLanguage
  sessionOverride: Lang | undefined   // ManagerFlowContext.languageOverride
}): { turnLang: Lang; detected: Lang; shouldOfferSwitch: boolean }
```

`resolveTurnLanguage` logic (behavior-identical to today's manager path, with the guard added):
- `effectiveOverride = preferredLanguage ?? sessionOverride`
- `rawDetected = detectLang(body)`
- `detected = hasLanguageSignal(body) ? rawDetected : (effectiveOverride ?? defaultLang)` ← the guard: no signal ⇒ don't flip
- `turnLang = effectiveOverride ?? detected`
- `shouldOfferSwitch = !effectiveOverride && detected !== defaultLang`

The pending-offer **answer** flow (accept → persist `preferredLanguage` + session override + ack; decline → lock session to default; unclear → fall through) stays in each gate as I/O, because the ack send differs per channel (manager: `generateManagerCommandReply`; onboarding: `generateOnboardingReply`). The decision uses the existing `parseConfirmation`. This keeps the *computation* shared while channel-specific sending stays local.

### Live manager path refactor (behavior-preserving)

`webhook.ts:715-719` is replaced by a call to `resolveTurnLanguage(...)`. The existing `tests/flows/manager-language-switch.test.ts` must stay green — its cases (`'can you add a yoga class…'`, Hebrew sentences) all have language signal, so the guard doesn't change their outcome. This is the proof the extraction preserved behavior.

### Onboarding gate (the plug-in), in `webhook.ts` `routeManagerMessage`

Replaces the bare `handleOnboardingMessage → sendMessage` block (`webhook.ts:486-493`) with:

```
1. session = loadActiveSession(identity) ?? createSession('manager_instruction', SESSION_EXPIRY.manager)
2. ctx = session.context as ManagerFlowContext
3. if ctx.languageSwitchOfferPending && !identity.preferredLanguage && !ctx.languageOverride:
     parseConfirmation(body): yes → persist preferredLanguage + override, ack via generateOnboardingReply, save+send, return
                              no  → set sessionOverride = defaultLang, clear pending
                              unclear → fall through
4. { turnLang, detected, shouldOfferSwitch } = resolveTurnLanguage({ body, defaultLang, preferredLanguage, sessionOverride })
5. saveMessage(session, 'customer', body)
6. transcript = loadTranscript(session, 10)
7. result = handleOnboardingMessage(db, msg, identity, business, baseUrl, log, turnLang, transcript)
8. reply = shouldOfferSwitch ? result.reply + managerSwitchOfferSuffix(detected) : result.reply
9. updateSessionContext(session, { ...ctx, languageSwitchOfferPending: shouldOfferSwitch, languageOverride: sessionOverride })
10. saveMessage(session, 'assistant', reply); sendMessage(reply)
```

All `saveMessage`/`loadTranscript`/session calls are wrapped in `.catch` (mirroring the live path) — any failure degrades to no-transcript / default-language generation; onboarding never breaks.

### `handleOnboardingMessage` + step handlers

New params threaded through, both with safe defaults so non-webhook callers (`oauth.ts`, `import.ts`) are unaffected:
- `lang: Lang` — now passed **in** (the resolved `turnLang`), replacing the internal `business.defaultLanguage` default. When a caller doesn't pass it, fall back to `business.defaultLanguage` (preserves current oauth/import behavior).
- `transcript: TranscriptTurn[] = []` — passed down to each step handler → `onboardingQuestion` / `notAnswerReply` (via the options bag) → `generateOnboardingReply`.

### `generateOnboardingReply` (the anti-repetition fix)

Add optional `transcript?: TranscriptTurn[]`. When present and non-empty, inject the recent turns into the system prompt as a "recent conversation" block, with the instruction to continue naturally and not reuse a prior opener (the §11 rule is already in `buildVoiceCore`; the transcript gives it something to honor). When absent, behavior is exactly as today.

## Data flow

```
inbound → load/create manager session
        → handle pending switch-offer answer (parseConfirmation) [may early-return]
        → resolveTurnLanguage → { turnLang, detected, shouldOfferSwitch }
        → saveMessage(inbound) → loadTranscript(10)
        → handleOnboardingMessage(lang=turnLang, transcript) → reply
        → append managerSwitchOfferSuffix(detected) if shouldOfferSwitch
        → updateSessionContext(language state) → saveMessage(outbound) → send
```

## Error handling

- Session create / save / load failures: caught, logged `warn`, degrade gracefully (no transcript, default language). Never throw out of the gate.
- `generateOnboardingReply` already swallows LLM errors internally and returns `''` → callers fall back to templates. Unchanged.

## Testing

Unit (deterministic, in `npm test`):
- `hasLanguageSignal`: `'24/7'`→false, `'GO'`→false, `'Bit'`→false, `'PayPal'`→false, `'שלום'`→true, `'I want to set my hours'`→true, `'credit card'`→true, `''`→false.
- `resolveTurnLanguage`: no-signal token keeps current language (no flip, no offer); English sentence on he-default → `turnLang='en'`, `shouldOfferSwitch=true`; locked `preferredLanguage` wins; mirrors `manager-language-switch.test.ts` predicate cases.
- Onboarding gate wiring (flow-control, mocked client + repository + session): asserts inbound+outbound `saveMessage` happen, `loadTranscript` result is passed into `generateOnboardingReply`, and `managerSwitchOfferSuffix` is appended exactly when `shouldOfferSwitch`.
- Existing `manager-language-switch.test.ts` stays green (proves the live-path extraction is behavior-preserving).

Not unit-tested (acknowledged): the *quality* of anti-repetition (LLM output) — validated by the quality suite / manual WhatsApp, as in Tier A. The unit tests prove the transcript **reaches** the generator.

No DB migration (reuses `conversation_sessions` / `conversation_messages`) → deploy-safe like Tier A.

## Files

- `src/domain/flows/language-switch.ts` — NEW: `hasLanguageSignal`, `resolveTurnLanguage`
- `src/routes/webhook.ts` — onboarding gate rewrite; live manager path refactor to call `resolveTurnLanguage`
- `src/domain/flows/manager-onboarding.ts` — `handleOnboardingMessage` + handlers accept `lang` + `transcript`
- `src/adapters/llm/client.ts` — `generateOnboardingReply` accepts/injects `transcript`
- Tests: `tests/flows/language-switch.test.ts` (new), `tests/flows/onboarding-session-language.test.ts` (new)

## Decisions locked

- Transcript window: **10** turns (live uses 8 customer / 20 manager; onboarding is ~9 steps).
- Keep the §3.4 switch-offer during onboarding (reply in detected language + offer), consistent with live channels.
- `hasLanguageSignal` rule: Hebrew letter ⇒ signal; else require ≥2 Latin word-tokens of ≥2 letters (so brand/single-token answers like `PayPal`, `Bit`, `GO`, `24/7` never flip the language).
- The signal guard lives in the shared resolver, so Branch 3 inherits it too — a safe, conservative improvement (only suppresses flips on no-signal messages).
- Out of scope: owner-gender capture.
