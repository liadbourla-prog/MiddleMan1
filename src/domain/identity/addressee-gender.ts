// Addressee-gender precedence resolver — the pure decision core for "which Hebrew
// second-person gender do we address this person in?".
//
// It composes the per-turn signals (a stored value, a first-name guess, and self-morphology
// harvested from the sender's own Hebrew) into a single winning (gender, source) by a fixed
// confidence precedence, or `null` when nothing resolves (→ caller treats null as masculine,
// the unknown floor, but does NOT persist a guess). No IO — callers fetch/persist.
//
// Precedence (higher rank wins; equal-rank → the fresher signal refreshes; a higher stored
// rank is NEVER downgraded by a weaker fresh signal):
//   explicit (4)  — owner's setCustomerGender / the person's own confirmation
//   self_morphology (3) — the sender's first-person Hebrew this/last turn
//   name (2)      — offline first-name dictionary guess
//   default (1)   — a written-down fallback (rarely persisted)

export type AddresseeGender = 'male' | 'female'
export type GenderSource = 'explicit' | 'self_morphology' | 'name' | 'default'

export const SOURCE_RANK: Record<GenderSource, number> = {
  default: 1,
  name: 2,
  self_morphology: 3,
  explicit: 4,
}

export interface ResolveAddresseeGenderInput {
  /** The currently-persisted value on the identity row (null = unknown). */
  stored?: AddresseeGender | null
  storedSource?: GenderSource | null
  /** Fresh first-name dictionary guess this turn (`genderFromName`), or null. */
  nameSignal?: AddresseeGender | null
  /** Fresh self-morphology evidence this turn (`selfGenderEvidence` mapped 'none'→null), or null. */
  morphologySignal?: AddresseeGender | null
}

export interface ResolvedGender {
  gender: AddresseeGender
  source: GenderSource
}

/**
 * Pick the winning (gender, source) by precedence, or null when nothing resolves.
 * Candidates are ordered stored → name → morphology so that, on an equal-rank tie, the
 * fresher signal (pushed later) wins — letting a new self-morphology reading refresh an
 * older one, while a higher stored rank (e.g. explicit) still dominates a weaker fresh one.
 */
export function resolveAddresseeGender(input: ResolveAddresseeGenderInput): ResolvedGender | null {
  const candidates: ResolvedGender[] = []
  if (input.stored && input.storedSource) candidates.push({ gender: input.stored, source: input.storedSource })
  if (input.nameSignal) candidates.push({ gender: input.nameSignal, source: 'name' })
  if (input.morphologySignal) candidates.push({ gender: input.morphologySignal, source: 'self_morphology' })

  if (candidates.length === 0) return null
  let best = candidates[0]!
  for (let i = 1; i < candidates.length; i++) {
    const c = candidates[i]!
    if (SOURCE_RANK[c.source] >= SOURCE_RANK[best.source]) best = c
  }
  return best
}

/**
 * Whether a resolution is worth writing back to the identity row: true only when it is a
 * genuine change (gender or source) AND not a downgrade of the stored confidence. The
 * resolver already guarantees no downgrade, but the rank guard makes the contract explicit
 * and keeps a stray caller honest.
 */
export function shouldPersist(
  stored: AddresseeGender | null,
  storedSource: GenderSource | null,
  resolved: ResolvedGender | null,
): boolean {
  if (!resolved) return false
  if (!stored || !storedSource) return true
  if (SOURCE_RANK[resolved.source] < SOURCE_RANK[storedSource]) return false
  return resolved.gender !== stored || resolved.source !== storedSource
}
