import { eq, desc } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { conversationMessages } from '../../db/schema.js'
import type { TranscriptTurn } from '../../adapters/llm/types.js'
import { sanitize } from '../flows/fence.js'

export async function saveMessage(
  db: Db,
  sessionId: string,
  role: 'customer' | 'assistant',
  text: string,
): Promise<void> {
  // Gate-2(i): sanitize customer-authored text at the persistence boundary so the stored
  // transcript (later fed to reply/extractor LLMs via loadTranscript) never carries raw
  // injection text. Assistant replies are NEVER sanitized — they are our own output and
  // sanitizing them could corrupt the stored transcript.
  // NOTE: Part (ii) per-LLM fences at each interpolation site (client.ts, orchestrator.ts,
  // customer-booking.ts) are deferred to those files' own task chains.
  const storedText = role === 'customer' ? sanitize(text) : text
  await db.insert(conversationMessages).values({ sessionId, role, text: storedText })
}

export async function loadTranscript(
  db: Db,
  sessionId: string,
  limit = 8,
): Promise<TranscriptTurn[]> {
  const rows = await db
    .select({ role: conversationMessages.role, text: conversationMessages.text })
    .from(conversationMessages)
    .where(eq(conversationMessages.sessionId, sessionId))
    .orderBy(desc(conversationMessages.createdAt))
    .limit(limit)

  // Reverse so oldest-first order for the LLM context window
  return rows.reverse().map((r) => ({ role: r.role as 'customer' | 'assistant', text: r.text }))
}
