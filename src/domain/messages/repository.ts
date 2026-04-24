import { eq, desc } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { conversationMessages } from '../../db/schema.js'
import type { TranscriptTurn } from '../../adapters/llm/types.js'

export async function saveMessage(
  db: Db,
  sessionId: string,
  role: 'customer' | 'assistant',
  text: string,
): Promise<void> {
  await db.insert(conversationMessages).values({ sessionId, role, text })
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
