/**
 * Gate 7 — WARN-ONLY bot-tell lint over the TEMPLATED string surface.
 *
 * WHY THIS EXISTS
 * `detectBotTells` (voice-guard.ts) only runs on LIVE LLM replies routed through
 * `makeGenReply` / the orchestrator. The i18n catalog (`src/domain/i18n/t.ts`),
 * the WhatsApp message-template catalog (`src/adapters/whatsapp/templates.ts`),
 * and the `managerSwitchOfferSuffix` helper BYPASS that path entirely — they are
 * never checked. This test sweeps the deterministic detectors over EVERY
 * customer/owner-facing templated string, in both `he` and `en`, so structural
 * bot-tells in templates surface in CI logs.
 *
 * WARN-ONLY (owner-confirmed decision)
 * This test MUST NOT fail CI on the existing, known template debt. It emits a
 * structured `console.warn('[voice-i18n-lint] …', …)` report and asserts only
 * that the lint RAN. The flip-to-blocking is a single-line uncomment (see the
 * `// TODO(WS9)` marker near the end) and lands as a WS9 closing step once the
 * allowlisted strings below are cleaned.
 *
 * KNOWN_PENDING below is the ACTUAL set of offenders the current detectors flag,
 * split into:
 *   • TODO(WS9)/TODO(WS4)  — genuine bot-tells owned by a later workstream.
 *   • FALSE-POSITIVE(...)  — detector calibration traps (embedded brand/technical
 *                            tokens tripping bilingual_leak; intentional two-part
 *                            owner/onboarding strings tripping stacked_questions;
 *                            non-availability owner strings tripping dead_end).
 *                            These are NOT real voice failures — noted for the log,
 *                            NOT a source change (voice-guard.ts is not touched).
 */
import { describe, it, expect } from 'vitest'
import { i18n, managerSwitchOfferSuffix, type Lang } from '../i18n/t.js'
import { WA_TEMPLATES } from '../../adapters/whatsapp/templates.js'
import { detectBotTells, type BotTell } from './voice-guard.js'

const LANGS: readonly Lang[] = ['he', 'en']

interface Offender {
  key: string
  lang: string
  tells: BotTell[]
  excerpt: string
}

/**
 * Resolve a catalog entry to its static skeleton string. Simple string entries are
 * returned as-is; function entries (interpolated templates) are invoked with neutral
 * placeholder args so the STATIC skeleton (the literal copy around the holes) is linted.
 * `'1'` is used for the placeholder so numeric-arg branches (e.g. `n === 1 ? … : …`)
 * resolve deterministically rather than throwing.
 */
function resolveSkeleton(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw
  if (typeof raw === 'function') {
    try {
      const fn = raw as (...args: unknown[]) => unknown
      const args = Array.from({ length: fn.length }, () => '1')
      const out = fn(...args)
      if (typeof out === 'string') return out
    } catch {
      // Non-string / arg-shape mismatch → skip (cannot statically lint).
      return undefined
    }
  }
  return undefined
}

/** Lint a single resolved string; push an Offender if any tell fires. */
function lintString(key: string, lang: string, s: string | undefined, into: Offender[]): void {
  if (!s) return
  const tells = detectBotTells(s)
  if (tells.length > 0) into.push({ key, lang, tells, excerpt: s.slice(0, 100) })
}

/**
 * Sweep the entire templated surface and return every offending string.
 * Surfaces covered:
 *   1. i18n catalog (`i18n` = the `strings` record), he + en, strings + interpolated.
 *   2. `managerSwitchOfferSuffix(lang)` helper (not in the record), he + en.
 *   3. WhatsApp template catalog bodies (he only today; en when present).
 */
function lintTemplateSurface(): Offender[] {
  const offenders: Offender[] = []

  // 1. i18n catalog
  for (const [key, entry] of Object.entries(i18n)) {
    const rec = entry as Record<string, unknown>
    for (const lang of LANGS) {
      lintString(`i18n.${key}`, lang, resolveSkeleton(rec[lang]), offenders)
    }
  }

  // 2. managerSwitchOfferSuffix helper
  for (const lang of LANGS) {
    lintString('managerSwitchOfferSuffix', lang, managerSwitchOfferSuffix(lang), offenders)
  }

  // 3. WhatsApp template catalog. Bodies use {{n}} positional holes (no runtime fn) —
  //    the static body copy is linted as-is. en is optional per template.
  for (const [name, def] of Object.entries(WA_TEMPLATES)) {
    const bodies = (def as { bodies: { he: string; en?: string } }).bodies
    lintString(`wa_template.${name}`, 'he', bodies.he, offenders)
    lintString(`wa_template.${name}`, 'en', bodies.en, offenders)
  }

  return offenders
}

