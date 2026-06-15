import { detectLang, type Lang } from '../i18n/t.js'

// True only when the text carries a real language signal. Stops low-signal tokens
// onboarding constantly sees — "24/7", "Bit", "GO", times, phone numbers, bare
// digits — from wrongly flipping the conversation language. A Hebrew letter is
// always a signal; otherwise we require at least two Latin word-tokens of >=2
// letters, so single brand/keyword tokens (PayPal, Bit, GO) never trigger a switch.
//
// Deliberate tradeoffs of the two-word threshold:
// - a genuine 1-word English answer ("internal", "Cash", "Yes") will NOT flip the
//   language (false negative) — acceptable, since real English speakers write more;
// - a 2-word English-looking business name ("Apple Music") WILL register as signal
//   (false positive). Both are accepted to keep the rule simple; tightening either
//   re-introduces the other. The §3.4 offer is reversible, so a wrong flip is cheap.
export function hasLanguageSignal(text: string): boolean {
  if (/[֐-׿]/.test(text)) return true
  const latinWords = text.match(/[A-Za-z]{2,}/g)
  return (latinWords?.length ?? 0) >= 2
}

// Branch-3 §3.4 language resolution, extracted so the live manager path and the
// onboarding gate run the identical decision. Pure — no I/O.
// - effectiveOverride: a locked identity preference or session-level override wins.
// - no language signal ⇒ do not flip (treat the turn as the resolved language).
// - offer a switch only when an unlocked turn's detected language differs from default.
export function resolveTurnLanguage(input: {
  body: string
  defaultLang: Lang
  preferredLanguage: Lang | null
  sessionOverride: Lang | undefined
}): { turnLang: Lang; detected: Lang; shouldOfferSwitch: boolean } {
  const effectiveOverride: Lang | undefined = input.preferredLanguage ?? input.sessionOverride
  const detected: Lang = hasLanguageSignal(input.body)
    ? detectLang(input.body)
    : (effectiveOverride ?? input.defaultLang)
  const turnLang: Lang = effectiveOverride ?? detected
  const shouldOfferSwitch = !effectiveOverride && detected !== input.defaultLang
  return { turnLang, detected, shouldOfferSwitch }
}
