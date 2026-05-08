import type { Redis } from 'ioredis'

export interface OperatorTurn {
  role: 'operator' | 'assistant'
  text: string
  ts: number
}

export interface OperatorSession {
  transcript: OperatorTurn[]
}

const TTL_SECONDS = 24 * 60 * 60 // 24 hours
const MAX_TURNS = 30             // cap stored turns to avoid unbounded growth

function key(phone: string): string {
  return `operator:session:${phone}`
}

export async function loadOperatorSession(redis: Redis, phone: string): Promise<OperatorSession> {
  const raw = await redis.get(key(phone))
  if (!raw) return { transcript: [] }
  try {
    return JSON.parse(raw) as OperatorSession
  } catch {
    return { transcript: [] }
  }
}

export async function appendOperatorTurn(
  redis: Redis,
  phone: string,
  role: OperatorTurn['role'],
  text: string,
): Promise<void> {
  const session = await loadOperatorSession(redis, phone)
  session.transcript.push({ role, text, ts: Date.now() })
  // Keep only the most recent turns
  if (session.transcript.length > MAX_TURNS) {
    session.transcript = session.transcript.slice(-MAX_TURNS)
  }
  await redis.set(key(phone), JSON.stringify(session), 'EX', TTL_SECONDS)
}

export async function clearOperatorSession(redis: Redis, phone: string): Promise<void> {
  await redis.del(key(phone))
}
