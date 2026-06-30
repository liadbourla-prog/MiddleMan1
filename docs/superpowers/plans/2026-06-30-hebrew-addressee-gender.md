# Hebrew Addressee-Gender — Implementation Plan (TDD, Subagent-Driven)

> **For agentic workers:** REQUIRED SUB-SKILL — execute with `superpowers:subagent-driven-development`. Each task is TDD: write the failing test → implement → green → `tsc` + targeted lint → commit. Tasks use checkbox (`- [ ]`) syntax. One subagent per task; obey the hot-file serialization rules or you WILL get merge conflicts.

**Goal:** Make the PA address each person in the **grammatically correct Hebrew gender** (male vs female second-person) across all four branches and the proactive/worker surfaces — replacing today's blanket "always masculine" rule — **without regressing** the four guarantees (G1/G4/G5/C-PIVOT), the anti-fabrication gates, or the human voice, and **without re-introducing** split-gender hedging (the very tell the voice-guard already bans).

**Standard:** This plan inherits the bar set by `docs/superpowers/plans/2026-06-28-pa-hardening-master-plan.md` — per-task `Problem · Root · Files · TEST-FIRST · Implement · Acceptance · Commit`, the DO-NOT-REGRESS attestation, the VOICE GATE, the seven-gate model, migration-with-backfill discipline, and hot-file serialization.

**Primed against:** `CLAUDE.md`, `ARCHITECTURE.md` (Parts 1, 2, 6, 8, 16), `CHAT_LEVEL_LAWBOOK.md` (§3, §9–14 Voice Bible), `CALENDAR_UX_DESIGN.md`, `src/adapters/llm/voice.ts`, and the PA Hardening Master Plan (esp. **WS9-T9.5 F4/F7** and **WS-VOICE / `voice-guard.ts`**, which this plan layers on top of).

**Tech stack:** TypeScript (ESM, `.js` import specifiers), Drizzle ORM (Postgres), Redis (locks), Vitest, Gemini via Vertex. tz `Asia/Jerusalem`. Read-only prod DB via the cloud-sql-proxy snapshot — **never mutate prod**.

**Test commands:** single file `npx vitest run <path>`; full suite `npm test`; types `npx tsc --noEmit`; lint `npx eslint <path>`.

---

## LIVE-STATE RECONCILIATION (verified 2026-06-30, after hardening WS1–4 + voice merged)

This plan was first drafted against the pre-merge codebase. The hardening waves have since landed; the deltas below are authoritative and override any stale reference later in this doc.

1. **Unified gate at three doors.** `grounding/output-gate.ts:gateReply()` is the one anti-fabrication gate; Branch 4's `makeGenReply` now *delegates* Gates 1/2/3 to it, and it also runs at Branch 3 (`orchestrator.ts`) and the proactive seam (`initiations/`). It calls `observeVoiceTells` (`voice-guard.ts:229`) at **every exit**, and `hasSplitGender` is one of its monitor detectors. **Consequence:** split-gender is ALREADY enforced (monitor-only) at all three doors — this plan adds **no** new gate/detector wiring for it; the female path must simply keep `hasSplitGender` green (it picks the single feminine form).
2. **The chokepoint is untouched by the gate refactor.** `voice.ts:39` still hardcodes masculine; `buildVoiceCore(channel)` is still single-arg (line 55). The gate inspects *output*; addressee gender is applied at *prompt construction* (`buildVoiceCore`), which is **upstream** of `makeGenReply`/`gateReply`. §4.4 stands exactly.
3. **The T3.1 intent-flag pattern is merged and is the template to copy.** Extractor flags use `z.<...>().optional().catch(undefined)` (`client.ts:104-106`), a JSON-output-template line (`:156-180`), and a descriptive rule (`:203-205`); `joinWaitlist` is the latest instance. `selfGenderEvidence` follows this exact triple — and **no longer waits on T3.1** (done). It is an enum, so: `z.enum(['male','female','none']).optional().catch('none')`.
4. **Branch 3 central-number ingress is merged** (`identity/central-manager.ts:findCentralManagedBusinessForOwner`). Own-number and central both resolve to the same `manager` identity, so reading `identities.addresseeGender` covers both ingresses — **no fork** (honors the one-manager-brain rule).
5. **Migration number = `0055`.** `main` is at `9516a8f`; latest migration is `0054_business_address` (merged after central-channel). **Branch the gender work from `main`** — the in-progress `dev/system/waitlist-join-accept` branch carries its own uncommitted `0053` and must not be the base.

