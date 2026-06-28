/**
 * Referential service resolution (Branch 4 lock-in).
 *
 * Customers often don't re-name the service every turn — they say "the one we
 * talked about", "sign me up", or just "yes". When the intent extractor returns
 * no serviceTypeHint, the booking draft would otherwise never capture a service
 * and the flow loops to failure. `inferFocusService` reads the recent transcript
 * (both the customer's and the assistant's turns — the assistant frequently named
 * the service when proposing it) and, when ONE active service is clearly the focus,
 * adopts it. A one-off menu that lists every service (all tied) stays ambiguous.
 *
 * Pure + synchronous: no LLM, no DB. Matching is token-based on the service name so
 * a long canonical name ("סדנת נשימות, כוללת סאונה ואמבטיית קרח") is matched by a
 * natural mention ("סדנת הנשימות").
 */

export interface TranscriptTurnLite {
  role: 'customer' | 'assistant'
  text: string
}

export interface ServiceLite {
  id: string
  name: string
}

// Significant tokens of a service name (≥3 chars, letters/numbers only) — used to
// detect a natural mention without requiring the full canonical string.
function serviceTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 3)
}

/**
 * Did the CUSTOMER themselves reference this service anywhere in the recent
 * transcript? Prior-ASSISTANT mentions don't count.
 *
 * Anti-fabrication, service-fidelity (ANTI_FABRICATION §4.2 — "never trust
 * prior-assistant turns as ground truth"). A service the PA merely *proposed* —
 * e.g. the customer's remembered favourite, surfaced from cross-session
 * "preferred service" memory ("yoga as usual?") — must be AFFIRMED by the
 * customer before it is locked into a booking. `inferFocusService` reads
 * assistant turns (by design, for referential continuations), so on its own it
 * would launder that proposal back in from the PA's own mouth and book a service
 * the customer never engaged with. Callers use this to refuse to lock the
 * remembered favourite unless the customer actually raised it this conversation.
 */
export function customerReferencedService<T extends ServiceLite>(
  transcript: TranscriptTurnLite[],
  service: T,
  recentTurns = 8,
): boolean {
  const tokens = serviceTokens(service.name)
  if (tokens.length === 0) return false
  return transcript
    .slice(-recentTurns)
    .some((t) => t.role === 'customer' && tokens.some((tok) => t.text.toLowerCase().includes(tok)))
}

export function inferFocusService<T extends ServiceLite>(
  transcript: TranscriptTurnLite[],
  services: T[],
  recentTurns = 8,
): T | null {
  if (services.length === 0) return null
  if (services.length === 1) return services[0]!

  const recent = transcript.slice(-recentTurns).map((t) => t.text.toLowerCase())
  if (recent.length === 0) return null

  // Count how many turns reference each service. A one-off menu turn lists every
  // service once (all tied → ambiguous), but a service that is actually the focus
  // of the conversation is referenced across multiple turns → strict maximum wins.
  const counts = services.map((s) => {
    const tokens = serviceTokens(s.name)
    const turns = recent.filter((line) => tokens.some((tok) => line.includes(tok))).length
    return { service: s, turns }
  })

  const max = Math.max(...counts.map((c) => c.turns))
  if (max === 0) return null
  const leaders = counts.filter((c) => c.turns === max)
  return leaders.length === 1 ? leaders[0]!.service : null
}
