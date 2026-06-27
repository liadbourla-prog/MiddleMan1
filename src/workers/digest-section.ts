import { type Lang } from '../domain/i18n/t.js'
import { type DigestRow } from '../domain/initiations/digest-queue.js'

/** Render buffered digest items into a briefing section. Pure (rows already have rendered summaries). */
export function buildDigestSection(rows: DigestRow[], lang: Lang): { section: string; ids: string[] } {
  if (rows.length === 0) return { section: '', ids: [] }
  const header = lang === 'he' ? '🗒️ *שינויים מאז העדכון האחרון:*' : '🗒️ *Changes since your last update:*'
  const lines = rows.map((r) => `• ${r.payload.summary}`).join('\n')
  return { section: `${header}\n${lines}`, ids: rows.map((r) => r.id) }
}
