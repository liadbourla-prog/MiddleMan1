/**
 * Pure operator-channel command parsers — kept dependency-free so they unit-test without the
 * operator handler's heavy module graph (redis, LLM client, db).
 */

export interface ManagerChannelCommand {
  mode: 'central' | 'own_number'
  target: string // business name or WhatsApp number
}

/**
 * Parse the operator's manager-channel switch:
 *   `CHANNEL CENTRAL <business>`  / `ערוץ מרכזי <עסק>`  → opt the business into the central channel
 *   `CHANNEL OWN <business>`      / `ערוץ עצמי <עסק>`   → revert to managing on its own PA number
 * `<business>` is a business name (fuzzy) or its WhatsApp number. Returns null when the text is
 * not a channel command.
 */
export function parseManagerChannelCommand(text: string): ManagerChannelCommand | null {
  const t = text.trim()
  const m = t.match(/^CHANNEL\s+(CENTRAL|OWN)\s+(.+)$/i) ?? t.match(/^ערוץ\s+(מרכזי|עצמי)\s+(.+)$/)
  if (!m) return null
  const mode: 'central' | 'own_number' = /central|מרכזי/i.test(m[1]!) ? 'central' : 'own_number'
  return { mode, target: m[2]!.trim() }
}
