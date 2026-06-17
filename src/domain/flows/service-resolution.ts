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