/**
 * The ACTUAL offenders the current detectors flag (recorded by running the sweep,
 * 2026-06-29). Each is annotated with its disposition:
 *   • TODO(WS9) / TODO(WS4): a genuine bot-tell, owned by a later workstream.
 *   • FALSE-POSITIVE(detector): a detector calibration trap — NOT a real voice
 *     failure. NOT fixed here (voice-guard.ts is not in scope for this task).
 *
 * Keys are `${surface}.${key}::${lang}`.
 */
const KNOWN_PENDING: ReadonlySet<string> = new Set([
  // ── F4 — language-switch offer suffix (WS9) ─────────────────────────────────
  'managerSwitchOfferSuffix::he', // TODO(WS9): split-gender "כתוב/י כן"
  'managerSwitchOfferSuffix::en', // TODO(WS9): "Reply YES" yes/no menu

  // ── F7 — split-gender Hebrew templates (WS9) ────────────────────────────────
  'i18n.apply_service_mode_class_no_series::he', // TODO(WS9): "תגיד/י"
  'i18n.calendar_owner_reconcile_gate::he',      // TODO(WS9): "השב/י" (+ bilingual brand FP)
  'i18n.unlisted_contact_forward::he',           // TODO(WS9): "השב/י"
  'i18n.owner_change_cancelled::he',             // TODO(WS9): "ביטל/ה"
  'i18n.owner_change_moved::he',                 // TODO(WS9): "העביר/ה"
  'i18n.outreach_reply_notify::he',              // TODO(WS9): "הגיב/ה"
  'i18n.approval_request_owner::he',             // TODO(WS9): "מבקש/ת"
  'i18n.approval_resolved_confirmed_owner::he',  // TODO(WS9): "אותו/ה"
  'i18n.approval_resolved_declined_owner::he',   // TODO(WS9): "הוא/היא"

  // ── F7 — split-gender in the WhatsApp template catalog (WS9) ─────────────────
  // Meta-approved template bodies (templates.ts) with split-gender verb forms.
  'wa_template.payment_dunning_2::he',        // TODO(WS9): "תוכל/י"
  'wa_template.subscription_renewal_7d::he',  // TODO(WS9): "תרצה/י"
  'wa_template.subscription_renewal_1d::he',  // TODO(WS9): "תרצה/י"
  'wa_template.review_request::he',           // TODO(WS9): "תוכל/י"
  'wa_template.contact_meeting_outreach::he', // TODO(WS9): "מדבר/ת", "העוזר/ת"
  'wa_template.reschedule_favor_request::he', // TODO(WS9): "תוכל/י"

  // ── FALSE-POSITIVE(bilingual_leak) — embedded brand / technical tokens ───────
  // Hebrew copy with a ≥4-letter Latin run that is a brand, product, loanword, or
  // internal field-name NOT in voice-guard's BILINGUAL_ALLOWLIST. These are NOT
  // bilingual leaks — they are intentional embedded proper nouns. Detector
  // calibration finding only; voice-guard.ts deliberately not modified here.
  'i18n.mm_ask_timezone::he',          // FALSE-POSITIVE(bilingual_leak): "IANA", "Asia/Jerusalem"
  'i18n.mm_bad_timezone::he',          // FALSE-POSITIVE(bilingual_leak): IANA names
  'i18n.mm_ask_calendar_mode::he',     // FALSE-POSITIVE(bilingual_leak): "Google Calendar"
  'i18n.mm_ask_calendar::he',          // FALSE-POSITIVE(bilingual_leak): "Google Calendar ID"
  'i18n.mm_no_number_linked::he',      // FALSE-POSITIVE(bilingual_leak): "Business Integrations"
  'i18n.mm_waba_guide_type::he',       // FALSE-POSITIVE(bilingual_leak): "Meta Business Manager"
  'i18n.mm_case3a_link::he',           // FALSE-POSITIVE(bilingual_leak): "Meta Business Manager"
  'i18n.mm_business_suite::he',        // FALSE-POSITIVE(bilingual_leak): "Meta Business Suite"
  'i18n.ob_payment::he',               // FALSE-POSITIVE(bilingual_leak): "PayPal" (+ stacked, see below)
  'i18n.ob_payment_method_ask::he',    // FALSE-POSITIVE(bilingual_leak): "PayPal"
  'i18n.ob_calendar::he',              // FALSE-POSITIVE(bilingual_leak): "Google Calendar"
  'i18n.ob_calendar_internal::he',     // FALSE-POSITIVE(bilingual_leak): "Google Calendar"
  'i18n.ob_complete::he',              // FALSE-POSITIVE(bilingual_leak): "STATUS"/"UPCOMING"/"PAUSE" command tokens
  'i18n.pause_confirm::he',            // FALSE-POSITIVE(bilingual_leak): "RESUME" command token
  'i18n.status_payments_connected::he',// FALSE-POSITIVE(bilingual_leak): "Grow" (payment provider)
  'i18n.status_resume_hint::he',       // FALSE-POSITIVE(bilingual_leak): "RESUME" command token
  'i18n.escalation_manager_notify::he',// FALSE-POSITIVE(bilingual_leak): "HANDLED" command token
  'i18n.ob_verify_calendar_google::he',// FALSE-POSITIVE(bilingual_leak): "Google Calendar"
  'i18n.ob_calendar_connected::he',    // FALSE-POSITIVE(bilingual_leak): "Google Calendar"
  'i18n.apply_set_hours_requires_times::he',  // FALSE-POSITIVE(bilingual_leak): internal field names "openTime"/"closeTime" (dev-facing error)
  'i18n.apply_set_hours_requires_target::he', // FALSE-POSITIVE(bilingual_leak): internal field names "dayOfWeek"/"specificDate" (dev-facing error)
  'i18n.calendar_auth_expired::he',    // FALSE-POSITIVE(bilingual_leak): "Google Calendar"
  'i18n.calendar_mirror_divergence::he',// FALSE-POSITIVE(bilingual_leak): "Google Calendar"
  'i18n.pause_conv_confirm::he',       // FALSE-POSITIVE(bilingual_leak): "Meta Business Suite"

  // ── FALSE-POSITIVE(stacked_questions) — intentional two-part strings ─────────
  // Deliberate two-question onboarding / owner-decision copy. Not a bot-tell stack;
  // the second question is a conditional follow-up the human flow expects.
  'i18n.ob_payment::en',                  // FALSE-POSITIVE(stacked_questions): onboarding "pay? if yes, method?"
  'i18n.freed_slot_ask_first_time::he',   // FALSE-POSITIVE(stacked_questions): owner offer + opt-in-automation
  'i18n.freed_slot_ask_first_time::en',   // FALSE-POSITIVE(stacked_questions): owner offer + opt-in-automation

  // ── FALSE-POSITIVE(dead_end) — non-availability owner/paused strings ─────────
  'i18n.pause_conv_ambiguous::he',     // FALSE-POSITIVE(dead_end): "לא מצאתי לקוח" is not-found w/ forward step "נסה שם אחר"
  'i18n.pa_paused_customer::en',       // FALSE-POSITIVE(dead_end): "not available … we'll be in touch" — has forward step the detector doesn't recognise
])