---

## 0. The four locked decisions (owner-confirmed 2026-06-30)

1. **Unknown gender → masculine.** Masculine singular is the safe floor whenever gender is unresolved. (Preserves today's behavior exactly — see "behavior-preserving refactor first," §4.)
2. **Name signal = BOTH.** Ship a static, offline Hebrew name→gender dictionary AND self-morphology inference from the sender's own Hebrew. Two independent producers feeding one resolver.
3. **Capture the owner's name + gender at onboarding.** The owner identity is currently created as a generic `displayName: 'Owner'` with no gender (`provider-onboarding.ts:516-517`). Start capturing both.
4. **WhatsApp templates stay gender-neutral.** Meta-approved template bodies are NOT branched into male/female variants. Free-form (LLM) proactive sends carry gender; templated sends remain neutral and must keep passing the voice-i18n gender lint.

---

## 1. Why this is low-risk: two separate gender axes, one chokepoint

There are **two distinct gender concerns** in the codebase. Do not conflate them.

| Axis | Controls | Where today | This plan |
|---|---|---|---|
| **Bot persona gender** | how the PA refers to **itself** | `businesses.botPersona` → `client.ts:474-478` | **Untouched.** Stays a separate, business-level axis. |
| **Addressee gender** | how the PA speaks **to the person** (2nd-person) | hardcoded masculine at `voice.ts:39` | **This is the whole plan.** Becomes a resolved per-identity attribute. |

`buildVoiceCore(channel)` is the **single chokepoint**: its `VOICE_CORE` body holds the `ADDRESSING` line (`voice.ts:39`), and it is injected at **13 call sites** (`client.ts` ×11 covering every branch + `orchestrator.ts` ×1 + its own def). Parameterizing `buildVoiceCore(channel, addresseeGender)` and threading the resolved gender to those sites is the entire surface for *applying* gender. Everything else is *resolving* it.

**Architectural home (mirror language):** ARCHITECTURE cross-branch invariant #3 says *"Language is always resolved before the LLM is called."* Addressee gender gets the exact same treatment — **resolved before any addressing LLM call**, as a sibling of `resolveTurnLanguage`. The resolution lives in Gate 1 (routing/identity); the self-morphology signal is harvested for free in Gate 4 (intent); the application is Gate 7 (voice).

---

## 2. DO-NOT-REGRESS (every task keeps these green)

1. **G1/G4/G5/C-PIVOT** — gender is a pure *phrasing* axis. No booking, availability, intent-routing, or grounding logic is touched. Each PR attests "G1/G4/G5/C-PIVOT regression checked" with test evidence.
2. **No split-gender, ever.** `voice-guard.ts:hasSplitGender` and the `voice-i18n-lint` suite stay green. The female path picks the **single feminine form** — it never emits `תרצה/תרצי`. (The female path is held to the same anti-split-gender bar as the male path.)
3. **WS9-T9.5 baseline (F4/F7).** That hardening task normalizes templates/switch-offers to **masculine-singular** and removes split-gender + formal-plural. This plan **builds on that baseline**: masculine-singular is our "unknown" floor; we add the feminine path on top. Do not undo WS9; coordinate if it is mid-flight (see §7).
4. **`botPersona` unchanged.** The bot's self-voice axis behaves identically; addressee gender is additive and orthogonal.
5. **Masculine default preserved when unknown** (decision 1) — pinned by an explicit regression test.

## 3. VOICE GATE (mandatory on every task touching an addressing string or prompt)

1. Output complies with `CHAT_LEVEL_LAWBOOK.md` §1–8 (format) and §9–14 (Voice Bible): first-person, warm, varied, one question, no IVR menu, no bilingual leak, no grovel, always a next step — **and now, gender-correct**.
2. Add/update a **golden-transcript assertion** (representative He) checking *shape*: a known-female addressee gets feminine 2nd-person; a known-male gets masculine; **unknown gets masculine**; **none of the three contains split-gender**. En is unaffected (no grammatical gender).
3. PR description includes a 3-line voice check: before/after of one representative He reply, confirming it reads human AND gender-correct.

---

## 4. Design

### 4.1 Data model — two nullable columns on `identities`

```
addresseeGender        text enum('male','female')                              | null   -- null = unknown
addresseeGenderSource  text enum('explicit','self_morphology','name','default')| null   -- provenance for precedence + audit
```

- **Both nullable, no constraint** → migration is low-risk: no backfill, no NOT NULL, no VALIDATE pass. Still obeys §v2-A2 discipline (one `drizzle-kit generate`, committed before any other schema task). **Next migration = `0055`** (latest is `0053_manager_channel`).
- **Precedence (higher rank wins; never silently downgrade):** `explicit (4) > self_morphology (3) > name (2) > default (1)`. A new signal overwrites the stored value only when its rank ≥ the stored source's rank (equal-rank `self_morphology` → latest/higher-confidence wins). This lets a customer's own Hebrew (rank 3) correct a name guess (rank 2), and lets the owner's explicit `setCustomerGender` (rank 4) lock it.

### 4.2 Resolution module — `src/domain/identity/addressee-gender.ts` (new)

Pure resolver, no IO:
```
resolveAddresseeGender({
  stored, storedSource,          // current identity row
  nameSignal,                    // 'male'|'female'|null   (from 4.3a)
  morphologySignal,              // 'male'|'female'|null   (from 4.3b)
}): { gender: 'male'|'female', source: Source } | null   // null = still unknown
```
Returns the winning (gender, source) by precedence, or `null` when nothing resolves. Consumers **persist** only when the result outranks (or refreshes same-rank) the stored row. Application code treats `null` as masculine (decision 1) but **does not write** `'male'/default` to the column on a guess — unknown stays unknown in storage so a later real signal can still win. (Optional: writing `source='default'` is allowed but never blocks a higher rank.)

### 4.3 The two signal producers

**(a) Static offline name dictionary — `src/domain/identity/hebrew-name-gender.ts` (new, shared, deterministic, no LLM/network).**
`genderFromName(displayName): 'male'|'female'|null`. Takes the first whitespace token, normalizes (strip niqqud/punctuation, NFC), looks up a curated Hebrew given-name → gender map (seed from Israeli CBS given-name frequency lists, shipped as a static TS/JSON map). **Unisex names (גל, שיר, רותם, עדן, אופיר, טל, …) return `null`** — never guess. Medium confidence (rank 2).

**(b) Self-morphology — piggyback on the existing intent-extraction LLM call (zero extra latency/cost).**
A Hebrew speaker's own 1st-person verbs/adjectives self-declare gender (*"מעוניינת / צריכה / גרה"* fem vs *"מעוניין / צריך / גר"* masc). Add a `selfGenderEvidence` field following the **merged T3.1 triple** (the established convention — see reconciliation #3): `z.enum(['male','female','none']).optional().catch('none')` in the Zod schema (alongside `client.ts:104-106`), a line in the JSON output template (`client.ts:156-180`), AND a descriptive rule (`client.ts:203-205`) — a schema field absent from the template is inert (the T3.1/K0 lesson). Default `'none'`. Add the same field to:
- the `extractCustomerIntent` structured output (the customer path);
- the Branch-3 orchestrator's per-turn signal (owner self-morphology).
Instruction: *"From the SENDER's own first-person Hebrew only, infer their grammatical gender; 'none' if they used no gendered self-reference. This is the person texting, not anyone they mention."* High confidence (rank 3).

### 4.4 Application — the parameterized chokepoint

`buildVoiceCore(channel, addresseeGender: 'male'|'female'|null)`. Replace the fixed `ADDRESSING` line (`voice.ts:39`) with:
- **female** → *"address in feminine singular second-person (פנייה בלשון נקבה). Pick the single feminine form; NEVER split-gender (not תרצה/תרצי)."*
- **male OR null** → *"address in masculine singular second-person (פנייה בלשון זכר). Pick the single masculine form; NEVER split-gender."* (unknown → masculine, decision 1)

Thread `addresseeGender` to all 13 call sites. For `generateCustomerReply` (which composes `PA_PERSONA_TEMPLATE` + `botPersona` `personaNotes`, separate from the voice core), inject the **addressee**-gender note alongside the existing **persona** note — two independent axes in one prompt. A discovery sub-task (T0.2) enumerates every prompt builder that addresses a person to guarantee none is missed.

### 4.5 Per-branch wiring

| Branch | Addressee | Gender source | Notes |
|---|---|---|---|
| **4 — Customer** | the customer | name (4.3a) + self-morphology (4.3b) + owner `setCustomerGender` | Primary beneficiary. Resolve before `generateCustomerReply`; pass `addresseeGender`. |
| **3 — Manager/owner** | the owner | owner's stored gender (seeded at onboarding) + owner self-morphology | Thread into `orchestrator.ts:buildSystemPrompt` (the `buildVoiceCore('manager')` site). Reading `identities.addresseeGender` covers **both** own-number and central-number ingress (reconciliation #4) — one manager identity, no fork. |
| **2 — Onboarding** | the prospect/owner | self-morphology of first Hebrew messages | **Seeds owner gender** (+ name, decision 3). `generateProviderOnboardingReply`. |
| **1 — Operator** | the platform operator | env/config constant `OPERATOR_GENDER` (default `male`) | One known human; lowest stakes. |
| **Workers / proactive** | the customer | read `identities.addresseeGender` | Free-form LLM sends pass gender; **Meta templates stay neutral** (decision 4). |

### 4.6 Owner correction + onboarding capture

- **`setCustomerGender` tool (Branch 3)** — sibling of `setCustomerName`; writes `addresseeGender` with `source='explicit'` (rank 4, locks it). Lets the owner fix any misread. Emits an `audit_log` row (Principle 7 + lawbook §7.4 tool-contract).
- **Onboarding (decision 3)** — capture the owner's real name (today discarded) and infer gender from their Branch-2 Hebrew; persist both to the `manager` identity at/after provision (`provider-onboarding.ts:516`). Falls back to masculine until resolved.

---

## 5. The seven gates — where gender lives

| Gate | Role for gender |
|---|---|
| 1 — Routing & identity | **Resolve** `addresseeGender` here (sibling of `resolveTurnLanguage`). Invariant: gender resolved before any addressing LLM call. |
| 4 — Intent | **Harvest** `selfGenderEvidence` (free, rides the extractor). |
| 7 — Voice | **Apply** via `buildVoiceCore`; `hasSplitGender` stays as the deterministic floor (female path must also pass it). Monitor-only per WS-VOICE re-scope — no new reply mutation. |

**Non-bypass invariant (add as test):** every customer/owner-facing addressing prompt is built through `buildVoiceCore(channel, addresseeGender)` — no addressing reply path constructs the masculine line by hand.

---

## 6. Migration & hot-file discipline

- **One migration (`0055`), committed before any other schema-touching task.** Both columns nullable → no backfill.
- **Hot files (serialize against each other AND against in-flight feature branches):** `voice.ts` (chokepoint), `client.ts` (extractor template + `generateCustomerReply` + 11 voice-core sites), `orchestrator.ts` (Branch 3), `customer-booking.ts` (Branch 4 wiring), `provider-onboarding.ts` (Branch 2 + owner capture), `schema.ts` (migration). The hardening WS3/WS5/WS-VOICE work has **merged** (reconciliation #1); the live contention is now the open `dev/system/waitlist-join-accept` branch, which also edits `client.ts`/`customer-booking.ts`/`orchestrator.ts` — branch from `main` and rebase/coordinate so the two don't collide on these files.
- The `selfGenderEvidence` field rides the now-merged `client.ts` extractor template (schema `:104-106`, template `:156-180`, rule `:203-205`). **No sequencing wait** — copy the established T3.1 triple (reconciliation #3).

---

## 7. Sequencing

1. **Phase 0 (foundation, behavior-preserving):** branch from `main`; schema `0055`; resolver; name dictionary; `selfGenderEvidence` in extractor + orchestrator; `buildVoiceCore(channel, addresseeGender)` parameterization **defaulting to masculine**. After Phase 0 the system behaves **identically to today** (unknown → masculine everywhere) — this de-risks the refactor: it ships and proves no regression *before* any female output is possible.
2. **Phase 1 (activate per-branch):** wire real resolution into Branch 4 → Branch 3 → Branch 2 (owner capture) → operator constant → worker free-form sends. The female path goes live branch by branch, each behind its own golden suite.
3. **Phase 2 (polish & docs):** `CHAT_LEVEL_LAWBOOK.md §3.5` (gender rules) + update the §3.4 switch-offer to be gender-aware; make `voice-i18n-lint` female-aware; broaden the golden set; precedence/correction edge tests.

> **Coordinate with live branches:** the hardening WS3/WS5/WS-VOICE work has merged (reconciliation #1), so the unified gate + extractor pattern are stable to build on. **WS9-T9.5 (F4/F7 — masculine-singular template/switch-offer baseline) is the remaining hardening dependency**: it establishes the clean baseline this plan extends, so let it land first where possible. The active collision risk is the open `dev/system/waitlist-join-accept` branch on `client.ts`/`customer-booking.ts`/`orchestrator.ts`.

---

# PHASE 0 — Foundation (behavior-preserving)

- [x] **T0.1 — DO-NOT-REGRESS pin (FIRST).** Identify/extend the G1/G4/G5/C-PIVOT regression files and add one assertion that the **current** masculine-default behavior is captured (a He reply to an unknown-gender customer is masculine-singular, no split-gender). The per-PR attestation references these files. Commit: `test(regression): pin masculine-default addressing as the unknown floor`.

- [ ] **T0.2 — Addressing-surface discovery (no code).** Enumerate every prompt builder that addresses a person: the 13 `buildVoiceCore` sites + `generateCustomerReply` persona path + `generateProviderOnboardingReply` + any worker free-form send. Produce the definitive file/line list the Phase-1 wiring tasks consume. Output: a short appendix appended to this plan. (No commit, or `docs(gender): addressing-surface inventory`.)

- [x] **T0.3 — Schema `0055`: addressee-gender columns (MIGRATION, serialize first).** Add `addresseeGender` + `addresseeGenderSource` to `identities` in `schema.ts` as `text(..., { enum })` columns (matching `preferredLanguage`, not native PG enums), both nullable. **Hand-author** `src/db/migrations/0055_addressee_gender.sql` following the house style (header comment + `ALTER TABLE identities ADD COLUMN IF NOT EXISTS addressee_gender text;` / `... addressee_gender_source text;`, idempotent). Do NOT run `drizzle-kit generate` (journal frozen — see migrations/README.md); applied by `npm run db:apply`. **TEST-FIRST:** a migration/schema test asserting both columns exist, nullable, with the enum domains. No backfill (nullable). Commit: `feat(schema): addressee_gender + source on identities (nullable)`.

- [x] **T0.4 — Name dictionary `hebrew-name-gender.ts` (pure, offline).** `genderFromName(displayName)` → first-token normalize + curated map; unisex → `null`. **TEST-FIRST:** masc names → 'male', fem names → 'female', unisex (גל/שיר/רותם/עדן/אופיר) → null, empty/English/emoji → null. No LLM, no network. Commit: `feat(identity): offline Hebrew name→gender dictionary`.

- [x] **T0.5 — Pure resolver `addressee-gender.ts`.** `resolveAddresseeGender` precedence logic (explicit>self_morphology>name>default; never downgrade; equal-rank morphology refreshes). **TEST-FIRST:** name-only resolves to name+rank2; morphology overrides a stored name; explicit beats all; nothing → null; a lower-rank signal never overwrites a higher stored source. Commit: `feat(identity): addressee-gender precedence resolver`.

- [x] **T0.6 — `selfGenderEvidence` in the extractor (copy the merged T3.1 triple; no wait).** Add `z.enum(['male','female','none']).optional().catch('none')` to the Zod schema (by `client.ts:104-106`), a line to the JSON output template (`:156-180`), AND a descriptive rule (`:203-205`) scoped to the SENDER's own 1st-person Hebrew. **TEST-FIRST:** the field is present in the template (not schema-only), a fem self-reference yields 'female', a masc one 'male', a gender-neutral message 'none', and a *mention of a third party's* gender does NOT leak into it. Commit: `feat(llm): selfGenderEvidence in intent extraction (template + schema + rule)`.

- [x] **T0.7 — deterministic Hebrew self-morphology detector (owner-path producer + customer backstop).** ▶ **RECONCILED:** the Branch-3 orchestrator is a Gemini **function-calling loop** (`runManagerOrchestratorLoop`) with **no per-turn structured output** to carry a `selfGenderEvidence` field — bolting one on would risk the reply path and add a constrained call. The owner path therefore gets a **pure deterministic detector** `inferSelfGenderFromHebrew(text)` in `src/domain/identity/hebrew-self-morphology.ts` (no LLM, no cost, reusable). It requires an explicit first-person pronoun (`אני`/`ואני`/`שאני`/`אנוכי`) within a 3-token window of a curated unambiguous gendered form → `'male' | 'female' | null` (high precision; ambiguous unvocalized forms like `רוצה` excluded; third-party references with no `אני` → null). **Keeps Phase 0 from touching the orchestrator hot file at all** — the orchestrator *consumption* (read owner inbound → resolve → thread into `buildSystemPrompt`) moves to **T1.3**. The detector also serves as a customer-path backstop when the LLM `selfGenderEvidence` returns `'none'` (wired in T1.1 if useful). **TEST-FIRST:** `'אני מעוניינת'`→female, `'אני מעוניין'`→male, `'אני לא בטוח'`→male, `'תשאל אותה אם היא מעוניינת'`→null (no `אני`), `'אני רוצה'`→null (ambiguous), niqqud-stripped, English→null. Commit: `feat(identity): deterministic Hebrew self-morphology detector (T0.7)`.

- [x] **T0.8 — Parameterize `buildVoiceCore(channel, addresseeGender)` — DEFAULT MASCULINE.** Replace the fixed `ADDRESSING` line with the gender-branched text (§4.4); update all 13 call sites to pass `addresseeGender` (Phase-0 callers pass `null`/`'male'` → unchanged output). **TEST-FIRST:** unit test the three branches of the addressing string (male/female/null); a golden test that with `null` the emitted prompt line is **byte-identical to today's masculine line** (behavior-preserving); female branch contains נקבה and no split-gender. **VOICE GATE.** Commit: `refactor(voice): parameterize addressee gender in buildVoiceCore (masculine default)`.

**Phase 0 gate:** full `npm test` + `tsc` green; a smoke check that all branches still produce masculine-singular replies for unknown-gender users (no behavior change).

---

# PHASE 1 — Activate per-branch

- [x] **T1.1 — Branch 4 resolve + apply.** Before `generateCustomerReply`, run `resolveAddresseeGender({stored, name: genderFromName(displayName), morphology: intent.selfGenderEvidence})`; persist on rank gain; pass the resolved gender into the reply (both the voice core and the persona path). **TEST-FIRST:** a known-female customer (by name) gets feminine; a name-unisex customer who writes feminine self-morphology gets feminine and the row is persisted source=self_morphology; an unknown stays masculine; no split-gender in any. **VOICE GATE** (He golden: confirmation + clarification + failure, all three genders). Commit: `feat(branch4): gender-correct customer addressing`.
  - *Hot file `customer-booking.ts` — the hardening WS2/WS3/WS-VOICE chain has merged; coordinate only with the open `dev/system/waitlist-join-accept` branch.*

- [x] **T1.2 — `setCustomerGender` owner tool (Branch 3).** Sibling of `setCustomerName`; writes `addresseeGender` source=`explicit`; emits an `audit_log` row; add to `REPORTABLE_ACTIONS`/`renderAction`. **TEST-FIRST:** owner sets a customer's gender → row updated source=explicit, ledger row written, and a later name/morphology signal does NOT override it. **VOICE GATE** (the confirmation reads human). Commit: `feat(branch3): setCustomerGender owner tool + ledger`.

- [x] **T1.3 — Branch 3 owner self-addressing.** Resolve the owner's own `addresseeGender` (stored + `selfGenderEvidence` from T0.7) and pass it into `buildSystemPrompt`/the `buildVoiceCore('manager')` site. **TEST-FIRST:** a female owner gets feminine 2nd-person from the orchestrator; unknown → masculine. **VOICE GATE.** Commit: `feat(branch3): gender-correct owner addressing`.

- [x] **T1.4 — Branch 2 onboarding owner capture (decision 3).** Capture the owner's name (stop discarding it) and infer gender from Branch-2 Hebrew self-morphology; persist both to the `manager` identity at/after provision (`provider-onboarding.ts:516`); thread `addresseeGender` into `generateProviderOnboardingReply`. **TEST-FIRST:** a female prospect's onboarding replies are feminine once evidence appears; the owner identity stores the captured name + gender; unknown → masculine. **VOICE GATE** (onboarding is non-technical, 1–3 sentences). Commit: `feat(onboarding): capture owner name+gender; gender-correct onboarding voice`.

- [x] **T1.5 — Operator constant (Branch 1).** Add `OPERATOR_GENDER` env (default `male`); pass into the `buildVoiceCore('operator')` sites. **TEST-FIRST:** operator replies honor the configured gender; absent env → masculine. Commit: `feat(operator): configurable operator addressee gender`.

- [x] **T1.6 — Worker / proactive free-form sends.** Free-form (LLM) proactive sends route through the proactive door (`initiations/` → `gateReply`) and `buildVoiceCore('proactive')`; have them read `identities.addresseeGender` and pass it into the reply. **Meta-approved template bodies stay neutral (decision 4)** — assert they remain gender-neutral, NOT branched. **TEST-FIRST:** a free-form reminder to a known-female customer is feminine; a templated send is unchanged and still passes the gender lint. **VOICE GATE.** Commit: `feat(workers): gender-correct free-form proactive sends; templates stay neutral`.

**Phase 1 gate:** full suite green; He golden suites for every branch pass all three genders; masculine-default regression (T0.1) still green.

---

# PHASE 2 — Polish & docs

- [x] **T2.1 — Lawbook §3.5 + gender-aware §3.4.** Add `CHAT_LEVEL_LAWBOOK.md §3.5` (addressee-gender rules: resolve before reply, single correct form, unknown→masculine, never split-gender) and rewrite the §3.4 switch-offer so that once gender is known it is single-gender (removes the existing `כתוב/י כן` split-gender debt — coordinate with WS9-T9.5 F4). Commit: `docs(lawbook): §3.5 addressee gender + gender-aware switch offer`.

- [x] **T2.2 — `voice-i18n-lint` female-awareness.** Extend the lint so the female addressing path is asserted to use a single feminine form (still no split-gender), and keep templates gender-neutral. Flip any pending allowlist entries this plan resolves. **TEST-FIRST.** Commit: `test(voice): female-aware addressing lint; templates stay neutral`.

- [x] **T2.3 — Precedence/correction edge tests + golden breadth.** Adversarial He goldens: name-says-male but morphology-says-female (morphology wins, persists, reply flips next turn); owner explicit override sticks against later signals; mid-session gender flip is handled warmly without re-introducing split-gender. Commit: `test(gender): precedence, correction, and mid-session-flip goldens`.

---

## Cross-cutting deliverables

- [x] **Non-bypass invariant test:** no addressing reply path builds the masculine line by hand — all go through `buildVoiceCore(channel, addresseeGender)`. (`tests/regression/addressing-non-bypass.test.ts`)
- [x] **DO-NOT-REGRESS gate:** G1/G4/G5/C-PIVOT + the masculine-default floor stay green on every PR; `hasSplitGender` never trips on the female path.
- [x] **Docs:** `ARCHITECTURE.md` note that addressee gender is resolved pre-LLM (sibling of language, cross-branch invariant); `CLAUDE.md` one-liner on the two gender axes.

## Out of scope
- Branching Meta-approved WhatsApp **template** bodies into male/female variants (decision 4 — templates stay neutral).
- Plural/formal "you" registers, dual forms, or non-binary Hebrew constructions (binary male/female + unknown→masculine only).
- Changing `botPersona` (the bot's self-voice axis) in any way.
- English output (no grammatical gender).