const offenderId = (o: Offender): string => `${o.key}::${o.lang}`

describe('voice-i18n-lint — WARN-ONLY bot-tell sweep over templated strings (Gate 7)', () => {
  it('runs the detectors over the i18n + WhatsApp template surface and reports (never fails)', () => {
    const offenders = lintTemplateSurface()

    // Structured report → surfaces every template bot-tell in CI logs.
    console.warn('[voice-i18n-lint] template bot-tell report (WARN-ONLY — does not fail CI)', {
      total: offenders.length,
      offenders: offenders.map((o) => ({ key: o.key, lang: o.lang, tells: o.tells, excerpt: o.excerpt })),
    })

    // New-offender guard: anything NOT on the KNOWN_PENDING allowlist is a string a
    // later change introduced. Logged LOUDLY and separately so a reviewer notices,
    // but — per the owner warn-only decision — it does NOT fail the build yet.
    const newOffenders = offenders.filter((o) => !KNOWN_PENDING.has(offenderId(o)))
    if (newOffenders.length > 0) {
      console.warn(
        '[voice-i18n-lint] ⚠️ NEW template bot-tell(s) NOT on the WS9/WS4 allowlist — please review',
        { newOffenders: newOffenders.map((o) => ({ id: offenderId(o), tells: o.tells, excerpt: o.excerpt })) },
      )
    }

    // TODO(WS9): when WS9/WS4 have cleaned the allowlisted strings, flip this to blocking:
    // expect(newOffenders, 'new customer/owner-facing string introduced a bot-tell').toEqual([])

    // WARN-ONLY: assert only that the lint RAN and produced a report array.
    expect(Array.isArray(offenders)).toBe(true)
  })

  it('the allowlist is honest — every KNOWN_PENDING id is an offender the detectors actually flag', () => {
    // Guard against allowlist rot: a stale entry that no longer fires means the string
    // was cleaned (or its key changed) and should be pruned. WARN-ONLY — never fails.
    const live = new Set(lintTemplateSurface().map(offenderId))
    const stale = [...KNOWN_PENDING].filter((id) => !live.has(id))
    if (stale.length > 0) {
      console.warn('[voice-i18n-lint] ℹ️ stale KNOWN_PENDING entries (no longer flagged — prune when cleaning):', stale)
    }
    expect(Array.isArray(stale)).toBe(true)
  })
})
